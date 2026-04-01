"""Async Eigent client for the agent trust registry.

Drop-in async counterpart of :class:`~eigent.client.EigentClient`.  Every
public method mirrors the sync API but returns a coroutine, making it
compatible with ``asyncio``-native AI frameworks such as LangChain, CrewAI,
and FastAPI.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from eigent.exceptions import (
    EigentAPIError,
    EigentRegistryUnreachable,
)
from eigent.models import (
    Agent,
    AuditEvent,
    AuditResponse,
    AuditVerifyResult,
    ComplianceReport,
    DelegationResult,
    RevocationResult,
    Session,
    VerifyResult,
)

logger = logging.getLogger("eigent")


class AsyncEigentClient:
    """Asynchronous client for the Eigent identity registry.

    Features:
    - Built on ``httpx.AsyncClient`` with connection pooling.
    - Automatic retry with exponential backoff on transient network errors.
    - Configurable timeout and max retries.
    - Async context-manager support for clean resource cleanup.

    Usage::

        async with AsyncEigentClient(registry_url="http://localhost:3456") as client:
            session = client.login(email="alice@acme.com", demo_mode=True)
            agent = await client.register_agent(
                name="code-reviewer",
                scope=["read_file", "run_tests"],
            )
    """

    def __init__(
        self,
        registry_url: str = "http://localhost:3456",
        *,
        timeout: float = 30.0,
        max_retries: int = 3,
        backoff_base: float = 1.0,
    ) -> None:
        self.base_url = registry_url.rstrip("/")
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self._http = httpx.AsyncClient(base_url=self.base_url, timeout=timeout)
        self._session: Session | None = None

    async def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        await self._http.aclose()

    async def __aenter__(self) -> AsyncEigentClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    # -- helpers --

    def _raise_for_error(self, resp: httpx.Response) -> None:
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            raise EigentAPIError(resp.status_code, body)

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        """Send an HTTP request with automatic retry on transient errors."""
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                return await self._http.request(method, path, **kwargs)
            except (
                httpx.ConnectError,
                httpx.ConnectTimeout,
                httpx.ReadTimeout,
                httpx.WriteTimeout,
                httpx.PoolTimeout,
            ) as exc:
                last_exc = exc
                if attempt < self.max_retries:
                    delay = self.backoff_base * (2 ** attempt)
                    logger.warning(
                        "Eigent request failed (attempt %d/%d), retrying in %.1fs: %s",
                        attempt + 1,
                        self.max_retries + 1,
                        delay,
                        exc,
                    )
                    await asyncio.sleep(delay)
        raise EigentRegistryUnreachable(url=self.base_url, cause=last_exc) from last_exc

    @property
    def session(self) -> Session:
        if self._session is None:
            raise RuntimeError("Not logged in. Call client.login() first.")
        return self._session

    # -- public API --

    def login(
        self,
        email: str,
        *,
        demo_mode: bool = False,
        sub: str | None = None,
        iss: str | None = None,
    ) -> Session:
        """Authenticate a human operator.

        This is intentionally synchronous — it only creates local state in
        demo mode.  Production OIDC login will be async in a future release.
        """
        if demo_mode:
            resolved_sub = sub or email
            resolved_iss = iss or "https://demo.eigent.dev"
            self._session = Session(
                human_sub=resolved_sub,
                human_email=email,
                human_iss=resolved_iss,
                identity_verified=False,
            )
            return self._session

        raise NotImplementedError(
            "Production OIDC login is not yet supported in the SDK. "
            "Use demo_mode=True for development."
        )

    async def register_agent(
        self,
        name: str,
        scope: list[str],
        *,
        max_delegation_depth: int = 3,
        can_delegate: list[str] | None = None,
        ttl_seconds: int = 3600,
        metadata: dict[str, Any] | None = None,
        risk_level: str | None = None,
    ) -> Agent:
        """Register a new agent bound to the current human session."""
        sess = self.session
        payload: dict[str, Any] = {
            "name": name,
            "human_sub": sess.human_sub,
            "human_email": sess.human_email,
            "human_iss": sess.human_iss,
            "scope": scope,
            "max_delegation_depth": max_delegation_depth,
            "can_delegate": can_delegate or [],
            "ttl_seconds": ttl_seconds,
        }
        if metadata:
            payload["metadata"] = metadata
        if risk_level:
            payload["risk_level"] = risk_level

        resp = await self._request("POST", "/api/agents", json=payload)
        self._raise_for_error(resp)
        data = resp.json()
        return Agent(
            agent_id=data["agent_id"],
            token=data["token"],
            scope=data["scope"],
            expires_at=data["expires_at"],
            identity_verified=data.get("identity_verified", False),
            name=name,
            risk_level=risk_level,
        )

    async def delegate(
        self,
        parent_token: str,
        child_name: str,
        scope: list[str],
        *,
        parent_agent_id: str | None = None,
        ttl_seconds: int = 3600,
        metadata: dict[str, Any] | None = None,
    ) -> DelegationResult:
        """Delegate a subset of permissions to a child agent."""
        if parent_agent_id is None:
            import base64
            import json

            parts = parent_token.split(".")
            if len(parts) != 3:
                raise ValueError("parent_token is not a valid JWT")
            padded = parts[1] + "=" * (-len(parts[1]) % 4)
            claims = json.loads(base64.urlsafe_b64decode(padded))
            parent_agent_id = claims["agent_id"]

        payload: dict[str, Any] = {
            "parent_token": parent_token,
            "child_name": child_name,
            "requested_scope": scope,
            "ttl_seconds": ttl_seconds,
        }
        if metadata:
            payload["metadata"] = metadata

        resp = await self._request(
            "POST", f"/api/agents/{parent_agent_id}/delegate", json=payload
        )
        self._raise_for_error(resp)
        return DelegationResult(**resp.json())

    async def verify(self, token: str, tool: str) -> VerifyResult:
        """Verify whether *token* is authorised to call *tool*."""
        resp = await self._request(
            "POST", "/api/verify", json={"token": token, "tool_name": tool}
        )
        data = resp.json()
        return VerifyResult(**data)

    async def revoke(self, agent_id: str) -> RevocationResult:
        """Revoke an agent and cascade-revoke all its children."""
        resp = await self._request("DELETE", f"/api/agents/{agent_id}")
        self._raise_for_error(resp)
        return RevocationResult(**resp.json())

    async def audit(
        self,
        *,
        human: str | None = None,
        agent_id: str | None = None,
        action: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[AuditEvent]:
        """Query the audit log with optional filters."""
        params: dict[str, str | int] = {"limit": limit, "offset": offset}
        if human:
            params["human_email"] = human
        if agent_id:
            params["agent_id"] = agent_id
        if action:
            params["action"] = action

        resp = await self._request("GET", "/api/audit", params=params)
        self._raise_for_error(resp)
        data = AuditResponse(**resp.json())
        return data.entries

    async def audit_verify(self) -> AuditVerifyResult:
        """Verify the integrity of the immutable audit chain."""
        resp = await self._request("GET", "/api/v1/audit/verify")
        self._raise_for_error(resp)
        return AuditVerifyResult(**resp.json())

    async def compliance_report(
        self,
        framework: str = "all",
        period: str = "30d",
        *,
        human: str | None = None,
    ) -> ComplianceReport:
        """Generate a compliance report."""
        params: dict[str, str] = {
            "framework": framework,
            "period": period,
            "format": "json",
        }
        if human:
            params["human"] = human

        resp = await self._request("GET", "/api/compliance/report", params=params)
        self._raise_for_error(resp)
        return ComplianceReport(**resp.json())
