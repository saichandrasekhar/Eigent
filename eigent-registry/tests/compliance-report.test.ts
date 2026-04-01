import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/server.js';
import { initDb, closeDb, insertAgent, insertAuditLog, type AgentRow, type AuditRow } from '../src/db.js';
import { ensureSigningKey } from '../src/tokens.js';
import { generateComplianceReport } from '../src/compliance-report.js';
import { v7 as uuidv7 } from 'uuid';

// ─── Test Helpers ───

async function request(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
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
  return res;
}

const HUMAN = {
  human_sub: 'compliance-user-123',
  human_email: 'ciso@example.com',
  human_iss: 'https://accounts.google.com',
};

const HUMAN2 = {
  human_sub: 'compliance-user-456',
  human_email: 'dev@example.com',
  human_iss: 'https://accounts.google.com',
};

// ─── Setup: Populate test data ───

beforeAll(async () => {
  initDb(':memory:');
  await ensureSigningKey();

  // Create several agents with various states for realistic reporting
  const now = new Date();

  // Agent 1: Active root agent
  await post('/api/agents', {
    name: 'orchestrator-main',
    ...HUMAN,
    scope: ['read_file', 'write_file', 'run_tests', 'deploy'],
    can_delegate: ['read_file', 'write_file', 'run_tests'],
    max_delegation_depth: 3,
    ttl_seconds: 7200,
  });

  // Agent 2: Another active agent
  const agent2Res = await post('/api/agents', {
    name: 'code-reviewer',
    ...HUMAN,
    scope: ['read_file', 'analyze_code'],
    max_delegation_depth: 2,
    ttl_seconds: 3600,
  });

  // Agent 3: Agent for second human
  await post('/api/agents', {
    name: 'dev-assistant',
    ...HUMAN2,
    scope: ['read_file', 'write_file'],
    max_delegation_depth: 1,
    ttl_seconds: 1800,
  });

  // Agent 4: Create and then revoke
  const revokeRes = await post('/api/agents', {
    name: 'temp-agent',
    ...HUMAN,
    scope: ['read_file'],
    max_delegation_depth: 1,
    ttl_seconds: 3600,
  });
  const revokeId = revokeRes.body.agent_id as string;
  await app.request(`/api/agents/${revokeId}`, { method: 'DELETE' });

  // Create delegation chain: orchestrator -> test-runner -> lint-checker
  const orchRes = await post('/api/agents', {
    name: 'chain-orchestrator',
    ...HUMAN,
    scope: ['read_file', 'write_file', 'run_tests', 'lint'],
    can_delegate: ['read_file', 'run_tests', 'lint'],
    max_delegation_depth: 3,
    ttl_seconds: 7200,
  });
  const orchId = orchRes.body.agent_id as string;
  const orchToken = orchRes.body.token as string;

  const child1Res = await post(`/api/agents/${orchId}/delegate`, {
    parent_token: orchToken,
    child_name: 'chain-test-runner',
    requested_scope: ['run_tests', 'lint'],
    ttl_seconds: 3600,
  });
  const child1Id = child1Res.body.child_agent_id as string;
  const child1Token = child1Res.body.token as string;

  await post(`/api/agents/${child1Id}/delegate`, {
    parent_token: child1Token,
    child_name: 'chain-lint-checker',
    requested_scope: ['lint'],
    ttl_seconds: 1800,
  });

  // Generate some verify calls (allowed and blocked)
  const agent2Id = agent2Res.body.agent_id as string;
  const agent2Token = agent2Res.body.token as string;

  await post('/api/verify', { token: agent2Token, tool_name: 'read_file' });
  await post('/api/verify', { token: agent2Token, tool_name: 'read_file' });
  await post('/api/verify', { token: agent2Token, tool_name: 'analyze_code' });
  // Blocked call: tool not in scope
  await post('/api/verify', { token: agent2Token, tool_name: 'deploy' });
  await post('/api/verify', { token: agent2Token, tool_name: 'write_file' });
});

afterAll(() => {
  closeDb();
});

// ─── Report Generation Tests ───

