"""Eigent Python SDK — AI agent identity, delegation, and compliance."""

__version__ = "0.1.0"

from eigent.client import EigentClient
from eigent.decorators import eigent_protected
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
    "EigentClient",
    "eigent_protected",
    "Agent",
    "AuditEvent",
    "ComplianceReport",
    "DelegationResult",
    "RevocationResult",
    "Session",
    "VerifyResult",
]
