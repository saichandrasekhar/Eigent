"""MCP Server Scanner — discovers and analyzes MCP server configurations.

Scans local IDE and tool configurations for MCP (Model Context Protocol) servers,
analyzes their transport types, authentication status, and tool permissions.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from agentvault_scan.models import (
    Agent,
    AgentSource,
    AuthStatus,
    Finding,
    Severity,
    TransportType,
)

# Well-known MCP servers and their expected security posture
KNOWN_SENSITIVE_TOOLS = {
    "filesystem": ["read_file", "write_file", "edit_file", "list_directory", "move_file"],
    "shell": ["execute", "run_command", "bash", "exec"],
    "database": ["query", "execute_sql", "run_query"],
    "git": ["commit", "push", "clone"],
    "browser": ["navigate", "click", "screenshot", "evaluate"],
    "secrets": ["get_secret", "list_secrets", "set_secret"],
}

# Servers known to have broad system access
HIGH_RISK_SERVER_PATTERNS = [
    "filesystem",
    "shell",
    "terminal",
    "exec",
    "bash",
    "computer-use",
    "browser",
    "puppeteer",
    "playwright",
    "desktop",
]


def _get_scan_locations() -> list[dict[str, Any]]:
    """Return all known MCP config file locations with their source labels."""
    home = Path.home()
    cwd = Path.cwd()

    locations = [
        # Claude Code plugins (installed MCP servers)
        {
            "path": home / ".claude" / "plugins" / "installed_plugins.json",
            "source": AgentSource.MCP_CLAUDE,
            "label": "Claude Code (installed plugins)",
        },
        # Claude Desktop / Claude CLI
        {
            "path": home / ".claude" / "settings.json",
            "source": AgentSource.MCP_CLAUDE,
            "label": "Claude (global settings)",
        },
        {
            "path": home / ".claude.json",
            "source": AgentSource.MCP_CLAUDE,
            "label": "Claude (legacy config)",
        },
        {
            "path": home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json",
            "source": AgentSource.MCP_CLAUDE,
            "label": "Claude Desktop (macOS)",
        },
        {
            "path": home / ".config" / "Claude" / "claude_desktop_config.json",
            "source": AgentSource.MCP_CLAUDE,
            "label": "Claude Desktop (Linux)",
        },
        {
            "path": home / "AppData" / "Roaming" / "Claude" / "claude_desktop_config.json",
            "source": AgentSource.MCP_CLAUDE,
            "label": "Claude Desktop (Windows)",
        },
        # Cursor
        {
            "path": home / ".cursor" / "mcp.json",
            "source": AgentSource.MCP_CURSOR,
            "label": "Cursor (global)",
        },
        {
            "path": cwd / ".cursor" / "mcp.json",
            "source": AgentSource.MCP_CURSOR,
            "label": "Cursor (project)",
        },
        # VS Code
        {
            "path": home / ".vscode" / "settings.json",
            "source": AgentSource.MCP_VSCODE,
            "label": "VS Code (global settings)",
        },
        {
            "path": cwd / ".vscode" / "settings.json",
            "source": AgentSource.MCP_VSCODE,
            "label": "VS Code (workspace settings)",
        },
        {
            "path": cwd / ".vscode" / "mcp.json",
            "source": AgentSource.MCP_VSCODE,
            "label": "VS Code (MCP config)",
        },
        # Windsurf
        {
            "path": home / ".codeium" / "windsurf" / "mcp_config.json",
            "source": AgentSource.MCP_WINDSURF,
            "label": "Windsurf",
        },
        # Project-level configs
        {
            "path": cwd / ".mcp.json",
            "source": AgentSource.MCP_PROJECT,
            "label": "Project MCP config",
        },
        {
            "path": cwd / "mcp.json",
            "source": AgentSource.MCP_PROJECT,
            "label": "Project MCP config (root)",
        },
    ]

    return locations


def _parse_plugin_manifest(data: dict[str, Any], source: AgentSource, config_path: str) -> list[Agent]:
    """Extract installed plugins from Claude Code's installed_plugins.json.

    Each plugin is treated as a discovered agent/integration point since
    plugins can include MCP servers, agents, hooks, and skills.
    """
    agents = []
    plugins = data.get("plugins", {})
    if not isinstance(plugins, dict):
        return agents

    for plugin_id, installs in plugins.items():
        if not isinstance(installs, list) or not installs:
            continue

        install = installs[0]  # Take the first (active) installation
        install_path = install.get("installPath", "")
        version = install.get("version", "unknown")

        # Check if plugin directory contains MCP server configs
        plugin_dir = Path(install_path) if install_path else None
        has_mcp = False
        if plugin_dir and plugin_dir.exists():
            # Look for MCP server definitions in plugin
            for pattern in ["mcp-servers", "mcp_servers", "servers"]:
                if (plugin_dir / pattern).is_dir():
                    has_mcp = True
                    break
            # Check plugin.json or manifest for MCP declarations
            for manifest in ["plugin.json", "manifest.json", "package.json"]:
                manifest_path = plugin_dir / manifest
                if manifest_path.exists():
                    try:
                        manifest_data = json.loads(manifest_path.read_text())
                        if "mcpServers" in manifest_data or "mcp" in manifest_data:
                            has_mcp = True
                    except (json.JSONDecodeError, PermissionError):
                        pass

        agents.append(Agent(
            name=f"plugin:{plugin_id}",
            source=source,
            transport=TransportType.UNKNOWN,
            auth_status=AuthStatus.UNKNOWN,
            config_path=config_path,
            metadata={
                "plugin_id": plugin_id,
                "version": version,
                "install_path": install_path,
                "has_mcp_servers": has_mcp,
                "installed_at": install.get("installedAt", ""),
                "disabled": False,
            },
        ))

    return agents


def _parse_mcp_servers(data: dict[str, Any], source: AgentSource, config_path: str) -> list[Agent]:
    """Extract MCP server definitions from a config dict.

    Handles multiple config formats:
    - Claude Desktop: {"mcpServers": {"name": {...}}}
    - Cursor/VS Code: {"mcpServers": {"name": {...}}} or {"mcp.servers": {"name": {...}}}
    - Direct: {"servers": {"name": {...}}}
    """
    agents = []
    servers: dict[str, Any] = {}

    # Try all known key patterns
    if "mcpServers" in data:
        servers = data["mcpServers"]
    elif "mcp.servers" in data:
        servers = data["mcp.servers"]
    elif "servers" in data:
        servers = data["servers"]
    elif "mcp" in data and isinstance(data["mcp"], dict):
        if "servers" in data["mcp"]:
            servers = data["mcp"]["servers"]
        elif "mcpServers" in data["mcp"]:
            servers = data["mcp"]["mcpServers"]

    if not isinstance(servers, dict):
        return agents

    for name, config in servers.items():
        if not isinstance(config, dict):
            continue

        agent = _parse_single_server(name, config, source, config_path)
        agents.append(agent)

    return agents


def _parse_single_server(
    name: str, config: dict[str, Any], source: AgentSource, config_path: str
) -> Agent:
    """Parse a single MCP server config entry into an Agent."""
    # Determine transport type
    transport = TransportType.UNKNOWN
    command = config.get("command")
    url = config.get("url")

    if command:
        transport = TransportType.STDIO
    elif url:
        if "sse" in url.lower() or config.get("transport") == "sse":
            transport = TransportType.SSE
        else:
            transport = TransportType.HTTP

    if config.get("transport") == "stdio":
        transport = TransportType.STDIO
    elif config.get("transport") == "sse":
        transport = TransportType.SSE
    elif config.get("transport") == "http":
        transport = TransportType.HTTP

    # Determine auth status
    auth_status = _detect_auth(config, transport)

    # Extract args
    args = config.get("args", [])
    if not isinstance(args, list):
        args = [str(args)]

    # Extract environment variables (names only, not values)
    env_vars = []
    env_config = config.get("env", {})
    if isinstance(env_config, dict):
        env_vars = list(env_config.keys())

    # Try to identify exposed tools from config
    tools = config.get("tools", [])
    if isinstance(tools, dict):
        tools = list(tools.keys())
    elif not isinstance(tools, list):
        tools = []

    return Agent(
        name=name,
        source=source,
        transport=transport,
        auth_status=auth_status,
        command=command,
        args=[str(a) for a in args],
        env_vars=env_vars,
        url=url,
        tools_exposed=tools,
        config_path=config_path,
        metadata={
            "raw_config_keys": list(config.keys()),
            "disabled": config.get("disabled", False),
        },
    )


def _detect_auth(config: dict[str, Any], transport: TransportType) -> AuthStatus:
    """Detect authentication configuration for an MCP server."""
    # Check for explicit auth config
    if "auth" in config:
        auth = config["auth"]
        if isinstance(auth, dict):
            if "oauth" in auth or "oidc" in auth:
                return AuthStatus.OAUTH
            if "apiKey" in auth or "api_key" in auth or "token" in auth:
                return AuthStatus.API_KEY

    # Check env vars for auth-related keys
    env = config.get("env", {})
    if isinstance(env, dict):
        auth_env_patterns = ["KEY", "TOKEN", "SECRET", "AUTH", "PASSWORD", "CREDENTIAL"]
        for key in env:
            if any(pattern in key.upper() for pattern in auth_env_patterns):
                return AuthStatus.API_KEY

    # Check headers for auth
    headers = config.get("headers", {})
    if isinstance(headers, dict):
        if "Authorization" in headers or "authorization" in headers:
            return AuthStatus.API_KEY
        if "x-api-key" in headers or "X-API-Key" in headers:
            return AuthStatus.API_KEY

    # stdio transport with no auth indicators
    if transport == TransportType.STDIO:
        return AuthStatus.NONE

    # HTTP/SSE with no auth detected
    if transport in (TransportType.HTTP, TransportType.SSE):
        return AuthStatus.NONE

    return AuthStatus.UNKNOWN


def _analyze_agent_risks(agent: Agent) -> list[Finding]:
    """Analyze a discovered MCP server for security risks."""
    findings: list[Finding] = []

    # Check 1: No authentication on any transport
    if agent.auth_status == AuthStatus.NONE:
        severity = Severity.HIGH if agent.transport in (TransportType.HTTP, TransportType.SSE) else Severity.MEDIUM

        findings.append(Finding(
            agent_name=agent.name,
            severity=severity,
            title=f"No authentication configured for '{agent.name}'",
            description=(
                f"MCP server '{agent.name}' is configured with {agent.transport.value} transport "
                f"and no authentication mechanism detected. "
                f"{'Network-accessible servers without auth allow any client to invoke tools.' if agent.transport != TransportType.STDIO else 'While stdio is local-only, any process running as the current user can interact with this server.'}"
            ),
            recommendation=(
                "Add authentication to this MCP server. For HTTP/SSE transports, configure "
                "OAuth 2.0 or API key authentication. For stdio servers, consider restricting "
                "which tools are exposed and use allowlists."
            ),
            config_path=agent.config_path,
            evidence={"transport": agent.transport.value, "auth_status": agent.auth_status.value},
        ))

    # Check 2: High-risk server patterns (filesystem, shell, etc.)
    name_lower = agent.name.lower()
    command_str = (agent.command or "").lower()
    args_str = " ".join(agent.args).lower()
    combined = f"{name_lower} {command_str} {args_str}"

    matched_patterns = [p for p in HIGH_RISK_SERVER_PATTERNS if p in combined]
    if matched_patterns:
        findings.append(Finding(
            agent_name=agent.name,
            severity=Severity.CRITICAL if agent.auth_status == AuthStatus.NONE else Severity.HIGH,
            title=f"High-risk server '{agent.name}' grants broad system access",
            description=(
                f"MCP server '{agent.name}' matches high-risk patterns: {', '.join(matched_patterns)}. "
                f"These servers typically grant direct access to the filesystem, shell commands, "
                f"or browser automation. Combined with {agent.auth_status.value} authentication, "
                f"this represents a significant attack surface."
            ),
            recommendation=(
                "1. Restrict tool permissions to only what is needed. "
                "2. Use allowlists for file paths and commands. "
                "3. Add authentication if not present. "
                "4. Consider running in a sandboxed environment."
            ),
            config_path=agent.config_path,
            evidence={"matched_patterns": matched_patterns, "command": agent.command},
        ))

    # Check 3: Secrets potentially exposed in env vars
    sensitive_env_patterns = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
    exposed_secrets = [
        v for v in agent.env_vars
        if any(p in v.upper() for p in sensitive_env_patterns)
    ]
    if exposed_secrets:
        findings.append(Finding(
            agent_name=agent.name,
            severity=Severity.MEDIUM,
            title=f"Secrets passed via environment to '{agent.name}'",
            description=(
                f"MCP server '{agent.name}' receives sensitive-looking environment variables: "
                f"{', '.join(exposed_secrets)}. While env vars are a common way to pass secrets, "
                f"they can be leaked through process listings, crash dumps, or child processes."
            ),
            recommendation=(
                "Consider using a secrets manager or encrypted config file instead of "
                "plain environment variables. Ensure the config file has restricted permissions."
            ),
            config_path=agent.config_path,
            evidence={"sensitive_env_vars": exposed_secrets},
        ))

    # Check 4: Server using npx/uvx (remote code execution)
    if agent.command in ("npx", "uvx", "bunx", "pnpx"):
        pkg_name = agent.args[0] if agent.args else "unknown"
        findings.append(Finding(
            agent_name=agent.name,
            severity=Severity.MEDIUM,
            title=f"Server '{agent.name}' uses package runner ({agent.command})",
            description=(
                f"MCP server '{agent.name}' is launched via '{agent.command}', which downloads "
                f"and executes package '{pkg_name}' at runtime. This introduces supply chain risk -- "
                f"a compromised package could execute arbitrary code with your user permissions."
            ),
            recommendation=(
                "Pin the package to a specific version. Consider installing the package "
                "locally instead of using npx/uvx. Verify the package integrity and publisher."
            ),
            config_path=agent.config_path,
            evidence={"runner": agent.command, "package": pkg_name},
        ))

    # Check 5: Disabled servers still configured
    if agent.metadata.get("disabled"):
        findings.append(Finding(
            agent_name=agent.name,
            severity=Severity.LOW,
            title=f"Disabled server '{agent.name}' still in configuration",
            description=(
                f"MCP server '{agent.name}' is marked as disabled but still present in the "
                f"configuration file. Disabled servers can be accidentally re-enabled and "
                f"still represent configuration drift."
            ),
            recommendation=(
                "Remove unused MCP server configurations entirely. Keep an inventory of "
                "approved servers and clean up stale entries."
            ),
            config_path=agent.config_path,
        ))

    # Check 6: No tool restrictions (empty tools list means all tools exposed)
    if not agent.tools_exposed and not agent.metadata.get("disabled"):
        findings.append(Finding(
            agent_name=agent.name,
            severity=Severity.LOW,
            title=f"No tool restrictions on '{agent.name}'",
            description=(
                f"MCP server '{agent.name}' has no explicit tool allowlist configured. "
                f"This means all tools provided by the server are available to the AI model. "
                f"Broad tool access increases the blast radius if the model is manipulated."
            ),
            recommendation=(
                "Define an explicit allowlist of tools that the AI model can access. "
                "Only expose the minimum set of tools required for your workflow."
            ),
            config_path=agent.config_path,
        ))

    return findings


def scan(verbose: bool = False) -> tuple[list[Agent], list[Finding], list[str]]:
    """Run the MCP scanner.

    Returns:
        Tuple of (discovered agents, security findings, log messages).
    """
    agents: list[Agent] = []
    findings: list[Finding] = []
    logs: list[str] = []

    locations = _get_scan_locations()
    logs.append(f"Scanning {len(locations)} known MCP config locations...")

    for loc in locations:
        config_path: Path = loc["path"]
        source: AgentSource = loc["source"]
        label: str = loc["label"]

        if not config_path.exists():
            if verbose:
                logs.append(f"  [skip] {label}: {config_path} (not found)")
            continue

        if not config_path.is_file():
            if verbose:
                logs.append(f"  [skip] {label}: {config_path} (not a file)")
            continue

        logs.append(f"  [found] {label}: {config_path}")

        try:
            raw = config_path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            logs.append(f"  [error] Failed to parse {config_path}: {e}")
            continue
        except PermissionError:
            logs.append(f"  [error] Permission denied reading {config_path}")
            continue
        except Exception as e:
            logs.append(f"  [error] Unexpected error reading {config_path}: {e}")
            continue

        # Check file permissions (non-Windows)
        if os.name != "nt":
            try:
                stat = config_path.stat()
                mode = oct(stat.st_mode)[-3:]
                if mode[-1] != "0":  # world-readable
                    findings.append(Finding(
                        agent_name="(config file)",
                        severity=Severity.MEDIUM,
                        title=f"MCP config file is world-readable",
                        description=(
                            f"Config file {config_path} has permissions {mode}, making it "
                            f"readable by all users on the system. This file may contain "
                            f"API keys or other secrets in environment variable definitions."
                        ),
                        recommendation=f"Run: chmod 600 {config_path}",
                        config_path=str(config_path),
                        evidence={"permissions": mode},
                    ))
            except OSError:
                pass

        # Handle plugin manifest specially
        if config_path.name == "installed_plugins.json":
            discovered = _parse_plugin_manifest(data, source, str(config_path))
        else:
            discovered = _parse_mcp_servers(data, source, str(config_path))
        logs.append(f"    -> Discovered {len(discovered)} MCP server(s)")

        for agent in discovered:
            if verbose:
                status = "disabled" if agent.metadata.get("disabled") else "active"
                logs.append(
                    f"    [{status}] {agent.name} "
                    f"(transport={agent.transport.value}, auth={agent.auth_status.value})"
                )

            agents.append(agent)
            agent_findings = _analyze_agent_risks(agent)
            findings.extend(agent_findings)

    logs.append(f"\nMCP scan complete: {len(agents)} server(s) found, {len(findings)} finding(s)")
    return agents, findings, logs
