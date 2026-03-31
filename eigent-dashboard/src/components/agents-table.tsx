"use client";

import { useState } from "react";
import { RiskBadge } from "./risk-badge";

interface Agent {
  id: string;
  name: string;
  source: string;
  transport: string;
  authStatus: string;
  configPath: string | null;
  lastSeen: string;
}

interface AgentsTableProps {
  agents: Agent[];
  filters?: {
    source?: string;
    authStatus?: string;
    riskLevel?: string;
  };
}

type SortKey = keyof Agent;

export function AgentsTable({ agents, filters }: AgentsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("lastSeen");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [sourceFilter, setSourceFilter] = useState(filters?.source || "all");
  const [authFilter, setAuthFilter] = useState(filters?.authStatus || "all");

  const sources = ["all", ...new Set(agents.map((a) => a.source))];
  const authStatuses = ["all", ...new Set(agents.map((a) => a.authStatus))];

  let filtered = agents;
  if (sourceFilter !== "all") {
    filtered = filtered.filter((a) => a.source === sourceFilter);
  }
  if (authFilter !== "all") {
    filtered = filtered.filter((a) => a.authStatus === authFilter);
  }

  const sorted = [...filtered].sort((a, b) => {
    const cmp = String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""));
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

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary focus:border-accent focus:outline-none"
        >
          {sources.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All Sources" : s}
            </option>
          ))}
        </select>
        <select
          value={authFilter}
          onChange={(e) => setAuthFilter(e.target.value)}
          className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary focus:border-accent focus:outline-none"
        >
          {authStatuses.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All Auth Statuses" : s}
            </option>
          ))}
        </select>
        <span className="text-text-muted text-xs font-mono self-center ml-auto">
          {sorted.length} agent{sorted.length !== 1 ? "s" : ""}
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="bg-bg-card rounded-xl border border-border p-12 text-center">
          <p className="text-text-muted text-sm">No agents found. Submit a scan to discover agents.</p>
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
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("source")}>
                    Source {sortIcon("source")}
                  </th>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("transport")}>
                    Transport {sortIcon("transport")}
                  </th>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("authStatus")}>
                    Auth Status {sortIcon("authStatus")}
                  </th>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("lastSeen")}>
                    Last Seen {sortIcon("lastSeen")}
                  </th>
                  <th className="cursor-pointer select-none" onClick={() => toggleSort("configPath")}>
                    Config Path {sortIcon("configPath")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => (
                  <tr key={a.id}>
                    <td className="font-medium text-text-primary">{a.name}</td>
                    <td>
                      <span className="bg-bg-hover px-2 py-0.5 rounded text-xs text-text-secondary">
                        {a.source}
                      </span>
                    </td>
                    <td className="text-text-secondary text-xs">{a.transport}</td>
                    <td>
                      <RiskBadge level={a.authStatus === "none" ? "critical" : a.authStatus === "api_key" ? "medium" : "clean"} />
                      <span className="ml-2 text-xs text-text-muted">{a.authStatus}</span>
                    </td>
                    <td className="text-text-muted text-xs">
                      {new Date(a.lastSeen).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="text-text-muted text-xs font-mono max-w-[200px] truncate">
                      {a.configPath || "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
