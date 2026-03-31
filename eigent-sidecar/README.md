# agentvault-sidecar

MCP stdio sidecar that intercepts JSON-RPC traffic between MCP clients and servers, producing OpenTelemetry spans for every operation.

Drop it in front of any MCP server command. The MCP client and server see no difference — the sidecar is fully transparent.

## How it works

```
                    agentvault-sidecar
                  ┌─────────────────────┐
 MCP Client      │  stdin ──► parser ──►│──► MCP Server stdin
 (Claude, etc.)  │                      │
                 │◄── parser ◄── stdout │◄── MCP Server stdout
                  └────────┬────────────┘
                           │
                           ▼
                    OTel Collector
                  (OTLP/HTTP spans)
```

The sidecar spawns the real MCP server as a child process, pipes stdin/stdout through NDJSON interceptors, and creates OpenTelemetry spans for:

- `initialize` — server identity and session start
- `tools/call` — tool invocation with name, duration, and error status
- `tools/list` — tool discovery
- `resources/read` — resource access with URI
- All other JSON-RPC requests, responses, and notifications

## Installation

```bash
npm install -g agentvault-sidecar
```

Or install locally:

```bash
npm install
npm run build
```

## Usage

Instead of running your MCP server directly:

```bash
npx @modelcontextprotocol/server-filesystem /tmp
```

Wrap it with the sidecar:

```bash
agentvault-sidecar wrap -- npx @modelcontextprotocol/server-filesystem /tmp
```

### Options

```
agentvault-sidecar wrap [options] <command> [args...]

Options:
  --otel-endpoint <url>   OTel collector endpoint (default: http://localhost:4318)
  --agent-id <id>         Agent identity to attach to all spans
  --verbose               Log intercepted messages to stderr
```

### With a local OTel collector

Start a collector (e.g., Jaeger all-in-one):

```bash
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

Then run:

```bash
agentvault-sidecar wrap \
  --otel-endpoint http://localhost:4318 \
  --agent-id my-agent \
  --verbose \
  -- npx @modelcontextprotocol/server-filesystem /tmp
```

Open http://localhost:16686 to see traces.

## Claude Desktop configuration

In your Claude Desktop config (`claude_desktop_config.json`), replace the server command with the sidecar:

**Before:**

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

**After:**

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "agentvault-sidecar",
      "args": [
        "wrap",
        "--otel-endpoint", "http://localhost:4318",
        "--agent-id", "claude-desktop",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"
      ]
    }
  }
}
```

## Span attributes

The sidecar attaches these attributes to spans, following the [OTel MCP semantic conventions](../otel-mcp-convention/):

| Attribute | Description |
|---|---|
| `rpc.system` | Always `mcp` |
| `rpc.method` | JSON-RPC method (e.g., `tools/call`) |
| `mcp.tool.name` | Tool name for `tools/call` requests |
| `mcp.server.name` | Server name from `initialize` response |
| `mcp.server.version` | Server version from `initialize` response |
| `mcp.session.id` | Unique session ID for this sidecar instance |
| `mcp.resource.uri` | Resource URI for `resources/read` requests |
| `mcp.transport` | Always `stdio` |
| `agentvault.agent.id` | Agent identity (from `--agent-id`) |
| `rpc.jsonrpc.error_code` | JSON-RPC error code (on error) |
| `rpc.jsonrpc.error_message` | JSON-RPC error message (on error) |

## Development

```bash
npm install
npm run build
npm run dev        # watch mode
```

## License

MIT
