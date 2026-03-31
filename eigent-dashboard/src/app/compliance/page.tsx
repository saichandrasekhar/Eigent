import { prisma } from "@/lib/db";

interface ControlCheck {
  id: string;
  title: string;
  description: string;
  status: "pass" | "fail" | "partial" | "not_assessed";
  findingCount: number;
}

async function getComplianceData() {
  try {
    const findings = await prisma.finding.findMany({
      select: { severity: true, category: true, title: true },
    });

    const agents = await prisma.agent.findMany({
      select: { authStatus: true, transport: true },
    });

    const hasNoAuth = agents.some((a) => a.authStatus === "none");
    const hasCritical = findings.some((f) => f.severity === "critical");
    const hasHigh = findings.some((f) => f.severity === "high");
    const noAuthCount = agents.filter((a) => a.authStatus === "none").length;
    const totalAgents = agents.length;

    // SOC2 Controls
    const soc2Controls: ControlCheck[] = [
      {
        id: "CC6.1",
        title: "Logical Access Controls",
        description: "AI agents must use authenticated connections and proper access controls",
        status: hasNoAuth ? "fail" : totalAgents > 0 ? "pass" : "not_assessed",
        findingCount: noAuthCount,
      },
      {
        id: "CC6.3",
        title: "Role-Based Access",
        description: "Agent permissions should follow least-privilege principle",
        status: findings.some((f) => f.title.toLowerCase().includes("permission"))
          ? "fail"
          : totalAgents > 0
          ? "pass"
          : "not_assessed",
        findingCount: findings.filter((f) => f.title.toLowerCase().includes("permission")).length,
      },
      {
        id: "CC7.1",
        title: "System Monitoring",
        description: "Agent activity must be monitored and logged",
        status: totalAgents > 0 ? "partial" : "not_assessed",
        findingCount: 0,
      },
      {
        id: "CC7.2",
        title: "Incident Detection",
        description: "Anomalous agent behavior should trigger alerts",
        status: totalAgents > 0 ? "partial" : "not_assessed",
        findingCount: 0,
      },
      {
        id: "CC8.1",
        title: "Change Management",
        description: "Agent configurations should be version controlled and reviewed",
        status: findings.some((f) => f.title.toLowerCase().includes("shadow"))
          ? "fail"
          : totalAgents > 0
          ? "pass"
          : "not_assessed",
        findingCount: findings.filter((f) => f.title.toLowerCase().includes("shadow")).length,
      },
      {
        id: "CC9.1",
        title: "Risk Mitigation",
        description: "Critical and high severity findings must be addressed",
        status: hasCritical ? "fail" : hasHigh ? "partial" : totalAgents > 0 ? "pass" : "not_assessed",
        findingCount: findings.filter((f) => f.severity === "critical" || f.severity === "high").length,
      },
    ];

    // EU AI Act Articles
    const euAiActArticles: ControlCheck[] = [
      {
        id: "Art. 9",
        title: "Risk Management System",
        description: "AI systems must have a risk management system throughout their lifecycle",
        status: totalAgents > 0 ? (hasCritical ? "fail" : "partial") : "not_assessed",
        findingCount: findings.filter((f) => f.severity === "critical").length,
      },
      {
        id: "Art. 13",
        title: "Transparency",
        description: "AI systems must be designed to allow human oversight and understanding",
        status: totalAgents > 0 ? "partial" : "not_assessed",
        findingCount: 0,
      },
      {
        id: "Art. 14",
        title: "Human Oversight",
        description: "AI systems must allow effective human oversight during operation",
        status: totalAgents > 0 ? "partial" : "not_assessed",
        findingCount: 0,
      },
      {
        id: "Art. 15",
        title: "Accuracy & Robustness",
        description: "AI systems must achieve appropriate levels of accuracy and cybersecurity",
        status: hasNoAuth ? "fail" : totalAgents > 0 ? "partial" : "not_assessed",
        findingCount: noAuthCount,
      },
      {
        id: "Art. 17",
        title: "Quality Management",
        description: "Providers must establish a quality management system",
        status: totalAgents > 0 ? "partial" : "not_assessed",
        findingCount: 0,
      },
    ];

    return { soc2Controls, euAiActArticles, totalFindings: findings.length, totalAgents };
  } catch {
    return {
      soc2Controls: [] as ControlCheck[],
      euAiActArticles: [] as ControlCheck[],
      totalFindings: 0,
      totalAgents: 0,
    };
  }
}

