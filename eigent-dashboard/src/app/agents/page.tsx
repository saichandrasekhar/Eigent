import { prisma } from "@/lib/db";
import { AgentsTable } from "@/components/agents-table";

async function getAgents() {
  try {
    return await prisma.agent.findMany({
      orderBy: { lastSeen: "desc" },
    });
  } catch {
    return [];
  }
}

export default async function AgentsPage() {
  const agents = await getAgents();

  const formattedAgents = agents.map((a) => ({
    ...a,
    lastSeen: a.lastSeen.toISOString(),
    firstSeen: a.firstSeen.toISOString(),
  }));

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-display font-bold text-text-primary">Agent Inventory</h1>
        <p className="text-text-muted text-sm mt-1 font-display">
          All AI agents discovered across scans in your organization
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Total Agents</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{agents.length}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Unique Sources</p>
          <p className="text-2xl font-bold font-mono text-text-primary">
            {new Set(agents.map((a) => a.source)).size}
          </p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Unauthenticated</p>
          <p className="text-2xl font-bold font-mono text-severity-critical">
            {agents.filter((a) => a.authStatus === "none").length}
          </p>
        </div>
      </div>

      {/* Agents Table */}
      <AgentsTable agents={formattedAgents} />
    </div>
  );
}
