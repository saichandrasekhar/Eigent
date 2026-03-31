# Semantic Conventions for Model Context Protocol (MCP)

**Status**: [Experimental](https://opentelemetry.io/docs/specs/otel/document-status/)

This document defines semantic conventions for instrumenting interactions with
[Model Context Protocol (MCP)](https://spec.modelcontextprotocol.io/) servers.

## Motivation

The Model Context Protocol (MCP), published by Anthropic, is an open standard
that defines how AI agents and applications connect to external tools,
resources, and prompts. As MCP adoption grows across the AI ecosystem, the
observability community needs a standard way to trace, measure, and monitor
these interactions.

Today, MCP client and server implementations produce telemetry using ad-hoc
attribute names, inconsistent span structures, and incompatible metric
definitions. This fragmentation makes it difficult to:

- Correlate an agent's tool call with the downstream operations the MCP server
  performs.
- Build vendor-neutral dashboards for MCP server health and performance.
- Trace multi-hop delegation chains where one agent calls another agent's MCP
  server.
- Attribute cost (tokens, compute, dollars) to specific tool invocations.

These semantic conventions address the gap by providing a single, agreed-upon
schema for MCP telemetry that any instrumentation library can implement.

## Scope

These conventions cover:

| Document | Description |
|---|---|
| [Span Conventions](mcp-spans.md) | Span names, kinds, and attributes for each MCP operation |
| [Attribute Registry](mcp-attributes.md) | Canonical attribute definitions in YAML schema format |
| [Metric Conventions](mcp-metrics.md) | Histogram, counter, and gauge definitions for MCP workloads |

## MCP Protocol Overview

MCP uses [JSON-RPC 2.0](https://www.jsonrpc.org/specification) as its wire
format. A typical interaction looks like this:

```
┌────────┐                    ┌────────────┐
│  Agent  │──initialize──────>│ MCP Server │
│ (Client)│<─result───────────│            │
│         │──tools/list──────>│            │
│         │<─result───────────│            │
│         │──tools/call──────>│            │
│         │<─result───────────│            │
│         │──resources/read──>│            │
│         │<─result───────────│            │
└────────┘                    └────────────┘
```

Transports include `stdio` (subprocess), `streamable-http`, and the legacy
`sse` (Server-Sent Events) transport. The protocol is stateful: a session
begins with `initialize` and persists until the transport is closed.

## Relationship to Other Semantic Conventions

These conventions build on and reference:

- [General RPC conventions](https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/) --
  MCP is an RPC protocol; these conventions specialize the general RPC
  attributes for MCP's domain-specific semantics.
- [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) --
  MCP is frequently invoked by LLM-powered agents. Attributes like
  `gen_ai.system`, `gen_ai.request.model`, and token-count attributes from the
  GenAI conventions can appear alongside MCP attributes on the same trace.
- [HTTP semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/) --
  When the transport is `streamable-http` or `sse`, the underlying HTTP spans
  carry standard HTTP attributes. MCP spans are typically parents or siblings
  of these HTTP spans.

## References

- [MCP Specification (latest)](https://spec.modelcontextprotocol.io/)
- [MCP GitHub Organization](https://github.com/modelcontextprotocol)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OTEP Template](https://github.com/open-telemetry/oteps/blob/main/0000-template.md)
