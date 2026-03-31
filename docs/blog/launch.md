# I scanned my machine for AI agents. Here's what I found.

I ran a single command on my MacBook last Tuesday. Thirty seconds later, I was staring at the output wondering how I'd been this careless.

```
$ eigent-scan scan --verbose

  +------------------------------------------+
  |                                          |
  |  Eigent Scan  v0.1.0                     |
  |  Discover AI agents. Expose security     |
  |  gaps.                                   |
  |                                          |
  +------------------------------------------+

  Scanning: Claude Desktop, Cursor, VS Code, Windsurf, project configs...

  +--- Scan Summary ----------------------------+
  |                                             |
  |  Targets scanned:    mcp                    |
  |  Agents discovered:  11                     |
  |  Agents with no auth: 8                     |
  |  Security findings:  17                     |
  |    Critical:         4                      |
  |    High:             6                      |
  |  Overall risk:       CRITICAL               |
  |  Scan duration:      0.12s                  |
  |                                             |
  +---------------------------------------------+
```

Eleven MCP servers. Eight with zero authentication. Four critical findings. On a machine I thought was locked down.

Here's the thing: I'm a security-aware developer. I use 2FA everywhere. I rotate credentials. I review IAM policies. But I'd never once audited the AI agents running on my own laptop.

I bet you haven't either.

---

## The shadow agent problem

We're in the middle of the fastest technology adoption in enterprise history. Every developer I know has Claude Desktop or Cursor installed. Most have both. Many have additional MCP servers they installed six months ago and forgot about.

The numbers back this up:

- **95%** of enterprises run AI agents autonomously
- **88%** had a confirmed agent security incident in the past year
- **82%** of executives think they're protected, but only **21%** of security teams have actual visibility into what's running
- Shadow AI breaches cost **$670K more** than standard incidents

The gap between "we have AI governance" and "we know what agents are actually running" is enormous. It's the same gap that existed with shadow IT a decade ago, except this time the shadow services can read your filesystem, execute shell commands, query your databases, and call external APIs.

And nobody is tracking what they do.

## What I actually found on my machine

Let me walk through the specific findings eigent-scan flagged. These are all real patterns I've seen across developer machines.

### Finding 1: Filesystem server with no auth, no path restrictions

```
[!] CRITICAL  High-risk server 'filesystem' grants broad system access
    MCP server 'filesystem' matches high-risk patterns: filesystem.
    Combined with none authentication, this represents a significant
    attack surface.
```

My Claude Desktop config had a filesystem MCP server pointed at `/`. Not `/tmp`. Not `~/projects`. The root of my entire filesystem. Any prompt injection in any document I opened could read `/etc/passwd`, `~/.ssh/id_rsa`, `~/.aws/credentials`, or anything else on disk.

The config that caused it:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/"]
    }
  }
}
```

### Finding 2: npx supply chain risk

```
[~] MEDIUM  Supply chain risk: server 'filesystem' launched via npx
    Server uses npx to download and execute '@modelcontextprotocol/server-filesystem'.
    This package is fetched from npm on each invocation without version pinning.
```

Six of my eleven MCP servers were launched via `npx -y`. Every single time I opened Claude Desktop, it was downloading and executing packages from npm without pinning a version. If any of those packages were compromised -- or if a typosquat package was registered -- it would execute arbitrary code with my user permissions.

This isn't theoretical. npm supply chain attacks happen constantly.

### Finding 3: Secrets in environment variables

```
[~] MEDIUM  Secrets passed via environment to 'postgres'
    MCP server 'postgres' receives sensitive-looking environment
    variables: POSTGRES_PASSWORD.
```

My database MCP server had credentials passed as plain environment variables in the config file. That config file was readable by any process on my machine. Any local malware, any compromised npm package running in a postinstall script, could read it.

### Finding 4: Shadow agents in Cursor I forgot about

```
[!] HIGH  No authentication configured for 'my-api'
    MCP server 'my-api' is configured with sse transport and no
    authentication mechanism detected. Network-accessible MCP servers
    without authentication can be accessed by any process on the network.
