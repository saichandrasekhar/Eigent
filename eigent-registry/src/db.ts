import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
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
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      settings TEXT
    );

    CREATE TABLE IF NOT EXISTS org_members (
      org_id TEXT NOT NULL,
      human_email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (org_id, human_email),
      FOREIGN KEY (org_id) REFERENCES organizations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_org_members_email ON org_members(human_email);
    CREATE INDEX IF NOT EXISTS idx_org_slug ON organizations(slug);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
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
      risk_level TEXT DEFAULT 'minimal',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_seen_at TEXT,
      deprovisioned_at TEXT,
      metadata TEXT,
      FOREIGN KEY (parent_id) REFERENCES agents(id),
      FOREIGN KEY (org_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      human_email TEXT NOT NULL,
      action TEXT NOT NULL,
      tool_name TEXT,
      delegation_chain TEXT,
      details TEXT,
      prev_hash TEXT,
      row_hash TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS keys (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_usage (
      agent_id TEXT NOT NULL,
      hour TEXT NOT NULL,
      tool_calls INTEGER DEFAULT 0,
      blocked_calls INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      PRIMARY KEY (agent_id, hour),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS webhook_configs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY (org_id) REFERENCES organizations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_agents_org_id ON agents(org_id);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_human_email ON agents(human_email);
    CREATE INDEX IF NOT EXISTS idx_agents_parent_id ON agents(parent_id);
    CREATE INDEX IF NOT EXISTS idx_agents_human_sub ON agents(human_sub);
    CREATE INDEX IF NOT EXISTS idx_agents_expires_at ON agents(expires_at);
    CREATE INDEX IF NOT EXISTS idx_agents_last_seen_at ON agents(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_agent_usage_hour ON agent_usage(hour);
    CREATE INDEX IF NOT EXISTS idx_audit_org_id ON audit_log(org_id);
    CREATE INDEX IF NOT EXISTS idx_audit_agent_id ON audit_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_audit_human_email ON audit_log(human_email);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_keys_org_id ON keys(org_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_configs_org_id ON webhook_configs(org_id);

    CREATE TABLE IF NOT EXISTS oidc_providers (
      id TEXT PRIMARY KEY,
      issuer_url TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_secret_encrypted TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'generic',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      human_sub TEXT NOT NULL,
      human_email TEXT NOT NULL,
      human_iss TEXT NOT NULL,
      id_token_hash TEXT NOT NULL,
      provider_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES oidc_providers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_human_sub ON sessions(human_sub);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_oidc_providers_issuer ON oidc_providers(issuer_url);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_agent_id ON approvals(agent_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals(expires_at);
  `);

  // Seed default organization
  database.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, slug, created_at, settings)
    VALUES ('default', 'Default Organization', 'default', ?, '{}')
  `).run(new Date().toISOString());
}

// ─── Agent Operations ───

export type RiskLevel = 'unacceptable' | 'high' | 'limited' | 'minimal';

export interface AgentRow {
  id: string;
  org_id: string;
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
  risk_level: RiskLevel;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  deprovisioned_at: string | null;
  metadata: string | null;
}

export function insertAgent(agent: AgentRow): void {
  const stmt = getDb().prepare(`
    INSERT INTO agents (id, org_id, name, human_sub, human_email, human_iss, scope, parent_id,
      delegation_depth, max_delegation_depth, can_delegate, token_jti, status, risk_level,
      created_at, expires_at, revoked_at, last_seen_at, deprovisioned_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    agent.id, agent.org_id, agent.name, agent.human_sub, agent.human_email, agent.human_iss,
    agent.scope, agent.parent_id, agent.delegation_depth, agent.max_delegation_depth,
    agent.can_delegate, agent.token_jti, agent.status, agent.risk_level ?? 'minimal',
    agent.created_at, agent.expires_at, agent.revoked_at, agent.last_seen_at ?? null,
    agent.deprovisioned_at ?? null, agent.metadata
  );
}

export function getAgentById(id: string): AgentRow | undefined {
  return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
}

export function getAgentByTokenJti(jti: string): AgentRow | undefined {
  return getDb().prepare('SELECT * FROM agents WHERE token_jti = ?').get(jti) as AgentRow | undefined;
}

export function listAgents(filters: {
  org_id?: string;
  status?: string;
  human_email?: string;
  parent_id?: string;
}): AgentRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.org_id) {
    conditions.push('org_id = ?');
    params.push(filters.org_id);
  }
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
  org_id: string;
  timestamp: string;
  agent_id: string;
  human_email: string;
  action: string;
  tool_name: string | null;
  delegation_chain: string | null;
  details: string | null;
  prev_hash?: string | null;
  row_hash?: string | null;
}

/**
 * Compute a SHA-256 hash for an audit row, chained to the previous hash.
 */
function computeAuditRowHash(event: AuditRow, prevHash: string): string {
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
  return crypto.createHash('sha256').update(prevHash + canonical).digest('hex');
}

/**
 * Get the hash of the most recent audit log entry for chaining.
 */
function getLastAuditHashInternal(): string {
  const row = getDb().prepare(
    'SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY timestamp DESC, id DESC LIMIT 1',
  ).get() as { row_hash: string } | undefined;
  return row?.row_hash ?? 'genesis';
}

export function insertAuditLog(entry: AuditRow): void {
  const prevHash = getLastAuditHashInternal();
  const rowHash = computeAuditRowHash(entry, prevHash);

  const stmt = getDb().prepare(`
    INSERT INTO audit_log (id, org_id, timestamp, agent_id, human_email, action, tool_name, delegation_chain, details, prev_hash, row_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(entry.id, entry.org_id, entry.timestamp, entry.agent_id, entry.human_email,
    entry.action, entry.tool_name, entry.delegation_chain, entry.details, prevHash, rowHash);
}

export function queryAuditLog(filters: {
  org_id?: string;
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

  if (filters.org_id) {
    conditions.push('org_id = ?');
    params.push(filters.org_id);
  }
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
  org_id: string;
  public_key: string;
  private_key: string;
  created_at: string;
}

export function insertKey(key: KeyRow): void {
  getDb().prepare('INSERT INTO keys (id, org_id, public_key, private_key, created_at) VALUES (?, ?, ?, ?, ?)').run(
    key.id, key.org_id, key.public_key, key.private_key, key.created_at
  );
}

export function getLatestKey(): KeyRow | undefined {
  return getDb().prepare('SELECT * FROM keys ORDER BY created_at DESC LIMIT 1').get() as KeyRow | undefined;
}

export function getAllPublicKeys(): { id: string; public_key: string }[] {
  return getDb().prepare('SELECT id, public_key FROM keys ORDER BY created_at DESC').all() as { id: string; public_key: string }[];
}

// ─── Agent Lookup by Human Sub ───

export function listAgentsByHumanSub(humanSub: string, status?: string): AgentRow[] {
  if (status) {
    return getDb()
      .prepare('SELECT * FROM agents WHERE human_sub = ? AND status = ? ORDER BY created_at DESC')
      .all(humanSub, status) as AgentRow[];
  }
  return getDb()
    .prepare('SELECT * FROM agents WHERE human_sub = ? ORDER BY created_at DESC')
    .all(humanSub) as AgentRow[];
}

// ─── OIDC Provider Operations ───

export interface OIDCProviderRow {
  id: string;
  issuer_url: string;
  client_id: string;
  client_secret_encrypted: string;
  type: string;
  enabled: number;
  created_at: string;
  updated_at: string | null;
}

export function insertOIDCProvider(provider: OIDCProviderRow): void {
  getDb().prepare(`
    INSERT INTO oidc_providers (id, issuer_url, client_id, client_secret_encrypted, type, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    provider.id, provider.issuer_url, provider.client_id, provider.client_secret_encrypted,
    provider.type, provider.enabled, provider.created_at, provider.updated_at,
  );
}

export function getOIDCProviderById(id: string): OIDCProviderRow | undefined {
  return getDb().prepare('SELECT * FROM oidc_providers WHERE id = ?').get(id) as OIDCProviderRow | undefined;
}

export function getOIDCProviderByIssuer(issuerUrl: string): OIDCProviderRow | undefined {
  return getDb().prepare('SELECT * FROM oidc_providers WHERE issuer_url = ? AND enabled = 1').get(issuerUrl) as OIDCProviderRow | undefined;
}

export function listOIDCProviders(enabledOnly: boolean = true): OIDCProviderRow[] {
  if (enabledOnly) {
    return getDb().prepare('SELECT * FROM oidc_providers WHERE enabled = 1 ORDER BY created_at DESC').all() as OIDCProviderRow[];
  }
  return getDb().prepare('SELECT * FROM oidc_providers ORDER BY created_at DESC').all() as OIDCProviderRow[];
}

// ─── Session Operations ───

export interface SessionRow {
  id: string;
  human_sub: string;
  human_email: string;
  human_iss: string;
  id_token_hash: string;
  provider_id: string | null;
  expires_at: string;
  created_at: string;
}

export function insertSession(session: SessionRow): void {
  getDb().prepare(`
    INSERT INTO sessions (id, human_sub, human_email, human_iss, id_token_hash, provider_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id, session.human_sub, session.human_email, session.human_iss,
    session.id_token_hash, session.provider_id, session.expires_at, session.created_at,
  );
}

export function getSessionById(id: string): SessionRow | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

export function getActiveSession(sessionId: string): SessionRow | undefined {
  return getDb().prepare(
    'SELECT * FROM sessions WHERE id = ? AND expires_at > ?',
  ).get(sessionId, new Date().toISOString()) as SessionRow | undefined;
}

export function deleteSession(sessionId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function deleteExpiredSessions(): number {
  const result = getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  return result.changes;
}

// ─── Organization Operations ───

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  settings: string | null;
}

export function insertOrganization(org: OrganizationRow): void {
  getDb().prepare(
    'INSERT INTO organizations (id, name, slug, created_at, settings) VALUES (?, ?, ?, ?, ?)',
  ).run(org.id, org.name, org.slug, org.created_at, org.settings);
}

export function getOrganizationById(id: string): OrganizationRow | undefined {
  return getDb().prepare('SELECT * FROM organizations WHERE id = ?').get(id) as OrganizationRow | undefined;
}

export function getOrganizationBySlug(slug: string): OrganizationRow | undefined {
  return getDb().prepare('SELECT * FROM organizations WHERE slug = ?').get(slug) as OrganizationRow | undefined;
}

export function listOrganizations(): OrganizationRow[] {
  return getDb().prepare('SELECT * FROM organizations ORDER BY created_at DESC').all() as OrganizationRow[];
}

export function updateOrganization(id: string, updates: { name?: string; settings?: string }): void {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    params.push(updates.name);
  }
  if (updates.settings !== undefined) {
    fields.push('settings = ?');
    params.push(updates.settings);
  }

  if (fields.length === 0) return;
  params.push(id);
  getDb().prepare(`UPDATE organizations SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

// ─── Org Member Operations ───

export interface OrgMemberRow {
  org_id: string;
  human_email: string;
  role: string;
  joined_at: string;
}

export function insertOrgMember(member: OrgMemberRow): void {
  getDb().prepare(
    'INSERT INTO org_members (org_id, human_email, role, joined_at) VALUES (?, ?, ?, ?)',
  ).run(member.org_id, member.human_email, member.role, member.joined_at);
}

export function listOrgMembers(orgId: string): OrgMemberRow[] {
  return getDb().prepare('SELECT * FROM org_members WHERE org_id = ? ORDER BY joined_at DESC').all(orgId) as OrgMemberRow[];
}

export function getOrgMember(orgId: string, email: string): OrgMemberRow | undefined {
  return getDb().prepare('SELECT * FROM org_members WHERE org_id = ? AND human_email = ?').get(orgId, email) as OrgMemberRow | undefined;
}

export function deleteOrgMember(orgId: string, email: string): boolean {
  const result = getDb().prepare('DELETE FROM org_members WHERE org_id = ? AND human_email = ?').run(orgId, email);
  return result.changes > 0;
}

export function getOrgsByEmail(email: string): OrgMemberRow[] {
  return getDb().prepare('SELECT * FROM org_members WHERE human_email = ?').all(email) as OrgMemberRow[];
}

// ─── Webhook Config Operations ───

export interface WebhookConfigRow {
  id: string;
  org_id: string;
  url: string;
  events: string;
  secret: string;
  enabled: number;
  created_at: string;
  updated_at: string | null;
}

export function insertWebhookConfig(config: WebhookConfigRow): void {
  getDb().prepare(`
    INSERT INTO webhook_configs (id, org_id, url, events, secret, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(config.id, config.org_id, config.url, config.events, config.secret, config.enabled, config.created_at, config.updated_at);
}

export function getWebhookConfigById(id: string): WebhookConfigRow | undefined {
  return getDb().prepare('SELECT * FROM webhook_configs WHERE id = ?').get(id) as WebhookConfigRow | undefined;
}

export function listWebhookConfigs(orgId: string): WebhookConfigRow[] {
  return getDb().prepare('SELECT * FROM webhook_configs WHERE org_id = ? ORDER BY created_at DESC').all(orgId) as WebhookConfigRow[];
}

export function updateWebhookConfig(id: string, updates: { url?: string; events?: string; secret?: string; enabled?: number }): void {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.url !== undefined) {
    fields.push('url = ?');
    params.push(updates.url);
  }
  if (updates.events !== undefined) {
    fields.push('events = ?');
    params.push(updates.events);
  }
  if (updates.secret !== undefined) {
    fields.push('secret = ?');
    params.push(updates.secret);
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    params.push(updates.enabled);
  }

  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  getDb().prepare(`UPDATE webhook_configs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteWebhookConfig(id: string): boolean {
  const result = getDb().prepare('DELETE FROM webhook_configs WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Approval Operations ───

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRow {
  id: string;
  agent_id: string;
  tool_name: string;
  arguments_hash: string;
  status: ApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  expires_at: string;
}

export function insertApproval(approval: ApprovalRow): void {
  getDb().prepare(`
    INSERT INTO approvals (id, agent_id, tool_name, arguments_hash, status, requested_at, decided_at, decided_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    approval.id, approval.agent_id, approval.tool_name, approval.arguments_hash,
    approval.status, approval.requested_at, approval.decided_at, approval.decided_by,
    approval.expires_at,
  );
}

export function getApprovalById(id: string): ApprovalRow | undefined {
  return getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
}

export function listPendingApprovals(): ApprovalRow[] {
  const now = new Date().toISOString();
  return getDb().prepare(
    'SELECT * FROM approvals WHERE status = ? AND expires_at > ? ORDER BY requested_at ASC',
  ).all('pending', now) as ApprovalRow[];
}

export function updateApprovalStatus(
  id: string,
  status: ApprovalStatus,
  decidedBy: string,
): boolean {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = ?',
  ).run(status, now, decidedBy, id, 'pending');
  return result.changes > 0;
}

export function expireOldApprovals(): number {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'UPDATE approvals SET status = ? WHERE status = ? AND expires_at <= ?',
  ).run('expired', 'pending', now);
  return result.changes;
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
