"""Rich terminal report generator for Eigent scan results."""

from __future__ import annotations

import json

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from eigent_scan.models import AuthStatus, ScanResult, Severity

SEVERITY_COLORS = {
    Severity.CRITICAL: "bold red",
    Severity.HIGH: "red",
    Severity.MEDIUM: "yellow",
    Severity.LOW: "cyan",
    Severity.INFO: "dim",
}

SEVERITY_ICONS = {
    Severity.CRITICAL: "[!]",
    Severity.HIGH: "[!]",
    Severity.MEDIUM: "[~]",
    Severity.LOW: "[-]",
    Severity.INFO: "[i]",
}

AUTH_DISPLAY = {
    AuthStatus.NONE: ("NONE", "bold red"),
    AuthStatus.API_KEY: ("API Key", "yellow"),
    AuthStatus.OAUTH: ("OAuth", "green"),
    AuthStatus.IAM: ("IAM", "green"),
    AuthStatus.UNKNOWN: ("Unknown", "dim"),
}


def render_table(result: ScanResult, console: Console | None = None) -> None:
    """Render the full scan report to the terminal."""
    if console is None:
        console = Console()

    _render_banner(console)
    _render_summary(result, console)

    if result.agents:
        _render_agents_table(result, console)

    if result.findings:
        _render_findings(result, console)
        _render_recommendations(result, console)

    _render_footer(result, console)


def render_json(result: ScanResult, console: Console | None = None) -> None:
    """Render scan results as JSON."""
    if console is None:
        console = Console()

    output = {
        "scan_id": result.scan_id,
        "timestamp": result.timestamp.isoformat(),
        "summary": {
            "total_agents": result.total_agents,
            "agents_no_auth": result.agents_no_auth,
            "total_findings": len(result.findings),
            "critical_findings": result.critical_findings,
            "high_findings": result.high_findings,
            "overall_risk": result.overall_risk.value,
        },
        "agents": [a.model_dump(mode="json") for a in result.agents],
        "findings": [f.model_dump(mode="json") for f in result.findings],
        "targets_scanned": result.targets_scanned,
        "scanner_version": result.scanner_version,
        "scan_duration_seconds": result.scan_duration_seconds,
    }

    console.print_json(json.dumps(output, default=str))


def _render_banner(console: Console) -> None:
    """Render the Eigent banner."""
    banner = Text()
    banner.append("\n  Eigent Scan", style="bold white")
    banner.append("  v0.1.0\n", style="dim")
    banner.append("  Discover AI agents. Expose security gaps.\n", style="italic dim")

    console.print(Panel(
        banner,
        border_style="blue",
        padding=(0, 1),
    ))


def _render_summary(result: ScanResult, console: Console) -> None:
    """Render the scan summary panel."""
    risk = result.overall_risk
    risk_style = SEVERITY_COLORS[risk]

    summary = Table.grid(padding=(0, 2))
    summary.add_column(style="bold")
    summary.add_column()

    summary.add_row("Targets scanned:", ", ".join(result.targets_scanned) or "none")
    summary.add_row("Agents discovered:", str(result.total_agents))
    summary.add_row("Agents with no auth:", Text(str(result.agents_no_auth), style="bold red" if result.agents_no_auth > 0 else "green"))
    summary.add_row("Security findings:", str(len(result.findings)))
    summary.add_row("  Critical:", Text(str(result.critical_findings), style="bold red" if result.critical_findings > 0 else "dim"))
    summary.add_row("  High:", Text(str(result.high_findings), style="red" if result.high_findings > 0 else "dim"))
    summary.add_row("Overall risk:", Text(risk.value.upper(), style=risk_style))
    summary.add_row("Scan duration:", f"{result.scan_duration_seconds:.2f}s")

    console.print(Panel(summary, title="Scan Summary", border_style=risk_style, padding=(1, 2)))


