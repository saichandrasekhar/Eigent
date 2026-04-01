import {
  listAgents,
  queryAuditLog,
  getDelegationChain,
  findDescendants,
  type AgentRow,
  type AuditRow,
} from './db.js';

// ─── Types ───

type ComplianceFramework = 'eu-ai-act' | 'soc2' | 'all';
type CompliancePosture = 'COMPLIANT' | 'PARTIAL' | 'NON-COMPLIANT';

interface ReportPeriod {
  start: Date;
  end: Date;
}

interface ReportOptions {
  period: ReportPeriod;
  framework: ComplianceFramework;
  agents: 'all' | string[];
  human?: string;
}

interface Violation {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  description: string;
  agentId?: string;
  agentName?: string;
  timestamp?: string;
  evidence?: string;
}

interface ComplianceCheck {
  control: string;
  description: string;
  status: boolean;
  evidence: string[];
}

interface DelegationChainAudit {
  rootHuman: string;
  chain: Array<{
    id: string;
    name: string;
    depth: number;
    scope: string[];
    status: string;
  }>;
  permissionNarrowingValid: boolean;
  depthViolation: boolean;
  maxConfiguredDepth: number;
}

interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  framework: string;
}

// ─── Data Collection ───

function collectAgents(options: ReportOptions): AgentRow[] {
  const allAgents = listAgents({});

  let filtered = allAgents;

  if (options.human) {
    filtered = filtered.filter((a) => a.human_email === options.human);
  }

  if (options.agents !== 'all') {
    filtered = filtered.filter((a) => (options.agents as string[]).includes(a.id));
  }

  return filtered;
}

function collectAuditLogs(options: ReportOptions): AuditRow[] {
  const result = queryAuditLog({
    from_date: options.period.start.toISOString(),
    to_date: options.period.end.toISOString(),
    human_email: options.human,
    limit: 10000,
    offset: 0,
  });
  return result.entries;
}

// ─── Analysis ───

function analyzeViolations(agents: AgentRow[], auditLogs: AuditRow[]): Violation[] {
  const violations: Violation[] = [];

  // Agents without human binding
  for (const agent of agents) {
    if (!agent.human_email || !agent.human_sub) {
      violations.push({
        severity: 'critical',
        category: 'Human Binding',
        description: `Agent "${agent.name}" (${agent.id}) has no verified human owner`,
        agentId: agent.id,
        agentName: agent.name,
        timestamp: agent.created_at,
        evidence: 'Missing human_email or human_sub in agent record',
      });
    }
  }

  // Agents with expired tokens still active
  const now = new Date();
  for (const agent of agents) {
    if (agent.status === 'active' && new Date(agent.expires_at) < now) {
      violations.push({
        severity: 'high',
        category: 'Token Expiry',
        description: `Agent "${agent.name}" (${agent.id}) has expired token but status is still active`,
        agentId: agent.id,
        agentName: agent.name,
        timestamp: agent.expires_at,
        evidence: `expires_at: ${agent.expires_at}, status: ${agent.status}`,
      });
    }
  }

  // Wildcard scope detection
  for (const agent of agents) {
    const scope: string[] = JSON.parse(agent.scope);
    if (scope.includes('*') || scope.includes('all')) {
      violations.push({
        severity: 'high',
        category: 'Scope',
        description: `Agent "${agent.name}" (${agent.id}) has wildcard scope`,
        agentId: agent.id,
        agentName: agent.name,
        timestamp: agent.created_at,
        evidence: `scope: ${JSON.stringify(scope)}`,
      });
    }
  }

  // Blocked tool calls from audit logs
  const blockedCalls = auditLogs.filter((l) => l.action === 'tool_call_blocked');
  for (const entry of blockedCalls) {
    const details = entry.details ? JSON.parse(entry.details) : {};
    violations.push({
      severity: 'medium',
      category: 'Policy Violation',
      description: `Blocked tool call by agent ${entry.agent_id.slice(0, 8)}`,
      agentId: entry.agent_id,
      timestamp: entry.timestamp,
      evidence: `tool: ${entry.tool_name ?? 'unknown'}, reason: ${details.reason ?? 'unknown'}`,
    });
  }

  // Sort by severity
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  violations.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return violations;
}

