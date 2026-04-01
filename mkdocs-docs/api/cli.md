# CLI Reference

The Eigent CLI (`eigent`) is the primary interface for managing agent identities. It handles authentication, token issuance, delegation, revocation, verification, and audit log queries.

**Installation:**

```bash
npm install -g @eigent/cli
```

---

## eigent init

Initialize Eigent for a project. Creates a `.eigent/` directory with configuration and key storage.

```bash
eigent init [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-r, --registry <url>` | `http://localhost:3456` | Registry URL |

**Example:**

```bash
eigent init
eigent init --registry https://eigent.company.com
```

**What it does:**

1. Creates `~/.eigent/` directory for keys and session data
2. Creates `.eigent/config.json` in the current project with the registry URL
3. Tests the connection to the registry

---

## eigent login

Authenticate as a human operator. Every agent identity must trace back to a human session.

```bash
eigent login [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-e, --email <email>` | (interactive prompt) | Email address |

**Examples:**

```bash
# Interactive
eigent login

# Non-interactive
eigent login -e alice@company.com
```

**What it does:**

1. Authenticates via OIDC (simulated in development)
2. Stores session in `~/.eigent/session.json`
3. The session includes `sub`, `email`, `iss`, and `token`

!!! info "Production OIDC"
    In production, `eigent login` redirects to your corporate identity provider (Okta, Auth0, Azure AD). The development mode simulates this flow.

---

## eigent issue

Issue a signed Eigent token for a new agent.

```bash
eigent issue <agent-name> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-s, --scope <tools>` | (required) | Comma-separated list of allowed tools |
| `-t, --ttl <seconds>` | `3600` | Token TTL in seconds |
| `-d, --max-depth <depth>` | `3` | Maximum delegation depth |
| `--can-delegate <tools>` | same as scope | Tools this agent can delegate |

**Examples:**

```bash
# Basic issuance
eigent issue code-agent --scope read_file,write_file,run_tests

# With delegation restrictions
eigent issue code-agent \
  --scope read_file,write_file,run_tests \
  --can-delegate run_tests \
  --ttl 7200 \
  --max-depth 2

# With wildcard scope
eigent issue admin-agent --scope "*" --max-depth 5
```

**Output:**

```
✔ Token issued.

  Agent        code-agent
  ID           019746a2-3f8b-7d4e-a1c5-9b3d2e7f0a1b
  Scope        read_file, write_file, run_tests
  Depth        0 / 3
  Expires      2026-03-31T15:00:00.000Z
  Token        ~/.eigent/tokens/code-agent.jwt
```

**Requires:** Active session (`eigent login`) and initialized project (`eigent init`).

---

## eigent delegate

Delegate a subset of permissions from a parent agent to a new child agent.

