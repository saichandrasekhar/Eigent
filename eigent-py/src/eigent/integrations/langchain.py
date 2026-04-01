"""LangChain integration for Eigent agent trust enforcement.

Provides two mechanisms for injecting Eigent authorization into LangChain
pipelines:

1. **EigentToolGuard** — a LangChain callback handler that intercepts
   ``on_tool_start`` events and validates the agent token before allowing
   execution.

2. **eigent_tool** — a decorator that wraps any LangChain ``BaseTool`` (or
   plain function tool) with Eigent scope verification.

Usage::

    from eigent import EigentClient
    from eigent.integrations.langchain import EigentToolGuard

    client = EigentClient()
    guard = EigentToolGuard(client=client, token="<agent-jwt>")

    agent = create_react_agent(llm, tools, callbacks=[guard])
"""

from __future__ import annotations

import functools
import logging
from typing import Any, Callable, TypeVar

from eigent.client import EigentClient
from eigent.exceptions import EigentPermissionDenied

logger = logging.getLogger("eigent.integrations.langchain")

F = TypeVar("F", bound=Callable[..., Any])

try:
    from langchain_core.callbacks import BaseCallbackHandler
except ImportError:  # pragma: no cover
    # Provide a stub so the module can be imported even without langchain
    # installed — the user will get a clear error when they try to
    # instantiate ``EigentToolGuard``.
    class BaseCallbackHandler:  # type: ignore[no-redef]
        """Stub — install ``langchain-core`` to use this integration."""

        def __init_subclass__(cls, **kwargs: Any) -> None:
            super().__init_subclass__(**kwargs)


class EigentToolGuard(BaseCallbackHandler):
    """LangChain callback handler that validates Eigent tokens before tool execution.

    Attach this to any LangChain agent or chain via the ``callbacks`` argument.
    When a tool is about to run, the guard calls ``client.verify()`` and raises
    :class:`~eigent.exceptions.EigentPermissionDenied` if the token does not
    authorize the tool's name.

    Args:
        client: An :class:`~eigent.client.EigentClient` instance.
        token: The agent JWT to verify on every tool call.
        raise_on_deny: If ``True`` (default), raise on denial.  If ``False``,
            log a warning and allow execution (useful during migration).
    """

    def __init__(
        self,
        client: EigentClient,
        token: str,
        *,
        raise_on_deny: bool = True,
    ) -> None:
        super().__init__()
        self.client = client
        self.token = token
        self.raise_on_deny = raise_on_deny

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        **kwargs: Any,
    ) -> None:
        """Called when a tool is about to be invoked."""
        tool_name = serialized.get("name", serialized.get("id", ["unknown"])[-1])
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


def eigent_tool(
    scope: str | list[str],
    *,
    client: EigentClient,
    token: str,
) -> Callable[[F], F]:
    """Decorator that wraps a LangChain tool function with Eigent enforcement.

    Each scope string is verified against the registry before the tool body
    executes.

    Usage::

        @eigent_tool("query_database", client=client, token=agent_token)
        @tool
        def search_db(query: str) -> str:
            return db.execute(query)
    """
    scopes = [scope] if isinstance(scope, str) else scope

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            for s in scopes:
                result = client.verify(token=token, tool=s)
                if not result.allowed:
                    raise EigentPermissionDenied(
                        tool=s,
                        reason=result.reason or "not authorised",
                        scope=scopes,
                    )
            return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator
