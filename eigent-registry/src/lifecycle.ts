import { v7 as uuidv7 } from 'uuid';
import {
  getDb,
  getAgentById,
  findDescendants,
  insertAuditLog,
} from './db.js';
import { issueToken, type EigentTokenPayload } from './tokens.js';
import { fireWebhooks } from './webhooks.js';

// ─── Configuration ───

export interface LifecycleConfig {
  /** Token rotation interval in milliseconds (default: 1 hour) */
  rotationIntervalMs: number;
  /** Auto-expiry check interval in milliseconds (default: 60 seconds) */
  expiryCheckIntervalMs: number;
  /** Staleness threshold in minutes (default: 30) */
  stalenessThresholdMinutes: number;
  /** Staleness check interval in milliseconds (default: 60 seconds) */
  stalenessCheckIntervalMs: number;
  /** Webhook URL to call when an agent goes stale (optional) */
  staleWebhookUrl?: string;
  /** Grace period for old token during rotation in milliseconds (default: 5 minutes) */
  rotationGracePeriodMs: number;
}

const DEFAULT_CONFIG: LifecycleConfig = {
  rotationIntervalMs: 60 * 60 * 1000,
  expiryCheckIntervalMs: 60 * 1000,
  stalenessThresholdMinutes: 30,
  stalenessCheckIntervalMs: 60 * 1000,
  rotationGracePeriodMs: 5 * 60 * 1000,
};

let lifecycleConfig: LifecycleConfig = { ...DEFAULT_CONFIG };

export function configureLifecycle(config: Partial<LifecycleConfig>): void {
  lifecycleConfig = { ...DEFAULT_CONFIG, ...config };
}

export function getLifecycleConfig(): LifecycleConfig {
  return { ...lifecycleConfig };
}

// ─── Helper ───

function auditId(): string {
  return uuidv7();
}

// ─── 1. Token Rotation ───

export interface RotationResult {
  new_token: string;
  old_token_expires: Date;
  agent_id: string;
}

export async function rotateToken(agentId: string): Promise<RotationResult> {
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  if (agent.status !== 'active') {
    throw new Error(`Cannot rotate token for agent with status: ${agent.status}`);
  }

  const now = new Date();
  const oldTokenExpires = new Date(now.getTime() + lifecycleConfig.rotationGracePeriodMs);
  const agentExpiresAt = new Date(agent.expires_at);

  // New token keeps the same expiration as the original agent
  const scope: string[] = JSON.parse(agent.scope);
  const canDelegate: string[] = agent.can_delegate ? JSON.parse(agent.can_delegate) : [];

  const tokenPayload: EigentTokenPayload = {
    agent_id: agentId,
    human_sub: agent.human_sub,
    human_email: agent.human_email,
    human_iss: agent.human_iss,
    scope,
    delegation_depth: agent.delegation_depth,
    max_delegation_depth: agent.max_delegation_depth,
    delegation_chain: [agentId], // simplified; full chain built at verify time
    can_delegate: canDelegate,
  };

  const { token: newToken, jti: newJti } = await issueToken(tokenPayload, agentExpiresAt);

  // Update agent with new token JTI
  const db = getDb();
  db.prepare(
    'UPDATE agents SET token_jti = ? WHERE id = ?'
  ).run(newJti, agentId);

  // Audit log
  insertAuditLog({
    id: auditId(),
    org_id: agent.org_id,
    timestamp: now.toISOString(),
    agent_id: agentId,
    human_email: agent.human_email,
    action: 'token_rotated',
    tool_name: null,
    delegation_chain: null,
    details: JSON.stringify({
      old_jti: agent.token_jti,
      new_jti: newJti,
      old_token_grace_expires: oldTokenExpires.toISOString(),
    }),
  });

  return {
    new_token: newToken,
    old_token_expires: oldTokenExpires,
    agent_id: agentId,
  };
}

// ─── 2. Auto-Expiry ───

export interface ExpiryResult {
  expired_agents: string[];
  cascade_expired: string[];
}

