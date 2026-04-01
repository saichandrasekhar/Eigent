# Registry API

The Eigent Registry exposes a REST API for agent lifecycle management, token verification, delegation, and audit log queries. The registry runs on port `3456` by default.

**Base URL:** `http://localhost:3456/api`

## Health Check

Check if the registry is running.

```
GET /api/health
```

=== "curl"

    ```bash
    curl http://localhost:3456/api/health
    ```

=== "Python"

    ```python
    import requests
    r = requests.get("http://localhost:3456/api/health")
    print(r.json())
    ```

=== "TypeScript"

    ```typescript
    const res = await fetch("http://localhost:3456/api/health");
    const data = await res.json();
    ```

**Response:**

```json
{
  "status": "ok",
  "service": "eigent-registry"
}
```

---

## Register Agent

Create a new agent identity with a signed token.

```
POST /api/agents
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
| `metadata` | object | No | Arbitrary metadata |

=== "curl"

    ```bash
    curl -X POST http://localhost:3456/api/agents \
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
    import requests

    r = requests.post("http://localhost:3456/api/agents", json={
        "name": "code-agent",
        "human_sub": "user-abc123",
        "human_email": "alice@company.com",
        "human_iss": "https://accounts.google.com",
        "scope": ["read_file", "write_file", "run_tests"],
        "max_delegation_depth": 3,
        "can_delegate": ["run_tests"],
        "ttl_seconds": 3600,
    })
    print(r.json())
    ```

=== "TypeScript"

    ```typescript
    const res = await fetch("http://localhost:3456/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "code-agent",
        human_sub: "user-abc123",
        human_email: "alice@company.com",
        human_iss: "https://accounts.google.com",
        scope: ["read_file", "write_file", "run_tests"],
        max_delegation_depth: 3,
        can_delegate: ["run_tests"],
        ttl_seconds: 3600,
      }),
    });
    const data = await res.json();
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
POST /api/agents/:parent_id/delegate
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
| `metadata` | object | No | Arbitrary metadata |

=== "curl"

    ```bash
    curl -X POST http://localhost:3456/api/agents/019746a2-.../delegate \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer eyJ..." \
      -d '{
        "child_name": "test-runner",
        "requested_scope": ["run_tests"],
        "ttl_seconds": 1800
      }'
    ```

=== "Python"

    ```python
    r = requests.post(
        f"http://localhost:3456/api/agents/{parent_id}/delegate",
        headers={"Authorization": f"Bearer {parent_token}"},
        json={
            "child_name": "test-runner",
            "requested_scope": ["run_tests"],
            "ttl_seconds": 1800,
        },
    )
    ```

=== "TypeScript"

    ```typescript
    const res = await fetch(
      `http://localhost:3456/api/agents/${parentId}/delegate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${parentToken}`,
        },
        body: JSON.stringify({
          child_name: "test-runner",
          requested_scope: ["run_tests"],
          ttl_seconds: 1800,
        }),
      }
    );
    ```

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

---

## Verify Token

Check if an agent's token authorizes a specific tool call.

```
POST /api/verify
```

### Request Body

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `token` | string | Yes | Agent's signed JWS token |
| `tool_name` | string | Yes | Tool being called |

=== "curl"

    ```bash
    curl -X POST http://localhost:3456/api/verify \
      -H "Content-Type: application/json" \
      -d '{
        "token": "eyJ...",
        "tool_name": "read_file"
      }'
    ```

=== "Python"

    ```python
    r = requests.post("http://localhost:3456/api/verify", json={
        "token": token,
        "tool_name": "read_file",
    })
    ```

=== "TypeScript"

    ```typescript
    const res = await fetch("http://localhost:3456/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, tool_name: "read_file" }),
    });
    ```

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
GET /api/agents/:id
```

=== "curl"

    ```bash
    curl http://localhost:3456/api/agents/019746a2-...
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
  "created_at": "2026-03-31T14:00:00.000Z",
  "expires_at": "2026-03-31T15:00:00.000Z",
  "revoked_at": null,
  "delegation_chain": ["019746a2-..."]
}
```

---

## List Agents

List all agents with optional filters.

```
GET /api/agents
```

### Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `status` | `active` | Filter by status: `active`, `revoked`, or omit for all |
| `human_email` | — | Filter by human email |
| `parent_id` | — | Filter by parent agent ID |

=== "curl"

    ```bash
    # Active agents
    curl http://localhost:3456/api/agents

    # All agents (including revoked)
    curl "http://localhost:3456/api/agents?status="

    # Agents by human
    curl "http://localhost:3456/api/agents?human_email=alice@company.com"
    ```

**Response:**

```json
{
  "agents": [
    {
      "id": "019746a2-...",
      "name": "code-agent",
      "scope": ["read_file", "write_file", "run_tests"],
      "status": "active",
      "delegation_depth": 0,
      "human_email": "alice@company.com"
    }
  ],
  "total": 1
}
```

---

## Get Delegation Chain

Retrieve the full delegation chain for an agent.

```
GET /api/agents/:id/chain
```

=== "curl"

    ```bash
    curl http://localhost:3456/api/agents/019746b1-.../chain
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
DELETE /api/agents/:id
```

=== "curl"

    ```bash
    curl -X DELETE http://localhost:3456/api/agents/019746a2-...
    ```

=== "Python"

    ```python
    r = requests.delete(f"http://localhost:3456/api/agents/{agent_id}")
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

## Query Audit Log

Query the audit trail with filters and pagination.

```
GET /api/audit
```

### Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `agent_id` | — | Filter by agent ID |
| `human_email` | — | Filter by human email |
| `action` | — | Filter by action type |
| `tool_name` | — | Filter by tool name |
| `from_date` | — | Start date (ISO 8601) |
| `to_date` | — | End date (ISO 8601) |
| `limit` | 50 | Maximum entries to return |
| `offset` | 0 | Pagination offset |

=== "curl"

    ```bash
    # Recent blocked calls
    curl "http://localhost:3456/api/audit?action=tool_call_blocked&limit=10"

    # Events by human in date range
    curl "http://localhost:3456/api/audit?\
    human_email=alice@company.com&\
    from_date=2026-03-01&\
    to_date=2026-03-31&\
    limit=100"
    ```

=== "Python"

    ```python
    r = requests.get("http://localhost:3456/api/audit", params={
        "action": "tool_call_blocked",
        "limit": 10,
    })
    ```

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
GET /api/.well-known/jwks.json
```

=== "curl"

    ```bash
    curl http://localhost:3456/api/.well-known/jwks.json
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
