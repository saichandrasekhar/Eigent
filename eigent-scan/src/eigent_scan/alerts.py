"""Webhook alerting system for Eigent scanner findings."""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import httpx

from eigent_scan.diff import ScanDiff
from eigent_scan.models import Finding, ScanResult, Severity

logger = logging.getLogger(__name__)

_SEVERITY_ORDER = {
    Severity.CRITICAL: 0,
    Severity.HIGH: 1,
    Severity.MEDIUM: 2,
    Severity.LOW: 3,
    Severity.INFO: 4,
}

_SEVERITY_EMOJI = {
    Severity.CRITICAL: "\U0001f6a8",  # rotating light
    Severity.HIGH: "\u26a0\ufe0f",  # warning
    Severity.MEDIUM: "\U0001f7e1",  # yellow circle
    Severity.LOW: "\U0001f535",  # blue circle
    Severity.INFO: "\u2139\ufe0f",  # info
}

_PD_SEVERITY_MAP = {
    Severity.CRITICAL: "critical",
    Severity.HIGH: "error",
    Severity.MEDIUM: "warning",
    Severity.LOW: "warning",
    Severity.INFO: "info",
}


class AlertChannel(str, Enum):
    """Supported alert channel types."""

    SLACK = "slack"
    PAGERDUTY = "pagerduty"
    GENERIC = "generic"


@dataclass(frozen=True)
class AlertConfig:
    """Configuration for a single alert destination."""

    webhook_url: str
    channel: AlertChannel = AlertChannel.GENERIC
    min_severity: Severity = Severity.HIGH
    routing_key: str | None = None  # PagerDuty only
    extra_headers: dict[str, str] = field(default_factory=dict)


def _meets_threshold(severity: Severity, min_severity: Severity) -> bool:
    """Return True if severity is at or above the minimum threshold."""
    return _SEVERITY_ORDER.get(severity, 4) <= _SEVERITY_ORDER.get(min_severity, 1)


# ---------------------------------------------------------------------------
# Slack formatting
# ---------------------------------------------------------------------------


def _format_slack_finding(finding: Finding) -> dict[str, Any]:
    """Build a Slack Block Kit payload for a single finding."""
    emoji = _SEVERITY_EMOJI.get(finding.severity, "")
    return {
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": f"{emoji} Eigent: {finding.severity.value.upper()} Finding",
                },
            },
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*Finding:*\n{finding.title}"},
                    {
                        "type": "mrkdwn",
                        "text": f"*Severity:*\n{finding.severity.value.upper()}",
                    },
                    {"type": "mrkdwn", "text": f"*Agent:*\n{finding.agent_name}"},
                    {"type": "mrkdwn", "text": f"*Risk:*\n{finding.description}"},
                ],
            },
        ]
    }


def _format_slack_summary(result: ScanResult, diff: ScanDiff | None) -> dict[str, Any]:
    """Build a Slack Block Kit payload for a scan summary."""
    shadow_count = sum(
        1 for f in result.findings if "shadow" in f.title.lower() or "unregistered" in f.title.lower()
    )

    lines = [
        f"*Agents discovered:* {result.total_agents}",
    ]

    if diff is not None:
        new_count = len(diff.new_agents)
        lines.append(f"*New since last scan:* +{new_count}")

    lines.append(f"*Critical findings:* {result.critical_findings}")

    if shadow_count > 0:
        lines.append(f"*Shadow agents:* {shadow_count} \u26a0\ufe0f")

    risk_text = result.overall_risk.value.upper()
    if diff is not None and diff.risk_change and diff.risk_change[0] != diff.risk_change[1]:
        old_risk, new_risk = diff.risk_change
        arrow = "\u2191" if _SEVERITY_ORDER[new_risk] < _SEVERITY_ORDER[old_risk] else "\u2193"
        risk_text = f"{old_risk.value.upper()} \u2192 {new_risk.value.upper()} {arrow}"
    lines.append(f"*Overall risk:* {risk_text}")

    body_text = "\n".join(f"\u2022 {line}" for line in lines)

    return {
        "blocks": [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": "Eigent Scan Complete"},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": body_text},
            },
        ]
    }


# ---------------------------------------------------------------------------
# PagerDuty formatting
# ---------------------------------------------------------------------------


def _dedup_key(finding: Finding) -> str:
    """Generate a deterministic dedup key from agent name and finding title."""
    raw = f"{finding.agent_name}:{finding.title}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _format_pagerduty_finding(finding: Finding, routing_key: str) -> dict[str, Any]:
    """Build a PagerDuty Events API v2 payload for a single finding."""
    return {
        "routing_key": routing_key,
        "dedup_key": _dedup_key(finding),
        "event_action": "trigger",
        "payload": {
            "summary": f"Eigent: [{finding.severity.value.upper()}] {finding.title} ({finding.agent_name})",
            "source": "eigent-scan",
            "severity": _PD_SEVERITY_MAP.get(finding.severity, "info"),
            "custom_details": {
                "agent_name": finding.agent_name,
                "title": finding.title,
                "description": finding.description,
                "recommendation": finding.recommendation,
                "config_path": finding.config_path,
            },
        },
    }


