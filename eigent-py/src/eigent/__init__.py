"""Eigent Python SDK — AI agent identity, delegation, and compliance."""

__version__ = "0.2.0"

from eigent.async_client import AsyncEigentClient
from eigent.client import EigentClient
from eigent.decorators import eigent_protected
from eigent.exceptions import (
    EigentAPIError,
    EigentDelegationDenied,
    EigentError,
    EigentPermissionDenied,
    EigentRegistryUnreachable,
    EigentTokenExpired,
    EigentTokenRevoked,
)
from eigent.models import (
    Agent,
    AuditEvent,
    ComplianceReport,
    DelegationResult,
    RevocationResult,
    Session,
    VerifyResult,
)

__all__ = [
    "AsyncEigentClient",
    "EigentClient",
    "eigent_protected",
    # Exceptions
    "EigentAPIError",
    "EigentDelegationDenied",
    "EigentError",
    "EigentPermissionDenied",
    "EigentRegistryUnreachable",
    "EigentTokenExpired",
    "EigentTokenRevoked",
    # Models
    "Agent",
    "AuditEvent",
    "ComplianceReport",
    "DelegationResult",
    "RevocationResult",
    "Session",
    "VerifyResult",
]
