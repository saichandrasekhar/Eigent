# System Design

Eigent is composed of five components that together provide agent identity, permission enforcement, discovery, and observability. This page describes each component, their interactions, and deployment models.

## Component Architecture

```mermaid
graph TB
    subgraph "Human Interface"
        CLI[Eigent CLI<br>@eigent/cli]
        Dashboard[Dashboard<br>eigent-dashboard]
    end

    subgraph "Runtime Enforcement"
        Sidecar[Eigent Sidecar<br>@eigent/sidecar]
    end

    subgraph "Core Services"
        Registry[Eigent Registry<br>@eigent/registry]
        Core[Eigent Core<br>@eigent/core]
    end

    subgraph "Discovery"
        Scanner[Eigent Scan<br>eigent-scan]
    end

    subgraph "Observability"
        OTel[OTel Collector]
        SIEM[SIEM / Splunk / Datadog]
    end

    subgraph "External"
        MCP[MCP Servers]
        Agent[AI Agents]
        IdP[Identity Provider]
    end

    CLI -->|REST API| Registry
    Dashboard -->|REST API| Registry
    CLI -->|spawns| Sidecar

    Agent -->|MCP protocol| Sidecar
    Sidecar -->|verify| Registry
    Sidecar -->|forward| MCP
    Sidecar -->|OTLP| OTel

    Registry -->|uses| Core
    Registry -->|SQLite| DB[(Database)]

    Scanner -->|reads| MCP
    Scanner -->|SARIF| GitHub[GitHub Security]

    OTel --> SIEM
    Registry -->|audit API| SIEM

    CLI -.->|OIDC| IdP
```

## Components

### Eigent CLI (`@eigent/cli`)

The CLI is the human-facing interface for agent identity management. Written in TypeScript with Commander.js, Inquirer.js, and Chalk.

**Responsibilities:**

- Human authentication (OIDC flow)
- Agent token issuance and delegation
- Token verification and revocation
- Audit log queries
- Sidecar orchestration via `eigent wrap`

**Key design decisions:**

- Stateful sessions stored in `~/.eigent/session.json`
- Tokens stored as files in `~/.eigent/tokens/<name>.jwt`
- Project configuration in `.eigent/config.json`
- All registry communication via REST API

### Eigent Core (`@eigent/core`)

The core library provides cryptographic primitives used by both the CLI and the registry. It has zero network dependencies and can be used in any Node.js environment.

**Responsibilities:**

- Ed25519 key generation and management
- JWS token issuance and validation
- Scope intersection computation
- Delegation chain validation
- Revocation store interface

**Key design decisions:**

- Uses the `jose` library for JWS operations (audited, maintained)
- Zod schemas for runtime validation of all inputs
- SPIFFE URI format for agent identifiers
- UUIDv7 for time-ordered unique identifiers
- In-memory revocation store with a pluggable interface

### Eigent Registry (`@eigent/registry`)

The registry is the central identity server. Built with Hono (a fast, lightweight web framework) and better-sqlite3.

**Responsibilities:**

- Agent record storage and lifecycle management
- Token issuance with registry-managed Ed25519 keys
- Token verification (signature + expiry + scope + status)
- Delegation chain tracking with parent-child relationships
- Cascade revocation across the delegation tree
- Audit log recording and querying
- JWKS endpoint for offline verification

**Key design decisions:**

- Embedded SQLite for zero-dependency deployment
- Synchronous database operations (better-sqlite3) for simplicity and consistency
- No external dependencies for state (no Redis, no Postgres required)
- Audit log in the same database for transactional consistency
- JWKS endpoint enables offline token verification

**Database schema:**

```mermaid
erDiagram
    AGENTS {
        string id PK
        string name
        string human_sub
        string human_email
        string human_iss
        string scope
        string parent_id FK
        int delegation_depth
        int max_delegation_depth
        string can_delegate
        string token_jti
        string status
        string created_at
        string expires_at
        string revoked_at
        string metadata
    }

    AUDIT_LOG {
        string id PK
        string timestamp
        string agent_id FK
        string human_email
        string action
        string tool_name
        string delegation_chain
        string details
    }

    AGENTS ||--o{ AGENTS : "parent_id"
    AGENTS ||--o{ AUDIT_LOG : "agent_id"
```

### Eigent Sidecar (`@eigent/sidecar`)

The sidecar is a transparent MCP proxy that intercepts tool calls and enforces permissions in real time.

**Responsibilities:**

- MCP protocol implementation (both server and client sides)
- Token-based authorization for every `tools/call`
- OpenTelemetry span export for observability
- Monitor and enforce operating modes

**Key design decisions:**

- stdio transport for Claude Desktop compatibility
- Transparent passthrough for non-tool-call messages
- Async OTel export (non-blocking)
- Error messages include the authorizing human's email for escalation

