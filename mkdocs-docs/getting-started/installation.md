# Installation

Eigent is composed of several packages. Install only the components you need.

## CLI

The Eigent CLI is the primary interface for managing agent identities. It handles authentication, token issuance, delegation, revocation, and auditing.

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

The registry is the central identity server. It stores agent records, manages delegation chains, handles token verification, and maintains the audit log.

```bash
# Clone the repository
git clone https://github.com/saichandrasekhar/Eigent.git
cd Eigent/eigent-registry

# Install dependencies
npm install

# Start the registry (development)
npm run dev
```

The registry starts on `http://localhost:3456` by default. It uses an embedded SQLite database that requires no external database setup.

!!! tip "Production deployment"
    For production, build the registry and run with a process manager:
    ```bash
    npm run build
    NODE_ENV=production node dist/index.js
    ```

**Requirements:** Node.js 18 or later.

## Sidecar

The sidecar is a lightweight MCP traffic interceptor that enforces Eigent policies on tool calls in real time. It sits between the AI agent and the MCP server, verifying every request against the agent's token.

=== "npm (global)"

    ```bash
    npm install -g @eigent/sidecar
    ```

=== "From source"

    ```bash
    cd Eigent/eigent-sidecar
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

**Requirements:** Node.js 18 or later.

## Docker (Coming Soon)

A Docker Compose setup for running the full Eigent stack is planned. This will include the registry, dashboard, and a pre-configured sidecar.

```yaml
# docker-compose.yml (planned)
services:
  registry:
    image: ghcr.io/saichandrasekhar/eigent-registry:latest
    ports:
      - "3456:3456"
    volumes:
      - eigent-data:/data

  dashboard:
    image: ghcr.io/saichandrasekhar/eigent-dashboard:latest
    ports:
      - "3457:3457"
    depends_on:
      - registry

volumes:
  eigent-data:
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
      ╔══════════════════════════════════════╗
      ║          E I G E N T                ║
      ╚══════════════════════════════════════╝

      Project     initialized
      Registry    http://localhost:3456
      Session     not logged in
      Tokens      none

      Registry: reachable
    ```

If the registry shows as `reachable`, your setup is complete. Proceed to the [Quick Start](quickstart.md) to issue your first agent identity.

## Troubleshooting

### Registry not reachable

Ensure the registry is running in a separate terminal. The CLI connects to `http://localhost:3456` by default:

```bash
cd eigent-registry && npm run dev
```

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

Eigent Scanner requires Python 3.10+. Check your version:

```bash
python3 --version
```

If your system Python is older, use `pyenv` or install from [python.org](https://www.python.org/downloads/).
