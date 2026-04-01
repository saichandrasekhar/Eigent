/**
 * HTTP/SSE reverse proxy for Streamable HTTP MCP servers.
 *
 * Sits between an MCP client and an upstream HTTP-based MCP server,
 * intercepting JSON-RPC messages for policy enforcement and telemetry
 * -- the same role the stdio interceptor plays, but for HTTP transport.
 */

import { Hono, type Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import type { Span } from "@opentelemetry/api";

import { TelemetryManager, MCP_ATTR } from "./telemetry.js";
import { TokenValidator, type EigentClaims } from "./auth.js";
import { PolicyEnforcer, type EnforcementMode } from "./enforcer.js";
import {
  parseLine,
  type JsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcErrorResponse,
  extractToolName,
  extractResourceUri,
  extractServerInfo,
} from "./parser.js";

// ── Options ────────────────────────────────────────────────────────────

export interface HttpProxyOptions {
  /** Upstream MCP server URL (e.g. "http://localhost:8080"). */
  upstreamUrl: string;
  /** Port to listen on. Default: 3100. */
  port: number;
  /** OTLP endpoint URL. */
  otelEndpoint: string;
  /** Optional agent identity string. */
  agentId?: string;
  /** Optional API key for the OTLP endpoint. */
  otelApiKey?: string;
  /** Whether to force TLS for the OTLP exporter. */
  otelTls?: boolean;
  /** Print intercepted messages to stderr. */
  verbose: boolean;
  /** Enforcement mode: enforce, monitor, or permissive. Default: monitor. */
  mode: EnforcementMode;
  /** Static eigent token (overridden by per-request Authorization header). */
  eigentToken?: string;
  /** Registry URL for token validation and JWKS. */
  registryUrl?: string;
}

// ── Metrics ────────────────────────────────────────────────────────────

interface ProxyMetrics {
  requestsTotal: number;
  requestsBlocked: number;
  requestsForwarded: number;
  requestsErrored: number;
  sseConnectionsTotal: number;
  sseEventsTotal: number;
  latencySum: number;
  latencyCount: number;
}

// ── Proxy ──────────────────────────────────────────────────────────────

export class HttpMcpProxy {
  private readonly app: Hono;
  private server: ServerType | null = null;
  private readonly telemetry: TelemetryManager;
  private readonly validator: TokenValidator;
  private readonly enforcer: PolicyEnforcer;
  private readonly options: HttpProxyOptions;
  private readonly metrics: ProxyMetrics = {
    requestsTotal: 0,
    requestsBlocked: 0,
    requestsForwarded: 0,
    requestsErrored: 0,
    sseConnectionsTotal: 0,
    sseEventsTotal: 0,
    latencySum: 0,
    latencyCount: 0,
  };

  /** In-flight request spans keyed by JSON-RPC message id. */
  private readonly pendingSpans = new Map<
    string | number,
    { span: Span; method: string; createdAt: number }
  >();

  /** Cached claims for the static token. */
  private cachedStaticClaims: EigentClaims | null = null;
  private staticClaimsValidated = false;

  constructor(options: HttpProxyOptions) {
    this.options = options;

    this.telemetry = new TelemetryManager({
      otelEndpoint: options.otelEndpoint,
      agentId: options.agentId,
      otelApiKey: options.otelApiKey,
      otelTls: options.otelTls,
    });

    this.validator = new TokenValidator({
      registryUrl: options.registryUrl,
    });

    this.enforcer = new PolicyEnforcer(options.mode, this.validator);

    this.app = this.buildApp();
  }

  /** Return the Hono app (useful for testing without starting a server). */
  getApp(): Hono {
    return this.app;
  }

  /** Start listening. */
  async start(): Promise<void> {
    const { port } = this.options;
    this.server = serve({ fetch: this.app.fetch, port });
    this.log(`Proxy listening on http://localhost:${port}`);
    this.log(`Upstream: ${this.options.upstreamUrl}`);
    this.log(`Mode: ${this.options.mode}`);
  }

  /** Gracefully shut down. */
  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    // End any in-flight spans
    for (const [id, { span, method }] of this.pendingSpans) {
      this.telemetry.endSpan(span, {
        code: -1,
        message: `Proxy shutting down before response for ${method} (id=${String(id)})`,
      });
    }
    this.pendingSpans.clear();
    await this.telemetry.shutdown();
  }

  // ── App construction ─────────────────────────────────────────────────

  private buildApp(): Hono {
    const app = new Hono();

    // Health check
    app.get("/health", (c) => {
      return c.json({
        status: "ok",
        upstream: this.options.upstreamUrl,
        mode: this.options.mode,
        uptime: process.uptime(),
      });
    });

    // Prometheus-style metrics
    app.get("/metrics", (c) => {
      const m = this.metrics;
      const avgLatency =
        m.latencyCount > 0 ? (m.latencySum / m.latencyCount).toFixed(2) : "0";
      const lines = [
        `# HELP eigent_proxy_requests_total Total requests received`,
        `# TYPE eigent_proxy_requests_total counter`,
        `eigent_proxy_requests_total ${m.requestsTotal}`,
        `# HELP eigent_proxy_requests_blocked Total requests blocked by policy`,
        `# TYPE eigent_proxy_requests_blocked counter`,
        `eigent_proxy_requests_blocked ${m.requestsBlocked}`,
        `# HELP eigent_proxy_requests_forwarded Total requests forwarded to upstream`,
        `# TYPE eigent_proxy_requests_forwarded counter`,
        `eigent_proxy_requests_forwarded ${m.requestsForwarded}`,
        `# HELP eigent_proxy_requests_errored Total requests that errored`,
        `# TYPE eigent_proxy_requests_errored counter`,
        `eigent_proxy_requests_errored ${m.requestsErrored}`,
        `# HELP eigent_proxy_sse_connections_total Total SSE connections`,
        `# TYPE eigent_proxy_sse_connections_total counter`,
        `eigent_proxy_sse_connections_total ${m.sseConnectionsTotal}`,
        `# HELP eigent_proxy_sse_events_total Total SSE events proxied`,
        `# TYPE eigent_proxy_sse_events_total counter`,
        `eigent_proxy_sse_events_total ${m.sseEventsTotal}`,
        `# HELP eigent_proxy_avg_latency_ms Average request latency (ms)`,
        `# TYPE eigent_proxy_avg_latency_ms gauge`,
        `eigent_proxy_avg_latency_ms ${avgLatency}`,
      ];
      return c.text(lines.join("\n") + "\n", 200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      });
    });

    // POST /mcp — main JSON-RPC endpoint
    app.post("/mcp", async (c) => {
      const startTime = Date.now();
      this.metrics.requestsTotal++;

      let body: string;
      try {
        body = await c.req.text();
      } catch {
        this.metrics.requestsErrored++;
        return c.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          400,
        );
      }

      // Parse JSON-RPC message
      const msg = parseLine(body);
      if (!msg) {
        this.metrics.requestsErrored++;
        return c.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC" } },
          400,
        );
      }

      // Extract session id for audit correlation
      const sessionId = c.req.header("Mcp-Session-Id");

      // If it's a tools/call request, enforce policy
      if (isJsonRpcRequest(msg) && msg.method === "tools/call") {
        const toolName = extractToolName(msg);
        if (toolName) {
          const token = this.extractToken(c.req.header("Authorization"), c.req.header("X-Eigent-Token"));
          const claims = await this.resolveClaimsFromToken(token);
          const decision = this.enforcer.evaluate(claims, msg.method, toolName);

          // Create span attributes
          const attrs: Record<string, string | number | undefined> = {
            [MCP_ATTR.TOOL_NAME]: toolName,
            [MCP_ATTR.EIGENT_DECISION]: decision.action,
            [MCP_ATTR.TRANSPORT]: "http",
          };
          if (sessionId) attrs[MCP_ATTR.SESSION_ID] = sessionId;
          if (claims) {
            attrs[MCP_ATTR.EIGENT_AGENT_ID] = claims.agent.name;
            attrs[MCP_ATTR.EIGENT_HUMAN_EMAIL] = claims.human.email;
            attrs[MCP_ATTR.EIGENT_DELEGATION_DEPTH] = claims.delegation.depth;
            attrs[MCP_ATTR.EIGENT_DELEGATION_CHAIN] = claims.delegation.chain.join(" -> ");
          }

          if (decision.action === "deny") {
            // Blocked — create and close span, return error
            const span = this.telemetry.startRequestSpan(msg.method, msg.id, attrs);
            this.telemetry.endSpan(span, {
              code: -32001,
              message: `Eigent: permission denied. ${decision.reason}`,
            });
            this.metrics.requestsBlocked++;
            this.recordLatency(startTime);
            this.log(`[enforce] DENIED: ${decision.reason}`);

            return c.json(
              {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: -32001,
                  message: `Eigent: permission denied. ${decision.reason}`,
                },
              },
              200,
            );
          }

          if (decision.action === "log_only") {
            this.log(`[monitor] ${decision.reason}`);
          }

          // Start a span that we close once upstream responds
          const span = this.telemetry.startRequestSpan(msg.method, msg.id, attrs);
          this.pendingSpans.set(msg.id, { span, method: msg.method, createdAt: Date.now() });
        }
      } else if (isJsonRpcRequest(msg)) {
        // Non-tool-call request — still trace it
        const attrs: Record<string, string | number | undefined> = {
          [MCP_ATTR.TRANSPORT]: "http",
        };
        if (sessionId) attrs[MCP_ATTR.SESSION_ID] = sessionId;

        if (msg.method === "resources/read") {
          const uri = extractResourceUri(msg);
          if (uri) attrs[MCP_ATTR.RESOURCE_URI] = uri;
        }

        const span = this.telemetry.startRequestSpan(msg.method, msg.id, attrs);
        this.pendingSpans.set(msg.id, { span, method: msg.method, createdAt: Date.now() });
      }

      // Forward to upstream
      return this.forwardPost(c, body, msg, sessionId, startTime);
    });

    // GET /mcp — SSE stream
    app.get("/mcp", async (c) => {
      this.metrics.sseConnectionsTotal++;
      const sessionId = c.req.header("Mcp-Session-Id");

      return this.forwardSSE(c, sessionId);
    });

    // DELETE /mcp — session termination
    app.delete("/mcp", async (c) => {
      const sessionId = c.req.header("Mcp-Session-Id");
      if (sessionId) {
        this.log(`Session terminated: ${sessionId}`);
        this.telemetry.recordEvent("session/delete", {
          [MCP_ATTR.SESSION_ID]: sessionId,
          [MCP_ATTR.TRANSPORT]: "http",
        });
      }

      return this.forwardSimple(c, "DELETE");
    });

    return app;
  }

  // ── Forwarding helpers ───────────────────────────────────────────────

  /**
   * Forward a POST request body to upstream MCP server, inspect the response,
   * and return it to the client. Handles both JSON and SSE responses.
   */
  private async forwardPost(
    c: Context,
    body: string,
    msg: JsonRpcMessage,
    sessionId: string | undefined,
    startTime: number,
  ): Promise<Response> {
    const upstreamUrl = `${this.options.upstreamUrl.replace(/\/+$/, "")}/mcp`;

    // Build headers to forward
    const forwardHeaders = this.buildUpstreamHeaders(c.req.raw.headers, body);

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: "POST",
        headers: forwardHeaders,
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      this.metrics.requestsErrored++;
      this.recordLatency(startTime);
      this.endPendingSpan(msg, { code: -32000, message: `Upstream error: ${err instanceof Error ? err.message : String(err)}` });
      return c.json(
        {
          jsonrpc: "2.0",
          id: isJsonRpcRequest(msg) ? msg.id : null,
          error: { code: -32000, message: "Upstream MCP server unreachable" },
        },
        502,
      );
    }

    const contentType = upstreamRes.headers.get("Content-Type") ?? "";

    // SSE response to a POST (Streamable HTTP pattern)
    if (contentType.includes("text/event-stream")) {
      this.metrics.requestsForwarded++;
      this.recordLatency(startTime);

      return this.streamSSEResponse(c, upstreamRes, sessionId);
    }

    // Regular JSON response
    const responseBody = await upstreamRes.text();
    this.metrics.requestsForwarded++;
    this.recordLatency(startTime);

    // Inspect the upstream response for telemetry
    const responseMsg = parseLine(responseBody);
    if (responseMsg) {
      this.handleUpstreamResponse(responseMsg);
    }

    // Build response headers, pass through Mcp-Session-Id
    const responseHeaders: Record<string, string> = {
      "Content-Type": contentType || "application/json",
    };
    const upstreamSessionId = upstreamRes.headers.get("Mcp-Session-Id");
    if (upstreamSessionId) {
      responseHeaders["Mcp-Session-Id"] = upstreamSessionId;
    }

    return c.newResponse(responseBody, upstreamRes.status as 200, responseHeaders);
  }

  /**
   * Forward a GET /mcp request as an SSE stream from upstream.
   */
  private async forwardSSE(
    c: Context,
    sessionId: string | undefined,
  ): Promise<Response> {
    const upstreamUrl = `${this.options.upstreamUrl.replace(/\/+$/, "")}/mcp`;

    const forwardHeaders = this.buildUpstreamHeaders(c.req.raw.headers);

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: "GET",
        headers: forwardHeaders,
      });
    } catch {
      return c.newResponse("Upstream MCP server unreachable", { status: 502 });
    }

    if (!upstreamRes.body) {
      return c.newResponse("No SSE stream from upstream", { status: 502 });
    }

    return this.streamSSEResponse(c, upstreamRes, sessionId);
  }

  /**
   * Stream an SSE response through the proxy, inspecting each event for telemetry.
   */
  private streamSSEResponse(
    c: Context,
    upstreamRes: Response,
    sessionId: string | undefined,
  ): Response {
    const body = upstreamRes.body;
    if (!body) {
      return c.newResponse("No body from upstream", { status: 502 });
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    const self = this;

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          controller.enqueue(value);

          // Parse SSE events for telemetry
          sseBuffer += text;
          const events = sseBuffer.split("\n\n");
          // Keep the last incomplete chunk in the buffer
          sseBuffer = events.pop() ?? "";

          for (const event of events) {
            self.inspectSSEEvent(event, sessionId);
          }
        } catch {
          controller.close();
        }
      },
      cancel() {
        reader.cancel().catch(() => { /* ignore */ });
      },
    });

    // Forward headers from upstream
    const responseHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    };
    const upstreamSessionId = upstreamRes.headers.get("Mcp-Session-Id");
    if (upstreamSessionId) {
      responseHeaders["Mcp-Session-Id"] = upstreamSessionId;
    }

    return c.newResponse(stream, {
      status: 200,
      headers: responseHeaders,
    });
  }

  /**
   * Forward a simple request (DELETE) to upstream.
   */
  private async forwardSimple(
    c: Context,
    method: string,
  ): Promise<Response> {
    const upstreamUrl = `${this.options.upstreamUrl.replace(/\/+$/, "")}/mcp`;
    const forwardHeaders = this.buildUpstreamHeaders(c.req.raw.headers);

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method,
        headers: forwardHeaders,
        signal: AbortSignal.timeout(30_000),
      });
      const responseBody = await upstreamRes.text();

      const responseHeaders: Record<string, string> = {};
      const ct = upstreamRes.headers.get("Content-Type");
      if (ct) responseHeaders["Content-Type"] = ct;

      return c.newResponse(responseBody, upstreamRes.status as 200, responseHeaders);
    } catch {
      return c.newResponse("Upstream MCP server unreachable", 502 as 502);
    }
  }

  // ── Header management ────────────────────────────────────────────────

  /**
   * Build headers to send to the upstream MCP server.
   * Passes through relevant headers, strips proxy-specific ones.
   */
  private buildUpstreamHeaders(
    incomingHeaders: Headers,
    body?: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {};

    // Pass through standard headers
    const passthrough = [
      "Content-Type",
      "Accept",
      "Authorization",
      "Mcp-Session-Id",
    ];

    for (const name of passthrough) {
      const value = incomingHeaders.get(name);
      if (value) headers[name] = value;
    }

    // Default content type for POST
    if (body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    // Default accept for GET (SSE)
    if (!body && !headers["Accept"]) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // ── Token extraction ─────────────────────────────────────────────────

  /**
   * Extract eigent token from request headers.
   * Priority: X-Eigent-Token header > Bearer token from Authorization header > static token from CLI.
   */
  private extractToken(
    authHeader: string | undefined,
    eigentHeader: string | undefined,
  ): string | undefined {
    if (eigentHeader) return eigentHeader;
    if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
    return this.options.eigentToken ?? process.env["EIGENT_TOKEN"];
  }

  /**
   * Resolve claims from a token string.
   * Caches the result for the static token.
   */
  private async resolveClaimsFromToken(
    token: string | undefined,
  ): Promise<EigentClaims | null> {
    if (!token) return null;

    // If this is the static token, use cached result
    const staticToken = this.options.eigentToken ?? process.env["EIGENT_TOKEN"];
    if (token === staticToken) {
      if (this.staticClaimsValidated) return this.cachedStaticClaims;

      const result = await this.validator.validate(token);
      this.staticClaimsValidated = true;
      this.cachedStaticClaims = result.valid ? result.claims : null;
      if (!result.valid) {
        this.log(`Static token validation failed: ${result.reason ?? "unknown"}`);
      }
      return this.cachedStaticClaims;
    }

    // Per-request token — validate each time
    const result = await this.validator.validate(token);
    if (!result.valid) {
      this.log(`Token validation failed: ${result.reason ?? "unknown"}`);
      return null;
    }
    return result.claims;
  }

  // ── Response handling ────────────────────────────────────────────────

  /**
   * Handle an upstream JSON response: close pending spans, capture server info.
   */
  private handleUpstreamResponse(msg: JsonRpcMessage): void {
    if (!isJsonRpcResponse(msg)) return;

    const pending = this.pendingSpans.get(msg.id);
    if (!pending) return;

    const { span, method } = pending;

    // Capture server info from initialize response
    if (method === "initialize" && "result" in msg) {
      const info = extractServerInfo(msg.result);
      if (info) {
        this.telemetry.setServerInfo(info.name, info.version);
        if (info.name) span.setAttribute(MCP_ATTR.SERVER_NAME, info.name);
        if (info.version) span.setAttribute(MCP_ATTR.SERVER_VERSION, info.version);
      }
    }

    if (isJsonRpcErrorResponse(msg)) {
      this.telemetry.endSpan(span, {
        code: msg.error.code,
        message: msg.error.message,
      });
    } else {
      this.telemetry.endSpan(span);
    }

    this.pendingSpans.delete(msg.id);
  }

  /**
   * End a pending span for a message that errored before reaching upstream.
   */
  private endPendingSpan(
    msg: JsonRpcMessage,
    error: { code: number; message: string },
  ): void {
    if (!isJsonRpcRequest(msg)) return;
    const pending = this.pendingSpans.get(msg.id);
    if (pending) {
      this.telemetry.endSpan(pending.span, error);
      this.pendingSpans.delete(msg.id);
    }
  }

  // ── SSE inspection ───────────────────────────────────────────────────

  /**
   * Inspect an SSE event for telemetry purposes.
   * Parses `event: message\ndata: {...}` blocks.
   */
  private inspectSSEEvent(
    event: string,
    sessionId: string | undefined,
  ): void {
    this.metrics.sseEventsTotal++;

    // Extract data lines
    const lines = event.split("\n");
    let data = "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        data += line.slice(6);
      }
    }

    if (!data) return;

    const msg = parseLine(data);
    if (!msg) return;

    if (this.options.verbose) {
      this.log(`[sse] ${data.trim()}`);
    }

    // Handle JSON-RPC messages from the SSE stream
    if (isJsonRpcResponse(msg)) {
      this.handleUpstreamResponse(msg);
    } else if (isJsonRpcRequest(msg)) {
      // Server-initiated request over SSE (e.g., sampling)
      const attrs: Record<string, string | number | undefined> = {
        [MCP_ATTR.TRANSPORT]: "http-sse",
      };
      if (sessionId) attrs[MCP_ATTR.SESSION_ID] = sessionId;

      this.telemetry.recordEvent(`server-request/${msg.method}`, attrs);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private recordLatency(startTime: number): void {
    const elapsed = Date.now() - startTime;
    this.metrics.latencySum += elapsed;
    this.metrics.latencyCount++;
  }

  private log(message: string): void {
    process.stderr.write(`[eigent-proxy] ${message}\n`);
  }
}
