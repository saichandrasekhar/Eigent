"""Compliance mapping for Eigent scan findings."""

from __future__ import annotations

from dataclasses import dataclass

from eigent_scan.models import Finding


@dataclass(frozen=True)
class ComplianceTag:
    """A compliance framework reference linked to a finding."""

    framework: str
    control_id: str
    title: str
    description: str


# Keyword-based mapping: if any keyword appears in the finding title (lowercased),
# the associated compliance tags apply.
_MAPPING: list[tuple[list[str], list[ComplianceTag]]] = [
    (
        ["no authentication", "no auth", "unauthenticated"],
        [
            ComplianceTag(
                framework="SOC 2",
                control_id="CC6.1",
                title="Logical and Physical Access Controls",
                description=(
                    "The entity implements logical access security software, infrastructure, "
                    "and architectures over protected information assets to protect them from "
                    "security events."
                ),
            ),
            ComplianceTag(
                framework="EU AI Act",
                control_id="Art. 9",
                title="Risk Management System",
                description=(
                    "A risk management system shall be established, implemented, documented "
                    "and maintained in relation to high-risk AI systems."
                ),
            ),
        ],
    ),
    (
        ["high-risk server", "remote server", "sse transport", "http transport"],
        [
            ComplianceTag(
                framework="SOC 2",
                control_id="CC6.3",
                title="Role-Based Access and Least Privilege",
                description=(
                    "The entity authorizes, modifies, or removes access to data, software, "
                    "functions, and other protected information assets based on roles."
                ),
            ),
            ComplianceTag(
                framework="EU AI Act",
                control_id="Art. 14",
                title="Human Oversight",
                description=(
                    "High-risk AI systems shall be designed and developed in such a way that "
                    "they can be effectively overseen by natural persons."
                ),
            ),
        ],
    ),
    (
        ["shadow agent", "shadow", "unregistered"],
        [
            ComplianceTag(
                framework="SOC 2",
                control_id="CC6.1",
                title="Logical and Physical Access Controls",
                description=(
                    "Undocumented agents represent unauthorized access vectors that bypass "
                    "established security controls."
                ),
            ),
            ComplianceTag(
                framework="EU AI Act",
                control_id="Art. 12",
                title="Record-Keeping",
                description=(
                    "High-risk AI systems shall technically allow for the automatic recording "
                    "of events (logs) over the lifetime of the system."
                ),
            ),
        ],
    ),
    (
        ["secrets in env", "environment variable", "env var", "api key in env"],
        [
            ComplianceTag(
                framework="SOC 2",
                control_id="CC6.6",
                title="Restriction of Access to System Components",
                description=(
                    "The entity restricts the ability to manage access to protected assets "
                    "to authorized parties. Secrets stored in plaintext environment variables "
                    "violate this control."
                ),
            ),
        ],
    ),
    (
        ["supply chain", "npx", "npm exec", "remote package"],
        [
            ComplianceTag(
                framework="SOC 2",
                control_id="CC6.8",
                title="Controls Over System Components",
                description=(
                    "The entity restricts the ability to change or install software to "
                    "authorized parties. Dynamic package execution via npx introduces "
                    "uncontrolled supply chain risk."
                ),
            ),
            ComplianceTag(
                framework="EU AI Act",
                control_id="Art. 17",
                title="Quality Management System",
                description=(
                    "Providers of high-risk AI systems shall put a quality management system "
                    "in place that ensures compliance, including supply chain controls."
                ),
            ),
        ],
    ),
    (
        ["world-readable", "file permission", "permissions"],
        [
            ComplianceTag(
                framework="SOC 2",
                control_id="CC6.1",
                title="Logical and Physical Access Controls",
                description=(
                    "Configuration files with overly permissive file system permissions "
                    "allow unauthorized access to agent configurations and credentials."
                ),
            ),
        ],
    ),
    (
        ["overpermission", "excessive tool", "tool access"],
        [
            ComplianceTag(
                framework="SOC 2",
                control_id="CC6.3",
                title="Role-Based Access and Least Privilege",
                description=(
                    "Agents with excessive tool access violate the principle of least "
                    "privilege required by this control."
                ),
            ),
            ComplianceTag(
                framework="EU AI Act",
                control_id="Art. 9",
                title="Risk Management System",
                description=(
                    "Overpermissioned agents increase the attack surface and must be "
                    "assessed under the AI Act risk management framework."
                ),
            ),
        ],
    ),
]


def get_compliance_tags(finding: Finding) -> list[ComplianceTag]:
    """Return compliance tags applicable to a given finding.

    Matches are determined by keyword presence in the finding title
    (case-insensitive).
    """
    title_lower = finding.title.lower()
    desc_lower = finding.description.lower()
    combined = f"{title_lower} {desc_lower}"

    tags: list[ComplianceTag] = []
    seen: set[tuple[str, str]] = set()

    for keywords, mapped_tags in _MAPPING:
        if any(kw in combined for kw in keywords):
            for tag in mapped_tags:
                key = (tag.framework, tag.control_id)
                if key not in seen:
                    seen.add(key)
                    tags.append(tag)

    return tags
