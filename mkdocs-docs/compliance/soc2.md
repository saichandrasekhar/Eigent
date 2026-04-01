# SOC 2 Compliance

SOC 2 (System and Organization Controls 2) defines criteria for managing data based on five Trust Services Criteria: Security, Availability, Processing Integrity, Confidentiality, and Privacy. Eigent provides technical controls that map to several SOC 2 criteria, particularly within the Security (Common Criteria) category.

## Control Mapping

### CC6 — Logical and Physical Access Controls

| SOC 2 Control | Eigent Implementation | Evidence |
|---------------|----------------------|----------|
| CC6.1 — Access to infrastructure and software is restricted | Agent tokens scope access to specific tools. Sidecar enforces at runtime. | Token scope lists, sidecar enforcement logs |
| CC6.2 — Access to data is restricted | Delegation chain narrows permissions. Child cannot exceed parent scope. | Delegation chain view, scope intersection logs |
| CC6.3 — Access is removed when no longer required | Cascade revocation removes agent and all descendants. Short-lived tokens expire automatically. | Revocation audit entries, token TTL configuration |
| CC6.6 — System boundaries are protected | Sidecar intercepts all MCP traffic at the boundary between agent and tool. | Sidecar configuration, OTel spans |
| CC6.8 — Unauthorized access is prevented and detected | Blocked tool calls are logged with full context. Scanner detects unprotected agents. | `tool_call_blocked` audit entries, scan reports |

### CC7 — System Operations

| SOC 2 Control | Eigent Implementation | Evidence |
|---------------|----------------------|----------|
| CC7.1 — Infrastructure and software are monitored | Sidecar exports OTel spans for every tool call. Scanner runs in CI/CD. | OTel collector data, CI/CD scan results |
| CC7.2 — Anomalies are detected and evaluated | Blocked tool call patterns indicate anomalous agent behavior. Drift detection catches config changes. | SIEM alerts, drift detection reports |
| CC7.3 — Security incidents are identified and reported | Mass revocation events, blocked call spikes, and shadow agent discoveries are flagged. | SIEM alert rules, scan findings |
| CC7.4 — Incidents are responded to | Cascade revocation provides immediate incident response capability. | Revocation audit entries with cascade details |

### CC8 — Change Management

| SOC 2 Control | Eigent Implementation | Evidence |
|---------------|----------------------|----------|
| CC8.1 — Changes to infrastructure and software are controlled | Agent identity changes (issuance, delegation, revocation) are logged. Scanner detects configuration drift. | Audit trail, drift detection |

### CC2 — Communication

| SOC 2 Control | Eigent Implementation | Evidence |
|---------------|----------------------|----------|
| CC2.1 — Information is communicated internally | Dashboard provides visibility into agent inventory and security posture. | Dashboard screenshots, agent list reports |

## Evidence Generation

### Automated Evidence Collection

Create a script to collect SOC 2 evidence periodically:

```bash
#!/bin/bash
# collect-soc2-evidence.sh
# Run weekly or before audit

DATE=$(date +%Y-%m-%d)
EVIDENCE_DIR="./soc2-evidence/$DATE"
mkdir -p "$EVIDENCE_DIR"

# CC6.1 — Access restrictions
echo "Collecting agent inventory..."
curl -s "http://localhost:3456/api/agents?status=active" | \
  jq '.' > "$EVIDENCE_DIR/active-agents.json"

# CC6.2 — Delegation chains
echo "Collecting delegation chains..."
curl -s "http://localhost:3456/api/agents?status=active" | \
  jq -r '.agents[].id' | \
  while read -r id; do
    curl -s "http://localhost:3456/api/agents/$id/chain" >> "$EVIDENCE_DIR/chains.json"
    echo "" >> "$EVIDENCE_DIR/chains.json"
  done

# CC6.3 — Access removal
echo "Collecting revocation events..."
curl -s "http://localhost:3456/api/audit?action=revoked&limit=1000" | \
  jq '.' > "$EVIDENCE_DIR/revocations.json"

# CC6.8 — Blocked access attempts
echo "Collecting blocked calls..."
curl -s "http://localhost:3456/api/audit?action=tool_call_blocked&limit=1000" | \
  jq '.' > "$EVIDENCE_DIR/blocked-calls.json"

# CC7.1 — Monitoring configuration
echo "Collecting scan results..."
eigent-scan scan --output json > "$EVIDENCE_DIR/scan-results.json"
eigent-scan scan --output html
mv eigent-scan-report.html "$EVIDENCE_DIR/scan-report.html"

# Summary
echo "Collecting statistics..."
cat > "$EVIDENCE_DIR/summary.json" << EOF
{
  "date": "$DATE",
  "active_agents": $(curl -s "http://localhost:3456/api/agents" | jq '.total'),
  "blocked_calls_30d": $(curl -s "http://localhost:3456/api/audit?action=tool_call_blocked" | jq '.total'),
  "revocations_30d": $(curl -s "http://localhost:3456/api/audit?action=revoked" | jq '.total'),
  "scan_findings": $(eigent-scan scan --output json | jq '.findings | length')
}
EOF

echo "Evidence collected in $EVIDENCE_DIR"
```

### Key Metrics for Auditors

| Metric | Query | SOC 2 Relevance |
|--------|-------|-----------------|
| Active agents | `GET /api/agents?status=active` | CC6.1 — current access |
| Avg. token TTL | Token `exp - iat` analysis | CC6.3 — timely revocation |
| Blocked call rate | `tool_call_blocked / total_calls` | CC6.8 — access control effectiveness |
| Mean time to revoke | Revocation timestamp - incident timestamp | CC7.4 — incident response |
| Scan frequency | CI/CD pipeline run history | CC7.1 — monitoring cadence |
| Drift detections | Scan diff analysis | CC8.1 — change detection |

## Auditor FAQ

**Q: How does Eigent prevent privilege escalation?**

A: The three-way scope intersection model ensures that delegated permissions can only narrow, never widen. A child agent's granted scope is `parent_scope ∩ requested_scope ∩ parent_can_delegate`. This is enforced cryptographically in the token and at runtime by the sidecar.

**Q: What happens when a token is compromised?**

A: The human operator runs `eigent revoke <agent-name>`, which immediately revokes the agent and all its descendants (cascade revocation). All subsequent tool calls by any agent in the chain are blocked and logged. Short-lived tokens (default 1 hour) limit the window of exposure.

**Q: How is the audit trail protected?**

A: The audit trail is stored in the registry's database. Each entry has a UUIDv7 ID that embeds the creation timestamp, making it difficult to insert backdated entries. For production deployments, audit events should be exported to an append-only log store (e.g., Splunk, immutable S3 bucket).

**Q: Can audit entries be deleted?**

A: The registry API does not expose a delete endpoint for audit entries. Entries can only be queried. For additional protection, export to a WORM (Write Once Read Many) storage target.

**Q: How do you verify the agent inventory is complete?**

A: `eigent-scan` discovers agents through two independent methods: configuration file scanning (14 locations) and live process detection. Running both methods provides comprehensive coverage. The scanner identifies agents that do not have Eigent tokens, highlighting gaps in the inventory.

## Preparing for a SOC 2 Audit

1. **Deploy Eigent** across all environments with agent activity
2. **Configure sidecar enforcement** on all MCP servers
3. **Set up CI/CD scanning** to run on every PR and on a daily schedule
4. **Export audit data** to a SIEM or immutable log store
5. **Run the evidence collection script** weekly
6. **Document procedures** for token issuance, delegation, and revocation
7. **Review and remediate** scan findings quarterly
8. **Maintain an agent inventory** with human owner mapping