```bash
eigent delegate <parent-agent> <child-agent> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-s, --scope <tools>` | (required) | Comma-separated list of tools to delegate |
| `-t, --ttl <seconds>` | (auto) | Token TTL (capped by parent's remaining TTL) |
| `-d, --max-depth <depth>` | (inherited) | Maximum further delegation depth |

**Examples:**

```bash
# Delegate specific tools
eigent delegate code-agent test-runner --scope run_tests

# Delegate with TTL
eigent delegate code-agent test-runner --scope run_tests --ttl 1800

# Multiple scopes
eigent delegate orchestrator qa-agent --scope test,lint,coverage
```

**Output:**

```
✔ Delegation successful.

  Child Agent    test-runner
  Granted Scope  run_tests
  Depth          1
  Token          ~/.eigent/tokens/test-runner.jwt
```

!!! warning "Denied scopes"
    If the child requests scopes that the parent cannot delegate, those scopes are denied silently and the remaining scopes are granted. If no scopes can be granted, the delegation fails entirely.

---

## eigent verify

Check if an agent is authorized to call a specific tool.

```bash
eigent verify <agent-name> <tool-name>
```

**Examples:**

```bash
eigent verify code-agent read_file
eigent verify test-runner write_file
```

**Output (Allowed):**

```
  ALLOWED  code-agent → read_file
  Agent code-agent is authorized to call read_file
  Scope: read_file, write_file, run_tests
  Human: alice@company.com
  Chain: alice@company.com → code-agent
```

**Output (Denied):**

```
  DENIED  test-runner → write_file
  Agent test-runner is NOT authorized to call write_file
  Scope: run_tests
  Reason: Tool "write_file" is not in agent scope: [run_tests]
```

---

## eigent revoke

Revoke an agent and cascade to all its delegates.

```bash
eigent revoke <agent-name>
```

**Example:**

```bash
eigent revoke code-agent
```

**Output:**

```
✔ Agent revoked.

  Revoked        code-agent
  Cascade        test-runner, file-reader
  Total Revoked  3
```

This operation is immediate and irreversible. The local token files are also cleaned up.

---

## eigent list

List all agents registered with the current registry.

```bash
eigent list [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--all` | false | Include revoked agents |

**Example:**

```bash
eigent list
eigent list --all
```

**Output:**

```
  Agents (3)

  NAME           SCOPE                      DEPTH  STATUS   HUMAN
  code-agent     read_file, write_file, ... 0/3    active   alice@company.com
  test-runner    run_tests                  1/3    active   alice@company.com
  file-reader    read_file                  2/3    active   alice@company.com
```

---

## eigent chain

Show the full delegation chain for an agent.

```bash
eigent chain <agent-name>
```

**Example:**

```bash
eigent chain file-reader
```

**Output:**

```
  Delegation Chain

  alice@company.com (human)
    └── code-agent [read_file, write_file, run_tests] (depth 0)
          └── test-runner [run_tests] (depth 1)
                └── file-reader [read_file] (depth 2)
```

---

## eigent wrap

Wrap an MCP server with the Eigent enforcing sidecar. This launches the sidecar as a transparent proxy between the AI agent and the MCP server.

```bash
eigent wrap <command> [args...] [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-a, --agent <name>` | (required) | Agent name whose token to use |

**Examples:**

```bash
# Wrap filesystem server
eigent wrap npx -y @modelcontextprotocol/server-filesystem /tmp \
  --agent code-agent

# Wrap any MCP server
eigent wrap python my_mcp_server.py --agent db-agent
```

The sidecar inherits the current environment and adds `EIGENT_TOKEN` and `EIGENT_REGISTRY_URL` environment variables.

---

## eigent audit

Query the audit log from the registry.

```bash
eigent audit [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-a, --agent <name>` | — | Filter by agent name |
| `-u, --human <email>` | — | Filter by human email |
| `--action <type>` | — | Filter by action type |
| `-l, --limit <count>` | `25` | Maximum entries to return |

**Examples:**

```bash
# Recent events
eigent audit

# Blocked calls only
eigent audit --action tool_call_blocked

# Events for a specific agent
eigent audit --agent code-agent --limit 50

# Events by human
eigent audit --human alice@company.com
```

**Output:**

```
  Audit Log (42 total)

  TIME                 AGENT         ACTION              TOOL         HUMAN
  2026-03-31 14:00:01  code-agent    issued              —            alice@company.com
  2026-03-31 14:00:05  test-runner   delegated           —            alice@company.com
  2026-03-31 14:00:12  code-agent    tool_call_allowed   read_file    alice@company.com
  2026-03-31 14:00:15  test-runner   tool_call_blocked   write_file   alice@company.com
```

---

## eigent status

Show the current Eigent configuration and connection status.

```bash
eigent status
```

**Output:**

```
  ╔══════════════════════════════════════╗
  ║          E I G E N T                ║
  ╚══════════════════════════════════════╝

  Project     initialized
  Registry    http://localhost:3456
  Session     alice@company.com
  Tokens      code-agent, test-runner

  Registry: reachable
```

---

## eigent logout

Clear the current session.

```bash
eigent logout
```

**Output:**

```
  Logged out. Session cleared.
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (authentication, network, validation, etc.) |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `EIGENT_REGISTRY_URL` | Override the registry URL |
| `EIGENT_TOKEN` | Provide a token inline (for sidecar) |
| `EIGENT_HOME` | Override the Eigent home directory (default `~/.eigent`) |

---

## File Locations

| Path | Description |
|------|-------------|
| `~/.eigent/session.json` | Current human session |
| `~/.eigent/keys/` | Cryptographic key storage |
| `~/.eigent/tokens/<name>.jwt` | Saved agent tokens |
| `.eigent/config.json` | Project-level configuration |