def _format_pagerduty_summary(
    result: ScanResult, diff: ScanDiff | None, routing_key: str
) -> dict[str, Any]:
    """Build a PagerDuty Events API v2 payload for a scan summary."""
    severity = _PD_SEVERITY_MAP.get(result.overall_risk, "info")
    summary = (
        f"Eigent scan complete: {result.total_agents} agents, "
        f"{result.critical_findings} critical findings, "
        f"risk={result.overall_risk.value.upper()}"
    )
    custom: dict[str, Any] = {
        "total_agents": result.total_agents,
        "critical_findings": result.critical_findings,
        "high_findings": result.high_findings,
        "overall_risk": result.overall_risk.value,
    }
    if diff is not None:
        custom["new_agents"] = len(diff.new_agents)
        custom["removed_agents"] = len(diff.removed_agents)
        custom["new_findings"] = len(diff.new_findings)
        custom["resolved_findings"] = len(diff.resolved_findings)

    return {
        "routing_key": routing_key,
        "dedup_key": f"eigent-scan-summary-{result.scan_id}",
        "event_action": "trigger",
        "payload": {
            "summary": summary,
            "source": "eigent-scan",
            "severity": severity,
            "custom_details": custom,
        },
    }


# ---------------------------------------------------------------------------
# Generic webhook formatting
# ---------------------------------------------------------------------------


def _format_generic_finding(finding: Finding) -> dict[str, Any]:
    """Build a plain JSON payload for a generic webhook."""
    return {
        "event": "eigent.finding",
        "agent_name": finding.agent_name,
        "severity": finding.severity.value,
        "title": finding.title,
        "description": finding.description,
        "recommendation": finding.recommendation,
        "config_path": finding.config_path,
        "evidence": finding.evidence,
    }


def _format_generic_summary(result: ScanResult, diff: ScanDiff | None) -> dict[str, Any]:
    """Build a plain JSON payload for a generic webhook scan summary."""
    payload: dict[str, Any] = {
        "event": "eigent.scan_complete",
        "scan_id": result.scan_id,
        "total_agents": result.total_agents,
        "total_findings": len(result.findings),
        "critical_findings": result.critical_findings,
        "high_findings": result.high_findings,
        "overall_risk": result.overall_risk.value,
        "scan_duration_seconds": result.scan_duration_seconds,
    }
    if diff is not None:
        payload["diff"] = {
            "new_agents": len(diff.new_agents),
            "removed_agents": len(diff.removed_agents),
            "new_findings": len(diff.new_findings),
            "resolved_findings": len(diff.resolved_findings),
            "risk_change": (
                [diff.risk_change[0].value, diff.risk_change[1].value]
                if diff.risk_change
                else None
            ),
        }
    return payload


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

_PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue"


def _post_webhook(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> bool:
    """POST a JSON payload to the given URL. Returns True on success (2xx)."""
    all_headers = {"Content-Type": "application/json"}
    if headers:
        all_headers.update(headers)
    try:
        response = httpx.post(url, json=payload, headers=all_headers, timeout=10.0)
        if response.is_success:
            logger.info("Alert sent successfully to %s (status %d)", url, response.status_code)
            return True
        logger.warning(
            "Alert webhook returned %d: %s", response.status_code, response.text[:200]
        )
        return False
    except httpx.HTTPError as exc:
        logger.error("Failed to send alert to %s: %s", url, exc)
        return False


def send_alert(finding: Finding, config: AlertConfig) -> bool:
    """Send an alert for a single finding if it meets the severity threshold.

    Returns True if the alert was sent successfully, False otherwise.
    Returns False (without sending) if the finding does not meet the
    minimum severity threshold.
    """
    if not _meets_threshold(finding.severity, config.min_severity):
        logger.debug(
            "Finding '%s' severity %s below threshold %s, skipping alert",
            finding.title,
            finding.severity.value,
            config.min_severity.value,
        )
        return False

    if config.channel == AlertChannel.SLACK:
        payload = _format_slack_finding(finding)
        return _post_webhook(config.webhook_url, payload, dict(config.extra_headers))

    if config.channel == AlertChannel.PAGERDUTY:
        routing_key = config.routing_key or ""
        payload = _format_pagerduty_finding(finding, routing_key)
        return _post_webhook(
            _PAGERDUTY_EVENTS_URL, payload, dict(config.extra_headers)
        )

    # Generic
    payload = _format_generic_finding(finding)
    return _post_webhook(config.webhook_url, payload, dict(config.extra_headers))


def send_scan_summary(
    result: ScanResult,
    diff: ScanDiff | None,
    config: AlertConfig,
) -> bool:
    """Send a scan summary alert.

    Returns True if the alert was sent successfully, False otherwise.
    """
    if config.channel == AlertChannel.SLACK:
        payload = _format_slack_summary(result, diff)
        return _post_webhook(config.webhook_url, payload, dict(config.extra_headers))

    if config.channel == AlertChannel.PAGERDUTY:
        routing_key = config.routing_key or ""
        payload = _format_pagerduty_summary(result, diff, routing_key)
        return _post_webhook(
            _PAGERDUTY_EVENTS_URL, payload, dict(config.extra_headers)
        )

    # Generic
    payload = _format_generic_summary(result, diff)
    return _post_webhook(config.webhook_url, payload, dict(config.extra_headers))