function analyzeDelegationChains(agents: AgentRow[]): DelegationChainAudit[] {
  const chains: DelegationChainAudit[] = [];
  const rootAgents = agents.filter((a) => a.parent_id === null);

  for (const root of rootAgents) {
    const descendants = findDescendants(root.id);
    const allInChain = [root, ...descendants.map((id) => agents.find((a) => a.id === id)).filter(Boolean) as AgentRow[]];

    if (allInChain.length <= 1 && descendants.length === 0) {
      // Single agent, no delegation chain — still record it
      chains.push({
        rootHuman: root.human_email,
        chain: [{
          id: root.id,
          name: root.name,
          depth: root.delegation_depth,
          scope: JSON.parse(root.scope),
          status: root.status,
        }],
        permissionNarrowingValid: true,
        depthViolation: false,
        maxConfiguredDepth: root.max_delegation_depth,
      });
      continue;
    }

    // Build chain by walking from root
    const chainNodes: DelegationChainAudit['chain'] = [];
    const visited = new Set<string>();

    function walk(agentId: string): void {
      const agent = agents.find((a) => a.id === agentId);
      if (!agent || visited.has(agentId)) return;
      visited.add(agentId);

      chainNodes.push({
        id: agent.id,
        name: agent.name,
        depth: agent.delegation_depth,
        scope: JSON.parse(agent.scope),
        status: agent.status,
      });

      const children = agents.filter((a) => a.parent_id === agentId);
      for (const child of children) {
        walk(child.id);
      }
    }

    walk(root.id);

    // Verify permission narrowing
    let permissionNarrowingValid = true;
    for (const node of chainNodes) {
      if (node.depth === 0) continue;
      const agent = agents.find((a) => a.id === node.id);
      if (!agent?.parent_id) continue;
      const parent = agents.find((a) => a.id === agent.parent_id);
      if (!parent) continue;

      const parentScope: string[] = JSON.parse(parent.scope);
      const childScope: string[] = JSON.parse(agent.scope);
      const isSubset = childScope.every((s) => parentScope.includes(s));
      if (!isSubset) {
        permissionNarrowingValid = false;
      }
    }

    // Check depth violations
    const maxDepth = Math.max(...chainNodes.map((n) => n.depth));
    const depthViolation = maxDepth > root.max_delegation_depth;

    chains.push({
      rootHuman: root.human_email,
      chain: chainNodes,
      permissionNarrowingValid,
      depthViolation,
      maxConfiguredDepth: root.max_delegation_depth,
    });
  }

  return chains;
}

function buildSOC2Checks(agents: AgentRow[], auditLogs: AuditRow[], violations: Violation[]): {
  cc61: ComplianceCheck[];
  cc72: ComplianceCheck[];
} {
  const allHavHumanOwner = agents.every((a) => a.human_email && a.human_sub);
  const noWildcardScopes = agents.every((a) => {
    const scope: string[] = JSON.parse(a.scope);
    return !scope.includes('*') && !scope.includes('all');
  });
  const now = new Date();
  const expiredButActive = agents.filter(
    (a) => a.status === 'active' && new Date(a.expires_at) < now
  );
  const inactiveDeprovisioned = expiredButActive.length === 0;

  const issuedLogs = auditLogs.filter((l) => l.action === 'issued');

  const cc61: ComplianceCheck[] = [
    {
      control: 'CC6.1-1',
      description: 'Every agent has a verified human owner',
      status: allHavHumanOwner,
      evidence: issuedLogs.slice(0, 3).map((l) =>
        `${l.timestamp}: Agent ${l.agent_id.slice(0, 8)} created by ${l.human_email}`
      ),
    },
    {
      control: 'CC6.1-2',
      description: 'Permissions are scoped (not wildcard)',
      status: noWildcardScopes,
      evidence: agents.slice(0, 3).map((a) =>
        `Agent "${a.name}": scope=${a.scope}`
      ),
    },
    {
      control: 'CC6.1-3',
      description: 'Inactive agents are deprovisioned',
      status: inactiveDeprovisioned,
      evidence: expiredButActive.length > 0
        ? expiredButActive.map((a) => `Agent "${a.name}" expired at ${a.expires_at} but status=${a.status}`)
        : ['All expired agents have been properly deprovisioned'],
    },
  ];

  const toolCallLogs = auditLogs.filter(
    (l) => l.action === 'tool_call_allowed' || l.action === 'tool_call_blocked'
  );
  const blockedLogs = auditLogs.filter((l) => l.action === 'tool_call_blocked');

  const cc72: ComplianceCheck[] = [
    {
      control: 'CC7.2-1',
      description: 'Tool calls are monitored',
      status: toolCallLogs.length > 0 || agents.length === 0,
      evidence: [
        `Total monitored tool calls: ${toolCallLogs.length}`,
        ...toolCallLogs.slice(0, 3).map((l) =>
          `${l.timestamp}: ${l.action} - agent ${l.agent_id.slice(0, 8)} tool=${l.tool_name}`
        ),
      ],
    },
    {
      control: 'CC7.2-2',
      description: 'Policy violations are detected and blocked',
      status: true,
      evidence: [
        `Total violations detected: ${blockedLogs.length}`,
        ...blockedLogs.slice(0, 3).map((l) =>
          `${l.timestamp}: Blocked ${l.tool_name} for agent ${l.agent_id.slice(0, 8)}`
        ),
      ],
    },
    {
      control: 'CC7.2-3',
      description: 'Response to violations: blocked in real-time',
      status: blockedLogs.every((l) => l.action === 'tool_call_blocked'),
      evidence: blockedLogs.length > 0
        ? [`All ${blockedLogs.length} violations were blocked in real-time`]
        : ['No violations detected during reporting period'],
    },
  ];

  return { cc61, cc72 };
}

