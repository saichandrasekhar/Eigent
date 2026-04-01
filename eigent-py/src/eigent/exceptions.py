"""Structured exception types for the Eigent SDK.

Every exception carries a ``fix`` attribute with an actionable suggestion so
that callers (and LLM agents) can self-heal without human intervention.
"""

from __future__ import annotations

from typing import Any


class EigentError(Exception):
    """Base exception for all Eigent SDK errors.

    Attributes:
        fix: A human-readable suggestion for resolving the error.
    """

    fix: str = "Check the Eigent documentation or registry logs for details."

    def __init__(self, message: str, *, fix: str | None = None) -> None:
        if fix is not None:
            self.fix = fix
        super().__init__(message)


class EigentAPIError(EigentError):
    """Raised when the Eigent registry returns an HTTP error."""

    def __init__(self, status_code: int, detail: Any, *, fix: str | None = None) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(
            f"Eigent API error {status_code}: {detail}",
            fix=fix or f"Inspect the response detail: {detail}",
        )


class EigentPermissionDenied(EigentError):
    """Raised when a tool call is blocked because the agent lacks the required scope."""

    def __init__(
        self,
        tool: str,
        reason: str,
        *,
        scope: list[str] | None = None,
        fix: str | None = None,
    ) -> None:
        self.tool = tool
        self.reason = reason
        self.scope = scope
        super().__init__(
            f"Permission denied for tool '{tool}': {reason}",
            fix=fix
            or (
                f"Re-register the agent with '{tool}' in its scope, "
                f"or request delegation from a parent that holds it."
            ),
        )


class EigentTokenExpired(EigentError):
    """Raised when the agent token has expired."""

    def __init__(self, expires_at: str | None = None, *, fix: str | None = None) -> None:
        self.expires_at = expires_at
        super().__init__(
            f"Agent token expired{f' at {expires_at}' if expires_at else ''}.",
            fix=fix or "Rotate the token by calling client.register_agent() again.",
        )


class EigentRegistryUnreachable(EigentError):
    """Raised when the SDK cannot connect to the Eigent registry."""

    def __init__(self, url: str, cause: Exception | None = None, *, fix: str | None = None) -> None:
        self.url = url
        self.cause = cause
        super().__init__(
            f"Cannot reach Eigent registry at {url}: {cause}",
            fix=fix
            or (
                f"Ensure the registry is running at {url}. "
                "Start it with `eigent-scan serve` or check EIGENT_REGISTRY_URL."
            ),
        )


class EigentTokenRevoked(EigentError):
    """Raised when the agent token has been revoked."""

    def __init__(self, agent_id: str | None = None, *, fix: str | None = None) -> None:
        self.agent_id = agent_id
        super().__init__(
            f"Agent token revoked{f' (agent_id={agent_id})' if agent_id else ''}.",
            fix=fix or "Register a new agent — revoked tokens cannot be reinstated.",
        )


class EigentDelegationDenied(EigentError):
    """Raised when a delegation request is refused."""

    def __init__(self, reason: str, *, fix: str | None = None) -> None:
        self.reason = reason
        super().__init__(
            f"Delegation denied: {reason}",
            fix=fix
            or (
                "Check that the parent agent has can_delegate permission "
                "and the requested scope is a subset of the parent's scope."
            ),
        )
