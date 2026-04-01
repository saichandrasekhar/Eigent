# Installation

Eigent is composed of several packages. Install the components you need for your use case.

## Docker Compose (Full Stack)

The fastest way to run the complete Eigent platform -- registry, sidecar, dashboard, and a demo MCP server:

```bash
git clone https://github.com/saichandrasekhar/Eigent.git
cd Eigent
docker compose up
```

This starts:

- **Registry** on `http://localhost:3456`
- **Dashboard** on `http://localhost:3000`
- **Sidecar** connected to the registry
- **Demo MCP server** for testing

## CLI

The Eigent CLI is the primary interface for managing agent identities. It handles authentication, token issuance, delegation, revocation, key rotation, compliance reports, and auditing.

=== "npm"

    ```bash
    npm install -g @eigent/cli
    ```

=== "pnpm"

    ```bash
    pnpm add -g @eigent/cli
    ```

=== "yarn"

    ```bash
    yarn global add @eigent/cli
    ```

Verify the installation:

```bash
eigent --version
# eigent/1.0.0
```

**Requirements:** Node.js 18 or later.

## Python SDK

The Python SDK provides `EigentClient` for programmatic agent management and `@eigent_protected` for tool-level enforcement.

=== "pip"

    ```bash
    pip install eigent
    ```

=== "pipx (isolated)"

    ```bash
    pipx install eigent
    ```

=== "uv"

    ```bash
    uv pip install eigent
    ```

```python
from eigent import EigentClient

client = EigentClient(registry_url="http://localhost:3456")
session = client.login(email="alice@company.com", demo_mode=True)
agent = client.register_agent(name="my-agent", scope=["read_file"])
```

**Requirements:** Python 3.10 or later.

## Scanner

The Eigent scanner discovers AI agents, MCP servers, and LLM-powered processes running in your environment. It is a standalone Python tool that does not require the rest of the Eigent stack.

=== "pip"

    ```bash
    pip install eigent-scan
    ```

=== "pipx (isolated)"

    ```bash
    pipx install eigent-scan
    ```

=== "uv"

    ```bash
    uv tool install eigent-scan
    ```

Verify the installation:

```bash
eigent-scan --version
# eigent-scan 0.1.0
```

**Requirements:** Python 3.10 or later.

## Registry

The registry is the central identity server. It stores agent records, manages delegation chains, handles OIDC authentication, and provides the audit log, approval queue, compliance reports, and SIEM webhooks.

=== "Docker"

    ```bash
    docker compose up registry
    ```

=== "From source"

    ```bash
    cd eigent-registry
    npm install
    npm run dev    # Development with SQLite
    ```

=== "Production"

    ```bash
    cd eigent-registry
    npm run build
    DATABASE_URL=postgres://user:pass@host/eigent \
    EIGENT_MASTER_KEY=your-256-bit-key \
    NODE_ENV=production node dist/index.js
    ```

The registry starts on `http://localhost:3456` by default. In development mode it uses an embedded SQLite database. For production, configure PostgreSQL via `DATABASE_URL` and set `EIGENT_MASTER_KEY` for AES-256-GCM encryption at rest.

**Requirements:** Node.js 18 or later. PostgreSQL 14+ for production.

## Sidecar

The sidecar is a lightweight MCP traffic interceptor that enforces Eigent policies on tool calls in real time. It supports both stdio and HTTP proxy modes, with a YAML policy engine, approval queue polling, OTel spans, and Prometheus metrics.

=== "npm (global)"

    ```bash
    npm install -g @eigent/sidecar
    ```

=== "From source"

    ```bash
    cd eigent-sidecar
    npm install
    npm run build
    npm link
    ```

**Requirements:** Node.js 18 or later.

## Core Library

The core library provides the cryptographic primitives for token issuance, delegation, permission checks, and revocation. Use it when building custom integrations.

=== "npm"

    ```bash
    npm install @eigent/core
    ```

=== "pnpm"

    ```bash
    pnpm add @eigent/core
    ```

76 tests cover Ed25519 key generation, JWS signing/verification, scope intersection, and delegation chain validation.

**Requirements:** Node.js 18 or later.

## Helm Chart (Kubernetes)

Deploy the full Eigent stack to Kubernetes:

```bash
helm install eigent deploy/helm/eigent \
  --set registry.database.url=postgres://... \
  --set registry.masterKey=your-key \
  --set registry.oidc.issuer=https://your-idp.com
```

See `deploy/helm/eigent/values.yaml` for all configuration options.

## Terraform

Infrastructure-as-code modules for provisioning Eigent on AWS, GCP, or Azure:

```hcl
module "eigent" {
  source = "./deploy/terraform"

  database_url = var.database_url
  master_key   = var.master_key
  oidc_issuer  = var.oidc_issuer
}
```

See `deploy/terraform/` for available modules.

## Dashboard

The Next.js dashboard provides 6 pages: overview, agent inventory, delegation tree visualization, audit log, policy editor, and compliance reports. It uses NextAuth for SSO with RBAC (admin, operator, viewer).

```bash
cd eigent-dashboard
npm install
npm run dev    # http://localhost:3000
```

Or via Docker Compose:

```bash
docker compose up dashboard
```

## Verifying Your Setup

After installing the CLI and starting the registry, run the full verification:

```bash
# Initialize the project
eigent init

# Check status
eigent status
```

??? example "Expected output"
    ```
      Project     initialized
      Registry    http://localhost:3456
      Session     not logged in
      Tokens      none

      Registry: reachable
    ```

If the registry shows as `reachable`, your setup is complete. Proceed to the [Quick Start](quickstart.md) to issue your first agent identity.

## Troubleshooting

### Registry not reachable

Ensure the registry is running. With Docker Compose:

```bash
docker compose up registry
```

Or from source:

```bash
cd eigent-registry && npm run dev
```

The CLI connects to `http://localhost:3456` by default.

### Permission denied on global install

Use `sudo` or configure npm to use a different prefix:

```bash
# Option 1: sudo
sudo npm install -g @eigent/cli

# Option 2: change npm prefix (recommended)
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g @eigent/cli
```

### Python version too old

Eigent SDK and Scanner require Python 3.10+. Check your version:

```bash
python3 --version
```

If your system Python is older, use `pyenv` or install from [python.org](https://www.python.org/downloads/).