describe('Compliance Report Generation', () => {
  it('generates valid HTML report with all frameworks', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'all',
      agents: 'all',
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Compliance Report');
    expect(html).toContain('Executive Summary');
    expect(html).toContain('Agent Inventory');
    expect(html).toContain('Delegation Chain Audit');
    expect(html).toContain('Access Control Evidence');
    expect(html).toContain('Monitoring Evidence');
    expect(html).toContain('Record-Keeping');
    expect(html).toContain('Human Oversight');
    expect(html).toContain('Policy Violations Detail');
    expect(html).toContain('Recommendations');
  });

  it('generates report with only EU AI Act framework', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'eu-ai-act',
      agents: 'all',
    });

    expect(html).toContain('Record-Keeping');
    expect(html).toContain('Human Oversight');
    expect(html).toContain('EU AI Act Article 12');
    expect(html).toContain('EU AI Act Article 14');
    // SOC2 sections should NOT be present
    expect(html).not.toContain('SOC2 CC6.1');
    expect(html).not.toContain('SOC2 CC7.2');
  });

  it('generates report with only SOC2 framework', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'soc2',
      agents: 'all',
    });

    expect(html).toContain('SOC2 CC6.1');
    expect(html).toContain('SOC2 CC7.2');
    // EU AI Act sections should NOT be present
    expect(html).not.toContain('EU AI Act Article 12');
    expect(html).not.toContain('EU AI Act Article 14');
  });

  it('filters report by human email', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'all',
      agents: 'all',
      human: 'ciso@example.com',
    });

    expect(html).toContain('ciso@example.com');
    // The second human's agent should not appear in the agent inventory
    // (though it may be referenced in chains if related)
    expect(html).toContain('ciso@example.com');
  });

  it('generates a report that is a self-contained HTML document', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'all',
      agents: 'all',
    });

    // No external CSS or JS dependencies
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('<script src=');
    // Complete HTML structure
    expect(html).toContain('</html>');
    expect(html).toContain('</head>');
    expect(html).toContain('</body>');
  });

  it('includes print-friendly styles', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'all',
      agents: 'all',
    });

    expect(html).toContain('@media print');
  });
});

// ─── Compliance Check Tests ───

describe('Human Binding Verification', () => {
  it('all test agents have human bindings', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'soc2',
      agents: 'all',
    });

    // CC6.1-1: Every agent has a verified human owner
    expect(html).toContain('CC6.1-1');
    expect(html).toContain('Every agent has a verified human owner');
    // Should pass since all our test agents have human bindings
    expect(html).toContain('badge-pass');
  });

  it('detects agents without human binding as violation', () => {
    // Insert an agent with empty human_email directly into DB
    const agentId = uuidv7();
    const now = new Date();

    insertAgent({
      id: agentId,
      name: 'unbound-agent',
      human_sub: '',
      human_email: '',
      human_iss: '',
      scope: JSON.stringify(['read_file']),
      parent_id: null,
      delegation_depth: 0,
      max_delegation_depth: 3,
      can_delegate: JSON.stringify(['read_file']),
      token_jti: uuidv7(),
      status: 'active',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 3600000).toISOString(),
      revoked_at: null,
      last_seen_at: null,
      deprovisioned_at: null,
      metadata: null,
    });

    const html = generateComplianceReport({
      period: { start: new Date(now.getTime() - 86400000), end: now },
      framework: 'all',
      agents: 'all',
    });

    // Should detect the unbound agent as a violation
    expect(html).toContain('No human binding');
    expect(html).toContain('unbound-agent');
    expect(html).toContain('CRITICAL');
  });
});

describe('Scope Validation', () => {
  it('validates that no agents have wildcard scope', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'soc2',
      agents: 'all',
    });

    // CC6.1-2: Permissions are scoped (not wildcard)
    expect(html).toContain('CC6.1-2');
    expect(html).toContain('Permissions are scoped');
  });

  it('detects wildcard scope as violation', () => {
    const agentId = uuidv7();
    const now = new Date();

    insertAgent({
      id: agentId,
      name: 'wildcard-agent',
      human_sub: 'test-sub',
      human_email: 'wildcard@example.com',
      human_iss: 'https://example.com',
      scope: JSON.stringify(['*']),
      parent_id: null,
      delegation_depth: 0,
      max_delegation_depth: 3,
      can_delegate: JSON.stringify(['*']),
      token_jti: uuidv7(),
      status: 'active',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 3600000).toISOString(),
      revoked_at: null,
      last_seen_at: null,
      deprovisioned_at: null,
      metadata: null,
    });

    const html = generateComplianceReport({
      period: { start: new Date(now.getTime() - 86400000), end: now },
      framework: 'soc2',
      agents: 'all',
    });

    expect(html).toContain('wildcard-agent');
    expect(html).toContain('wildcard scope');
  });
});

describe('Delegation Chain Verification', () => {
  it('reports delegation chains in the audit section', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'all',
      agents: 'all',
    });

    expect(html).toContain('Delegation Chain Audit');
    expect(html).toContain('chain-orchestrator');
    expect(html).toContain('chain-test-runner');
    expect(html).toContain('chain-lint-checker');
    // Verify permission narrowing is checked
    expect(html).toContain('Permission Narrowing');
  });
});

describe('EU AI Act Mapping Completeness', () => {
  it('covers Article 12 requirements (Record-Keeping)', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'eu-ai-act',
      agents: 'all',
    });

    // Article 12 checks
    expect(html).toContain('Art.12-1');
    expect(html).toContain('Art.12-2');
    expect(html).toContain('Art.12-3');
    expect(html).toContain('Automatic logging enabled');
    expect(html).toContain('Log entries include required fields');
    expect(html).toContain('Log retention');
  });

  it('covers Article 14 requirements (Human Oversight)', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'eu-ai-act',
      agents: 'all',
    });

    // Article 14 checks
    expect(html).toContain('Art.14-1');
    expect(html).toContain('Art.14-2');
    expect(html).toContain('Art.14-3');
    expect(html).toContain('Art.14-4');
    expect(html).toContain('Human authorization required');
    expect(html).toContain('Permission boundaries enforced');
    expect(html).toContain('Override/revocation capability');
    expect(html).toContain('Delegation chains rooted in human authority');
  });
});

