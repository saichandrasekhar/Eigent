# Registry API

The Eigent Registry exposes a REST API for agent lifecycle management, token verification, delegation, organization management, approval workflows, compliance reporting, SIEM webhooks, and audit log queries. The registry runs on port `3456` by default.

**Base URL:** `http://localhost:3456/api/v1`

All endpoints are versioned under `/api/v1/`. The registry serves an OpenAPI specification at `/api/v1/openapi.json`.

---

## Health Check

Check if the registry is running and its dependencies are healthy.

```
GET /api/v1/health
```

=== "curl"

    ```bash
    curl http://localhost:3456/api/v1/health
    ```

=== "Python"

    ```python
    import requests
    r = requests.get("http://localhost:3456/api/v1/health")
    print(r.json())
    ```

=== "TypeScript"

    ```typescript
    const res = await fetch("http://localhost:3456/api/v1/health");
    const data = await res.json();
    ```

**Response:**

```json
{
  "status": "ok",
  "service": "eigent-registry",
  "database": "connected",
  "uptime_seconds": 3600
}
```

---

## Register Agent

Create a new agent identity with a signed token.

```
POST /api/v1/agents
```

### Request Body

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `name` | string | Yes | Human-readable agent name (1-255 chars) |
| `human_sub` | string | Yes | Human subject identifier from IdP |
| `human_email` | string | Yes | Human email address |
| `human_iss` | string | Yes | Human IdP issuer URL |
| `scope` | string[] | Yes | Permitted tool names (min 1) |
| `max_delegation_depth` | number | No | Max delegation depth (0-10, default 3) |
| `can_delegate` | string[] | No | Delegatable scopes (default: same as scope) |
| `ttl_seconds` | number | No | Token TTL (60-2592000, default 3600) |
| `org_id` | string | No | Organization ID for multi-tenancy |
| `metadata` | object | No | Arbitrary metadata |

=== "curl"

    ```bash
    curl -X POST http://localhost:3456/api/v1/agents \
      -H "Content-Type: application/json" \
      -d '{
        "name": "code-agent",
        "human_sub": "user-abc123",
        "human_email": "alice@company.com",
        "human_iss": "https://accounts.google.com",
        "scope": ["read_file", "write_file", "run_tests"],
        "max_delegation_depth": 3,
        "can_delegate": ["run_tests"],
        "ttl_seconds": 3600
      }'
    ```

=== "Python"

    ```python
    from eigent import EigentClient

    client = EigentClient(registry_url="http://localhost:3456")
    client.login(email="alice@company.com", demo_mode=True)
    agent = client.register_agent(
        name="code-agent",
        scope=["read_file", "write_file", "run_tests"],
        max_delegation_depth=3,
        can_delegate=["run_tests"],
    )
    ```

**Response (201 Created):**

```json
{
  "agent_id": "019746a2-3f8b-7d4e-a1c5-9b3d2e7f0a1b",
  "token": "eyJhbGciOiJFZERTQSIsInR5cCI6ImVpZ2VudCtqd3QiLCJraWQiOiIuLi4ifQ...",
  "scope": ["read_file", "write_file", "run_tests"],
  "expires_at": "2026-03-31T15:00:00.000Z"
}
```

---

## Delegate to Child Agent

Delegate a subset of permissions from a parent agent to a new child agent.

```
POST /api/v1/agents/:parent_id/delegate
```

### Headers

| Header | Value | Description |
|--------|-------|-------------|
| `Authorization` | `Bearer <parent_token>` | Parent agent's signed token |

### Request Body

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `child_name` | string | Yes | Child agent name |
| `requested_scope` | string[] | Yes | Scopes the child is requesting |
| `ttl_seconds` | number | No | Token TTL (default 3600, capped by parent) |
| `require_approval` | boolean | No | Send to approval queue before issuing |
| `metadata` | object | No | Arbitrary metadata |

**Response (201 Created):**

```json
{
  "child_agent_id": "019746b1-...",
  "token": "eyJ...",
  "granted_scope": ["run_tests"],
  "denied_scope": [],
  "delegation_depth": 1,
  "expires_at": "2026-03-31T14:30:00.000Z"
}
```

**Error Responses:**

| Status | Reason |
|--------|--------|
| 401 | Invalid parent token |
| 403 | Token does not match parent / not active / max depth exceeded / no scopes delegatable |
| 404 | Parent agent not found |
| 202 | Delegation sent to approval queue (when `require_approval: true`) |

---

## Verify Token

Check if an agent's token authorizes a specific tool call.

```
POST /api/v1/verify
```

### Request Body

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `token` | string | Yes | Agent's signed JWS token |
| `tool_name` | string | Yes | Tool being called |

**Response (Allowed):**

```json
{
  "allowed": true,
  "agent_id": "019746a2-...",
  "human_email": "alice@company.com",
  "delegation_chain": ["019746a2-..."],
  "reason": "Tool is within agent scope"
}
```

**Response (Denied):**

