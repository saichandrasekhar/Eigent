import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DecisionLog, type DecisionLogEntry } from '../src/decision-log.js';

describe('DecisionLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigent-decision-log-test-'));
    logPath = path.join(tmpDir, 'decisions.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a log file and writes entries', () => {
    const log = new DecisionLog({ filePath: logPath });

    const entry: DecisionLogEntry = {
      timestamp: '2026-03-31T14:23:45Z',
      agent_id: 'test-runner',
      tool: 'delete_file',
      decision: 'deny',
      reason: "Tool 'delete_file' not in scope [run_tests]",
      latency_ms: 2,
      policy_rule: null,
      token_verified: true,
    };

    log.write(entry);
    log.close();

    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.agent_id).toBe('test-runner');
    expect(parsed.tool).toBe('delete_file');
    expect(parsed.decision).toBe('deny');
    expect(parsed.token_verified).toBe(true);
  });

  it('writes multiple entries as JSONL', () => {
    const log = new DecisionLog({ filePath: logPath });

    log.logDecision({
      agentId: 'agent-1',
      tool: 'read_file',
      decision: 'allow',
      reason: 'in scope',
      latencyMs: 1,
      policyRule: null,
      tokenVerified: true,
    });

    log.logDecision({
      agentId: 'agent-2',
      tool: 'write_file',
      decision: 'deny',
      reason: 'not in scope',
      latencyMs: 3,
      policyRule: 'block-writes',
      tokenVerified: true,
    });

    log.close();

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.agent_id).toBe('agent-1');
    expect(first.decision).toBe('allow');

    const second = JSON.parse(lines[1]);
    expect(second.agent_id).toBe('agent-2');
    expect(second.decision).toBe('deny');
    expect(second.policy_rule).toBe('block-writes');
  });

  it('rotates when max size is exceeded', () => {
    // Use a very small max size to trigger rotation
    const log = new DecisionLog({
      filePath: logPath,
      maxSizeBytes: 200,
      maxFiles: 2,
    });

    // Write enough entries to trigger rotation
    for (let i = 0; i < 10; i++) {
      log.logDecision({
        agentId: `agent-${i}`,
        tool: `tool-${i}`,
        decision: 'allow',
        reason: 'test',
        latencyMs: 1,
        policyRule: null,
        tokenVerified: true,
      });
    }

    log.close();

    // The main file should exist
    expect(fs.existsSync(logPath)).toBe(true);

    // At least one rotated file should exist
    const rotatedFile1 = `${logPath}.1`;
    expect(fs.existsSync(rotatedFile1)).toBe(true);
  });

  it('handles the logDecision convenience method', () => {
    const log = new DecisionLog({ filePath: logPath });

    log.logDecision({
      agentId: 'my-agent',
      tool: 'some_tool',
      decision: 'log_only',
      reason: 'monitoring mode',
      latencyMs: 5,
      policyRule: 'audit-all',
      tokenVerified: false,
    });

    log.close();

    const content = fs.readFileSync(logPath, 'utf-8').trim();
    const parsed = JSON.parse(content);

    expect(parsed.agent_id).toBe('my-agent');
    expect(parsed.tool).toBe('some_tool');
    expect(parsed.decision).toBe('log_only');
    expect(parsed.policy_rule).toBe('audit-all');
    expect(parsed.token_verified).toBe(false);
    expect(parsed.latency_ms).toBe(5);
    expect(parsed.timestamp).toBeDefined();
  });

  it('creates parent directories if needed', () => {
    const deepPath = path.join(tmpDir, 'sub', 'dir', 'decisions.jsonl');
    const log = new DecisionLog({ filePath: deepPath });

    log.logDecision({
      agentId: 'agent',
      tool: 'tool',
      decision: 'allow',
      reason: 'ok',
      latencyMs: 1,
      policyRule: null,
      tokenVerified: true,
    });

    log.close();

    expect(fs.existsSync(deepPath)).toBe(true);
  });
});
