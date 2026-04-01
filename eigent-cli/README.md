# @eigent/cli

The developer-facing CLI for managing agent identities, delegation, and trust.

## Installation

```bash
npm install -g @eigent/cli
```

## Quick Start

```bash
# Initialize Eigent in your project
eigent init

# Authenticate as a human operator
eigent login

# Issue an identity token for an agent
eigent issue code-reviewer --scope read_file,run_tests,write_file

# Delegate a subset of permissions to a child agent
eigent delegate code-reviewer test-runner --scope run_tests

# Verify what an agent can do
eigent verify test-runner run_tests   # ALLOWED
eigent verify test-runner delete_file # DENIED

# View the delegation chain
eigent chain test-runner
# Output:
#   alice@company.com (human)
#       └─ code-reviewer [read_file, run_tests, write_file] (depth 0)
#           └─ test-runner [run_tests] (depth 1) ← this agent

# Wrap an MCP server with the enforcing sidecar
eigent wrap --agent code-reviewer npx @modelcontextprotocol/server-filesystem /tmp

# Revoke an agent (cascades to all delegates)
eigent revoke code-reviewer

# Query the audit log
eigent audit --human alice@company.com
```

## Commands

| Command | Description |
|---------|-------------|
| `eigent init` | Initialize Eigent for a project |
| `eigent login` | Authenticate as a human operator |
| `eigent issue <name> --scope <tools>` | Issue an eigent token for an agent |
| `eigent delegate <parent> <child> --scope <tools>` | Delegate permissions to a child agent |
| `eigent revoke <name>` | Revoke an agent and cascade to delegates |
| `eigent list` | List all active agents |
| `eigent verify <name> <tool>` | Check if an agent can call a tool |
| `eigent chain <name>` | Show the delegation chain |
| `eigent wrap --agent <name> <command> [args]` | Wrap an MCP server with the sidecar |
| `eigent audit` | Query the audit log |
| `eigent status` | Show current Eigent status |
| `eigent logout` | Clear the current session |

## MCP Integration

Add Eigent to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "eigent",
      "args": ["wrap", "--agent", "code-reviewer", "npx", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

Every tool call through this MCP server will be verified against the agent's scope, with full audit logging and delegation chain tracking.
