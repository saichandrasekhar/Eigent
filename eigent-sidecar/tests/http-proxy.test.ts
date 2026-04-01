import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { HttpMcpProxy } from "../src/http-proxy.js";
import type { EigentClaims } from "../src/auth.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a valid JWT-shaped token string from claims (no real signature). */
function makeToken(claims: EigentClaims): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = "fake-sig";
  return `${header}.${payload}.${signature}`;
}

function makeClaims(scope: string[], overrides?: Partial<EigentClaims>): EigentClaims {
  return {
    jti: "test-jti",
    sub: "spiffe://example.com/agent/test-agent",
    iss: "https://registry.example.com",
    aud: "mcp-server",
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
    human: {
      sub: "user-123",
      email: "alice@example.com",
      iss: "https://idp.example.com",
      groups: ["developers"],
    },
    agent: {
      name: "test-agent",
      model: "gpt-4",
    },
    scope,
    delegation: {
      depth: 0,
      max_depth: 2,
      chain: [],
      can_delegate: [],
    },
    ...overrides,
  };
}

// ── Mock upstream MCP server ─────────────────────────────────────────────

let mockUpstream: ServerType;
let mockUpstreamPort: number;
/** Tracks requests received by the mock upstream. */
let upstreamRequests: Array<{ method: string; body: string; headers: Record<string, string> }>;

function createMockUpstream(): Hono {
  const app = new Hono();

  app.post("/mcp", async (c) => {
    const body = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });
    upstreamRequests.push({ method: "POST", body, headers });

    const parsed = JSON.parse(body);

    // Simulate MCP server responses
    if (parsed.method === "initialize") {
      return c.json({
        jsonrpc: "2.0",
        id: parsed.id,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "test-mcp-server", version: "1.0.0" },
          capabilities: {},
        },
      });
    }

    if (parsed.method === "tools/call") {
      return c.json({
        jsonrpc: "2.0",
        id: parsed.id,
        result: {
          content: [{ type: "text", text: "tool result" }],
        },
      });
    }

    if (parsed.method === "tools/list") {
      return c.json({
        jsonrpc: "2.0",
        id: parsed.id,
        result: {
          tools: [{ name: "read_file", description: "Read a file" }],
        },
      });
    }

    // Default echo response
    return c.json({
      jsonrpc: "2.0",
      id: parsed.id,
      result: { echo: parsed.method },
    });
  });

  app.get("/mcp", (c) => {
    // Simulate SSE stream
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t1", progress: 50 } })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "done" }] } })}\n\n`,
          ),
        );
        controller.close();
      },
    });

    return c.newResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  app.delete("/mcp", (c) => {
    return c.text("OK", 200);
  });

  return app;
}

// ── Test setup ───────────────────────────────────────────────────────────

// Use a dynamic port range to avoid collisions
let proxyPort = 13100;

beforeAll(async () => {
  upstreamRequests = [];
  const app = createMockUpstream();
  mockUpstreamPort = 18080;
  mockUpstream = serve({ fetch: app.fetch, port: mockUpstreamPort });
});

afterAll(async () => {
  mockUpstream?.close();
});

beforeEach(() => {
  upstreamRequests = [];
});

