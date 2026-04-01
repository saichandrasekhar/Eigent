import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.join(__dirname, '..', 'data', 'registry.db');

  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createSchema(db);
  return db;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      human_sub TEXT NOT NULL,
      human_email TEXT NOT NULL,
      human_iss TEXT NOT NULL,
      scope TEXT NOT NULL,
      parent_id TEXT,
      delegation_depth INTEGER DEFAULT 0,
      max_delegation_depth INTEGER DEFAULT 3,
      can_delegate TEXT,
      token_jti TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      metadata TEXT,
      FOREIGN KEY (parent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      human_email TEXT NOT NULL,
      action TEXT NOT NULL,
      tool_name TEXT,
      delegation_chain TEXT,
      details TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_human_email ON agents(human_email);
    CREATE INDEX IF NOT EXISTS idx_agents_parent_id ON agents(parent_id);
    CREATE INDEX IF NOT EXISTS idx_audit_agent_id ON audit_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_audit_human_email ON audit_log(human_email);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  `);
}

// ─── Agent Operations ───

export interface AgentRow {
  id: string;
  name: string;
  human_sub: string;
  human_email: string;
  human_iss: string;
  scope: string;
  parent_id: string | null;
  delegation_depth: number;
  max_delegation_depth: number;
  can_delegate: string | null;
  token_jti: string;
  status: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  metadata: string | null;
}

export function insertAgent(agent: AgentRow): void {
  const stmt = getDb().prepare(`
    INSERT INTO agents (id, name, human_sub, human_email, human_iss, scope, parent_id,
      delegation_depth, max_delegation_depth, can_delegate, token_jti, status,
      created_at, expires_at, revoked_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    agent.id, agent.name, agent.human_sub, agent.human_email, agent.human_iss,
    agent.scope, agent.parent_id, agent.delegation_depth, agent.max_delegation_depth,
    agent.can_delegate, agent.token_jti, agent.status, agent.created_at,
    agent.expires_at, agent.revoked_at, agent.metadata
  );
}

export function getAgentById(id: string): AgentRow | undefined {
  return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
}

export function getAgentByTokenJti(jti: string): AgentRow | undefined {
  return getDb().prepare('SELECT * FROM agents WHERE token_jti = ?').get(jti) as AgentRow | undefined;
}

export function listAgents(filters: {
  status?: string;
  human_email?: string;
  parent_id?: string;
}): AgentRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.human_email) {
    conditions.push('human_email = ?');
    params.push(filters.human_email);
  }
  if (filters.parent_id) {
    conditions.push('parent_id = ?');
    params.push(filters.parent_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM agents ${where} ORDER BY created_at DESC`).all(...params) as AgentRow[];
}

/**
 * Recursively find all descendant agent IDs using a CTE.
 */
export function findDescendants(agentId: string): string[] {
  const rows = getDb().prepare(`
    WITH RECURSIVE descendants AS (
      SELECT id FROM agents WHERE parent_id = ?
      UNION ALL
      SELECT a.id FROM agents a INNER JOIN descendants d ON a.parent_id = d.id
    )
    SELECT id FROM descendants
  `).all(agentId) as { id: string }[];

  return rows.map((r) => r.id);
}

/**
 * Revoke an agent and all descendants. Returns list of all revoked IDs.
 */
export function revokeAgentCascade(agentId: string): string[] {
  const now = new Date().toISOString();
  const descendants = findDescendants(agentId);
  const allIds = [agentId, ...descendants];

  const stmt = getDb().prepare('UPDATE agents SET status = ?, revoked_at = ? WHERE id = ?');
  const txn = getDb().transaction(() => {
    for (const id of allIds) {
      stmt.run('revoked', now, id);
    }
  });
  txn();

  return allIds;
}

/**
 * Build the delegation chain from an agent back to the root.
 */
export function getDelegationChain(agentId: string): AgentRow[] {
  const chain: AgentRow[] = [];
  let current = getAgentById(agentId);

  while (current) {
    chain.unshift(current);
    if (current.parent_id) {
      current = getAgentById(current.parent_id);
    } else {
      break;
    }
  }

  return chain;
}

// ─── Audit Log Operations ───

export interface AuditRow {
  id: string;
  timestamp: string;
  agent_id: string;
  human_email: string;
  action: string;
  tool_name: string | null;
  delegation_chain: string | null;
  details: string | null;
}

export function insertAuditLog(entry: AuditRow): void {
  const stmt = getDb().prepare(`
    INSERT INTO audit_log (id, timestamp, agent_id, human_email, action, tool_name, delegation_chain, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(entry.id, entry.timestamp, entry.agent_id, entry.human_email,
    entry.action, entry.tool_name, entry.delegation_chain, entry.details);
}

export function queryAuditLog(filters: {
  agent_id?: string;
  human_email?: string;
  action?: string;
  tool_name?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}): { entries: AuditRow[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.agent_id) {
    conditions.push('agent_id = ?');
    params.push(filters.agent_id);
  }
  if (filters.human_email) {
    conditions.push('human_email = ?');
    params.push(filters.human_email);
  }
  if (filters.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }
  if (filters.tool_name) {
    conditions.push('tool_name = ?');
    params.push(filters.tool_name);
  }
  if (filters.from_date) {
    conditions.push('timestamp >= ?');
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push('timestamp <= ?');
    params.push(filters.to_date);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const total = (getDb().prepare(`SELECT COUNT(*) as count FROM audit_log ${where}`).get(...params) as { count: number }).count;
  const entries = getDb().prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as AuditRow[];

  return { entries, total };
}

// ─── Key Operations ───

export interface KeyRow {
  id: string;
  public_key: string;
  private_key: string;
  created_at: string;
}

export function insertKey(key: KeyRow): void {
  getDb().prepare('INSERT INTO keys (id, public_key, private_key, created_at) VALUES (?, ?, ?, ?)').run(
    key.id, key.public_key, key.private_key, key.created_at
  );
}

export function getLatestKey(): KeyRow | undefined {
  return getDb().prepare('SELECT * FROM keys ORDER BY created_at DESC LIMIT 1').get() as KeyRow | undefined;
}

export function getAllPublicKeys(): { id: string; public_key: string }[] {
  return getDb().prepare('SELECT id, public_key FROM keys ORDER BY created_at DESC').all() as { id: string; public_key: string }[];
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
