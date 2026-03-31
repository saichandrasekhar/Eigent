"""SARIF v2.1.0 output format for Eigent scan results.

Generates spec-compliant SARIF JSON so findings appear in GitHub's Security tab
when uploaded via github/codeql-action/upload-sarif.
"""

from __future__ import annotations

import re

from eigent_scan import __version__
from eigent_scan.models import Finding, ScanResult, Severity

# SARIF severity mapping
_SARIF_LEVEL = {
    Severity.CRITICAL: "error",
    Severity.HIGH: "error",
    Severity.MEDIUM: "warning",
    Severity.LOW: "note",
    Severity.INFO: "note",
}

# SARIF security-severity score (used by GitHub to rank findings)
_SECURITY_SEVERITY = {
    Severity.CRITICAL: "9.5",
    Severity.HIGH: "7.5",
    Severity.MEDIUM: "5.0",
    Severity.LOW: "2.5",
    Severity.INFO: "1.0",
}


def _slugify(text: str) -> str:
    """Convert a finding title to a SARIF-compatible ruleId slug."""
    slug = text.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    return slug


def _build_rules(findings: list[Finding]) -> list[dict]:
    """Build deduplicated SARIF rule definitions from findings."""
    seen: dict[str, dict] = {}
    for finding in findings:
        rule_id = _slugify(finding.title)
        if rule_id not in seen:
            seen[rule_id] = {
                "id": rule_id,
                "name": finding.title,
                "shortDescription": {"text": finding.title},
                "fullDescription": {"text": finding.description},
                "helpUri": "https://docs.eigent.dev/findings",
                "help": {
                    "text": finding.recommendation,
                    "markdown": f"**Recommendation:** {finding.recommendation}",
                },
                "properties": {
                    "tags": ["security", "ai-agents", "mcp"],
                    "security-severity": _SECURITY_SEVERITY.get(
                        finding.severity, "1.0"
                    ),
                },
                "defaultConfiguration": {
                    "level": _SARIF_LEVEL.get(finding.severity, "note"),
                },
            }
    return list(seen.values())


def _build_results(findings: list[Finding]) -> list[dict]:
    """Build SARIF result entries from findings."""
    results = []
    for finding in findings:
        rule_id = _slugify(finding.title)
        result: dict = {
            "ruleId": rule_id,
            "level": _SARIF_LEVEL.get(finding.severity, "note"),
            "message": {
                "text": finding.description,
            },
            "properties": {
                "eigent-severity": finding.severity.value,
                "agent-name": finding.agent_name,
            },
        }

        # Add location if a config path is available
        if finding.config_path:
            result["locations"] = [
                {
                    "physicalLocation": {
                        "artifactLocation": {
                            "uri": finding.config_path,
                            "uriBaseId": "%SRCROOT%",
                        },
                        "region": {
                            "startLine": 1,
                            "startColumn": 1,
                        },
                    },
                }
            ]

        results.append(result)

    return results


def render_sarif(result: ScanResult) -> dict:
    """Generate a SARIF v2.1.0 compliant JSON document from scan results.

    The output conforms to the OASIS SARIF v2.1.0 specification and is
    compatible with GitHub's code scanning / Security tab upload.
    """
    sarif: dict = {
        "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "eigent-scan",
                        "semanticVersion": __version__,
                        "informationUri": "https://github.com/saichandrasekhar/Eigent",
                        "rules": _build_rules(result.findings),
                    },
                },
                "results": _build_results(result.findings),
                "invocations": [
                    {
                        "executionSuccessful": True,
                        "endTimeUtc": result.timestamp.isoformat() + "Z"
                        if not result.timestamp.isoformat().endswith("Z")
                        else result.timestamp.isoformat(),
                    }
                ],
                "properties": {
                    "scan_id": result.scan_id,
                    "targets_scanned": result.targets_scanned,
                    "total_agents": result.total_agents,
                    "scan_duration_seconds": result.scan_duration_seconds,
                },
            }
        ],
    }

    return sarif
