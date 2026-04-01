import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the api module
vi.mock('../src/api.js', () => ({
  explainAccess: vi.fn(),
  getTraceEvent: vi.fn(),
  getChain: vi.fn(),
  queryAudit: vi.fn(),
  healthCheck: vi.fn(),
}));

// Mock the config module
vi.mock('../src/config.js', () => ({
  requireProjectConfig: vi.fn(() => ({ registryUrl: 'http://localhost:3456' })),
  requireToken: vi.fn(() => 'mock.jwt.token'),
  loadProjectConfig: vi.fn(() => ({ registryUrl: 'http://localhost:3456' })),
  loadSession: vi.fn(() => null),
  listTokenFiles: vi.fn(() => []),
}));

import type { ExplainResult, TraceEvent, ChainNode } from '../src/api.js';

describe('explain command types', () => {
  it('ExplainResult has all required fields for display', () => {
    const result: ExplainResult = {
      allowed: false,
      agent_id: 'agt-001',
      agent_name: 'test-runner',
      tool: 'delete_file',
      scope: ['run_tests'],
      human_email: 'alice@acme.com',
      human_iss: 'https://accounts.google.com',
      delegation_depth: 1,
      max_delegation_depth: 3,
      reason: "Tool 'delete_file' is not in agent scope [run_tests]",
      chain: [
        { type: 'human', name: 'alice@acme.com', email: 'alice@acme.com' },
        { type: 'agent', name: 'code-reviewer', scope: ['read_file', 'write_file', 'run_tests'], delegation_depth: 0, agent_id: 'agt-000' },
        { type: 'agent', name: 'test-runner', scope: ['run_tests'], delegation_depth: 1, agent_id: 'agt-001' },
      ],
      policy_evaluations: [
        { rule_name: 'block-shell-execution', matched: false, action: 'deny', reason: "tool doesn't match" },
        { rule_name: 'business-hours-only', matched: false, action: 'deny', reason: 'within hours' },
      ],
      default_action: 'allow',
    };

    expect(result.allowed).toBe(false);
    expect(result.agent_name).toBe('test-runner');
    expect(result.tool).toBe('delete_file');
    expect(result.scope).toEqual(['run_tests']);
    expect(result.chain).toHaveLength(3);
    expect(result.chain[0].type).toBe('human');
    expect(result.chain[1].type).toBe('agent');
    expect(result.policy_evaluations).toHaveLength(2);
    expect(result.reason).toContain('not in agent scope');
  });

  it('ExplainResult for an allowed tool', () => {
    const result: ExplainResult = {
      allowed: true,
      agent_id: 'agt-001',
      agent_name: 'test-runner',
      tool: 'run_tests',
      scope: ['run_tests'],
      human_email: 'alice@acme.com',
      human_iss: 'https://accounts.google.com',
      delegation_depth: 1,
      max_delegation_depth: 3,
      reason: "Tool 'run_tests' is in agent scope [run_tests]",
      chain: [],
      policy_evaluations: [],
      default_action: 'allow',
    };

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('is in agent scope');
  });
});

describe('trace command types', () => {
  it('TraceEvent has all required fields for display', () => {
    const event: TraceEvent = {
      id: 'evt-abc123',
      timestamp: '2026-03-31T14:23:45Z',
      action: 'tool_call_blocked',
      agent_id: 'agt-002',
      agent_name: 'test-runner',
      human_email: 'alice@acme.com',
      tool_name: 'delete_file',
      details: { reason: 'not_in_scope', agent_scope: ['run_tests'] },
      delegation_chain: '["agt-001","agt-002"]',
      chain: [
        { type: 'human', name: 'alice@acme.com', email: 'alice@acme.com' },
        { type: 'agent', name: 'code-reviewer', scope: ['read_file', 'write_file', 'run_tests'], delegation_depth: 0, agent_id: 'agt-001' },
        { type: 'agent', name: 'test-runner', scope: ['run_tests'], delegation_depth: 1, agent_id: 'agt-002' },
      ],
      decision: 'deny',
      reason: 'not_in_scope',
      policy_rule: null,
      audit_hash: 'sha256:abc123def456789012345678',
      hash_verified: true,
    };

    expect(event.action).toBe('tool_call_blocked');
    expect(event.decision).toBe('deny');
    expect(event.chain).toHaveLength(3);
    expect(event.hash_verified).toBe(true);
    expect(event.tool_name).toBe('delete_file');
  });

  it('TraceEvent for an allowed call', () => {
    const event: TraceEvent = {
      id: 'evt-def456',
      timestamp: '2026-03-31T14:24:00Z',
      action: 'tool_call_allowed',
      agent_id: 'agt-002',
      agent_name: 'test-runner',
      human_email: 'alice@acme.com',
      tool_name: 'run_tests',
      details: { reason: 'in_scope' },
      delegation_chain: null,
      chain: [],
      decision: 'allow',
      reason: 'in_scope',
      policy_rule: null,
      audit_hash: null,
      hash_verified: false,
    };

    expect(event.action).toBe('tool_call_allowed');
    expect(event.decision).toBe('allow');
  });
});

describe('explain result structure', () => {
  it('denied result includes fix suggestions data', () => {
    const result: ExplainResult = {
      allowed: false,
      agent_id: 'agt-001',
      agent_name: 'test-runner',
      tool: 'delete_file',
      scope: ['run_tests'],
      human_email: 'alice@acme.com',
      human_iss: 'https://accounts.google.com',
      delegation_depth: 1,
      max_delegation_depth: 3,
      reason: "Tool 'delete_file' is not in agent scope",
      chain: [],
      policy_evaluations: [],
      default_action: 'allow',
    };

    // Verify fix suggestion data is derivable
    const broadenedScope = [...result.scope, result.tool];
    expect(broadenedScope).toEqual(['run_tests', 'delete_file']);

    const delegateCmd = `eigent delegate <parent> ${result.agent_name} --scope ${broadenedScope.join(',')}`;
    expect(delegateCmd).toContain('test-runner');
    expect(delegateCmd).toContain('delete_file');

    const issueCmd = `eigent issue <new-agent> --scope ${result.tool}`;
    expect(issueCmd).toContain('delete_file');
  });
});
