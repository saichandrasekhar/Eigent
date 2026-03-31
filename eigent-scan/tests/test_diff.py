"""Tests for the scan diff engine."""

from __future__ import annotations

import pytest

from eigent_scan.diff import AgentChange, ScanDiff, diff_results, format_diff_text
from eigent_scan.models import (
    Agent,
    AgentSource,
    AuthStatus,
    Finding,
    ScanResult,
    Severity,
    TransportType,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_agent(
    name: str = "server",
    source: AgentSource = AgentSource.MCP_CLAUDE,
    auth: AuthStatus = AuthStatus.NONE,
    transport: TransportType = TransportType.STDIO,
    tools: list[str] | None = None,
    command: str | None = "npx",
    config_path: str | None = "/test/config.json",
) -> Agent:
    return Agent(
        name=name,
        source=source,
        auth_status=auth,
        transport=transport,
        tools_exposed=tools or [],
        command=command,
        config_path=config_path,
    )


def _make_finding(
    agent_name: str = "server",
    severity: Severity = Severity.HIGH,
    title: str = "Test finding",
) -> Finding:
    return Finding(
        agent_name=agent_name,
        severity=severity,
        title=title,
        description="Test description",
        recommendation="Fix it",
    )


# ---------------------------------------------------------------------------
# Tests: diff_results
# ---------------------------------------------------------------------------


class TestDiffResults:
    """Test the diff_results function."""

    def test_identical_scans_no_changes(self) -> None:
        agent = _make_agent()
        finding = _make_finding()
        prev = ScanResult(scan_id="1", agents=[agent], findings=[finding])
        curr = ScanResult(scan_id="2", agents=[agent], findings=[finding])

        d = diff_results(prev, curr)
        assert not d.new_agents
        assert not d.removed_agents
        assert not d.changed_agents
        assert not d.new_findings
        assert not d.resolved_findings
        assert d.risk_change is not None
        assert d.risk_change[0] == d.risk_change[1]

    def test_new_agent_detected(self) -> None:
        prev = ScanResult(scan_id="1", agents=[])
        curr = ScanResult(scan_id="2", agents=[_make_agent(name="new-server")])

        d = diff_results(prev, curr)
        assert len(d.new_agents) == 1
        assert d.new_agents[0].name == "new-server"
        assert not d.removed_agents

    def test_removed_agent_detected(self) -> None:
        prev = ScanResult(scan_id="1", agents=[_make_agent(name="old-server")])
        curr = ScanResult(scan_id="2", agents=[])

        d = diff_results(prev, curr)
        assert len(d.removed_agents) == 1
        assert d.removed_agents[0].name == "old-server"
        assert not d.new_agents

    def test_agent_auth_change(self) -> None:
        prev = ScanResult(
            scan_id="1",
            agents=[_make_agent(auth=AuthStatus.NONE)],
        )
        curr = ScanResult(
            scan_id="2",
            agents=[_make_agent(auth=AuthStatus.API_KEY)],
        )

        d = diff_results(prev, curr)
        assert len(d.changed_agents) == 1
        assert any("Auth changed" in c for c in d.changed_agents[0].changes)

    def test_agent_new_tools_exposed(self) -> None:
        prev = ScanResult(
            scan_id="1",
            agents=[_make_agent(tools=["read"])],
        )
        curr = ScanResult(
            scan_id="2",
            agents=[_make_agent(tools=["read", "write", "delete"])],
        )

        d = diff_results(prev, curr)
        assert len(d.changed_agents) == 1
        changes_text = " ".join(d.changed_agents[0].changes)
        assert "New tools exposed" in changes_text
        assert "write" in changes_text
        assert "delete" in changes_text

    def test_agent_tools_removed(self) -> None:
        prev = ScanResult(
            scan_id="1",
            agents=[_make_agent(tools=["read", "write"])],
        )
        curr = ScanResult(
            scan_id="2",
            agents=[_make_agent(tools=["read"])],
        )

        d = diff_results(prev, curr)
        assert len(d.changed_agents) == 1
        changes_text = " ".join(d.changed_agents[0].changes)
        assert "Tools removed" in changes_text

    def test_agent_matching_by_name_and_source(self) -> None:
        """Same name but different source = different agent."""
        agent_claude = _make_agent(name="fs", source=AgentSource.MCP_CLAUDE)
        agent_cursor = _make_agent(name="fs", source=AgentSource.MCP_CURSOR)

        prev = ScanResult(scan_id="1", agents=[agent_claude])
        curr = ScanResult(scan_id="2", agents=[agent_cursor])

        d = diff_results(prev, curr)
        assert len(d.new_agents) == 1
        assert len(d.removed_agents) == 1

    def test_new_finding(self) -> None:
        prev = ScanResult(scan_id="1", findings=[])
        curr = ScanResult(
            scan_id="2",
            findings=[_make_finding(title="New issue")],
        )

        d = diff_results(prev, curr)
        assert len(d.new_findings) == 1
        assert d.new_findings[0].title == "New issue"

    def test_resolved_finding(self) -> None:
        prev = ScanResult(
            scan_id="1",
            findings=[_make_finding(title="Old issue")],
        )
        curr = ScanResult(scan_id="2", findings=[])

        d = diff_results(prev, curr)
        assert len(d.resolved_findings) == 1
        assert d.resolved_findings[0].title == "Old issue"

    def test_finding_matching_by_agent_and_title(self) -> None:
        """Same title but different agent = different finding."""
        f1 = _make_finding(agent_name="server-a", title="No auth")
        f2 = _make_finding(agent_name="server-b", title="No auth")

        prev = ScanResult(scan_id="1", findings=[f1])
        curr = ScanResult(scan_id="2", findings=[f2])

        d = diff_results(prev, curr)
        assert len(d.new_findings) == 1
        assert len(d.resolved_findings) == 1

    def test_risk_change(self) -> None:
        prev = ScanResult(
            scan_id="1",
            findings=[_make_finding(severity=Severity.MEDIUM)],
        )
        curr = ScanResult(
            scan_id="2",
            findings=[_make_finding(severity=Severity.CRITICAL)],
        )

        d = diff_results(prev, curr)
        assert d.risk_change == (Severity.MEDIUM, Severity.CRITICAL)

    def test_transport_change(self) -> None:
        prev = ScanResult(
            scan_id="1",
            agents=[_make_agent(transport=TransportType.STDIO)],
        )
        curr = ScanResult(
            scan_id="2",
            agents=[_make_agent(transport=TransportType.HTTP)],
        )

        d = diff_results(prev, curr)
        assert len(d.changed_agents) == 1
        assert any("Transport changed" in c for c in d.changed_agents[0].changes)


# ---------------------------------------------------------------------------
# Tests: ScanDiff.has_changes
# ---------------------------------------------------------------------------


class TestScanDiffHasChanges:
    def test_empty_diff(self) -> None:
        d = ScanDiff()
        assert not d.has_changes

    def test_same_risk_no_changes(self) -> None:
        d = ScanDiff(risk_change=(Severity.INFO, Severity.INFO))
        assert not d.has_changes

    def test_risk_change_counts(self) -> None:
        d = ScanDiff(risk_change=(Severity.LOW, Severity.HIGH))
        assert d.has_changes

    def test_new_agent_counts(self) -> None:
        d = ScanDiff(new_agents=[_make_agent()])
        assert d.has_changes


# ---------------------------------------------------------------------------
# Tests: format_diff_text
# ---------------------------------------------------------------------------


class TestFormatDiffText:
    def test_no_changes(self) -> None:
        d = ScanDiff()
        text = format_diff_text(d)
        assert "No changes" in text

    def test_with_changes(self) -> None:
        d = ScanDiff(
            new_agents=[_make_agent(name="new-srv")],
            removed_agents=[_make_agent(name="old-srv")],
            new_findings=[_make_finding(title="Bad config")],
            resolved_findings=[_make_finding(title="Fixed issue")],
            risk_change=(Severity.LOW, Severity.HIGH),
        )
        text = format_diff_text(d)
        assert "new-srv" in text
        assert "old-srv" in text
        assert "Bad config" in text
        assert "Fixed issue" in text
        assert "LOW" in text
        assert "HIGH" in text

    def test_changed_agents_in_text(self) -> None:
        d = ScanDiff(
            changed_agents=[
                AgentChange(
                    agent_name="server",
                    source="mcp_claude",
                    changes=["Auth changed: none -> api_key"],
                )
            ]
        )
        text = format_diff_text(d)
        assert "server" in text
        assert "Auth changed" in text
