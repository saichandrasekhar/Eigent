import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  insertAgent,
  getAgentById,
  listAgents,
  revokeAgentCascade,
  getDelegationChain,
  insertAuditLog,
  queryAuditLog,
  getAgentByTokenJti,
  type AgentRow,
} from './db.js';
import { issueToken, verifyToken, getJwks, type EigentTokenPayload } from './tokens.js';

export const app = new Hono();

// ─── Validation Schemas ───

const RegisterAgentSchema = z.object({
  name: z.string().min(1).max(255),
  human_sub: z.string().min(1),
  human_email: z.string().email(),
  human_iss: z.string().url(),
  scope: z.array(z.string().min(1)).min(1),
  max_delegation_depth: z.number().int().min(0).max(10).default(3),
  can_delegate: z.array(z.string()).default([]),
  ttl_seconds: z.number().int().min(60).max(86400 * 30).default(3600),
  metadata: z.record(z.unknown()).optional(),
});

const DelegateSchema = z.object({
  parent_token: z.string().min(1),
  child_name: z.string().min(1).max(255),
  requested_scope: z.array(z.string().min(1)).min(1),
  ttl_seconds: z.number().int().min(60).max(86400 * 30).default(3600),
  metadata: z.record(z.unknown()).optional(),
});

const VerifySchema = z.object({
  token: z.string().min(1),
  tool_name: z.string().min(1),
});

// ─── Helper ───

function auditId(): string {
  return uuidv7();
}

function buildDelegationChainIds(agent: AgentRow): string[] {
  const chain = getDelegationChain(agent.id);
  return chain.map((a) => a.id);
}

// ─── Routes ───

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'eigent-registry' });
});

// POST /api/agents — Register a new agent
app.post('/api/agents', async (c) => {
  const body = await c.req.json();
  const parsed = RegisterAgentSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const input = parsed.data;
  const agentId = uuidv7();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttl_seconds * 1000);

  // Determine delegatable scopes: default to full scope if not specified
  const canDelegate = input.can_delegate.length > 0 ? input.can_delegate : input.scope;

  const tokenPayload: EigentTokenPayload = {
    agent_id: agentId,
    human_sub: input.human_sub,
    human_email: input.human_email,
    human_iss: input.human_iss,
    scope: input.scope,
    delegation_depth: 0,
    max_delegation_depth: input.max_delegation_depth,
    delegation_chain: [agentId],
    can_delegate: canDelegate,
  };

  const { token, jti } = await issueToken(tokenPayload, expiresAt);

  const agent: AgentRow = {
    id: agentId,
    name: input.name,
    human_sub: input.human_sub,
    human_email: input.human_email,
    human_iss: input.human_iss,
    scope: JSON.stringify(input.scope),
    parent_id: null,
    delegation_depth: 0,
    max_delegation_depth: input.max_delegation_depth,
    can_delegate: JSON.stringify(canDelegate),
    token_jti: jti,
    status: 'active',
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    revoked_at: null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  };

  insertAgent(agent);

  insertAuditLog({
    id: auditId(),
    timestamp: now.toISOString(),
    agent_id: agentId,
    human_email: input.human_email,
    action: 'issued',
    tool_name: null,
    delegation_chain: JSON.stringify([agentId]),
    details: JSON.stringify({ scope: input.scope, ttl_seconds: input.ttl_seconds }),
  });

  return c.json({
    agent_id: agentId,
    token,
    scope: input.scope,
    expires_at: expiresAt.toISOString(),
  }, 201);
});

