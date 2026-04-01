"""Tests for the Eigent Python SDK sync client with mocked HTTP."""

from __future__ import annotations

import json
import os
from unittest.mock import patch

import httpx
import pytest
import respx

from eigent.client import EigentClient
from eigent.decorators import eigent_protected
from eigent.exceptions import (
    EigentAPIError,
    EigentPermissionDenied,
    EigentRegistryUnreachable,
)
from eigent.models import (
    Agent,
    AuditEvent,
    AuditVerifyResult,
    ComplianceReport,
    DelegationResult,
    RevocationResult,
    VerifyResult,
)

BASE = "http://localhost:3456"

# ---- Helpers ----

# A minimal JWT-shaped string whose payload contains {"agent_id": "parent-1"}
_FAKE_JWT_PAYLOAD = "eyJhZ2VudF9pZCI6InBhcmVudC0xIn0"
FAKE_PARENT_TOKEN = f"header.{_FAKE_JWT_PAYLOAD}.signature"


# ---- login ----


def test_login_demo_mode() -> None:
    client = EigentClient(registry_url=BASE)
    session = client.login(email="alice@acme.com", demo_mode=True)

    assert session.human_email == "alice@acme.com"
    assert session.human_sub == "alice@acme.com"
    assert session.human_iss == "https://demo.eigent.dev"
    assert session.identity_verified is False
    client.close()


def test_login_production_raises() -> None:
    client = EigentClient(registry_url=BASE)
    with pytest.raises(NotImplementedError):
        client.login(email="alice@acme.com")
    client.close()


def test_session_required_before_register() -> None:
    client = EigentClient(registry_url=BASE)
    with pytest.raises(RuntimeError, match="Not logged in"):
        client.register_agent(name="x", scope=["y"])
    client.close()


# ---- register_agent ----


@respx.mock
def test_register_agent() -> None:
    respx.post(f"{BASE}/api/agents").mock(
        return_value=httpx.Response(
            201,
            json={
                "agent_id": "agent-1",
                "token": "tok-abc",
                "scope": ["read_file"],
                "expires_at": "2026-12-31T00:00:00Z",
                "identity_verified": False,
            },
        )
    )

    client = EigentClient(registry_url=BASE)
    client.login(email="alice@acme.com", demo_mode=True)
    agent = client.register_agent(
        name="reviewer", scope=["read_file"], max_delegation_depth=2
    )

    assert isinstance(agent, Agent)
    assert agent.agent_id == "agent-1"
    assert agent.scope == ["read_file"]
    client.close()


@respx.mock
def test_register_agent_with_risk_level() -> None:
    route = respx.post(f"{BASE}/api/agents").mock(
        return_value=httpx.Response(
            201,
            json={
                "agent_id": "agent-2",
                "token": "tok-xyz",
                "scope": ["run_tests"],
                "expires_at": "2026-12-31T00:00:00Z",
                "identity_verified": False,
            },
        )
    )

    client = EigentClient(registry_url=BASE)
    client.login(email="bob@acme.com", demo_mode=True)
    agent = client.register_agent(
        name="tester", scope=["run_tests"], risk_level="high"
    )

    assert agent.risk_level == "high"
    sent_body = json.loads(route.calls.last.request.content)
    assert sent_body["risk_level"] == "high"
    client.close()


# ---- delegate ----


@respx.mock
def test_delegate() -> None:
    respx.post(f"{BASE}/api/agents/parent-1/delegate").mock(
        return_value=httpx.Response(
            201,
            json={
                "child_agent_id": "child-1",
                "token": "tok-child",
                "granted_scope": ["run_tests"],
                "denied_scope": [],
                "delegation_depth": 1,
                "expires_at": "2026-12-31T00:00:00Z",
            },
        )
    )

    client = EigentClient(registry_url=BASE)
    result = client.delegate(
        parent_token=FAKE_PARENT_TOKEN,
        child_name="test-runner",
        scope=["run_tests"],
    )

    assert isinstance(result, DelegationResult)
    assert result.child_agent_id == "child-1"
    assert result.delegation_depth == 1
    client.close()


# ---- verify ----


@respx.mock
def test_verify_allowed() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={
                "allowed": True,
                "agent_id": "agent-1",
                "human_email": "alice@acme.com",
                "delegation_chain": ["agent-1"],
                "reason": "Tool is within agent scope",
            },
        )
    )

    client = EigentClient(registry_url=BASE)
    result = client.verify(token="tok-abc", tool="read_file")

    assert isinstance(result, VerifyResult)
    assert result.allowed is True
    client.close()


@respx.mock
def test_verify_denied() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={
                "allowed": False,
                "agent_id": "agent-1",
                "human_email": "alice@acme.com",
                "delegation_chain": ["agent-1"],
                "reason": 'Tool "delete_file" is not in agent scope',
            },
        )
    )

    client = EigentClient(registry_url=BASE)
    result = client.verify(token="tok-abc", tool="delete_file")

    assert result.allowed is False
    assert "delete_file" in (result.reason or "")
    client.close()


# ---- revoke ----


@respx.mock
def test_revoke() -> None:
    respx.delete(f"{BASE}/api/agents/agent-1").mock(
        return_value=httpx.Response(
            200,
            json={
                "revoked_agent_id": "agent-1",
                "cascade_revoked": ["child-1"],
                "total_revoked": 2,
            },
        )
    )

    client = EigentClient(registry_url=BASE)
    result = client.revoke(agent_id="agent-1")

    assert isinstance(result, RevocationResult)
    assert result.cascade_revoked == ["child-1"]
    assert result.total_revoked == 2
    client.close()


# ---- audit ----