```

I had an SSE-based MCP server configured in Cursor from a hackathon three months ago. It was still in my config. It was network-accessible. It had no authentication. I had completely forgotten it existed.

This is the "shadow agent" problem in miniature. Multiply it across every developer in your org.

---

## What we built

**eigent-scan** is an open-source CLI tool that discovers every AI agent and MCP server in your environment, analyzes their security posture, and tells you exactly what to fix.

It's read-only and offline. It doesn't execute any MCP servers, make network requests, or modify any files. It reads configuration files from well-known locations and applies security heuristics.

### What it scans

| Tool | Config Locations |
|------|-----------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude CLI | `~/.claude/settings.json`, `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json`, `.cursor/mcp.json` |
| VS Code | `~/.vscode/settings.json`, `.vscode/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Project configs | `.mcp.json`, `mcp.json` |

### What it checks

- **No authentication** -- MCP servers running without any auth mechanism
- **Overpermissions** -- Agents with filesystem, shell, or database access they don't need
- **Supply chain risk** -- Servers launched via `npx`/`uvx` downloading unverified packages at runtime
- **Secret exposure** -- API keys and tokens passed as environment variables in config files
- **Config drift** -- Disabled servers still in configs, stale entries from months ago
- **File permissions** -- Config files readable by other users on the system

### Install and run it right now

```bash
pip install eigent-scan
eigent-scan scan --verbose
```

That's it. Takes about 30 seconds including install. No account, no API key, no configuration. It runs locally and prints results to your terminal.

Want JSON output to pipe somewhere?

```bash
eigent-scan scan --output json > results.json
```

Want SARIF for your GitHub Security tab?

```bash
eigent-scan scan --output sarif > results.sarif
```

---

## Architecture: the bigger picture

eigent-scan is the discovery layer. But discovery is only step one. You also need to know what your agents are *doing* at runtime. That's where the rest of the Eigent stack comes in.

```
                         Eigent Architecture

  +-----------+     +-----------+     +------------------+
  | AI Agent  | --> | MCP Client| --> | Eigent Sidecar   | --> MCP Server
  | (Claude,  |     | (IDE,     |     | (stdio proxy)    |
  |  GPT,     |     |  CLI)     |     |                  |
  |  custom)  |     |           |     | Intercepts every |
  +-----------+     +-----------+     | JSON-RPC message |
                                      +--------+---------+
                                               |
                                      OTel spans (OTLP/HTTP)
                                               |
                                               v
                                      +------------------+
                                      | OTel Collector   |
                                      | (Jaeger, Grafana,|
                                      |  Datadog, etc.)  |
                                      +------------------+
```

### The sidecar

The **eigent-sidecar** is a transparent stdio proxy. You put it in front of any MCP server command, and it intercepts every JSON-RPC message flowing between the MCP client and server. It creates OpenTelemetry spans for each operation:

```bash
# Before (no visibility):
npx @modelcontextprotocol/server-filesystem /tmp

# After (full telemetry):
eigent-sidecar wrap -- npx @modelcontextprotocol/server-filesystem /tmp
```

The MCP client and server see no difference. The sidecar is fully transparent. But now every `tools/call`, `tools/list`, `resources/read`, and `initialize` message gets an OTel span with attributes like:

```
rpc.system          = "mcp"
rpc.method          = "tools/call"
mcp.tool.name       = "read_file"
mcp.server.name     = "filesystem"
mcp.session.id      = "abc-123"
eigent.agent.id     = "claude-desktop"
```

Drop it into your Claude Desktop config in 60 seconds:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "eigent-sidecar",
      "args": [
        "wrap",
        "--otel-endpoint", "http://localhost:4318",
        "--agent-id", "claude-desktop",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"
      ]
    }
  }
}
```

Point it at any OTel collector -- Jaeger, Grafana Tempo, Datadog, Honeycomb, whatever you already use. No new vendor, no new dashboard to learn.

### OTel semantic conventions for MCP

We're also publishing an open [semantic convention for MCP operations](https://github.com/saichandrasekhar/Eigent/tree/main/otel-mcp-convention). We think this should be a standard that the whole ecosystem adopts, not something proprietary. The convention defines:

- Span names and attributes for every MCP method
- Status mapping from JSON-RPC error codes to OTel span status
- Metric conventions for tool call rates, durations, and error rates
- Resource attributes for MCP server identity

If you're building MCP tooling, we'd love your input on the spec.

---

## CI/CD integration

You can gate your builds on agent security findings. Add it to any CI pipeline:

```bash
# Fail the build if any high or critical findings exist
eigent-scan scan --output sarif --fail-on high > results.sarif
```

Or use the GitHub Action for automatic SARIF upload to your Security tab:

```yaml
name: MCP Security Scan
on: [push, pull_request]

