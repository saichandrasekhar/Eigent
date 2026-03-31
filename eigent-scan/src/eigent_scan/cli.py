"""Eigent Scan CLI — discover AI agents and their security gaps."""

from __future__ import annotations

import logging
import time

import click
from rich.console import Console

from eigent_scan import __version__
from eigent_scan.alerts import AlertChannel, AlertConfig, send_alert, send_scan_summary
from eigent_scan.config import EigentConfig, load_config
from eigent_scan.models import Agent, Finding, ScanResult, Severity
from eigent_scan.report import render_diff, render_json, render_table
from eigent_scan.report_html import render_html
from eigent_scan.sarif import render_sarif
from eigent_scan.scanners import aws_scanner, mcp_scanner, process_scanner

logger = logging.getLogger(__name__)

# Ordered from most to least severe for --fail-on threshold comparison
_SEVERITY_ORDER = [Severity.CRITICAL, Severity.HIGH, Severity.MEDIUM, Severity.LOW, Severity.INFO]

console = Console()

TARGETS = {
    "mcp": ("MCP Servers (config)", mcp_scanner.scan),
    "aws": ("AWS Agents", aws_scanner.scan),
    "process": ("Live MCP Processes", process_scanner.scan),
    "live": ("Live MCP Processes", process_scanner.scan),
    # "azure": ("Azure Agents", azure_scanner.scan),  # Coming soon
    # "gcp": ("GCP Agents", gcp_scanner.scan),        # Coming soon
}


def _build_alert_configs(
    webhook_url: str | None,
    eigent_config: EigentConfig,
) -> list[AlertConfig]:
    """Build the list of alert configs from CLI flag + config file."""
    configs: list[AlertConfig] = list(eigent_config.alert_configs)

    if webhook_url:
        configs.append(
            AlertConfig(
                webhook_url=webhook_url,
                channel=AlertChannel.GENERIC,
                min_severity=Severity.HIGH,
            )
        )

    return configs


def _dispatch_alerts(
    result: ScanResult,
    diff: "ScanDiff | None",
    alert_configs: list[AlertConfig],
    verbose: bool = False,
) -> None:
    """Send alerts for findings that meet each config's threshold, plus a summary."""
    if not alert_configs:
        return

    for cfg in alert_configs:
        sent_count = 0
        for finding in result.findings:
            if send_alert(finding, cfg):
                sent_count += 1

        summary_ok = send_scan_summary(result, diff, cfg)

        if verbose:
            channel_label = cfg.channel.value
            console.print(
                f"  [dim]Alerts ({channel_label}): "
                f"{sent_count} finding(s) sent, "
                f"summary {'sent' if summary_ok else 'failed'}[/dim]"
            )


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
    type=click.Choice(["table", "json", "sarif", "html"], case_sensitive=False),
    default="table",
    help="Output format. Default: table.",
)
@click.option(
    "--fail-on",
    type=click.Choice(["critical", "high", "medium", "low", "none"], case_sensitive=False),
    default="none",
    help="Exit with code 1 if any finding meets or exceeds this severity. Default: none (always pass).",
)
@click.option(
    "--verbose",
    "-v",
    is_flag=True,
    default=False,
    help="Show detailed scan progress and debug info.",
)
@click.option(
    "--save/--no-save",
    default=True,
    help="Save scan result to local store (default: save).",
)
@click.option(
    "--alert-webhook",
    default=None,
    help="Webhook URL for one-off alerting (generic JSON POST).",
)
def scan(target: str, output: str, fail_on: str, verbose: bool, save: bool, alert_webhook: str | None):
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

    # Compute diff against previous scan and persist
    diff = None
    if save:
        try:
            from eigent_scan.diff import diff_results
            from eigent_scan.store import ScanStore

            store = ScanStore()
            previous = store.get_latest()
            if previous is not None:
                diff = diff_results(previous, result)
            store.save_result(result)
            if verbose:
                console.print(f"  [dim]Scan saved with id: {result.scan_id}[/dim]")
        except Exception as e:
            if verbose:
                console.print(f"  [dim red]Failed to save scan result: {e}[/dim red]")

    # Render output
    if output == "sarif":
        import json as json_mod

        sarif_output = render_sarif(result)
        click.echo(json_mod.dumps(sarif_output, indent=2, default=str))
    elif output == "html":
        from pathlib import Path

        html_str = render_html(result, diff=diff)
        out_path = Path(f"eigent-report-{result.scan_id}.html").resolve()
        out_path.write_text(html_str, encoding="utf-8")
        console.print(f"\n  [bold green]HTML report written to:[/bold green] {out_path}\n")
    elif output == "json":
        render_json(result, console)
    else:
        render_table(result, console, diff=diff)

    # Dispatch alerts
    eigent_config = load_config()
    alert_configs = _build_alert_configs(alert_webhook, eigent_config)
    _dispatch_alerts(result, diff, alert_configs, verbose=verbose)

    # Check --fail-on threshold
    if fail_on != "none":
        threshold = Severity(fail_on)
        threshold_idx = _SEVERITY_ORDER.index(threshold)
        # Fail if any finding has severity at or above (i.e., index <= threshold_idx)
        for finding in result.findings:
            finding_idx = _SEVERITY_ORDER.index(finding.severity)
            if finding_idx <= threshold_idx:
                raise SystemExit(1)


