"use client";

import { useState, useCallback } from "react";
import { AgentDetail } from "@/components/agent-detail";
import type { RegistryAgent } from "@/lib/registry";

interface AgentWithAudit extends RegistryAgent {
  recentAudit: Array<{
    id: string;
    timestamp: string;
    action: string;
    tool_name: string | null;
  }>;
}

interface RegistryAgentsViewProps {
  agents: AgentWithAudit[];
}

type SortKey = "name" | "human_email" | "delegation_depth" | "status" | "created_at" | "expires_at";

export function RegistryAgentsView({ agents }: RegistryAgentsViewProps) {
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [statusFilter, setStatusFilter] = useState("all");
  const [humanFilter, setHumanFilter] = useState("all");
  const [selectedAgent, setSelectedAgent] = useState<AgentWithAudit | null>(null);

  const uniqueHumans = ["all", ...new Set(agents.map((a) => a.human_email))];

  let filtered = agents;
  if (statusFilter !== "all") {
    filtered = filtered.filter((a) => a.status === statusFilter);
  }
  if (humanFilter !== "all") {
    filtered = filtered.filter((a) => a.human_email === humanFilter);
  }

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "delegation_depth") {
      cmp = a.delegation_depth - b.delegation_depth;
    } else {
      cmp = String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""));
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return "\u2195";
    return sortDir === "asc" ? "\u2191" : "\u2193";
  };

  const handleRevoke = useCallback(async (agentId: string) => {
    try {
      const res = await fetch(`/api/registry/agents/${agentId}`, { method: "DELETE" });
      if (res.ok) {
        window.location.reload();
      }
    } catch {
      // Revoke failed silently
    }
  }, []);

  function getEffectiveStatus(agent: AgentWithAudit): string {
    if (agent.status === "revoked") return "revoked";
    if (new Date(agent.expires_at) < new Date()) return "expired";
    return "active";
  }

  const statusColors: Record<string, { bg: string; text: string; dot: string }> = {
    active: { bg: "bg-status-pass/10", text: "text-status-pass", dot: "bg-status-pass" },
    revoked: { bg: "bg-status-fail/10", text: "text-status-fail", dot: "bg-status-fail" },
    expired: { bg: "bg-status-partial/10", text: "text-status-partial", dot: "bg-status-partial" },
  };

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary focus:border-accent focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="revoked">Revoked</option>
        </select>
        <select
          value={humanFilter}
          onChange={(e) => setHumanFilter(e.target.value)}
          className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary focus:border-accent focus:outline-none"
        >
          {uniqueHumans.map((h) => (
            <option key={h} value={h}>
              {h === "all" ? "All Humans" : h}
            </option>
          ))}
        </select>
        <span className="text-text-muted text-xs font-mono self-center ml-auto">
          {sorted.length} agent{sorted.length !== 1 ? "s" : ""}
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="bg-bg-card rounded-xl border border-border p-12 text-center">
          <p className="text-text-muted text-sm font-display">No agents found in the registry.</p>
          <p className="text-text-muted text-xs font-mono mt-1">Register agents via the eigent-registry API.</p>
        </div>
      ) : (
        <div className="bg-bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("name")}>
                    Name {sortIcon("name")}
                  </th>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("human_email")}>
                    Human Owner {sortIcon("human_email")}
                  </th>
                  <th>Scope</th>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("delegation_depth")}>
                    Depth {sortIcon("delegation_depth")}
                  </th>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("status")}>
                    Status {sortIcon("status")}
                  </th>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("expires_at")}>
                    Expires {sortIcon("expires_at")}
                  </th>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("created_at")}>
                    Created {sortIcon("created_at")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((agent) => {
                  const effectiveStatus = getEffectiveStatus(agent);
                  const colors = statusColors[effectiveStatus] ?? statusColors.active;
                  return (
                    <tr
                      key={agent.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedAgent(agent)}
                    >
                      <td className="font-medium text-text-primary">{agent.name}</td>
                      <td className="text-text-secondary text-xs truncate max-w-[180px]">{agent.human_email}</td>
                      <td>
                        <div className="flex flex-wrap gap-1 max-w-[200px]">
                          {agent.scope.slice(0, 3).map((s) => (
                            <span key={s} className="bg-accent/10 text-accent text-[0.6rem] font-mono px-1.5 py-0.5 rounded">
                              {s}
                            </span>
                          ))}
                          {agent.scope.length > 3 && (
                            <span className="text-text-muted text-[0.6rem] font-mono">+{agent.scope.length - 3}</span>
                          )}
                        </div>
                      </td>
                      <td className="text-text-secondary text-xs font-mono text-center">
                        {agent.delegation_depth}/{agent.max_delegation_depth}
                      </td>
                      <td>
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[0.65rem] font-mono ${colors.bg} ${colors.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
                          {effectiveStatus.toUpperCase()}
                        </span>
                      </td>
                      <td className="text-text-muted text-xs font-mono whitespace-nowrap">
                        {new Date(agent.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="text-text-muted text-xs font-mono whitespace-nowrap">
                        {new Date(agent.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Agent Detail Panel */}
      {selectedAgent && (
        <AgentDetail
          agent={{
            ...selectedAgent,
            recentAudit: selectedAgent.recentAudit,
          }}
          onClose={() => setSelectedAgent(null)}
          onRevoke={handleRevoke}
        />
      )}
    </div>
  );
}
