"""FastAPI middleware for Eigent agent trust enforcement.

Extracts an Eigent JWT from the ``Authorization`` header of incoming requests,
validates it against the registry, and injects the verified claims into
``request.state`` for downstream route handlers.

Usage::

    from fastapi import FastAPI
    from eigent.integrations.fastapi import EigentMiddleware

    app = FastAPI()
    app.add_middleware(
        EigentMiddleware,
        registry_url="http://localhost:3456",
    )

    @app.post("/tools/{tool_name}")
    async def invoke_tool(tool_name: str, request: Request):
        claims = request.state.eigent  # VerifyResult
        ...
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from eigent.client import EigentClient
from eigent.exceptions import EigentPermissionDenied, EigentTokenExpired, EigentTokenRevoked

logger = logging.getLogger("eigent.integrations.fastapi")

try:
    from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
    from starlette.requests import Request
    from starlette.responses import JSONResponse, Response
except ImportError:  # pragma: no cover

    class BaseHTTPMiddleware:  # type: ignore[no-redef]
        """Stub — install ``starlette`` (or ``fastapi``) to use this integration."""

        def __init_subclass__(cls, **kwargs: Any) -> None:
            super().__init_subclass__(**kwargs)

    Request = Any  # type: ignore[assignment,misc]
    Response = Any  # type: ignore[assignment,misc]
    RequestResponseEndpoint = Any  # type: ignore[assignment,misc]
    JSONResponse = Any  # type: ignore[assignment,misc]


class EigentMiddleware(BaseHTTPMiddleware):
    """FastAPI/Starlette middleware that enforces Eigent agent authorization.

    The middleware:

    1. Reads the ``Authorization: Bearer <token>`` header.
    2. Extracts the tool name from the URL path (last segment by default, or
       configurable via ``tool_extractor``).
    3. Calls ``client.verify(token, tool)`` against the Eigent registry.
    4. On success, stores the :class:`~eigent.models.VerifyResult` in
       ``request.state.eigent``.
    5. On failure, returns a ``403`` JSON response.

    Paths listed in ``exclude_paths`` skip verification entirely (e.g.,
    ``/health``, ``/docs``).

    Args:
        app: The ASGI application.
        registry_url: URL of the Eigent registry.
        client: Optional pre-configured :class:`~eigent.client.EigentClient`.
        exclude_paths: Paths that bypass verification.
        tool_extractor: Callable ``(Request) -> str | None`` that derives the
            tool name from the request.  Defaults to last path segment.
    """

    def __init__(
        self,
        app: Any,
        registry_url: str = "http://localhost:3456",
        *,
        client: EigentClient | None = None,
        exclude_paths: list[str] | None = None,
        tool_extractor: Callable[[Any], str | None] | None = None,
    ) -> None:
        super().__init__(app)
        self.client = client or EigentClient(registry_url=registry_url)
        self.exclude_paths: set[str] = set(exclude_paths or [])
        self.tool_extractor = tool_extractor or self._default_tool_extractor

    @staticmethod
    def _default_tool_extractor(request: Any) -> str | None:
        """Use the last non-empty path segment as the tool name."""
        parts = [p for p in request.url.path.rstrip("/").split("/") if p]
        return parts[-1] if parts else None

    async def dispatch(
        self,
        request: Any,
        call_next: Any,
    ) -> Any:
        # Skip excluded paths.
        if request.url.path in self.exclude_paths:
            return await call_next(request)

        # Extract bearer token.
        auth_header: str = request.headers.get("authorization", "")
        if not auth_header.lower().startswith("bearer "):
            return JSONResponse(
                status_code=401,
                content={
                    "error": "Missing or malformed Authorization header.",
                    "fix": "Include 'Authorization: Bearer <eigent-token>' in the request.",
                },
            )
        token = auth_header[7:]  # strip "Bearer "

        # Extract tool name.
        tool = self.tool_extractor(request)
        if tool is None:
            return JSONResponse(
                status_code=400,
                content={
                    "error": "Could not determine tool name from request path.",
                    "fix": "Provide a tool_extractor or structure URLs as /tools/<tool_name>.",
                },
            )

        # Verify.
        result = self.client.verify(token=token, tool=tool)
        if not result.allowed:
            return JSONResponse(
                status_code=403,
                content={
                    "error": f"Permission denied for tool '{tool}'.",
                    "reason": result.reason,
                    "fix": (
                        f"Re-register the agent with '{tool}' in its scope, "
                        "or request delegation from a parent that holds it."
                    ),
                },
            )

        # Attach claims to request state for downstream handlers.
        request.state.eigent = result
        return await call_next(request)
