"""Live Process Scanner -- discovers RUNNING MCP server processes on the system.

This is the "oh shit" scanner. Instead of reading static config files, it examines
the process table to find MCP servers that are actually running right now, including
ones that may not appear in any configuration file (shadow agents).

Cross-references discovered processes against configured MCP servers to identify:
- UNKNOWN/shadow agents running without any config entry
- Configured servers that are NOT running
- Processes with elevated privileges or suspicious environment variables
"""

from __future__ import annotations

import os
import platform
import re
import subprocess
from typing import Any

from eigent_scan.models import (
    Agent,
    AgentSource,
    AuthStatus,
    Finding,
    Severity,
    TransportType,
)

# Patterns that indicate an MCP server in a process command line
MCP_CMDLINE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"@modelcontextprotocol/", re.IGNORECASE),
    re.compile(r"mcp-server-", re.IGNORECASE),
    re.compile(r"mcp_server", re.IGNORECASE),
    re.compile(r"server-filesystem", re.IGNORECASE),
    re.compile(r"server-github", re.IGNORECASE),
    re.compile(r"server-postgres", re.IGNORECASE),
    re.compile(r"server-sqlite", re.IGNORECASE),
    re.compile(r"server-puppeteer", re.IGNORECASE),
    re.compile(r"server-brave-search", re.IGNORECASE),
    re.compile(r"server-everything", re.IGNORECASE),
    re.compile(r"server-memory", re.IGNORECASE),
    re.compile(r"server-sequential-thinking", re.IGNORECASE),
    re.compile(r"server-slack", re.IGNORECASE),
    re.compile(r"modelcontextprotocol", re.IGNORECASE),
]

# Launcher commands that may run MCP servers
MCP_LAUNCHERS = {"npx", "uvx", "bunx", "pnpx", "node", "python", "python3", "deno"}

# URL patterns in arguments that suggest MCP HTTP/SSE endpoints
MCP_URL_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"/mcp(?:/|$|\?)", re.IGNORECASE),
    re.compile(r"/sse(?:/|$|\?)", re.IGNORECASE),
    re.compile(r"mcp.*server", re.IGNORECASE),
]

# Sensitive environment variable patterns
SENSITIVE_ENV_PATTERNS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"]


def _is_mcp_process(cmdline: list[str]) -> tuple[bool, str]:
    """Determine if a process command line looks like an MCP server.

    Returns:
        Tuple of (is_mcp, matched_reason).
    """
    if not cmdline:
        return False, ""

    full_cmd = " ".join(cmdline)

    # Check against known MCP patterns
    for pattern in MCP_CMDLINE_PATTERNS:
        if pattern.search(full_cmd):
            return True, f"cmdline matches pattern: {pattern.pattern}"

    # Check if a known launcher is running MCP-related arguments
    exe_name = os.path.basename(cmdline[0]).lower() if cmdline else ""
    if exe_name in MCP_LAUNCHERS and len(cmdline) > 1:
        args_str = " ".join(cmdline[1:])
        for pattern in MCP_CMDLINE_PATTERNS:
            if pattern.search(args_str):
                return True, f"{exe_name} running MCP package: {pattern.pattern}"

    # Check for MCP URL patterns in arguments
    for arg in cmdline:
        for pattern in MCP_URL_PATTERNS:
            if pattern.search(arg) and ("http" in arg.lower() or ":" in arg):
                return True, f"argument contains MCP URL pattern: {arg}"

    return False, ""


def _extract_server_name(cmdline: list[str]) -> str:
    """Extract a human-readable server name from the command line."""
    full_cmd = " ".join(cmdline)

    # Try to find @modelcontextprotocol/server-xxx or mcp-server-xxx
    match = re.search(r"@modelcontextprotocol/server-(\w[\w-]*)", full_cmd)
    if match:
        return f"mcp-{match.group(1)}"

    match = re.search(r"mcp-server-([\w-]+)", full_cmd, re.IGNORECASE)
    if match:
        return f"mcp-{match.group(1)}"

    match = re.search(r"mcp_server_([\w]+)", full_cmd, re.IGNORECASE)
    if match:
        return f"mcp-{match.group(1)}"

    match = re.search(r"server-(filesystem|github|postgres|sqlite|puppeteer|slack)", full_cmd, re.IGNORECASE)
    if match:
        return f"mcp-{match.group(1)}"

    # Fallback: use the main executable + first meaningful arg
    exe = os.path.basename(cmdline[0]) if cmdline else "unknown"
    if len(cmdline) > 1 and not cmdline[1].startswith("-"):
        return f"{exe}:{os.path.basename(cmdline[1])}"

    return f"process:{exe}"


