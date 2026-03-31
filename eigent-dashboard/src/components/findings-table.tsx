"use client";

import { useState } from "react";
import { RiskBadge } from "./risk-badge";

interface Finding {
  id: string;
  agentName: string;
  severity: string;
  title: string;
  description: string;
  recommendation: string;
  createdAt: string;
}

interface FindingsTableProps {
  findings: Finding[];
}

type SortKey = keyof Finding;

export function FindingsTable({ findings }: FindingsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };

  const sorted = [...findings].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "severity") {
      cmp = (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5);
    } else {
      cmp = String(a[sortKey]).localeCompare(String(b[sortKey]));
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

  if (findings.length === 0) {
    return (
      <div className="bg-bg-card rounded-xl border border-border p-12 text-center">
        <p className="text-text-muted text-sm">No findings yet. Submit a scan to see results.</p>
      </div>
    );
  }

  return (
    <div className="bg-bg-card rounded-xl border border-border overflow-hidden">
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th className="cursor-pointer select-none" onClick={() => toggleSort("severity")}>
                Severity {sortIcon("severity")}
              </th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort("title")}>
                Finding {sortIcon("title")}
              </th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort("agentName")}>
                Agent {sortIcon("agentName")}
              </th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort("description")}>
                Description {sortIcon("description")}
              </th>
              <th>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((f) => (
              <tr key={f.id}>
                <td>
                  <RiskBadge level={f.severity} />
                </td>
                <td className="font-medium text-text-primary max-w-[200px] truncate">
                  {f.title}
                </td>
                <td className="text-accent font-mono text-xs">{f.agentName}</td>
                <td className="text-text-secondary max-w-[300px] truncate">{f.description}</td>
                <td className="text-text-muted max-w-[250px] truncate">{f.recommendation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
