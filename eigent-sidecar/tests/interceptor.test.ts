import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpInterceptor, type InterceptorOptions } from "../src/interceptor.js";

// We need to access private members for testing, so we use type assertion
type McpInterceptorPrivate = McpInterceptor & {
  pendingSpans: Map<string | number, { span: { end: () => void; setStatus: (s: unknown) => void; setAttribute: (k: string, v: unknown) => void }; method: string; createdAt: number }>;
  requestMethods: Map<string | number, string>;
  telemetry: {
    startRequestSpan: (...args: unknown[]) => unknown;
    endSpan: (...args: unknown[]) => void;
    recordEvent: (...args: unknown[]) => void;
    shutdown: () => Promise<void>;
  };
  handleClientMessage: (msg: unknown) => void;
  handleServerMessage: (msg: unknown) => void;
  reapExpiredSpans: () => void;
  reaperInterval: ReturnType<typeof setInterval> | null;
};

function createOptions(overrides?: Partial<InterceptorOptions>): InterceptorOptions {
  return {
    command: "echo",
    args: ["hello"],
    otelEndpoint: "http://localhost:4318",
    verbose: false,
    ...overrides,
  };
}

describe("McpInterceptor", () => {
  let interceptor: McpInterceptorPrivate;

  beforeEach(() => {
    interceptor = new McpInterceptor(createOptions()) as unknown as McpInterceptorPrivate;
  });

  afterEach(async () => {
    if (interceptor.reaperInterval) {
      clearInterval(interceptor.reaperInterval);
      interceptor.reaperInterval = null;
    }
    try {
      await interceptor.telemetry.shutdown();
    } catch {
      // ignore
    }
  });

  describe("handleClientMessage", () => {
    it("creates a span for a tools/call request", () => {
      const startSpy = vi.spyOn(interceptor.telemetry, "startRequestSpan").mockReturnValue({
        end: vi.fn(),
        setStatus: vi.fn(),
        setAttribute: vi.fn(),
      } as unknown as ReturnType<typeof interceptor.telemetry.startRequestSpan>);

      interceptor.handleClientMessage({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "myTool" },
      });

      expect(startSpy).toHaveBeenCalledWith(
        "tools/call",
        42,
        expect.objectContaining({ "mcp.tool.name": "myTool" }),
      );
      expect(interceptor.pendingSpans.has(42)).toBe(true);
    });
  });

  describe("handleServerMessage", () => {
    it("ends a span when matching response arrives", () => {
      const mockSpan = {
        end: vi.fn(),
        setStatus: vi.fn(),
        setAttribute: vi.fn(),
      };
      const endSpy = vi.spyOn(interceptor.telemetry, "endSpan").mockImplementation(() => {});

      interceptor.pendingSpans.set(42, { span: mockSpan as never, method: "tools/call", createdAt: Date.now() });
      interceptor.requestMethods.set(42, "tools/call");

      interceptor.handleServerMessage({
        jsonrpc: "2.0",
        id: 42,
        result: { ok: true },
      });

      expect(endSpy).toHaveBeenCalledWith(mockSpan);
      expect(interceptor.pendingSpans.has(42)).toBe(false);
    });

    it("ends a span with error for error responses", () => {
      const mockSpan = {
        end: vi.fn(),
        setStatus: vi.fn(),
        setAttribute: vi.fn(),
      };
      const endSpy = vi.spyOn(interceptor.telemetry, "endSpan").mockImplementation(() => {});

      interceptor.pendingSpans.set(7, { span: mockSpan as never, method: "tools/call", createdAt: Date.now() });
      interceptor.requestMethods.set(7, "tools/call");

      interceptor.handleServerMessage({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32600, message: "Invalid Request" },
      });

      expect(endSpy).toHaveBeenCalledWith(mockSpan, {
        code: -32600,
        message: "Invalid Request",
      });
      expect(interceptor.pendingSpans.has(7)).toBe(false);
    });
  });

  describe("reapExpiredSpans", () => {
    it("reaps spans older than 60 seconds", () => {
      const mockSpan = {
        end: vi.fn(),
        setStatus: vi.fn(),
        setAttribute: vi.fn(),
      };
      const endSpy = vi.spyOn(interceptor.telemetry, "endSpan").mockImplementation(() => {});

      // Add a span created 61 seconds ago
      interceptor.pendingSpans.set(99, {
        span: mockSpan as never,
        method: "tools/call",
        createdAt: Date.now() - 61_000,
      });
      interceptor.requestMethods.set(99, "tools/call");

      interceptor.reapExpiredSpans();

      expect(endSpy).toHaveBeenCalledWith(mockSpan, expect.objectContaining({
        code: -1,
        message: expect.stringContaining("timed out"),
      }));
      expect(interceptor.pendingSpans.has(99)).toBe(false);
    });

    it("does not reap spans that are still fresh", () => {
      const mockSpan = {
        end: vi.fn(),
        setStatus: vi.fn(),
        setAttribute: vi.fn(),
      };
      const endSpy = vi.spyOn(interceptor.telemetry, "endSpan").mockImplementation(() => {});

      interceptor.pendingSpans.set(100, {
        span: mockSpan as never,
        method: "tools/call",
        createdAt: Date.now() - 5_000,
      });

      interceptor.reapExpiredSpans();

      expect(endSpy).not.toHaveBeenCalled();
      expect(interceptor.pendingSpans.has(100)).toBe(true);
    });
  });
});
