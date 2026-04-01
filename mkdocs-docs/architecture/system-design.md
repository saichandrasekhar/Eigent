# System Design

Eigent is composed of eight components that together provide agent identity, delegation governance, permission enforcement, discovery, and observability. This page describes each component, their interactions, and deployment models.

## Component Architecture

```mermaid
graph TB
    subgraph "Human Interface"
        CLI[Eigent CLI<br>16 commands]
        Dashboard[Dashboard<br>Next.js, 6 pages, SSO, RBAC]
    end

    subgraph "Runtime Enforcement"
        Sidecar[Eigent Sidecar<br>stdio + HTTP proxy<br>YAML policy engine<br>Approval queue polling<br>OTel + Prometheus]
    end

    subgraph "Core Services"
        Registry[Eigent Registry<br>Hono API<br>OIDC, SCIM, multi-tenancy<br>Approval queue, compliance<br>SIEM webhooks, rate limiting]
        Core[Eigent Core<br>Ed25519, JWS, scope intersection<br>76 tests]
    end

    subgraph "SDKs"
        PythonSDK[eigent-py<br>EigentClient + @eigent_protected]
    end

    subgraph "Discovery"
        Scanner[Eigent Scan<br>14 config locations<br>Shadow agent detection<br>SARIF, HTML, CI/CD]
    end

    subgraph "Deployment"
        Helm[Helm Chart]
        Terraform[Terraform Modules]
        Docker[Docker Compose]
    end

    subgraph "Observability"
        OTel[OTel Collector]
        SIEM[SIEM / Splunk / Datadog]
        Prom[Prometheus / Grafana]
    end

    subgraph "External"
        MCP[MCP Servers]
        Agent[AI Agents]
        IdP[Identity Provider<br>Okta / Entra / Google]
    end

    CLI -->|REST API| Registry
    Dashboard -->|REST API| Registry
    PythonSDK -->|REST API| Registry
    CLI -->|spawns| Sidecar

    Agent -->|MCP protocol| Sidecar
    Sidecar -->|verify + audit| Registry
    Sidecar -->|forward| MCP
    Sidecar -->|OTLP| OTel
    Sidecar -->|/metrics| Prom

    Registry -->|uses| Core
    Registry -->|PostgreSQL / SQLite| DB[(Database)]
    Registry -->|webhooks| SIEM

    Scanner -->|reads configs| MCP
    Scanner -->|SARIF| GitHub[GitHub Security]

    OTel --> SIEM

    CLI -.->|OIDC| IdP
    Registry -.->|OIDC verify| IdP
    Registry -.->|SCIM| IdP
```

## Components

### Eigent Core (`@eigent/core`)

The core library provides cryptographic primitives used by the CLI, registry, and sidecar. Zero network dependencies.

**Responsibilities:**

- Ed25519 key generation and management
- JWS token issuance and validation
- Three-way scope intersection computation
- Delegation chain validation (depth limits, permission narrowing)
- Revocation store interface

**Key design decisions:**

- `jose` library for JWS operations (audited, maintained)
- Zod schemas for runtime validation
- SPIFFE URI format for agent identifiers
- UUIDv7 for time-ordered unique IDs
- In-memory revocation store with pluggable interface
- 76 tests covering all crypto and delegation logic

### Eigent Registry (`@eigent/registry`)

The central identity server. Built with Hono.

**Responsibilities:**

- OIDC authentication (Okta, Entra ID, Google)
- Agent record storage and lifecycle (registration, delegation, revocation, rotation, expiry, heartbeat)
- Cascade revocation across the delegation tree
- SCIM deprovisioning -- automatic agent cleanup when users leave
- Multi-tenancy with organization-scoped isolation
- Approval queue for sensitive delegations
- Compliance reports (EU AI Act, SOC 2, ISO 27001)
- SIEM webhooks (Splunk, Datadog, PagerDuty, Slack)
- API versioning with OpenAPI spec
- Rate limiting (configurable per-endpoint)
- Health checks with dependency status
- AES-256-GCM encryption at rest
- JWKS endpoint for offline token verification

**Key design decisions:**

- SQLite for development (zero-dependency); PostgreSQL adapter for production
- AES-256-GCM encryption for sensitive fields at rest
- Audit log in the same database for transactional consistency
- API versioned under `/api/v1/`

**Database schema:**