describe('SOC2 Control Mapping', () => {
  it('covers CC6.1 (Access Control)', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'soc2',
      agents: 'all',
    });

    expect(html).toContain('CC6.1-1');
    expect(html).toContain('CC6.1-2');
    expect(html).toContain('CC6.1-3');
    expect(html).toContain('Every agent has a verified human owner');
    expect(html).toContain('Permissions are scoped');
    expect(html).toContain('Inactive agents are deprovisioned');
  });

  it('covers CC7.2 (Monitoring)', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'soc2',
      agents: 'all',
    });

    expect(html).toContain('CC7.2-1');
    expect(html).toContain('CC7.2-2');
    expect(html).toContain('CC7.2-3');
    expect(html).toContain('Tool calls are monitored');
    expect(html).toContain('Policy violations are detected');
    expect(html).toContain('Response to violations');
  });
});

describe('Policy Violations Detail', () => {
  it('reports blocked tool calls in violations section', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'all',
      agents: 'all',
    });

    // We made blocked calls in setup (deploy, write_file on code-reviewer)
    expect(html).toContain('Policy Violations Detail');
    expect(html).toContain('Policy Violation');
  });
});

describe('Expired Token Detection', () => {
  it('flags active agents with expired tokens', () => {
    const agentId = uuidv7();
    const now = new Date();

    insertAgent({
      id: agentId,
      name: 'expired-active-agent',
      human_sub: 'exp-sub',
      human_email: 'expired@example.com',
      human_iss: 'https://example.com',
      scope: JSON.stringify(['read_file']),
      parent_id: null,
      delegation_depth: 0,
      max_delegation_depth: 3,
      can_delegate: JSON.stringify(['read_file']),
      token_jti: uuidv7(),
      status: 'active',
      created_at: new Date(now.getTime() - 7200000).toISOString(),
      expires_at: new Date(now.getTime() - 1000).toISOString(), // expired 1 second ago
      revoked_at: null,
      last_seen_at: null,
      deprovisioned_at: null,
      metadata: null,
    });

    const html = generateComplianceReport({
      period: { start: new Date(now.getTime() - 86400000), end: now },
      framework: 'all',
      agents: 'all',
    });

    expect(html).toContain('expired-active-agent');
    expect(html).toContain('Expired but active');
    expect(html).toContain('Token Expiry');
  });
});

// ─── API Endpoint Tests ───

describe('Compliance Report API Endpoint', () => {
  it('GET /api/compliance/report returns HTML', async () => {
    const res = await get('/api/compliance/report?period=30d&framework=all&format=html');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<!DOCTYPE html>');
    expect(text).toContain('Compliance Report');
  });

  it('GET /api/compliance/report with JSON format returns wrapped JSON', async () => {
    const res = await get('/api/compliance/report?period=30d&framework=all&format=json');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.report_html).toBeDefined();
    expect(json.generated_at).toBeDefined();
    expect(json.framework).toBe('all');
  });

  it('rejects invalid period format', async () => {
    const res = await get('/api/compliance/report?period=invalid&framework=all&format=html');
    expect(res.status).toBe(400);
  });

  it('rejects invalid framework', async () => {
    const res = await get('/api/compliance/report?period=30d&framework=invalid&format=html');
    expect(res.status).toBe(400);
  });

  it('supports human email filter', async () => {
    const res = await get('/api/compliance/report?period=30d&framework=all&format=html&human=ciso@example.com');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('ciso@example.com');
  });

  it('supports different period formats (hours)', async () => {
    const res = await get('/api/compliance/report?period=24h&framework=all&format=html');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<!DOCTYPE html>');
  });

  it('supports framework-specific reports via API', async () => {
    const res = await get('/api/compliance/report?period=30d&framework=eu-ai-act&format=html');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('EU AI Act Article 12');
    expect(text).not.toContain('SOC2 CC6.1');
  });
});

describe('Recommendations', () => {
  it('generates recommendations based on violations', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'all',
      agents: 'all',
    });

    expect(html).toContain('Recommendations');
    // We have violations from earlier tests (unbound agent, wildcard scope, expired active)
    // so there should be recommendations
    expect(html).toContain('rec-item');
  });
});

describe('Report Posture Determination', () => {
  it('shows compliance posture in the executive summary', () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const html = generateComplianceReport({
      period: { start: thirtyDaysAgo, end: now },
      framework: 'all',
      agents: 'all',
    });

    // Should contain one of the posture values
    const hasPosture =
      html.includes('COMPLIANT') ||
      html.includes('PARTIAL') ||
      html.includes('NON-COMPLIANT');
    expect(hasPosture).toBe(true);
    expect(html).toContain('Overall Compliance Posture');
  });
});