### Eigent Scan (`eigent-scan`)

The scanner is a standalone Python tool for discovering AI agents and MCP servers. It operates independently of the rest of the Eigent stack.

**Responsibilities:**

- Configuration file scanning (14 locations across 5 tools)
- Live process discovery (shadow agent detection)
- Security risk assessment (6 checks per server)
- Multi-format reporting (SARIF, HTML, JSON, table)
- CI/CD integration (GitHub Action, GitLab CI)

**Key design decisions:**

- Python for broad compatibility and easy CI/CD integration
- Read-only operation (never modifies discovered configs)
- SARIF output for GitHub Advanced Security integration
- Pluggable scanner architecture for adding new config locations

## Data Flow

### Token Issuance Flow

```mermaid
sequenceDiagram
    participant H as Human
    participant CLI as CLI
    participant R as Registry
    participant DB as SQLite

    H->>CLI: eigent issue code-agent
    CLI->>CLI: Read session (human identity)
    CLI->>R: POST /api/agents
    R->>R: Generate UUIDv7 agent ID
    R->>R: Build SPIFFE URI
    R->>R: Sign JWS with Ed25519
    R->>DB: INSERT agent record
    R->>DB: INSERT audit log (action: issued)
    R-->>CLI: { agent_id, token, scope, expires_at }
    CLI->>CLI: Save token to ~/.eigent/tokens/
    CLI-->>H: Display agent details
```

### Tool Call Verification Flow

```mermaid
sequenceDiagram
    participant A as AI Agent
    participant S as Sidecar
    participant R as Registry
    participant M as MCP Server
    participant DB as SQLite

    A->>S: tools/call { name: "read_file", arguments: {...} }
    S->>R: POST /api/verify { token, tool_name }
    R->>R: Verify JWS signature
    R->>R: Check token expiry
    R->>DB: Get agent record
    R->>R: Check agent status (active?)
    R->>R: Check scope (tool in scope?)
    R->>DB: INSERT audit log
    R-->>S: { allowed: true/false, reason }

    alt Allowed
        S->>M: tools/call { name: "read_file", arguments: {...} }
        M-->>S: result
        S-->>A: result
    else Denied
        S-->>A: error { "Eigent: permission denied" }
    end
```

## Deployment Models

### Local Development

Everything runs on a single machine. The registry uses an embedded SQLite database. No external services required.

```mermaid
graph LR
    subgraph "Developer Machine"
        CLI[CLI]
        Registry[Registry :3456]
        Sidecar[Sidecar]
        Agent[AI Agent]
        MCP[MCP Server]
    end

    CLI --> Registry
    Agent --> Sidecar --> Registry
    Sidecar --> MCP
```

**Best for:** Individual developers, prototyping, CI/CD pipelines.

### Team Deployment

The registry runs on a shared server. Multiple developers and agents connect to the same registry.

```mermaid
graph TB
    subgraph "Shared Server"
        Registry[Registry :3456]
        DB[(SQLite / PostgreSQL)]
    end

    subgraph "Dev Machine 1"
        CLI1[CLI] --> Registry
        Sidecar1[Sidecar] --> Registry
    end

    subgraph "Dev Machine 2"
        CLI2[CLI] --> Registry
        Sidecar2[Sidecar] --> Registry
    end

    subgraph "CI/CD"
        Scanner[eigent-scan] --> Registry
    end

    Registry --> DB
```

**Best for:** Small teams, shared development environments.

### Production Deployment

The registry runs behind a load balancer with a persistent database. OTel collector aggregates telemetry. SIEM receives audit events.

```mermaid
graph TB
    subgraph "Load Balancer"
        LB[Nginx / ALB]
    end

    subgraph "Registry Cluster"
        R1[Registry 1]
        R2[Registry 2]
    end

    subgraph "Data"
        DB[(PostgreSQL)]
        Redis[(Redis - Revocation Cache)]
    end

    subgraph "Observability"
        OTel[OTel Collector]
        SIEM[Splunk / Datadog]
    end

    LB --> R1
    LB --> R2
    R1 --> DB
    R2 --> DB
    R1 --> Redis
    R2 --> Redis
    OTel --> SIEM
```

**Best for:** Production environments, regulated industries, multi-team organizations.

## Technology Stack

| Component | Language | Framework | Key Dependencies |
|-----------|----------|-----------|------------------|
| CLI | TypeScript | Commander.js | chalk, ora, inquirer |
| Core | TypeScript | — | jose, zod, uuid |
| Registry | TypeScript | Hono | better-sqlite3, jose |
| Sidecar | TypeScript | — | MCP SDK, OTLP |
| Scanner | Python | — | Click, rich |
| Dashboard | TypeScript | React | Tailwind, Recharts |
