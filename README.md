<p align="center">
  <img src="docs/logo.svg" alt="Eigent Logo" width="280" />
  <br />
  <strong>E I G E N T</strong>
  <br />
  <em>Find every shadow AI agent. Before attackers do.</em>
</p>

<p align="center">
  <a href="https://github.com/saichandrasekhar/Eigent/actions"><img src="https://img.shields.io/github/actions/workflow/status/saichandrasekhar/Eigent/ci.yml?branch=main&style=flat-square&label=build" alt="Build Status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License" /></a>
  <a href="https://github.com/saichandrasekhar/Eigent/stargazers"><img src="https://img.shields.io/github/stars/saichandrasekhar/Eigent?style=flat-square&color=yellow" alt="GitHub Stars" /></a>
  <a href="https://pypi.org/project/eigent-scan/"><img src="https://img.shields.io/pypi/v/eigent-scan?style=flat-square&color=green" alt="PyPI Version" /></a>
  <a href="https://www.npmjs.com/package/eigent-sidecar"><img src="https://img.shields.io/npm/v/eigent-sidecar?style=flat-square&color=red" alt="npm Version" /></a>
  <a href="https://pypi.org/project/eigent-scan/"><img src="https://img.shields.io/pypi/dm/eigent-scan?style=flat-square" alt="Downloads" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#why-eigent">Why Eigent?</a> &bull;
  <a href="#cicd-integration">CI/CD</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="https://eigent.dev">Website</a>
</p>

---

## What is Eigent?

**Eigent** is an open-source security scanner that discovers AI agents, MCP servers, and LLM-powered tools running in your environment -- then flags the security risks nobody is watching. Think of it as **Trivy for AI agents**: one command, full visibility, zero config.

---

## Quick Start

Three commands. Zero to findings in under 30 seconds.

```bash
pip install eigent-scan            # Install
eigent-scan scan --verbose         # Discover agents + flag risks
eigent-scan scan --output html     # Generate a shareable report
```

<details>
<summary><strong>See it in action</strong></summary>

```
$ eigent-scan scan --verbose

  ╔══════════════════════════════════════════╗
  ║  Eigent Scan  v0.1.0                    ║
  ║  Discover AI agents. Expose risks.      ║
  ╚══════════════════════════════════════════╝

  Scanning ███████████████████████████ 14 locations

  ┌─── Scan Summary ─────────────────────────┐
  │  Targets scanned:    mcp, process        │
  │  Agents discovered:  7                   │
  │  Security findings:  12                  │
  │    Critical:  3  ██████                  │
  │    High:      4  ████████               │
  │    Medium:    5  ██████████             │
  │  Overall risk:  CRITICAL                 │
  │  Scan duration: 0.08s                    │
  └──────────────────────────────────────────┘

  ┌─── Discovered AI Agents / MCP Servers ───┐
  │ #  Name         Transport  Auth          │
  │ 1  filesystem   stdio      NONE    [!!]  │
  │ 2  shell        stdio      NONE    [!!]  │
  │ 3  postgres     stdio      API Key       │
  │ 4  playwright   stdio      NONE    [!]   │
  │ 5  my-api       sse        NONE    [!]   │
  │ 6  bedrock-agent process   IAM           │
  │ 7  openai-fn    process    NONE    [!!]  │
  └──────────────────────────────────────────┘

  FINDINGS

  [!!] CRITICAL  filesystem — broad system access, no auth
       MCP server has unrestricted read/write to the filesystem.
       No authentication mechanism configured.

  [!!] CRITICAL  shell — arbitrary command execution
       MCP server can execute shell commands with the
       permissions of the current user.

  [!]  HIGH  my-api — unauthenticated SSE endpoint
       Network-accessible MCP server with no auth.
       Any process on the network can invoke tools.

  [~]  MEDIUM  postgres — secrets in environment variables
       POSTGRES_PASSWORD passed via env. Use a secret
       manager instead.

  ── Recommendations ────────────────────────
  1. Restrict filesystem/shell tool permissions to allowlists
  2. Add OAuth 2.0 or API key auth to SSE-transport servers
  3. Move secrets from env vars to a vault
  4. Export: eigent-scan scan --output sarif
  5. Re-run in CI to detect drift
```

