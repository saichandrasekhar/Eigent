"use client";

import { useState } from "react";

interface AgentDetailData {
  id: string;
  name: string;
  human_email: string;
  human_sub: string;
  human_iss: string;
  scope: string[];
  status: string;
  delegation_depth: number;
  max_delegation_depth: number;
  can_delegate: string[] | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  parent_id: string | null;
  chain?: Array<{
    id: string;
    name: string;
    delegation_depth: number;
    scope: string[];
    status: string;
  }>;
  recentAudit?: Array<{
    id: string;
    timestamp: string;
    action: string;
    tool_name: string | null;
  }>;
}

interface AgentDetailProps {
  agent: AgentDetailData;
  onClose: () => void;
  onRevoke?: (agentId: string) => void;
}

const statusStyles: Record<string, { bg: string; text: string; dot: string }> = {
  active: { bg: "bg-status-pass/10", text: "text-status-pass", dot: "bg-status-pass" },
  revoked: { bg: "bg-status-fail/10", text: "text-status-fail", dot: "bg-status-fail" },
  expired: { bg: "bg-status-partial/10", text: "text-status-partial", dot: "bg-status-partial" },
};

export function AgentDetail({ agent, onClose, onRevoke }: AgentDetailProps) {
  const [revoking, setRevoking] = useState(false);
  const isExpired = new Date(agent.expires_at) < new Date();
  const effectiveStatus = agent.status === "revoked" ? "revoked" : isExpired ? "expired" : "active";
  const style = statusStyles[effectiveStatus] ?? statusStyles.active;

  async function handleRevoke() {
    if (!onRevoke) return;
    setRevoking(true);
    try {
      onRevoke(agent.id);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-lg h-full bg-bg-secondary border-l border-border overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-bg-secondary/95 backdrop-blur-sm border-b border-border px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="font-display font-bold text-lg text-text-primary">{agent.name}</h2>
            <p className="text-text-muted text-[0.65rem] font-mono mt-0.5">{agent.id}</p>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors p-1"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Status & Basic Info */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[0.65rem] font-mono ${style.bg} ${style.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                {effectiveStatus.toUpperCase()}
              </span>
              <span className="text-text-muted text-[0.65rem] font-mono">
                Depth {agent.delegation_depth} / {agent.max_delegation_depth} max
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-bg-card rounded-lg border border-border p-3">
                <p className="text-text-muted text-[0.6rem] font-display uppercase tracking-wider mb-1">Human Owner</p>
                <p className="text-text-primary text-xs font-mono truncate">{agent.human_email}</p>
              </div>
              <div className="bg-bg-card rounded-lg border border-border p-3">
                <p className="text-text-muted text-[0.6rem] font-display uppercase tracking-wider mb-1">Issuer</p>
                <p className="text-text-primary text-xs font-mono truncate">{agent.human_iss}</p>
              </div>
              <div className="bg-bg-card rounded-lg border border-border p-3">
                <p className="text-text-muted text-[0.6rem] font-display uppercase tracking-wider mb-1">Created</p>
                <p className="text-text-primary text-xs font-mono">
                  {new Date(agent.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
              <div className="bg-bg-card rounded-lg border border-border p-3">
                <p className="text-text-muted text-[0.6rem] font-display uppercase tracking-wider mb-1">Expires</p>
                <p className={`text-xs font-mono ${isExpired ? "text-status-fail" : "text-text-primary"}`}>
                  {new Date(agent.expires_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            </div>
          </div>

          {/* Scope */}
          <div>
            <h3 className="font-display font-semibold text-xs text-text-primary mb-2">Scope</h3>
            <div className="flex flex-wrap gap-1.5">
              {agent.scope.map((s) => (
                <span key={s} className="bg-accent/10 text-accent text-[0.65rem] font-mono px-2 py-1 rounded">
                  {s}
                </span>
              ))}
            </div>
          </div>

          {/* Can Delegate */}
          {agent.can_delegate && agent.can_delegate.length > 0 && (
            <div>
              <h3 className="font-display font-semibold text-xs text-text-primary mb-2">Can Delegate</h3>
              <div className="flex flex-wrap gap-1.5">
                {agent.can_delegate.map((s) => (
                  <span key={s} className="bg-accent-dim/20 text-accent-light text-[0.65rem] font-mono px-2 py-1 rounded">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Delegation Chain */}
          {agent.chain && agent.chain.length > 0 && (
            <div>
              <h3 className="font-display font-semibold text-xs text-text-primary mb-2">Delegation Chain</h3>
              <div className="space-y-1">
                {agent.chain.map((node, i) => {
                  const nodeStatus = node.status === "revoked" ? "revoked" : "active";
                  const nodeStyle = statusStyles[nodeStatus] ?? statusStyles.active;
                  return (
                    <div key={node.id} className="flex items-center gap-2">
                      {i > 0 && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted shrink-0 ml-2">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      )}
                      <div className={`flex-1 bg-bg-card border ${node.id === agent.id ? "border-accent/40" : "border-border"} rounded-lg px-3 py-2 flex items-center gap-2`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${nodeStyle.dot} shrink-0`} />
                        <span className="text-text-primary text-xs font-mono truncate">{node.name}</span>
                        <span className="text-text-muted text-[0.6rem] font-mono ml-auto shrink-0">
                          d{node.delegation_depth}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recent Activity */}
          {agent.recentAudit && agent.recentAudit.length > 0 && (
            <div>
              <h3 className="font-display font-semibold text-xs text-text-primary mb-2">Recent Activity</h3>
              <div className="bg-bg-card rounded-lg border border-border divide-y divide-border">
                {agent.recentAudit.map((entry) => (
                  <div key={entry.id} className="px-3 py-2 flex items-center gap-3">
                    <span className="text-text-muted text-[0.6rem] font-mono whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className={`text-[0.65rem] font-mono ${
                      entry.action.includes("allowed") ? "text-status-pass" :
                      entry.action.includes("blocked") || entry.action === "revoked" ? "text-status-fail" :
                      "text-accent"
                    }`}>
                      {entry.action.replace(/_/g, " ")}
                    </span>
                    {entry.tool_name && (
                      <span className="text-text-secondary text-[0.6rem] font-mono ml-auto">
                        {entry.tool_name}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="pt-2 border-t border-border flex gap-3">
            {effectiveStatus === "active" && onRevoke && (
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="bg-severity-critical/10 border border-severity-critical/30 text-severity-critical rounded-lg px-4 py-2 text-xs font-display hover:bg-severity-critical/20 transition-colors disabled:opacity-50"
              >
                {revoking ? "Revoking..." : "Revoke Agent"}
              </button>
            )}
            <button
              onClick={onClose}
              className="bg-bg-card border border-border text-text-secondary rounded-lg px-4 py-2 text-xs font-display hover:text-text-primary transition-colors ml-auto"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