```json
{
  "allowed": false,
  "agent_id": "019746a2-...",
  "human_email": "alice@company.com",
  "delegation_chain": ["019746a2-..."],
  "reason": "Tool \"shell_exec\" is not in agent scope: [read_file, write_file]"
}
```

---

## Get Agent

Retrieve details for a specific agent.

```
GET /api/v1/agents/:id
```

**Response:**

```json
{
  "id": "019746a2-...",
  "name": "code-agent",
  "human_sub": "user-abc123",
  "human_email": "alice@company.com",
  "human_iss": "https://accounts.google.com",
  "scope": ["read_file", "write_file", "run_tests"],
  "parent_id": null,
  "delegation_depth": 0,
  "max_delegation_depth": 3,
  "can_delegate": ["run_tests"],
  "status": "active",
  "org_id": "org-123",
  "created_at": "2026-03-31T14:00:00.000Z",
  "expires_at": "2026-03-31T15:00:00.000Z",
  "revoked_at": null,
  "last_heartbeat": "2026-03-31T14:30:00.000Z",
  "delegation_chain": ["019746a2-..."]
}
```

---

## List Agents

List all agents with optional filters.

```
GET /api/v1/agents
```

### Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `status` | `active` | Filter by status: `active`, `revoked`, or omit for all |
| `human_email` | -- | Filter by human email |
| `parent_id` | -- | Filter by parent agent ID |
| `org_id` | -- | Filter by organization |

**Response:**

```json
{
  "agents": [...],
  "total": 5
}
```

---

## Get Delegation Chain

Retrieve the full delegation chain for an agent.

```
GET /api/v1/agents/:id/chain
```

**Response:**

```json
{
  "agent_id": "019746b1-...",
  "chain": [
    {
      "id": "019746a2-...",
      "name": "code-agent",
      "delegation_depth": 0,
      "scope": ["read_file", "write_file", "run_tests"],
      "status": "active",
      "human_email": "alice@company.com",
      "created_at": "2026-03-31T14:00:00.000Z"
    },
    {
      "id": "019746b1-...",
      "name": "test-runner",
      "delegation_depth": 1,
      "scope": ["run_tests"],
      "status": "active",
      "human_email": "alice@company.com",
      "created_at": "2026-03-31T14:00:05.000Z"
    }
  ],
  "depth": 1,
  "root_human_email": "alice@company.com"
}
```

---

## Revoke Agent

Revoke an agent and cascade to all descendants.

```
DELETE /api/v1/agents/:id
```

**Response:**

```json
{
  "revoked_agent_id": "019746a2-...",
  "cascade_revoked": ["019746b1-..."],
  "total_revoked": 2
}
```

| Status | Reason |
|--------|--------|
| 404 | Agent not found |
| 409 | Agent already revoked |

---

## Rotate Agent Keys

Rotate an agent's cryptographic keys and issue a new token. The old token is invalidated.

```
POST /api/v1/agents/:id/rotate
```

**Response:**

```json
{
  "agent_id": "019746a2-...",
  "new_token": "eyJ...",
  "rotated_at": "2026-03-31T15:00:00.000Z"
}
```

---

## Agent Heartbeat

Report that an agent is still alive and active. Used by the stale detection system.

```
POST /api/v1/agents/:id/heartbeat
```

**Response:**

```json
{
  "agent_id": "019746a2-...",
  "last_heartbeat": "2026-03-31T15:00:00.000Z"
}
```

---

## Stale Agents

Find agents that have not sent a heartbeat within a given window.

```
GET /api/v1/agents/stale
```

### Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `threshold_minutes` | `60` | Minutes since last heartbeat to consider stale |

**Response:**

```json
{
  "stale_agents": [...],
  "total": 3
}
```

---

## Expiring Agents

Find agents that will expire within a given window.

```
GET /api/v1/agents/expiring
```

### Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `within_minutes` | `60` | Minutes until expiry |

**Response:**

```json
{
  "expiring_agents": [...],
  "total": 2
}
```

---

## Organizations (Multi-Tenancy)

### Create Organization

```
POST /api/v1/orgs
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `name` | string | Yes | Organization name |
| `domain` | string | No | Email domain for auto-assignment |

**Response (201 Created):**

```json
{
  "org_id": "org-abc123",
  "name": "Acme Corp",
  "created_at": "2026-03-31T14:00:00.000Z"
}
```

### List Organizations

```
GET /api/v1/orgs
```

### Get Organization

```
GET /api/v1/orgs/:id
```

### List Organization Agents

```
GET /api/v1/orgs/:id/agents
```

Returns all agents scoped to a specific organization.

---

## Webhooks (SIEM Integration)

Register HTTP endpoints to receive real-time audit events. Use for Splunk, Datadog, PagerDuty, Slack, or any webhook-compatible system.

### Register Webhook

```
POST /api/v1/webhooks
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `url` | string | Yes | Webhook endpoint URL |
| `events` | string[] | No | Event types to subscribe to (default: all) |
| `secret` | string | No | HMAC secret for signature verification |

