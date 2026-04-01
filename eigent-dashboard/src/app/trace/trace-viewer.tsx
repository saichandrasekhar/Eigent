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
}

interface ChainNode {
  type: "human" | "agent";
  name: string;
  email?: string;
  scope?: string[];
  delegation_depth?: number;
  agent_id?: string;
  status?: string;
}

interface TraceData {
  id: string;
  timestamp: string;
  action: string;
  agent_id: string;
  agent_name: string;
  human_email: string;
  tool_name: string | null;
  details: Record<string, unknown> | null;
  delegation_chain: string[] | null;
  chain: ChainNode[];
  decision: string | null;
  reason: string | null;
  policy_rule: string | null;
  audit_hash: string | null;
  hash_verified: boolean;
}

interface TraceViewerProps {
  initialEntries: AuditEntry[];
}

export function TraceViewer({ initialEntries }: TraceViewerProps) {
  const [searchId, setSearchId] = useState("");
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(["timeline", "chain", "decision"])
  );

  async function fetchTrace(eventId: string) {
    setLoading(true);
    setError(null);
    setTrace(null);

    try {
      const res = await fetch(`/api/registry/audit/${encodeURIComponent(eventId)}/trace`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed to fetch trace" }));
        throw new Error((body as Record<string, string>).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as TraceData;
      setTrace(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch trace");
    } finally {
      setLoading(false);
    }
  }

  function toggleSection(section: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }

  return (
    <div>
      {/* Search */}
      <div className="flex gap-3 mb-8">
        <input
          type="text"
          placeholder="Enter audit event ID (e.g. evt-abc123...)"
          value={searchId}
          onChange={(e) => setSearchId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && searchId.trim()) {
              fetchTrace(searchId.trim());
            }
          }}
          className="flex-1 bg-bg-card border border-border rounded-lg px-4 py-2.5 text-sm font-mono text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <button
          onClick={() => searchId.trim() && fetchTrace(searchId.trim())}
          disabled={loading || !searchId.trim()}
          className="px-5 py-2.5 bg-accent text-white text-sm font-display font-semibold rounded-lg hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Loading..." : "Trace"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-status-fail/10 border border-status-fail/30 rounded-xl p-4 mb-6">
          <p className="text-status-fail text-sm font-mono">{error}</p>
        </div>
      )}

      {/* Trace Result */}
      {trace && (
        <div className="space-y-4">
          {/* Event Summary */}
          <div className="bg-bg-card rounded-xl border border-border p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-display font-bold text-text-primary">
                Event: {trace.action}
              </h2>
              <DecisionBadge decision={trace.decision} action={trace.action} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <InfoField label="Event ID" value={trace.id} mono />
              <InfoField label="Timestamp" value={new Date(trace.timestamp).toLocaleString()} />
              <InfoField label="Agent" value={trace.agent_name} />
              <InfoField label="Human" value={trace.human_email} />
            </div>
          </div>

          {/* Timeline */}
          <CollapsibleSection
            title="Timeline"
            id="timeline"
            expanded={expandedSections.has("timeline")}
            onToggle={() => toggleSection("timeline")}
          >
            <div className="space-y-0">
              {/* Human auth step */}
              {trace.chain.length > 0 && trace.chain[0].type === "human" && (
                <TimelineStep
                  icon="person"
                  title="Human Authentication"
                  subtitle={trace.chain[0].email ?? trace.chain[0].name}
                  status="complete"
                  details={`Authenticated as ${trace.chain[0].email}`}
                />
              )}

              {/* Token issuance */}
              <TimelineStep
                icon="key"
                title="Token Issued"
                subtitle={`Agent: ${trace.agent_name}`}
                status="complete"
                details={`Agent ID: ${trace.agent_id}`}
              />

              {/* Delegation steps */}
              {trace.chain
                .filter((n) => n.type === "agent" && n.delegation_depth !== undefined && n.delegation_depth > 0)
                .map((node, i) => (
                  <TimelineStep
                    key={`delegation-${i}`}
                    icon="delegate"
                    title={`Delegated to ${node.name}`}
                    subtitle={`Scope: [${(node.scope ?? []).join(", ")}]`}
                    status="complete"
                    details={`Depth: ${node.delegation_depth}`}
                  />
                ))}

              {/* Tool call */}
              {trace.tool_name && (
                <TimelineStep
                  icon="tool"
                  title={`Tool Call: ${trace.tool_name}`}
                  subtitle={`Method: tools/call`}
                  status={trace.decision === "deny" ? "error" : "complete"}
                />
              )}

              {/* Decision */}
              {trace.decision && (
                <TimelineStep
                  icon="shield"
                  title={`Decision: ${trace.decision === "deny" ? "BLOCKED" : "ALLOWED"}`}
                  subtitle={trace.reason ?? ""}
                  status={trace.decision === "deny" ? "error" : "success"}
                  details={trace.policy_rule ? `Policy rule: ${trace.policy_rule}` : undefined}
                  isLast
                />
              )}
            </div>
          </CollapsibleSection>

          {/* Delegation Chain */}
          {trace.chain.length > 0 && (
            <CollapsibleSection
              title="Delegation Chain"
              id="chain"
              expanded={expandedSections.has("chain")}
              onToggle={() => toggleSection("chain")}
            >
              <div className="space-y-2">
                {trace.chain.map((node, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3"
                    style={{ paddingLeft: `${i * 24}px` }}
                  >
                    {i > 0 && (
                      <span className="text-text-muted text-xs mt-1 select-none">
                        {"\u2514\u2500"}
                      </span>
                    )}
                    <div className="bg-bg-secondary rounded-lg border border-border px-3 py-2 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                            node.type === "human"
                              ? "bg-accent/10 text-accent"
                              : "bg-status-pass/10 text-status-pass"
                          }`}
                        >
                          {node.type}
                        </span>
                        <span className="text-sm font-mono text-text-primary">
                          {node.email ?? node.name}
                        </span>
                        {node.status && node.status !== "active" && (
                          <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-status-fail/10 text-status-fail">
                            {node.status}
                          </span>
                        )}
                      </div>
                      {node.scope && (
                        <p className="text-text-muted text-xs font-mono mt-1">
                          Scope: [{node.scope.join(", ")}]
                        </p>
                      )}
                      {node.delegation_depth !== undefined && (
                        <p className="text-text-muted text-xs font-mono">
                          Depth: {node.delegation_depth}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Token Claims / Details */}
          {trace.details && Object.keys(trace.details).length > 0 && (
            <CollapsibleSection
              title="Event Details"
              id="details"
              expanded={expandedSections.has("details")}
              onToggle={() => toggleSection("details")}
            >
              <pre className="text-xs font-mono text-text-secondary bg-bg-secondary rounded-lg p-4 overflow-x-auto">
                {JSON.stringify(trace.details, null, 2)}
              </pre>
            </CollapsibleSection>
          )}

          {/* Audit Integrity */}
          {trace.audit_hash && (
            <CollapsibleSection
              title="Audit Chain Integrity"
              id="integrity"
              expanded={expandedSections.has("integrity")}
              onToggle={() => toggleSection("integrity")}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center gap-1.5 text-sm font-mono px-3 py-1.5 rounded-lg ${
                    trace.hash_verified
                      ? "bg-status-pass/10 text-status-pass border border-status-pass/20"
                      : "bg-status-fail/10 text-status-fail border border-status-fail/20"
                  }`}
                >
                  {trace.hash_verified ? "\u2713 Verified" : "\u2717 Failed"}
                </span>
                <span className="text-text-muted text-xs font-mono">
                  Hash: {trace.audit_hash}
                </span>
              </div>
            </CollapsibleSection>
          )}
        </div>
      )}

      {/* Recent Events Quick Access */}
      {!trace && !loading && (
        <div>
          <h3 className="text-sm font-display font-semibold text-text-secondary mb-3">
            Recent Audit Events
          </h3>
          <div className="bg-bg-card rounded-xl border border-border divide-y divide-border">
            {initialEntries.slice(0, 20).map((entry) => (
              <button
                key={entry.id}
                onClick={() => {
                  setSearchId(entry.id);
                  fetchTrace(entry.id);
                }}
                className="w-full text-left px-4 py-3 hover:bg-bg-hover transition-colors first:rounded-t-xl last:rounded-b-xl"
              >
                <div className="flex items-center gap-3">
                  <ActionBadge action={entry.action} />
                  <span className="text-xs font-mono text-text-muted flex-1 truncate">
                    {entry.id}
                  </span>
                  <span className="text-xs font-mono text-text-muted">
                    {entry.tool_name ?? "-"}
                  </span>
                  <span className="text-xs text-text-muted">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </button>
            ))}
            {initialEntries.length === 0 && (
              <div className="px-4 py-8 text-center text-text-muted text-sm">
                No audit events found. Events will appear here after agents make tool calls.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function InfoField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-0.5">
        {label}
      </p>
      <p
        className={`text-sm text-text-primary truncate ${mono ? "font-mono" : "font-display"}`}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function DecisionBadge({ decision, action }: { decision: string | null; action: string }) {
  const isDeny = decision === "deny" || action.includes("blocked");
  const isAllow = decision === "allow" || action.includes("allowed");

  if (isDeny) {
    return (
      <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-status-fail/10 text-status-fail border border-status-fail/20">
        BLOCKED
      </span>
    );
  }
  if (isAllow) {
    return (
      <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-status-pass/10 text-status-pass border border-status-pass/20">
        ALLOWED
      </span>
    );
  }
  return (
    <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-bg-secondary text-text-muted border border-border">
      {action}
    </span>
  );
}

function ActionBadge({ action }: { action: string }) {
  const colors: Record<string, string> = {
    tool_call_blocked: "bg-status-fail/10 text-status-fail",
    tool_call_allowed: "bg-status-pass/10 text-status-pass",
    issued: "bg-accent/10 text-accent",
    delegated: "bg-blue-500/10 text-blue-400",
    revoked: "bg-orange-500/10 text-orange-400",
  };

  const color = colors[action] ?? "bg-bg-secondary text-text-muted";
  const label = action.replace(/_/g, " ").replace("tool call ", "");

  return (
    <span className={`text-[0.6rem] font-mono px-2 py-0.5 rounded-md ${color} whitespace-nowrap`}>
      {label}
    </span>
  );
}

function CollapsibleSection({
  title,
  id,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  id: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg-card rounded-xl border border-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-bg-hover transition-colors"
      >
        <h3 className="text-sm font-display font-semibold text-text-primary">{title}</h3>
        <svg
          className={`w-4 h-4 text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}

function TimelineStep({
  icon,
  title,
  subtitle,
  status,
  details,
  isLast,
}: {
  icon: "person" | "key" | "delegate" | "tool" | "shield";
  title: string;
  subtitle: string;
  status: "complete" | "success" | "error";
  details?: string;
  isLast?: boolean;
}) {
  const statusColors = {
    complete: "bg-accent/20 text-accent border-accent/30",
    success: "bg-status-pass/20 text-status-pass border-status-pass/30",
    error: "bg-status-fail/20 text-status-fail border-status-fail/30",
  };

  const lineColor = status === "error" ? "bg-status-fail/30" : "bg-border";

  return (
    <div className="flex gap-3">
      {/* Vertical line and dot */}
      <div className="flex flex-col items-center">
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center border ${statusColors[status]}`}
        >
          <TimelineIcon icon={icon} />
        </div>
        {!isLast && <div className={`w-px flex-1 min-h-[20px] ${lineColor}`} />}
      </div>

      {/* Content */}
      <div className="pb-4 flex-1">
        <p className="text-sm font-display font-semibold text-text-primary">{title}</p>
        <p className="text-xs font-mono text-text-muted mt-0.5">{subtitle}</p>
        {details && (
          <p className="text-xs font-mono text-text-muted mt-0.5">{details}</p>
        )}
      </div>
    </div>
  );
}

function TimelineIcon({ icon }: { icon: string }) {
  switch (icon) {
    case "person":
      return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="8" r="4" />
          <path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
        </svg>
      );
    case "key":
      return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      );
    case "delegate":
      return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
        </svg>
      );
    case "tool":
      return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case "shield":
      return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2l8 4v6c0 5.5-3.8 10.7-8 12-4.2-1.3-8-6.5-8-12V6l8-4z" />
        </svg>
      );
    default:
      return null;
  }
}
