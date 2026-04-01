# CLI Reference

The Eigent CLI (`eigent`) provides 16 commands for complete agent lifecycle management -- from authentication and token issuance through delegation, enforcement, rotation, compliance reporting, and deprovisioning.

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

1. Authenticates via OIDC (Okta, Entra ID, or Google in production; simulated in development)
2. Stores session in `~/.eigent/session.json`
3. The session includes `sub`, `email`, `iss`, and `token`

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

# Multiple scopes
eigent delegate orchestrator qa-agent --scope test,lint,coverage
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
eigent verify code-agent read_file      # ALLOWED
eigent verify test-runner write_file    # DENIED
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

This operation is immediate and irreversible. All descendant agents in the delegation subtree are also revoked. Local token files are cleaned up.

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
    +-- code-agent [read_file, write_file, run_tests] (depth 0)
          +-- test-runner [run_tests] (depth 1)
                +-- file-reader [read_file] (depth 2)
```

---

## eigent wrap

Wrap an MCP server with the Eigent enforcing sidecar.

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

---

## eigent audit

Query the audit log from the registry.

```bash
eigent audit [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-a, --agent <name>` | -- | Filter by agent name |
| `-u, --human <email>` | -- | Filter by human email |
| `--action <type>` | -- | Filter by action type |
| `-l, --limit <count>` | `25` | Maximum entries to return |

**Examples:**

```bash
eigent audit
eigent audit --action tool_call_blocked
eigent audit --agent code-agent --limit 50
eigent audit --human alice@company.com
```

---

## eigent rotate

Rotate an agent's cryptographic keys. Issues a new token and invalidates the old one. Use this for scheduled key rotation or after a suspected compromise.

```bash
eigent rotate <agent-name>
```

**Example:**

```bash
eigent rotate code-agent
```

**Output:**

```
  Key rotated.

  Agent        code-agent
  New Token    ~/.eigent/tokens/code-agent.jwt
  Rotated At   2026-03-31T15:00:00.000Z
```

---

## eigent deprovision

Deprovision a user and revoke all agents they authorized. This integrates with SCIM lifecycle events from your IdP.

```bash
eigent deprovision <email>
```

**Example:**

```bash
eigent deprovision alice@company.com
```

**Output:**

```
  Deprovisioned alice@company.com

  Agents revoked:      5
  Cascade revoked:     12
  Total revoked:       17
```

---

## eigent stale

Find agents that have not sent a heartbeat within the configured threshold.

```bash
eigent stale [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--threshold <minutes>` | `60` | Minutes since last heartbeat |

**Example:**

```bash
eigent stale
eigent stale --threshold 30
```

**Output:**

```
  Stale Agents (3)

  NAME           LAST HEARTBEAT       HUMAN
  old-agent      2026-03-31 12:00     alice@company.com
  test-bot       2026-03-31 11:30     bob@company.com
  orphan-tool    never                carol@company.com
```

---

## eigent usage

Show usage statistics for agents -- tool call counts, delegation counts, and activity summaries.

```bash
eigent usage [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-a, --agent <name>` | -- | Filter by agent name |
| `--period <period>` | `7d` | Time period: `1d`, `7d`, `30d`, `90d` |

**Example:**

```bash
eigent usage
eigent usage --agent code-agent --period 30d
```

---

## eigent compliance-report

Generate a compliance report mapping agent activity to a regulatory framework.

```bash
eigent compliance-report [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--framework <name>` | `eu-ai-act` | Framework: `eu-ai-act`, `soc2`, `iso27001` |
| `--period <period>` | `30d` | Reporting period |
| `--format <format>` | `table` | Output format: `table`, `json`, `pdf` |

**Example:**

```bash
eigent compliance-report --framework eu-ai-act --period 30d
eigent compliance-report --framework soc2 --format json
```

**Output:**

```
  Compliance Report: EU AI Act (30 days)

  ARTICLE                         STATUS      EVIDENCE
  Art. 14 - Human Oversight       PASS        47 agents bound to humans
  Art. 15 - Accuracy              PASS        0 unauthorized delegations
  Art. 52 - Transparency          PASS        Full audit trail, 1,234 events
  Art. 9 - Risk Management        WARN        2 agents with broad scope

  Score: 91.7% (11/12 controls passing)
```

---

## eigent logout

Clear the current session.

```bash
eigent logout
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
