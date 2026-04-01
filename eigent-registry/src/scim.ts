import { Hono } from 'hono';
import { z } from 'zod';
import {
  listAgentsByHumanSub,
  revokeAgentCascade,
  insertAuditLog,
  getAgentById,
  getDelegationChain,
  type AgentRow,
} from './db.js';
import { v7 as uuidv7 } from 'uuid';

export const scimApp = new Hono();

// ─── SCIM Event Types ───

/**
 * Supported SCIM event types for user lifecycle management.
 */
type SCIMEventType =
  | 'user.deprovisioned'
  | 'user.suspended'
  | 'user.deleted'
  | 'user.removed';

const DEPROVISION_EVENTS: SCIMEventType[] = [
  'user.deprovisioned',
  'user.suspended',
  'user.deleted',
  'user.removed',
];

// ─── Validation Schemas ───

/**
 * SCIM webhook payload schema.
 * Supports both Okta-style and generic SCIM event formats.
 */
const SCIMWebhookSchema = z.object({
  // Event type (Okta-style or generic)
  event_type: z.string().min(1),

  // User information
  user: z.object({
    // SCIM user ID (maps to human_sub in the agents table)
    id: z.string().min(1),
    // User email for audit logging
    email: z.string().email().optional(),
    // Issuer/provider that sent the event
    issuer: z.string().optional(),
    // Display name
    displayName: z.string().optional(),
  }),

  // Timestamp of the event
  timestamp: z.string().optional(),

  // Source system metadata
  source: z.object({
    type: z.string().optional(),
    provider: z.string().optional(),
  }).optional(),
});

type SCIMWebhookPayload = z.infer<typeof SCIMWebhookSchema>;

// ─── Helpers ───

function buildDelegationChainIds(agent: AgentRow): string[] {
  const chain = getDelegationChain(agent.id);
  return chain.map((a) => a.id);
}

// ─── Routes ───

/**
 * POST /api/scim/webhook
 *
 * Receives SCIM lifecycle events (user deprovisioned, suspended, deleted).
 * When a user is deprovisioned:
 *   1. Finds all agents bound to that human (by human_sub)
 *   2. CASCADE REVOKES all of them and their delegates
 *   3. Logs to audit trail: "Human deprovisioned -> N agents revoked"
 *
 * This solves the "departed engineer" scenario: when someone leaves the org,
 * ALL agents they authorized are immediately and automatically revoked.
 */
scimApp.post('/api/scim/webhook', async (c) => {
  const body = await c.req.json();
  const parsed = SCIMWebhookSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: 'Invalid SCIM webhook payload', details: parsed.error.flatten() },
      400,
    );
  }

  const payload: SCIMWebhookPayload = parsed.data;
  const eventType = payload.event_type;

  // Only process deprovision events
  if (!DEPROVISION_EVENTS.includes(eventType as SCIMEventType)) {
    return c.json({
      status: 'ignored',
      event_type: eventType,
      message: `Event type "${eventType}" does not trigger agent revocation`,
    });
  }

  const humanSub = payload.user.id;
  const humanEmail = payload.user.email ?? 'unknown';
  const now = new Date().toISOString();

  // Find all active agents bound to this human
  const agents = listAgentsByHumanSub(humanSub, 'active');

  if (agents.length === 0) {
    // Log even if no agents found -- for audit completeness
    insertAuditLog({
      id: uuidv7(),
      org_id: 'default',
      timestamp: now,
      agent_id: 'system',
      human_email: humanEmail,
      action: 'human_deprovisioned',
      tool_name: null,
      delegation_chain: null,
      details: JSON.stringify({
        event_type: eventType,
        human_sub: humanSub,
        agents_found: 0,
        message: 'No active agents found for deprovisioned human',
      }),
    });

    return c.json({
      status: 'processed',
      event_type: eventType,
      human_sub: humanSub,
      agents_revoked: 0,
      total_cascade_revoked: 0,
    });
  }

  // Cascade revoke ALL agents bound to this human
  let totalRevoked = 0;
  const revokedAgentIds: string[] = [];

  for (const agent of agents) {
    // revokeAgentCascade handles the agent and all its descendants
    const revokedIds = revokeAgentCascade(agent.id);
    totalRevoked += revokedIds.length;
    revokedAgentIds.push(...revokedIds);

    // Log each root agent revocation
    for (const id of revokedIds) {
      const revokedAgent = getAgentById(id);
      if (revokedAgent) {
        insertAuditLog({
          id: uuidv7(),
          org_id: revokedAgent.org_id,
          timestamp: now,
          agent_id: id,
          human_email: humanEmail,
          action: 'revoked',
          tool_name: null,
          delegation_chain: JSON.stringify(buildDelegationChainIds(revokedAgent)),
          details: JSON.stringify({
            reason: id === agent.id ? 'human_deprovisioned' : 'cascade_from_human_deprovision',
            scim_event: eventType,
            human_sub: humanSub,
            triggered_by: 'scim_webhook',
          }),
        });
      }
    }
  }

  // Log the summary event
  insertAuditLog({
    id: uuidv7(),
    org_id: agents[0]?.org_id ?? 'default',
    timestamp: now,
    agent_id: 'system',
    human_email: humanEmail,
    action: 'human_deprovisioned',
    tool_name: null,
    delegation_chain: null,
    details: JSON.stringify({
      event_type: eventType,
      human_sub: humanSub,
      root_agents_revoked: agents.length,
      total_cascade_revoked: totalRevoked,
      revoked_agent_ids: revokedAgentIds,
      source: payload.source,
    }),
  });

  return c.json({
    status: 'processed',
    event_type: eventType,
    human_sub: humanSub,
    agents_revoked: agents.length,
    total_cascade_revoked: totalRevoked,
    revoked_agent_ids: revokedAgentIds,
  });
});

/**
 * GET /api/scim/health
 * Health check for the SCIM webhook receiver.
 */
scimApp.get('/api/scim/health', (c) => {
  return c.json({ status: 'ok', service: 'eigent-scim-webhook' });
});
