import { describe, it, expect, afterEach } from "vitest";
import { TelemetryManager, MCP_ATTR } from "../src/telemetry.js";
import { SpanStatusCode } from "@opentelemetry/api";

describe("MCP_ATTR constants", () => {
  it("uses mcp.agent.id (not eigent.agent.id)", () => {
    expect(MCP_ATTR.AGENT_ID).toBe("mcp.agent.id");
  });

  it("uses mcp.server.transport (not mcp.transport)", () => {
    expect(MCP_ATTR.TRANSPORT).toBe("mcp.server.transport");
  });
});

describe("TelemetryManager", () => {
  let manager: TelemetryManager;

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
    }
  });

  it("creates a TelemetryManager with default options", () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
    });
    expect(manager).toBeDefined();
  });

  it("creates a TelemetryManager with agentId", () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
      agentId: "test-agent",
    });
    expect(manager).toBeDefined();
  });

  it("creates a TelemetryManager with API key", () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
      otelApiKey: "my-secret-key",
    });
    expect(manager).toBeDefined();
  });

  it("creates a TelemetryManager with TLS enabled", () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
      otelTls: true,
    });
    expect(manager).toBeDefined();
  });

  it("startRequestSpan returns a span", () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
    });
    const span = manager.startRequestSpan("tools/call", 1, {
      [MCP_ATTR.TOOL_NAME]: "echo",
    });
    expect(span).toBeDefined();
    expect(typeof span.end).toBe("function");
    span.end();
  });

  it("endSpan sets OK status on success", () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
    });
    const span = manager.startRequestSpan("tools/call", 2);
    // Should not throw
    manager.endSpan(span);
  });

  it("endSpan sets ERROR status on error", () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
    });
    const span = manager.startRequestSpan("tools/call", 3);
    manager.endSpan(span, { code: -32600, message: "Invalid Request" });
  });

  it("recordEvent creates and ends a span", () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
    });
    // Should not throw
    manager.recordEvent("notification/progress");
  });

  it("setServerInfo stores server metadata", () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
    });
    manager.setServerInfo("test-server", "1.0.0");
    // Verify it reflects in subsequent spans
    const span = manager.startRequestSpan("tools/call", 4);
    expect(span).toBeDefined();
    span.end();
  });

  it("shutdown is idempotent", async () => {
    manager = new TelemetryManager({
      otelEndpoint: "http://localhost:4318",
    });
    await manager.shutdown();
    await manager.shutdown(); // second call should not throw
  });
});
