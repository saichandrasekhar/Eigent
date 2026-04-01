"""Tests for the LangChain integration."""

from __future__ import annotations

import httpx
import pytest
import respx

from eigent.client import EigentClient
from eigent.exceptions import EigentPermissionDenied
from eigent.integrations.langchain import EigentToolGuard, eigent_tool

BASE = "http://localhost:3456"


@respx.mock
def test_tool_guard_allows() -> None:
    """EigentToolGuard passes when verify returns allowed=True."""
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": True, "agent_id": "a1", "reason": "ok"},
        )
    )

    client = EigentClient(registry_url=BASE)
    guard = EigentToolGuard(client=client, token="tok-abc")

    # Should not raise.
    guard.on_tool_start(
        serialized={"name": "search_db"},
        input_str="SELECT 1",
    )
    client.close()


@respx.mock
def test_tool_guard_denies() -> None:
    """EigentToolGuard raises EigentPermissionDenied on denial."""
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": False, "agent_id": "a1", "reason": "not in scope"},
        )
    )

    client = EigentClient(registry_url=BASE)
    guard = EigentToolGuard(client=client, token="tok-abc")

    with pytest.raises(EigentPermissionDenied, match="search_db"):
        guard.on_tool_start(
            serialized={"name": "search_db"},
            input_str="DROP TABLE",
        )
    client.close()


@respx.mock
def test_tool_guard_warn_mode() -> None:
    """With raise_on_deny=False, denial logs a warning but does not raise."""
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": False, "agent_id": "a1", "reason": "not in scope"},
        )
    )

    client = EigentClient(registry_url=BASE)
    guard = EigentToolGuard(client=client, token="tok-abc", raise_on_deny=False)

    # Should not raise.
    guard.on_tool_start(
        serialized={"name": "search_db"},
        input_str="DROP TABLE",
    )
    client.close()


@respx.mock
def test_tool_guard_extracts_name_from_id() -> None:
    """Falls back to serialized['id'] when 'name' is absent."""
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": True, "agent_id": "a1", "reason": "ok"},
        )
    )

    client = EigentClient(registry_url=BASE)
    guard = EigentToolGuard(client=client, token="tok-abc")

    guard.on_tool_start(
        serialized={"id": ["langchain", "tools", "my_search"]},
        input_str="query",
    )
    client.close()


# ---- eigent_tool decorator ----


@respx.mock
def test_eigent_tool_decorator_allows() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": True, "agent_id": "a1", "reason": "ok"},
        )
    )

    client = EigentClient(registry_url=BASE)

    @eigent_tool("query_database", client=client, token="tok-abc")
    def search_db(query: str) -> str:
        return f"result:{query}"

    assert search_db("SELECT 1") == "result:SELECT 1"
    client.close()


@respx.mock
def test_eigent_tool_decorator_denies() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": False, "agent_id": "a1", "reason": "not in scope"},
        )
    )

    client = EigentClient(registry_url=BASE)

    @eigent_tool(["query_database", "write_database"], client=client, token="tok-abc")
    def search_db(query: str) -> str:
        return f"result:{query}"

    with pytest.raises(EigentPermissionDenied):
        search_db("SELECT 1")
    client.close()
