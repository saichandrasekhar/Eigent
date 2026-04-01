"""CrewAI integration for Eigent agent trust enforcement.

Provides ``EigentCrewGuard`` — a step callback compatible with CrewAI's
``step_callback`` parameter.  It validates the agent's Eigent identity token
before each tool invocation, blocking unauthorized calls.

Usage::

    from eigent import EigentClient
    from eigent.integrations.crewai import EigentCrewGuard

    client = EigentClient()
    guard = EigentCrewGuard(client=client, token="<agent-jwt>")

    crew = Crew(
        agents=[researcher],
        tasks=[task],
        step_callback=guard,
    )
    crew.kickoff()
"""

from __future__ import annotations

import logging
from typing import Any

from eigent.client import EigentClient
from eigent.exceptions import EigentPermissionDenied

logger = logging.getLogger("eigent.integrations.crewai")


class EigentCrewGuard:
    """CrewAI step callback that validates Eigent tokens before tool use.

    CrewAI invokes the step callback with the output of each agent step.
    When the step involves a tool call, this guard verifies the agent token
    against the Eigent registry.

    Args:
        client: An :class:`~eigent.client.EigentClient` instance.
        token: The agent JWT to verify on every tool call.
        raise_on_deny: If ``True`` (default), raise on denial.  If ``False``,
            log a warning and allow execution.
    """

    def __init__(
        self,
        client: EigentClient,
        token: str,
        *,
        raise_on_deny: bool = True,
    ) -> None:
        self.client = client
        self.token = token
        self.raise_on_deny = raise_on_deny

    def __call__(self, step_output: Any) -> None:
        """Invoked by CrewAI after each agent step.

        ``step_output`` is typically a CrewAI ``TaskOutput`` or agent action.
        We attempt to extract a tool name from common shapes and verify it.
        """
        tool_name = self._extract_tool_name(step_output)
        if tool_name is None:
            # Not a tool step — nothing to guard.
            return

        result = self.client.verify(token=self.token, tool=tool_name)
        if not result.allowed:
            reason = result.reason or "not authorised"
            if self.raise_on_deny:
                raise EigentPermissionDenied(tool=tool_name, reason=reason)
            logger.warning(
                "Eigent denied tool '%s' but raise_on_deny=False: %s",
                tool_name,
                reason,
            )

    @staticmethod
    def _extract_tool_name(step_output: Any) -> str | None:
        """Best-effort extraction of a tool name from a CrewAI step output."""
        # CrewAI's AgentAction has a `tool` attribute.
        if hasattr(step_output, "tool"):
            return str(step_output.tool)

        # Dict-like outputs.
        if isinstance(step_output, dict):
            return step_output.get("tool") or step_output.get("tool_name")

        return None