// POST /api/agents/:id/delegate — Delegate to a child agent
app.post('/api/agents/:id/delegate', async (c) => {
  const parentId = c.req.param('id');
  const body = await c.req.json();
  const parsed = DelegateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const input = parsed.data;

  // Verify parent token
  let parentTokenPayload;
  try {
    const verified = await verifyToken(input.parent_token);
    parentTokenPayload = verified.payload;
  } catch (err) {
    return c.json({ error: 'Invalid parent token', details: (err as Error).message }, 401);
  }

  // Verify the token belongs to the specified parent agent
  if (parentTokenPayload.agent_id !== parentId) {
    return c.json({ error: 'Token does not match the specified parent agent' }, 403);
  }

  // Get parent agent from DB
  const parentAgent = getAgentById(parentId);
  if (!parentAgent) {
    return c.json({ error: 'Parent agent not found' }, 404);
  }

  if (parentAgent.status !== 'active') {
    return c.json({ error: 'Parent agent is not active', status: parentAgent.status }, 403);
  }

  // Check delegation depth
  const currentDepth = parentAgent.delegation_depth;
  if (currentDepth >= parentAgent.max_delegation_depth) {
    return c.json({
      error: 'Maximum delegation depth exceeded',
      current_depth: currentDepth,
      max_depth: parentAgent.max_delegation_depth,
    }, 403);
  }

  // Compute scope intersection: child gets only scopes the parent can delegate
  const parentDelegatable: string[] = parentAgent.can_delegate
    ? JSON.parse(parentAgent.can_delegate)
    : [];
  const grantedScope = input.requested_scope.filter((s) => parentDelegatable.includes(s));
  const deniedScope = input.requested_scope.filter((s) => !parentDelegatable.includes(s));

  if (grantedScope.length === 0) {
    return c.json({
      error: 'No requested scopes are delegatable by the parent',
      requested: input.requested_scope,
      parent_can_delegate: parentDelegatable,
    }, 403);
  }

  const childId = uuidv7();
  const now = new Date();

  // Child TTL cannot exceed parent's remaining TTL
  const parentExpiresAt = new Date(parentAgent.expires_at);
  const maxChildExpiry = parentExpiresAt.getTime();
  const requestedExpiry = now.getTime() + input.ttl_seconds * 1000;
  const childExpiresAt = new Date(Math.min(maxChildExpiry, requestedExpiry));

  const parentChain = buildDelegationChainIds(parentAgent);
  const childChain = [...parentChain, childId];
  const childDepth = currentDepth + 1;

  // Child can only delegate what it was granted (further narrowing)
  const childCanDelegate = grantedScope;

  const tokenPayload: EigentTokenPayload = {
    agent_id: childId,
    human_sub: parentAgent.human_sub,
    human_email: parentAgent.human_email,
    human_iss: parentAgent.human_iss,
    scope: grantedScope,
    delegation_depth: childDepth,
    max_delegation_depth: parentAgent.max_delegation_depth,
    delegation_chain: childChain,
    can_delegate: childCanDelegate,
  };

  const { token, jti } = await issueToken(tokenPayload, childExpiresAt);

  const childAgent: AgentRow = {
    id: childId,
    name: input.child_name,
    human_sub: parentAgent.human_sub,
    human_email: parentAgent.human_email,
    human_iss: parentAgent.human_iss,
    scope: JSON.stringify(grantedScope),
    parent_id: parentId,
    delegation_depth: childDepth,
    max_delegation_depth: parentAgent.max_delegation_depth,
    can_delegate: JSON.stringify(childCanDelegate),
    token_jti: jti,
    status: 'active',
    created_at: now.toISOString(),
    expires_at: childExpiresAt.toISOString(),
    revoked_at: null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  };

  insertAgent(childAgent);

  insertAuditLog({
    id: auditId(),
    timestamp: now.toISOString(),
    agent_id: childId,
    human_email: parentAgent.human_email,
    action: 'delegated',
    tool_name: null,
    delegation_chain: JSON.stringify(childChain),
    details: JSON.stringify({
      parent_id: parentId,
      granted_scope: grantedScope,
      denied_scope: deniedScope,
      delegation_depth: childDepth,
    }),
  });

  return c.json({
    child_agent_id: childId,
    token,
    granted_scope: grantedScope,
    denied_scope: deniedScope,
    delegation_depth: childDepth,
    expires_at: childExpiresAt.toISOString(),
  }, 201);
});

// DELETE /api/agents/:id — Revoke agent (cascade)
app.delete('/api/agents/:id', (c) => {
  const agentId = c.req.param('id');
  const agent = getAgentById(agentId);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  if (agent.status === 'revoked') {
    return c.json({ error: 'Agent is already revoked' }, 409);
  }

  const revokedIds = revokeAgentCascade(agentId);
  const now = new Date().toISOString();

  // Log each revocation
  for (const id of revokedIds) {
    const revokedAgent = getAgentById(id)!;
    insertAuditLog({
      id: auditId(),
      timestamp: now,
      agent_id: id,
      human_email: revokedAgent.human_email,
      action: 'revoked',
      tool_name: null,
      delegation_chain: JSON.stringify(buildDelegationChainIds(revokedAgent)),
      details: JSON.stringify({
        reason: id === agentId ? 'direct_revocation' : 'cascade_revocation',
        triggered_by: agentId,
      }),
    });
  }

  const cascadeRevoked = revokedIds.filter((id) => id !== agentId);

  return c.json({
    revoked_agent_id: agentId,
    cascade_revoked: cascadeRevoked,
    total_revoked: revokedIds.length,
  });
});

// GET /api/agents/:id — Get agent details
app.get('/api/agents/:id', (c) => {
  const agentId = c.req.param('id');
  const agent = getAgentById(agentId);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  return c.json({
    ...agent,
    scope: JSON.parse(agent.scope),
    can_delegate: agent.can_delegate ? JSON.parse(agent.can_delegate) : null,
    metadata: agent.metadata ? JSON.parse(agent.metadata) : null,
    delegation_chain: buildDelegationChainIds(agent),
  });
});

// GET /api/agents/:id/chain — Get full delegation chain
app.get('/api/agents/:id/chain', (c) => {
  const agentId = c.req.param('id');
  const agent = getAgentById(agentId);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const chain = getDelegationChain(agentId);
  return c.json({
    agent_id: agentId,
    chain: chain.map((a) => ({
      id: a.id,
      name: a.name,
      delegation_depth: a.delegation_depth,
      scope: JSON.parse(a.scope),
      status: a.status,
      human_email: a.human_email,
      created_at: a.created_at,
    })),
    depth: chain.length - 1,
    root_human_email: chain[0]?.human_email,
  });
});

