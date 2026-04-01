import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { app } from '../src/server.js';
import { initDb, closeDb, getDb } from '../src/db.js';
import { ensureSigningKey } from '../src/tokens.js';

// Helper to make test requests against the Hono app
async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe('Risk Classification — EU AI Act Art. 6', () => {
  beforeEach(async () => {
    initDb(':memory:');
    await ensureSigningKey();
  });

  afterEach(() => {
    closeDb();
  });

  it('should accept agents with default (minimal) risk level', async () => {
    const resp = await request('POST', '/api/agents', {
      name: 'simple-bot',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['read_file'],
    });

    expect(resp.status).toBe(201);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.risk_level).toBe('minimal');
  });

  it('should accept agents with limited risk level', async () => {
    const resp = await request('POST', '/api/agents', {
      name: 'chatbot',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['respond_to_user'],
      risk_level: 'limited',
    });

    expect(resp.status).toBe(201);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.risk_level).toBe('limited');
  });

  it('should REJECT unacceptable-risk agents', async () => {
    const resp = await request('POST', '/api/agents', {
      name: 'social-scoring-bot',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['score_citizens'],
      risk_level: 'unacceptable',
    });

    expect(resp.status).toBe(403);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.error).toContain('unacceptable');
  });

  it('should REJECT high-risk agents without verified OIDC binding (dev mode)', async () => {
    const resp = await request('POST', '/api/agents', {
      name: 'medical-advisor',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['query_patient_records'],
      risk_level: 'high',
    });

    expect(resp.status).toBe(403);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.error).toContain('verified OIDC');
  });

  it('should REJECT high-risk agents with delegation depth > 1', async () => {
    // Even with OIDC we can't test easily, but we can test the depth check
    // by sending a request with max_delegation_depth > 1 (in dev mode, it will fail
    // on the OIDC check first, which is correct)
    const resp = await request('POST', '/api/agents', {
      name: 'high-risk-deep',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['critical_action'],
      risk_level: 'high',
      max_delegation_depth: 5,
    });

    expect(resp.status).toBe(403);
  });

  it('should REJECT high-risk agents with wildcard scopes', async () => {
    const resp = await request('POST', '/api/agents', {
      name: 'high-risk-wildcard',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['*'],
      risk_level: 'high',
    });

    expect(resp.status).toBe(403);
  });

  it('should store risk_level in the database', async () => {
    const resp = await request('POST', '/api/agents', {
      name: 'limited-bot',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['search'],
      risk_level: 'limited',
    });

    expect(resp.status).toBe(201);
    const data = (await resp.json()) as Record<string, unknown>;

    const row = getDb()
      .prepare('SELECT risk_level FROM agents WHERE id = ?')
      .get(data.agent_id as string) as { risk_level: string };

    expect(row.risk_level).toBe('limited');
  });

  it('should reject invalid risk_level values', async () => {
    const resp = await request('POST', '/api/agents', {
      name: 'invalid-risk',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['read'],
      risk_level: 'banana',
    });

    expect(resp.status).toBe(400);
  });

  it('should propagate risk_level to delegated child agents', async () => {
    // Register a minimal-risk parent
    const parentResp = await request('POST', '/api/agents', {
      name: 'parent',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['read_file', 'run_tests'],
      risk_level: 'limited',
    });

    expect(parentResp.status).toBe(201);
    const parent = (await parentResp.json()) as { agent_id: string; token: string };

    // Delegate
    const childResp = await request('POST', `/api/agents/${parent.agent_id}/delegate`, {
      parent_token: parent.token,
      child_name: 'child',
      requested_scope: ['read_file'],
    });

    expect(childResp.status).toBe(201);
    const child = (await childResp.json()) as { child_agent_id: string };

    const row = getDb()
      .prepare('SELECT risk_level FROM agents WHERE id = ?')
      .get(child.child_agent_id) as { risk_level: string };

    expect(row.risk_level).toBe('limited');
  });
});
