# eigent-sidecar

MCP interceptor that sits between MCP clients and servers, enforcing Eigent token-based authorization and YAML policy rules on every tool call. Supports stdio and HTTP proxy transports.

## How it works

```
                    eigent-sidecar
                  +---------------------------------+
 MCP Client      |  stdin --> parser --> policy     |--> MCP Server stdin
 (Claude, etc.)  |              |        engine     |
                 |<-- parser <-- stdout             |<-- MCP Server stdout
                  +--------+--------+---------------+
                           |        |
                           v        v
                    OTel Collector  Prometheus
                  (OTLP/HTTP spans) (:9090/metrics)
```

The sidecar intercepts `tools/call` messages and verifies them through three layers:

1. **Token scope check** -- is the tool in the agent's JWS token scope?
2. **YAML policy engine** -- glob patterns, argument regex, time windows, delegation depth limits
3. **Approval queue** -- route sensitive operations for human approval

## Installation

```bash
npm install -g eigent-sidecar
```

Or from source:

```bash
npm install
npm run build
```

## Usage

### stdio mode (default)

Wrap any MCP server command:

```bash
eigent-sidecar \
  --mode enforce \
  --eigent-token-file ~/.eigent/tokens/code-agent.jwt \
  --policy-file ./eigent-policy.yaml \
  -- npx @modelcontextprotocol/server-filesystem /tmp
```

### HTTP proxy mode

Proxy to a remote MCP server:

```bash
eigent-sidecar \
  --transport http \
  --listen-port 8080 \
  --upstream-url http://mcp-server:3000 \
  --eigent-token-file ~/.eigent/tokens/code-agent.jwt \
  --policy-file ./eigent-policy.yaml
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--mode <mode>` | `enforce` | `enforce` or `monitor` |
| `--transport <type>` | `stdio` | `stdio` or `http` |
| `--eigent-token <token>` | -- | Inline token (JWS) |
| `--eigent-token-file <path>` | -- | Path to token file |
| `--registry-url <url>` | `http://localhost:3456` | Registry endpoint |
| `--policy-file <path>` | -- | YAML policy file |
| `--listen-port <port>` | `8080` | HTTP proxy listen port |
| `--upstream-url <url>` | -- | Upstream MCP server URL |
| `--approval-poll-interval <ms>` | `5000` | Approval queue poll interval |
| `--otel-endpoint <url>` | -- | OTel collector endpoint |
| `--otel-service-name <name>` | `eigent-sidecar` | OTel service name |
| `--prometheus-port <port>` | -- | Prometheus metrics port |
| `--verbose` | false | Debug logging |

## YAML Policy Engine

Policies are defined in YAML and hot-reload on file changes:

```yaml
version: "1"

policies:
  - tool: "read_file"
    allow: true
    conditions:
      args:
        path: "^/safe/.*"

  - tool: "write_file"
    allow: true
    conditions:
      time_window:
        start: "09:00"
        end: "18:00"
        timezone: "America/New_York"

  - tool: "deploy_*"
    allow: true
    require_approval: true

  - tool: "shell_exec"
    allow: false

defaults:
  allow: false
```

Features: glob patterns, argument regex, time windows, delegation depth limits, approval routing, hot-reload.

## Claude Desktop configuration

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "eigent-sidecar",
      "args": [
        "--mode", "enforce",
        "--eigent-token-file", "~/.eigent/tokens/code-agent.jwt",
        "--registry-url", "http://localhost:3456",
        "--policy-file", "~/.eigent/policies/filesystem.yaml",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"
      ]
    }
  }
}
```

## Span attributes

| Attribute | Description |
|---|---|
| `rpc.system` | Always `mcp` |
| `rpc.method` | JSON-RPC method (e.g., `tools/call`) |
| `mcp.tool.name` | Tool name |
| `mcp.server.name` | Server name from `initialize` |
| `mcp.session.id` | Session ID |
| `eigent.agent.id` | Agent identity |
| `eigent.agent.name` | Agent name |
| `eigent.human.email` | Authorizing human |
| `eigent.action` | `allowed`, `blocked`, or `approval_pending` |
| `eigent.delegation.depth` | Delegation depth |
| `eigent.scope` | Agent scope |
| `eigent.policy.matched_rule` | Policy rule that matched |
| `eigent.mode` | `enforce` or `monitor` |

## Prometheus metrics

| Metric | Type | Description |
|--------|------|-------------|
| `eigent_tool_calls_total` | counter | Tool calls by tool, action, agent |
| `eigent_tool_call_duration_seconds` | histogram | Tool call latency |
| `eigent_policy_evaluations_total` | counter | Policy evaluations by result |
| `eigent_approval_queue_pending` | gauge | Pending approval requests |

## Development

```bash
npm install
npm run build
npm run dev        # watch mode
npm test
```

## License

Apache 2.0
