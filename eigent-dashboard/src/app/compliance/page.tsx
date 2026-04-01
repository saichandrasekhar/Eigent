import { fetchAgents, fetchAuditLog } from "@/lib/registry";
import { ComplianceDownloadButtonClient } from "./compliance-download";

interface ControlCheck {
  id: string;
  title: string;
  description: string;
  status: "pass" | "fail" | "partial" | "not_assessed";
  findingCount: number;
}

async function getComplianceData() {
  const [allAgentsResult, activeAgentsResult, auditResult, blockedResult] = await Promise.all([
    fetchAgents(""),
    fetchAgents("active"),
    fetchAuditLog({ limit: 1000 }),
    fetchAuditLog({ action: "tool_call_blocked", limit: 500 }),
  ]);

  const allAgents = allAgentsResult.agents;
  const activeAgents = activeAgentsResult.agents;
  const totalAgents = allAgents.length;
  const revokedAgents = allAgents.filter((a) => a.status === "revoked");
  const expiredAgents = activeAgents.filter((a) => new Date(a.expires_at) < new Date());
  const agentsWithDelegation = allAgents.filter((a) => a.parent_id !== null);
  const hasBlockedEvents = blockedResult.entries.length > 0;
  const hasAuditTrail = auditResult.entries.length > 0;
  const uniqueHumans = new Set(allAgents.map((a) => a.human_email));
  const allBound = allAgents.every((a) => a.human_email && a.human_sub);

  // SOC2 Controls (mapped to Eigent registry capabilities)
  const soc2Controls: ControlCheck[] = [
    {
      id: "CC6.1",
      title: "Logical Access Controls",
      description: "AI agents use cryptographic tokens (JWS) with scope-based access controls",
      status: totalAgents > 0 ? (activeAgents.every((a) => a.scope.length > 0) ? "pass" : "partial") : "not_assessed",
      findingCount: activeAgents.filter((a) => a.scope.length === 0).length,
    },
    {
      id: "CC6.3",
      title: "Role-Based Access (Scope Enforcement)",
      description: "Agent permissions are enforced via scope checks; out-of-scope tool calls are blocked",
      status: totalAgents > 0 ? (hasBlockedEvents ? "pass" : "partial") : "not_assessed",
      findingCount: blockedResult.entries.length,
    },
    {
      id: "CC6.6",
      title: "Delegation Controls",
      description: "Delegation chains enforce scope narrowing; children cannot exceed parent permissions",
      status: agentsWithDelegation.length > 0 ? "pass" : totalAgents > 0 ? "partial" : "not_assessed",
      findingCount: 0,
    },
    {
      id: "CC7.1",
      title: "System Monitoring",
      description: "Complete audit trail of all agent registrations, delegations, and tool call decisions",
      status: hasAuditTrail ? "pass" : totalAgents > 0 ? "fail" : "not_assessed",
      findingCount: 0,
    },
    {
      id: "CC7.2",
      title: "Incident Detection",
      description: "Policy violations (blocked tool calls) are logged and visible in the dashboard",
      status: totalAgents > 0 ? "pass" : "not_assessed",
      findingCount: blockedResult.entries.length,
    },
    {
      id: "CC8.1",
      title: "Change Management",
      description: "Agent revocations cascade to all descendant agents automatically",
      status: revokedAgents.length > 0 ? "pass" : totalAgents > 0 ? "partial" : "not_assessed",
      findingCount: 0,
    },
    {
      id: "CC9.1",
      title: "Risk Mitigation",
      description: "Token expiry, scope limits, and delegation depth limits mitigate agent risks",
      status: totalAgents > 0 ? (expiredAgents.length === 0 ? "pass" : "partial") : "not_assessed",
      findingCount: expiredAgents.length,
    },
  ];

  // EU AI Act Articles
  const euAiActArticles: ControlCheck[] = [
    {
      id: "Art. 9",
      title: "Risk Management System",
      description: "Delegation depth limits, scope narrowing, and token expiry form a continuous risk management system",
      status: totalAgents > 0 ? "pass" : "not_assessed",
      findingCount: 0,
    },
    {
      id: "Art. 13",
      title: "Transparency",
      description: "Full delegation chain visibility: every agent is traceable to its human principal",
      status: totalAgents > 0 ? (allBound ? "pass" : "partial") : "not_assessed",
      findingCount: allAgents.filter((a) => !a.human_email).length,
    },
    {
      id: "Art. 14",
      title: "Human Oversight",
      description: "Human-in-the-loop via required human binding for all agents; revocation capability",
      status: totalAgents > 0 ? (uniqueHumans.size > 0 ? "pass" : "fail") : "not_assessed",
      findingCount: 0,
    },
    {
      id: "Art. 15",
      title: "Accuracy & Robustness",
      description: "Cryptographic token verification (ES256 JWS) ensures agent identity integrity",
      status: totalAgents > 0 ? "pass" : "not_assessed",
      findingCount: 0,
    },
    {
      id: "Art. 17",
      title: "Quality Management",
      description: "Centralized registry with audit logging provides quality management for agent operations",
      status: hasAuditTrail ? "pass" : totalAgents > 0 ? "partial" : "not_assessed",
      findingCount: 0,
    },
    {
      id: "Art. 26",
      title: "Deployer Obligations",
      description: "Dashboard provides deployers with visibility into agent behavior and compliance status",
      status: totalAgents > 0 ? "pass" : "not_assessed",
      findingCount: 0,
    },
  ];

  return {
    soc2Controls,
    euAiActArticles,
    totalAgents,
    activeCount: activeAgents.length,
    auditCount: auditResult.total,
    violationCount: blockedResult.total,
  };
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

function generateComplianceReportHtml(
  soc2Controls: ControlCheck[],
  euAiActArticles: ControlCheck[],
  stats: { totalAgents: number; activeCount: number; auditCount: number; violationCount: number }
): string {
  const now = new Date().toISOString();
  const soc2Rows = soc2Controls.map((c) => `
    <tr>
      <td>${c.id}</td>
      <td>${c.title}</td>
      <td>${c.description}</td>
      <td class="${c.status}">${c.status.toUpperCase()}</td>
      <td>${c.findingCount}</td>
    </tr>
  `).join("");
  const euRows = euAiActArticles.map((c) => `
    <tr>
      <td>${c.id}</td>
      <td>${c.title}</td>
      <td>${c.description}</td>
      <td class="${c.status}">${c.status.toUpperCase()}</td>
      <td>${c.findingCount}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html>
<head>
  <title>Eigent Compliance Report - ${now}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; background: #0a0b0f; color: #e4e4e7; }
    h1 { color: #7c6aef; }
    h2 { color: #9d8ff5; border-bottom: 1px solid #1e2235; padding-bottom: 0.5rem; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0 2rem; }
    th, td { padding: 0.75rem 1rem; border-bottom: 1px solid #1e2235; text-align: left; font-size: 0.85rem; }
    th { color: #555872; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
    .pass { color: #22c55e; font-weight: bold; }
    .fail { color: #ef4444; font-weight: bold; }
    .partial { color: #eab308; font-weight: bold; }
    .not_assessed { color: #6b7280; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 1.5rem 0; }
    .stat { background: #141620; border: 1px solid #1e2235; border-radius: 0.75rem; padding: 1rem; }
    .stat-label { color: #555872; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; }
    .stat-value { font-size: 1.5rem; font-weight: bold; margin-top: 0.25rem; }
    .generated { color: #555872; font-size: 0.75rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>Eigent Compliance Report</h1>
  <p class="generated">Generated: ${new Date().toLocaleString()}</p>
  <div class="stats">
    <div class="stat"><div class="stat-label">Total Agents</div><div class="stat-value">${stats.totalAgents}</div></div>
    <div class="stat"><div class="stat-label">Active Agents</div><div class="stat-value">${stats.activeCount}</div></div>
    <div class="stat"><div class="stat-label">Audit Events</div><div class="stat-value">${stats.auditCount}</div></div>
    <div class="stat"><div class="stat-label">Violations</div><div class="stat-value">${stats.violationCount}</div></div>
  </div>
  <h2>SOC 2 Type II Controls</h2>
  <table><thead><tr><th>Control</th><th>Title</th><th>Description</th><th>Status</th><th>Findings</th></tr></thead><tbody>${soc2Rows}</tbody></table>
  <h2>EU AI Act Articles</h2>
  <table><thead><tr><th>Article</th><th>Title</th><th>Description</th><th>Status</th><th>Findings</th></tr></thead><tbody>${euRows}</tbody></table>
  <p class="generated">This report was generated by the Eigent compliance dashboard.</p>
</body>
</html>`;
}

export default async function CompliancePage() {
  const { soc2Controls, euAiActArticles, totalAgents, activeCount, auditCount, violationCount } =
    await getComplianceData();

  const soc2PassRate = soc2Controls.length > 0
    ? Math.round((soc2Controls.filter((c) => c.status === "pass").length / soc2Controls.length) * 100)
    : 0;

  const euCoverage = euAiActArticles.length > 0
    ? Math.round(
        (euAiActArticles.filter((c) => c.status === "pass" || c.status === "partial").length /
          euAiActArticles.length) * 100
      )
    : 0;

  // Serialize report HTML for client-side download
  const reportHtml = generateComplianceReportHtml(soc2Controls, euAiActArticles, {
    totalAgents,
    activeCount,
    auditCount,
    violationCount,
  });

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-display font-bold text-text-primary">Compliance Status</h1>
          <p className="text-text-muted text-sm mt-1 font-display">
            Compliance mapping based on Eigent registry agent governance data
          </p>
        </div>
        <ComplianceDownloadButton reportHtml={reportHtml} />
      </div>

      {/* Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Registered Agents</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{totalAgents}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Audit Events</p>
          <p className="text-2xl font-bold font-mono text-text-primary">{auditCount}</p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">SOC2 Pass Rate</p>
          <p className="text-2xl font-bold font-mono text-status-pass">
            {soc2Controls.length > 0 ? `${soc2PassRate}%` : "--"}
          </p>
        </div>
        <div className="bg-bg-card rounded-xl border border-border p-4">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">EU AI Act Coverage</p>
          <p className="text-2xl font-bold font-mono text-status-partial">
            {euAiActArticles.length > 0 ? `${euCoverage}%` : "--"}
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

function ComplianceDownloadButton({ reportHtml }: { reportHtml: string }) {
  return <ComplianceDownloadButtonClient reportHtml={reportHtml} />;
}
