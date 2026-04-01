# Claude Desktop Setup

This guide walks you through setting up Eigent with Claude Desktop to protect MCP server access with cryptographic identity and permission enforcement.

## Overview

Claude Desktop connects to MCP servers via the `claude_desktop_config.json` file. Without Eigent, every MCP server runs with full permissions and no audit trail. With Eigent, each server is wrapped by the sidecar, which enforces scoped permissions and logs every tool call.

```mermaid
graph LR
    Claude[Claude Desktop] -->|MCP| Sidecar[Eigent Sidecar]
    Sidecar -->|verify| Registry[Eigent Registry]
    Sidecar -->|if allowed| Server[MCP Server]
    Sidecar -->|audit| Log[(Audit Log)]
```

## Prerequisites

- [x] Claude Desktop installed
- [x] Eigent CLI installed (`npm install -g @eigent/cli`)
- [x] Eigent Sidecar installed (`npm install -g @eigent/sidecar`)
- [x] Eigent Registry running (`cd eigent-registry && npm run dev`)

## Step 1: Initialize and Authenticate

```bash
eigent init
eigent login -e your-email@company.com
```

## Step 2: Issue Agent Tokens

Create a separate agent identity for each MCP server with appropriate scopes.

```bash
# Filesystem agent — read and write files
eigent issue fs-agent \
  --scope read_file,write_file,list_directory,search_files \
  --ttl 28800 \
  --max-depth 1

# Shell agent — execute commands (more restricted)
eigent issue shell-agent \
  --scope run_command \
  --ttl 3600 \
  --max-depth 0

# Database agent — read-only
eigent issue db-agent \
  --scope query,list_tables,describe_table \
  --ttl 3600 \
  --max-depth 0
```

!!! tip "Scope naming"
    The scope values must match the exact tool names exposed by the MCP server. Check the server's documentation or run it directly to see the available tools.

## Step 3: Configure Claude Desktop

Locate your Claude Desktop configuration file:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Replace your existing MCP server entries with sidecar-wrapped versions:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "eigent-sidecar",
      "args": [
        "--mode", "enforce",
        "--eigent-token-file", "~/.eigent/tokens/fs-agent.jwt",
        "--registry-url", "http://localhost:3456",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem",
        "/Users/you/projects"
      ]
    },
    "shell": {
      "command": "eigent-sidecar",
      "args": [
        "--mode", "enforce",
        "--eigent-token-file", "~/.eigent/tokens/shell-agent.jwt",
        "--registry-url", "http://localhost:3456",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-shell"
      ]
    },
    "postgres": {
      "command": "eigent-sidecar",
      "args": [
        "--mode", "enforce",
        "--eigent-token-file", "~/.eigent/tokens/db-agent.jwt",
        "--registry-url", "http://localhost:3456",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-postgres"
      ],
      "env": {
        "POSTGRES_CONNECTION_STRING": "postgresql://user:pass@localhost/mydb"
      }
    }
  }
}
```

## Step 4: Restart Claude Desktop

After saving the configuration, restart Claude Desktop. The sidecar will start automatically for each MCP server.

## Step 5: Verify It Works

Open Claude Desktop and try using the tools. Then check the audit trail:

```bash
eigent audit --limit 10
```

You should see entries like:

```
TIME                 AGENT       ACTION              TOOL           HUMAN
2026-03-31 15:00:01  fs-agent    tool_call_allowed   read_file      you@company.com
2026-03-31 15:00:05  fs-agent    tool_call_allowed   list_directory you@company.com
2026-03-31 15:00:12  shell-agent tool_call_allowed   run_command    you@company.com
```

If Claude tries to call a tool outside the agent's scope, it will be blocked:

```
2026-03-31 15:01:00  db-agent    tool_call_blocked   drop_table     you@company.com
```

## Monitor Mode First

If you want to evaluate Eigent before enforcing policies, start in monitor mode:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "eigent-sidecar",
      "args": [
        "--mode", "monitor",
        "--eigent-token-file", "~/.eigent/tokens/fs-agent.jwt",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"
      ]
    }
  }
}
```

In monitor mode, all calls are allowed through, but the audit trail records what would have been blocked. Review the log, adjust scopes, then switch to `enforce`.

## Token Renewal

Agent tokens expire (default: 1 hour). For long-running Claude Desktop sessions, issue tokens with a longer TTL:

```bash
# 8-hour token for a workday
eigent issue fs-agent --scope read_file,write_file --ttl 28800

# 24-hour token
eigent issue fs-agent --scope read_file,write_file --ttl 86400
```

!!! warning "Security tradeoff"
    Longer TTLs are more convenient but increase the window of exposure if a token is compromised. For sensitive environments, prefer shorter TTLs and re-issue as needed.

## Troubleshooting

### Claude shows MCP server error

Check that the sidecar binary is in your PATH:

```bash
which eigent-sidecar
```

Check the registry is running:

```bash
curl http://localhost:3456/api/health
```

### Tools appear but calls fail

The token's scope may not match the tool names. Check what tools the MCP server exposes and ensure they match:

```bash
eigent verify fs-agent read_file
eigent verify fs-agent list_directory
```

### No audit entries

Ensure the `--registry-url` in your config matches the running registry. The sidecar sends verification requests and the registry logs them.

### Environment variables not passed

Use the `env` section in the MCP server config to pass environment variables through the sidecar to the underlying server:

```json
{
  "command": "eigent-sidecar",
  "args": ["--mode", "enforce", "--", "npx", "server-postgres"],
  "env": {
    "DATABASE_URL": "postgresql://localhost/mydb"
  }
}
```