@cli.command()
@click.option(
    "--test",
    "send_test",
    is_flag=True,
    default=False,
    help="Send a test alert to verify webhook configuration.",
)
@click.option(
    "--webhook",
    default=None,
    help="Override webhook URL for testing (generic JSON POST).",
)
def alert(send_test: bool, webhook: str | None):
    """Manage alert configuration and send test alerts."""
    eigent_config = load_config()

    if send_test:
        configs = _build_alert_configs(webhook, eigent_config)
        if not configs:
            console.print(
                "\n  [red]No alert destinations configured.[/red]\n"
                "  Use --webhook URL or add alerts to ~/.eigent/config.yaml\n"
            )
            raise SystemExit(1)

        test_finding = Finding(
            agent_name="eigent-test-agent",
            severity=Severity.HIGH,
            title="Test alert from Eigent",
            description="This is a test alert to verify your webhook integration.",
            recommendation="No action required — this is a connectivity test.",
        )

        console.print("\n[bold]Sending test alerts...[/bold]\n")
        for cfg in configs:
            ok = send_alert(test_finding, cfg)
            status = "[green]OK[/green]" if ok else "[red]FAILED[/red]"
            console.print(f"  {cfg.channel.value} ({cfg.webhook_url[:50]}...): {status}")
        console.print()
    else:
        configs = eigent_config.alert_configs
        if not configs:
            console.print(
                "\n  [yellow]No alert destinations configured.[/yellow]\n"
                "  Add alerts to ~/.eigent/config.yaml or .eigent.yaml\n"
            )
            return

        console.print("\n[bold]Configured alert destinations:[/bold]\n")
        for cfg in configs:
            console.print(
                f"  - {cfg.channel.value}: {cfg.webhook_url[:50]}... "
                f"(min_severity={cfg.min_severity.value})"
            )
        console.print()


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


@cli.command()
@click.option(
    "--limit",
    "-n",
    default=20,
    help="Number of recent scans to show (default: 20).",
)
def history(limit: int):
    """Show recent scan history with risk trends."""
    from rich.table import Table as RichTable

    from eigent_scan.store import ScanStore

    try:
        store = ScanStore()
    except Exception as e:
        console.print(f"  [red]Failed to open scan store: {e}[/red]")
        return

    results = store.list_results(limit=limit)

    if not results:
        console.print(
            "\n  [dim]No scan history found. "
            "Run [cyan]eigent-scan scan[/cyan] first.[/dim]\n"
        )
        return

    table = RichTable(
        title="Scan History",
        show_header=True,
        header_style="bold",
        border_style="blue",
        show_lines=True,
    )
    table.add_column("#", style="dim", width=3)
    table.add_column("Scan ID")
    table.add_column("Timestamp")
    table.add_column("Targets")
    table.add_column("Agents", justify="right")
    table.add_column("Findings", justify="right")
    table.add_column("Critical", justify="right")
    table.add_column("Risk")

    risk_colors = {
        "critical": "bold red",
        "high": "red",
        "medium": "yellow",
        "low": "cyan",
        "info": "dim",
    }

    for i, summary in enumerate(results, 1):
        risk_style = risk_colors.get(summary.overall_risk, "dim")
        table.add_row(
            str(i),
            summary.id,
            summary.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            summary.targets or "-",
            str(summary.total_agents),
            str(summary.total_findings),
            str(summary.critical_findings),
            f"[{risk_style}]{summary.overall_risk.upper()}[/{risk_style}]",
        )

    console.print()
    console.print(table)
    console.print()


