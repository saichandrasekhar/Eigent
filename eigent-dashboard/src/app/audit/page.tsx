import { fetchAuditLog, fetchAgents } from "@/lib/registry";
import { AuditPageView } from "./audit-view";

export default async function AuditPage() {
  const [auditResult, agentsResult] = await Promise.all([
    fetchAuditLog({ limit: 500 }),
    fetchAgents(""),
  ]);

  // Build agent name map
  const agentNameMap = new Map(agentsResult.agents.map((a) => [a.id, a.name]));

  // Enrich entries with agent names
  const enrichedEntries = auditResult.entries.map((e) => ({
    ...e,
    agent_name: agentNameMap.get(e.agent_id) ?? e.agent_id.slice(0, 12),
  }));

  // Stats
  const totalEntries = auditResult.total;
  const allowedCount = auditResult.entries.filter((e) => e.action === "tool_call_allowed").length;
  const blockedCount = auditResult.entries.filter((e) => e.action === "tool_call_blocked").length;
  const issuedCount = auditResult.entries.filter((e) => e.action === "issued" || e.action === "delegated").length;

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-display font-bold text-text-primary">Audit Log</h1>
        <p className="text-text-muted text-sm mt-1 font-display">
          Complete audit trail of agent registrations, delegations, and policy decisions
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Total Events</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{totalEntries}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-status-pass/20 p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Allowed</p>
          <p className="text-2xl font-bold font-mono text-status-pass">{allowedCount}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-status-fail/20 p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Blocked</p>
          <p className="text-2xl font-bold font-mono text-status-fail">{blockedCount}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-accent/20 p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Issued/Delegated</p>
          <p className="text-2xl font-bold font-mono text-accent">{issuedCount}</p>
        </div>
      </div>

      {/* Full audit log with filters and export */}
      <AuditPageView entries={enrichedEntries} />
    </div>
  );
}
