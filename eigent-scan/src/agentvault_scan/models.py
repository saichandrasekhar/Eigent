"""Data models for AgentVault scan results."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class Severity(str, Enum):
    """Risk severity levels."""

    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


class TransportType(str, Enum):
    """MCP server transport types."""

    STDIO = "stdio"
    SSE = "sse"
    HTTP = "http"
    UNKNOWN = "unknown"


class AuthStatus(str, Enum):
    """Authentication status for a discovered agent."""

    NONE = "none"
    API_KEY = "api_key"
    OAUTH = "oauth"
    IAM = "iam"
    UNKNOWN = "unknown"


class AgentSource(str, Enum):
    """Where the agent was discovered."""

    MCP_CLAUDE = "mcp_claude"
    MCP_CURSOR = "mcp_cursor"
    MCP_VSCODE = "mcp_vscode"
    MCP_WINDSURF = "mcp_windsurf"
    MCP_PROJECT = "mcp_project"
    AWS_BEDROCK = "aws_bedrock"
    AWS_LAMBDA = "aws_lambda"
    AWS_SAGEMAKER = "aws_sagemaker"
    AZURE_OPENAI = "azure_openai"
    GCP_VERTEX = "gcp_vertex"


class Agent(BaseModel):
    """A discovered AI agent or MCP server."""

    name: str
    source: AgentSource
    transport: TransportType = TransportType.UNKNOWN
    auth_status: AuthStatus = AuthStatus.UNKNOWN
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    env_vars: list[str] = Field(default_factory=list)
    url: str | None = None
    tools_exposed: list[str] = Field(default_factory=list)
    config_path: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class Finding(BaseModel):
    """A security finding related to a discovered agent."""

    agent_name: str
    severity: Severity
    title: str
    description: str
    recommendation: str
    config_path: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)


class ScanResult(BaseModel):
    """Complete result of an AgentVault scan."""

    scan_id: str = Field(default_factory=lambda: datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"))
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    targets_scanned: list[str] = Field(default_factory=list)
    agents: list[Agent] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    scan_duration_seconds: float = 0.0
    scanner_version: str = "0.1.0"

    @property
    def total_agents(self) -> int:
        return len(self.agents)

    @property
    def agents_no_auth(self) -> int:
        return sum(1 for a in self.agents if a.auth_status == AuthStatus.NONE)

    @property
    def critical_findings(self) -> int:
        return sum(1 for f in self.findings if f.severity == Severity.CRITICAL)

    @property
    def high_findings(self) -> int:
        return sum(1 for f in self.findings if f.severity == Severity.HIGH)

    @property
    def overall_risk(self) -> Severity:
        """Calculate the overall risk level based on findings."""
        if self.critical_findings > 0:
            return Severity.CRITICAL
        if self.high_findings > 0:
            return Severity.HIGH
        if any(f.severity == Severity.MEDIUM for f in self.findings):
            return Severity.MEDIUM
        if any(f.severity == Severity.LOW for f in self.findings):
            return Severity.LOW
        return Severity.INFO
