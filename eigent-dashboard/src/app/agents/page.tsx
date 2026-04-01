import { fetchAgents, fetchAuditLog } from "@/lib/registry";
import { RegistryAgentsView } from "./agents-view";

export default async function AgentsPage() {
  const [allResult, activeResult] = await Promise.all([
    fetchAgents(""),
    fetchAgents("active"),
  ]);

  // Get agent names for audit entries
  const agentMap = new Map(allResult.agents.map((a) => [a.id, a.name]));

  // Fetch recent audit for each agent (batch approach: fetch all recent audit)
  const auditResult = await fetchAuditLog({ limit: 200 });
  const auditByAgent = new Map<string, typeof auditResult.entries>();
  for (const entry of auditResult.entries) {
    const list = auditByAgent.get(entry.agent_id) ?? [];
    list.push(entry);
    auditByAgent.set(entry.agent_id, list);
  }

  const agents = allResult.agents.map((a) => ({
    ...a,
    recentAudit: (auditByAgent.get(a.id) ?? []).slice(0, 10).map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      action: e.action,
      tool_name: e.tool_name,
    })),
  }));

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-display font-bold text-text-primary">Agent Registry</h1>
        <p className="text-text-muted text-sm mt-1 font-display">
          All registered agent identities with delegation chains and token details
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Total Agents</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{allResult.total}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Active</p>
          <p className="text-2xl font-bold font-mono text-status-pass">{activeResult.total}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Unique Humans</p>
          <p className="text-2xl font-bold font-mono text-text-primary">
            {new Set(allResult.agents.map((a) => a.human_email)).size}
          </p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Revoked</p>
          <p className="text-2xl font-bold font-mono text-severity-critical">
            {allResult.agents.filter((a) => a.status === "revoked").length}
          </p>
        </div>
      </div>

      {/* Client-side interactive table */}
      <RegistryAgentsView agents={agents} />
    </div>
  );
}
