import { fetchAgents } from "@/lib/registry";
import { DelegationExplorer } from "./delegation-explorer";

export default async function DelegationPage() {
  const allResult = await fetchAgents("");

  const agents = allResult.agents.map((a) => ({
    id: a.id,
    name: a.name,
    human_email: a.human_email,
    scope: a.scope,
    status: a.status,
    delegation_depth: a.delegation_depth,
    max_delegation_depth: a.max_delegation_depth,
    created_at: a.created_at,
    expires_at: a.expires_at,
    parent_id: a.parent_id,
    can_delegate: a.can_delegate,
  }));

  const rootAgents = agents.filter((a) => a.parent_id === null);
  const delegatedAgents = agents.filter((a) => a.parent_id !== null);
  const maxDepth = Math.max(0, ...agents.map((a) => a.delegation_depth));

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-display font-bold text-text-primary">Delegation Chains</h1>
        <p className="text-text-muted text-sm mt-1 font-display">
          Visual exploration of agent delegation hierarchies and permission narrowing
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Root Agents</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{rootAgents.length}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Delegated Agents</p>
          <p className="text-2xl font-bold font-mono text-accent">{delegatedAgents.length}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Max Chain Depth</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{maxDepth}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Total Agents</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{agents.length}</p>
        </div>
      </div>

      {/* Delegation Explorer (client component) */}
      <DelegationExplorer agents={agents} />
    </div>
  );
}