permissions:
  security-events: write
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Scan for AI agents
        uses: saichandrasekhar/Eigent/eigent-scan@main
        with:
          target: mcp
          fail-on: high
          upload-sarif: true
```

Every PR that introduces an MCP config gets scanned automatically. Findings show up in the GitHub Security tab alongside your existing code scanning alerts.

---

## What's next

This is v0.1. Here's what we're building:

- **Cloud scanners** -- AWS Bedrock agents, Lambda functions calling LLMs, SageMaker endpoints, Azure OpenAI, GCP Vertex AI. Same scan, across your entire cloud.
- **Continuous monitoring** -- Watch mode that detects config changes in real-time and alerts on drift.
- **Policy-as-code** -- Define what agents are allowed in your environment. Enforce it in CI and at runtime.
- **Compliance reports** -- EU AI Act, SOC 2, ISO 27001. Export audit-ready documentation.
- **SBOM for AI agents** -- A software bill of materials, but for the AI agents in your stack.
- **Dashboard** -- Centralized view across your entire organization. How many agents, what permissions, what changed since last week.

The market for this is real. Non-human identity management is projected to be a **$38.8B market by 2036**. EU AI Act enforcement begins in August 2027. Every enterprise will need this.

---

## Try it

```bash
pip install eigent-scan && eigent-scan scan --verbose
```

Look at what it finds. I promise you'll be surprised.

Then:

1. Star the repo: [github.com/saichandrasekhar/Eigent](https://github.com/saichandrasekhar/Eigent)
2. Fix the critical findings it reports (seriously, go restrict that filesystem server path)
3. Share your scan results -- what did you find? How many shadow agents? Post them in the issues or tweet at us.
4. If you're a security team: try running it across your developers' machines. Run `eigent-scan scan --output json` and aggregate the results. The number of unmonitored agents will alarm you.

We're building this in the open because agent security shouldn't be a luxury. The scanner is Apache 2.0 licensed. Contributions welcome.

The agents are already running. The question is whether you know what they're doing.

---

*Eigent (eigen + agent): the fundamental trust state of autonomous AI agents. Because you can't secure what you can't see.*

*GitHub: [github.com/saichandrasekhar/Eigent](https://github.com/saichandrasekhar/Eigent) | Website: [eigent.dev](https://eigent.dev)*

---

---

# HN Submission

## Title

I scanned my machine for AI agents. Here's what I found.

## First comment to post

Hey HN, I built this. eigent-scan is an open-source CLI that discovers every MCP server configured across Claude Desktop, Cursor, VS Code, and Windsurf on your machine, then analyzes their security posture.

I wrote it after realizing I had 11 MCP servers running with zero auth, including a filesystem server pointed at / and six packages being downloaded via npx on every launch without version pinning.

It's read-only, offline, takes 30 seconds to install and run:

    pip install eigent-scan && eigent-scan scan --verbose

What it checks: missing authentication, overpermissions (filesystem/shell access), supply chain risk (npx/uvx without pinning), secrets in env vars, stale configs.

Output formats: table (terminal), JSON (pipe to jq/SIEM), SARIF (GitHub Security tab). There's also a GitHub Action for CI gating.

We're also building an OTel sidecar that sits in front of any stdio MCP server and emits spans for every tool call -- so you can see what your agents are actually doing at runtime, in Jaeger/Grafana/Datadog/whatever you already use.

The semantic conventions for MCP-over-OpenTelemetry are in the repo too. We think this should be a community standard.

Apache 2.0. Python 3.10+. No account required.

Repo: https://github.com/saichandrasekhar/Eigent

Would love feedback on the security heuristics -- what findings would be most useful for your setup?
