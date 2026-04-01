/**
 * Decision log for the Eigent sidecar.
 *
 * Logs every enforcement decision to a local JSONL file for debugging
 * without requiring an OpenTelemetry collector. Supports log rotation
 * with configurable max size and file retention.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────

export interface DecisionLogEntry {
  timestamp: string;
  agent_id: string;
  tool: string;
  decision: 'allow' | 'deny' | 'log_only' | 'require_approval';
  reason: string;
  latency_ms: number;
  policy_rule: string | null;
  token_verified: boolean;
}

export interface DecisionLogOptions {
  /** Path to the JSONL log file. */
  filePath: string;
  /** Maximum file size in bytes before rotation (default: 100MB). */
  maxSizeBytes?: number;
  /** Number of rotated files to keep (default: 3). */
  maxFiles?: number;
}

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_FILES = 3;

// ── Decision logger ────────────────────────────────────────────────────

export class DecisionLog {
  private readonly filePath: string;
  private readonly maxSizeBytes: number;
  private readonly maxFiles: number;
  private fd: number | null = null;
  private currentSize: number = 0;

  constructor(options: DecisionLogOptions) {
    this.filePath = path.resolve(options.filePath);
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.open();
  }

  /**
   * Write a decision entry to the log file.
   */
  write(entry: DecisionLogEntry): void {
    if (this.fd === null) {
      return;
    }

    const line = JSON.stringify(entry) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf-8');

    try {
      fs.writeSync(this.fd, line, undefined, 'utf-8');
      this.currentSize += lineBytes;

      if (this.currentSize >= this.maxSizeBytes) {
        this.rotate();
      }
    } catch {
      // Silently ignore write errors to avoid breaking the sidecar
    }
  }

  /**
   * Convenience method: log a decision from enforcement parameters.
   */
  logDecision(params: {
    agentId: string;
    tool: string;
    decision: DecisionLogEntry['decision'];
    reason: string;
    latencyMs: number;
    policyRule: string | null;
    tokenVerified: boolean;
  }): void {
    this.write({
      timestamp: new Date().toISOString(),
      agent_id: params.agentId,
      tool: params.tool,
      decision: params.decision,
      reason: params.reason,
      latency_ms: params.latencyMs,
      policy_rule: params.policyRule,
      token_verified: params.tokenVerified,
    });
  }

  /**
   * Close the log file.
   */
  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────

  private open(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.fd = fs.openSync(this.filePath, 'a');

      // Get current file size
      try {
        const stat = fs.statSync(this.filePath);
        this.currentSize = stat.size;
      } catch {
        this.currentSize = 0;
      }
    } catch {
      this.fd = null;
    }
  }

  private rotate(): void {
    this.close();

    try {
      // Shift existing rotated files: .3 -> delete, .2 -> .3, .1 -> .2
      for (let i = this.maxFiles; i >= 1; i--) {
        const from = i === 1
          ? this.filePath
          : `${this.filePath}.${i - 1}`;
        const to = `${this.filePath}.${i}`;

        if (i === this.maxFiles && fs.existsSync(to)) {
          fs.unlinkSync(to);
        }

        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
        }
      }
    } catch {
      // If rotation fails, just truncate
    }

    this.open();
  }
}
