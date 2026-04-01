import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '../src/logger.js';

describe('Logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('emits structured JSON with required fields', () => {
    const logger = new Logger('auth', 'info');
    logger.info('Token verified', { agent_id: 'agt-001', latency_ms: 3 });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());

    expect(parsed.timestamp).toBeDefined();
    expect(parsed.level).toBe('info');
    expect(parsed.component).toBe('auth');
    expect(parsed.message).toBe('Token verified');
    expect(parsed.agent_id).toBe('agt-001');
    expect(parsed.latency_ms).toBe(3);
  });

  it('writes info and debug to stdout', () => {
    const logger = new Logger('test', 'debug');
    logger.debug('debug message');
    logger.info('info message');

    expect(stdoutSpy).toHaveBeenCalledTimes(2);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes warn and error to stderr', () => {
    const logger = new Logger('test', 'debug');
    logger.warn('warn message');
    logger.error('error message');

    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('respects log level filtering', () => {
    const logger = new Logger('test', 'warn');

    logger.debug('should not appear');
    logger.info('should not appear');
    logger.warn('should appear');
    logger.error('should appear');

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('defaults to info level', () => {
    const logger = new Logger('test');

    logger.debug('should not appear');
    logger.info('should appear');

    // debug should be filtered since default is info
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain('should appear');
  });

  it('child inherits parent log level', () => {
    const parent = new Logger('parent', 'error');
    const child = parent.child('child');

    child.info('should not appear');
    child.error('should appear');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.component).toBe('child');
    expect(parsed.level).toBe('error');
  });

  it('includes context fields in output', () => {
    const logger = new Logger('enforcer', 'info');
    logger.info('Decision made', {
      agent_id: 'agt-002',
      human_email: 'alice@acme.com',
      tool: 'delete_file',
      latency_ms: 5,
    });

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());

    expect(parsed.agent_id).toBe('agt-002');
    expect(parsed.human_email).toBe('alice@acme.com');
    expect(parsed.tool).toBe('delete_file');
    expect(parsed.latency_ms).toBe(5);
  });

  it('produces valid JSON on every line', () => {
    const logger = new Logger('test', 'debug');
    logger.debug('first');
    logger.info('second', { key: 'value' });
    logger.warn('third');
    logger.error('fourth', { code: 500 });

    const allCalls = [...stdoutSpy.mock.calls, ...stderrSpy.mock.calls];
    expect(allCalls).toHaveLength(4);

    for (const call of allCalls) {
      const line = (call[0] as string).trim();
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('timestamp is valid ISO 8601', () => {
    const logger = new Logger('test', 'info');
    logger.info('check timestamp');

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    const date = new Date(parsed.timestamp);
    expect(date.toISOString()).toBe(parsed.timestamp);
  });
});