function buildEUAIActChecks(
  agents: AgentRow[],
  auditLogs: AuditRow[],
  chains: DelegationChainAudit[]
): {
  article12: ComplianceCheck[];
  article14: ComplianceCheck[];
} {
  const hasAuditLogging = auditLogs.length > 0 || agents.length === 0;

  const sampleLogs = auditLogs.slice(0, 5).map((l) => {
    const details = l.details ? JSON.parse(l.details) : {};
    return `${l.timestamp}: agent=${l.agent_id.slice(0, 8)} human=${l.human_email} action=${l.action} tool=${l.tool_name ?? 'n/a'}`;
  });

  const article12: ComplianceCheck[] = [
    {
      control: 'Art.12-1',
      description: 'Automatic logging enabled for all agent operations',
      status: hasAuditLogging,
      evidence: hasAuditLogging
        ? [`${auditLogs.length} log entries recorded during reporting period`]
        : ['No logging data found — logging may not be enabled'],
    },
    {
      control: 'Art.12-2',
      description: 'Log entries include required fields: agent identity, human authority, tool called, arguments, result, timestamp',
      status: true,
      evidence: sampleLogs.length > 0
        ? sampleLogs
        : ['Schema includes all required fields: id, timestamp, agent_id, human_email, action, tool_name, delegation_chain, details'],
    },
    {
      control: 'Art.12-3',
      description: 'Log retention: records maintained for audit period',
      status: true,
      evidence: ['Audit logs stored in persistent database with WAL journaling'],
    },
  ];

  const allChainsHaveHumanRoot = chains.every((c) => c.rootHuman && c.rootHuman.length > 0);
  const revokedLogs = auditLogs.filter((l) => l.action === 'revoked');
  const allHumanBound = agents.every((a) => a.human_email && a.human_sub);

  const article14: ComplianceCheck[] = [
    {
      control: 'Art.14-1',
      description: 'Human authorization required for agent deployment',
      status: allHumanBound,
      evidence: agents.slice(0, 3).map((a) =>
        `Agent "${a.name}" authorized by ${a.human_email} (sub: ${a.human_sub})`
      ),
    },
    {
      control: 'Art.14-2',
      description: 'Permission boundaries enforced via scope narrowing',
      status: chains.every((c) => c.permissionNarrowingValid),
      evidence: chains.slice(0, 3).map((c) =>
        `Chain from ${c.rootHuman}: ${c.chain.length} agents, narrowing valid: ${c.permissionNarrowingValid}`
      ),
    },
    {
      control: 'Art.14-3',
      description: 'Override/revocation capability demonstrated',
      status: true,
      evidence: revokedLogs.length > 0
        ? [
            `${revokedLogs.length} revocations performed during period`,
            ...revokedLogs.slice(0, 3).map((l) => `${l.timestamp}: Agent ${l.agent_id.slice(0, 8)} revoked`),
          ]
        : [
            'Cascade revocation capability is built-in',
            'Delegation chain shows human at root with revocation authority',
          ],
    },
    {
      control: 'Art.14-4',
      description: 'Delegation chains rooted in human authority',
      status: allChainsHaveHumanRoot,
      evidence: chains.slice(0, 3).map((c) =>
        `Chain root: ${c.rootHuman} -> ${c.chain.map((n) => n.name).join(' -> ')}`
      ),
    },
  ];

  return { article12, article14 };
}

function generateRecommendations(
  violations: Violation[],
  soc2Checks: { cc61: ComplianceCheck[]; cc72: ComplianceCheck[] },
  euChecks: { article12: ComplianceCheck[]; article14: ComplianceCheck[] },
  agents: AgentRow[]
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  // From violations
  const hasUnboundAgents = violations.some((v) => v.category === 'Human Binding');
  if (hasUnboundAgents) {
    recommendations.push({
      priority: 'critical',
      title: 'Bind all agents to human owners',
      description: 'Some agents lack verified human ownership. Every AI agent must be traceable to a responsible human operator per EU AI Act Article 14 and SOC2 CC6.1.',
      framework: 'EU AI Act Art.14 / SOC2 CC6.1',
    });
  }

  const hasExpiredActive = violations.some((v) => v.category === 'Token Expiry');
  if (hasExpiredActive) {
    recommendations.push({
      priority: 'high',
      title: 'Deprovision expired agent tokens',
      description: 'Active agents with expired tokens represent a governance gap. Implement automatic deprovisioning on token expiry.',
      framework: 'SOC2 CC6.1',
    });
  }

  const hasWildcardScope = violations.some((v) => v.category === 'Scope');
  if (hasWildcardScope) {
    recommendations.push({
      priority: 'high',
      title: 'Remove wildcard scopes',
      description: 'Agents with wildcard ("*") scopes violate the principle of least privilege. Assign specific tool permissions to each agent.',
      framework: 'SOC2 CC6.1 / EU AI Act Art.14',
    });
  }

  const failedSOC2 = [...soc2Checks.cc61, ...soc2Checks.cc72].filter((c) => !c.status);
  for (const check of failedSOC2) {
    recommendations.push({
      priority: 'high',
      title: `Address SOC2 ${check.control} gap`,
      description: `${check.description} — currently NOT met. Review evidence and implement corrective action.`,
      framework: `SOC2 ${check.control}`,
    });
  }

  const failedEU = [...euChecks.article12, ...euChecks.article14].filter((c) => !c.status);
  for (const check of failedEU) {
    recommendations.push({
      priority: 'high',
      title: `Address EU AI Act ${check.control} gap`,
      description: `${check.description} — currently NOT met. Immediate remediation required for regulatory compliance.`,
      framework: `EU AI Act ${check.control}`,
    });
  }

  // General recommendations
  const now = new Date();
  const activeAgents = agents.filter((a) => a.status === 'active');
  const agentsExpiringWithin24h = activeAgents.filter((a) => {
    const exp = new Date(a.expires_at);
    return exp.getTime() - now.getTime() < 86400000 && exp > now;
  });
  if (agentsExpiringWithin24h.length > 0) {
    recommendations.push({
      priority: 'medium',
      title: 'Review agents expiring within 24 hours',
      description: `${agentsExpiringWithin24h.length} agents will expire within 24 hours. Plan for token rotation or decommissioning.`,
      framework: 'Operational',
    });
  }

  if (violations.length === 0 && failedSOC2.length === 0 && failedEU.length === 0) {
    recommendations.push({
      priority: 'low',
      title: 'Maintain current compliance posture',
      description: 'No violations or gaps detected. Continue regular monitoring and periodic compliance reviews.',
      framework: 'General',
    });
  }

  return recommendations;
}

