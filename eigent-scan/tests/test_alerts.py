"""Tests for the alerting system and config loading."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from eigent_scan.alerts import (
    AlertChannel,
    AlertConfig,
    _dedup_key,
    _format_generic_finding,
    _format_generic_summary,
    _format_pagerduty_finding,
    _format_pagerduty_summary,
    _format_slack_finding,
    _format_slack_summary,
    _meets_threshold,
    send_alert,
    send_scan_summary,
)
from eigent_scan.config import EigentConfig, load_config
from eigent_scan.diff import ScanDiff
from eigent_scan.models import (
    Agent,
    AgentSource,
    AuthStatus,
    Finding,
    ScanResult,
    Severity,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def critical_finding() -> Finding:
    return Finding(
        agent_name="unknown-mcp-server",
        severity=Severity.CRITICAL,
        title="Shadow agent detected",
        description="Unregistered MCP server running without config",
        recommendation="Register the server or remove it",
    )


@pytest.fixture()
def high_finding() -> Finding:
    return Finding(
        agent_name="code-runner",
        severity=Severity.HIGH,
        title="No authentication configured",
        description="MCP server exposes tools without authentication",
        recommendation="Add API key or OAuth authentication",
    )


@pytest.fixture()
def low_finding() -> Finding:
    return Finding(
        agent_name="docs-helper",
        severity=Severity.LOW,
        title="Verbose logging enabled",
        description="Server logs contain verbose debug output",
        recommendation="Reduce log level in production",
    )


@pytest.fixture()
def sample_result(critical_finding: Finding, high_finding: Finding) -> ScanResult:
    return ScanResult(
        targets_scanned=["mcp", "process"],
        agents=[
            Agent(name="server-a", source=AgentSource.MCP_CLAUDE, auth_status=AuthStatus.NONE),
            Agent(name="server-b", source=AgentSource.MCP_CURSOR, auth_status=AuthStatus.API_KEY),
        ],
        findings=[critical_finding, high_finding],
        scan_duration_seconds=1.5,
    )


@pytest.fixture()
def sample_diff() -> ScanDiff:
    return ScanDiff(
        new_agents=[
            Agent(name="new-server", source=AgentSource.MCP_CLAUDE, auth_status=AuthStatus.NONE),
        ],
        removed_agents=[],
        changed_agents=[],
        new_findings=[],
        resolved_findings=[],
        risk_change=(Severity.HIGH, Severity.CRITICAL),
    )


@pytest.fixture()
def slack_config() -> AlertConfig:
    return AlertConfig(
        webhook_url="https://hooks.slack.com/services/T00/B00/xxx",
        channel=AlertChannel.SLACK,
        min_severity=Severity.HIGH,
    )


@pytest.fixture()
def pagerduty_config() -> AlertConfig:
    return AlertConfig(
        webhook_url="https://events.pagerduty.com/v2/enqueue",
        channel=AlertChannel.PAGERDUTY,
        min_severity=Severity.CRITICAL,
        routing_key="test-routing-key-123",
    )


@pytest.fixture()
def generic_config() -> AlertConfig:
    return AlertConfig(
        webhook_url="https://example.com/webhook",
        channel=AlertChannel.GENERIC,
        min_severity=Severity.HIGH,
    )


# ---------------------------------------------------------------------------
# Threshold tests
# ---------------------------------------------------------------------------


class TestMeetsThreshold:
    def test_critical_meets_high(self) -> None:
        assert _meets_threshold(Severity.CRITICAL, Severity.HIGH) is True

    def test_high_meets_high(self) -> None:
        assert _meets_threshold(Severity.HIGH, Severity.HIGH) is True

    def test_medium_below_high(self) -> None:
        assert _meets_threshold(Severity.MEDIUM, Severity.HIGH) is False

    def test_low_below_high(self) -> None:
        assert _meets_threshold(Severity.LOW, Severity.HIGH) is False

    def test_info_below_high(self) -> None:
        assert _meets_threshold(Severity.INFO, Severity.HIGH) is False

    def test_critical_meets_critical(self) -> None:
        assert _meets_threshold(Severity.CRITICAL, Severity.CRITICAL) is True

    def test_high_below_critical(self) -> None:
        assert _meets_threshold(Severity.HIGH, Severity.CRITICAL) is False


# ---------------------------------------------------------------------------
# Slack format tests
# ---------------------------------------------------------------------------


class TestSlackFormat:
    def test_finding_has_blocks(self, critical_finding: Finding) -> None:
        payload = _format_slack_finding(critical_finding)
        assert "blocks" in payload
        assert len(payload["blocks"]) == 2

    def test_finding_header(self, critical_finding: Finding) -> None:
        payload = _format_slack_finding(critical_finding)
        header = payload["blocks"][0]
        assert header["type"] == "header"
        assert "CRITICAL" in header["text"]["text"]

    def test_finding_fields(self, critical_finding: Finding) -> None:
        payload = _format_slack_finding(critical_finding)
        section = payload["blocks"][1]
        assert section["type"] == "section"
        fields = section["fields"]
        assert len(fields) == 4

        field_texts = [f["text"] for f in fields]
        assert any("Shadow agent detected" in t for t in field_texts)
        assert any("CRITICAL" in t for t in field_texts)
        assert any("unknown-mcp-server" in t for t in field_texts)

    def test_summary_has_blocks(self, sample_result: ScanResult) -> None:
        payload = _format_slack_summary(sample_result, None)
        assert "blocks" in payload
        header = payload["blocks"][0]
        assert "Eigent Scan Complete" in header["text"]["text"]

    def test_summary_with_diff(self, sample_result: ScanResult, sample_diff: ScanDiff) -> None:
        payload = _format_slack_summary(sample_result, sample_diff)
        body = payload["blocks"][1]["text"]["text"]
        assert "+1" in body  # new_agents count
        assert "CRITICAL" in body

    def test_summary_without_diff(self, sample_result: ScanResult) -> None:
        payload = _format_slack_summary(sample_result, None)
        body = payload["blocks"][1]["text"]["text"]
        assert "Agents discovered" in body
        assert "New since last scan" not in body


# ---------------------------------------------------------------------------
# PagerDuty format tests
# ---------------------------------------------------------------------------


class TestPagerDutyFormat:
    def test_finding_structure(self, critical_finding: Finding) -> None:
        payload = _format_pagerduty_finding(critical_finding, "rk-123")
        assert payload["routing_key"] == "rk-123"
        assert payload["event_action"] == "trigger"
        assert payload["dedup_key"] == _dedup_key(critical_finding)

    def test_severity_mapping_critical(self, critical_finding: Finding) -> None:
        payload = _format_pagerduty_finding(critical_finding, "rk")
        assert payload["payload"]["severity"] == "critical"

    def test_severity_mapping_high(self, high_finding: Finding) -> None:
        payload = _format_pagerduty_finding(high_finding, "rk")
        assert payload["payload"]["severity"] == "error"

    def test_dedup_key_deterministic(self, critical_finding: Finding) -> None:
        key1 = _dedup_key(critical_finding)
        key2 = _dedup_key(critical_finding)
        assert key1 == key2
        assert len(key1) == 32

    def test_dedup_key_different_findings(
        self, critical_finding: Finding, high_finding: Finding
    ) -> None:
        assert _dedup_key(critical_finding) != _dedup_key(high_finding)

    def test_summary_payload(
        self, sample_result: ScanResult, sample_diff: ScanDiff
    ) -> None:
        payload = _format_pagerduty_summary(sample_result, sample_diff, "rk-123")
        assert payload["routing_key"] == "rk-123"
        assert payload["event_action"] == "trigger"
        details = payload["payload"]["custom_details"]
        assert details["new_agents"] == 1
        assert details["total_agents"] == 2


# ---------------------------------------------------------------------------
# Generic webhook format tests
# ---------------------------------------------------------------------------


class TestGenericFormat:
    def test_finding_payload(self, critical_finding: Finding) -> None:
        payload = _format_generic_finding(critical_finding)
        assert payload["event"] == "eigent.finding"
        assert payload["severity"] == "critical"
        assert payload["agent_name"] == "unknown-mcp-server"
        assert payload["title"] == "Shadow agent detected"

    def test_summary_payload(self, sample_result: ScanResult) -> None:
        payload = _format_generic_summary(sample_result, None)
        assert payload["event"] == "eigent.scan_complete"
        assert payload["total_agents"] == 2
        assert payload["critical_findings"] == 1
        assert "diff" not in payload

    def test_summary_with_diff(
        self, sample_result: ScanResult, sample_diff: ScanDiff
    ) -> None:
        payload = _format_generic_summary(sample_result, sample_diff)
        assert "diff" in payload
        assert payload["diff"]["new_agents"] == 1
        assert payload["diff"]["risk_change"] == ["high", "critical"]


# ---------------------------------------------------------------------------
# send_alert tests
# ---------------------------------------------------------------------------


class TestSendAlert:
    @patch("eigent_scan.alerts._post_webhook", return_value=True)
    def test_sends_when_above_threshold(
        self, mock_post: MagicMock, critical_finding: Finding, slack_config: AlertConfig
    ) -> None:
        result = send_alert(critical_finding, slack_config)
        assert result is True
        mock_post.assert_called_once()

    @patch("eigent_scan.alerts._post_webhook", return_value=True)
    def test_skips_when_below_threshold(
        self, mock_post: MagicMock, low_finding: Finding, slack_config: AlertConfig
    ) -> None:
        result = send_alert(low_finding, slack_config)
        assert result is False
        mock_post.assert_not_called()

    @patch("eigent_scan.alerts._post_webhook", return_value=True)
    def test_pagerduty_uses_events_url(
        self, mock_post: MagicMock, critical_finding: Finding, pagerduty_config: AlertConfig
    ) -> None:
        send_alert(critical_finding, pagerduty_config)
        call_args = mock_post.call_args
        assert "pagerduty.com" in call_args[0][0]

    @patch("eigent_scan.alerts._post_webhook", return_value=False)
    def test_returns_false_on_failure(
        self, mock_post: MagicMock, critical_finding: Finding, generic_config: AlertConfig
    ) -> None:
        result = send_alert(critical_finding, generic_config)
        assert result is False


# ---------------------------------------------------------------------------
# send_scan_summary tests
# ---------------------------------------------------------------------------


class TestSendScanSummary:
    @patch("eigent_scan.alerts._post_webhook", return_value=True)
    def test_sends_slack_summary(
        self,
        mock_post: MagicMock,
        sample_result: ScanResult,
        sample_diff: ScanDiff,
        slack_config: AlertConfig,
    ) -> None:
        result = send_scan_summary(sample_result, sample_diff, slack_config)
        assert result is True
        mock_post.assert_called_once()
        payload = mock_post.call_args[0][1]
        assert "blocks" in payload

    @patch("eigent_scan.alerts._post_webhook", return_value=True)
    def test_sends_generic_summary(
        self,
        mock_post: MagicMock,
        sample_result: ScanResult,
        generic_config: AlertConfig,
    ) -> None:
        result = send_scan_summary(sample_result, None, generic_config)
        assert result is True
        payload = mock_post.call_args[0][1]
        assert payload["event"] == "eigent.scan_complete"


# ---------------------------------------------------------------------------
# Config loading tests
# ---------------------------------------------------------------------------


class TestConfigLoading:
    def test_from_dict_slack(self) -> None:
        data = {
            "alerts": {
                "slack": {
                    "webhook_url": "https://hooks.slack.com/services/T00/B00/xxx",
                    "min_severity": "high",
                }
            },
            "scan": {"targets": ["mcp", "process"], "save_results": True},
        }
        config = EigentConfig.from_dict(data)
        assert len(config.alert_configs) == 1
        assert config.alert_configs[0].channel == AlertChannel.SLACK
        assert config.alert_configs[0].min_severity == Severity.HIGH
        assert config.scan.targets == ["mcp", "process"]
        assert config.scan.save_results is True

    def test_from_dict_pagerduty(self) -> None:
        data = {
            "alerts": {
                "pagerduty": {
                    "routing_key": "rk-123",
                    "min_severity": "critical",
                }
            }
        }
        config = EigentConfig.from_dict(data)
        assert len(config.alert_configs) == 1
        assert config.alert_configs[0].channel == AlertChannel.PAGERDUTY
        assert config.alert_configs[0].routing_key == "rk-123"
        assert config.alert_configs[0].min_severity == Severity.CRITICAL

    def test_from_dict_multiple_channels(self) -> None:
        data = {
            "alerts": {
                "slack": {
                    "webhook_url": "https://hooks.slack.com/services/T00/B00/xxx",
                    "min_severity": "high",
                },
                "pagerduty": {
                    "routing_key": "rk-456",
                    "min_severity": "critical",
                },
            }
        }
        config = EigentConfig.from_dict(data)
        assert len(config.alert_configs) == 2

    def test_from_dict_empty(self) -> None:
        config = EigentConfig.from_dict({})
        assert len(config.alert_configs) == 0
        assert config.scan.targets == ["mcp", "process"]

    def test_from_dict_pagerduty_missing_routing_key(self) -> None:
        data = {"alerts": {"pagerduty": {"min_severity": "critical"}}}
        config = EigentConfig.from_dict(data)
        assert len(config.alert_configs) == 0  # skipped

    def test_from_dict_missing_webhook_url(self) -> None:
        data = {"alerts": {"slack": {"min_severity": "high"}}}
        config = EigentConfig.from_dict(data)
        assert len(config.alert_configs) == 0  # skipped

    def test_load_config_no_file(self, tmp_path: Path) -> None:
        config = load_config(
            global_path=tmp_path / "nonexistent.yaml",
            project_path=tmp_path / "also-nonexistent.yaml",
        )
        assert isinstance(config, EigentConfig)
        assert len(config.alert_configs) == 0

    def test_load_config_from_file(self, tmp_path: Path) -> None:
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            """
alerts:
  slack:
    webhook_url: "https://hooks.slack.com/services/T00/B00/xxx"
    min_severity: high
scan:
  targets: [mcp]
  save_results: false
"""
        )
        config = load_config(global_path=config_file)
        assert len(config.alert_configs) == 1
        assert config.alert_configs[0].channel == AlertChannel.SLACK
        assert config.scan.targets == ["mcp"]
        assert config.scan.save_results is False

    def test_load_config_project_takes_precedence(self, tmp_path: Path) -> None:
        global_file = tmp_path / "global.yaml"
        global_file.write_text(
            """
alerts:
  slack:
    webhook_url: "https://hooks.slack.com/global"
    min_severity: low
"""
        )
        project_file = tmp_path / "project.yaml"
        project_file.write_text(
            """
alerts:
  slack:
    webhook_url: "https://hooks.slack.com/project"
    min_severity: critical
"""
        )
        config = load_config(global_path=global_file, project_path=project_file)
        assert config.alert_configs[0].webhook_url == "https://hooks.slack.com/project"
        assert config.alert_configs[0].min_severity == Severity.CRITICAL
