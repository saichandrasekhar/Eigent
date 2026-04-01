"use client";

import { useState } from "react";

interface AuditEntry {
  id: string;
  timestamp: string;
  agent_id: string;
  human_email: string;
  action: string;
  tool_name: string | null;
  delegation_chain: string[] | null;
  details: Record<string, unknown> | null;
  agent_name?: string;
}

interface AuditLogProps {
  entries: AuditEntry[];
  showFilters?: boolean;
  showExport?: boolean;
  compact?: boolean;
}

const actionColors: Record<string, { bg: string; text: string }> = {
  issued: { bg: "bg-accent/10", text: "text-accent" },
  delegated: { bg: "bg-accent-light/10", text: "text-accent-light" },
  revoked: { bg: "bg-severity-critical/10", text: "text-severity-critical" },
  tool_call_allowed: { bg: "bg-status-pass/10", text: "text-status-pass" },
  tool_call_blocked: { bg: "bg-status-fail/10", text: "text-status-fail" },
};

function ActionBadge({ action }: { action: string }) {
  const colors = actionColors[action] ?? { bg: "bg-severity-info/10", text: "text-severity-info" };
  const label = action.replace(/_/g, " ").replace(/tool call /g, "");

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[0.65rem] font-mono ${colors.bg} ${colors.text}`}>
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          action.includes("allowed")
            ? "bg-status-pass"
            : action.includes("blocked") || action === "revoked"
            ? "bg-status-fail"
            : "bg-accent"
        }`}
      />
      {label.toUpperCase()}
    </span>
  );
}

export function AuditLog({ entries, showFilters = true, showExport = false, compact = false }: AuditLogProps) {
  const [actionFilter, setActionFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

  const actions = ["all", ...new Set(entries.map((e) => e.action))];

  let filtered = entries;
  if (actionFilter !== "all") {
    filtered = filtered.filter((e) => e.action === actionFilter);
  }
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.human_email.toLowerCase().includes(term) ||
        e.agent_id.toLowerCase().includes(term) ||
        (e.tool_name ?? "").toLowerCase().includes(term) ||
        (e.agent_name ?? "").toLowerCase().includes(term)
    );
  }

  function exportData(format: "json" | "csv") {
    let content: string;
    let mimeType: string;
    let filename: string;

    if (format === "json") {
      content = JSON.stringify(filtered, null, 2);
      mimeType = "application/json";
      filename = "eigent-audit-log.json";
    } else {
      const headers = ["timestamp", "agent_id", "human_email", "action", "tool_name"];
      const rows = filtered.map((e) =>
        [e.timestamp, e.agent_id, e.human_email, e.action, e.tool_name ?? ""].join(",")
      );
      content = [headers.join(","), ...rows].join("\n");
      mimeType = "text/csv";
      filename = "eigent-audit-log.csv";
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (entries.length === 0) {
    return (
      <div className="bg-bg-card rounded-xl border border-border p-12 text-center">
        <p className="text-text-muted text-sm font-display">No audit entries found.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Filters bar */}
      {showFilters && (
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Search by email, agent ID, or tool..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary focus:border-accent focus:outline-none flex-1 min-w-[200px]"
          />
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary focus:border-accent focus:outline-none"
          >
            {actions.map((a) => (
              <option key={a} value={a}>
                {a === "all" ? "All Actions" : a.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          {showExport && (
            <div className="flex gap-2">
              <button
                onClick={() => exportData("json")}
                className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
              >
                Export JSON
              </button>
              <button
                onClick={() => exportData("csv")}
                className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
              >
                Export CSV
              </button>
            </div>
          )}
          <span className="text-text-muted text-xs font-mono self-center ml-auto">
            {filtered.length} of {entries.length} entries
          </span>
        </div>
      )}

      {/* Table */}
      <div className="bg-bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                {!compact && <th>Agent</th>}
                <th>Human</th>
                <th>Action</th>
                <th>Tool</th>
                {!compact && <th>Chain Depth</th>}
                {!compact && <th>Details</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id}>
                  <td className="text-text-muted text-xs font-mono whitespace-nowrap">
                    {new Date(entry.timestamp).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </td>
                  {!compact && (
                    <td className="text-accent text-xs font-mono max-w-[120px] truncate" title={entry.agent_id}>
                      {entry.agent_name ?? entry.agent_id.slice(0, 12)}...
                    </td>
                  )}
                  <td className="text-text-secondary text-xs truncate max-w-[160px]">
                    {entry.human_email}
                  </td>
                  <td>
                    <ActionBadge action={entry.action} />
                  </td>
                  <td className="text-text-secondary text-xs font-mono">
                    {entry.tool_name ?? "--"}
                  </td>
                  {!compact && (
                    <td className="text-text-muted text-xs font-mono">
                      {entry.delegation_chain ? entry.delegation_chain.length : "--"}
                    </td>
                  )}
                  {!compact && (
                    <td className="text-text-muted text-[0.65rem] font-mono max-w-[200px] truncate">
                      {entry.details ? JSON.stringify(entry.details).slice(0, 60) : "--"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
