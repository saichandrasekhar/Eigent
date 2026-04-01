import * as crypto from 'node:crypto';
import { getDb, type AuditRow } from './db.js';

/**
 * Compute a SHA-256 hash for an audit row, chained to the previous hash.
 * The hash covers: prevHash + a canonical JSON representation of the event.
 */
export function computeRowHash(event: Pick<AuditRow, 'id' | 'timestamp' | 'agent_id' | 'human_email' | 'action' | 'tool_name' | 'delegation_chain' | 'details'>, prevHash: string): string {
  const canonical = JSON.stringify({
    id: event.id,
    timestamp: event.timestamp,
    agent_id: event.agent_id,
    human_email: event.human_email,
    action: event.action,
    tool_name: event.tool_name,
    delegation_chain: event.delegation_chain,
    details: event.details,
  });

  return crypto
    .createHash('sha256')
    .update(prevHash + canonical)
    .digest('hex');
}

/**
 * Walk the full audit chain and verify every hash link.
 *
 * Returns `{ valid: true }` when the chain is intact, or
 * `{ valid: false, broken_at: <event_id> }` when the first
 * broken link is found.
 */
export function verifyAuditChain(): { valid: boolean; broken_at?: string; total_events: number } {
  const db = getDb();

  const rows = db.prepare(
    'SELECT id, timestamp, agent_id, human_email, action, tool_name, delegation_chain, details, prev_hash, row_hash FROM audit_log ORDER BY timestamp ASC, id ASC',
  ).all() as (AuditRow & { prev_hash: string | null; row_hash: string | null })[];

  if (rows.length === 0) {
    return { valid: true, total_events: 0 };
  }

  for (const row of rows) {
    // Rows inserted before the hash-chain migration have null hashes -- skip gracefully.
    if (row.row_hash === null) {
      continue;
    }

    const recomputed = computeRowHash(
      {
        id: row.id,
        timestamp: row.timestamp,
        agent_id: row.agent_id,
        human_email: row.human_email,
        action: row.action,
        tool_name: row.tool_name,
        delegation_chain: row.delegation_chain,
        details: row.details,
      },
      row.prev_hash ?? 'genesis',
    );

    if (recomputed !== row.row_hash) {
      return { valid: false, broken_at: row.id, total_events: rows.length };
    }
  }

  return { valid: true, total_events: rows.length };
}

/**
 * Get the hash of the most recent audit log entry (needed when inserting
 * the next row to maintain the chain).
 */
export function getLastAuditHash(): string {
  const db = getDb();
  const row = db.prepare(
    'SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY timestamp DESC, id DESC LIMIT 1',
  ).get() as { row_hash: string } | undefined;

  return row?.row_hash ?? 'genesis';
}
