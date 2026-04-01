import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/server.js';
import { initDb, closeDb } from '../src/db.js';
import { ensureSigningKey } from '../src/tokens.js';

// Hono test helper — use app.request() instead of supertest
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

async function post(path: string, body: unknown) {
  const res = await request('POST', path, body);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function get(path: string) {
  const res = await request('GET', path);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function del(path: string) {
  const res = await request('DELETE', path);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// ─── Test Data ───

const HUMAN = {
  human_sub: 'user-123',
  human_email: 'alice@example.com',
  human_iss: 'https://accounts.google.com',
};

beforeAll(async () => {
  initDb(':memory:');
  await ensureSigningKey();
});

afterAll(() => {
  closeDb();
});

describe('Health Check', () => {
  it('GET /api/health returns ok', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'eigent-registry' });
  });
});

describe('Agent Registration', () => {
  it('registers a new agent and returns token', async () => {
    const res = await post('/api/agents', {
      name: 'code-reviewer',
      ...HUMAN,
      scope: ['read_file', 'write_file', 'run_tests'],
      max_delegation_depth: 3,
      ttl_seconds: 3600,
    });

    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBeDefined();
    expect(res.body.token).toBeDefined();
    expect(res.body.scope).toEqual(['read_file', 'write_file', 'run_tests']);
    expect(res.body.expires_at).toBeDefined();
  });

  it('rejects invalid input', async () => {
    const res = await post('/api/agents', {
      name: '',
      human_sub: '',
      scope: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });
});

describe('Full Flow: Register -> Delegate -> Verify -> Revoke', () => {
  let rootAgentId: string;
  let rootToken: string;
  let childAgentId: string;
  let childToken: string;

  it('Step 1: Register root agent', async () => {
    const res = await post('/api/agents', {
      name: 'orchestrator',
      ...HUMAN,
      scope: ['read_file', 'write_file', 'run_tests', 'deploy'],
      max_delegation_depth: 3,
      can_delegate: ['read_file', 'write_file', 'run_tests'],
      ttl_seconds: 7200,
    });

    expect(res.status).toBe(201);
    rootAgentId = res.body.agent_id as string;
    rootToken = res.body.token as string;
  });

  it('Step 2: Delegate to child agent with scope narrowing', async () => {
    const res = await post(`/api/agents/${rootAgentId}/delegate`, {
      parent_token: rootToken,
      child_name: 'test-runner',
      requested_scope: ['run_tests', 'deploy'],
      ttl_seconds: 3600,
    });

    expect(res.status).toBe(201);
    childAgentId = res.body.child_agent_id as string;
    childToken = res.body.token as string;
    // deploy is not in can_delegate, so only run_tests is granted
    expect(res.body.granted_scope).toEqual(['run_tests']);
    expect(res.body.denied_scope).toEqual(['deploy']);
    expect(res.body.delegation_depth).toBe(1);
  });

  it('Step 3: Verify child token — allowed tool', async () => {
    const res = await post('/api/verify', {
      token: childToken,
      tool_name: 'run_tests',
    });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
    expect(res.body.agent_id).toBe(childAgentId);
    expect(res.body.human_email).toBe(HUMAN.human_email);
    expect((res.body.delegation_chain as string[]).length).toBe(2);
  });

  it('Step 4: Verify child token — blocked tool', async () => {
    const res = await post('/api/verify', {
      token: childToken,
      tool_name: 'deploy',
    });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.reason).toContain('not in agent scope');
  });

  it('Step 5: Get agent details', async () => {
    const res = await get(`/api/agents/${childAgentId}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('test-runner');
    expect(res.body.parent_id).toBe(rootAgentId);
    expect(res.body.delegation_depth).toBe(1);
  });

  it('Step 6: Get delegation chain', async () => {
    const res = await get(`/api/agents/${childAgentId}/chain`);
    expect(res.status).toBe(200);
    expect((res.body.chain as unknown[]).length).toBe(2);
    expect(res.body.root_human_email).toBe(HUMAN.human_email);
    expect(res.body.depth).toBe(1);
  });

  it('Step 7: Revoke root — cascades to child', async () => {
    const res = await del(`/api/agents/${rootAgentId}`);
    expect(res.status).toBe(200);
    expect(res.body.revoked_agent_id).toBe(rootAgentId);
    expect((res.body.cascade_revoked as string[])).toContain(childAgentId);
    expect(res.body.total_revoked).toBe(2);
  });

  it('Step 8: Verify revoked token is rejected', async () => {
    const res = await post('/api/verify', {
      token: childToken,
      tool_name: 'run_tests',
    });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.reason).toContain('revoked');
  });
});

describe('Permission Narrowing', () => {
  it('child only gets intersection of parent delegatable and requested scope', async () => {
    const parentRes = await post('/api/agents', {
      name: 'parent-agent',
      ...HUMAN,
      scope: ['A', 'B', 'C'],
      can_delegate: ['A', 'B', 'C'],
      max_delegation_depth: 2,
      ttl_seconds: 3600,
    });

    const parentId = parentRes.body.agent_id as string;
    const parentToken = parentRes.body.token as string;

    const childRes = await post(`/api/agents/${parentId}/delegate`, {
      parent_token: parentToken,
      child_name: 'child-narrow',
      requested_scope: ['B', 'D'],
      ttl_seconds: 1800,
    });

    expect(childRes.status).toBe(201);
    expect(childRes.body.granted_scope).toEqual(['B']);
    expect(childRes.body.denied_scope).toEqual(['D']);
  });
});

describe('Delegation Depth Limit', () => {
  it('rejects delegation beyond max_delegation_depth', async () => {
    // Create root with max_depth=2
    const rootRes = await post('/api/agents', {
      name: 'depth-root',
      ...HUMAN,
      scope: ['tool_a'],
      can_delegate: ['tool_a'],
      max_delegation_depth: 2,
      ttl_seconds: 7200,
    });

    const rootId = rootRes.body.agent_id as string;
    const rootToken = rootRes.body.token as string;

    // Depth 0 -> 1
    const child1Res = await post(`/api/agents/${rootId}/delegate`, {
      parent_token: rootToken,
      child_name: 'depth-child-1',
      requested_scope: ['tool_a'],
      ttl_seconds: 3600,
    });
    expect(child1Res.status).toBe(201);
    expect(child1Res.body.delegation_depth).toBe(1);

    const child1Id = child1Res.body.child_agent_id as string;
    const child1Token = child1Res.body.token as string;

    // Depth 1 -> 2
    const child2Res = await post(`/api/agents/${child1Id}/delegate`, {
      parent_token: child1Token,
      child_name: 'depth-child-2',
      requested_scope: ['tool_a'],
      ttl_seconds: 1800,
    });
    expect(child2Res.status).toBe(201);
    expect(child2Res.body.delegation_depth).toBe(2);

    const child2Id = child2Res.body.child_agent_id as string;
    const child2Token = child2Res.body.token as string;

    // Depth 2 -> 3: should be rejected (max is 2)
    const child3Res = await post(`/api/agents/${child2Id}/delegate`, {
      parent_token: child2Token,
      child_name: 'depth-child-3',
      requested_scope: ['tool_a'],
      ttl_seconds: 900,
    });
    expect(child3Res.status).toBe(403);
    expect(child3Res.body.error).toContain('delegation depth');
  });
});

describe('Cascade Revocation', () => {
  it('revoking a mid-level agent cascades to all descendants', async () => {
    const rootRes = await post('/api/agents', {
      name: 'cascade-root',
      ...HUMAN,
      scope: ['x'],
      can_delegate: ['x'],
      max_delegation_depth: 5,
      ttl_seconds: 7200,
    });

    const rootId = rootRes.body.agent_id as string;
    const rootToken = rootRes.body.token as string;

    // Root -> Child A
    const childARes = await post(`/api/agents/${rootId}/delegate`, {
      parent_token: rootToken,
      child_name: 'child-a',
      requested_scope: ['x'],
      ttl_seconds: 3600,
    });
    const childAId = childARes.body.child_agent_id as string;
    const childAToken = childARes.body.token as string;

    // Child A -> Grandchild B
    const childBRes = await post(`/api/agents/${childAId}/delegate`, {
      parent_token: childAToken,
      child_name: 'grandchild-b',
      requested_scope: ['x'],
      ttl_seconds: 1800,
    });
    const childBId = childBRes.body.child_agent_id as string;

    // Revoke Child A -> should cascade to B
    const revokeRes = await del(`/api/agents/${childAId}`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.revoked_agent_id).toBe(childAId);
    expect((revokeRes.body.cascade_revoked as string[])).toContain(childBId);
    expect(revokeRes.body.total_revoked).toBe(2);

    // Root should still be active
    const rootStatus = await get(`/api/agents/${rootId}`);
    expect(rootStatus.body.status).toBe('active');

    // Grandchild should be revoked
    const grandchildStatus = await get(`/api/agents/${childBId}`);
    expect(grandchildStatus.body.status).toBe('revoked');
  });
});

describe('Token Expiry', () => {
  it('rejects expired tokens during verification', async () => {
    // Register with minimal TTL
    const res = await post('/api/agents', {
      name: 'expiring-agent',
      ...HUMAN,
      scope: ['tool_z'],
      ttl_seconds: 60, // minimum allowed
    });

    const agentId = res.body.agent_id as string;

    // Manually expire the agent in the DB by updating expires_at
    const { getDb } = await import('../src/db.js');
    const db = getDb();
    const pastDate = new Date(Date.now() - 1000).toISOString();
    db.prepare('UPDATE agents SET expires_at = ? WHERE id = ?').run(pastDate, agentId);

    // Try to verify — the DB check should catch the expiry
    const verifyRes = await post('/api/verify', {
      token: res.body.token,
      tool_name: 'tool_z',
    });

    // jose will reject the token because exp is in the JWT itself,
    // but we also check DB. The jose error happens first here.
    expect(verifyRes.body.allowed).toBe(false);
  });
});

describe('Revoked Token Rejection', () => {
  it('verify returns not-allowed for a revoked agent token', async () => {
    const res = await post('/api/agents', {
      name: 'soon-revoked',
      ...HUMAN,
      scope: ['tool_y'],
      ttl_seconds: 3600,
    });

    const agentId = res.body.agent_id as string;
    const token = res.body.token as string;

    // Revoke
    await del(`/api/agents/${agentId}`);

    // Verify
    const verifyRes = await post('/api/verify', {
      token,
      tool_name: 'tool_y',
    });

    expect(verifyRes.body.allowed).toBe(false);
    expect(verifyRes.body.reason).toContain('revoked');
  });
});

describe('List Agents', () => {
  it('lists active agents', async () => {
    const res = await get('/api/agents?status=active');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.agents)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });
});

describe('Audit Log', () => {
  it('returns audit entries with pagination', async () => {
    const res = await get('/api/audit?limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('filters by action', async () => {
    const res = await get('/api/audit?action=issued');
    expect(res.status).toBe(200);
    const entries = res.body.entries as { action: string }[];
    for (const entry of entries) {
      expect(entry.action).toBe('issued');
    }
  });
});

describe('JWKS Endpoint', () => {
  it('returns public keys in JWKS format', async () => {
    const res = await get('/api/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { keys: unknown[] }).keys)).toBe(true);
    const keys = (res.body as { keys: Record<string, unknown>[] }).keys;
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0].kty).toBeDefined();
    expect(keys[0].kid).toBeDefined();
  });
});

describe('Edge Cases', () => {
  it('returns 404 for non-existent agent', async () => {
    const res = await get('/api/agents/non-existent-id');
    expect(res.status).toBe(404);
  });

  it('returns 409 when revoking already-revoked agent', async () => {
    const regRes = await post('/api/agents', {
      name: 'double-revoke',
      ...HUMAN,
      scope: ['a'],
      ttl_seconds: 3600,
    });
    const agentId = regRes.body.agent_id as string;

    await del(`/api/agents/${agentId}`);
    const res = await del(`/api/agents/${agentId}`);
    expect(res.status).toBe(409);
  });

  it('token mismatch — parent token does not match parent ID', async () => {
    // Create two separate agents
    const agent1 = await post('/api/agents', {
      name: 'agent-1',
      ...HUMAN,
      scope: ['tool'],
      can_delegate: ['tool'],
      max_delegation_depth: 2,
      ttl_seconds: 3600,
    });
    const agent2 = await post('/api/agents', {
      name: 'agent-2',
      ...HUMAN,
      scope: ['tool'],
      can_delegate: ['tool'],
      max_delegation_depth: 2,
      ttl_seconds: 3600,
    });

    // Try to delegate from agent2's ID using agent1's token
    const res = await post(`/api/agents/${agent2.body.agent_id}/delegate`, {
      parent_token: agent1.body.token,
      child_name: 'sneaky',
      requested_scope: ['tool'],
      ttl_seconds: 1800,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('does not match');
  });

  it('delegation with no overlapping scopes returns 403', async () => {
    const parentRes = await post('/api/agents', {
      name: 'no-overlap-parent',
      ...HUMAN,
      scope: ['A', 'B'],
      can_delegate: ['A', 'B'],
      max_delegation_depth: 2,
      ttl_seconds: 3600,
    });

    const res = await post(`/api/agents/${parentRes.body.agent_id}/delegate`, {
      parent_token: parentRes.body.token,
      child_name: 'no-overlap-child',
      requested_scope: ['X', 'Y'],
      ttl_seconds: 1800,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('No requested scopes');
  });
});
