"""Diff engine for comparing two Eigent scan results."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from eigent_scan.models import Agent, Finding, ScanResult, Severity


@dataclass
class AgentChange:
    """Describes what changed for a single agent between two scans."""

    agent_name: str
    source: str
    changes: list[str] = field(default_factory=list)


@dataclass
class ScanDiff:
    """Result of comparing two scan results."""

    new_agents: list[Agent] = field(default_factory=list)
    removed_agents: list[Agent] = field(default_factory=list)
    changed_agents: list[AgentChange] = field(default_factory=list)
    new_findings: list[Finding] = field(default_factory=list)
    resolved_findings: list[Finding] = field(default_factory=list)
    risk_change: tuple[Severity, Severity] | None = None  # (old, new)

    @property
    def has_changes(self) -> bool:
        return bool(
            self.new_agents
            or self.removed_agents
            or self.changed_agents
            or self.new_findings
            or self.resolved_findings
            or (self.risk_change and self.risk_change[0] != self.risk_change[1])
        )


def _agent_key(agent: Agent) -> str:
    """Unique key for an agent: name + source."""
    return f"{agent.name}||{agent.source.value}"


def _finding_key(finding: Finding) -> str:
    """Unique key for a finding: agent_name + title."""
    return f"{finding.agent_name}||{finding.title}"


def _compare_agents(previous: Agent, current: Agent) -> list[str]:
    """Return a list of human-readable change descriptions between two versions of the same agent."""
    changes: list[str] = []

    if previous.auth_status != current.auth_status:
        changes.append(
            f"Auth changed: {previous.auth_status.value} -> {current.auth_status.value}"
        )

    if previous.transport != current.transport:
        changes.append(
            f"Transport changed: {previous.transport.value} -> {current.transport.value}"
        )

    prev_tools = set(previous.tools_exposed)
    curr_tools = set(current.tools_exposed)
    added_tools = curr_tools - prev_tools
    removed_tools = prev_tools - curr_tools
    if added_tools:
        changes.append(f"New tools exposed: {', '.join(sorted(added_tools))}")
    if removed_tools:
        changes.append(f"Tools removed: {', '.join(sorted(removed_tools))}")

    if previous.command != current.command:
        changes.append(f"Command changed: {previous.command} -> {current.command}")

    if previous.url != current.url:
        changes.append(f"URL changed: {previous.url} -> {current.url}")

    prev_env = set(previous.env_vars)
    curr_env = set(current.env_vars)
    added_env = curr_env - prev_env
    removed_env = prev_env - curr_env
    if added_env:
        changes.append(f"New env vars: {', '.join(sorted(added_env))}")
    if removed_env:
        changes.append(f"Env vars removed: {', '.join(sorted(removed_env))}")

    if previous.config_path != current.config_path:
        changes.append(
            f"Config path changed: {previous.config_path} -> {current.config_path}"
        )

    return changes


def diff_results(previous: ScanResult, current: ScanResult) -> ScanDiff:
    """Compare two scan results and return a structured diff."""
    diff = ScanDiff()

    # --- Risk change ---
    prev_risk = previous.overall_risk
    curr_risk = current.overall_risk
    diff.risk_change = (prev_risk, curr_risk)

    # --- Agent diff ---
    prev_agents = {_agent_key(a): a for a in previous.agents}
    curr_agents = {_agent_key(a): a for a in current.agents}

    prev_keys = set(prev_agents.keys())
    curr_keys = set(curr_agents.keys())

    for key in curr_keys - prev_keys:
        diff.new_agents.append(curr_agents[key])

    for key in prev_keys - curr_keys:
        diff.removed_agents.append(prev_agents[key])

    for key in prev_keys & curr_keys:
        changes = _compare_agents(prev_agents[key], curr_agents[key])
        if changes:
            diff.changed_agents.append(
                AgentChange(
                    agent_name=curr_agents[key].name,
                    source=curr_agents[key].source.value,
                    changes=changes,
                )
            )

    # --- Finding diff ---
    prev_findings = {_finding_key(f): f for f in previous.findings}
    curr_findings = {_finding_key(f): f for f in current.findings}

    prev_fkeys = set(prev_findings.keys())
    curr_fkeys = set(curr_findings.keys())

    for key in curr_fkeys - prev_fkeys:
        diff.new_findings.append(curr_findings[key])

    for key in prev_fkeys - curr_fkeys:
        diff.resolved_findings.append(prev_findings[key])

    return diff


def format_diff_text(diff: ScanDiff) -> str:
    """Return a human-readable text summary of the diff."""
    if not diff.has_changes:
        return "No changes since last scan."

    lines: list[str] = []

    if diff.risk_change and diff.risk_change[0] != diff.risk_change[1]:
        old, new = diff.risk_change
        lines.append(f"Risk: {old.value.upper()} -> {new.value.upper()}")

    if diff.new_agents:
        lines.append(f"\n+{len(diff.new_agents)} new agent(s):")
        for a in diff.new_agents:
            lines.append(f"  + {a.name} ({a.source.value}, auth={a.auth_status.value})")

    if diff.removed_agents:
        lines.append(f"\n-{len(diff.removed_agents)} removed agent(s):")
        for a in diff.removed_agents:
            lines.append(f"  - {a.name} ({a.source.value})")

    if diff.changed_agents:
        lines.append(f"\n~{len(diff.changed_agents)} changed agent(s):")
        for ac in diff.changed_agents:
            lines.append(f"  ~ {ac.agent_name} ({ac.source}):")
            for change in ac.changes:
                lines.append(f"      {change}")

    if diff.new_findings:
        lines.append(f"\n+{len(diff.new_findings)} new finding(s):")
        for f in diff.new_findings:
            lines.append(f"  + [{f.severity.value.upper()}] {f.title}")

    if diff.resolved_findings:
        lines.append(f"\n-{len(diff.resolved_findings)} resolved finding(s):")
        for f in diff.resolved_findings:
            lines.append(f"  - [{f.severity.value.upper()}] {f.title}")

    return "\n".join(lines)
