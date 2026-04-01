# CI/CD Pipeline

Eigent integrates into your CI/CD pipeline to scan for unprotected AI agents, flag security risks, and gate merges on agent security posture. Findings appear directly in the GitHub Security tab via SARIF upload.

## GitHub Action (Recommended)

The Eigent GitHub Action runs `eigent-scan` on every push and pull request, uploading findings to GitHub Advanced Security.

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

### Action Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `target` | `all` | What to scan: `mcp` (configs only), `process` (running agents), or `all` |
| `fail-on` | `high` | Minimum severity to fail the build: `critical`, `high`, `medium`, `low`, `none` |
| `upload-sarif` | `true` | Upload findings to GitHub Security tab |
| `output` | `sarif` | Output format: `sarif`, `json`, `table`, `html` |
| `config` | — | Path to custom Eigent scan config file |

### Failing PRs on Policy Violations

Set `fail-on` to control when PRs are blocked:

```yaml
# Block on critical and high findings
- uses: saichandrasekhar/Eigent/eigent-scan@main
  with:
    fail-on: high

# Block on any finding
- uses: saichandrasekhar/Eigent/eigent-scan@main
  with:
    fail-on: low

# Never block (monitor only)
- uses: saichandrasekhar/Eigent/eigent-scan@main
  with:
    fail-on: none
```

### SARIF Integration

When `upload-sarif` is enabled, findings appear in the **Security** tab of your GitHub repository under **Code scanning alerts**. Each finding includes:

- Severity level (critical, high, medium, low)
- The MCP server or agent that triggered the finding
- The specific security check that failed
- Remediation guidance

```yaml
# Manual SARIF upload (if not using the action)
- name: Scan
  run: |
    pip install eigent-scan
    eigent-scan scan --output sarif > results.sarif

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: results.sarif
```

## GitLab CI

```yaml
stages:
  - test

eigent-scan:
  stage: test
  image: python:3.12-slim
  script:
    - pip install eigent-scan
    - eigent-scan scan --output sarif --fail-on high > gl-eigent-results.sarif
  artifacts:
    reports:
      sast: gl-eigent-results.sarif
    when: always
  allow_failure: false
```

GitLab automatically ingests the SARIF file and displays findings in the **Security Dashboard** and on merge request widgets.

## Jenkins

```groovy
pipeline {
    agent any

    stages {
        stage('AI Agent Security') {
            steps {
                sh '''
                    pip install eigent-scan
                    eigent-scan scan --output sarif --fail-on high > results.sarif
                '''
            }
            post {
                always {
                    archiveArtifacts artifacts: 'results.sarif'
                }
            }
        }
    }
}
```

## CircleCI

```yaml
version: 2.1

jobs:
  eigent-scan:
    docker:
      - image: python:3.12-slim
    steps:
      - checkout
      - run:
          name: Install Eigent Scanner
          command: pip install eigent-scan
      - run:
          name: Scan for AI agents
          command: eigent-scan scan --output sarif --fail-on high > results.sarif
      - store_artifacts:
          path: results.sarif

workflows:
  security:
    jobs:
      - eigent-scan
```

## What Gets Scanned

The scanner checks 14 configuration locations across popular AI development tools:

| Tool | Config Locations |
|------|-----------------|
| Claude Desktop | `~/Library/Application Support/Claude/`, `%APPDATA%\Claude\` |
| Cursor | `.cursor/mcp.json`, cursor settings |
| VS Code | `.vscode/mcp.json`, VS Code settings |
| Windsurf | `.windsurf/mcp.json` |
| Project files | `.mcp.json`, `mcp.json`, `.eigent/` |

For each discovered MCP server, 6 security checks are run:

- [x] **Authentication** — Is auth configured?
- [x] **Permissions** — Are tool scopes restricted?
- [x] **Supply chain** — Is the package from a trusted source?
- [x] **Secrets** — Are credentials exposed in config?
- [x] **Drift** — Has the config changed since last scan?
- [x] **File permissions** — Are config files world-readable?

## Scan Output Formats

=== "SARIF"

    ```bash
    eigent-scan scan --output sarif > results.sarif
    ```

    Standard Static Analysis Results Interchange Format. Compatible with GitHub Advanced Security, Azure DevOps, VS Code SARIF Viewer.

=== "JSON"

    ```bash
    eigent-scan scan --output json > results.json
    ```

    Machine-readable format for custom integrations.

=== "HTML"

    ```bash
    eigent-scan scan --output html
    ```

    Generates a shareable HTML report with risk scores, remediation guidance, and compliance mapping.

=== "Table"

    ```bash
    eigent-scan scan --verbose
    ```

    Human-readable terminal output with color-coded severity.

## Drift Detection

Run scans on a schedule to detect configuration drift:

```yaml
# GitHub Action: daily scan
on:
  schedule:
    - cron: '0 8 * * *'  # Every day at 8 AM UTC
  push:
    branches: [main]

jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: saichandrasekhar/Eigent/eigent-scan@main
        with:
          target: mcp
          fail-on: medium
```

Drift detection compares the current scan against the previous baseline and alerts when:

- New MCP servers appear
- Server configurations change
- Authentication is removed
- Scopes are widened

## Best Practices

!!! tip "Start with monitor mode"
    Set `fail-on: none` initially to collect findings without blocking PRs. Review the findings, add Eigent tokens where needed, then tighten to `fail-on: high`.

!!! tip "Scan on every PR"
    Developers add MCP server configs frequently. Scanning on every PR catches new unprotected agents before they reach main.

!!! tip "Use SARIF for visibility"
    SARIF upload puts findings in the same Security tab as CodeQL and Dependabot alerts, giving security teams a single pane of glass.

!!! tip "Separate scan and enforce"
    Use `eigent-scan` in CI to discover agents. Use the sidecar in runtime to enforce permissions. They complement each other: scan finds what is deployed, sidecar controls what runs.