def _detect_transport_from_cmdline(cmdline: list[str]) -> TransportType:
    """Infer transport type from command line arguments."""
    full_cmd = " ".join(cmdline).lower()

    if "--stdio" in full_cmd or "stdio" in full_cmd:
        return TransportType.STDIO
    if "/sse" in full_cmd or "--sse" in full_cmd:
        return TransportType.SSE
    if "http" in full_cmd and ("server" in full_cmd or "listen" in full_cmd or "port" in full_cmd):
        return TransportType.HTTP

    # stdio is the most common MCP transport
    return TransportType.STDIO


def _get_process_env(pid: int) -> dict[str, str]:
    """Attempt to read environment variables for a process.

    On macOS uses `ps eww`, on Linux reads /proc/PID/environ.
    Returns empty dict if access is denied.
    """
    env_vars: dict[str, str] = {}
    system = platform.system()

    try:
        if system == "Darwin":
            result = subprocess.run(
                ["ps", "eww", "-p", str(pid), "-o", "command="],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                # ps eww outputs command followed by env vars like KEY=VALUE
                parts = result.stdout.strip().split("\x00")
                if len(parts) <= 1:
                    # Fallback: split on spaces and look for KEY=VALUE
                    parts = result.stdout.strip().split()
                for part in parts:
                    if "=" in part and not part.startswith("-"):
                        key, _, val = part.partition("=")
                        # Only capture the key name, not the value (security)
                        if key.isidentifier() or (key.replace("_", "").isalnum() and key[0:1].isalpha()):
                            env_vars[key] = val

        elif system == "Linux":
            environ_path = f"/proc/{pid}/environ"
            if os.path.exists(environ_path):
                with open(environ_path, "r") as f:
                    content = f.read()
                for entry in content.split("\x00"):
                    if "=" in entry:
                        key, _, val = entry.partition("=")
                        env_vars[key] = val
    except (PermissionError, ProcessLookupError, FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return env_vars


def _get_listening_ports(pid: int) -> list[int]:
    """Get TCP ports a process is listening on.

    Uses lsof on macOS, /proc/net/tcp on Linux.
    """
    ports: list[int] = []
    system = platform.system()

    try:
        if system in ("Darwin", "Linux"):
            result = subprocess.run(
                ["lsof", "-i", "-P", "-n", "-p", str(pid)],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                for line in result.stdout.strip().splitlines()[1:]:  # Skip header
                    if "LISTEN" in line:
                        # Extract port from e.g. "*:3000" or "127.0.0.1:8080"
                        parts = line.split()
                        for part in parts:
                            match = re.search(r":(\d+)$", part)
                            if match:
                                ports.append(int(match.group(1)))
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    return list(set(ports))


def _scan_processes(verbose: bool = False) -> tuple[list[dict[str, Any]], list[str]]:
    """Scan the process table for MCP-related processes using psutil.

    Returns:
        Tuple of (process_info_list, log_messages).
    """
    logs: list[str] = []
    found: list[dict[str, Any]] = []

    try:
        import psutil
    except ImportError:
        logs.append(
            "[error] psutil is not installed. "
            "Install it with: pip install psutil"
        )
        return found, logs

    logs.append("Scanning process table for MCP servers...")

    for proc in psutil.process_iter(["pid", "name", "cmdline", "username", "create_time"]):
        try:
            info = proc.info
            cmdline = info.get("cmdline") or []
            if not cmdline:
                continue

            is_mcp, reason = _is_mcp_process(cmdline)
            if not is_mcp:
                continue

            pid = info["pid"]
            username = info.get("username", "unknown")

            # Gather additional info
            listening_ports = _get_listening_ports(pid)
            env = _get_process_env(pid)

            # Check for elevated privileges
            is_root = username in ("root", "SYSTEM", "Administrator")
            try:
                parent = proc.parent()
                parent_name = parent.name() if parent else None
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                parent_name = None

            process_info = {
                "pid": pid,
                "name": info.get("name", "unknown"),
                "cmdline": cmdline,
                "username": username,
                "is_root": is_root,
                "listening_ports": listening_ports,
                "env_keys": list(env.keys()),
                "sensitive_env_keys": [
                    k for k in env
                    if any(p in k.upper() for p in SENSITIVE_ENV_PATTERNS)
                ],
                "parent_process": parent_name,
                "match_reason": reason,
                "create_time": info.get("create_time"),
            }

            found.append(process_info)

            if verbose:
                logs.append(
                    f"  [live] PID {pid}: {' '.join(cmdline[:5])} "
                    f"(user={username}, ports={listening_ports}, reason={reason})"
                )

        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    logs.append(f"  Found {len(found)} MCP-related process(es)")
    return found, logs


def _find_mcp_network_listeners(verbose: bool = False) -> tuple[list[dict[str, Any]], list[str]]:
    """Scan for processes listening on ports that might be MCP SSE/HTTP servers.

    This catches MCP servers that may not have recognizable command lines but
    are serving on common MCP ports or have MCP-related paths.
    """
    logs: list[str] = []
    found: list[dict[str, Any]] = []

    try:
        import psutil
    except ImportError:
        return found, logs

    logs.append("Scanning for MCP-related network listeners...")

    for conn in psutil.net_connections(kind="tcp"):
        if conn.status != "LISTEN":
            continue
        if conn.pid is None:
            continue

        try:
            proc = psutil.Process(conn.pid)
            cmdline = proc.cmdline()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

        if not cmdline:
            continue

        # Already found by process scan? Skip to avoid duplicates.
        full_cmd = " ".join(cmdline)

        # Check if the listening process has MCP-related indicators
        is_mcp, reason = _is_mcp_process(cmdline)
        if is_mcp:
            # Already caught by the process scanner, skip
            continue

        # Check for processes serving on typical dev ports with MCP URL paths
        for arg in cmdline:
            for pattern in MCP_URL_PATTERNS:
                if pattern.search(arg):
                    port = conn.laddr.port if conn.laddr else None
                    found.append({
                        "pid": conn.pid,
                        "name": proc.name(),
                        "cmdline": cmdline,
                        "username": proc.username(),
                        "listening_port": port,
                        "match_reason": f"network listener with MCP URL pattern in args: {arg}",
                    })
                    if verbose:
                        logs.append(
                            f"  [net] PID {conn.pid} listening on port {port}: "
                            f"{' '.join(cmdline[:4])}"
                        )
                    break

    logs.append(f"  Found {len(found)} additional MCP network listener(s)")
    return found, logs


def _process_to_agent(proc_info: dict[str, Any]) -> Agent:
    """Convert a discovered process info dict into an Agent model."""
    cmdline = proc_info["cmdline"]
    name = _extract_server_name(cmdline)
    transport = _detect_transport_from_cmdline(cmdline)

    # If it has listening ports, it's likely HTTP or SSE
    ports = proc_info.get("listening_ports", [])
    if ports and transport == TransportType.STDIO:
        transport = TransportType.HTTP

    # Build URL for network-listening processes
    url = None
    if ports:
        url = f"http://localhost:{ports[0]}"

    # Check for auth-related env vars
    sensitive_keys = proc_info.get("sensitive_env_keys", [])
    auth_status = AuthStatus.API_KEY if sensitive_keys else AuthStatus.NONE

    return Agent(
        name=name,
        source=AgentSource.LIVE_PROCESS,
        transport=transport,
        auth_status=auth_status,
        command=cmdline[0] if cmdline else None,
        args=[str(a) for a in cmdline[1:]],
        env_vars=proc_info.get("sensitive_env_keys", []),
        url=url,
        config_path=None,
        metadata={
            "pid": proc_info["pid"],
            "username": proc_info["username"],
            "is_root": proc_info.get("is_root", False),
            "listening_ports": ports,
            "parent_process": proc_info.get("parent_process"),
            "match_reason": proc_info.get("match_reason", ""),
            "total_env_keys": len(proc_info.get("env_keys", [])),
            "discovery": "live_process",
        },
    )


def _cross_reference_with_config(
    live_agents: list[Agent],
    verbose: bool = False,
) -> tuple[list[Finding], list[str]]:
    """Cross-reference live processes with configured MCP servers.

    Imports and runs the config-based MCP scanner to get configured servers,
    then compares against running processes.
    """
    findings: list[Finding] = []
    logs: list[str] = []

    # Import the config scanner
    from eigent_scan.scanners import mcp_scanner

    config_agents, _, config_logs = mcp_scanner.scan(verbose=verbose)
    logs.append(f"Cross-referencing {len(live_agents)} live process(es) against {len(config_agents)} configured server(s)...")

    # Build lookup of configured server names (normalized)
    configured_names: set[str] = set()
    for agent in config_agents:
        configured_names.add(agent.name.lower())
        # Also add the command + first arg as a lookup key
        if agent.command and agent.args:
            configured_names.add(f"{os.path.basename(agent.command)}:{agent.args[0]}".lower())

    # Check each live process against config
    for live_agent in live_agents:
        live_name_lower = live_agent.name.lower()
        cmd_key = ""
        if live_agent.command and live_agent.args:
            cmd_key = f"{os.path.basename(live_agent.command)}:{live_agent.args[0]}".lower()

        # Check if this live process matches any configured server
        is_configured = (
            live_name_lower in configured_names
            or (cmd_key and cmd_key in configured_names)
            or any(
                live_name_lower in ca.name.lower() or ca.name.lower() in live_name_lower
                for ca in config_agents
            )
        )

        if not is_configured:
            findings.append(Finding(
                agent_name=live_agent.name,
                severity=Severity.CRITICAL,
                title=f"SHADOW AGENT: '{live_agent.name}' is running but NOT in any config",
                description=(
                    f"A process matching MCP server patterns is running (PID {live_agent.metadata.get('pid')}, "
                    f"user={live_agent.metadata.get('username')}) but does not appear in any known "
                    f"MCP configuration file. This could be a rogue agent, a compromised tool, "
                    f"or a legitimate server started manually. Command: {live_agent.command} "
                    f"{' '.join(live_agent.args[:3])}"
                ),
                recommendation=(
                    "1. Identify who started this process and why. "
                    "2. If legitimate, add it to your MCP configuration for tracking. "
                    "3. If unknown, terminate the process immediately and investigate. "
                    "4. Check system logs for how this process was started."
                ),
                evidence={
                    "pid": live_agent.metadata.get("pid"),
                    "username": live_agent.metadata.get("username"),
                    "command": live_agent.command,
                    "args": live_agent.args[:5],
                    "listening_ports": live_agent.metadata.get("listening_ports", []),
                    "match_reason": live_agent.metadata.get("match_reason", ""),
                },
            ))
            if verbose:
                logs.append(f"  [SHADOW] {live_agent.name} (PID {live_agent.metadata.get('pid')}) -- NOT in config!")

    # Check for configured servers that aren't running
    live_cmdlines = set()
    for la in live_agents:
        live_cmdlines.add(" ".join(la.args[:3]).lower())
        live_cmdlines.add(la.name.lower())

    for config_agent in config_agents:
        if config_agent.metadata.get("disabled"):
            continue

        is_running = (
            config_agent.name.lower() in live_cmdlines
            or any(
                config_agent.name.lower() in la.name.lower()
                or la.name.lower() in config_agent.name.lower()
                for la in live_agents
            )
        )

        if not is_running and config_agent.command:
            findings.append(Finding(
                agent_name=config_agent.name,
                severity=Severity.INFO,
                title=f"Configured server '{config_agent.name}' is NOT running",
                description=(
                    f"MCP server '{config_agent.name}' is configured in {config_agent.config_path} "
                    f"but no matching process was found. This may be normal (started on-demand by IDE) "
                    f"or could indicate a configuration issue."
                ),
                recommendation=(
                    "Verify this server starts correctly when invoked by your IDE or tool. "
                    "If this server is no longer needed, remove it from your configuration."
                ),
                config_path=config_agent.config_path,
                evidence={
                    "configured_command": config_agent.command,
                    "configured_args": config_agent.args[:5],
                },
            ))
            if verbose:
                logs.append(f"  [NOT RUNNING] {config_agent.name} (configured in {config_agent.config_path})")

    return findings, logs


def _analyze_live_agent_risks(agent: Agent) -> list[Finding]:
    """Analyze security risks specific to a live running process."""
    findings: list[Finding] = []

    # Check 1: Running as root/admin
    if agent.metadata.get("is_root"):
        findings.append(Finding(
            agent_name=agent.name,
            severity=Severity.CRITICAL,
            title=f"MCP server '{agent.name}' running as ROOT/admin",
            description=(
                f"MCP server '{agent.name}' (PID {agent.metadata.get('pid')}) is running as "
                f"user '{agent.metadata.get('username')}' with elevated privileges. "
                f"If this server is compromised or manipulated via prompt injection, "
                f"an attacker would gain root-level access to the system."
            ),
            recommendation=(
                "1. Never run MCP servers as root. "
                "2. Create a dedicated service user with minimal permissions. "
                "3. Use OS-level sandboxing (containers, seccomp, AppArmor)."
            ),
            evidence={
                "pid": agent.metadata.get("pid"),
                "username": agent.metadata.get("username"),
            },
        ))

    # Check 2: Listening on network ports (externally accessible)
    ports = agent.metadata.get("listening_ports", [])
    if ports:
        findings.append(Finding(
            agent_name=agent.name,
            severity=Severity.HIGH,
            title=f"MCP server '{agent.name}' listening on network port(s): {ports}",
            description=(
                f"MCP server '{agent.name}' (PID {agent.metadata.get('pid')}) is listening on "
                f"TCP port(s) {ports}. Network-accessible MCP servers can be reached by any "
                f"process or user on the network, expanding the attack surface significantly."
            ),
            recommendation=(
                "1. Bind to 127.0.0.1 (localhost) only if remote access is not needed. "
                "2. Add authentication (OAuth 2.0 or API keys). "
                "3. Use a reverse proxy with TLS and access controls. "
                "4. Consider using stdio transport instead."
            ),
            evidence={
                "pid": agent.metadata.get("pid"),
                "listening_ports": ports,
            },
        ))

    # Check 3: Sensitive environment variables accessible
    if agent.env_vars:
        findings.append(Finding(
            agent_name=agent.name,
            severity=Severity.MEDIUM,
            title=f"Running MCP server '{agent.name}' has access to sensitive env vars",
            description=(
                f"MCP server '{agent.name}' (PID {agent.metadata.get('pid')}) has "
                f"{len(agent.env_vars)} sensitive-looking environment variable(s) in its "
                f"process environment: {', '.join(agent.env_vars[:5])}. These can be "
                f"exfiltrated if the server is compromised via prompt injection."
            ),
            recommendation=(
                "1. Minimize secrets available to MCP server processes. "
                "2. Use short-lived credentials where possible. "
                "3. Consider a secrets manager with scoped access."
            ),
            evidence={
                "pid": agent.metadata.get("pid"),
                "sensitive_env_vars": agent.env_vars[:10],
                "total_env_count": agent.metadata.get("total_env_keys", 0),
            },
        ))

    # Check 4: No authentication on a live server
    if agent.auth_status == AuthStatus.NONE:
        severity = Severity.HIGH if ports else Severity.MEDIUM
        findings.append(Finding(
            agent_name=agent.name,
            severity=severity,
            title=f"Running MCP server '{agent.name}' has no authentication",
            description=(
                f"Live MCP server '{agent.name}' (PID {agent.metadata.get('pid')}) does not "
                f"appear to use any authentication mechanism. "
                f"{'It is also listening on the network, making it accessible to any client.' if ports else 'While using stdio transport, any local process can connect.'}"
            ),
            recommendation=(
                "Configure authentication for this MCP server. For HTTP/SSE servers, "
                "add OAuth 2.0 or API key auth. Review the server documentation for auth options."
            ),
            evidence={
                "pid": agent.metadata.get("pid"),
                "transport": agent.transport.value,
                "auth_status": agent.auth_status.value,
            },
        ))

    return findings


def scan(verbose: bool = False) -> tuple[list[Agent], list[Finding], list[str]]:
    """Run the live process scanner.

    Discovers running MCP server processes, cross-references with config,
    and analyzes security risks.

    Returns:
        Tuple of (discovered agents, security findings, log messages).
    """
    agents: list[Agent] = []
    findings: list[Finding] = []
    logs: list[str] = []

    # Step 1: Scan process table
    proc_infos, proc_logs = _scan_processes(verbose=verbose)
    logs.extend(proc_logs)

    # Step 2: Scan network listeners for additional MCP servers
    net_infos, net_logs = _find_mcp_network_listeners(verbose=verbose)
    logs.extend(net_logs)

    # Merge network-only discoveries (avoid duplicates by PID)
    seen_pids = {p["pid"] for p in proc_infos}
    for net_info in net_infos:
        if net_info["pid"] not in seen_pids:
            # Normalize network info to match process info format
            net_info.setdefault("is_root", False)
            net_info.setdefault("listening_ports", [net_info.get("listening_port")])
            net_info.setdefault("env_keys", [])
            net_info.setdefault("sensitive_env_keys", [])
            net_info.setdefault("parent_process", None)
            net_info.setdefault("create_time", None)
            proc_infos.append(net_info)
            seen_pids.add(net_info["pid"])

    # Step 3: Convert to Agent objects
    for proc_info in proc_infos:
        agent = _process_to_agent(proc_info)
        agents.append(agent)

        # Analyze individual agent risks
        agent_findings = _analyze_live_agent_risks(agent)
        findings.extend(agent_findings)

    # Step 4: Cross-reference with configured servers
    xref_findings, xref_logs = _cross_reference_with_config(agents, verbose=verbose)
    findings.extend(xref_findings)
    logs.extend(xref_logs)

    logs.append(
        f"\nLive process scan complete: {len(agents)} running MCP server(s) found, "
        f"{len(findings)} finding(s)"
    )

    return agents, findings, logs
