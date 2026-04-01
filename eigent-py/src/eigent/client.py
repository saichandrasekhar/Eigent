"""Eigent Python client for the agent trust registry."""

from __future__ import annotations

from typing import Any

import httpx

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


class EigentError(Exception):
    """Raised when the Eigent registry returns an error."""

    def __init__(self, status_code: int, detail: Any) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"Eigent API error {status_code}: {detail}")


class EigentClient:
    """Synchronous client for the Eigent identity registry.

    Usage::

        client = EigentClient(registry_url="http://localhost:3456")
        session = client.login(email="alice@acme.com", demo_mode=True)
        agent = client.register_agent(
            name="code-reviewer",
            scope=["read_file", "run_tests"],
            max_delegation_depth=2,
        )
    """

    def __init__(
        self,
        registry_url: str = "http://localhost:3456",
        *,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = registry_url.rstrip("/")
        self._http = httpx.Client(base_url=self.base_url, timeout=timeout)
        self._session: Session | None = None

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._http.close()

    def __enter__(self) -> EigentClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    # -- helpers --

    def _raise_for_error(self, resp: httpx.Response) -> None:
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            raise EigentError(resp.status_code, body)

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

        In *demo_mode* the identity fields are accepted directly (unverified).
        For production, use the OIDC login flow via ``login_oidc``.
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

    def register_agent(
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

        resp = self._http.post("/api/agents", json=payload)
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

    def delegate(
        self,
        parent_token: str,
        child_name: str,
        scope: list[str],
        *,
        parent_agent_id: str | None = None,
        ttl_seconds: int = 3600,
        metadata: dict[str, Any] | None = None,
    ) -> DelegationResult:
        """Delegate a subset of permissions to a child agent.

        If *parent_agent_id* is not provided it is extracted from the JWT
        (requires the ``agent_id`` field in the token claims).
        """
        if parent_agent_id is None:
            # Extract agent_id from the JWT payload (second segment, base64)
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

        resp = self._http.post(
            f"/api/agents/{parent_agent_id}/delegate", json=payload
        )
        self._raise_for_error(resp)
        return DelegationResult(**resp.json())

    def verify(self, token: str, tool: str) -> VerifyResult:
        """Verify whether *token* is authorised to call *tool*."""
        resp = self._http.post(
            "/api/verify", json={"token": token, "tool_name": tool}
        )
        # 401/404 still carry structured JSON — parse them
        data = resp.json()
        return VerifyResult(**data)

    def revoke(self, agent_id: str) -> RevocationResult:
        """Revoke an agent and cascade-revoke all its children."""
        resp = self._http.delete(f"/api/agents/{agent_id}")
        self._raise_for_error(resp)
        return RevocationResult(**resp.json())

    def audit(
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

        resp = self._http.get("/api/audit", params=params)
        self._raise_for_error(resp)
        data = AuditResponse(**resp.json())
        return data.entries

    def audit_verify(self) -> AuditVerifyResult:
        """Verify the integrity of the immutable audit chain."""
        resp = self._http.get("/api/v1/audit/verify")
        self._raise_for_error(resp)
        return AuditVerifyResult(**resp.json())

    def compliance_report(
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

        resp = self._http.get("/api/compliance/report", params=params)
        self._raise_for_error(resp)
        return ComplianceReport(**resp.json())
