"""Tests for data models."""

from eigent_scan.models import (
    Agent,
    AgentSource,
    AuthStatus,
    Finding,
    ScanResult,
    Severity,
    TransportType,
)


class TestScanResult:
    """Test ScanResult computed properties."""

    def test_empty_result(self) -> None:
        result = ScanResult()
        assert result.total_agents == 0
        assert result.agents_no_auth == 0
        assert result.critical_findings == 0
        assert result.overall_risk == Severity.INFO

    def test_risk_level_critical(self) -> None:
        result = ScanResult(
            findings=[
                Finding(
                    agent_name="test",
                    severity=Severity.CRITICAL,
                    title="Critical issue",
                    description="desc",
                    recommendation="fix it",
                )
            ]
        )
        assert result.overall_risk == Severity.CRITICAL
        assert result.critical_findings == 1

    def test_risk_level_medium(self) -> None:
        result = ScanResult(
            findings=[
                Finding(
                    agent_name="test",
                    severity=Severity.MEDIUM,
                    title="Medium issue",
                    description="desc",
                    recommendation="fix it",
                )
            ]
        )
        assert result.overall_risk == Severity.MEDIUM

    def test_agents_no_auth_count(self) -> None:
        result = ScanResult(
            agents=[
                Agent(name="a", source=AgentSource.MCP_CLAUDE, auth_status=AuthStatus.NONE),
                Agent(name="b", source=AgentSource.MCP_CLAUDE, auth_status=AuthStatus.API_KEY),
                Agent(name="c", source=AgentSource.MCP_CLAUDE, auth_status=AuthStatus.NONE),
            ]
        )
        assert result.agents_no_auth == 2
        assert result.total_agents == 3
