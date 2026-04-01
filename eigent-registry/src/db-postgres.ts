/**
 * PostgreSQL adapter with connection pooling.
 * Implements the DatabaseAdapter interface using node-postgres (pg).
 */

import pg from 'pg';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter } from './db-factory.js';
import type {
  AgentRow,
  AuditRow,
  KeyRow,
  OIDCProviderRow,
  SessionRow,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class PostgresAdapter implements DatabaseAdapter {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      min: 2,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async initialize(): Promise<void> {
    // Run migrations
    const migrationPath = path.join(
      __dirname,
      'migrations',
      '001-initial.sql',
    );
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf-8');
      await this.pool.query(sql);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  // ─── Agent Operations ───

  async insertAgent(agent: AgentRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO agents (id, org_id, name, human_sub, human_email, human_iss, scope, parent_id,
        delegation_depth, max_delegation_depth, can_delegate, token_jti, status, risk_level,
        created_at, expires_at, revoked_at, last_seen_at, deprovisioned_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        agent.id,
        agent.org_id,
        agent.name,
        agent.human_sub,
        agent.human_email,
        agent.human_iss,
        agent.scope,
        agent.parent_id,
        agent.delegation_depth,
        agent.max_delegation_depth,
        agent.can_delegate,
        agent.token_jti,
        agent.status,
        agent.risk_level ?? 'minimal',
        agent.created_at,
        agent.expires_at,
        agent.revoked_at,
        agent.last_seen_at ?? null,
        agent.deprovisioned_at ?? null,
        agent.metadata,
      ],
    );
  }

  async getAgentById(id: string): Promise<AgentRow | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agents WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? undefined;
  }

  async getAgentByTokenJti(jti: string): Promise<AgentRow | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agents WHERE token_jti = $1',
      [jti],
    );
    return result.rows[0] ?? undefined;
  }

  async listAgents(filters: {
    org_id?: string;
    status?: string;
    human_email?: string;
    parent_id?: string;
  }): Promise<AgentRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.org_id) {
      conditions.push(`org_id = $${paramIndex++}`);
      params.push(filters.org_id);
    }
    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }
    if (filters.human_email) {
      conditions.push(`human_email = $${paramIndex++}`);
      params.push(filters.human_email);
    }
    if (filters.parent_id) {
      conditions.push(`parent_id = $${paramIndex++}`);
      params.push(filters.parent_id);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM agents ${where} ORDER BY created_at DESC`,
      params,
    );
    return result.rows;
  }

  async findDescendants(agentId: string): Promise<string[]> {
    const result = await this.pool.query(
      `WITH RECURSIVE descendants AS (
        SELECT id FROM agents WHERE parent_id = $1
        UNION ALL
        SELECT a.id FROM agents a INNER JOIN descendants d ON a.parent_id = d.id
      )
      SELECT id FROM descendants`,
      [agentId],
    );
    return result.rows.map((r: { id: string }) => r.id);
  }

  async revokeAgentCascade(agentId: string): Promise<string[]> {
    const now = new Date().toISOString();
    const descendants = await this.findDescendants(agentId);
    const allIds = [agentId, ...descendants];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const id of allIds) {
        await client.query(
          'UPDATE agents SET status = $1, revoked_at = $2 WHERE id = $3',
          ['revoked', now, id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return allIds;
  }

  async getDelegationChain(agentId: string): Promise<AgentRow[]> {
    const chain: AgentRow[] = [];
    let current = await this.getAgentById(agentId);

    while (current) {
      chain.unshift(current);
      if (current.parent_id) {
        current = await this.getAgentById(current.parent_id);
      } else {
        break;
      }
    }

    return chain;
  }

  // ─── Audit Log Operations ───

  private async getLastAuditHash(): Promise<string> {
    const result = await this.pool.query(
      'SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY timestamp DESC, id DESC LIMIT 1',
    );
    return result.rows[0]?.row_hash ?? 'genesis';
  }

  private computeAuditRowHash(event: AuditRow, prevHash: string): string {
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

  async insertAuditLog(entry: AuditRow): Promise<void> {
    const prevHash = await this.getLastAuditHash();
    const rowHash = this.computeAuditRowHash(entry, prevHash);

    await this.pool.query(
      `INSERT INTO audit_log (id, org_id, timestamp, agent_id, human_email, action, tool_name, delegation_chain, details, prev_hash, row_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.id,
        entry.org_id,
        entry.timestamp,
        entry.agent_id,
        entry.human_email,
        entry.action,
        entry.tool_name,
        entry.delegation_chain,
        entry.details,
        prevHash,
        rowHash,
      ],
    );
  }

  async queryAuditLog(filters: {
    org_id?: string;
    agent_id?: string;
    human_email?: string;
    action?: string;
    tool_name?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: AuditRow[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.org_id) {
      conditions.push(`org_id = $${paramIndex++}`);
      params.push(filters.org_id);
    }
    if (filters.agent_id) {
      conditions.push(`agent_id = $${paramIndex++}`);
      params.push(filters.agent_id);
    }
    if (filters.human_email) {
      conditions.push(`human_email = $${paramIndex++}`);
      params.push(filters.human_email);
    }
    if (filters.action) {
      conditions.push(`action = $${paramIndex++}`);
      params.push(filters.action);
    }
    if (filters.tool_name) {
      conditions.push(`tool_name = $${paramIndex++}`);
      params.push(filters.tool_name);
    }
    if (filters.from_date) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(filters.from_date);
    }
    if (filters.to_date) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(filters.to_date);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM audit_log ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const entriesParams = [...params, limit, offset];
    const entriesResult = await this.pool.query(
      `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      entriesParams,
    );

    return { entries: entriesResult.rows, total };
  }

  // ─── Key Operations ───

  async insertKey(key: KeyRow): Promise<void> {
    await this.pool.query(
      'INSERT INTO keys (id, org_id, public_key, private_key, created_at) VALUES ($1, $2, $3, $4, $5)',
      [key.id, key.org_id, key.public_key, key.private_key, key.created_at],
    );
  }

  async getLatestKey(): Promise<KeyRow | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM keys ORDER BY created_at DESC LIMIT 1',
    );
    return result.rows[0] ?? undefined;
  }

  async getAllPublicKeys(): Promise<{ id: string; public_key: string }[]> {
    const result = await this.pool.query(
      'SELECT id, public_key FROM keys ORDER BY created_at DESC',
    );
    return result.rows;
  }

  // ─── OIDC Provider Operations ───

  async insertOIDCProvider(provider: OIDCProviderRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO oidc_providers (id, issuer_url, client_id, client_secret_encrypted, type, enabled, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        provider.id,
        provider.issuer_url,
        provider.client_id,
        provider.client_secret_encrypted,
        provider.type,
        provider.enabled,
        provider.created_at,
        provider.updated_at,
      ],
    );
  }

  async listOIDCProviders(
    enabledOnly: boolean = true,
  ): Promise<OIDCProviderRow[]> {
    if (enabledOnly) {
      const result = await this.pool.query(
        'SELECT * FROM oidc_providers WHERE enabled = 1 ORDER BY created_at DESC',
      );
      return result.rows;
    }
    const result = await this.pool.query(
      'SELECT * FROM oidc_providers ORDER BY created_at DESC',
    );
    return result.rows;
  }

  // ─── Session Operations ───

  async insertSession(session: SessionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, human_sub, human_email, human_iss, id_token_hash, provider_id, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        session.id,
        session.human_sub,
        session.human_email,
        session.human_iss,
        session.id_token_hash,
        session.provider_id,
        session.expires_at,
        session.created_at,
      ],
    );
  }

  async getActiveSession(
    sessionId: string,
  ): Promise<SessionRow | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM sessions WHERE id = $1 AND expires_at > $2',
      [sessionId, new Date().toISOString()],
    );
    return result.rows[0] ?? undefined;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  }
}
