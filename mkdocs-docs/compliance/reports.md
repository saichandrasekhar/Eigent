# Compliance Reports

Eigent provides multiple report formats for compliance audits, board presentations, and internal security reviews. This guide covers how to generate, customize, and distribute compliance reports.

## Report Formats

### HTML Report

The HTML report is a self-contained, shareable document with risk scores, compliance mapping, and remediation priorities. It is designed for board-level and auditor audiences.

```bash
eigent-scan scan --output html
# Creates: eigent-scan-report.html
```

The report includes:

- **Executive Summary** — Overall risk score, agent count, finding count
- **Agent Inventory** — All discovered agents with transport, auth status, and risk level
- **Security Findings** — Detailed findings with severity, description, and remediation
- **Compliance Mapping** — How findings map to EU AI Act and SOC 2 controls
- **Remediation Priorities** — Ordered list of actions ranked by risk reduction

### SARIF Report

SARIF (Static Analysis Results Interchange Format) is the standard for security tool output. Use it for GitHub Advanced Security, Azure DevOps, and VS Code integration.

```bash
eigent-scan scan --output sarif > results.sarif
```

Upload to GitHub:

```bash
gh api repos/:owner/:repo/code-scanning/sarifs \
  -f "sarif=$(cat results.sarif | gzip | base64)" \
  -f "ref=refs/heads/main"
```

### JSON Report

Machine-readable format for custom dashboards and automated processing:

```bash
eigent-scan scan --output json > results.json
```

```json
{
  "scan_id": "019746f3-...",
  "timestamp": "2026-03-31T14:00:00.000Z",
  "summary": {
    "targets_scanned": ["mcp", "process"],
    "agents_discovered": 7,
    "findings_count": 12,
    "risk_level": "critical"
  },
  "agents": [...],
  "findings": [...]
}
```

## Generating Audit Reports

### Agent Inventory Report

Export the complete agent inventory with delegation chains:

```bash
# All active agents
curl -s "http://localhost:3456/api/agents" | jq '.agents[] | {
  name: .name,
  human: .human_email,
  scope: (.scope | join(", ")),
  depth: .delegation_depth,
  status: .status,
  created: .created_at,
  expires: .expires_at
}' > agent-inventory.json
```

### Audit Trail Export

Export audit events for a specific time period:

```bash
# Q1 2026 audit events
curl -s "http://localhost:3456/api/audit?\
from_date=2026-01-01T00:00:00Z&\
to_date=2026-03-31T23:59:59Z&\
limit=50000" > audit-q1-2026.json
```

### Delegation Chain Report

Generate a report showing all delegation relationships:

```bash
# Get all agents and their chains
curl -s "http://localhost:3456/api/agents" | \
  jq -r '.agents[] | .id' | \
  while read -r id; do
    echo "---"
    curl -s "http://localhost:3456/api/agents/$id/chain" | \
      jq '{agent_id: .agent_id, depth: .depth, root_human: .root_human_email, chain: [.chain[] | {name, scope, status}]}'
  done > delegation-chains.json
```

### Permission Audit Report

Summarize what each agent can and cannot do:

```bash
curl -s "http://localhost:3456/api/agents" | jq '.agents[] | {
  name: .name,
  human_owner: .human_email,
  can_do: (.scope | join(", ")),
  can_delegate: (.can_delegate // [] | join(", ")),
  delegation_depth: .delegation_depth,
  max_depth: .max_delegation_depth
}' > permission-audit.json
```

## Scheduled Report Generation

### Cron Job

Set up a weekly compliance report:

```bash
# /etc/cron.d/eigent-compliance
# Run every Monday at 6:00 AM UTC
0 6 * * 1 /opt/eigent/collect-compliance-report.sh
```

### GitHub Action

Generate and archive compliance reports on a schedule:

```yaml
name: Compliance Report
on:
  schedule:
    - cron: '0 6 * * 1'  # Weekly on Monday

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install scanner
        run: pip install eigent-scan

      - name: Generate reports
        run: |
          eigent-scan scan --output html
          eigent-scan scan --output json > scan-results.json
          eigent-scan scan --output sarif > scan-results.sarif

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: compliance-report-${{ github.run_id }}
          path: |
            eigent-scan-report.html
            scan-results.json
            scan-results.sarif
          retention-days: 365
```

## Report Distribution

### Stakeholder Matrix

| Report Type | Audience | Frequency | Format |
|-------------|----------|-----------|--------|
| Executive summary | Board, CISO | Monthly | HTML |
| Scan findings | Security team | Every PR | SARIF |
| Audit trail | Compliance team | Quarterly | JSON export |
| Agent inventory | IT operations | Weekly | JSON |
| Incident report | Management | As needed | HTML + JSON |

### Automated Distribution

```bash
#!/bin/bash
# distribute-reports.sh

# Generate reports
eigent-scan scan --output html
eigent-scan scan --output json > scan-results.json

# Upload to S3 for archival
DATE=$(date +%Y-%m-%d)
aws s3 cp eigent-scan-report.html "s3://compliance-reports/eigent/$DATE/report.html"
aws s3 cp scan-results.json "s3://compliance-reports/eigent/$DATE/results.json"

# Send Slack notification
curl -X POST "$SLACK_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d "{
    \"text\": \"Eigent compliance report generated for $DATE. View: https://compliance-reports.s3.amazonaws.com/eigent/$DATE/report.html\"
  }"
```

## Custom Report Templates

For organizations with specific reporting requirements, the JSON output can be transformed into any format:

```python
import json
from datetime import datetime

# Load scan results
with open("scan-results.json") as f:
    data = json.load(f)

# Generate custom report
report = {
    "title": "AI Agent Security Assessment",
    "date": datetime.now().isoformat(),
    "organization": "Your Company",
    "framework": "EU AI Act + SOC 2",
    "summary": {
        "total_agents": data["summary"]["agents_discovered"],
        "critical_findings": len([f for f in data["findings"] if f["severity"] == "critical"]),
        "high_findings": len([f for f in data["findings"] if f["severity"] == "high"]),
        "compliance_score": calculate_score(data),
    },
    "recommendations": generate_recommendations(data["findings"]),
}

# Output as formatted JSON, CSV, or feed into a template engine
with open("custom-report.json", "w") as f:
    json.dump(report, f, indent=2)
```

## Retention Requirements

| Framework | Minimum Retention | Eigent Evidence |
|-----------|-------------------|-----------------|
| EU AI Act | System lifecycle | Audit trail, scan history |
| SOC 2 | 1 year | Audit trail, evidence packages |
| ISO 27001 | 3 years | All logs and reports |
| HIPAA | 6 years | Audit trail |
| PCI DSS | 1 year | Access logs, scan reports |

Configure your SIEM and archive storage to meet the longest applicable retention period. The Eigent registry retains audit entries indefinitely by default; export to immutable storage for compliance-grade retention.
