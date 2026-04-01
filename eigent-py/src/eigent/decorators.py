"""Decorators for protecting tool functions with Eigent authorization."""

from __future__ import annotations

import functools
import os
from typing import Any, Callable, TypeVar

from eigent.client import EigentClient
from eigent.exceptions import EigentPermissionDenied

F = TypeVar("F", bound=Callable[..., Any])

# Module-level default client (lazily initialised).
_default_client: EigentClient | None = None


def _get_default_client() -> EigentClient:
    global _default_client
    if _default_client is None:
        url = os.environ.get("EIGENT_REGISTRY_URL", "http://localhost:3456")
        _default_client = EigentClient(registry_url=url)
    return _default_client


def eigent_protected(
    scope: list[str],
    *,
    token_env: str = "EIGENT_AGENT_TOKEN",
    client: EigentClient | None = None,
) -> Callable[[F], F]:
    """Decorator that gates a function behind Eigent token verification.

    The decorated function will only execute if the agent token (read from the
    environment variable *token_env*) is authorised for every scope listed in
    *scope*.

    Usage::

        @eigent_protected(scope=["query_database"])
        def my_tool(query: str) -> str:
            return db.execute(query)

    Raises:
        EigentPermissionDenied: If the token is missing or not authorised.
    """

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            token = kwargs.pop("__eigent_token__", None) or os.environ.get(token_env)
            if not token:
                raise EigentPermissionDenied(
                    fn.__name__,
                    f"No agent token found. Set the {token_env} environment variable.",
                    fix=f"Set the {token_env} environment variable to a valid Eigent agent JWT.",
                )

            eigent = client or _get_default_client()
            for tool_scope in scope:
                result = eigent.verify(token=token, tool=tool_scope)
                if not result.allowed:
                    raise EigentPermissionDenied(
                        tool_scope,
                        result.reason or "not authorised",
                    )

            return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator
