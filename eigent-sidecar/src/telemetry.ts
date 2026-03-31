/**
 * OpenTelemetry setup for the Eigent sidecar.
 *
 * Initialises a TracerProvider with an OTLP/HTTP exporter and exposes
 * helpers for creating MCP-attributed spans.
 */

import { trace, context, SpanKind, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

// ── MCP semantic convention attribute keys ─────────────────────────────
// Following the draft OTel MCP semantic conventions from the sibling
// otel-mcp-convention directory.
export const MCP_ATTR = {
  METHOD:      "rpc.method",
  SYSTEM:      "rpc.system",
  TOOL_NAME:   "mcp.tool.name",
  SERVER_NAME: "mcp.server.name",
  SERVER_VERSION: "mcp.server.version",
  SESSION_ID:  "mcp.session.id",
  RESOURCE_URI: "mcp.resource.uri",
  AGENT_ID:    "mcp.agent.id",
  MESSAGE_ID:  "mcp.message.id",
  TRANSPORT:   "mcp.server.transport",
  ERROR_CODE:  "rpc.jsonrpc.error_code",
  ERROR_MESSAGE: "rpc.jsonrpc.error_message",
} as const;

// ── Telemetry manager ──────────────────────────────────────────────────

export interface TelemetryOptions {
  otelEndpoint: string;
  agentId?: string;
  serviceName?: string;
  /** Optional API key sent as an x-api-key header to the OTLP endpoint. */
  otelApiKey?: string;
  /** Whether to use TLS (https) for the OTLP exporter. Default: auto-detect from endpoint URL. */
  otelTls?: boolean;
}

export class TelemetryManager {
  private readonly provider: NodeTracerProvider;
  private readonly tracer: Tracer;
  private readonly sessionId: string;
  private readonly agentId?: string;
  private serverName?: string;
  private serverVersion?: string;
  private shutdownCalled = false;

  constructor(options: TelemetryOptions) {
    const { otelEndpoint, agentId, serviceName = "eigent-sidecar", otelApiKey, otelTls } = options;
    this.agentId = agentId;
    this.sessionId = randomUUID();

    // Build resource
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: "0.1.0",
      [MCP_ATTR.SESSION_ID]: this.sessionId,
      ...(agentId ? { [MCP_ATTR.AGENT_ID]: agentId } : {}),
      "process.pid": process.pid,
      "process.parent_pid": process.ppid,
      "process.executable.name": basename(process.execPath),
    });

    // Build OTLP exporter URL — optionally upgrade to https
    let endpointUrl = otelEndpoint.replace(/\/+$/, "");
    if (otelTls === true && endpointUrl.startsWith("http://")) {
      endpointUrl = endpointUrl.replace(/^http:\/\//, "https://");
    }

    // Optional headers (e.g., API key for authenticated collectors)
    const headers: Record<string, string> = {};
    if (otelApiKey) {
      headers["x-api-key"] = otelApiKey;
    }

    // OTLP/HTTP exporter — sends to /v1/traces by default
    const exporter = new OTLPTraceExporter({
      url: `${endpointUrl}/v1/traces`,
      headers,
    });

    // Provider + processor
    this.provider = new NodeTracerProvider({ resource });
    this.provider.addSpanProcessor(
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 1000,
      }),
    );
    this.provider.register();

    this.tracer = trace.getTracer("eigent-sidecar", "0.1.0");
  }

  /** Update server identity once we see an initialize response. */
  setServerInfo(name?: string, version?: string): void {
    this.serverName = name;
    this.serverVersion = version;
  }

  /**
   * Start a new span for an MCP request (tools/call, resources/read, etc.).
   * Returns the span so the caller can end it when the response arrives.
   */
  startRequestSpan(
    method: string,
    messageId: string | number,
    attributes?: Record<string, string | number | undefined>,
  ): Span {
    const spanName = method;
    const span = this.tracer.startSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: this.buildAttributes(method, messageId, attributes),
      },
      context.active(),
    );
    return span;
  }

  /**
   * Create and immediately end a span (for notifications or one-shot events).
   */
  recordEvent(
    method: string,
    attributes?: Record<string, string | number | undefined>,
  ): void {
    const span = this.tracer.startSpan(method, {
      kind: SpanKind.INTERNAL,
      attributes: this.buildAttributes(method, undefined, attributes),
    });
    span.end();
  }

  /**
   * End a request span with either success or error status.
   */
  endSpan(
    span: Span,
    error?: { code: number; message: string },
  ): void {
    if (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      span.setAttribute(MCP_ATTR.ERROR_CODE, error.code);
      span.setAttribute(MCP_ATTR.ERROR_MESSAGE, error.message);
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  }

  /** Gracefully flush and shut down the tracer provider. */
  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    try {
      await this.provider.forceFlush();
      await this.provider.shutdown();
    } catch {
      // Best-effort shutdown — do not throw
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private buildAttributes(
    method: string,
    messageId?: string | number,
    extra?: Record<string, string | number | undefined>,
  ): Record<string, string | number> {
    const attrs: Record<string, string | number> = {
      [MCP_ATTR.SYSTEM]: "mcp",
      [MCP_ATTR.METHOD]: method,
      [MCP_ATTR.TRANSPORT]: "stdio",
      [MCP_ATTR.SESSION_ID]: this.sessionId,
    };
    if (messageId !== undefined) {
      attrs[MCP_ATTR.MESSAGE_ID] = typeof messageId === "number" ? messageId : String(messageId);
    }
    if (this.serverName) attrs[MCP_ATTR.SERVER_NAME] = this.serverName;
    if (this.serverVersion) attrs[MCP_ATTR.SERVER_VERSION] = this.serverVersion;
    if (this.agentId) attrs[MCP_ATTR.AGENT_ID] = this.agentId;

    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined) attrs[k] = v;
      }
    }
    return attrs;
  }
}