</details>

---

## Features

<table>
<tr>
<td width="50%">

### :mag: MCP Config Scanner
Scans **14 config locations** across Claude Desktop, Cursor, VS Code, Windsurf, and project files. Runs **6 security checks** per server (auth, permissions, supply chain, secrets, drift, file permissions).

</td>
<td width="50%">

### :ghost: Live Process Discovery
Detects **shadow AI agents** -- processes with LLM connections that never appeared in any config. Finds what your team forgot to tell you about.

</td>
</tr>
<tr>
<td>

### :page_facing_up: HTML & PDF Reports
Generate **board-ready reports** with risk scores, compliance mapping (EU AI Act, SOC 2, ISO 27001), and remediation priorities. Share with auditors, not just engineers.

</td>
<td>

### :link: SARIF Output
Findings flow directly into the **GitHub Security tab**. Works with any SARIF-compatible tool: GitHub Advanced Security, Azure DevOps, VS Code SARIF Viewer.

</td>
</tr>
<tr>
<td>

### :gear: CI/CD Integration
Ship a **GitHub Action** out of the box. Gate merges on agent security posture. Works with GitLab CI, Jenkins, CircleCI, and any CI that runs `pip install`.

</td>
<td>

### :bell: Webhook Alerts
Send findings to **Slack**, **PagerDuty**, **Microsoft Teams**, or any webhook endpoint. Get notified when a new unprotected agent appears.

</td>
</tr>
<tr>
<td>

### :chart_with_upwards_trend: Scan History & Drift Detection
Track your agent inventory over time. Get alerted when configs change, new servers appear, or security posture degrades between scans.

</td>
<td>

### :satellite: OTel Sidecar
Lightweight MCP traffic interceptor that exports **OpenTelemetry spans** for every tool call. Real-time telemetry without modifying your agents.

</td>
</tr>
</table>

---

## Why Eigent?

AI agents are the **fastest-growing unmanaged attack surface** in the enterprise.

| | |
|---|---|
| **88%** of organizations had an AI agent security incident last year | Source: industry reports, 2025 |
| Only **21%** of security teams know which AI agents are running | The rest are flying blind |
| Shadow AI breaches cost **$670K more** than standard incidents | Longer dwell time, broader blast radius |

Your developers are installing MCP servers with filesystem access, shell execution, and database credentials -- with **zero authentication** and **zero monitoring**. `eigent-scan` finds them all in seconds.

---

## How Eigent Compares

| Capability | **Eigent** | Astrix Security | Okta NHI | DIY (OPA + ELK) |
|---|:---:|:---:|:---:|:---:|
| MCP server discovery | :white_check_mark: | :x: | :x: | :x: |
| Shadow agent detection | :white_check_mark: | Partial | :x: | Manual |
| Security risk analysis | :white_check_mark: | :white_check_mark: | Limited | Manual |
| SARIF / GitHub Security | :white_check_mark: | :x: | :x: | :x: |
| CI/CD gate (GitHub Action) | :white_check_mark: | :x: | :x: | Custom |
| OTel telemetry sidecar | :white_check_mark: | :x: | :x: | Custom |
| Open source | :white_check_mark: | :x: | :x: | :white_check_mark: |
| Setup time | **30 seconds** | Weeks | Weeks | Months |
| Price | **Free** | $$$$$ | $$$$$ | Engineering time |

---

## CI/CD Integration

### GitHub Action (recommended)

Findings automatically appear in the **Security** tab via SARIF upload.