const statusStyles = {
  pass: { bg: "bg-status-pass/10", text: "text-status-pass", label: "PASS" },
  fail: { bg: "bg-status-fail/10", text: "text-status-fail", label: "FAIL" },
  partial: { bg: "bg-status-partial/10", text: "text-status-partial", label: "PARTIAL" },
  not_assessed: { bg: "bg-severity-info/10", text: "text-severity-info", label: "N/A" },
};

function StatusBadge({ status }: { status: ControlCheck["status"] }) {
  const style = statusStyles[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[0.65rem] font-mono ${style.bg} ${style.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.text === "text-status-pass" ? "bg-status-pass" : style.text === "text-status-fail" ? "bg-status-fail" : style.text === "text-status-partial" ? "bg-status-partial" : "bg-severity-info"}`} />
      {style.label}
    </span>
  );
}

function ControlsSection({ title, controls }: { title: string; controls: ControlCheck[] }) {
  const passCount = controls.filter((c) => c.status === "pass").length;
  const failCount = controls.filter((c) => c.status === "fail").length;

  return (
    <div className="bg-bg-card rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <h3 className="font-display font-semibold text-sm text-text-primary">{title}</h3>
        <div className="flex items-center gap-3 text-[0.6rem] font-mono">
          <span className="text-status-pass">{passCount} passed</span>
          <span className="text-status-fail">{failCount} failed</span>
          <span className="text-text-muted">{controls.length} total</span>
        </div>
      </div>
      <div className="divide-y divide-border">
        {controls.map((control) => (
          <div key={control.id} className="px-5 py-3 flex items-center gap-4 hover:bg-bg-hover transition-colors">
            <span className="text-accent font-mono text-xs w-16 shrink-0">{control.id}</span>
            <div className="flex-1 min-w-0">
              <p className="text-text-primary text-xs font-medium">{control.title}</p>
              <p className="text-text-muted text-[0.65rem] mt-0.5 truncate">{control.description}</p>
            </div>
            {control.findingCount > 0 && (
              <span className="text-severity-critical text-[0.6rem] font-mono shrink-0">
                {control.findingCount} finding{control.findingCount !== 1 ? "s" : ""}
              </span>
            )}
            <StatusBadge status={control.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function CompliancePage() {
  const { soc2Controls, euAiActArticles, totalFindings, totalAgents } = await getComplianceData();

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-display font-bold text-text-primary">Compliance Status</h1>
          <p className="text-text-muted text-sm mt-1 font-display">
            Automated compliance mapping based on agent scan findings
          </p>
        </div>
        <button
          className="bg-bg-card border border-border rounded-lg px-4 py-2 text-xs font-display text-text-secondary hover:text-text-primary hover:border-border-light transition-colors flex items-center gap-2"
          title="Export compliance report (coming soon)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export Report
        </button>
      </div>

      {/* Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Agents Scanned</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{totalAgents}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Total Findings</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{totalFindings}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">SOC2 Pass Rate</p>
          <p className="text-2xl font-bold font-mono text-status-pass">
            {soc2Controls.length > 0
              ? `${Math.round((soc2Controls.filter((c) => c.status === "pass").length / soc2Controls.length) * 100)}%`
              : "--"}
          </p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">EU AI Act Coverage</p>
          <p className="text-2xl font-bold font-mono text-status-partial">
            {euAiActArticles.length > 0
              ? `${Math.round(
                  (euAiActArticles.filter((c) => c.status === "pass" || c.status === "partial").length /
                    euAiActArticles.length) *
                    100
                )}%`
              : "--"}
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="space-y-6">
        <ControlsSection title="SOC 2 Type II Controls" controls={soc2Controls} />
        <ControlsSection title="EU AI Act Articles" controls={euAiActArticles} />
      </div>
    </div>
  );
}
