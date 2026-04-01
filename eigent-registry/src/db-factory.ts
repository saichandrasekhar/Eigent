/**
 * Database factory for switching between SQLite and PostgreSQL adapters.
 *
 * Usage:
 *   - `sqlite:path` or `sqlite::memory:` for SQLite
 *   - `postgres://...` or `postgresql://...` for PostgreSQL
 *   - Default: `sqlite:///tmp/eigent.db` (dev mode)
 *
 * The factory creates a DatabaseAdapter instance based on the URL scheme.
 * The existing `db.ts` (synchronous SQLite) remains the primary import
 * used throughout the codebase. This factory provides an async adapter
 * interface for production PostgreSQL deployments.
 */

import type {
  AgentRow,
  AuditRow,
  KeyRow,
  OIDCProviderRow,
  SessionRow,
} from './db.js';

// Re-export types for convenience
export type { AgentRow, AuditRow, KeyRow, OIDCProviderRow, SessionRow };

// ─── Database Adapter Interface ───

export interface DatabaseAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<boolean>;

  // Agent operations
  insertAgent(agent: AgentRow): Promise<void>;
  getAgentById(id: string): Promise<AgentRow | undefined>;
  getAgentByTokenJti(jti: string): Promise<AgentRow | undefined>;
  listAgents(filters: {
    org_id?: string;
    status?: string;
    human_email?: string;
    parent_id?: string;
  }): Promise<AgentRow[]>;
  findDescendants(agentId: string): Promise<string[]>;
  revokeAgentCascade(agentId: string): Promise<string[]>;
  getDelegationChain(agentId: string): Promise<AgentRow[]>;

  // Audit log operations
  insertAuditLog(entry: AuditRow): Promise<void>;
  queryAuditLog(filters: {
    org_id?: string;
    agent_id?: string;
    human_email?: string;
    action?: string;
    tool_name?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: AuditRow[]; total: number }>;

  // Key operations
  insertKey(key: KeyRow): Promise<void>;
  getLatestKey(): Promise<KeyRow | undefined>;
  getAllPublicKeys(): Promise<{ id: string; public_key: string }[]>;

  // OIDC provider operations
  insertOIDCProvider(provider: OIDCProviderRow): Promise<void>;
  listOIDCProviders(enabledOnly?: boolean): Promise<OIDCProviderRow[]>;

  // Session operations
  insertSession(session: SessionRow): Promise<void>;
  getActiveSession(sessionId: string): Promise<SessionRow | undefined>;
  deleteSession(sessionId: string): Promise<void>;
}

// ─── Factory ───

let adapterInstance: DatabaseAdapter | null = null;

/**
 * Create and initialize a database adapter based on the connection URL.
 * - `sqlite:path` or `sqlite::memory:` for SQLite
 * - `postgres://...` or `postgresql://...` for PostgreSQL
 */
export async function createDatabase(
  url?: string,
): Promise<DatabaseAdapter> {
  const resolvedUrl =
    url ?? process.env.DATABASE_URL ?? 'sqlite:///tmp/eigent.db';

  if (resolvedUrl.startsWith('sqlite:')) {
    // For SQLite, delegate to the existing initDb from db.ts
    const dbPath = resolvedUrl.slice('sqlite:'.length);
    const { initDb } = await import('./db.js');
    initDb(dbPath === ':memory:' ? ':memory:' : dbPath);
    // The adapter wraps synchronous db.ts calls
    const { SQLiteAdapter } = await import('./db-sqlite.js');
    adapterInstance = new SQLiteAdapter();
    return adapterInstance;
  }

  if (
    resolvedUrl.startsWith('postgres://') ||
    resolvedUrl.startsWith('postgresql://')
  ) {
    const { PostgresAdapter } = await import('./db-postgres.js');
    adapterInstance = new PostgresAdapter(resolvedUrl);
    await adapterInstance.initialize();
    return adapterInstance;
  }

  throw new Error(
    `Unsupported database URL scheme: ${resolvedUrl}. Use sqlite: or postgres://`,
  );
}

/**
 * Get the current database adapter instance.
 */
export function getAdapter(): DatabaseAdapter | null {
  return adapterInstance;
}
