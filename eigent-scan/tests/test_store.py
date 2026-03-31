"""Tests for the SQLite scan result store."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from eigent_scan.models import (
    Agent,
    AgentSource,
    AuthStatus,
    Finding,
    ScanResult,
    Severity,
    TransportType,
)
from eigent_scan.store import ScanStore


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> ScanStore:
    """Return a ScanStore backed by a temporary database."""
    return ScanStore(db_path=tmp_path / "test_scans.db")


@pytest.fixture
def sample_result() -> ScanResult:
    """Return a sample ScanResult for testing."""
    return ScanResult(
        scan_id="test-001",
        targets_scanned=["mcp"],
        agents=[
            Agent(
                name="filesystem",
                source=AgentSource.MCP_CLAUDE,
                transport=TransportType.STDIO,
                auth_status=AuthStatus.NONE,
                command="npx",
                args=["-y", "@modelcontextprotocol/server-filesystem"],
                config_path="/home/user/.claude/settings.json",
            ),
            Agent(
                name="github",
                source=AgentSource.MCP_CURSOR,
                transport=TransportType.STDIO,
                auth_status=AuthStatus.API_KEY,
                command="npx",
                args=["-y", "@modelcontextprotocol/server-github"],
                env_vars=["GITHUB_TOKEN"],
                config_path="/home/user/.cursor/mcp.json",
            ),
        ],
        findings=[
            Finding(
                agent_name="filesystem",
                severity=Severity.CRITICAL,
                title="High-risk server 'filesystem' grants broad system access",
                description="Filesystem access without auth.",
                recommendation="Add authentication.",
                config_path="/home/user/.claude/settings.json",
            ),
            Finding(
                agent_name="filesystem",
                severity=Severity.MEDIUM,
                title="No authentication configured for 'filesystem'",
                description="No auth detected.",
                recommendation="Configure auth.",
            ),
        ],
        scan_duration_seconds=0.42,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestScanStore:
    """Test ScanStore CRUD operations."""

    def test_save_and_retrieve(self, store: ScanStore, sample_result: ScanResult) -> None:
        scan_id = store.save_result(sample_result)
        assert scan_id == "test-001"

        retrieved = store.get_result(scan_id)
        assert retrieved.scan_id == sample_result.scan_id
        assert retrieved.total_agents == 2
        assert len(retrieved.findings) == 2
        assert retrieved.agents[0].name == "filesystem"
        assert retrieved.agents[1].name == "github"

    def test_get_result_not_found(self, store: ScanStore) -> None:
        with pytest.raises(KeyError, match="not-a-real-id"):
            store.get_result("not-a-real-id")

    def test_list_results_empty(self, store: ScanStore) -> None:
        results = store.list_results()
        assert results == []

    def test_list_results_ordering(self, store: ScanStore) -> None:
        for i in range(5):
            result = ScanResult(
                scan_id=f"scan-{i:03d}",
                targets_scanned=["mcp"],
            )
            store.save_result(result)

        summaries = store.list_results(limit=3)
        assert len(summaries) == 3
        # Most recent first (highest scan_id number = latest timestamp)
        assert summaries[0].id == "scan-004"
        assert summaries[1].id == "scan-003"
        assert summaries[2].id == "scan-002"

    def test_list_results_summary_fields(
        self, store: ScanStore, sample_result: ScanResult
    ) -> None:
        store.save_result(sample_result)
        summaries = store.list_results()
        assert len(summaries) == 1

        s = summaries[0]
        assert s.id == "test-001"
        assert s.targets == "mcp"
        assert s.total_agents == 2
        assert s.total_findings == 2
        assert s.critical_findings == 1
        assert s.overall_risk == "critical"

    def test_get_latest_empty(self, store: ScanStore) -> None:
        assert store.get_latest() is None

    def test_get_latest(self, store: ScanStore) -> None:
        store.save_result(ScanResult(scan_id="old", targets_scanned=["mcp"]))
        store.save_result(ScanResult(scan_id="new", targets_scanned=["aws"]))

        latest = store.get_latest()
        assert latest is not None
        assert latest.scan_id == "new"

    def test_save_replaces_existing(
        self, store: ScanStore, sample_result: ScanResult
    ) -> None:
        store.save_result(sample_result)
        # Save again with same id -- should replace
        store.save_result(sample_result)
        summaries = store.list_results()
        assert len(summaries) == 1

    def test_tables_auto_created(self, tmp_path: Path) -> None:
        db_path = tmp_path / "new.db"
        assert not db_path.exists()
        store = ScanStore(db_path=db_path)
        assert db_path.exists()
        # Should be able to list with no errors
        assert store.list_results() == []

    def test_finding_severity_preserved(self, store: ScanStore) -> None:
        result = ScanResult(
            scan_id="sev-test",
            findings=[
                Finding(
                    agent_name="a",
                    severity=Severity.HIGH,
                    title="High issue",
                    description="desc",
                    recommendation="fix",
                ),
            ],
        )
        store.save_result(result)
        retrieved = store.get_result("sev-test")
        assert retrieved.findings[0].severity == Severity.HIGH

    def test_agent_fields_preserved(self, store: ScanStore) -> None:
        result = ScanResult(
            scan_id="agent-test",
            agents=[
                Agent(
                    name="test-server",
                    source=AgentSource.MCP_VSCODE,
                    transport=TransportType.HTTP,
                    auth_status=AuthStatus.OAUTH,
                    url="http://localhost:3000",
                    tools_exposed=["read", "write"],
                    config_path="/path/to/config",
                ),
            ],
        )
        store.save_result(result)
        retrieved = store.get_result("agent-test")
        agent = retrieved.agents[0]
        assert agent.name == "test-server"
        assert agent.source == AgentSource.MCP_VSCODE
        assert agent.transport == TransportType.HTTP
        assert agent.auth_status == AuthStatus.OAUTH
        assert agent.url == "http://localhost:3000"
        assert agent.tools_exposed == ["read", "write"]
