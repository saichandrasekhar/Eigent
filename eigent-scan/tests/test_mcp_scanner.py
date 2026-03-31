"""Tests for the MCP scanner."""

import json
import os
import stat
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from eigent_scan.models import AuthStatus, Severity, TransportType
from eigent_scan.scanners.mcp_scanner import (
    _analyze_agent_risks,
    _detect_auth,
    _parse_mcp_servers,
    _parse_single_server,
    scan,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_config_dir(tmp_path: Path):
    """Create a temporary config directory structure."""
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    return tmp_path


def _write_config(path: Path, data: dict) -> None:
    """Write a JSON config to a path, creating parents."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


# ---------------------------------------------------------------------------
# Config parsing tests
# ---------------------------------------------------------------------------

class TestParseMcpServers:
    """Test _parse_mcp_servers with different config formats."""

    def test_claude_desktop_format(self) -> None:
        data = {
            "mcpServers": {
                "filesystem": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                },
                "github": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-github"],
                    "env": {"GITHUB_TOKEN": "ghp_xxxxx"},
                },
            }
        }
        agents = _parse_mcp_servers(data, source="mcp_claude", config_path="/test/config.json")
        assert len(agents) == 2
        assert agents[0].name == "filesystem"
        assert agents[1].name == "github"

    def test_cursor_format(self) -> None:
        data = {
            "mcp.servers": {
                "my-server": {
                    "url": "http://localhost:3000/mcp",
                    "transport": "http",
                }
            }
        }
        agents = _parse_mcp_servers(data, source="mcp_cursor", config_path="/test/config.json")
        assert len(agents) == 1
        assert agents[0].name == "my-server"
        assert agents[0].transport == TransportType.HTTP

    def test_nested_mcp_servers(self) -> None:
        data = {
            "mcp": {
                "servers": {
                    "test-server": {"command": "node", "args": ["server.js"]},
                }
            }
        }
        agents = _parse_mcp_servers(data, source="mcp_vscode", config_path="/test/config.json")
        assert len(agents) == 1
        assert agents[0].name == "test-server"

    def test_empty_config(self) -> None:
        agents = _parse_mcp_servers({}, source="mcp_claude", config_path="/test/config.json")
        assert len(agents) == 0

    def test_non_dict_servers(self) -> None:
        data = {"mcpServers": "not-a-dict"}
        agents = _parse_mcp_servers(data, source="mcp_claude", config_path="/test/config.json")
        assert len(agents) == 0

    def test_non_dict_server_entry(self) -> None:
        data = {"mcpServers": {"bad": "not-a-dict"}}
        agents = _parse_mcp_servers(data, source="mcp_claude", config_path="/test/config.json")
        assert len(agents) == 0


# ---------------------------------------------------------------------------
# Transport detection tests
# ---------------------------------------------------------------------------

class TestTransportDetection:
    """Test transport type detection."""

    def test_stdio_from_command(self) -> None:
        agent = _parse_single_server(
            "test", {"command": "node", "args": ["server.js"]},
            source="mcp_claude", config_path="/test"
        )
        assert agent.transport == TransportType.STDIO

    def test_http_from_url(self) -> None:
        agent = _parse_single_server(
            "test", {"url": "http://localhost:3000/mcp"},
            source="mcp_claude", config_path="/test"
        )
        assert agent.transport == TransportType.HTTP

    def test_sse_from_url_keyword(self) -> None:
        agent = _parse_single_server(
            "test", {"url": "http://localhost:3000/sse"},
            source="mcp_claude", config_path="/test"
        )
        assert agent.transport == TransportType.SSE

    def test_explicit_transport_override(self) -> None:
        agent = _parse_single_server(
            "test", {"command": "node", "transport": "http"},
            source="mcp_claude", config_path="/test"
        )
        assert agent.transport == TransportType.HTTP


# ---------------------------------------------------------------------------
# Auth detection tests
# ---------------------------------------------------------------------------

class TestAuthDetection:
    """Test authentication detection."""

    def test_no_auth_stdio(self) -> None:
        result = _detect_auth({"command": "node"}, TransportType.STDIO)
        assert result == AuthStatus.NONE

    def test_auth_from_env_vars(self) -> None:
        config = {"env": {"GITHUB_TOKEN": "ghp_xxxxx"}}
        result = _detect_auth(config, TransportType.STDIO)
        assert result == AuthStatus.API_KEY

    def test_auth_from_headers(self) -> None:
        config = {"headers": {"Authorization": "Bearer xxx"}}
        result = _detect_auth(config, TransportType.HTTP)
        assert result == AuthStatus.API_KEY

    def test_oauth_auth(self) -> None:
        config = {"auth": {"oauth": {"client_id": "xxx"}}}
        result = _detect_auth(config, TransportType.HTTP)
        assert result == AuthStatus.OAUTH

    def test_api_key_in_auth(self) -> None:
        config = {"auth": {"apiKey": "xxx"}}
        result = _detect_auth(config, TransportType.HTTP)
        assert result == AuthStatus.API_KEY

    def test_no_auth_http(self) -> None:
        result = _detect_auth({}, TransportType.HTTP)
        assert result == AuthStatus.NONE


# ---------------------------------------------------------------------------
# Risk analysis tests
# ---------------------------------------------------------------------------

class TestRiskAnalysis:
    """Test security finding generation."""

    def test_no_auth_finding(self) -> None:
        agent = _parse_single_server(
            "test-server", {"command": "node", "args": ["server.js"]},
            source="mcp_claude", config_path="/test"
        )
        findings = _analyze_agent_risks(agent)
        no_auth_findings = [f for f in findings if "No authentication" in f.title]
        assert len(no_auth_findings) == 1

    def test_high_risk_server_pattern(self) -> None:
        agent = _parse_single_server(
            "filesystem-server", {"command": "npx", "args": ["@mcp/filesystem"]},
            source="mcp_claude", config_path="/test"
        )
        findings = _analyze_agent_risks(agent)
        high_risk = [f for f in findings if "broad system access" in f.title]
        assert len(high_risk) == 1
        assert high_risk[0].severity == Severity.CRITICAL  # No auth + high risk = critical

    def test_secrets_in_env(self) -> None:
        agent = _parse_single_server(
            "github", {"command": "node", "env": {"GITHUB_TOKEN": "xxx", "NODE_ENV": "prod"}},
            source="mcp_claude", config_path="/test"
        )
        findings = _analyze_agent_risks(agent)
        secret_findings = [f for f in findings if "Secrets passed" in f.title]
        assert len(secret_findings) == 1

    def test_npx_supply_chain_risk(self) -> None:
        agent = _parse_single_server(
            "test", {"command": "npx", "args": ["some-mcp-server"]},
            source="mcp_claude", config_path="/test"
        )
        findings = _analyze_agent_risks(agent)
        supply_chain = [f for f in findings if "package runner" in f.title]
        assert len(supply_chain) == 1

    def test_disabled_server_finding(self) -> None:
        agent = _parse_single_server(
            "old-server", {"command": "node", "disabled": True},
            source="mcp_claude", config_path="/test"
        )
        findings = _analyze_agent_risks(agent)
        disabled = [f for f in findings if "Disabled server" in f.title]
        assert len(disabled) == 1
        assert disabled[0].severity == Severity.LOW


# ---------------------------------------------------------------------------
# Integration test — full scan
# ---------------------------------------------------------------------------

class TestFullScan:
    """Test the full scan function."""

    def test_scan_returns_tuple(self) -> None:
        agents, findings, logs = scan(verbose=False)
        assert isinstance(agents, list)
        assert isinstance(findings, list)
        assert isinstance(logs, list)

    def test_scan_with_mock_config(self, tmp_path: Path) -> None:
        config_file = tmp_path / ".claude" / "settings.json"
        config_file.parent.mkdir(parents=True)
        config_file.write_text(json.dumps({
            "mcpServers": {
                "test-filesystem": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                },
                "test-api": {
                    "url": "http://localhost:8080/mcp",
                    "headers": {"Authorization": "Bearer test-token"},
                },
            }
        }))

        # Patch home directory
        with patch("eigent_scan.scanners.mcp_scanner.Path.home", return_value=tmp_path):
            agents, findings, logs = scan(verbose=True)

        assert len(agents) == 2
        fs_agent = next(a for a in agents if a.name == "test-filesystem")
        assert fs_agent.transport == TransportType.STDIO
        assert fs_agent.auth_status == AuthStatus.NONE

        api_agent = next(a for a in agents if a.name == "test-api")
        assert api_agent.transport == TransportType.HTTP
        assert api_agent.auth_status == AuthStatus.API_KEY

        # filesystem server should have high-risk + no-auth findings
        fs_findings = [f for f in findings if f.agent_name == "test-filesystem"]
        assert any("broad system access" in f.title for f in fs_findings)
