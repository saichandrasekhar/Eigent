import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { app } from '../src/server.js';
import { initDb, closeDb, getDb } from '../src/db.js';
import { ensureSigningKey } from '../src/tokens.js';
import { configureLifecycle } from '../src/lifecycle.js';

// ─── Test helpers ───

async function request(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

async function post(path: string, body?: unknown) {
  const res = await request('POST', path, body);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function get(path: string) {
  const res = await request('GET', path);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// ─── Test Data ───

const HUMAN = {
  human_sub: 'lifecycle-user-123',
  human_email: 'lifecycle@example.com',
  human_iss: 'https://accounts.google.com',
};

const HUMAN2 = {
  human_sub: 'lifecycle-user-456',
  human_email: 'alice@acme.com',
  human_iss: 'https://accounts.google.com',
};

async function createAgent(name: string, opts?: {
  scope?: string[];
  ttl_seconds?: number;
  human?: typeof HUMAN;
  can_delegate?: string[];
  max_delegation_depth?: number;
}) {
  const res = await post('/api/agents', {
    name,
    ...(opts?.human ?? HUMAN),
    scope: opts?.scope ?? ['read_file', 'write_file'],
    ttl_seconds: opts?.ttl_seconds ?? 3600,
    can_delegate: opts?.can_delegate ?? ['read_file', 'write_file'],
    max_delegation_depth: opts?.max_delegation_depth ?? 3,
  });
  return res.body as { agent_id: string; token: string; expires_at: string };
}

// ─── Setup ───

beforeAll(async () => {
  initDb(':memory:');
  await ensureSigningKey();
  configureLifecycle({
    stalenessThresholdMinutes: 30,
    rotationGracePeriodMs: 5 * 60 * 1000,
  });
});

afterAll(() => {
  closeDb();
});

// ─── Tests ───

describe('Token Rotation', () => {
  it('rotates token and returns new token with grace period', async () => {
    const agent = await createAgent('rotate-test');

    const res = await post(`/api/agents/${agent.agent_id}/rotate`);
    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe(agent.agent_id);
    expect(res.body.new_token).toBeDefined();
    expect(typeof res.body.new_token).toBe('string');
    expect(res.body.old_token_expires).toBeDefined();

    // The old token grace period should be ~5 minutes from now
    const graceExpiry = new Date(res.body.old_token_expires as string);
    const now = new Date();
    const diffMs = graceExpiry.getTime() - now.getTime();
    expect(diffMs).toBeGreaterThan(4 * 60 * 1000); // > 4 min
    expect(diffMs).toBeLessThanOrEqual(5 * 60 * 1000 + 1000); // <= 5 min + 1s buffer
  });

  it('new token works for verification', async () => {
    const agent = await createAgent('rotate-verify', { scope: ['tool_a'] });

    const rotateRes = await post(`/api/agents/${agent.agent_id}/rotate`);
    const newToken = rotateRes.body.new_token as string;

    // Verify with new token
    const verifyRes = await post('/api/verify', {
      token: newToken,
      tool_name: 'tool_a',
    });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.allowed).toBe(true);
  });

  it('rejects rotation for non-existent agent', async () => {
    const res = await post('/api/agents/nonexistent-id/rotate');
    expect(res.status).toBe(404);
  });

  it('rejects rotation for revoked agent', async () => {
    const agent = await createAgent('rotate-revoked');

    // Revoke the agent
    await request('DELETE', `/api/agents/${agent.agent_id}`);

    const res = await post(`/api/agents/${agent.agent_id}/rotate`);
    expect(res.status).toBe(409);
  });

  it('records token rotation in audit log', async () => {
    const agent = await createAgent('rotate-audit');
    await post(`/api/agents/${agent.agent_id}/rotate`);

    const auditRes = await get(`/api/audit?agent_id=${agent.agent_id}&action=token_rotated`);
    expect(auditRes.status).toBe(200);
    const entries = auditRes.body.entries as Array<{ action: string }>;
    expect(entries.some((e) => e.action === 'token_rotated')).toBe(true);
  });
});

describe('Auto-Expiry', () => {
  it('expires agents with past expiration and cascades to children', async () => {
    // Create parent with normal TTL
    const parent = await createAgent('expiry-parent', { ttl_seconds: 3600 });

    // Create child
    const childRes = await post(`/api/agents/${parent.agent_id}/delegate`, {
      parent_token: parent.token,
      child_name: 'expiry-child',
      requested_scope: ['read_file'],
      ttl_seconds: 1800,
    });
    expect(childRes.status).toBe(201);
    const childId = childRes.body.child_agent_id as string;

    // Manually set parent's expires_at to the past
    const db = getDb();
    const pastDate = new Date(Date.now() - 1000).toISOString();
    db.prepare('UPDATE agents SET expires_at = ? WHERE id = ?').run(pastDate, parent.agent_id);

    // Trigger auto-expiry via the lifecycle module
    const { runAutoExpiry } = await import('../src/lifecycle.js');
    const result = runAutoExpiry();

    expect(result.expired_agents).toContain(parent.agent_id);
    // Child should be cascade expired
    expect(result.cascade_expired).toContain(childId);

    // Verify statuses
    const parentStatus = await get(`/api/agents/${parent.agent_id}`);
    expect(parentStatus.body.status).toBe('expired');

    const childStatus = await get(`/api/agents/${childId}`);
    expect(childStatus.body.status).toBe('expired');
  });

  it('records auto-expiry in audit log', async () => {
    const agent = await createAgent('expiry-audit', { ttl_seconds: 60 });

    const db = getDb();
    const pastDate = new Date(Date.now() - 1000).toISOString();
    db.prepare('UPDATE agents SET expires_at = ? WHERE id = ?').run(pastDate, agent.agent_id);

    const { runAutoExpiry } = await import('../src/lifecycle.js');
    runAutoExpiry();

    const auditRes = await get(`/api/audit?agent_id=${agent.agent_id}&action=auto_expired`);
    expect(auditRes.status).toBe(200);
    const entries = auditRes.body.entries as Array<{ action: string }>;
    expect(entries.some((e) => e.action === 'auto_expired')).toBe(true);
  });
});

describe('Heartbeat & Staleness', () => {
  it('records heartbeat and updates last_seen_at', async () => {
    const agent = await createAgent('heartbeat-test');

    const res = await post(`/api/agents/${agent.agent_id}/heartbeat`);
    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe(agent.agent_id);
    expect(res.body.last_seen_at).toBeDefined();

    // Verify the agent's last_seen_at is updated
    const agentRes = await get(`/api/agents/${agent.agent_id}`);
    expect(agentRes.body.last_seen_at).toBeDefined();
  });

  it('rejects heartbeat for non-existent agent', async () => {
    const res = await post('/api/agents/nonexistent-id/heartbeat');
    expect(res.status).toBe(404);
  });

  it('detects stale agents (never sent heartbeat)', async () => {
    const agent = await createAgent('stale-test');

    // With threshold=0 minutes, all agents without heartbeat are stale
    const res = await get('/api/agents/stale?threshold_minutes=0');
    expect(res.status).toBe(200);

    const staleAgents = res.body.stale_agents as Array<{ id: string }>;
    expect(staleAgents.some((a) => a.id === agent.agent_id)).toBe(true);
  });

  it('agent with recent heartbeat is not stale', async () => {
    const agent = await createAgent('not-stale');

    // Send heartbeat
    await post(`/api/agents/${agent.agent_id}/heartbeat`);

    // Check with 30 min threshold -- agent should NOT be stale
    const res = await get('/api/agents/stale?threshold_minutes=30');
    const staleAgents = res.body.stale_agents as Array<{ id: string }>;
    expect(staleAgents.some((a) => a.id === agent.agent_id)).toBe(false);
  });

  it('detects agent as stale after threshold passes', async () => {
    const agent = await createAgent('stale-after-threshold');

    // Set last_seen_at to 60 minutes ago
    const db = getDb();
    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(oldTime, agent.agent_id);

    const res = await get('/api/agents/stale?threshold_minutes=30');
    const staleAgents = res.body.stale_agents as Array<{ id: string }>;
    expect(staleAgents.some((a) => a.id === agent.agent_id)).toBe(true);
  });
});

describe('Deprovisioning', () => {
  it('deprovisions a single agent with cascade', async () => {
    const parent = await createAgent('deprov-parent');
    const childRes = await post(`/api/agents/${parent.agent_id}/delegate`, {
      parent_token: parent.token,
      child_name: 'deprov-child',
      requested_scope: ['read_file'],
      ttl_seconds: 1800,
    });
    const childId = childRes.body.child_agent_id as string;

    const res = await post(`/api/agents/${parent.agent_id}/deprovision`);
    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe(parent.agent_id);
    expect(res.body.agent_name).toBe('deprov-parent');
    expect(res.body.deprovisioned_at).toBeDefined();
    expect(res.body.cascade_revoked).toContain(childId);

    // Verify statuses
    const parentStatus = await get(`/api/agents/${parent.agent_id}`);
    expect(parentStatus.body.status).toBe('deprovisioned');

    const childStatus = await get(`/api/agents/${childId}`);
    expect(childStatus.body.status).toBe('deprovisioned');
  });

  it('rejects double deprovisioning', async () => {
    const agent = await createAgent('deprov-double');
    await post(`/api/agents/${agent.agent_id}/deprovision`);

    const res = await post(`/api/agents/${agent.agent_id}/deprovision`);
    expect(res.status).toBe(409);
  });

  it('rejects deprovisioning non-existent agent', async () => {
    const res = await post('/api/agents/nonexistent-id/deprovision');
    expect(res.status).toBe(404);
  });
});

describe('Human Deprovisioning', () => {
  it('deprovisions all agents for a human email', async () => {
    // Create multiple agents for alice@acme.com
    const agent1 = await createAgent('alice-agent-1', { human: HUMAN2 });
    const agent2 = await createAgent('alice-agent-2', { human: HUMAN2 });
    const agent3 = await createAgent('alice-agent-3', { human: HUMAN2 });

    const res = await post(`/api/humans/${encodeURIComponent(HUMAN2.human_email)}/deprovision`);
    expect(res.status).toBe(200);
    expect(res.body.human_email).toBe(HUMAN2.human_email);
    expect(res.body.agents_affected).toBeGreaterThanOrEqual(3);
    expect(res.body.message).toContain('alice@acme.com deprovisioned');
    expect(res.body.message).toContain('agents cascade revoked');

    // All three should be deprovisioned
    for (const id of [agent1.agent_id, agent2.agent_id, agent3.agent_id]) {
      const agentRes = await get(`/api/agents/${id}`);
      expect(agentRes.body.status).toBe('deprovisioned');
    }
  });

  it('handles deprovisioning with no agents gracefully', async () => {
    const res = await post('/api/humans/nobody@example.com/deprovision');
    expect(res.status).toBe(200);
    expect(res.body.agents_affected).toBe(0);
  });

  it('records human deprovisioning in audit log', async () => {
    const agent = await createAgent('audit-deprov', {
      human: {
        human_sub: 'audit-user',
        human_email: 'audit-deprov@example.com',
        human_iss: 'https://accounts.google.com',
      },
    });

    await post('/api/humans/audit-deprov@example.com/deprovision');

    const auditRes = await get('/api/audit?action=human_deprovisioned');
    expect(auditRes.status).toBe(200);
    const entries = auditRes.body.entries as Array<{ action: string; human_email: string }>;
    expect(
      entries.some((e) => e.action === 'human_deprovisioned' && e.human_email === 'audit-deprov@example.com')
    ).toBe(true);
  });
});

describe('Usage Tracking', () => {
  it('records and retrieves usage for an agent', async () => {
    const agent = await createAgent('usage-test', { scope: ['tool_x', 'tool_y'] });

    // Simulate some tool calls via verify endpoint
    await post('/api/verify', { token: agent.token, tool_name: 'tool_x' });
    await post('/api/verify', { token: agent.token, tool_name: 'tool_x' });
    await post('/api/verify', { token: agent.token, tool_name: 'tool_y' });

    // Manually record usage since verify doesn't auto-track yet
    const { recordUsage } = await import('../src/lifecycle.js');
    recordUsage(agent.agent_id, 'tool_call');
    recordUsage(agent.agent_id, 'tool_call');
    recordUsage(agent.agent_id, 'blocked_call');

    const res = await get(`/api/agents/${agent.agent_id}/usage`);
    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe(agent.agent_id);
    expect(res.body.agent_name).toBe('usage-test');

    const usage = res.body.usage as Array<{
      tool_calls: number;
      blocked_calls: number;
      errors: number;
    }>;
    expect(usage.length).toBeGreaterThan(0);

    const totals = usage.reduce(
      (acc, u) => ({
        tool_calls: acc.tool_calls + u.tool_calls,
        blocked_calls: acc.blocked_calls + u.blocked_calls,
        errors: acc.errors + u.errors,
      }),
      { tool_calls: 0, blocked_calls: 0, errors: 0 }
    );
    expect(totals.tool_calls).toBe(2);
    expect(totals.blocked_calls).toBe(1);
  });

  it('returns usage for non-existent agent as 404', async () => {
    const res = await get('/api/agents/nonexistent-id/usage');
    expect(res.status).toBe(404);
  });

  it('returns org-wide usage summary', async () => {
    const res = await get('/api/usage/summary');
    expect(res.status).toBe(200);
    expect(typeof res.body.total_tool_calls).toBe('number');
    expect(typeof res.body.total_blocked_calls).toBe('number');
    expect(typeof res.body.total_errors).toBe('number');
    expect(typeof res.body.active_agents).toBe('number');
    expect(Array.isArray(res.body.top_agents)).toBe(true);
  });

  it('records errors in usage', async () => {
    const agent = await createAgent('usage-errors');
    const { recordUsage } = await import('../src/lifecycle.js');
    recordUsage(agent.agent_id, 'error');
    recordUsage(agent.agent_id, 'error');
    recordUsage(agent.agent_id, 'error');

    const res = await get(`/api/agents/${agent.agent_id}/usage`);
    const usage = res.body.usage as Array<{ errors: number }>;
    const totalErrors = usage.reduce((sum, u) => sum + u.errors, 0);
    expect(totalErrors).toBe(3);
  });
});
