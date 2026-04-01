import { describe, it, expect } from 'vitest';
import {
  buildSlackBlockKit,
  buildWebhookPayload,
  parseSlackAction,
  type ApprovalNotification,
} from '../src/approval-notifier.js';

const SAMPLE_NOTIFICATION: ApprovalNotification = {
  approval_id: 'approval-001',
  agent_id: 'agent-001',
  agent_name: 'code-review-bot',
  tool_name: 'execute_command',
  arguments_hash: 'abc123def456',
  human_email: 'dev@example.com',
  delegation_chain: ['root-agent', 'code-review-bot'],
  registry_url: 'http://localhost:3456',
  expires_at: '2026-04-01T00:00:00.000Z',
};

describe('buildSlackBlockKit', () => {
  it('generates valid Slack Block Kit message', () => {
    const message = buildSlackBlockKit(SAMPLE_NOTIFICATION);

    expect(message.text).toContain('code-review-bot');
    expect(message.text).toContain('execute_command');
    expect(message.blocks).toBeDefined();

    const blocks = message.blocks as Array<Record<string, unknown>>;
    expect(blocks.length).toBeGreaterThan(0);

    // Check header block
    const header = blocks.find((b) => b.type === 'header');
    expect(header).toBeDefined();

    // Check action buttons
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions).toBeDefined();
    const elements = (actions as Record<string, unknown>).elements as Array<Record<string, unknown>>;
    expect(elements.length).toBe(2);

    const approveBtn = elements.find((e) => (e as Record<string, unknown>).action_id === 'approve_action');
    expect(approveBtn).toBeDefined();
    expect((approveBtn as Record<string, unknown>).value).toBe('approval-001');

    const denyBtn = elements.find((e) => (e as Record<string, unknown>).action_id === 'deny_action');
    expect(denyBtn).toBeDefined();
  });

  it('includes delegation chain in the message', () => {
    const message = buildSlackBlockKit(SAMPLE_NOTIFICATION);
    const blocks = message.blocks as Array<Record<string, unknown>>;
    const chainBlock = blocks.find((b) => {
      if (b.type !== 'section') return false;
      const text = b.text as Record<string, string> | undefined;
      return text?.text?.includes('Delegation Chain');
    });
    expect(chainBlock).toBeDefined();
  });
});

describe('buildWebhookPayload', () => {
  it('generates valid webhook payload', () => {
    const payload = buildWebhookPayload(SAMPLE_NOTIFICATION);

    expect(payload.event).toBe('approval_requested');
    expect(payload.approval_id).toBe('approval-001');
    expect(payload.agent_name).toBe('code-review-bot');
    expect(payload.tool_name).toBe('execute_command');
    expect(payload.human_email).toBe('dev@example.com');
    expect(payload.approve_url).toContain('/api/v1/approvals/approval-001/approve');
    expect(payload.deny_url).toContain('/api/v1/approvals/approval-001/deny');
  });
});

describe('parseSlackAction', () => {
  it('parses approve action', () => {
    const body = {
      actions: [
        { action_id: 'approve_action', value: 'approval-001' },
      ],
      user: { id: 'U123', name: 'admin' },
    };

    const result = parseSlackAction(body);
    expect(result).not.toBeNull();
    expect(result?.approval_id).toBe('approval-001');
    expect(result?.action).toBe('approve');
    expect(result?.user_id).toBe('U123');
    expect(result?.user_name).toBe('admin');
  });

  it('parses deny action', () => {
    const body = {
      actions: [
        { action_id: 'deny_action', value: 'approval-002' },
      ],
      user: { id: 'U456', name: 'security' },
    };

    const result = parseSlackAction(body);
    expect(result).not.toBeNull();
    expect(result?.approval_id).toBe('approval-002');
    expect(result?.action).toBe('deny');
  });

  it('parses Slack interactive payload with payload field', () => {
    const body = {
      payload: JSON.stringify({
        actions: [
          { action_id: 'approve_action', value: 'approval-003' },
        ],
        user: { id: 'U789', name: 'ops' },
      }),
    };

    const result = parseSlackAction(body);
    expect(result).not.toBeNull();
    expect(result?.approval_id).toBe('approval-003');
    expect(result?.action).toBe('approve');
  });

  it('returns null for invalid action', () => {
    const body = {
      actions: [
        { action_id: 'unknown_action', value: 'approval-004' },
      ],
      user: { id: 'U000', name: 'unknown' },
    };

    const result = parseSlackAction(body);
    expect(result).toBeNull();
  });

  it('returns null for empty actions', () => {
    const body = { actions: [] };
    const result = parseSlackAction(body);
    expect(result).toBeNull();
  });

  it('returns null for missing actions', () => {
    const result = parseSlackAction({});
    expect(result).toBeNull();
  });
});