def _render_agents_table(result: ScanResult, console: Console) -> None:
    """Render the discovered agents table."""
    table = Table(
        title="Discovered AI Agents / MCP Servers",
        show_header=True,
        header_style="bold",
        border_style="blue",
        show_lines=True,
    )

    table.add_column("#", style="dim", width=3)
    table.add_column("Name", style="bold")
    table.add_column("Source")
    table.add_column("Transport")
    table.add_column("Auth")
    table.add_column("Command / URL", max_width=40, overflow="ellipsis")
    table.add_column("Config", max_width=35, overflow="ellipsis")

    for i, agent in enumerate(result.agents, 1):
        auth_text, auth_style = AUTH_DISPLAY.get(agent.auth_status, ("?", "dim"))

        # Build command display
        if agent.command:
            cmd = agent.command
            if agent.args:
                cmd += " " + " ".join(agent.args[:2])
                if len(agent.args) > 2:
                    cmd += " ..."
        elif agent.url:
            cmd = agent.url
        else:
            cmd = "-"

        # Shorten config path for display
        config = agent.config_path or "-"
        if "/.claude/" in config:
            config = "~/.claude/..." + config.split("/.claude/")[-1]
        elif "/Library/Application Support/" in config:
            config = "~/Library/.../Claude/" + config.split("/Claude/")[-1]

        status = "[dim]disabled[/dim]" if agent.metadata.get("disabled") else ""

        table.add_row(
            str(i),
            f"{agent.name} {status}",
            agent.source.value,
            agent.transport.value,
            Text(auth_text, style=auth_style),
            cmd,
            config,
        )

    console.print()
    console.print(table)


def _render_findings(result: ScanResult, console: Console) -> None:
    """Render security findings."""
    console.print()
    console.print(Text(" Security Findings ", style="bold white on red"), justify="left")
    console.print()

    # Sort by severity
    severity_order = [Severity.CRITICAL, Severity.HIGH, Severity.MEDIUM, Severity.LOW, Severity.INFO]
    sorted_findings = sorted(result.findings, key=lambda f: severity_order.index(f.severity))

    for i, finding in enumerate(sorted_findings, 1):
        style = SEVERITY_COLORS[finding.severity]
        icon = SEVERITY_ICONS[finding.severity]

        console.print(
            f"  {icon} ",
            Text(finding.severity.value.upper(), style=style),
            f"  {finding.title}",
        )
        console.print(f"      {finding.description}", style="dim")
        if finding.config_path:
            console.print(f"      File: {finding.config_path}", style="dim italic")
        console.print()


def _render_recommendations(result: ScanResult, console: Console) -> None:
    """Render top recommendations based on findings."""
    if not result.findings:
        return

    # Deduplicate recommendations, keep highest severity
    seen: dict[str, Severity] = {}
    recs: list[tuple[Severity, str]] = []

    severity_order = [Severity.CRITICAL, Severity.HIGH, Severity.MEDIUM, Severity.LOW, Severity.INFO]

    for finding in sorted(result.findings, key=lambda f: severity_order.index(f.severity)):
        rec = finding.recommendation
        if rec not in seen:
            seen[rec] = finding.severity
            recs.append((finding.severity, rec))

    table = Table(
        title="Recommendations",
        show_header=True,
        header_style="bold",
        border_style="green",
        show_lines=True,
    )
    table.add_column("Priority", width=10)
    table.add_column("Action")

    for i, (severity, rec) in enumerate(recs[:8], 1):  # Top 8 recommendations
        style = SEVERITY_COLORS[severity]
        table.add_row(
            Text(severity.value.upper(), style=style),
            rec,
        )

    console.print(table)


def _render_footer(result: ScanResult, console: Console) -> None:
    """Render the scan footer with next steps."""
    console.print()

    if result.total_agents == 0 and not result.findings:
        console.print(Panel(
            "[green]No AI agents or MCP servers detected in scanned locations.[/green]\n\n"
            "This could mean:\n"
            "  - No MCP servers are configured on this machine\n"
            "  - Configs are in non-standard locations\n"
            "  - Try scanning with --verbose for details",
            title="Clean Scan",
            border_style="green",
        ))
    else:
        console.print(Panel(
            "[bold]What's next?[/bold]\n\n"
            "  [dim]1.[/dim] Review findings above and address critical issues first\n"
            "  [dim]2.[/dim] Export results:  [cyan]eigent-scan scan --output json > results.json[/cyan]\n"
            "  [dim]3.[/dim] Track changes:   Re-run this scan regularly to detect drift\n"
            "  [dim]4.[/dim] Full platform:   [blue]https://eigent.dev[/blue] for continuous monitoring\n",
            title="Next Steps",
            border_style="blue",
        ))

    console.print(
        "  [dim]eigent-scan v0.1.0 | https://github.com/saichandrasekhar/Eigent | Apache 2.0[/dim]"
    )
    console.print()