@cli.command()
@click.option(
    "--scan-id",
    default=None,
    help=(
        "Compare the latest scan against this specific scan ID. "
        "Defaults to comparing the two most recent scans."
    ),
)
def diff(scan_id: str | None):
    """Compare the latest scan to a previous one and show what changed."""
    from eigent_scan.diff import diff_results
    from eigent_scan.store import ScanStore

    try:
        store = ScanStore()
    except Exception as e:
        console.print(f"  [red]Failed to open scan store: {e}[/red]")
        return

    if scan_id is not None:
        try:
            previous = store.get_result(scan_id)
        except KeyError:
            console.print(f"\n  [red]Scan not found: {scan_id}[/red]")
            console.print(
                "  Run [cyan]eigent-scan history[/cyan] to see available scans.\n"
            )
            return

        latest = store.get_latest()
        if latest is None:
            console.print(
                "\n  [dim]No scans found. "
                "Run [cyan]eigent-scan scan[/cyan] first.[/dim]\n"
            )
            return

        if latest.scan_id == scan_id:
            console.print(
                "\n  [yellow]The specified scan is the latest scan. "
                "Nothing to compare.[/yellow]\n"
            )
            return
    else:
        summaries = store.list_results(limit=2)
        if len(summaries) < 2:
            console.print(
                "\n  [dim]Need at least 2 scans to diff. "
                "Run [cyan]eigent-scan scan[/cyan] again.[/dim]\n"
            )
            return

        latest = store.get_result(summaries[0].id)
        previous = store.get_result(summaries[1].id)

    scan_diff = diff_results(previous, latest)

    console.print(
        f"\n  Comparing scan [cyan]{previous.scan_id}[/cyan] "
        f"-> [cyan]{latest.scan_id}[/cyan]\n"
    )

    render_diff(scan_diff, console)

    if not scan_diff.has_changes:
        console.print("  [dim]No changes detected between these scans.[/dim]\n")


@cli.command()
@click.option(
    "--scan-id",
    default=None,
    help="ID of a previous scan. Defaults to the most recent scan.",
)
@click.option(
    "--format",
    "fmt",
    type=click.Choice(["html", "json"], case_sensitive=False),
    default="html",
    help="Report format. Default: html.",
)
def report(scan_id: str | None, fmt: str):
    """Generate a report from a stored scan result."""
    from pathlib import Path

    from eigent_scan.diff import diff_results
    from eigent_scan.store import ScanStore

    try:
        store = ScanStore()
    except Exception as e:
        console.print(f"  [red]Failed to open scan store: {e}[/red]")
        raise SystemExit(1) from e

    if scan_id:
        try:
            result = store.get_result(scan_id)
        except KeyError:
            console.print(f"\n  [red]Scan not found: {scan_id}[/red]")
            console.print("  Run [cyan]eigent-scan history[/cyan] to see available scans.\n")
            raise SystemExit(1)
    else:
        result = store.get_latest()
        if result is None:
            console.print(
                "\n  [red]No stored scan found.[/red] "
                "Run [cyan]eigent-scan scan[/cyan] first.\n"
            )
            raise SystemExit(1)

    # Try to compute a diff against the previous scan for trend data
    scan_diff = None
    summaries = store.list_results(limit=20)
    # Find the scan just before the one we're reporting on
    found = False
    for summary in summaries:
        if found:
            try:
                previous = store.get_result(summary.id)
                scan_diff = diff_results(previous, result)
            except Exception:
                pass
            break
        if summary.id == result.scan_id:
            found = True

    if fmt == "json":
        render_json(result, console)
    else:
        html_str = render_html(result, diff=scan_diff)
        out_path = Path(f"eigent-report-{result.scan_id}.html").resolve()
        out_path.write_text(html_str, encoding="utf-8")
        console.print(f"\n  [bold green]HTML report written to:[/bold green] {out_path}\n")


def main():
    """Entry point for the CLI."""
    cli()


if __name__ == "__main__":
    main()