**Response (201 Created):**

```json
{
  "webhook_id": "wh-abc123",
  "url": "https://hooks.slack.com/...",
  "events": ["agent.revoked", "tool_call_blocked"],
  "created_at": "2026-03-31T14:00:00.000Z"
}
```

### List Webhooks

```
GET /api/v1/webhooks
```

### Delete Webhook

```
DELETE /api/v1/webhooks/:id
```

---

## Approval Queue

Require human approval for sensitive delegations before tokens are issued.

### List Pending Approvals

```
GET /api/v1/approvals
```

### Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `status` | `pending` | Filter: `pending`, `approved`, `denied` |
| `org_id` | -- | Filter by organization |

**Response:**

```json
{
  "approvals": [
    {
      "id": "apr-abc123",
      "parent_agent_id": "019746a2-...",
      "child_name": "deploy-agent",
      "requested_scope": ["deploy_production"],
      "requested_by": "alice@company.com",
      "status": "pending",
      "created_at": "2026-03-31T14:00:00.000Z"
    }
  ],
  "total": 1
}
```

### Approve

```
POST /api/v1/approvals/:id/approve
```

**Response:**

```json
{
  "approval_id": "apr-abc123",
  "status": "approved",
  "child_agent_id": "019746c1-...",
  "token": "eyJ..."
}
```

### Deny

```
POST /api/v1/approvals/:id/deny
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `reason` | string | No | Reason for denial |

---

## Compliance Reports

Generate compliance evidence mapping agent activity to regulatory frameworks.

### Generate Report

```
GET /api/v1/compliance/report
```

### Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `framework` | `eu-ai-act` | Framework: `eu-ai-act`, `soc2`, `iso27001` |
| `period` | `30d` | Reporting period: `7d`, `30d`, `90d`, `1y` |
| `org_id` | -- | Scope report to an organization |

**Response:**

```json
{
  "framework": "eu-ai-act",
  "period": "30d",
  "generated_at": "2026-03-31T14:00:00.000Z",
  "controls": [
    {
      "article": "Article 14 - Human Oversight",
      "status": "compliant",
      "evidence": [
        "All 47 active agents trace to authenticated humans",
        "3 cascade revocations executed in period"
      ]
    }
  ],
  "summary": {
    "total_controls": 12,
    "compliant": 11,
    "non_compliant": 1,
    "compliance_score": 91.7
  }
}
```

### List Frameworks

```
GET /api/v1/compliance/frameworks
```

---

## SCIM Deprovisioning

Deprovision a user and cascade-revoke all their agents. Integrates with your IdP's SCIM lifecycle events.

```
POST /api/v1/scim/deprovision
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `user_email` | string | Yes | Email of the user being deprovisioned |
| `reason` | string | No | Reason for deprovisioning |

**Response:**

```json
{
  "user_email": "alice@company.com",
  "agents_revoked": 5,
  "cascade_revoked": 12,
  "total_revoked": 17
}
```

---

## Query Audit Log

Query the audit trail with filters and pagination.

```
GET /api/v1/audit
```

### Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `agent_id` | -- | Filter by agent ID |
| `human_email` | -- | Filter by human email |
| `action` | -- | Filter by action type |
| `tool_name` | -- | Filter by tool name |
| `org_id` | -- | Filter by organization |
| `from_date` | -- | Start date (ISO 8601) |
| `to_date` | -- | End date (ISO 8601) |
| `limit` | 50 | Maximum entries to return |
| `offset` | 0 | Pagination offset |

**Response:**

```json
{
  "entries": [
    {
      "id": "019746f3-...",
      "timestamp": "2026-03-31T14:30:01.234Z",
      "agent_id": "019746b1-...",
      "human_email": "alice@company.com",
      "action": "tool_call_blocked",
      "tool_name": "write_file",
      "delegation_chain": ["019746a2-...", "019746b1-..."],
      "details": {
        "reason": "not_in_scope",
        "agent_scope": ["run_tests"]
      }
    }
  ],
  "total": 1,
  "limit": 10,
  "offset": 0
}
```

---

## JWKS Endpoint

Retrieve the registry's public key in JWKS format for offline token verification.

```
GET /api/v1/.well-known/jwks.json
```

**Response:**

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "...",
      "kid": "...",
      "use": "sig",
      "alg": "EdDSA"
    }
  ]
}
```

Use this endpoint to verify Eigent tokens without contacting the registry for each verification. Cache the JWKS and refresh periodically.

---

## Rate Limiting

All endpoints are rate-limited. Default: 100 requests per 60-second window. Configurable via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX` environment variables.

Rate limit headers are included in every response:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 97
X-RateLimit-Reset: 1711900860
```

## Authentication

Endpoints that modify state require a valid session token (obtained via OIDC login) or an agent bearer token. The registry supports Okta, Entra ID, and Google as OIDC providers. Configure via `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` environment variables.
