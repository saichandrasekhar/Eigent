# @eigent/registry

The central identity and governance server for the Eigent platform. Built with Hono on Node.js.

## Features

- **OIDC Authentication** -- Okta, Entra ID, and Google identity providers
- **Agent Lifecycle** -- Registration, delegation, cascade revocation, key rotation, expiry, heartbeat
- **SCIM Deprovisioning** -- Automatic agent cleanup when users are removed from your IdP
- **Multi-Tenancy** -- Organization-scoped agent isolation with `POST /api/v1/orgs`
- **Approval Queue** -- Require human approval for sensitive delegations before tokens are issued
- **Compliance Reports** -- Generate EU AI Act and SOC 2 compliance evidence via `GET /api/v1/compliance/report`
- **SIEM Webhooks** -- Push audit events to Splunk, Datadog, PagerDuty, or any HTTP endpoint
- **PostgreSQL Adapter** -- Production-grade storage with AES-256-GCM encryption at rest (SQLite for dev)
- **API Versioning** -- All endpoints under `/api/v1/` with OpenAPI spec
- **Rate Limiting** -- Configurable per-endpoint rate limits
- **Health Checks** -- `GET /api/v1/health` with dependency status

## Quick Start

```bash
# Development (SQLite, no external deps)
npm install
npm run dev    # http://localhost:3456

# Production (PostgreSQL)
DATABASE_URL=postgres://user:pass@host/eigent \
EIGENT_MASTER_KEY=your-256-bit-key \
npm start
```

## Docker

```bash
docker compose up registry
```

Or standalone:

```bash
docker build -t eigent-registry .
docker run -p 3456:3456 \
  -e EIGENT_MASTER_KEY=your-key \
  -e DATABASE_URL=postgres://... \
  eigent-registry
```

## API Endpoints

### Core Identity

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/agents` | Register a new agent with signed token |
| `GET` | `/api/v1/agents` | List agents (filter by status, human, org) |
| `GET` | `/api/v1/agents/:id` | Get agent details |
| `POST` | `/api/v1/agents/:id/delegate` | Delegate to a child agent |
| `DELETE` | `/api/v1/agents/:id` | Revoke agent + cascade to descendants |
| `GET` | `/api/v1/agents/:id/chain` | Get full delegation chain |
| `POST` | `/api/v1/verify` | Verify token against a tool call |
| `GET` | `/api/v1/.well-known/jwks.json` | Public keys for offline verification |

### Lifecycle

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/agents/:id/rotate` | Rotate agent keys, issue new token |
| `POST` | `/api/v1/agents/:id/heartbeat` | Report agent liveness |
| `GET` | `/api/v1/agents/stale` | Find agents with no recent heartbeat |
| `GET` | `/api/v1/agents/expiring` | Find agents expiring within a window |

### Organizations (Multi-Tenancy)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/orgs` | Create an organization |
| `GET` | `/api/v1/orgs` | List organizations |
| `GET` | `/api/v1/orgs/:id` | Get organization details |
| `GET` | `/api/v1/orgs/:id/agents` | List agents in an organization |

### Webhooks (SIEM)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/webhooks` | Register a webhook endpoint |
| `GET` | `/api/v1/webhooks` | List registered webhooks |
| `DELETE` | `/api/v1/webhooks/:id` | Remove a webhook |

### Approval Queue

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/approvals` | List pending approval requests |
| `POST` | `/api/v1/approvals/:id/approve` | Approve a pending delegation |
| `POST` | `/api/v1/approvals/:id/deny` | Deny a pending delegation |

### Compliance

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/compliance/report` | Generate compliance report (EU AI Act, SOC 2) |
| `GET` | `/api/v1/compliance/frameworks` | List supported frameworks |

### Audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/audit` | Query audit log with filters and pagination |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/health` | Health check with dependency status |

### SCIM

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/scim/deprovision` | Deprovision a user and revoke all their agents |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `DATABASE_URL` | `sqlite:///data/eigent.db` | Database connection string |
| `EIGENT_MASTER_KEY` | (required in prod) | AES-256-GCM encryption key for data at rest |
| `OIDC_ISSUER` | — | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | — | OIDC client ID |
| `OIDC_CLIENT_SECRET` | — | OIDC client secret |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |

## Development

```bash
npm install
npm run dev        # Watch mode on :3456
npm test           # Run tests
npm run build      # Build for production
```

## License

Apache 2.0