@respx.mock
def test_audit() -> None:
    respx.get(f"{BASE}/api/audit").mock(
        return_value=httpx.Response(
            200,
            json={
                "entries": [
                    {
                        "id": "evt-1",
                        "timestamp": "2026-01-01T00:00:00Z",
                        "agent_id": "agent-1",
                        "human_email": "alice@acme.com",
                        "action": "issued",
                        "tool_name": None,
                        "delegation_chain": ["agent-1"],
                        "details": {"scope": ["read_file"]},
                    }
                ],
                "total": 1,
                "limit": 50,
                "offset": 0,
            },
        )
    )

    client = EigentClient(registry_url=BASE)
    events = client.audit(human="alice@acme.com", limit=20)

    assert len(events) == 1
    assert isinstance(events[0], AuditEvent)
    assert events[0].action == "issued"
    client.close()


# ---- audit_verify ----


@respx.mock
def test_audit_verify() -> None:
    respx.get(f"{BASE}/api/v1/audit/verify").mock(
        return_value=httpx.Response(
            200,
            json={"valid": True, "broken_at": None, "total_events": 42},
        )
    )

    client = EigentClient(registry_url=BASE)
    result = client.audit_verify()

    assert isinstance(result, AuditVerifyResult)
    assert result.valid is True
    assert result.total_events == 42
    client.close()


# ---- compliance_report ----


@respx.mock
def test_compliance_report() -> None:
    respx.get(f"{BASE}/api/compliance/report").mock(
        return_value=httpx.Response(
            200,
            json={
                "report_html": "<html>report</html>",
                "generated_at": "2026-01-01T00:00:00Z",
                "period": {
                    "start": "2025-12-01T00:00:00Z",
                    "end": "2026-01-01T00:00:00Z",
                },
                "framework": "eu-ai-act",
            },
        )
    )

    client = EigentClient(registry_url=BASE)
    report = client.compliance_report(framework="eu-ai-act", period="30d")

    assert isinstance(report, ComplianceReport)
    assert report.framework == "eu-ai-act"
    assert "<html>" in report.report_html
    client.close()


# ---- error handling ----


@respx.mock
def test_api_error_raises() -> None:
    respx.delete(f"{BASE}/api/agents/bad-id").mock(
        return_value=httpx.Response(404, json={"error": "Agent not found"})
    )

    client = EigentClient(registry_url=BASE)
    with pytest.raises(EigentAPIError) as exc_info:
        client.revoke(agent_id="bad-id")

    assert exc_info.value.status_code == 404
    client.close()


# ---- retry logic ----


@respx.mock
def test_retry_on_connect_error() -> None:
    """Client retries on transient connection failures."""
    route = respx.post(f"{BASE}/api/verify")
    route.side_effect = [
        httpx.ConnectError("Connection refused"),
        httpx.Response(
            200,
            json={"allowed": True, "agent_id": "a1", "reason": "ok"},
        ),
    ]

    client = EigentClient(registry_url=BASE, max_retries=2, backoff_base=0.0)
    result = client.verify(token="tok", tool="read")
    assert result.allowed is True
    client.close()


@respx.mock
def test_retry_exhausted_raises_unreachable() -> None:
    """All retries exhausted raises EigentRegistryUnreachable."""
    respx.post(f"{BASE}/api/verify").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )

    client = EigentClient(registry_url=BASE, max_retries=1, backoff_base=0.0)
    with pytest.raises(EigentRegistryUnreachable) as exc_info:
        client.verify(token="tok", tool="read")

    assert "localhost:3456" in str(exc_info.value)
    assert exc_info.value.fix  # should have a fix suggestion
    client.close()


# ---- context manager ----


@respx.mock
def test_context_manager() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": True, "agent_id": "a1", "reason": "ok"},
        )
    )

    with EigentClient(registry_url=BASE) as client:
        result = client.verify(token="tok", tool="read")
        assert result.allowed is True


# ---- decorator ----


@respx.mock
def test_eigent_protected_allowed() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": True, "agent_id": "a1", "reason": "ok"},
        )
    )

    client = EigentClient(registry_url=BASE)

    @eigent_protected(scope=["query_database"], client=client)
    def my_tool(query: str) -> str:
        return f"result:{query}"

    result = my_tool("SELECT 1", __eigent_token__="tok-abc")
    assert result == "result:SELECT 1"
    client.close()


@respx.mock
def test_eigent_protected_denied() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={
                "allowed": False,
                "agent_id": "a1",
                "reason": "not in scope",
            },
        )
    )

    client = EigentClient(registry_url=BASE)

    @eigent_protected(scope=["query_database"], client=client)
    def my_tool(query: str) -> str:
        return f"result:{query}"

    with pytest.raises(EigentPermissionDenied):
        my_tool("SELECT 1", __eigent_token__="tok-abc")

    client.close()


def test_eigent_protected_no_token() -> None:
    os.environ.pop("EIGENT_AGENT_TOKEN", None)

    client = EigentClient(registry_url=BASE)

    @eigent_protected(scope=["query_database"], client=client)
    def my_tool(query: str) -> str:
        return f"result:{query}"

    with pytest.raises(EigentPermissionDenied, match="No agent token"):
        my_tool("SELECT 1")

    client.close()


# ---- exception attributes ----


def test_exception_fix_attribute() -> None:
    """All custom exceptions expose a fix attribute."""
    exc = EigentPermissionDenied(tool="run_tests", reason="not in scope")
    assert exc.fix
    assert "run_tests" in exc.fix

    exc2 = EigentRegistryUnreachable(url="http://localhost:3456", cause=None)
    assert "localhost:3456" in exc2.fix

    exc3 = EigentAPIError(500, "internal error")
    assert exc3.fix
