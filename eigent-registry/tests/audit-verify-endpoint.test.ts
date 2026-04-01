import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { app } from '../src/server.js';
import { initDb, closeDb, getDb } from '../src/db.js';
import { ensureSigningKey } from '../src/tokens.js';

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe('GET /api/v1/audit/verify — Audit Chain Integrity Endpoint', () => {
  beforeEach(async () => {
    initDb(':memory:');
    await ensureSigningKey();
  });

  afterEach(() => {
    closeDb();
  });

  it('should return valid for empty audit log', async () => {
    const resp = await request('GET', '/api/v1/audit/verify');
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as { valid: boolean; total_events: number };
    expect(data.valid).toBe(true);
    expect(data.total_events).toBe(0);
  });

  it('should return valid after registering an agent (which creates audit entries)', async () => {
    // Register an agent (creates an audit log entry with hash chain)
    await request('POST', '/api/agents', {
      name: 'test-bot',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['read_file'],
    });

    const resp = await request('GET', '/api/v1/audit/verify');
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as { valid: boolean; total_events: number };
    expect(data.valid).toBe(true);
    expect(data.total_events).toBeGreaterThan(0);
  });

  it('should detect tampering in the audit log', async () => {
    // Register agent
    await request('POST', '/api/agents', {
      name: 'test-bot',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['read_file'],
    });

    // Tamper with the audit entry
    getDb().prepare("UPDATE audit_log SET action = 'tampered' WHERE rowid = 1").run();

    const resp = await request('GET', '/api/v1/audit/verify');
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as { valid: boolean; broken_at?: string };
    expect(data.valid).toBe(false);
    expect(data.broken_at).toBeDefined();
  });

  it('should validate a multi-entry chain correctly', async () => {
    // Create multiple audit entries via different operations
    const agentResp = await request('POST', '/api/agents', {
      name: 'bot-1',
      human_sub: 'alice',
      human_email: 'alice@acme.com',
      human_iss: 'https://demo.eigent.dev',
      scope: ['read_file', 'run_tests'],
    });

    const agent = (await agentResp.json()) as { agent_id: string; token: string };

    // Verify a tool call (creates another audit entry)
    await request('POST', '/api/verify', {
      token: agent.token,
      tool_name: 'read_file',
    });

    // Revoke (creates audit entries for revocation)
    await request('DELETE', `/api/agents/${agent.agent_id}`);

    const resp = await request('GET', '/api/v1/audit/verify');
    const data = (await resp.json()) as { valid: boolean; total_events: number };
    expect(data.valid).toBe(true);
    expect(data.total_events).toBeGreaterThanOrEqual(3);
  });
});
