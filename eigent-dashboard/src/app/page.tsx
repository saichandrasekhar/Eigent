import { StatsCard } from "@/components/stats-card";
import { fetchAgents, fetchAuditLog, checkHealth } from "@/lib/registry";
import { DelegationTree, buildTree } from "@/components/delegation-tree";
import { AuditLog } from "@/components/audit-log";

async function getDashboardData() {
  const [
    allAgentsResult,
    activeAgentsResult,
    auditResult,
    recentBlockedResult,
    registryHealthy,
  ] = await Promise.all([
    fetchAgents(""),
    fetchAgents("active"),
    fetchAuditLog({ limit: 20 }),
    fetchAuditLog({ action: "tool_call_blocked", limit: 100 }),
    checkHealth(),
  ]);

  const allAgents = allAgentsResult.agents;
  const activeAgents = activeAgentsResult.agents;

  // Compute stats
  const uniqueHumans = new Set(allAgents.map((a) => a.human_email));
  const delegationChains = allAgents.filter((a) => a.parent_id !== null);
  const expiredTokens = allAgents.filter(
    (a) => a.status === "active" && new Date(a.expires_at) < new Date()
  );
  const unboundAgents = allAgents.filter(
    (a) => a.status === "active" && !a.human_email
  );

  // Count violations in last 24h
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentViolations = recentBlockedResult.entries.filter(
    (e) => e.timestamp >= twentyFourHoursAgo
  ).length;

  return {
    stats: {
      activeAgents: activeAgents.length,
      delegationChains: delegationChains.length,
      policyViolations24h: recentViolations,
      humansWithAgents: uniqueHumans.size,
    },
    allAgents,
    activeAgents,
    auditEntries: auditResult.entries,
    risks: {
      unboundAgents: unboundAgents.length,
      expiredTokens: expiredTokens.length,
      staleAgents: 0,
    },
    registryHealthy,
  };
}

export default async function DashboardPage() {
  const {
    stats,
    allAgents,
    activeAgents,
    auditEntries,
    risks,
    registryHealthy,
  } = await getDashboardData();

  // Build tree from all agents
  const treeNodes = allAgents.map((a) => ({
    id: a.id,
    name: a.name,
    human_email: a.human_email,
    scope: a.scope,
    status: a.status,
    delegation_depth: a.delegation_depth,
    created_at: a.created_at,
    expires_at: a.expires_at,
    parent_id: a.parent_id,
  }));
  const tree = buildTree(treeNodes);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-display font-bold text-text-primary">Control Plane</h1>
          <p className="text-text-muted text-sm mt-1 font-display">
            Agent identities, delegation chains, and policy decisions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono border ${
            registryHealthy
              ? "border-status-pass/30 text-status-pass bg-status-pass/5"
              : "border-status-fail/30 text-status-fail bg-status-fail/5"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${registryHealthy ? "bg-status-pass" : "bg-status-fail"}`} />
            Registry {registryHealthy ? "Connected" : "Offline"}
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatsCard
          label="Active Agents"
          value={stats.activeAgents}
          variant="accent"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="8" r="4" />
              <path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
            </svg>
          }
        />
        <StatsCard
          label="Delegation Chains"
          value={stats.delegationChains}
          variant="accent"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          }
        />
        <StatsCard
          label="Policy Violations (24h)"
          value={stats.policyViolations24h}
          variant={stats.policyViolations24h > 0 ? "danger" : "default"}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          }
        />
        <StatsCard
          label="Humans with Agents"
          value={stats.humansWithAgents}
          variant="default"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 00-3-3.87" />
              <path d="M16 3.13a4 4 0 010 7.75" />
            </svg>
          }
        />
      </div>

      {/* Risk Indicators */}
      {(risks.expiredTokens > 0 || risks.unboundAgents > 0) && (
        <div className="mb-8 bg-severity-critical/5 border border-severity-critical/20 rounded-xl p-4">
          <h3 className="font-display font-semibold text-sm text-severity-critical mb-2 flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Risk Indicators
          </h3>
          <div className="flex flex-wrap gap-4 text-xs font-mono">
            {risks.expiredTokens > 0 && (
              <span className="text-severity-high">
                {risks.expiredTokens} expired token{risks.expiredTokens !== 1 ? "s" : ""} still marked active
              </span>
            )}
            {risks.unboundAgents > 0 && (
              <span className="text-severity-critical">
                {risks.unboundAgents} agent{risks.unboundAgents !== 1 ? "s" : ""} without human binding
              </span>
            )}
          </div>
        </div>
      )}

      {/* Two-column layout: Delegation Tree + Audit */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Delegation Chains */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display font-semibold text-sm text-text-primary">Active Delegation Chains</h2>
            <a href="/delegation" className="text-accent text-xs font-display hover:text-accent-light transition-colors">
              View All
            </a>
          </div>
          <DelegationTree agents={tree.slice(0, 5)} compact />
        </div>

        {/* Recent Audit Events */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display font-semibold text-sm text-text-primary">Recent Audit Events</h2>
            <a href="/audit" className="text-accent text-xs font-display hover:text-accent-light transition-colors">
              View All
            </a>
          </div>
          <AuditLog entries={auditEntries} showFilters={false} compact />
        </div>
      </div>
    </div>
  );
}
