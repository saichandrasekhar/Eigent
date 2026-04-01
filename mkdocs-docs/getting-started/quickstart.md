# Quick Start

Get from zero to a fully secured AI agent in under 5 minutes. This guide walks you through the core Eigent workflow: authenticate as a human, issue an agent identity, delegate permissions, verify access, and wrap an MCP server with the enforcing sidecar.

## Prerequisites

- **Node.js 18+** (for the CLI, registry, and sidecar)
- **npm** or **pnpm**
- A terminal

!!! tip "No cloud account required"
    Eigent runs entirely locally during development. The registry uses an embedded SQLite database. No sign-ups, no API keys, no external dependencies.

## Step 1: Install and Initialize

```bash
# Install the CLI globally
npm install -g @eigent/cli

# Initialize Eigent in your project
eigent init
```

??? example "Expected output"
    ```
    ✔ Connected to registry.

      Eigent initialized. Registry at http://localhost:3456
      Config: .eigent/config.json
      Keys:   ~/.eigent/keys/
    ```

!!! note "Start the registry first"
    If `eigent init` warns that the registry is not reachable, start it in a separate terminal:
    ```bash
    cd eigent-registry && npm install && npm run dev
    ```

## Step 2: Authenticate as a Human

Every agent identity must trace back to a human. This step binds your human identity to the Eigent session.

```bash
eigent login -e alice@company.com
```

??? example "Expected output"
    ```
      ╔══════════════════════════════════════╗
      ║          E I G E N T                ║
      ╚══════════════════════════════════════╝

    ✔ Authenticated.

      Logged in as alice@company.com
      Session stored in ~/.eigent/session.json
    ```

!!! info "Simulated OIDC"
    In development mode, Eigent simulates an OIDC authentication flow. In production, this integrates with your existing identity provider (Okta, Auth0, Azure AD, Google Workspace).

## Step 3: Issue an Agent Identity

Create a cryptographic identity for your AI agent with specific tool permissions:

```bash
eigent issue code-agent \
  --scope read_file,write_file,run_tests \
  --ttl 3600 \
  --max-depth 3
```

This issues a signed JWS token that:

- Identifies the agent as `code-agent`
- Grants access to `read_file`, `write_file`, and `run_tests`
- Expires in 1 hour
- Allows up to 3 levels of sub-delegation

??? example "Expected output"
    ```
    ✔ Token issued.

      Agent        code-agent
      ID           019746a2-3f8b-7d4e-a1c5-9b3d2e7f0a1b
      Scope        read_file, write_file, run_tests
      Depth        0 / 3
      Expires      2026-03-31T15:00:00.000Z
      Token        ~/.eigent/tokens/code-agent.jwt
    ```

## Step 4: Delegate to a Sub-Agent

Agent `code-agent` can delegate a subset of its permissions to a child agent:

```bash
eigent delegate code-agent test-runner \
  --scope run_tests
```

??? example "Expected output"
    ```
    ✔ Delegation successful.

      Child Agent    test-runner
      Granted Scope  run_tests
      Depth          1
      Token          ~/.eigent/tokens/test-runner.jwt
    ```

!!! warning "Permissions can only narrow"
    The child agent `test-runner` receives only `run_tests`. It cannot access `read_file` or `write_file` even if it requests them. Permissions flow downhill, never uphill.

## Step 5: Verify Permissions

Check whether an agent is authorized for a specific tool:

```bash
# This should succeed
eigent verify code-agent read_file

# This should fail — test-runner only has run_tests
eigent verify test-runner read_file
```

??? example "Expected output"
    ```
      ALLOWED  code-agent → read_file
      Agent code-agent is authorized to call read_file
      Scope: read_file, write_file, run_tests
      Human: alice@company.com
      Chain: alice@company.com → code-agent

      DENIED  test-runner → read_file
      Agent test-runner is NOT authorized to call read_file
      Scope: run_tests
      Reason: Tool "read_file" is not in agent scope
    ```

## Step 6: Wrap an MCP Server

The sidecar intercepts all MCP traffic and enforces permissions in real time:

```bash
eigent wrap npx -y @modelcontextprotocol/server-filesystem /tmp \
  --agent code-agent
```

This launches the filesystem MCP server behind the Eigent sidecar. Every tool call is verified against the agent's token before being forwarded to the server.

!!! danger "Without Eigent"
    The filesystem MCP server has unrestricted read/write access. Any connected AI agent can read `/etc/passwd`, overwrite config files, or exfiltrate data.

!!! success "With Eigent"
    The sidecar checks every `read_file` and `write_file` call against the agent's scoped permissions. Unauthorized calls are blocked and logged.

## Step 7: View the Audit Trail

Every action is logged with full delegation chain context:

```bash
eigent audit --limit 10
```

??? example "Expected output"
    ```
      Audit Log (10 total)

      TIME                 AGENT         ACTION              TOOL         HUMAN
      2026-03-31 14:00:01  code-agent    issued              —            alice@company.com
      2026-03-31 14:00:05  test-runner   delegated           —            alice@company.com
      2026-03-31 14:00:12  code-agent    tool_call_allowed   read_file    alice@company.com
      2026-03-31 14:00:15  test-runner   tool_call_blocked   read_file    alice@company.com
    ```

## Next Steps

- [Installation](installation.md) for detailed install instructions across all components
- [Your First Eigent](first-eigent.md) for a deeper tutorial
- [Concepts Overview](../concepts/overview.md) to understand the architecture
- [MCP Server Integration](../guides/mcp-integration.md) for production sidecar setup
- [CI/CD Pipeline](../guides/cicd.md) to add agent scanning to your build