```mermaid
erDiagram
    ORGANIZATIONS {
        string id PK
        string name
        string domain
        string created_at
    }

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
        string org_id FK
        string created_at
        string expires_at
        string revoked_at
        string last_heartbeat
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
        string org_id FK
        string details
    }

    WEBHOOKS {
        string id PK
        string url
        string events
        string secret
        string org_id FK
        string created_at
    }

    APPROVALS {
        string id PK
        string parent_agent_id FK
        string child_name
        string requested_scope
        string requested_by
        string status
        string decided_by
        string decided_at
        string created_at
    }

    ORGANIZATIONS ||--o{ AGENTS : "org_id"
    ORGANIZATIONS ||--o{ WEBHOOKS : "org_id"
    AGENTS ||--o{ AGENTS : "parent_id"
    AGENTS ||--o{ AUDIT_LOG : "agent_id"
    AGENTS ||--o{ APPROVALS : "parent_agent_id"
```

### Eigent Sidecar (`@eigent/sidecar`)

MCP traffic interceptor with policy enforcement and observability.

**Responsibilities:**

- MCP protocol implementation (server and client sides)
- **stdio transport** for Claude Desktop and local agents
- **HTTP proxy transport** for network-accessible MCP servers
- Token-based authorization for every `tools/call`
- **YAML policy engine** with glob patterns, argument regex, time windows, delegation depth limits, and hot-reload
- **Approval queue polling** for sensitive operations
- OpenTelemetry span export
- Prometheus metrics endpoint
- Enforce and monitor operating modes

**Key design decisions:**

- Dual transport: stdio (default) and HTTP proxy
- Policy engine evaluates locally (no network call for policy rules)
- Hot-reload watches policy file for changes
- Async OTel/Prometheus export (non-blocking)
- Error messages include the authorizing human's email for escalation

### Eigent CLI (`@eigent/cli`)

16 commands for complete agent lifecycle management. Written in TypeScript with Commander.js, Inquirer.js, and Chalk.

**Commands:**

| Command | Description |
|---------|-------------|
| `init` | Initialize Eigent for a project |
| `login` | Authenticate as a human via OIDC |
| `issue` | Issue a signed agent token |
| `delegate` | Delegate permissions to a child agent |
| `revoke` | Revoke an agent and cascade |
| `verify` | Check if an agent can call a tool |
| `chain` | Show the delegation chain |
| `wrap` | Wrap an MCP server with the sidecar |
| `audit` | Query the audit log |
| `rotate` | Rotate agent keys |
| `deprovision` | Deprovision a user (SCIM) |
| `stale` | Find stale agents |
| `usage` | Show agent usage statistics |
| `compliance-report` | Generate compliance evidence |
| `list` | List all agents |
| `logout` | Clear the session |

### eigent-py (Python SDK)

Python SDK providing `EigentClient` for programmatic access and `@eigent_protected` decorator for tool-level enforcement.

**Features:**

- Typed client for registration, delegation, verification, revocation, audit, compliance
- `@eigent_protected` decorator -- verifies token scope before each tool call
- LangChain and CrewAI integration examples
- EU AI Act risk classification support

### Eigent Scan (`eigent-scan`)

Standalone Python scanner for discovering AI agents and MCP servers. Operates independently of the rest of the stack.

**Responsibilities:**

- Configuration file scanning (14 locations across Claude Desktop, Cursor, VS Code, Windsurf)
- Live process discovery (shadow agent detection)
- Security risk assessment (6 checks per server)
- Multi-format reporting (SARIF, HTML, JSON, table)
- CI/CD integration (GitHub Action, GitLab CI, Jenkins)
- Webhook alerts (Slack, PagerDuty, Teams)
- Scan history and drift detection

### Eigent Dashboard (`eigent-dashboard`)

Next.js dashboard with 6 pages for visual management and monitoring.

**Pages:**

1. **Dashboard** -- overview metrics, active agents, recent events
2. **Agents** -- agent inventory with search, filter, and bulk actions
3. **Delegation Tree** -- visual tree of delegation chains
4. **Audit Log** -- searchable, filterable event history
5. **Policies** -- YAML policy editor with validation
6. **Compliance** -- compliance report viewer and evidence export

**Features:**

- NextAuth SSO integration
- RBAC with three roles: admin, operator, viewer
- Real-time updates via registry API polling

## Data Flow

### Token Issuance Flow

