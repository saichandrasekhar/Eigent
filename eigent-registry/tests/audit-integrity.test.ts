import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb, insertAuditLog } from '../src/db.js';
import { verifyAuditChain, computeRowHash } from '../src/audit-integrity.js';

describe('Audit Integrity — Immutable Signed Audit Log', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('should return valid for an empty audit log', () => {
    const result = verifyAuditChain();
    expect(result.valid).toBe(true);
    expect(result.total_events).toBe(0);
  });

  it('should compute consistent row hashes', () => {
    const event = {
      id: 'evt-1',
      timestamp: '2026-01-01T00:00:00Z',
      agent_id: 'agent-1',
      human_email: 'alice@acme.com',
      action: 'issued',
      tool_name: null,
      delegation_chain: '["agent-1"]',
      details: '{"scope":["read"]}',
    };

    const hash1 = computeRowHash(event, 'genesis');
    const hash2 = computeRowHash(event, 'genesis');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce different hashes for different prev_hash values', () => {
    const event = {
      id: 'evt-1',
      timestamp: '2026-01-01T00:00:00Z',
      agent_id: 'agent-1',
      human_email: 'alice@acme.com',
      action: 'issued',
      tool_name: null,
      delegation_chain: null,
      details: null,
    };

    const hash1 = computeRowHash(event, 'genesis');
    const hash2 = computeRowHash(event, 'different-prev');
    expect(hash1).not.toBe(hash2);
  });

  it('should build a valid hash chain from inserted audit entries', () => {
    // We need a valid agent for FK. Seed one.
    getDb().exec(`
      INSERT INTO organizations (id, name, slug, created_at) VALUES ('default', 'Default', 'default', '2026-01-01T00:00:00Z');
    `);
    getDb().exec(`
      INSERT INTO agents (id, org_id, name, human_sub, human_email, human_iss, scope, token_jti, status, risk_level, created_at, expires_at)
      VALUES ('agent-1', 'default', 'test-agent', 'sub-1', 'alice@acme.com', 'https://demo.eigent.dev', '["read"]', 'jti-1', 'active', 'minimal', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
    `);

    insertAuditLog({
      id: 'evt-1',
      org_id: 'default',
      timestamp: '2026-01-01T00:00:01Z',
      agent_id: 'agent-1',
      human_email: 'alice@acme.com',
      action: 'issued',
      tool_name: null,
      delegation_chain: '["agent-1"]',
      details: '{"scope":["read"]}',
    });

    insertAuditLog({
      id: 'evt-2',
      org_id: 'default',
      timestamp: '2026-01-01T00:00:02Z',
      agent_id: 'agent-1',
      human_email: 'alice@acme.com',
      action: 'tool_call_allowed',
      tool_name: 'read_file',
      delegation_chain: '["agent-1"]',
      details: '{"reason":"in_scope"}',
    });

    insertAuditLog({
      id: 'evt-3',
      org_id: 'default',
      timestamp: '2026-01-01T00:00:03Z',
      agent_id: 'agent-1',
      human_email: 'alice@acme.com',
      action: 'revoked',
      tool_name: null,
      delegation_chain: '["agent-1"]',
      details: '{"reason":"direct_revocation"}',
    });

    const result = verifyAuditChain();
    expect(result.valid).toBe(true);
    expect(result.total_events).toBe(3);
  });

  it('should detect a tampered audit entry', () => {
    getDb().exec(`
      INSERT INTO organizations (id, name, slug, created_at) VALUES ('default', 'Default', 'default', '2026-01-01T00:00:00Z');
    `);
    getDb().exec(`
      INSERT INTO agents (id, org_id, name, human_sub, human_email, human_iss, scope, token_jti, status, risk_level, created_at, expires_at)
      VALUES ('agent-1', 'default', 'test-agent', 'sub-1', 'alice@acme.com', 'https://demo.eigent.dev', '["read"]', 'jti-1', 'active', 'minimal', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
    `);

    insertAuditLog({
      id: 'evt-1',
      org_id: 'default',
      timestamp: '2026-01-01T00:00:01Z',
      agent_id: 'agent-1',
      human_email: 'alice@acme.com',
      action: 'issued',
      tool_name: null,
      delegation_chain: null,
      details: null,
    });

    insertAuditLog({
      id: 'evt-2',
      org_id: 'default',
      timestamp: '2026-01-01T00:00:02Z',
      agent_id: 'agent-1',
      human_email: 'alice@acme.com',
      action: 'tool_call_allowed',
      tool_name: 'read_file',
      delegation_chain: null,
      details: null,
    });

    // Tamper with the first entry
    getDb().prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('tool_call_blocked', 'evt-1');

    const result = verifyAuditChain();
    expect(result.valid).toBe(false);
    expect(result.broken_at).toBe('evt-1');
  });

  it('should store prev_hash and row_hash columns in audit_log', () => {
    getDb().exec(`
      INSERT INTO organizations (id, name, slug, created_at) VALUES ('default', 'Default', 'default', '2026-01-01T00:00:00Z');
    `);
    getDb().exec(`
      INSERT INTO agents (id, org_id, name, human_sub, human_email, human_iss, scope, token_jti, status, risk_level, created_at, expires_at)
      VALUES ('agent-1', 'default', 'test-agent', 'sub-1', 'alice@acme.com', 'https://demo.eigent.dev', '["read"]', 'jti-1', 'active', 'minimal', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
    `);

    insertAuditLog({
      id: 'evt-1',
      org_id: 'default',
      timestamp: '2026-01-01T00:00:01Z',
      agent_id: 'agent-1',
      human_email: 'alice@acme.com',
      action: 'issued',
      tool_name: null,
      delegation_chain: null,
      details: null,
    });

    const row = getDb().prepare('SELECT prev_hash, row_hash FROM audit_log WHERE id = ?').get('evt-1') as {
      prev_hash: string;
      row_hash: string;
    };

    expect(row.prev_hash).toBe('genesis');
    expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
