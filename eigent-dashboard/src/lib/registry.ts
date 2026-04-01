const REGISTRY_URL = process.env.EIGENT_REGISTRY_URL || "http://localhost:3456";

export interface RegistryAgent {
  id: string;
  name: string;
  human_sub: string;
  human_email: string;
  human_iss: string;
  scope: string[];
  parent_id: string | null;
  delegation_depth: number;
  max_delegation_depth: number;
  can_delegate: string[] | null;
  token_jti: string;
  status: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface RegistryAuditEntry {
  id: string;
  timestamp: string;
  agent_id: string;
  human_email: string;
  action: string;
  tool_name: string | null;
  delegation_chain: string[] | null;
  details: Record<string, unknown> | null;
}

export interface DelegationChainNode {
  id: string;
  name: string;
  delegation_depth: number;
  scope: string[];
  status: string;
  human_email: string;
  created_at: string;
}

async function registryFetch<T>(path: string, options?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${REGISTRY_URL}${path}`, {
      ...options,
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchAgents(status?: string): Promise<{ agents: RegistryAgent[]; total: number }> {
  const query = status ? `?status=${status}` : "?status=";
  const data = await registryFetch<{ agents: RegistryAgent[]; total: number }>(`/api/agents${query}`);
  return data ?? { agents: [], total: 0 };
}

export async function fetchAgent(id: string): Promise<RegistryAgent | null> {
  return registryFetch<RegistryAgent>(`/api/agents/${id}`);
}

export async function fetchDelegationChain(id: string): Promise<{
  agent_id: string;
  chain: DelegationChainNode[];
  depth: number;
  root_human_email: string;
} | null> {
  return registryFetch(`/api/agents/${id}/chain`);
}

export async function fetchAuditLog(params?: {
  agent_id?: string;
  human_email?: string;
  action?: string;
  tool_name?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}): Promise<{ entries: RegistryAuditEntry[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        searchParams.set(key, String(value));
      }
    }
  }
  const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const data = await registryFetch<{ entries: RegistryAuditEntry[]; total: number }>(`/api/audit${query}`);
  return data ?? { entries: [], total: 0 };
}

export async function revokeAgent(id: string): Promise<{
  revoked_agent_id: string;
  cascade_revoked: string[];
  total_revoked: number;
} | null> {
  return registryFetch(`/api/agents/${id}`, { method: "DELETE" });
}

export async function checkHealth(): Promise<boolean> {
  const data = await registryFetch<{ status: string }>("/api/health");
  return data?.status === "ok";
}

export function getRegistryUrl(): string {
  return REGISTRY_URL;
}
