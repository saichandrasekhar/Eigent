# Semantic Conventions for MCP Metrics

**Status**: [Experimental](https://opentelemetry.io/docs/specs/otel/document-status/)

This document defines metric semantic conventions for Model Context Protocol
(MCP) operations. These metrics enable monitoring of MCP server health,
agent activity, cost tracking, and performance analysis.

All metrics use the `mcp.` namespace prefix.

## Metric: `mcp.tools.call.duration`

<!-- semconv metric.mcp.tools.call.duration -->

This metric measures the duration of MCP tool call operations.

| Name | Instrument Type | Unit | Description |
|---|---|---|---|
| `mcp.tools.call.duration` | Histogram | `ms` | Duration of an MCP `tools/call` round-trip. |

**Bucket boundaries (advisory)**: `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]`

| Attribute | Type | Requirement Level | Description |
|---|---|---|---|
| `mcp.server.name` | string | `Required` | MCP server logical name. |
| `mcp.tool.name` | string | `Required` | Name of the tool invoked. |
| `mcp.tool.is_error` | boolean | `Required` | Whether the tool returned an error. |
| `mcp.server.transport` | string | `Recommended` | Transport mechanism. |
| `mcp.agent.id` | string | `Recommended` | Agent identity. |
| `mcp.agent.model` | string | `Recommended` | LLM model name. |

This metric SHOULD be recorded by the MCP client instrumentation. The value
SHOULD represent the complete round-trip duration from sending the JSON-RPC
request to receiving the response.

### Example

```
Metric {
  name:        "mcp.tools.call.duration"
  type:        Histogram
  unit:        "ms"
  data_points: [
    {
      attributes: {
        mcp.server.name:  "filesystem"
        mcp.tool.name:    "read_file"
        mcp.tool.is_error: false
      }
      sum:   1720.0
      count: 5
      min:   120.0
      max:   580.0
      bucket_counts: [0, 0, 0, 0, 1, 2, 1, 1, 0, 0, 0, 0, 0]
    }
  ]
}
```

<!-- endsemconv -->

---

## Metric: `mcp.tools.call.count`

<!-- semconv metric.mcp.tools.call.count -->

This metric tracks the total number of MCP tool call operations.

| Name | Instrument Type | Unit | Description |
|---|---|---|---|
| `mcp.tools.call.count` | Counter | `{call}` | Total number of MCP `tools/call` requests completed. |

| Attribute | Type | Requirement Level | Description |
|---|---|---|---|
| `mcp.server.name` | string | `Required` | MCP server logical name. |
| `mcp.tool.name` | string | `Required` | Name of the tool invoked. |
| `mcp.tool.is_error` | boolean | `Required` | Whether the tool returned an error. |
| `mcp.server.transport` | string | `Recommended` | Transport mechanism. |
| `mcp.agent.id` | string | `Recommended` | Agent identity. |

This counter increments by 1 for each completed `tools/call` request,
regardless of success or failure. Use the `mcp.tool.is_error` attribute to
filter for successful vs. failed calls.

### Example

```
Metric {
  name:        "mcp.tools.call.count"
  type:        Counter
  unit:        "{call}"
  data_points: [
    {
      attributes: {
        mcp.server.name:   "filesystem"
        mcp.tool.name:     "read_file"
        mcp.tool.is_error: false
      }
      value: 142
    },
    {
      attributes: {
        mcp.server.name:   "filesystem"
        mcp.tool.name:     "write_file"
        mcp.tool.is_error: true
      }
      value: 3
    }
  ]
}
```

<!-- endsemconv -->

---

## Metric: `mcp.tools.call.errors`

<!-- semconv metric.mcp.tools.call.errors -->

This metric tracks the total number of MCP tool call errors. This is a
convenience metric that counts only the error cases, equivalent to filtering
`mcp.tools.call.count` where `mcp.tool.is_error = true`.

| Name | Instrument Type | Unit | Description |
|---|---|---|---|
| `mcp.tools.call.errors` | Counter | `{error}` | Total number of MCP `tools/call` requests that returned an error. |

| Attribute | Type | Requirement Level | Description |
|---|---|---|---|
| `mcp.server.name` | string | `Required` | MCP server logical name. |
| `mcp.tool.name` | string | `Required` | Name of the tool invoked. |
| `mcp.server.transport` | string | `Recommended` | Transport mechanism. |
| `mcp.agent.id` | string | `Recommended` | Agent identity. |
| `error.type` | string | `Recommended` | The type of error (e.g., JSON-RPC error code or exception class). |

This counter increments by 1 for each `tools/call` request where the response
has `isError: true` or where the JSON-RPC response contains an error object.

### Example

```
Metric {
  name:        "mcp.tools.call.errors"
  type:        Counter
  unit:        "{error}"
  data_points: [
    {
      attributes: {
        mcp.server.name: "postgres-mcp"
        mcp.tool.name:   "query_database"
        error.type:      "ToolExecutionError"
      }
      value: 7
    }
  ]
}
```

<!-- endsemconv -->

---

## Metric: `mcp.agents.active`

<!-- semconv metric.mcp.agents.active -->

This metric tracks the number of currently active agents connected to MCP
servers.

| Name | Instrument Type | Unit | Description |
|---|---|---|---|
| `mcp.agents.active` | UpDownCounter (Gauge) | `{agent}` | Number of agents with at least one active MCP session. |

| Attribute | Type | Requirement Level | Description |
|---|---|---|---|
| `mcp.server.name` | string | `Recommended` | MCP server logical name. If set, counts agents connected to this specific server. |
| `mcp.agent.model` | string | `Recommended` | LLM model name. |

This metric is incremented when an agent establishes an MCP session (completes
`initialize`) and decremented when the session is closed.

### Example

```
Metric {
  name:        "mcp.agents.active"
  type:        UpDownCounter
  unit:        "{agent}"
  data_points: [
    {
      attributes: {
        mcp.server.name: "filesystem"
      }
      value: 3
    },
    {
      attributes: {
        mcp.server.name: "postgres-mcp"
      }
      value: 1
    }
  ]
}
```

<!-- endsemconv -->

---

## Metric: `mcp.session.duration`

<!-- semconv metric.mcp.session.duration -->

This metric measures the lifetime of MCP sessions from `initialize` to
transport close.

| Name | Instrument Type | Unit | Description |
|---|---|---|---|
| `mcp.session.duration` | Histogram | `s` | Duration of an MCP session in seconds. |

**Bucket boundaries (advisory)**: `[1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200]`

| Attribute | Type | Requirement Level | Description |
|---|---|---|---|
| `mcp.server.name` | string | `Required` | MCP server logical name. |
| `mcp.server.transport` | string | `Recommended` | Transport mechanism. |
| `mcp.agent.id` | string | `Recommended` | Agent identity. |
| `mcp.auth.method` | string | `Recommended` | Authentication method used. |

This metric SHOULD be recorded when the MCP session ends (transport closes or
explicit shutdown).

### Example

```
Metric {
  name:        "mcp.session.duration"
  type:        Histogram
  unit:        "s"
  data_points: [
    {
      attributes: {
        mcp.server.name:      "filesystem"
        mcp.server.transport: "stdio"
      }
      sum:   3650.0
      count: 8
      min:   12.0
      max:   1800.0
      bucket_counts: [0, 0, 1, 1, 1, 2, 1, 1, 0, 1, 0]
    }
  ]
}
```

<!-- endsemconv -->

---

## Metric: `mcp.cost.tokens.total`

<!-- semconv metric.mcp.cost.tokens.total -->

This metric tracks the cumulative number of tokens consumed across all MCP
operations that involve LLM inference (tool calls wrapping LLMs and
`sampling/createMessage` requests).

| Name | Instrument Type | Unit | Description |
|---|---|---|---|
| `mcp.cost.tokens.total` | Counter | `{token}` | Cumulative token usage across MCP operations. |

| Attribute | Type | Requirement Level | Description |
|---|---|---|---|
| `mcp.server.name` | string | `Required` | MCP server logical name. |
| `mcp.cost.token_type` | string | `Required` | Token direction. One of `input`, `output`. |
| `mcp.agent.model` | string | `Recommended` | LLM model name. |
| `mcp.agent.id` | string | `Recommended` | Agent identity. |
| `mcp.tool.name` | string | `Recommended` | Tool name (if tokens were consumed during a tool call). |

### Example

```
Metric {
  name:        "mcp.cost.tokens.total"
  type:        Counter
  unit:        "{token}"
  data_points: [
    {
      attributes: {
        mcp.server.name:    "code-analysis"
        mcp.cost.token_type: "input"
        mcp.agent.model:    "claude-sonnet-4-20250514"
      }
      value: 245000
    },
    {
      attributes: {
        mcp.server.name:    "code-analysis"
        mcp.cost.token_type: "output"
        mcp.agent.model:    "claude-sonnet-4-20250514"
      }
      value: 82000
    }
  ]
}
```

<!-- endsemconv -->

---

## Metric Instruments Summary

| Metric Name | Instrument | Unit | Description |
|---|---|---|---|
| `mcp.tools.call.duration` | Histogram | `ms` | Tool call latency |
| `mcp.tools.call.count` | Counter | `{call}` | Total tool calls |
| `mcp.tools.call.errors` | Counter | `{error}` | Tool call errors |
| `mcp.agents.active` | UpDownCounter | `{agent}` | Currently active agents |
| `mcp.session.duration` | Histogram | `s` | Session lifetime |
| `mcp.cost.tokens.total` | Counter | `{token}` | Cumulative token usage |

## Relationship to Span Metrics

Implementations that use a span-to-metrics connector (e.g., the OpenTelemetry
Collector `spanmetrics` connector) MAY derive `mcp.tools.call.duration` and
`mcp.tools.call.count` from `mcp.tools.call` spans automatically. When using
this approach, ensure the span attributes listed above are present on the spans
to produce correctly dimensioned metrics.

Dedicated metric instruments are still RECOMMENDED because they can capture
additional dimensions (like `error.type`) that are not always present on spans,
and because they do not require the overhead of full span collection.