// GET /api/agents — List all agents (with filters)
app.get('/api/agents', (c) => {
  const status = c.req.query('status') ?? 'active';
  const human_email = c.req.query('human_email');
  const parent_id = c.req.query('parent_id');

  const agents = listAgents({
    status: status || undefined,
    human_email: human_email || undefined,
    parent_id: parent_id || undefined,
  });

  return c.json({
    agents: agents.map((a) => ({
      ...a,
      scope: JSON.parse(a.scope),
      can_delegate: a.can_delegate ? JSON.parse(a.can_delegate) : null,
      metadata: a.metadata ? JSON.parse(a.metadata) : null,
    })),
    total: agents.length,
  });
});

// POST /api/verify — Verify a token and check if action is allowed
app.post('/api/verify', async (c) => {
  const body = await c.req.json();
  const parsed = VerifySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { token, tool_name } = parsed.data;

  // Verify token signature and expiration
  let tokenPayload;
  let jti: string;
  try {
    const verified = await verifyToken(token);
    tokenPayload = verified.payload;
    jti = verified.jti;
  } catch (err) {
    return c.json({
      allowed: false,
      reason: `Token verification failed: ${(err as Error).message}`,
    }, 401);
  }

  // Check if agent exists and is active
  const agent = getAgentByTokenJti(jti);
  if (!agent) {
    return c.json({
      allowed: false,
      reason: 'Agent not found for this token',
    }, 404);
  }

  if (agent.status === 'revoked') {
    insertAuditLog({
      id: auditId(),
      timestamp: new Date().toISOString(),
      agent_id: agent.id,
      human_email: agent.human_email,
      action: 'tool_call_blocked',
      tool_name,
      delegation_chain: JSON.stringify(buildDelegationChainIds(agent)),
      details: JSON.stringify({ reason: 'agent_revoked' }),
    });

    return c.json({
      allowed: false,
      agent_id: agent.id,
      human_email: agent.human_email,
      delegation_chain: buildDelegationChainIds(agent),
      reason: 'Agent has been revoked',
    });
  }

  // Check expiration from DB record
  if (new Date(agent.expires_at) < new Date()) {
    insertAuditLog({
      id: auditId(),
      timestamp: new Date().toISOString(),
      agent_id: agent.id,
      human_email: agent.human_email,
      action: 'tool_call_blocked',
      tool_name,
      delegation_chain: JSON.stringify(buildDelegationChainIds(agent)),
      details: JSON.stringify({ reason: 'token_expired' }),
    });

    return c.json({
      allowed: false,
      agent_id: agent.id,
      human_email: agent.human_email,
      delegation_chain: buildDelegationChainIds(agent),
      reason: 'Token has expired',
    });
  }

  // Check scope
  const agentScope: string[] = JSON.parse(agent.scope);
  const allowed = agentScope.includes(tool_name);

  const action = allowed ? 'tool_call_allowed' : 'tool_call_blocked';
  const chain = buildDelegationChainIds(agent);

  insertAuditLog({
    id: auditId(),
    timestamp: new Date().toISOString(),
    agent_id: agent.id,
    human_email: agent.human_email,
    action,
    tool_name,
    delegation_chain: JSON.stringify(chain),
    details: JSON.stringify({
      reason: allowed ? 'in_scope' : 'not_in_scope',
      agent_scope: agentScope,
    }),
  });

  if (!allowed) {
    return c.json({
      allowed: false,
      agent_id: agent.id,
      human_email: agent.human_email,
      delegation_chain: chain,
      reason: `Tool "${tool_name}" is not in agent scope: [${agentScope.join(', ')}]`,
    });
  }

  return c.json({
    allowed: true,
    agent_id: agent.id,
    human_email: agent.human_email,
    delegation_chain: chain,
    reason: 'Tool is within agent scope',
  });
});

// GET /api/audit — Query audit log
app.get('/api/audit', (c) => {
  const agent_id = c.req.query('agent_id');
  const human_email = c.req.query('human_email');
  const action = c.req.query('action');
  const tool_name = c.req.query('tool_name');
  const from_date = c.req.query('from_date');
  const to_date = c.req.query('to_date');
  const limit = c.req.query('limit');
  const offset = c.req.query('offset');

  const result = queryAuditLog({
    agent_id: agent_id || undefined,
    human_email: human_email || undefined,
    action: action || undefined,
    tool_name: tool_name || undefined,
    from_date: from_date || undefined,
    to_date: to_date || undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  return c.json({
    entries: result.entries.map((e) => ({
      ...e,
      delegation_chain: e.delegation_chain ? JSON.parse(e.delegation_chain) : null,
      details: e.details ? JSON.parse(e.details) : null,
    })),
    total: result.total,
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  });
});

// GET /api/.well-known/jwks.json — Public key endpoint
app.get('/api/.well-known/jwks.json', (c) => {
  const jwks = getJwks();
  return c.json(jwks);
});
