"""Pydantic models for the Eigent SDK."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Session(BaseModel):
    """Represents an authenticated human session (dev-mode or OIDC)."""

    human_sub: str
    human_email: str
    human_iss: str
    session_token: str | None = None
    identity_verified: bool = False


class Agent(BaseModel):
    """Registered agent returned by the registry."""

    agent_id: str
    token: str
    scope: list[str]
    expires_at: str
    identity_verified: bool = False
    name: str | None = None
    risk_level: str | None = None


class DelegationResult(BaseModel):
    """Result of delegating permissions to a child agent."""

    child_agent_id: str
    token: str
    granted_scope: list[str]
    denied_scope: list[str] = Field(default_factory=list)
    delegation_depth: int
    expires_at: str


class VerifyResult(BaseModel):
    """Result of verifying a token against a specific tool."""

    allowed: bool
    agent_id: str | None = None
    human_email: str | None = None
    delegation_chain: list[str] | None = None
    reason: str | None = None


class RevocationResult(BaseModel):
    """Result of revoking an agent (with cascade)."""

    revoked_agent_id: str
    cascade_revoked: list[str] = Field(default_factory=list)
    total_revoked: int


class AuditEvent(BaseModel):
    """A single entry from the audit log."""

    id: str
    timestamp: str
    agent_id: str
    human_email: str
    action: str
    tool_name: str | None = None
    delegation_chain: list[str] | None = None
    details: dict[str, Any] | None = None


class AuditResponse(BaseModel):
    """Paginated audit log response."""

    entries: list[AuditEvent]
    total: int
    limit: int
    offset: int


class ComplianceReport(BaseModel):
    """Compliance report metadata (HTML body stored separately)."""

    report_html: str
    generated_at: str
    period: dict[str, str]
    framework: str


class AuditVerifyResult(BaseModel):
    """Result of verifying the audit chain integrity."""

    valid: bool
    broken_at: str | None = None
    total_events: int = 0
