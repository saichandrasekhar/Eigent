/**
 * SQLite adapter that wraps the existing synchronous db.ts module.
 * This adapter implements the DatabaseAdapter interface by delegating
 * to the existing db.ts functions.
 */

import type { DatabaseAdapter } from './db-factory.js';
import type {
  AgentRow,
  AuditRow,
  KeyRow,
  OIDCProviderRow,
  SessionRow,
} from './db.js';
import {
  getDb,
  insertAgent as dbInsertAgent,
  getAgentById as dbGetAgentById,
  getAgentByTokenJti as dbGetAgentByTokenJti,
  listAgents as dbListAgents,
  findDescendants as dbFindDescendants,
  revokeAgentCascade as dbRevokeAgentCascade,
  getDelegationChain as dbGetDelegationChain,
  insertAuditLog as dbInsertAuditLog,
  queryAuditLog as dbQueryAuditLog,
  insertKey as dbInsertKey,
  getLatestKey as dbGetLatestKey,
  getAllPublicKeys as dbGetAllPublicKeys,
  insertOIDCProvider as dbInsertOIDCProvider,
  listOIDCProviders as dbListOIDCProviders,
  insertSession as dbInsertSession,
  getActiveSession as dbGetActiveSession,
  deleteSession as dbDeleteSession,
} from './db.js';

export class SQLiteAdapter implements DatabaseAdapter {
  async initialize(): Promise<void> {
    // db.ts initDb() is called separately before this adapter is created
  }

  async close(): Promise<void> {
    getDb().close();
  }

  async ping(): Promise<boolean> {
    try {
      getDb().prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async insertAgent(agent: AgentRow): Promise<void> {
    dbInsertAgent(agent);
  }

  async getAgentById(id: string): Promise<AgentRow | undefined> {
    return dbGetAgentById(id);
  }

  async getAgentByTokenJti(jti: string): Promise<AgentRow | undefined> {
    return dbGetAgentByTokenJti(jti);
  }

  async listAgents(filters: {
    org_id?: string;
    status?: string;
    human_email?: string;
    parent_id?: string;
  }): Promise<AgentRow[]> {
    return dbListAgents(filters);
  }

  async findDescendants(agentId: string): Promise<string[]> {
    return dbFindDescendants(agentId);
  }

  async revokeAgentCascade(agentId: string): Promise<string[]> {
    return dbRevokeAgentCascade(agentId);
  }

  async getDelegationChain(agentId: string): Promise<AgentRow[]> {
    return dbGetDelegationChain(agentId);
  }

  async insertAuditLog(entry: AuditRow): Promise<void> {
    dbInsertAuditLog(entry);
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
    return dbQueryAuditLog(filters);
  }

  async insertKey(key: KeyRow): Promise<void> {
    dbInsertKey(key);
  }

  async getLatestKey(): Promise<KeyRow | undefined> {
    return dbGetLatestKey();
  }

  async getAllPublicKeys(): Promise<{ id: string; public_key: string }[]> {
    return dbGetAllPublicKeys();
  }

  async insertOIDCProvider(provider: OIDCProviderRow): Promise<void> {
    dbInsertOIDCProvider(provider);
  }

  async listOIDCProviders(enabledOnly?: boolean): Promise<OIDCProviderRow[]> {
    return dbListOIDCProviders(enabledOnly);
  }

  async insertSession(session: SessionRow): Promise<void> {
    dbInsertSession(session);
  }

  async getActiveSession(sessionId: string): Promise<SessionRow | undefined> {
    return dbGetActiveSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    dbDeleteSession(sessionId);
  }
}
