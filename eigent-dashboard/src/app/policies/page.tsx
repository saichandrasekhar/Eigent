import { fetchAuditLog } from "@/lib/registry";

interface PolicyRule {
  id: string;
  name: string;
  description: string;
  match: string;
  action: "allow" | "block" | "log";
  priority: number;
  enabled: boolean;
}

// Built-in policy rules (these represent the policies enforced by the registry)
const BUILTIN_POLICIES: PolicyRule[] = [
  {
    id: "scope-enforcement",
    name: "Scope Enforcement",
    description: "Block tool calls that are not within the agent's granted scope",
    match: "tool_name NOT IN agent.scope",
    action: "block",
    priority: 1,
    enabled: true,
  },
  {
    id: "delegation-depth-limit",
    name: "Delegation Depth Limit",
    description: "Prevent delegation beyond the configured maximum depth",
    match: "delegation_depth >= max_delegation_depth",
    action: "block",
    priority: 2,
    enabled: true,
  },
  {
    id: "scope-narrowing",
    name: "Scope Narrowing",
    description: "Child agents can only receive scopes that the parent can delegate",
    match: "requested_scope NOT SUBSET OF parent.can_delegate",
    action: "block",
    priority: 3,
    enabled: true,
  },
  {
    id: "token-expiry",
    name: "Token Expiry Enforcement",
    description: "Block tool calls from agents with expired tokens",
    match: "agent.expires_at < NOW()",
    action: "block",
    priority: 4,
    enabled: true,
  },
  {
    id: "revocation-cascade",
    name: "Cascade Revocation",
    description: "When a parent agent is revoked, all descendant agents are automatically revoked",
    match: "parent.status == 'revoked'",
    action: "block",
    priority: 5,
    enabled: true,
  },
  {
    id: "child-ttl-bound",
    name: "Child TTL Bound",
    description: "Child agent tokens cannot expire later than their parent's token",
    match: "child.expires_at > parent.expires_at",
    action: "block",
    priority: 6,
    enabled: true,
  },
  {
    id: "human-binding",
    name: "Human Binding Requirement",
    description: "Every agent must be traceable to a human identity (human_sub, human_email)",
    match: "agent.human_sub IS NULL",
    action: "block",
    priority: 7,
    enabled: true,
  },
  {
    id: "audit-logging",
    name: "Full Audit Logging",
    description: "Log all tool call decisions (allowed and blocked) to the audit trail",
    match: "ALL tool_calls",
    action: "log",
    priority: 10,
    enabled: true,
  },
];

const actionStyles: Record<string, { bg: string; text: string }> = {
  allow: { bg: "bg-status-pass/10", text: "text-status-pass" },
  block: { bg: "bg-status-fail/10", text: "text-status-fail" },
  log: { bg: "bg-accent/10", text: "text-accent" },
};

export default async function PoliciesPage() {
  // Fetch violation history (blocked events)
  const violationResult = await fetchAuditLog({ action: "tool_call_blocked", limit: 50 });

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-display font-bold text-text-primary">Policies</h1>
          <p className="text-text-muted text-sm mt-1 font-display">
            Active policy rules enforced by the Eigent registry
          </p>
        </div>
        <button
          className="bg-bg-card border border-border rounded-lg px-4 py-2 text-xs font-display text-text-muted cursor-not-allowed flex items-center gap-2"
          title="Policy editing coming soon"
          disabled
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          Edit Policies
        </button>
      </div>

      {/* Policy summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Active Rules</p>
          <p className="text-2xl font-bold font-mono text-text-primary">
            {BUILTIN_POLICIES.filter((p) => p.enabled).length}
          </p>
        </div>
        <div className="bg-bg-card rounded-xl border border-status-fail/20 p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Recent Violations</p>
          <p className="text-2xl font-bold font-mono text-status-fail">{violationResult.total}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Enforcement Mode</p>
          <p className="text-lg font-bold font-mono text-status-pass">ENFORCE</p>
        </div>
      </div>

      {/* Policy Rules Table */}
      <div className="mb-8">
        <h2 className="font-display font-semibold text-sm text-text-primary mb-4">Policy Rules</h2>
        <div className="bg-bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Rule</th>
                  <th>Match Condition</th>
                  <th>Action</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {BUILTIN_POLICIES.map((policy) => {
                  const style = actionStyles[policy.action] ?? actionStyles.log;
                  return (
                    <tr key={policy.id}>
                      <td className="text-text-muted text-xs font-mono text-center">
                        P{policy.priority}
                      </td>
                      <td>
                        <div>
                          <p className="text-text-primary text-xs font-medium">{policy.name}</p>
                          <p className="text-text-muted text-[0.65rem] mt-0.5">{policy.description}</p>
                        </div>
                      </td>
                      <td className="font-mono text-[0.65rem] text-text-secondary max-w-[250px]">
                        <code className="bg-bg-hover px-2 py-0.5 rounded text-[0.6rem]">
                          {policy.match}
                        </code>
                      </td>
                      <td>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[0.65rem] font-mono ${style.bg} ${style.text}`}>
                          {policy.action.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[0.65rem] font-mono ${
                          policy.enabled
                            ? "bg-status-pass/10 text-status-pass"
                            : "bg-severity-info/10 text-severity-info"
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${policy.enabled ? "bg-status-pass" : "bg-severity-info"}`} />
                          {policy.enabled ? "ACTIVE" : "DISABLED"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Violation History */}
      <div>
        <h2 className="font-display font-semibold text-sm text-text-primary mb-4">
          Policy Violation History
          <span className="text-text-muted text-xs font-mono ml-2">({violationResult.total} total)</span>
        </h2>
        {violationResult.entries.length === 0 ? (
          <div className="bg-bg-card rounded-xl border border-border p-12 text-center">
            <p className="text-text-muted text-sm font-display">No policy violations recorded.</p>
          </div>
        ) : (
          <div className="bg-bg-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Agent</th>
                    <th>Human</th>
                    <th>Tool</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {violationResult.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="text-text-muted text-xs font-mono whitespace-nowrap">
                        {new Date(entry.timestamp).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="text-accent text-xs font-mono max-w-[120px] truncate">
                        {entry.agent_id.slice(0, 16)}...
                      </td>
                      <td className="text-text-secondary text-xs truncate max-w-[160px]">
                        {entry.human_email}
                      </td>
                      <td className="text-text-secondary text-xs font-mono">
                        {entry.tool_name ?? "--"}
                      </td>
                      <td className="text-severity-critical text-[0.65rem] font-mono max-w-[200px] truncate">
                        {entry.details
                          ? (entry.details as Record<string, unknown>).reason as string ?? "blocked"
                          : "blocked"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
