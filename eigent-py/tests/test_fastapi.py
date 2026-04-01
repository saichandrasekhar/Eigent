"""Tests for the FastAPI/Starlette middleware integration."""

from __future__ import annotations

import httpx
import pytest
import respx

from eigent.client import EigentClient

# We test the middleware using Starlette's TestClient to avoid requiring
# a running server.
try:
    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    HAS_STARLETTE = True
except ImportError:
    HAS_STARLETTE = False

from eigent.integrations.fastapi import EigentMiddleware

BASE = "http://localhost:3456"

pytestmark = pytest.mark.skipif(
    not HAS_STARLETTE,
    reason="starlette not installed",
)


def _make_app(client: EigentClient, **kwargs: object) -> Starlette:
    """Build a tiny Starlette app with EigentMiddleware attached."""

    async def tool_endpoint(request: Request) -> JSONResponse:
        claims = request.state.eigent
        return JSONResponse(
            {"ok": True, "agent_id": claims.agent_id},
        )

    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"status": "healthy"})

    app = Starlette(
        routes=[
            Route("/tools/{tool_name}", tool_endpoint, methods=["POST"]),
            Route("/health", health, methods=["GET"]),
        ],
    )
    app.add_middleware(
        EigentMiddleware,
        client=client,
        exclude_paths=["/health"],
        **kwargs,  # type: ignore[arg-type]
    )
    return app


@respx.mock
def test_middleware_allows_valid_token() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={
                "allowed": True,
                "agent_id": "agent-1",
                "human_email": "alice@acme.com",
                "reason": "ok",
            },
        )
    )

    client = EigentClient(registry_url=BASE)
    app = _make_app(client)
    test_client = TestClient(app, raise_server_exceptions=False)

    resp = test_client.post(
        "/tools/search_db",
        headers={"Authorization": "Bearer tok-abc"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert resp.json()["agent_id"] == "agent-1"
    client.close()


@respx.mock
def test_middleware_blocks_denied_token() -> None:
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

    client = EigentClient(registry_url=BASE)
    app = _make_app(client)
    test_client = TestClient(app, raise_server_exceptions=False)

    resp = test_client.post(
        "/tools/search_db",
        headers={"Authorization": "Bearer tok-abc"},
    )
    assert resp.status_code == 403
    body = resp.json()
    assert "fix" in body
    client.close()


def test_middleware_rejects_missing_auth() -> None:
    client = EigentClient(registry_url=BASE)
    app = _make_app(client)
    test_client = TestClient(app, raise_server_exceptions=False)

    resp = test_client.post("/tools/search_db")
    assert resp.status_code == 401
    assert "Authorization" in resp.json()["fix"]
    client.close()


def test_middleware_excludes_health() -> None:
    """Excluded paths bypass Eigent verification entirely."""
    client = EigentClient(registry_url=BASE)
    app = _make_app(client)
    test_client = TestClient(app, raise_server_exceptions=False)

    resp = test_client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"
    client.close()
