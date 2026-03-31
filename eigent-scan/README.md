# agentvault-scan

**Find every AI agent in your environment. Before attackers do.**

<!-- Badges -->
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://python.org)
[![PyPI](https://img.shields.io/pypi/v/agentvault-scan.svg)](https://pypi.org/project/agentvault-scan/)
[![Downloads](https://img.shields.io/pypi/dm/agentvault-scan.svg)](https://pypi.org/project/agentvault-scan/)

---

## The problem

AI agents are everywhere. MCP servers on developer laptops. Bedrock agents in AWS. LLM-powered Lambda functions with IAM roles nobody audited.

The numbers are alarming:

- **88%** of organizations have experienced an AI-related security incident in the past year
- Only **21%** of security teams have visibility into which AI agents are running in their environment
- The average enterprise has **3.5x more** AI agents deployed than their security team knows about

Most of these agents have **no authentication**, **broad permissions**, and **zero monitoring**. They can read your filesystem, execute shell commands, query databases, and call external APIs -- and nobody is tracking what they do.

**You can't secure what you can't see.**

## What agentvault-scan does

One command. Full visibility.

```bash
agentvault-scan scan
```

It discovers AI agents and MCP servers across your environment, analyzes their security posture, and tells you exactly what to fix.

### What it scans

| Target | Status | What it finds |
|--------|--------|---------------|
| **MCP Servers** | Available | Claude Desktop, Cursor, VS Code, Windsurf, project configs |
| **AWS** | Coming soon | Bedrock agents, Lambda + LLM, IAM roles, SageMaker |
| **Azure** | Coming soon | Azure OpenAI, AI agents, Functions |
| **GCP** | Coming soon | Vertex AI, Cloud Functions, IAM |

### What it checks

- **No authentication** -- MCP servers running without any auth mechanism
- **Overpermissions** -- Agents with filesystem, shell, or database access they don't need
- **Supply chain risk** -- Servers launched via `npx`/`uvx` downloading unverified packages
- **Secret exposure** -- API keys and tokens passed as environment variables
- **Config drift** -- Disabled servers still in configs, stale entries
- **File permissions** -- Config files readable by all users on the system

## Quick start

### Install

```bash
pip install agentvault-scan
```

Or run directly:

```bash
pipx install agentvault-scan
```

### Scan

```bash
# Scan everything
agentvault-scan scan

# Scan with details
agentvault-scan scan --verbose

# MCP servers only
agentvault-scan scan --target mcp

# JSON output (pipe to jq, save to file, send to SIEM)
agentvault-scan scan --output json > scan-results.json
```

### Develop

```bash
git clone https://github.com/agentvault/agentvault-scan.git
cd agentvault-scan
pip install -e ".[dev]"
agentvault-scan scan --verbose
```

## Example output

```
  +------------------------------------------+
  |                                          |
  |  AgentVault Scan  v0.1.0                 |
  |  Discover AI agents. Expose security     |
  |  gaps.                                   |
  |                                          |
  +------------------------------------------+

  +--- Scan Summary ----------------------------+
  |                                             |
  |  Targets scanned:    mcp, aws               |
  |  Agents discovered:  7                      |
  |  Agents with no auth: 5                     |
  |  Security findings:  12                     |
  |    Critical:         3                      |
  |    High:             4                      |
  |  Overall risk:       CRITICAL               |
  |  Scan duration:      0.08s                  |
  |                                             |
  +---------------------------------------------+

  +--- Discovered AI Agents / MCP Servers ------+
  | # | Name        | Transport | Auth     |    |
  |---|-------------|-----------|----------|    |
  | 1 | filesystem  | stdio     | NONE     |    |
  | 2 | shell       | stdio     | NONE     |    |
  | 3 | postgres    | stdio     | API Key  |    |
  | 4 | playwright  | stdio     | NONE     |    |
  | 5 | my-api      | sse       | NONE     |    |
  +---------------------------------------------+

   Security Findings

  [!] CRITICAL  High-risk server 'filesystem' grants broad system access
      MCP server 'filesystem' matches high-risk patterns: filesystem.
      Combined with none authentication, this represents a significant
      attack surface.

  [!] CRITICAL  High-risk server 'shell' grants broad system access
      MCP server 'shell' matches high-risk patterns: shell.

  [!] HIGH  No authentication configured for 'my-api'
      MCP server 'my-api' is configured with sse transport and no
      authentication mechanism detected.

  [~] MEDIUM  Secrets passed via environment to 'postgres'
      MCP server 'postgres' receives sensitive-looking environment
      variables: POSTGRES_PASSWORD.

  +--- Recommendations -------------------------+
  | Priority  | Action                          |
  |-----------|-------------------------------- |
  | CRITICAL  | Restrict tool permissions to    |
  |           | only what is needed. Use        |
  |           | allowlists for file paths.      |
  | HIGH      | Add authentication to this MCP  |
  |           | server. For HTTP/SSE, configure |
  |           | OAuth 2.0 or API key auth.      |
  +---------------------------------------------+

  +--- Next Steps ------------------------------+
  |                                             |
  |  1. Review findings and address critical    |
  |     issues first                            |
  |  2. Export: agentvault-scan scan -o json    |
  |  3. Re-run regularly to detect drift        |
  |  4. Full platform: https://agentvault.dev   |
  |                                             |
  +---------------------------------------------+
```

## How it works

`agentvault-scan` reads configuration files from well-known locations on your system. It does **not** execute any MCP servers, make network requests, or modify any files. It is a read-only, offline scanner.

**MCP config locations scanned:**

| Tool | Path |
|------|------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Claude CLI | `~/.claude/settings.json`, `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json`, `.cursor/mcp.json` |
| VS Code | `~/.vscode/settings.json`, `.vscode/settings.json`, `.vscode/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Project | `.mcp.json`, `mcp.json` |

## CI/CD integration

Run in your CI pipeline to catch new agents before they reach production:

```yaml
# GitHub Actions
- name: Scan for AI agents
  run: |
    pip install agentvault-scan
    agentvault-scan scan --output json > agentvault-results.json
    # Fail if critical findings
    python -c "
    import json, sys
    r = json.load(open('agentvault-results.json'))
    if r['summary']['critical_findings'] > 0:
        print(f'FAILED: {r[\"summary\"][\"critical_findings\"]} critical findings')
        sys.exit(1)
    "
```

## Roadmap

- [x] MCP server scanner (local configs)
- [ ] AWS scanner (Bedrock, Lambda, IAM, SageMaker)
- [ ] Azure scanner (OpenAI Service, Functions, Managed Identity)
- [ ] GCP scanner (Vertex AI, Cloud Functions, IAM)
- [ ] PDF report export
- [ ] SARIF output (GitHub Security tab integration)
- [ ] Policy-as-code (define allowed agent configurations)
- [ ] Continuous monitoring mode (watch for config changes)
- [ ] SBOM generation for AI agents

## AgentVault Platform

`agentvault-scan` is the free, open-source scanner from **AgentVault** -- the agent trust infrastructure platform.

Need more? [AgentVault](https://agentvault.dev) provides:

- **Continuous monitoring** -- real-time alerts when new agents appear or configs change
- **Policy enforcement** -- define and enforce what agents are allowed in your environment
- **Audit logging** -- full history of agent activity for compliance
- **Team dashboard** -- centralized view across your entire organization
- **SSO / SCIM** -- enterprise identity integration

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
git clone https://github.com/agentvault/agentvault-scan.git
cd agentvault-scan
pip install -e ".[dev]"
pytest
```

## License

Apache 2.0. See [LICENSE](LICENSE).

---

Built by [AgentVault](https://agentvault.dev). Because you can't secure what you can't see.
