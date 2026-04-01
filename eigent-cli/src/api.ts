import { getRegistryUrl } from './config.js';

// ─── Types ───

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface AgentRecord {
  id: string;
  name: string;
  human_email: string;
  human_sub: string;
  human_iss: string;
  scope: string[];
  parent_id: string | null;
  delegation_depth: number;
  max_delegation_depth: number;
  can_delegate: string[];
  status: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  token?: string;
}

interface VerifyResult {
  allowed: boolean;
  agent_id: string;
  agent_name: string;
  tool: string;
  scope: string[];
  human_email: string;
  delegation_depth: number;
  reason?: string;
}

interface ChainNode {
  type: 'human' | 'agent';
  name: string;
  email?: string;
  scope?: string[];
  delegation_depth?: number;
  agent_id?: string;
  status?: string;
}

interface AuditEntry {
  id: string;
  timestamp: string;
  agent_id: string;
  agent_name?: string;
  human_email: string;
  action: string;
  tool_name: string | null;
  delegation_chain: string | null;
  details: string | null;
}

interface AuditResponse {
  entries: AuditEntry[];
  total: number;
}

interface RevokeResult {
  revoked_id: string;
  revoked_name: string;
  cascade_revoked: Array<{ id: string; name: string }>;
  total_revoked: number;
}

export type {
  AgentRecord,
  VerifyResult,
  ChainNode,
  AuditEntry,
  AuditResponse,
  RevokeResult,
};

// ─── HTTP Client ───

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const baseUrl = getRegistryUrl();
  const url = `${baseUrl}${path}`;

  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, opts);
  } catch (err: unknown) {
    if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('ECONNREFUSED'))) {
      throw new Error(
        `Cannot connect to registry at ${baseUrl}. Is the registry running?\n` +
        `Start it with: cd eigent-registry && npm run dev`
      );
    }
    throw err;
  }

  const text = await res.text();
  let json: ApiResponse<T>;

  try {
    json = JSON.parse(text);
  } catch {
    if (!res.ok) {
      throw new ApiError(res.status, `Registry returned ${res.status}: ${text}`);
    }
    return text as unknown as T;
  }

  if (!res.ok) {
    throw new ApiError(res.status, json.error ?? `Registry returned ${res.status}`);
  }

  return (json.data ?? json) as T;
}

// ─── Registry API ───

export async function createAgent(params: {
  name: string;
  human_email: string;
  human_sub: string;
  human_iss: string;
  scope: string[];
  ttl: number;
  max_delegation_depth: number;
  can_delegate?: string[];
}): Promise<AgentRecord> {
  return request<AgentRecord>('POST', '/api/agents', params);
}

export async function delegateAgent(params: {
  parent_id: string;
  name: string;
  scope: string[];
  ttl?: number;
  max_delegation_depth?: number;
  parent_token: string;
}): Promise<AgentRecord> {
  const { parent_id, parent_token, ...body } = params;
  return request<AgentRecord>(
    'POST',
    `/api/agents/${parent_id}/delegate`,
    body,
    { Authorization: `Bearer ${parent_token}` },
  );
}

export async function listAgents(): Promise<AgentRecord[]> {
  return request<AgentRecord[]>('GET', '/api/agents');
}

export async function getAgent(id: string): Promise<AgentRecord> {
  return request<AgentRecord>('GET', `/api/agents/${id}`);
}

export async function revokeAgent(id: string): Promise<RevokeResult> {
  return request<RevokeResult>('DELETE', `/api/agents/${id}`);
}

export async function verifyAgent(params: {
  agent_id: string;
  tool: string;
  token?: string;
}): Promise<VerifyResult> {
  return request<VerifyResult>('POST', '/api/verify', params);
}

export async function getChain(id: string): Promise<ChainNode[]> {
  return request<ChainNode[]>('GET', `/api/agents/${id}/chain`);
}

export async function queryAudit(filters: {
  agent?: string;
  human?: string;
  action?: string;
  limit?: number;
}): Promise<AuditResponse> {
  const params = new URLSearchParams();
  if (filters.agent) params.set('agent', filters.agent);
  if (filters.human) params.set('human', filters.human);
  if (filters.action) params.set('action', filters.action);
  if (filters.limit) params.set('limit', filters.limit.toString());

  const query = params.toString();
  const path = `/api/audit${query ? `?${query}` : ''}`;
  return request<AuditResponse>('GET', path);
}

export async function healthCheck(): Promise<boolean> {
  try {
    await request<unknown>('GET', '/health');
    return true;
  } catch {
    return false;
  }
}
