"""Tests for the CrewAI integration."""

from __future__ import annotations

from dataclasses import dataclass

import httpx
import pytest
import respx

from eigent.client import EigentClient
from eigent.exceptions import EigentPermissionDenied
from eigent.integrations.crewai import EigentCrewGuard

BASE = "http://localhost:3456"


# ---- Fake step outputs to simulate CrewAI behaviour ----


@dataclass
class FakeAgentAction:
    """Mimics a CrewAI AgentAction with a ``tool`` attribute."""

    tool: str
    tool_input: str = ""


# ---- tests ----


@respx.mock
def test_crew_guard_allows() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": True, "agent_id": "a1", "reason": "ok"},
        )
    )

    client = EigentClient(registry_url=BASE)
    guard = EigentCrewGuard(client=client, token="tok-abc")

    # Should not raise.
    guard(FakeAgentAction(tool="search_db"))
    client.close()


@respx.mock
def test_crew_guard_denies() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": False, "agent_id": "a1", "reason": "not in scope"},
        )
    )

    client = EigentClient(registry_url=BASE)
    guard = EigentCrewGuard(client=client, token="tok-abc")

    with pytest.raises(EigentPermissionDenied, match="search_db"):
        guard(FakeAgentAction(tool="search_db"))
    client.close()


@respx.mock
def test_crew_guard_warn_mode() -> None:
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": False, "agent_id": "a1", "reason": "not in scope"},
        )
    )

    client = EigentClient(registry_url=BASE)
    guard = EigentCrewGuard(client=client, token="tok-abc", raise_on_deny=False)

    # Should not raise.
    guard(FakeAgentAction(tool="search_db"))
    client.close()


@respx.mock
def test_crew_guard_dict_step() -> None:
    """Guard extracts tool name from a dict-shaped step output."""
    respx.post(f"{BASE}/api/verify").mock(
        return_value=httpx.Response(
            200,
            json={"allowed": True, "agent_id": "a1", "reason": "ok"},
        )
    )

    client = EigentClient(registry_url=BASE)
    guard = EigentCrewGuard(client=client, token="tok-abc")

    guard({"tool": "search_db", "input": "query"})
    client.close()


def test_crew_guard_non_tool_step_skipped() -> None:
    """Steps without a tool name are silently skipped."""
    client = EigentClient(registry_url=BASE)
    guard = EigentCrewGuard(client=client, token="tok-abc")

    # Should not raise or make any HTTP calls.
    guard("just a text output")
    client.close()
