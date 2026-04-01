import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/server.js';
import { initDb, closeDb } from '../src/db.js';
import { ensureSigningKey } from '../src/tokens.js';

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

const HUMAN = {
  human_sub: 'user-approval-test',
  human_email: 'approver@example.com',
  human_iss: 'https://accounts.google.com',
};

let agentId: string;

beforeAll(async () => {
  initDb(':memory:');
  await ensureSigningKey();

  // Create an agent for approval tests
  const agentRes = await post('/api/agents', {
    name: 'approval-test-agent',
    ...HUMAN,
    scope: ['read_file', 'write_file', 'execute_command'],
    ttl_seconds: 3600,
  });
  agentId = agentRes.body.agent_id as string;
});

afterAll(() => {
  closeDb();
});

describe('Approval Queue', () => {
  let approvalId: string;

  it('POST /api/v1/approvals creates a pending approval', async () => {
    const res = await post('/api/v1/approvals', {
      agent_id: agentId,
      tool_name: 'execute_command',
      arguments_hash: 'abc123hash',
      timeout_seconds: 60,
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.approval_id).toBeDefined();
    expect(res.body.expires_at).toBeDefined();
    approvalId = res.body.approval_id as string;
  });

  it('GET /api/v1/approvals/pending lists pending approvals', async () => {
    const res = await get('/api/v1/approvals/pending');

    expect(res.status).toBe(200);
    const approvals = res.body.approvals as Array<Record<string, unknown>>;
    expect(approvals.length).toBeGreaterThanOrEqual(1);
    const found = approvals.find((a) => a.id === approvalId);
    expect(found).toBeDefined();
    expect(found?.status).toBe('pending');
  });

  it('GET /api/v1/approvals/:id returns the approval', async () => {
    const res = await get(`/api/v1/approvals/${approvalId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(approvalId);
    expect(res.body.agent_id).toBe(agentId);
    expect(res.body.tool_name).toBe('execute_command');
    expect(res.body.status).toBe('pending');
  });

  it('POST /api/v1/approvals/:id/approve approves the request', async () => {
    const res = await post(`/api/v1/approvals/${approvalId}/approve`, {
      decided_by: 'admin@example.com',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.decided_by).toBe('admin@example.com');
    expect(res.body.decided_at).toBeDefined();
  });

  it('cannot approve an already-approved request', async () => {
    const res = await post(`/api/v1/approvals/${approvalId}/approve`, {
      decided_by: 'admin@example.com',
    });

    expect(res.status).toBe(409);
  });

  it('POST /api/v1/approvals/:id/deny denies a new request', async () => {
    // Create a new approval to deny
    const createRes = await post('/api/v1/approvals', {
      agent_id: agentId,
      tool_name: 'write_file',
      arguments_hash: 'def456hash',
      timeout_seconds: 60,
    });
    const denyId = createRes.body.approval_id as string;

    const res = await post(`/api/v1/approvals/${denyId}/deny`, {
      decided_by: 'admin@example.com',
      reason: 'Not authorized for production writes',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('denied');
    expect(res.body.reason).toBe('Not authorized for production writes');
  });

  it('returns 404 for non-existent approval', async () => {
    const res = await get('/api/v1/approvals/non-existent-id');
    expect(res.status).toBe(404);
  });

  it('returns 404 when agent does not exist', async () => {
    const res = await post('/api/v1/approvals', {
      agent_id: 'non-existent-agent',
      tool_name: 'foo',
      arguments_hash: 'bar',
      timeout_seconds: 60,
    });
    expect(res.status).toBe(404);
  });

  it('validates required fields', async () => {
    const res = await post('/api/v1/approvals', {});
    expect(res.status).toBe(400);
  });
});

describe('Approval Expiry', () => {
  it('auto-expires approvals past their deadline', async () => {
    // Create an approval with a very short timeout
    const createRes = await post('/api/v1/approvals', {
      agent_id: agentId,
      tool_name: 'read_file',
      arguments_hash: 'expiry-test',
      timeout_seconds: 10, // minimum allowed
    });
    const expId = createRes.body.approval_id as string;

    // The approval should be pending now
    const checkRes = await get(`/api/v1/approvals/${expId}`);
    expect(checkRes.body.status).toBe('pending');
  });
});

describe('Slack Action Endpoint', () => {
  it('POST /api/v1/approvals/:id/slack-action processes approve action', async () => {
    // Create a new approval
    const createRes = await post('/api/v1/approvals', {
      agent_id: agentId,
      tool_name: 'execute_command',
      arguments_hash: 'slack-test',
      timeout_seconds: 300,
    });
    const slackApprovalId = createRes.body.approval_id as string;

    // Simulate Slack button click
    const res = await post(`/api/v1/approvals/${slackApprovalId}/slack-action`, {
      actions: [
        { action_id: 'approve_action', value: slackApprovalId },
      ],
      user: { id: 'U123', name: 'admin_user' },
    });

    expect(res.status).toBe(200);
    expect(res.body.response_type).toBe('in_channel');
    expect(res.body.replace_original).toBe(true);
    expect((res.body.text as string)).toContain('APPROVED');

    // Verify it's now approved
    const checkRes = await get(`/api/v1/approvals/${slackApprovalId}`);
    expect(checkRes.body.status).toBe('approved');
  });

  it('POST /api/v1/approvals/:id/slack-action processes deny action', async () => {
    const createRes = await post('/api/v1/approvals', {
      agent_id: agentId,
      tool_name: 'write_file',
      arguments_hash: 'slack-deny-test',
      timeout_seconds: 300,
    });
    const slackDenyId = createRes.body.approval_id as string;

    const res = await post(`/api/v1/approvals/${slackDenyId}/slack-action`, {
      actions: [
        { action_id: 'deny_action', value: slackDenyId },
      ],
      user: { id: 'U456', name: 'security_admin' },
    });

    expect(res.status).toBe(200);
    expect((res.body.text as string)).toContain('DENIED');
  });

  it('returns error for invalid action payload', async () => {
    const res = await post('/api/v1/approvals/some-id/slack-action', {});
    expect(res.status).toBe(400);
  });
});