export function runAutoExpiry(): ExpiryResult {
  const now = new Date().toISOString();
  const db = getDb();

  // Find agents that are active but have expired tokens
  const expiredAgents = db.prepare(`
    SELECT id, human_email, parent_id FROM agents
    WHERE status = 'active' AND expires_at <= ?
  `).all(now) as Array<{ id: string; human_email: string; parent_id: string | null }>;

  const expiredIds: string[] = [];
  const cascadeExpiredIds: string[] = [];

  const updateStmt = db.prepare(
    'UPDATE agents SET status = ? WHERE id = ? AND status = ?'
  );

  const txn = db.transaction(() => {
    for (const agent of expiredAgents) {
      const result = updateStmt.run('expired', agent.id, 'active');
      if (result.changes > 0) {
        expiredIds.push(agent.id);

        insertAuditLog({
          id: auditId(),
          org_id: agent.org_id,
          timestamp: now,
          agent_id: agent.id,
          human_email: agent.human_email,
          action: 'auto_expired',
          tool_name: null,
          delegation_chain: null,
          details: JSON.stringify({ reason: 'token_expired' }),
        });

        // Cascade: expire all children of this agent
        const descendants = findDescendants(agent.id);
        for (const childId of descendants) {
          const childResult = updateStmt.run('expired', childId, 'active');
          if (childResult.changes > 0) {
            cascadeExpiredIds.push(childId);
            const child = getAgentById(childId);

            insertAuditLog({
              id: auditId(),
              org_id: child?.org_id ?? agent.org_id,
              timestamp: now,
              agent_id: childId,
              human_email: child?.human_email ?? agent.human_email,
              action: 'auto_expired',
              tool_name: null,
              delegation_chain: null,
              details: JSON.stringify({
                reason: 'parent_expired',
                parent_id: agent.id,
              }),
            });
          }
        }
      }
    }
  });

  txn();

  return {
    expired_agents: expiredIds,
    cascade_expired: cascadeExpiredIds,
  };
}

// ─── 3. Heartbeat / Last-Seen Tracking ───

export function recordHeartbeat(agentId: string): { last_seen_at: string } {
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const now = new Date().toISOString();
  const db = getDb();

  db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now, agentId);

  return { last_seen_at: now };
}

export interface StaleAgent {
  id: string;
  name: string;
  human_email: string;
  last_seen_at: string | null;
  status: string;
  minutes_since_seen: number;
}

export function findStaleAgents(thresholdMinutes?: number): StaleAgent[] {
  const threshold = thresholdMinutes ?? lifecycleConfig.stalenessThresholdMinutes;
  const cutoff = new Date(Date.now() - threshold * 60 * 1000).toISOString();
  const db = getDb();

  // Agents that are active but haven't been seen recently
  // Includes agents that have never sent a heartbeat (last_seen_at IS NULL)
  const rows = db.prepare(`
    SELECT id, name, human_email, last_seen_at, status FROM agents
    WHERE status = 'active'
      AND (last_seen_at IS NULL OR last_seen_at <= ?)
  `).all(cutoff) as Array<{
    id: string;
    name: string;
    human_email: string;
    last_seen_at: string | null;
    status: string;
  }>;

  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    minutes_since_seen: r.last_seen_at
      ? Math.floor((now - new Date(r.last_seen_at).getTime()) / 60000)
      : -1, // -1 indicates never seen
  }));
}

export function markStaleAgents(thresholdMinutes?: number): string[] {
  const stale = findStaleAgents(thresholdMinutes);
  const db = getDb();
  const now = new Date().toISOString();
  const markedIds: string[] = [];

  const updateStmt = db.prepare(
    'UPDATE agents SET status = ? WHERE id = ? AND status = ?'
  );

  const txn = db.transaction(() => {
    for (const agent of stale) {
      const result = updateStmt.run('stale', agent.id, 'active');
      if (result.changes > 0) {
        markedIds.push(agent.id);

        insertAuditLog({
          id: auditId(),
          org_id: agent.org_id,
          timestamp: now,
          agent_id: agent.id,
          human_email: agent.human_email,
          action: 'marked_stale',
          tool_name: null,
          delegation_chain: null,
          details: JSON.stringify({
            last_seen_at: agent.last_seen_at,
            threshold_minutes: thresholdMinutes ?? lifecycleConfig.stalenessThresholdMinutes,
          }),
        });
      }
    }
  });

  txn();

  return markedIds;
}