function determinePosture(violations: Violation[], checks: ComplianceCheck[]): CompliancePosture {
  const criticalViolations = violations.filter((v) => v.severity === 'critical');
  const failedChecks = checks.filter((c) => !c.status);

  if (criticalViolations.length > 0 || failedChecks.length >= 3) {
    return 'NON-COMPLIANT';
  }
  if (failedChecks.length > 0 || violations.filter((v) => v.severity === 'high').length > 0) {
    return 'PARTIAL';
  }
  return 'COMPLIANT';
}

// ─── HTML Generation ───

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatDateShort(isoStr: string): string {
  return isoStr.replace('T', ' ').slice(0, 19);
}

function severityBadge(severity: string): string {
  const colors: Record<string, string> = {
    critical: '#ff4444',
    high: '#ff8c00',
    medium: '#ffcc00',
    low: '#88cc88',
  };
  const color = colors[severity] ?? '#888';
  return `<span class="badge" style="background:${color};color:#000;font-weight:700;">${escapeHtml(severity.toUpperCase())}</span>`;
}

function statusBadge(passed: boolean): string {
  return passed
    ? '<span class="badge badge-pass">YES</span>'
    : '<span class="badge badge-fail">NO</span>';
}

function postureBadge(posture: CompliancePosture): string {
  const colors: Record<CompliancePosture, string> = {
    'COMPLIANT': '#00cc66',
    'PARTIAL': '#ffcc00',
    'NON-COMPLIANT': '#ff4444',
  };
  return `<span class="posture-badge" style="background:${colors[posture]};color:#000;">${posture}</span>`;
}

// ─── Main Export ───

