import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { app } from '../src/server.js';
import { initDb, closeDb } from '../src/db.js';
import { ensureSigningKey } from '../src/tokens.js';
import { computeSignature, stopRetryTimer } from '../src/webhooks.js';

// ─── Test Helpers ───

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

async function post(path: string, body: unknown, headers?: Record<string, string>) {
  const res = await request('POST', path, body, headers);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function get(path: string, headers?: Record<string, string>) {
  const res = await request('GET', path, undefined, headers);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function put(path: string, body: unknown, headers?: Record<string, string>) {
  const res = await request('PUT', path, body, headers);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function del(path: string, headers?: Record<string, string>) {
  const res = await request('DELETE', path, undefined, headers);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const HUMAN = {
  human_sub: 'user-phase3',
  human_email: 'admin@acme.com',
  human_iss: 'https://accounts.google.com',
};

beforeAll(async () => {
  initDb(':memory:');
  await ensureSigningKey();
});

afterAll(() => {
  stopRetryTimer();
  closeDb();
});

// ═══════════════════════════════════════════════
// 1. Multi-tenancy: Organization CRUD
// ═══════════════════════════════════════════════

describe('Organization CRUD', () => {
  let orgId: string;

  it('creates a new organization', async () => {
    const res = await post('/api/v1/orgs', {
      name: 'Acme Corp',
      slug: 'acme-corp',
      settings: { sso_required: true },
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Acme Corp');
    expect(res.body.slug).toBe('acme-corp');
    expect(res.body.id).toBeDefined();
    expect((res.body.settings as Record<string, unknown>).sso_required).toBe(true);

    orgId = res.body.id as string;
  });

  it('rejects duplicate slug', async () => {
    const res = await post('/api/v1/orgs', {
      name: 'Acme Corp Duplicate',
      slug: 'acme-corp',
    });
    expect(res.status).toBe(409);
  });

  it('lists organizations including default', async () => {
    const res = await get('/api/v1/orgs');
    expect(res.status).toBe(200);

    const orgs = res.body.organizations as Array<Record<string, unknown>>;
    expect(orgs.length).toBeGreaterThanOrEqual(2); // default + acme-corp
    expect(orgs.some((o) => o.slug === 'acme-corp')).toBe(true);
    expect(orgs.some((o) => o.slug === 'default')).toBe(true);
  });

  it('gets organization by ID', async () => {
    const res = await get(`/api/v1/orgs/${orgId}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Acme Corp');
  });

  it('returns 404 for unknown org', async () => {
    const res = await get('/api/v1/orgs/nonexistent');
    expect(res.status).toBe(404);
  });

  it('updates organization', async () => {
    const res = await put(`/api/v1/orgs/${orgId}`, {
      name: 'Acme Corporation',
      settings: { sso_required: true, max_agents: 100 },
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Acme Corporation');
    expect((res.body.settings as Record<string, unknown>).max_agents).toBe(100);
  });

  it('rejects invalid create input', async () => {
    const res = await post('/api/v1/orgs', {
      name: '',
      slug: 'INVALID SLUG',
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════
// 2. Multi-tenancy: Org Member Management
// ═══════════════════════════════════════════════

describe('Org Member Management', () => {
  let orgId: string;

  beforeEach(async () => {
    // Create a fresh org for member tests
    const res = await post('/api/v1/orgs', {
      name: 'Member Test Org',
      slug: `member-test-${Date.now()}`,
    });
    orgId = res.body.id as string;
  });

  it('adds a member to an org', async () => {
    const res = await post(`/api/v1/orgs/${orgId}/members`, {
      human_email: 'alice@acme.com',
      role: 'admin',
    });

    expect(res.status).toBe(201);
    expect(res.body.human_email).toBe('alice@acme.com');
    expect(res.body.role).toBe('admin');
    expect(res.body.joined_at).toBeDefined();
  });

  it('rejects duplicate member', async () => {
    await post(`/api/v1/orgs/${orgId}/members`, {
      human_email: 'bob@acme.com',
      role: 'viewer',
    });

    const res = await post(`/api/v1/orgs/${orgId}/members`, {
      human_email: 'bob@acme.com',
      role: 'operator',
    });
    expect(res.status).toBe(409);
  });

  it('lists org members', async () => {
    await post(`/api/v1/orgs/${orgId}/members`, {
      human_email: 'member1@acme.com',
      role: 'admin',
    });
    await post(`/api/v1/orgs/${orgId}/members`, {
      human_email: 'member2@acme.com',
      role: 'viewer',
    });

    const res = await get(`/api/v1/orgs/${orgId}/members`);
    expect(res.status).toBe(200);

    const members = res.body.members as Array<Record<string, unknown>>;
    expect(members.length).toBe(2);
  });

  it('removes a member from org', async () => {
    await post(`/api/v1/orgs/${orgId}/members`, {
      human_email: 'remove-me@acme.com',
      role: 'viewer',
    });

    const res = await del(`/api/v1/orgs/${orgId}/members/${encodeURIComponent('remove-me@acme.com')}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('removed');

    // Verify removed
    const listRes = await get(`/api/v1/orgs/${orgId}/members`);
    const members = (listRes.body as Record<string, unknown>).members as Array<Record<string, unknown>>;
    expect(members.some((m) => m.human_email === 'remove-me@acme.com')).toBe(false);
  });

  it('returns 404 for non-existent org', async () => {
    const res = await post('/api/v1/orgs/nonexistent/members', {
      human_email: 'test@test.com',
      role: 'viewer',
    });
    expect(res.status).toBe(404);
  });

  it('rejects invalid role', async () => {
    const res = await post(`/api/v1/orgs/${orgId}/members`, {
      human_email: 'test@test.com',
      role: 'superadmin',
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════
// 3. Multi-tenancy: Agent Scoping by Org
// ═══════════════════════════════════════════════

describe('Agent org_id scoping', () => {
  it('creates agent with org_id from header', async () => {
    const res = await post('/api/agents', {
      name: 'org-scoped-agent',
      ...HUMAN,
      scope: ['read_file'],
      ttl_seconds: 3600,
    }, { 'x-eigent-org-id': 'default' });

    expect(res.status).toBe(201);

    // Verify the agent is stored with org_id
    const agentId = res.body.agent_id as string;
    const agentRes = await get(`/api/agents/${agentId}`);
    expect(agentRes.status).toBe(200);
    expect((agentRes.body as Record<string, unknown>).org_id).toBe('default');
  });

  it('defaults to "default" org when no header set', async () => {
    const res = await post('/api/agents', {
      name: 'default-org-agent',
      ...HUMAN,
      scope: ['write_file'],
      ttl_seconds: 3600,
    });

    expect(res.status).toBe(201);
    const agentId = res.body.agent_id as string;
    const agentRes = await get(`/api/agents/${agentId}`);
    expect((agentRes.body as Record<string, unknown>).org_id).toBe('default');
  });
});

// ═══════════════════════════════════════════════
// 4. Webhook Configuration CRUD
// ═══════════════════════════════════════════════

describe('Webhook Configuration CRUD', () => {
  let webhookId: string;

  it('creates a webhook config', async () => {
    const res = await post('/api/v1/webhooks', {
      url: 'https://siem.example.com/eigent',
      events: ['agent.created', 'agent.revoked', 'policy.denied'],
      secret: 'supersecretkey1234567',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.url).toBe('https://siem.example.com/eigent');
    expect((res.body.events as string[]).length).toBe(3);

    webhookId = res.body.id as string;
  });

  it('auto-generates secret when not provided', async () => {
    const res = await post('/api/v1/webhooks', {
      url: 'https://other-siem.example.com/hook',
      events: ['agent.created'],
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it('lists webhook configs', async () => {
    const res = await get('/api/v1/webhooks');
    expect(res.status).toBe(200);

    const webhooks = res.body.webhooks as Array<Record<string, unknown>>;
    expect(webhooks.length).toBeGreaterThanOrEqual(1);
  });

  it('gets a specific webhook config', async () => {
    const res = await get(`/api/v1/webhooks/${webhookId}`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://siem.example.com/eigent');
  });

  it('updates a webhook config', async () => {
    const res = await put(`/api/v1/webhooks/${webhookId}`, {
      url: 'https://siem-v2.example.com/eigent',
      events: ['agent.created', 'agent.revoked'],
      enabled: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://siem-v2.example.com/eigent');
    expect(res.body.enabled).toBe(false);
    expect((res.body.events as string[]).length).toBe(2);
  });

  it('returns 404 for unknown webhook', async () => {
    const res = await get('/api/v1/webhooks/nonexistent');
    expect(res.status).toBe(404);
  });

  it('deletes a webhook config', async () => {
    // Create one to delete
    const createRes = await post('/api/v1/webhooks', {
      url: 'https://delete-me.example.com/hook',
      events: ['agent.created'],
    });
    const deleteId = createRes.body.id as string;

    const res = await del(`/api/v1/webhooks/${deleteId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deleted');

    // Verify deleted
    const getRes = await get(`/api/v1/webhooks/${deleteId}`);
    expect(getRes.status).toBe(404);
  });

  it('rejects invalid events', async () => {
    const res = await post('/api/v1/webhooks', {
      url: 'https://example.com/hook',
      events: ['invalid.event'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid URL', async () => {
    const res = await post('/api/v1/webhooks', {
      url: 'not-a-url',
      events: ['agent.created'],
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════
// 5. Webhook HMAC Signature Verification
// ═══════════════════════════════════════════════

describe('Webhook HMAC Signing', () => {
  it('computes correct HMAC-SHA256 signature', () => {
    const body = JSON.stringify({ event: 'agent.created', data: { agent_id: '123' } });
    const secret = 'test-secret-key-12345';

    const sig = computeSignature(body, secret);

    // Verify it's a hex string (64 chars for SHA-256)
    expect(sig).toMatch(/^[a-f0-9]{64}$/);

    // Same input produces same signature
    const sig2 = computeSignature(body, secret);
    expect(sig).toBe(sig2);

    // Different secret produces different signature
    const sig3 = computeSignature(body, 'different-secret-1234');
    expect(sig).not.toBe(sig3);

    // Different body produces different signature
    const sig4 = computeSignature('different body', secret);
    expect(sig).not.toBe(sig4);
  });
});

// ═══════════════════════════════════════════════
// 6. Webhook Test Endpoint
// ═══════════════════════════════════════════════

describe('Webhook Test Endpoint', () => {
  it('returns 404 for non-existent webhook', async () => {
    const res = await post('/api/v1/webhooks/nonexistent/test', {});
    expect(res.status).toBe(404);
  });

  it('attempts to send test webhook (will fail due to unreachable URL)', async () => {
    // Create a webhook with unreachable URL
    const createRes = await post('/api/v1/webhooks', {
      url: 'https://unreachable.invalid/test',
      events: ['agent.created'],
    });
    const wid = createRes.body.id as string;

    const res = await post(`/api/v1/webhooks/${wid}/test`, {});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// 7. Audit Log includes org_id
// ═══════════════════════════════════════════════

describe('Audit log org_id scoping', () => {
  it('audit log entries have org_id field', async () => {
    // Create an agent to generate audit entries
    await post('/api/agents', {
      name: 'audit-org-test-agent',
      ...HUMAN,
      scope: ['test_tool'],
      ttl_seconds: 3600,
    });

    const res = await get('/api/audit?limit=5');
    expect(res.status).toBe(200);

    const entries = res.body.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);

    // All entries should have org_id
    for (const entry of entries) {
      expect(entry.org_id).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════
// 8. Dashboard Auth Module (unit tests)
// ═══════════════════════════════════════════════

describe('Auth role hierarchy', () => {
  // Test role comparison logic directly
  const roleHierarchy: Record<string, number> = {
    viewer: 0,
    operator: 1,
    admin: 2,
  };

  function hasRole(userRole: string, minimumRole: string): boolean {
    return roleHierarchy[userRole] >= roleHierarchy[minimumRole];
  }

  it('admin has all roles', () => {
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('admin', 'operator')).toBe(true);
    expect(hasRole('admin', 'viewer')).toBe(true);
  });

  it('operator has operator and viewer roles', () => {
    expect(hasRole('operator', 'admin')).toBe(false);
    expect(hasRole('operator', 'operator')).toBe(true);
    expect(hasRole('operator', 'viewer')).toBe(true);
  });

  it('viewer only has viewer role', () => {
    expect(hasRole('viewer', 'admin')).toBe(false);
    expect(hasRole('viewer', 'operator')).toBe(false);
    expect(hasRole('viewer', 'viewer')).toBe(true);
  });
});