export async function notifyStaleWebhook(staleAgents: StaleAgent[]): Promise<void> {
  if (!lifecycleConfig.staleWebhookUrl || staleAgents.length === 0) {
    return;
  }

  try {
    await fetch(lifecycleConfig.staleWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'agents_stale',
        timestamp: new Date().toISOString(),
        agents: staleAgents,
      }),
    });
  } catch {
    // Webhook failures are non-fatal; silently continue
  }
}

// ─── 4. Deprovisioning ───

export interface DeprovisionResult {
  agent_id: string;
  agent_name: string;
  deprovisioned_at: string;
  cascade_revoked: string[];
}

export function deprovisionAgent(agentId: string): DeprovisionResult {
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  if (agent.status === 'deprovisioned') {
    throw new Error(`Agent is already deprovisioned: ${agentId}`);
  }

  const now = new Date().toISOString();
  const db = getDb();

  // Find and revoke all descendants first
  const descendants = findDescendants(agentId);
  const allIds = [agentId, ...descendants];

  const updateStmt = db.prepare(
    'UPDATE agents SET status = ?, deprovisioned_at = ?, revoked_at = COALESCE(revoked_at, ?) WHERE id = ?'
  );

  const txn = db.transaction(() => {
    for (const id of allIds) {
      updateStmt.run('deprovisioned', now, now, id);
    }
  });
  txn();

  // Audit log
  insertAuditLog({
    id: auditId(),
    org_id: agent.org_id,
    timestamp: now,
    agent_id: agentId,
    human_email: agent.human_email,
    action: 'deprovisioned',
    tool_name: null,
    delegation_chain: null,
    details: JSON.stringify({
      agent_name: agent.name,
      cascade_count: descendants.length,
      cascade_ids: descendants,
    }),
  });

  return {
    agent_id: agentId,
    agent_name: agent.name,
    deprovisioned_at: now,
    cascade_revoked: descendants,
  };
}

export interface HumanDeprovisionResult {
  human_email: string;
  deprovisioned_at: string;
  agents_affected: number;
  agent_ids: string[];
  agent_names: string[];
}

export function deprovisionHuman(email: string): HumanDeprovisionResult {
  const db = getDb();
  const now = new Date().toISOString();

  // Find all agents belonging to this human
  const agents = db.prepare(`
    SELECT id, name, status FROM agents
    WHERE human_email = ? AND status NOT IN ('deprovisioned')
  `).all(email) as Array<{ id: string; name: string; status: string }>;

  if (agents.length === 0) {
    return {
      human_email: email,
      deprovisioned_at: now,
      agents_affected: 0,
      agent_ids: [],
      agent_names: [],
    };
  }

  const updateStmt = db.prepare(
    'UPDATE agents SET status = ?, deprovisioned_at = ?, revoked_at = COALESCE(revoked_at, ?) WHERE id = ?'
  );

  const agentIds: string[] = [];
  const agentNames: string[] = [];

  const txn = db.transaction(() => {
    for (const agent of agents) {
      updateStmt.run('deprovisioned', now, now, agent.id);
      agentIds.push(agent.id);
      agentNames.push(agent.name);
    }
  });
  txn();

  // Single audit log entry for the human deprovisioning
  insertAuditLog({
    id: auditId(),
    org_id: agents[0]?.org_id ?? 'default',
    timestamp: now,
    agent_id: agentIds[0], // primary reference
    human_email: email,
    action: 'human_deprovisioned',
    tool_name: null,
    delegation_chain: null,
    details: JSON.stringify({
      message: `Human ${email} deprovisioned. ${agents.length} agents cascade revoked.`,
      agent_ids: agentIds,
      agent_names: agentNames,
    }),
  });

  // Fire webhook for human.deprovisioned
  const orgId = agents[0]?.org_id ?? 'default';
  fireWebhooks(orgId, 'human.deprovisioned', {
    human_email: email,
    agents_affected: agents.length,
    agent_ids: agentIds,
  });

  return {
    human_email: email,
    deprovisioned_at: now,
    agents_affected: agents.length,
    agent_ids: agentIds,
    agent_names: agentNames,
  };
}

// ─── 5. Usage Tracking ───

