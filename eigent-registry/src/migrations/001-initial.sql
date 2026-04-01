-- Eigent Registry: Initial PostgreSQL Migration
-- Creates all tables, indexes, and constraints

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
  parent_id TEXT REFERENCES agents(id),
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
  FOREIGN KEY (org_id) REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  timestamp TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  human_email TEXT NOT NULL,
  action TEXT NOT NULL,
  tool_name TEXT,
  delegation_chain TEXT,
  details TEXT,
  prev_hash TEXT,
  row_hash TEXT
);

CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_usage (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  hour TEXT NOT NULL,
  tool_calls INTEGER DEFAULT 0,
  blocked_calls INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  PRIMARY KEY (agent_id, hour)
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
  provider_id TEXT REFERENCES oidc_providers(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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

-- Indexes for agents
CREATE INDEX IF NOT EXISTS idx_agents_org_id ON agents(org_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_human_email ON agents(human_email);
CREATE INDEX IF NOT EXISTS idx_agents_parent_id ON agents(parent_id);
CREATE INDEX IF NOT EXISTS idx_agents_human_sub ON agents(human_sub);
CREATE INDEX IF NOT EXISTS idx_agents_expires_at ON agents(expires_at);
CREATE INDEX IF NOT EXISTS idx_agents_last_seen_at ON agents(last_seen_at);

-- Indexes for agent_usage
CREATE INDEX IF NOT EXISTS idx_agent_usage_hour ON agent_usage(hour);

-- Indexes for audit_log
CREATE INDEX IF NOT EXISTS idx_audit_org_id ON audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_agent_id ON audit_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_human_email ON audit_log(human_email);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);

-- Indexes for keys
CREATE INDEX IF NOT EXISTS idx_keys_org_id ON keys(org_id);

-- Indexes for webhook_configs
CREATE INDEX IF NOT EXISTS idx_webhook_configs_org_id ON webhook_configs(org_id);

-- Indexes for sessions
CREATE INDEX IF NOT EXISTS idx_sessions_human_sub ON sessions(human_sub);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Indexes for oidc_providers
CREATE INDEX IF NOT EXISTS idx_oidc_providers_issuer ON oidc_providers(issuer_url);

-- Indexes for approvals
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_agent_id ON approvals(agent_id);
CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals(expires_at);

-- Seed default organization
INSERT INTO organizations (id, name, slug, created_at, settings)
VALUES ('default', 'Default Organization', 'default', NOW()::text, '{}')
ON CONFLICT (id) DO NOTHING;