function createProxy(
  overrides?: Partial<{
    upstreamUrl: string;
    port: number;
    otelEndpoint: string;
    verbose: boolean;
    mode: "enforce" | "monitor" | "permissive";
    eigentToken: string;
  }>,
): HttpMcpProxy {
  const port = proxyPort++;
  return new HttpMcpProxy({
    upstreamUrl: `http://localhost:${mockUpstreamPort}`,
    port,
    otelEndpoint: "http://localhost:4318",
    verbose: false,
    mode: "monitor",
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("HttpMcpProxy", () => {
  describe("health endpoint", () => {
    it("returns health status", async () => {
      const proxy = createProxy();
      const app = proxy.getApp();

      const res = await app.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.upstream).toContain("localhost");
      expect(body.mode).toBe("monitor");

      await proxy.stop();
    });
  });

  describe("metrics endpoint", () => {
    it("returns prometheus-format metrics", async () => {
      const proxy = createProxy();
      const app = proxy.getApp();

      const res = await app.request("/metrics");
      expect(res.status).toBe(200);

      const text = await res.text();
      expect(text).toContain("eigent_proxy_requests_total");
      expect(text).toContain("eigent_proxy_requests_blocked");
      expect(text).toContain("eigent_proxy_requests_forwarded");
      expect(text).toContain("eigent_proxy_sse_connections_total");
      expect(text).toContain("eigent_proxy_avg_latency_ms");

      await proxy.stop();
    });
  });

  describe("POST /mcp forwarding", () => {
    it("forwards valid JSON-RPC requests to upstream", async () => {
      const proxy = createProxy();
      const app = proxy.getApp();

      const jsonRpcBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });

      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonRpcBody,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);
      expect(body.result.tools).toBeDefined();

      // Verify upstream received the request
      expect(upstreamRequests.length).toBe(1);
      expect(upstreamRequests[0].body).toBe(jsonRpcBody);

      await proxy.stop();
    });

    it("forwards initialize request and gets server info", async () => {
      const proxy = createProxy();
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            clientInfo: { name: "test-client", version: "1.0.0" },
            capabilities: {},
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.serverInfo.name).toBe("test-mcp-server");

      await proxy.stop();
    });

    it("returns parse error for invalid body", async () => {
      const proxy = createProxy();
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json at all {{{",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32700);

      await proxy.stop();
    });
  });

  describe("session header forwarding", () => {
    it("passes Mcp-Session-Id header to upstream", async () => {
      const proxy = createProxy();
      const app = proxy.getApp();

      await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "sess-abc-123",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });

      expect(upstreamRequests.length).toBe(1);
      expect(upstreamRequests[0].headers["mcp-session-id"]).toBe("sess-abc-123");

      await proxy.stop();
    });
  });

  describe("policy enforcement (enforce mode)", () => {
    it("blocks unauthorized tool calls", async () => {
      const claims = makeClaims(["read_file"]);
      const token = makeToken(claims);

      const proxy = createProxy({ mode: "enforce", eigentToken: token });
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eigent-Token": token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "delete_file", arguments: { path: "/etc/passwd" } },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toContain("permission denied");
      expect(body.id).toBe(42);

      // Verify the request was NOT forwarded to upstream
      expect(upstreamRequests.length).toBe(0);

      await proxy.stop();
    });

    it("allows authorized tool calls", async () => {
      const claims = makeClaims(["read_file"]);
      const token = makeToken(claims);

      const proxy = createProxy({ mode: "enforce", eigentToken: token });
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eigent-Token": token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_file", arguments: { path: "/tmp/test" } },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();
      expect(body.error).toBeUndefined();

      // Verify the request WAS forwarded
      expect(upstreamRequests.length).toBe(1);

      await proxy.stop();
    });

    it("denies tool calls with no token in enforce mode", async () => {
      const proxy = createProxy({ mode: "enforce" });
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_file", arguments: {} },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32001);

      expect(upstreamRequests.length).toBe(0);

      await proxy.stop();
    });

    it("extracts token from Authorization Bearer header", async () => {
      const claims = makeClaims(["read_file"]);
      const token = makeToken(claims);

      const proxy = createProxy({ mode: "enforce" });
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_file", arguments: {} },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();
      expect(body.error).toBeUndefined();

      await proxy.stop();
    });

    it("allows wildcard scope", async () => {
      const claims = makeClaims(["*"]);
      const token = makeToken(claims);

      const proxy = createProxy({ mode: "enforce", eigentToken: token });
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eigent-Token": token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "any_tool_at_all", arguments: {} },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();

      await proxy.stop();
    });
  });

  describe("monitor mode", () => {
    it("forwards tool calls even when not in scope (logs only)", async () => {
      const claims = makeClaims(["read_file"]);
      const token = makeToken(claims);

      const proxy = createProxy({ mode: "monitor", eigentToken: token });
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eigent-Token": token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "delete_file", arguments: {} },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // In monitor mode, request should be forwarded (not blocked)
      expect(body.result).toBeDefined();
      expect(upstreamRequests.length).toBe(1);

      await proxy.stop();
    });
  });

  describe("GET /mcp — SSE passthrough", () => {
    it("streams SSE events from upstream", async () => {
      const proxy = createProxy();
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      const text = await res.text();
      expect(text).toContain("event: message");
      expect(text).toContain("notifications/progress");

      await proxy.stop();
    });
  });

  describe("DELETE /mcp — session termination", () => {
    it("forwards DELETE to upstream", async () => {
      const proxy = createProxy();
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "DELETE",
        headers: { "Mcp-Session-Id": "sess-to-delete" },
      });

      expect(res.status).toBe(200);

      await proxy.stop();
    });
  });

  describe("upstream error handling", () => {
    it("returns 502 when upstream is unreachable", async () => {
      const proxy = new HttpMcpProxy({
        upstreamUrl: "http://localhost:19999", // nothing listening here
        port: proxyPort++,
        otelEndpoint: "http://localhost:4318",
        verbose: false,
        mode: "monitor",
      });
      const app = proxy.getApp();

      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.message).toContain("unreachable");

      await proxy.stop();
    });
  });
});