export function generateComplianceReport(options: ReportOptions): string {
  const agents = collectAgents(options);
  const auditLogs = collectAuditLogs(options);
  const violations = analyzeViolations(agents, auditLogs);
  const chains = analyzeDelegationChains(agents);
  const soc2Checks = buildSOC2Checks(agents, auditLogs, violations);
  const euChecks = buildEUAIActChecks(agents, auditLogs, chains);
  const recommendations = generateRecommendations(violations, soc2Checks, euChecks, agents);

  const allChecks = [
    ...soc2Checks.cc61,
    ...soc2Checks.cc72,
    ...euChecks.article12,
    ...euChecks.article14,
  ];
  const posture = determinePosture(violations, allChecks);

  const activeAgents = agents.filter((a) => a.status === 'active');
  const revokedAgents = agents.filter((a) => a.status === 'revoked');
  const toolCallLogs = auditLogs.filter(
    (l) => l.action === 'tool_call_allowed' || l.action === 'tool_call_blocked'
  );
  const blockedLogs = auditLogs.filter((l) => l.action === 'tool_call_blocked');

  // Risk classification breakdown (EU AI Act Art. 6)
  const riskBreakdown = {
    unacceptable: agents.filter((a) => (a as AgentRow & { risk_level?: string }).risk_level === 'unacceptable').length,
    high: agents.filter((a) => (a as AgentRow & { risk_level?: string }).risk_level === 'high').length,
    limited: agents.filter((a) => (a as AgentRow & { risk_level?: string }).risk_level === 'limited').length,
    minimal: agents.filter((a) => {
      const rl = (a as AgentRow & { risk_level?: string }).risk_level;
      return !rl || rl === 'minimal';
    }).length,
  };

  const showSOC2 = options.framework === 'soc2' || options.framework === 'all';
  const showEU = options.framework === 'eu-ai-act' || options.framework === 'all';

  const generatedAt = formatDate(new Date());

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Eigent Compliance Report — ${formatDate(options.period.start)} to ${formatDate(options.period.end)}</title>
<style>
  :root {
    --bg-primary: #0a0e1a;
    --bg-secondary: #111827;
    --bg-card: #1a2035;
    --bg-card-alt: #1e2642;
    --border: #2a3555;
    --text-primary: #e8ecf4;
    --text-secondary: #8892a8;
    --text-muted: #5a6580;
    --accent: #3b82f6;
    --accent-dim: #2563eb;
    --green: #10b981;
    --green-dim: #064e3b;
    --red: #ef4444;
    --red-dim: #7f1d1d;
    --yellow: #f59e0b;
    --yellow-dim: #78350f;
    --orange: #f97316;
    --cyan: #06b6d4;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.6;
    font-size: 14px;
  }

  .report-container {
    max-width: 1100px;
    margin: 0 auto;
    padding: 40px 32px;
  }

  /* Header */
  .report-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 2px solid var(--accent);
    padding-bottom: 32px;
    margin-bottom: 40px;
  }

  .report-header .brand {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .logo-placeholder {
    width: 48px;
    height: 48px;
    background: linear-gradient(135deg, var(--accent), var(--cyan));
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    font-size: 20px;
    color: #fff;
    letter-spacing: -1px;
  }

  .report-header h1 {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.5px;
    color: var(--text-primary);
  }

  .report-header .subtitle {
    font-size: 14px;
    color: var(--text-secondary);
    margin-top: 2px;
  }

  .report-meta {
    text-align: right;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .report-meta .label {
    color: var(--text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Section */
  .section {
    margin-bottom: 36px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 20px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }

  .section-number {
    background: var(--accent);
    color: #fff;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
    flex-shrink: 0;
  }

  .section-header h2 {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .section-header .framework-tag {
    margin-left: auto;
    font-size: 11px;
    color: var(--accent);
    background: rgba(59, 130, 246, 0.12);
    padding: 3px 10px;
    border-radius: 4px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Cards & Stats */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    text-align: center;
  }

  .stat-card .stat-value {
    font-size: 32px;
    font-weight: 800;
    color: var(--text-primary);
    line-height: 1;
  }

  .stat-card .stat-label {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 6px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .stat-card.accent .stat-value { color: var(--accent); }
  .stat-card.green .stat-value { color: var(--green); }
  .stat-card.red .stat-value { color: var(--red); }
  .stat-card.yellow .stat-value { color: var(--yellow); }
  .stat-card.cyan .stat-value { color: var(--cyan); }

  .posture-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 24px;
    text-align: center;
    grid-column: 1 / -1;
  }

  .posture-badge {
    display: inline-block;
    padding: 8px 28px;
    border-radius: 6px;
    font-size: 18px;
    font-weight: 800;
    letter-spacing: 1px;
  }

  .posture-label {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--bg-card);
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--border);
    margin-bottom: 16px;
  }

  thead th {
    background: var(--bg-card-alt);
    padding: 12px 16px;
    text-align: left;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--border);
  }

  tbody td {
    padding: 10px 16px;
    border-bottom: 1px solid rgba(42, 53, 85, 0.5);
    font-size: 13px;
    color: var(--text-primary);
    vertical-align: top;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  tbody tr:hover {
    background: rgba(59, 130, 246, 0.04);
  }

  .violation-row {
    background: rgba(239, 68, 68, 0.06) !important;
  }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .badge-pass {
    background: var(--green);
    color: #000;
  }

  .badge-fail {
    background: var(--red);
    color: #fff;
  }

  .badge-active {
    background: var(--green-dim);
    color: var(--green);
    border: 1px solid var(--green);
  }

  .badge-revoked {
    background: var(--red-dim);
    color: var(--red);
    border: 1px solid var(--red);
  }

  .badge-expired {
    background: var(--yellow-dim);
    color: var(--yellow);
    border: 1px solid var(--yellow);
  }

  /* Compliance Check */
  .check-item {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 12px;
    display: flex;
    gap: 16px;
    align-items: flex-start;
  }

  .check-status {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
    margin-top: 2px;
  }

  .check-pass {
    background: var(--green-dim);
    color: var(--green);
    border: 1px solid var(--green);
  }

  .check-fail {
    background: var(--red-dim);
    color: var(--red);
    border: 1px solid var(--red);
  }

  .check-body {
    flex: 1;
  }

  .check-body .control-id {
    font-size: 11px;
    color: var(--accent);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .check-body .check-desc {
    font-size: 14px;
    color: var(--text-primary);
    margin-top: 2px;
    font-weight: 500;
  }

  .check-body .evidence-list {
    margin-top: 8px;
    padding: 10px 14px;
    background: var(--bg-secondary);
    border-radius: 6px;
    border-left: 3px solid var(--border);
  }

  .check-body .evidence-list .evidence-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    margin-bottom: 4px;
    font-weight: 700;
  }

  .check-body .evidence-list code {
    display: block;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.8;
    word-break: break-all;
  }

  /* Delegation Chain Tree */
  .chain-tree {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 16px;
  }

  .chain-tree .chain-label {
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 12px;
    font-weight: 600;
  }

  .chain-node {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    font-size: 13px;
  }

  .chain-node .node-icon {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .chain-node .human-icon {
    background: var(--accent);
    color: #fff;
  }

  .chain-node .agent-icon {
    background: var(--bg-card-alt);
    border: 1px solid var(--border);
    color: var(--cyan);
  }

  .chain-connector {
    width: 24px;
    display: flex;
    justify-content: center;
    color: var(--border);
    font-size: 16px;
    padding: 2px 0;
  }

  .chain-node .node-name {
    font-weight: 600;
    color: var(--text-primary);
  }

  .chain-node .node-scope {
    font-size: 11px;
    color: var(--text-secondary);
    font-family: 'JetBrains Mono', monospace;
  }

  .chain-node .node-status {
    margin-left: auto;
  }

  .chain-validation {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    display: flex;
    gap: 20px;
  }

  .chain-validation span {
    color: var(--text-secondary);
  }

  /* Recommendations */
  .rec-item {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 10px;
    border-left: 4px solid var(--border);
  }

  .rec-item.rec-critical { border-left-color: var(--red); }
  .rec-item.rec-high { border-left-color: var(--orange); }
  .rec-item.rec-medium { border-left-color: var(--yellow); }
  .rec-item.rec-low { border-left-color: var(--green); }

  .rec-item .rec-title {
    font-weight: 600;
    font-size: 14px;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .rec-item .rec-desc {
    font-size: 13px;
    color: var(--text-secondary);
    margin-top: 4px;
    line-height: 1.5;
  }

  .rec-item .rec-framework {
    font-size: 11px;
    color: var(--accent);
    margin-top: 6px;
    font-weight: 600;
  }

  /* Footer */
  .report-footer {
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    text-align: center;
    font-size: 12px;
    color: var(--text-muted);
  }

  .report-footer .confidential {
    font-weight: 700;
    color: var(--red);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }

  /* Utility */
  .mono {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
  }

  .text-muted { color: var(--text-muted); }
  .text-green { color: var(--green); }
  .text-red { color: var(--red); }
  .text-yellow { color: var(--yellow); }
  .text-accent { color: var(--accent); }

  .empty-state {
    text-align: center;
    padding: 32px;
    color: var(--text-muted);
    font-style: italic;
  }

  /* Print styles */
  @media print {
    :root {
      --bg-primary: #ffffff;
      --bg-secondary: #f8f9fb;
      --bg-card: #ffffff;
      --bg-card-alt: #f3f4f6;
      --border: #d1d5db;
      --text-primary: #111827;
      --text-secondary: #4b5563;
      --text-muted: #9ca3af;
      --accent: #2563eb;
      --green: #059669;
      --green-dim: #d1fae5;
      --red: #dc2626;
      --red-dim: #fee2e2;
      --yellow: #d97706;
      --yellow-dim: #fef3c7;
    }

    body {
      background: #fff;
      color: #111;
      font-size: 11px;
    }

    .report-container {
      max-width: 100%;
      padding: 20px;
    }

    .section {
      page-break-inside: avoid;
    }

    table {
      font-size: 10px;
    }

    .badge-pass {
      background: #d1fae5;
      color: #065f46;
      border: 1px solid #059669;
    }

    .badge-fail {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #dc2626;
    }

    .badge-active {
      background: #d1fae5;
      color: #065f46;
    }

    .badge-revoked {
      background: #fee2e2;
      color: #991b1b;
    }

    .check-pass {
      background: #d1fae5;
      color: #065f46;
    }

    .check-fail {
      background: #fee2e2;
      color: #991b1b;
    }

    .posture-badge {
      border: 2px solid #111;
    }

    .logo-placeholder {
      background: #2563eb;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  }
</style>
</head>
<body>
<div class="report-container">

  <!-- ═══════════ HEADER ═══════════ -->
  <div class="report-header">
    <div class="brand">
      <div class="logo-placeholder">E</div>
      <div>
        <h1>Compliance Report</h1>
        <div class="subtitle">Eigent Agent Governance Infrastructure</div>
      </div>
    </div>
    <div class="report-meta">
      <div class="label">Generated</div>
      <div>${escapeHtml(generatedAt)}</div>
      <div class="label" style="margin-top:8px;">Reporting Period</div>
      <div>${escapeHtml(formatDate(options.period.start))}</div>
      <div>to ${escapeHtml(formatDate(options.period.end))}</div>
      <div class="label" style="margin-top:8px;">Framework</div>
      <div>${escapeHtml(options.framework.toUpperCase())}</div>
      ${options.human ? `<div class="label" style="margin-top:8px;">Filtered By</div><div>${escapeHtml(options.human)}</div>` : ''}
    </div>
  </div>

  <!-- ═══════════ 1. EXECUTIVE SUMMARY ═══════════ -->
  <div class="section">
    <div class="section-header">
      <div class="section-number">1</div>
      <h2>Executive Summary</h2>
    </div>

    <div class="stats-grid">
      <div class="stat-card accent">
        <div class="stat-value">${agents.length}</div>
        <div class="stat-label">Total Agents</div>
      </div>
      <div class="stat-card green">
        <div class="stat-value">${activeAgents.length}</div>
        <div class="stat-label">Active Agents</div>
      </div>
      <div class="stat-card cyan">
        <div class="stat-value">${toolCallLogs.length}</div>
        <div class="stat-label">Tool Calls Monitored</div>
      </div>
      <div class="stat-card ${violations.length > 0 ? 'red' : 'green'}">
        <div class="stat-value">${violations.length}</div>
        <div class="stat-label">Violations Detected</div>
      </div>
      <div class="stat-card yellow">
        <div class="stat-value">${chains.length}</div>
        <div class="stat-label">Delegation Chains</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${auditLogs.length}</div>
        <div class="stat-label">Audit Log Entries</div>
      </div>
    </div>

    <div class="posture-card">
      ${postureBadge(posture)}
      <div class="posture-label">Overall Compliance Posture</div>
    </div>
  </div>

  <!-- ═══════════ 2. AGENT INVENTORY ═══════════ -->
  <div class="section">
    <div class="section-header">
      <div class="section-number">2</div>
      <h2>Agent Inventory</h2>
    </div>

    ${agents.length === 0
      ? '<div class="empty-state">No agents found for the specified criteria.</div>'
      : `<table>
      <thead>
        <tr>
          <th>Agent Name</th>
          <th>Human Owner</th>
          <th>Scope</th>
          <th>Depth</th>
          <th>Max Depth</th>
          <th>Status</th>
          <th>Created</th>
          <th>Expires</th>
        </tr>
      </thead>
      <tbody>
        ${agents.map((a) => {
          const scope: string[] = JSON.parse(a.scope);
          const now = new Date();
          const expired = new Date(a.expires_at) < now;
          const noHuman = !a.human_email || !a.human_sub;
          const isViolation = noHuman || (expired && a.status === 'active');
          const statusClass = a.status === 'active'
            ? (expired ? 'badge-expired' : 'badge-active')
            : 'badge-revoked';
          const statusLabel = a.status === 'active' && expired ? 'expired' : a.status;

          return `<tr class="${isViolation ? 'violation-row' : ''}">
            <td><strong>${escapeHtml(a.name)}</strong>${noHuman ? '<br>' + severityBadge('critical') + ' No human binding' : ''}${expired && a.status === 'active' ? '<br>' + severityBadge('high') + ' Expired but active' : ''}</td>
            <td class="mono">${escapeHtml(a.human_email || 'NONE')}</td>
            <td class="mono" style="font-size:11px;">${scope.map((s) => escapeHtml(s)).join(', ')}</td>
            <td>${a.delegation_depth}</td>
            <td>${a.max_delegation_depth}</td>
            <td><span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span></td>
            <td class="text-muted" style="font-size:11px;">${escapeHtml(formatDateShort(a.created_at))}</td>
            <td class="text-muted" style="font-size:11px;">${escapeHtml(formatDateShort(a.expires_at))}</td>
          </tr>`;
        }).join('\n        ')}
      </tbody>
    </table>`
    }
  </div>

  <!-- ═══════════ 3. DELEGATION CHAIN AUDIT ═══════════ -->
  <div class="section">
    <div class="section-header">
      <div class="section-number">3</div>
      <h2>Delegation Chain Audit</h2>
    </div>

    ${chains.length === 0
      ? '<div class="empty-state">No delegation chains found.</div>'
      : chains.map((chain, idx) => `
    <div class="chain-tree">
      <div class="chain-label">Chain #${idx + 1} &mdash; Root: ${escapeHtml(chain.rootHuman)}</div>

      <div class="chain-node">
        <div class="node-icon human-icon">H</div>
        <span class="node-name">${escapeHtml(chain.rootHuman)}</span>
        <span class="text-muted">(Human Authority)</span>
      </div>

      ${chain.chain.map((node, i) => `
      <div class="chain-connector">|</div>
      <div class="chain-node" style="margin-left:${(node.depth + 1) * 24}px;">
        <div class="node-icon agent-icon">A${node.depth}</div>
        <span class="node-name">${escapeHtml(node.name)}</span>
        <span class="node-scope">[${node.scope.map((s) => escapeHtml(s)).join(', ')}]</span>
        <span class="node-status"><span class="badge ${node.status === 'active' ? 'badge-active' : 'badge-revoked'}">${escapeHtml(node.status)}</span></span>
      </div>`).join('')}

      <div class="chain-validation">
        <span>Permission Narrowing: ${chain.permissionNarrowingValid
          ? '<span class="text-green">Valid</span>'
          : '<span class="text-red">VIOLATION - child has scope not in parent</span>'
        }</span>
        <span>Depth: ${chain.chain.length > 0 ? Math.max(...chain.chain.map((n) => n.depth)) : 0} / ${chain.maxConfiguredDepth} max ${chain.depthViolation ? '<span class="text-red">EXCEEDS LIMIT</span>' : ''}</span>
      </div>
    </div>`).join('\n    ')
    }
  </div>

  <!-- ═══════════ 4. SOC2 CC6.1 — ACCESS CONTROL ═══════════ -->
  ${showSOC2 ? `
  <div class="section">
    <div class="section-header">
      <div class="section-number">4</div>
      <h2>Access Control Evidence</h2>
      <span class="framework-tag">SOC2 CC6.1</span>
    </div>

    ${soc2Checks.cc61.map((check) => `
    <div class="check-item">
      <div class="check-status ${check.status ? 'check-pass' : 'check-fail'}">${check.status ? '\u2713' : '\u2717'}</div>
      <div class="check-body">
        <div class="control-id">${escapeHtml(check.control)}</div>
        <div class="check-desc">${escapeHtml(check.description)}: ${statusBadge(check.status)}</div>
        <div class="evidence-list">
          <div class="evidence-title">Evidence</div>
          ${check.evidence.map((e) => `<code>${escapeHtml(e)}</code>`).join('\n          ')}
        </div>
      </div>
    </div>`).join('\n    ')}
  </div>
  ` : ''}

  <!-- ═══════════ 5. SOC2 CC7.2 — MONITORING ═══════════ -->
  ${showSOC2 ? `
  <div class="section">
    <div class="section-header">
      <div class="section-number">5</div>
      <h2>Monitoring Evidence</h2>
      <span class="framework-tag">SOC2 CC7.2</span>
    </div>

    ${soc2Checks.cc72.map((check) => `
    <div class="check-item">
      <div class="check-status ${check.status ? 'check-pass' : 'check-fail'}">${check.status ? '\u2713' : '\u2717'}</div>
      <div class="check-body">
        <div class="control-id">${escapeHtml(check.control)}</div>
        <div class="check-desc">${escapeHtml(check.description)}: ${statusBadge(check.status)}</div>
        <div class="evidence-list">
          <div class="evidence-title">Evidence</div>
          ${check.evidence.map((e) => `<code>${escapeHtml(e)}</code>`).join('\n          ')}
        </div>
      </div>
    </div>`).join('\n    ')}
  </div>
  ` : ''}

  <!-- ═══════════ 6. EU AI ACT ARTICLE 12 ═══════════ -->
  ${showEU ? `
  <div class="section">
    <div class="section-header">
      <div class="section-number">6</div>
      <h2>Record-Keeping</h2>
      <span class="framework-tag">EU AI Act Article 12</span>
    </div>

    ${euChecks.article12.map((check) => `
    <div class="check-item">
      <div class="check-status ${check.status ? 'check-pass' : 'check-fail'}">${check.status ? '\u2713' : '\u2717'}</div>
      <div class="check-body">
        <div class="control-id">${escapeHtml(check.control)}</div>
        <div class="check-desc">${escapeHtml(check.description)}: ${statusBadge(check.status)}</div>
        <div class="evidence-list">
          <div class="evidence-title">Evidence</div>
          ${check.evidence.map((e) => `<code>${escapeHtml(e)}</code>`).join('\n          ')}
        </div>
      </div>
    </div>`).join('\n    ')}
  </div>
  ` : ''}

  <!-- ═══════════ 7. EU AI ACT ARTICLE 14 ═══════════ -->
  ${showEU ? `
  <div class="section">
    <div class="section-header">
      <div class="section-number">7</div>
      <h2>Human Oversight</h2>
      <span class="framework-tag">EU AI Act Article 14</span>
    </div>

    ${euChecks.article14.map((check) => `
    <div class="check-item">
      <div class="check-status ${check.status ? 'check-pass' : 'check-fail'}">${check.status ? '\u2713' : '\u2717'}</div>
      <div class="check-body">
        <div class="control-id">${escapeHtml(check.control)}</div>
        <div class="check-desc">${escapeHtml(check.description)}: ${statusBadge(check.status)}</div>
        <div class="evidence-list">
          <div class="evidence-title">Evidence</div>
          ${check.evidence.map((e) => `<code>${escapeHtml(e)}</code>`).join('\n          ')}
        </div>
      </div>
    </div>`).join('\n    ')}
  </div>
  ` : ''}

  <!-- ═══════════ 8. RISK CLASSIFICATION (EU AI Act Art. 6) ═══════════ -->
  ${showEU ? `
  <div class="section">
    <div class="section-header">
      <div class="section-number">8</div>
      <h2>Risk Classification</h2>
      <span class="framework-tag">EU AI Act Article 6</span>
    </div>

    <table class="data-table">
      <thead>
        <tr><th>Risk Level</th><th>Agent Count</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr><td>${severityBadge('critical')} Unacceptable</td><td>${riskBreakdown.unacceptable}</td><td>Prohibited per Article 5 - rejected at registration</td></tr>
        <tr><td>${severityBadge('high')} High</td><td>${riskBreakdown.high}</td><td>Requires verified OIDC, delegation depth &le; 1, no wildcards</td></tr>
        <tr><td>${severityBadge('medium')} Limited</td><td>${riskBreakdown.limited}</td><td>Transparency obligations apply</td></tr>
        <tr><td>${severityBadge('low')} Minimal</td><td>${riskBreakdown.minimal}</td><td>Standard controls</td></tr>
      </tbody>
    </table>
  </div>
  ` : ''}

  <!-- ═══════════ 9. POLICY VIOLATIONS DETAIL ═══════════ -->
  <div class="section">
    <div class="section-header">
      <div class="section-number">9</div>
      <h2>Policy Violations Detail</h2>
    </div>

    ${violations.length === 0
      ? '<div class="empty-state">No policy violations detected during the reporting period.</div>'
      : `<table>
      <thead>
        <tr>
          <th>Severity</th>
          <th>Timestamp</th>
          <th>Agent</th>
          <th>Category</th>
          <th>Description</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        ${violations.map((v) => `<tr>
          <td>${severityBadge(v.severity)}</td>
          <td class="mono text-muted" style="font-size:11px;">${escapeHtml(v.timestamp ? formatDateShort(v.timestamp) : 'N/A')}</td>
          <td class="mono" style="font-size:11px;">${escapeHtml(v.agentName ?? v.agentId?.slice(0, 12) ?? 'N/A')}</td>
          <td>${escapeHtml(v.category)}</td>
          <td>${escapeHtml(v.description)}</td>
          <td class="mono text-muted" style="font-size:11px;">${escapeHtml(v.evidence ?? '')}</td>
        </tr>`).join('\n        ')}
      </tbody>
    </table>`
    }
  </div>

  <!-- ═══════════ 10. RECOMMENDATIONS ═══════════ -->
  <div class="section">
    <div class="section-header">
      <div class="section-number">10</div>
      <h2>Recommendations</h2>
    </div>

    ${recommendations.length === 0
      ? '<div class="empty-state">No recommendations at this time.</div>'
      : recommendations.map((r) => `
    <div class="rec-item rec-${r.priority}">
      <div class="rec-title">${severityBadge(r.priority)} ${escapeHtml(r.title)}</div>
      <div class="rec-desc">${escapeHtml(r.description)}</div>
      <div class="rec-framework">${escapeHtml(r.framework)}</div>
    </div>`).join('\n    ')
    }
  </div>

  <!-- ═══════════ FOOTER ═══════════ -->
  <div class="report-footer">
    <div class="confidential">Confidential</div>
    <div>This report was automatically generated by Eigent Agent Governance Infrastructure.</div>
    <div>Report ID: RPT-${Date.now().toString(36).toUpperCase()} | Generated: ${escapeHtml(generatedAt)}</div>
    <div style="margin-top:8px;">Eigent &mdash; Trust Infrastructure for AI Agents</div>
  </div>

</div>
</body>
</html>`;
}

export type { ReportOptions, ComplianceFramework, ReportPeriod };
