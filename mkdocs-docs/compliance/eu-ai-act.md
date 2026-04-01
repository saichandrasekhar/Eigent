# EU AI Act Compliance

The EU AI Act (Regulation 2024/1689) establishes a legal framework for AI systems in the European Union. Eigent provides technical controls that directly support compliance with several key articles, particularly those related to transparency, traceability, human oversight, and accountability.

## Article-by-Article Mapping

### Article 9 — Risk Management System

**Requirement:** High-risk AI systems must implement a risk management system that identifies, evaluates, and mitigates risks throughout the system lifecycle.

**What Eigent provides:**

- `eigent-scan` discovers all AI agents and MCP servers in the environment, identifying previously unknown risk surfaces
- Security findings are categorized by severity (critical, high, medium, low)
- Scan history enables drift detection to catch new risks as they appear
- SARIF output integrates with existing vulnerability management workflows

| Evidence | Source |
|----------|--------|
| Agent inventory | `eigent-scan scan --output json` |
| Risk findings | `eigent-scan scan --output html` |
| Drift alerts | CI/CD scan comparison |

### Article 12 — Record-Keeping

**Requirement:** High-risk AI systems must enable automatic logging of events that are relevant for identifying risks, monitoring operations, and enabling post-market surveillance. Logs must ensure traceability of the AI system's functioning.

**What Eigent provides:**

- Complete audit trail of every agent lifecycle event (issuance, delegation, revocation)
- Every tool call authorization decision is logged with full context
- Delegation chains record the complete path from human to tool call
- UUIDv7 event IDs provide millisecond-precision time ordering

| Evidence | Source |
|----------|--------|
| Audit log export | `GET /api/audit` with date range filters |
| Delegation chain trace | `GET /api/agents/:id/chain` |
| Tool call decisions | Audit entries with `tool_call_allowed` / `tool_call_blocked` |

### Article 13 — Transparency and Provision of Information

**Requirement:** High-risk AI systems must be designed to ensure sufficient transparency to enable users to interpret the system's output and use it appropriately.

**What Eigent provides:**

- Every agent has a visible, inspectable identity (name, scope, delegation chain)
- Token contents can be decoded to show exactly what permissions an agent holds
- The CLI provides human-readable views of chains, permissions, and audit trails
- Dashboard visualizations show agent topology and permission flows

| Evidence | Source |
|----------|--------|
| Agent identity | `eigent list` or `GET /api/agents` |
| Permission details | Token decode or `eigent verify` |
| Chain visualization | `eigent chain <agent-name>` |

### Article 14 — Human Oversight

**Requirement:** High-risk AI systems must be designed to allow effective human oversight, including the ability for a human to understand the system's capabilities and limitations, correctly interpret output, and decide not to use the system or override its operation.

**What Eigent provides:**

- Every agent identity traces back to a specific human operator via the `human` binding
- Humans can revoke any agent and its entire delegation subtree at any time
- The sidecar can operate in monitor mode, allowing humans to review before enforcing
- Permission boundaries are explicitly defined by humans, not inferred

| Evidence | Source |
|----------|--------|
| Human binding | `human.email` in every token |
| Revocation capability | `eigent revoke <agent>` |
| Monitor mode logs | Sidecar in `--mode monitor` |
| Human-defined scopes | `eigent issue --scope` |

### Article 17 — Quality Management System

**Requirement:** Providers must establish a quality management system that includes procedures for data management, risk management, post-market monitoring, and incident reporting.

**What Eigent provides:**

- Standardized process for agent identity management
- Audit trail provides post-market monitoring data
- `eigent-scan` enables regular security assessments
- SIEM integration enables incident detection and response

### Article 26 — Obligations of Deployers

**Requirement:** Deployers of high-risk AI systems must monitor the operation of the system and report any serious incidents.

**What Eigent provides:**

- Real-time monitoring via sidecar OTel export
- Alert rules for blocked tool calls, mass revocations, and shadow agents
- Incident response through immediate cascade revocation
- Historical audit data for incident investigation

## Compliance Control Matrix

| EU AI Act Article | Eigent Control | Evidence Type |
|-------------------|---------------|---------------|
| Art. 9 — Risk Management | Agent discovery scan | Scan reports (SARIF, HTML) |
| Art. 12 — Record-Keeping | Audit trail | Audit API export |
| Art. 13 — Transparency | Identity + chain visibility | Token decode, chain view |
| Art. 14 — Human Oversight | Human binding + revocation | Token human claim, revocation logs |
| Art. 17 — Quality Management | Standardized identity lifecycle | Process documentation |
| Art. 26 — Deployer Obligations | Real-time monitoring + alerting | OTel spans, SIEM alerts |

## Sample Audit Report

Generate a compliance-ready audit report:

```bash
# Export all audit events for a time period
curl "http://localhost:3456/api/audit?from_date=2026-01-01&to_date=2026-03-31&limit=10000" \
  > audit-q1-2026.json

# Generate HTML scan report
eigent-scan scan --output html
# Creates: eigent-scan-report.html
```

A compliance audit report should include:

1. **Agent Inventory** — Complete list of all agents, their scopes, and delegation chains
2. **Human Authorization Map** — Which humans authorized which agents
3. **Tool Call Summary** — Statistics on allowed vs. blocked tool calls
4. **Revocation Log** — All revocation events with reasons
5. **Security Findings** — Most recent scan results with remediation status

See [Compliance Reports](reports.md) for automated report generation.

## Implementation Checklist

Use this checklist to track your EU AI Act compliance with Eigent:

- [ ] Deploy Eigent registry and issue tokens for all AI agents
- [ ] Configure sidecar enforcement on all MCP servers
- [ ] Set up `eigent-scan` in CI/CD pipeline
- [ ] Configure SIEM integration for real-time monitoring
- [ ] Establish token issuance and revocation procedures
- [ ] Document the human-agent authorization mapping
- [ ] Set up regular (weekly/monthly) drift detection scans
- [ ] Configure alerts for blocked tool calls and mass revocations
- [ ] Export audit data for the required retention period
- [ ] Conduct and document periodic access reviews