```mermaid
sequenceDiagram
    participant H as Human
    participant CLI as CLI
    participant R as Registry
    participant DB as Database

    H->>CLI: eigent login
    CLI->>R: OIDC authentication
    R-->>CLI: session token

    H->>CLI: eigent issue code-agent
    CLI->>CLI: Read session (human identity)
    CLI->>R: POST /api/v1/agents
    R->>R: Generate UUIDv7 agent ID
    R->>R: Build SPIFFE URI
    R->>R: Sign JWS with Ed25519
    R->>R: Encrypt sensitive fields (AES-256-GCM)
    R->>DB: INSERT agent record
    R->>DB: INSERT audit log (action: issued)
    R->>R: Dispatch webhooks (async)
    R-->>CLI: { agent_id, token, scope, expires_at }
    CLI->>CLI: Save token to ~/.eigent/tokens/
    CLI-->>H: Display agent details
```

### Tool Call Verification Flow

```mermaid
sequenceDiagram
    participant A as AI Agent
    participant S as Sidecar
    participant P as Policy Engine
    participant R as Registry
    participant M as MCP Server

    A->>S: tools/call { name: "read_file", arguments: {...} }
    S->>S: Token scope check (local)
    S->>P: Evaluate YAML policy rules
    P-->>S: allowed (args match, in time window)
    S->>R: POST /api/v1/verify { token, tool_name }
    R->>R: Verify JWS signature + expiry + status + scope
    R->>R: Log to audit trail
    R-->>S: { allowed: true }

    alt Allowed
        S->>M: tools/call { name: "read_file", arguments: {...} }
        M-->>S: result
        S->>S: Export OTel span + update Prometheus metrics
        S-->>A: result
    else Denied
        S->>S: Export OTel span (blocked)
        S-->>A: error { "Eigent: permission denied" }
    else Approval Required
        S->>R: POST approval request
        S->>S: Poll approval queue
        R-->>S: approved/denied
    end
```

## Deployment Models

### Local Development (Docker Compose)

```bash
docker compose up
```

Starts registry (SQLite), dashboard, sidecar, and demo MCP server on a single machine.

### Team Deployment

```mermaid
graph TB
    subgraph "Shared Server"
        Registry[Registry :3456]
        Dashboard[Dashboard :3000]
        DB[(PostgreSQL)]
    end

    subgraph "Dev Machine 1"
        CLI1[CLI] --> Registry
        Sidecar1[Sidecar] --> Registry
    end

    subgraph "Dev Machine 2"
        CLI2[CLI] --> Registry
        PySdk[Python SDK] --> Registry
        Sidecar2[Sidecar] --> Registry
    end

    Registry --> DB
```

### Production (Kubernetes via Helm)

```bash
helm install eigent deploy/helm/eigent \
  --set registry.replicas=3 \
  --set registry.database.url=postgres://... \
  --set registry.masterKey=... \
  --set registry.oidc.issuer=https://your-idp.com
```

```mermaid
graph TB
    subgraph "Kubernetes Cluster"
        LB[Ingress / Load Balancer]
        R1[Registry Pod 1]
        R2[Registry Pod 2]
        R3[Registry Pod 3]
        Dash[Dashboard Pod]
    end

    subgraph "Data"
        DB[(PostgreSQL)]
    end

    subgraph "Observability"
        OTel[OTel Collector]
        SIEM[Splunk / Datadog]
        Prom[Prometheus]
        Grafana[Grafana]
    end

    LB --> R1
    LB --> R2
    LB --> R3
    LB --> Dash
    R1 --> DB
    R2 --> DB
    R3 --> DB
    OTel --> SIEM
    Prom --> Grafana
```

### Infrastructure as Code (Terraform)

```bash
cd deploy/terraform
terraform init
terraform apply
```

Modules available for AWS, GCP, and Azure.

## Technology Stack

| Component | Language | Framework | Key Dependencies |
|-----------|----------|-----------|------------------|
| Core | TypeScript | -- | jose, zod, uuid |
| Registry | TypeScript | Hono | PostgreSQL adapter, AES-256-GCM |
| Sidecar | TypeScript | -- | MCP SDK, OTLP, prom-client |
| CLI | TypeScript | Commander.js | chalk, ora, inquirer |
| Python SDK | Python | -- | requests, pydantic |
| Scanner | Python | -- | click, rich |
| Dashboard | TypeScript | Next.js | NextAuth, Tailwind, Recharts |
| Helm | YAML | Helm 3 | -- |
| Terraform | HCL | Terraform | -- |