```yaml
name: AI Agent Security Scan
on: [push, pull_request]

permissions:
  security-events: write
  contents: read

jobs:
  eigent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Scan for AI agents
        uses: saichandrasekhar/Eigent/eigent-scan@main
        with:
          target: all             # mcp, process, or all
          fail-on: high           # critical, high, medium, low, none
          upload-sarif: true      # Push to GitHub Security tab
```

<details>
<summary>GitLab CI / Jenkins</summary>

```yaml
# GitLab CI
security-scan:
  stage: test
  script:
    - pip install eigent-scan
    - eigent-scan scan --output sarif --fail-on high > gl-eigent-results.sarif
  artifacts:
    reports:
      sast: gl-eigent-results.sarif
```

```bash
# Jenkins (shell step)
pip install eigent-scan
eigent-scan scan --output sarif --fail-on high > results.sarif
```

</details>

---

## Architecture

```
                        ┌──────────────────────────────────┐
                        │         Your Environment         │
                        │                                  │
  ┌─────────────┐       │   ┌───────────┐  ┌───────────┐  │
  │ eigent-scan │──────▶│   │ MCP       │  │ Shadow    │  │
  │   (CLI)     │ read  │   │ Configs   │  │ Processes │  │
  └──────┬──────┘ only  │   └───────────┘  └───────────┘  │
         │              └──────────────────────────────────┘
         │
         ▼
  ┌──────────────┐       ┌──────────────┐
  │   Findings   │       │   Sidecar    │
  │              │       │              │
  │ - Table/JSON │       │ MCP Client   │
  │ - HTML/PDF   │       │   ↕ [tap]    │
  │ - SARIF      │──┐    │ MCP Server   │
  └──────────────┘  │    └──────┬───────┘
                    │           │
         ┌──────────┘           │  OTel spans
         ▼                      ▼
  ┌──────────────┐       ┌──────────────┐
  │   GitHub     │       │   Eigent     │
  │   Security   │       │   Platform   │
  │   Tab        │       │              │
  └──────────────┘       │ - Identity   │
                         │ - Audit Log  │
  ┌──────────────┐       │ - Compliance │
  │  Webhooks    │       │ - Dashboard  │
  │ Slack/PD/etc │       │ - Alerting   │
  └──────────────┘       └──────────────┘
```

---

## Project Structure

```
eigent-scan/            # Python CLI scanner (PyPI: eigent-scan)
eigent-sidecar/         # TypeScript MCP sidecar (npm: eigent-sidecar)
otel-mcp-convention/    # OpenTelemetry semantic convention for MCP (draft)
docs/                   # Documentation
```

---

## Contributing

We welcome contributions of all kinds: bug reports, feature requests, docs, and code.

```bash
git clone https://github.com/saichandrasekhar/Eigent.git
cd Eigent/eigent-scan
pip install -e ".[dev]"
pytest
```

See [CONTRIBUTING.md](eigent-scan/CONTRIBUTING.md) for full guidelines.

**Good first issues** are tagged with [`good first issue`](https://github.com/saichandrasekhar/Eigent/labels/good%20first%20issue).

---

## Community

- **Discussions** -- [GitHub Discussions](https://github.com/saichandrasekhar/Eigent/discussions) for questions and ideas
- **Issues** -- [GitHub Issues](https://github.com/saichandrasekhar/Eigent/issues) for bugs and feature requests
- **Discord** -- [Join our Discord](https://discord.gg/eigent) (coming soon)
- **Twitter** -- [@eigent_dev](https://twitter.com/eigent_dev)

---

## License

[Apache 2.0](LICENSE) -- free forever, no vendor lock-in.

---

<p align="center">
  <strong>You can't secure what you can't see.</strong>
  <br />
  <a href="https://eigent.dev">eigent.dev</a> &bull; <a href="https://pypi.org/project/eigent-scan/">PyPI</a> &bull; <a href="https://github.com/saichandrasekhar/Eigent/issues">Report a Bug</a>
  <br /><br />
  If Eigent helps you, consider giving it a <a href="https://github.com/saichandrasekhar/Eigent">star</a>. It helps others find it.
</p>
