"""Eigent Scan CLI — discover AI agents and their security gaps."""

from __future__ import annotations

import time

import click
from rich.console import Console

from eigent_scan import __version__
from eigent_scan.models import Agent, Finding, ScanResult
from eigent_scan.report import render_json, render_table
from eigent_scan.scanners import aws_scanner, mcp_scanner, process_scanner

console = Console()

TARGETS = {
    "mcp": ("MCP Servers (config)", mcp_scanner.scan),
    "aws": ("AWS Agents", aws_scanner.scan),
    "process": ("Live MCP Processes", process_scanner.scan),
    "live": ("Live MCP Processes", process_scanner.scan),
    # "azure": ("Azure Agents", azure_scanner.scan),  # Coming soon
    # "gcp": ("GCP Agents", gcp_scanner.scan),        # Coming soon
}


@click.group()
@click.version_option(version=__version__, prog_name="eigent-scan")
def cli():
    """Eigent Scan -- discover AI agents, their permissions, and security gaps.

    Scans your local environment and cloud infrastructure to find AI agents,
    MCP servers, and LLM-powered services. Identifies authentication gaps,
    overpermissions, and security misconfigurations.
    """
    pass


@cli.command()
@click.option(
    "--target",
    "-t",
    type=click.Choice(["mcp", "aws", "process", "live", "azure", "gcp", "all"], case_sensitive=False),
    default="all",
    help="What to scan. Default: all available scanners.",
)
@click.option(
    "--output",
    "-o",
    type=click.Choice(["table", "json"], case_sensitive=False),
    default="table",
    help="Output format. Default: table.",
)
@click.option(
    "--verbose",
    "-v",
    is_flag=True,
    default=False,
    help="Show detailed scan progress and debug info.",
)
def scan(target: str, output: str, verbose: bool):
    """Scan for AI agents and MCP servers in your environment."""
    start = time.time()

    all_agents: list[Agent] = []
    all_findings: list[Finding] = []
    targets_scanned: list[str] = []

    # Determine which scanners to run
    # "live" is an alias for "process" — exclude it from "all" to avoid duplicate runs
    if target == "all":
        scan_targets = [t for t in TARGETS if t not in ("live", "process")]
    elif target in ("azure", "gcp"):
        console.print(f"\n  [yellow]{target.upper()} scanner coming soon.[/yellow]")
        console.print("  Track progress: https://github.com/saichandrasekhar/Eigent/issues\n")
        scan_targets = []
    else:
        scan_targets = [target]

    for t in scan_targets:
        label, scanner_fn = TARGETS[t]
        targets_scanned.append(t)

        if verbose:
            console.print(f"\n[bold blue]Scanning: {label}[/bold blue]")

        agents, findings, logs = scanner_fn(verbose=verbose)

        if verbose:
            for log in logs:
                console.print(f"  [dim]{log}[/dim]")

        all_agents.extend(agents)
        all_findings.extend(findings)

    elapsed = time.time() - start

    result = ScanResult(
        targets_scanned=targets_scanned,
        agents=all_agents,
        findings=all_findings,
        scan_duration_seconds=elapsed,
    )

    # Render output
    if output == "json":
        render_json(result, console)
    else:
        render_table(result, console)


@cli.command()
def targets():
    """List available scan targets and their status."""
    console.print("\n[bold]Available scan targets:[/bold]\n")

    available = [
        ("mcp", "MCP Servers (config files)", "Available", "green"),
        ("process", "Live MCP Processes (process table)", "Available", "green"),
        ("live", "Alias for 'process'", "Available", "green"),
        ("aws", "AWS (Bedrock, Lambda, IAM)", "Coming soon", "yellow"),
        ("azure", "Azure (OpenAI Service, Functions)", "Coming soon", "yellow"),
        ("gcp", "GCP (Vertex AI, Cloud Functions)", "Coming soon", "yellow"),
    ]

    from rich.table import Table

    table = Table(show_header=True, header_style="bold", border_style="blue")
    table.add_column("Target")
    table.add_column("Scope")
    table.add_column("Status")

    for target, scope, status, color in available:
        table.add_row(target, scope, f"[{color}]{status}[/{color}]")

    console.print(table)
    console.print()


@cli.command()
def version():
    """Show version and environment info."""
    import platform
    import sys

    console.print(f"\n  eigent-scan {__version__}")
    console.print(f"  Python {sys.version.split()[0]}")
    console.print(f"  Platform: {platform.system()} {platform.release()}")
    console.print(f"  Architecture: {platform.machine()}")
    console.print()


def main():
    """Entry point for the CLI."""
    cli()


if __name__ == "__main__":
    main()
