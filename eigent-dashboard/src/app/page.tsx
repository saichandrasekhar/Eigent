import { prisma } from "@/lib/db";
import { StatsCard } from "@/components/stats-card";
import { FindingsTable } from "@/components/findings-table";

async function getStats() {
  try {
    const [totalAgents, noAuth, criticalFindings, shadowAgents] = await Promise.all([
      prisma.agent.count(),
      prisma.agent.count({ where: { authStatus: "none" } }),
      prisma.finding.count({ where: { severity: "critical" } }),
      prisma.agent.count({ where: { source: "env_scan" } }),
    ]);
    return { totalAgents, noAuth, criticalFindings, shadowAgents };
  } catch {
    return { totalAgents: 0, noAuth: 0, criticalFindings: 0, shadowAgents: 0 };
  }
}

async function getRecentFindings() {
  try {
    return await prisma.finding.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  } catch {
    return [];
  }
}

async function getRiskTrend() {
  try {
    const scans = await prisma.scan.findMany({
      orderBy: { timestamp: "desc" },
      take: 10,
      include: {
        findings: {
          select: { severity: true },
        },
      },
    });

    return scans.reverse().map((scan) => ({
      scanId: scan.id,
      timestamp: scan.timestamp.toISOString(),
      totalFindings: scan.totalFindings,
      critical: scan.findings.filter((f) => f.severity === "critical").length,
      high: scan.findings.filter((f) => f.severity === "high").length,
      medium: scan.findings.filter((f) => f.severity === "medium").length,
      low: scan.findings.filter((f) => f.severity === "low").length,
    }));
  } catch {
    return [];
  }
}

function RiskTrendChart({ data }: { data: Awaited<ReturnType<typeof getRiskTrend>> }) {
  if (data.length === 0) {
    return (
      <div className="bg-bg-card rounded-xl border border-border p-8 text-center">
        <p className="text-text-muted text-sm">No scan data yet. Submit scans to see trends.</p>
      </div>
    );
  }

  const maxFindings = Math.max(...data.map((d) => d.totalFindings), 1);
  const width = 600;
  const height = 200;
  const padding = { top: 20, right: 20, bottom: 30, left: 40 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  function toX(i: number) {
    return padding.left + (i / Math.max(data.length - 1, 1)) * chartW;
  }
  function toY(val: number) {
    return padding.top + chartH - (val / maxFindings) * chartH;
  }

  const totalLine = data.map((d, i) => `${i === 0 ? "M" : "L"}${toX(i)},${toY(d.totalFindings)}`).join(" ");
  const criticalLine = data.map((d, i) => `${i === 0 ? "M" : "L"}${toX(i)},${toY(d.critical)}`).join(" ");

  // Area fill under total line
  const areaPath = totalLine + ` L${toX(data.length - 1)},${toY(0)} L${toX(0)},${toY(0)} Z`;

  return (
    <div className="bg-bg-card rounded-xl border border-border p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display font-semibold text-sm text-text-primary">Risk Trend</h3>
        <div className="flex items-center gap-4 text-[0.6rem] font-mono">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-accent rounded" /> Total
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-severity-critical rounded" /> Critical
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
          <g key={pct}>
            <line
              x1={padding.left}
              y1={toY(pct * maxFindings)}
              x2={width - padding.right}
              y2={toY(pct * maxFindings)}
              stroke="#1e2235"
              strokeWidth="1"
            />
            <text
              x={padding.left - 8}
              y={toY(pct * maxFindings) + 3}
              fill="#555872"
              fontSize="9"
              textAnchor="end"
              fontFamily="JetBrains Mono"
            >
              {Math.round(pct * maxFindings)}
            </text>
          </g>
        ))}

        {/* Area fill */}
        <path d={areaPath} fill="url(#areaGradient)" />
        <defs>
          <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c6aef" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#7c6aef" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Lines */}
        <path d={totalLine} fill="none" stroke="#7c6aef" strokeWidth="2" />
        <path d={criticalLine} fill="none" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="4 2" />

        {/* Data points */}
        {data.map((d, i) => (
          <g key={d.scanId}>
            <circle cx={toX(i)} cy={toY(d.totalFindings)} r="3" fill="#7c6aef" />
            <circle cx={toX(i)} cy={toY(d.critical)} r="2.5" fill="#ef4444" />
          </g>
        ))}

        {/* X-axis labels */}
        {data.map((d, i) => (
          <text
            key={d.scanId}
            x={toX(i)}
            y={height - 5}
            fill="#555872"
            fontSize="8"
            textAnchor="middle"
            fontFamily="JetBrains Mono"
          >
            {new Date(d.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </text>
        ))}
      </svg>
    </div>
  );
}

export default async function DashboardPage() {
  const [stats, findings, riskTrend] = await Promise.all([
    getStats(),
    getRecentFindings(),
    getRiskTrend(),
  ]);

  const formattedFindings = findings.map((f) => ({
    ...f,
    createdAt: f.createdAt.toISOString(),
  }));

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-display font-bold text-text-primary">Dashboard</h1>
        <p className="text-text-muted text-sm mt-1 font-display">
          Agent security posture across your organization
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatsCard
          label="Total Agents"
          value={stats.totalAgents}
          variant="accent"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="8" r="4" />
              <path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
            </svg>
          }
        />
        <StatsCard
          label="No Auth"
          value={stats.noAuth}
          variant="danger"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
              <line x1="1" y1="1" x2="23" y2="23" strokeWidth="1.5" />
            </svg>
          }
        />
        <StatsCard
          label="Critical Findings"
          value={stats.criticalFindings}
          variant="danger"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          }
        />
        <StatsCard
          label="Shadow Agents"
          value={stats.shadowAgents}
          variant="warning"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          }
        />
      </div>

      {/* Risk Trend */}
      <div className="mb-8">
        <RiskTrendChart data={riskTrend} />
      </div>

      {/* Recent Findings */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-semibold text-sm text-text-primary">Recent Findings</h2>
          <span className="text-text-muted text-xs font-mono">{findings.length} findings</span>
        </div>
        <FindingsTable findings={formattedFindings} />
      </div>
    </div>
  );
}