export interface UsageRecord {
  agent_id: string;
  hour: string;
  tool_calls: number;
  blocked_calls: number;
  errors: number;
}

export function recordUsage(
  agentId: string,
  type: 'tool_call' | 'blocked_call' | 'error'
): void {
  const db = getDb();
  const now = new Date();
  // Round to current hour
  const hour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).toISOString();

  const column = type === 'tool_call' ? 'tool_calls'
    : type === 'blocked_call' ? 'blocked_calls'
    : 'errors';

  // Upsert: insert or increment
  db.prepare(`
    INSERT INTO agent_usage (agent_id, hour, tool_calls, blocked_calls, errors)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, hour) DO UPDATE SET ${column} = ${column} + 1
  `).run(
    agentId,
    hour,
    type === 'tool_call' ? 1 : 0,
    type === 'blocked_call' ? 1 : 0,
    type === 'error' ? 1 : 0
  );
}

export function getAgentUsage(agentId: string, hours?: number): UsageRecord[] {
  const db = getDb();
  const limit = hours ?? 24;
  const cutoff = new Date(Date.now() - limit * 60 * 60 * 1000).toISOString();

  return db.prepare(`
    SELECT agent_id, hour, tool_calls, blocked_calls, errors
    FROM agent_usage
    WHERE agent_id = ? AND hour >= ?
    ORDER BY hour DESC
  `).all(agentId, cutoff) as UsageRecord[];
}

export interface UsageSummary {
  total_tool_calls: number;
  total_blocked_calls: number;
  total_errors: number;
  active_agents: number;
  top_agents: Array<{
    agent_id: string;
    agent_name: string;
    total_calls: number;
  }>;
}

export function getUsageSummary(hours?: number): UsageSummary {
  const db = getDb();
  const limit = hours ?? 24;
  const cutoff = new Date(Date.now() - limit * 60 * 60 * 1000).toISOString();

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(tool_calls), 0) as total_tool_calls,
      COALESCE(SUM(blocked_calls), 0) as total_blocked_calls,
      COALESCE(SUM(errors), 0) as total_errors,
      COUNT(DISTINCT agent_id) as active_agents
    FROM agent_usage
    WHERE hour >= ?
  `).get(cutoff) as {
    total_tool_calls: number;
    total_blocked_calls: number;
    total_errors: number;
    active_agents: number;
  };

  const topAgents = db.prepare(`
    SELECT u.agent_id, a.name as agent_name, SUM(u.tool_calls) as total_calls
    FROM agent_usage u
    LEFT JOIN agents a ON a.id = u.agent_id
    WHERE u.hour >= ?
    GROUP BY u.agent_id
    ORDER BY total_calls DESC
    LIMIT 10
  `).all(cutoff) as Array<{
    agent_id: string;
    agent_name: string;
    total_calls: number;
  }>;

  return {
    ...totals,
    top_agents: topAgents,
  };
}

// ─── Background Jobs ───

let expiryInterval: ReturnType<typeof setInterval> | null = null;
let stalenessInterval: ReturnType<typeof setInterval> | null = null;

export function startBackgroundJobs(): void {
  // Auto-expiry job
  expiryInterval = setInterval(() => {
    try {
      const result = runAutoExpiry();
      if (result.expired_agents.length > 0) {
        process.stdout.write(
          `[eigent-lifecycle] Auto-expired ${result.expired_agents.length} agents` +
          (result.cascade_expired.length > 0
            ? ` (${result.cascade_expired.length} cascade)`
            : '') +
          '\n'
        );
      }
    } catch {
      // Non-fatal: log and continue
    }
  }, lifecycleConfig.expiryCheckIntervalMs);

  // Staleness detection job
  stalenessInterval = setInterval(async () => {
    try {
      const staleAgents = findStaleAgents();
      if (staleAgents.length > 0) {
        await notifyStaleWebhook(staleAgents);
      }
    } catch {
      // Non-fatal: log and continue
    }
  }, lifecycleConfig.stalenessCheckIntervalMs);
}

export function stopBackgroundJobs(): void {
  if (expiryInterval) {
    clearInterval(expiryInterval);
    expiryInterval = null;
  }
  if (stalenessInterval) {
    clearInterval(stalenessInterval);
    stalenessInterval = null;
  }
}
