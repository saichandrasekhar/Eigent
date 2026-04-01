"""Tests for the async Eigent client with mocked HTTP."""

from __future__ import annotations

import httpx
import pytest
import respx

from eigent.async_client import AsyncEigentClient
from eigent.exceptions import EigentAPIError, EigentRegistryUnreachable
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

_FAKE_JWT_PAYLOAD = "eyJhZ2VudF9pZCI6InBhcmVudC0xIn0"
FAKE_PARENT_TOKEN = f"header.{_FAKE_JWT_PAYLOAD}.signature"


# ---- login ----


@pytest.mark.asyncio
async def test_login_demo_mode() -> None:
    async with AsyncEigentClient(registry_url=BASE) as client:
        session = client.login(email="alice@acme.com", demo_mode=True)
        assert session.human_email == "alice@acme.com"
        assert session.identity_verified is False


@pytest.mark.asyncio
async def test_login_production_raises() -> None:
    async with AsyncEigentClient(registry_url=BASE) as client:
        with pytest.raises(NotImplementedError):
            client.login(email="alice@acme.com")


# ---- register_agent ----


@pytest.mark.asyncio
@respx.mock
async def test_register_agent() -> None:
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

    async with AsyncEigentClient(registry_url=BASE) as client:
        client.login(email="alice@acme.com", demo_mode=True)
        agent = await client.register_agent(
            name="reviewer", scope=["read_file"], max_delegation_depth=2
        )
        assert isinstance(agent, Agent)
        assert agent.agent_id == "agent-1"


# ---- delegate ----


@pytest.mark.asyncio
@respx.mock
async def test_delegate() -> None:
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

    async with AsyncEigentClient(registry_url=BASE) as client:
        result = await client.delegate(
            parent_token=FAKE_PARENT_TOKEN,
            child_name="test-runner",
            scope=["run_tests"],
        )
        assert isinstance(result, DelegationResult)
        assert result.child_agent_id == "child-1"


# ---- verify ----


@pytest.mark.asyncio
@respx.mock
async def test_verify_allowed() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={
                "allowed": True,
                "agent_id": "agent-1",
                "human_email": "alice@acme.com",
                "delegation_chain": ["agent-1"],
                "reason": "ok",
            },
        )
    )

    async with AsyncEigentClient(registry_url=BASE) as client:
        result = await client.verify(token="tok-abc", tool="read_file")
        assert result.allowed is True


@pytest.mark.asyncio
@respx.mock
async def test_verify_denied() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={
                "allowed": False,
                "agent_id": "agent-1",
                "reason": "not in scope",
            },
        )
    )

    async with AsyncEigentClient(registry_url=BASE) as client:
        result = await client.verify(token="tok-abc", tool="delete_file")
        assert result.allowed is False


# ---- revoke ----


@pytest.mark.asyncio
@respx.mock
async def test_revoke() -> None:
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

    async with AsyncEigentClient(registry_url=BASE) as client:
        result = await client.revoke(agent_id="agent-1")
        assert isinstance(result, RevocationResult)
        assert result.total_revoked == 2


# ---- audit ----


@pytest.mark.asyncio
@respx.mock
async def test_audit() -> None:
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
                    }
                ],
                "total": 1,
                "limit": 50,
                "offset": 0,
            },
        )
    )

    async with AsyncEigentClient(registry_url=BASE) as client:
        events = await client.audit(human="alice@acme.com")
        assert len(events) == 1
        assert isinstance(events[0], AuditEvent)


# ---- audit_verify ----


@pytest.mark.asyncio
@respx.mock
async def test_audit_verify() -> None:
    respx.get(f"{BASE}/api/v1/audit/verify").mock(
        return_value=httpx.Response(
            200,
            json={"valid": True, "broken_at": None, "total_events": 42},
        )
    )

    async with AsyncEigentClient(registry_url=BASE) as client:
        result = await client.audit_verify()
        assert isinstance(result, AuditVerifyResult)
        assert result.valid is True


# ---- compliance_report ----


@pytest.mark.asyncio
@respx.mock
async def test_compliance_report() -> None:
    respx.get(f"{BASE}/api/compliance/report").mock(
        return_value=httpx.Response(
            200,
            json={
                "report_html": "<html>ok</html>",
                "generated_at": "2026-01-01T00:00:00Z",
                "period": {"start": "2025-12-01", "end": "2026-01-01"},
                "framework": "eu-ai-act",
            },
        )
    )

    async with AsyncEigentClient(registry_url=BASE) as client:
        report = await client.compliance_report(framework="eu-ai-act")
        assert isinstance(report, ComplianceReport)
        assert report.framework == "eu-ai-act"


# ---- error handling ----


@pytest.mark.asyncio
@respx.mock
async def test_api_error_raises() -> None:
    respx.delete(f"{BASE}/api/agents/bad-id").mock(
        return_value=httpx.Response(404, json={"error": "Agent not found"})
    )

    async with AsyncEigentClient(registry_url=BASE) as client:
        with pytest.raises(EigentAPIError) as exc_info:
            await client.revoke(agent_id="bad-id")
        assert exc_info.value.status_code == 404


# ---- retry logic ----


@pytest.mark.asyncio
@respx.mock
async def test_retry_on_connect_error() -> None:
    route = respx.post(f"{BASE}/api/verify")
    route.side_effect = [
        httpx.ConnectError("Connection refused"),
        httpx.Response(
            200,
            json={"allowed": True, "agent_id": "a1", "reason": "ok"},
        ),
    ]

    async with AsyncEigentClient(
        registry_url=BASE, max_retries=2, backoff_base=0.0
    ) as client:
        result = await client.verify(token="tok", tool="read")
        assert result.allowed is True


@pytest.mark.asyncio
@respx.mock
async def test_retry_exhausted_raises_unreachable() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )

    async with AsyncEigentClient(
        registry_url=BASE, max_retries=1, backoff_base=0.0
    ) as client:
        with pytest.raises(EigentRegistryUnreachable):
            await client.verify(token="tok", tool="read")
