import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";

import { NdjsonInterceptor, type JsonRpcMessage, type HoldDecision } from "../src/parser.js";
import { TokenValidator, type EigentClaims } from "../src/auth.js";
import { PolicyEnforcer } from "../src/enforcer.js";

/**
 * Create a fake JWT token with the given payload.
 */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "eigent+jwt" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-signature").toString("base64url");
  return `${header}.${body}.${sig}`;
}

function validClaims(scope: string[]): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    jti: "test-jti-123",
    sub: "spiffe://example.com/agent/test-agent",
    iss: "https://registry.example.com",
    aud: "mcp-server",
    iat: nowSec - 60,
    exp: nowSec + 3600,
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
      chain: ["spiffe://example.com/agent/parent"],
      can_delegate: [],
    },
  };
}

describe("Integration: end-to-end enforcement", () => {
  it("blocks unauthorized tool call and returns JSON-RPC error", async () => {
    const token = fakeJwt(validClaims(["read_file", "run_tests"]));
    const validator = new TokenValidator({});
    const enforcer = new PolicyEnforcer("enforce", validator);

    // Validate the token to get claims
    const tokenResult = await validator.validate(token);
    expect(tokenResult.valid).toBe(true);

    const outputChunks: Buffer[] = [];

    // Create a hold-mode interceptor that simulates the enforce pipeline
    const interceptor = new NdjsonInterceptor(
      async (msg: JsonRpcMessage, _raw: string): Promise<HoldDecision> => {
        if ("method" in msg && "id" in msg && msg.method === "tools/call") {
          const params = (msg as { params?: Record<string, unknown> }).params;
          const toolName = typeof params?.["name"] === "string" ? params["name"] : "";

          const decision = enforcer.evaluate(tokenResult.claims, "tools/call", toolName);

          if (decision.action === "deny") {
            const errorResponse = JSON.stringify({
              jsonrpc: "2.0",
              id: (msg as { id: string | number }).id,
              error: {
                code: -32001,
                message: `Eigent: permission denied. ${decision.reason}`,
              },
            });
            return { action: "deny", errorResponse };
          }
        }
        return { action: "allow" };
      },
      { holdMode: true },
    );

    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => outputChunks.push(chunk));

    // Send a tools/call for "delete_file" which is NOT in scope
    const deleteCallMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "delete_file" },
    });

    // Also send an allowed call
    const readCallMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_file" },
    });

    await pipeline(
      async function* () {
        yield Buffer.from(deleteCallMsg + "\n");
        yield Buffer.from(readCallMsg + "\n");
      },
      interceptor,
      sink,
    );

    const output = Buffer.concat(outputChunks).toString();
    const lines = output.trim().split("\n").filter((l) => l.length > 0);

    expect(lines).toHaveLength(2);

    // First line should be the error response for delete_file
    const errorMsg = JSON.parse(lines[0]);
    expect(errorMsg.jsonrpc).toBe("2.0");
    expect(errorMsg.id).toBe(1);
    expect(errorMsg.error).toBeDefined();
    expect(errorMsg.error.code).toBe(-32001);
    expect(errorMsg.error.message).toContain("permission denied");
    expect(errorMsg.error.message).toContain("delete_file");
    expect(errorMsg.error.message).toContain("not in agent scope");
    expect(errorMsg.error.message).toContain("read_file");
    expect(errorMsg.error.message).toContain("run_tests");

    // Second line should be the original allowed message (read_file passes through)
    const allowedMsg = JSON.parse(lines[1]);
    expect(allowedMsg.jsonrpc).toBe("2.0");
    expect(allowedMsg.id).toBe(2);
    expect(allowedMsg.method).toBe("tools/call");
    expect(allowedMsg.params.name).toBe("read_file");
  });

  it("allows all tools with wildcard scope", async () => {
    const token = fakeJwt(validClaims(["*"]));
    const validator = new TokenValidator({});
    const enforcer = new PolicyEnforcer("enforce", validator);

    const tokenResult = await validator.validate(token);
    expect(tokenResult.valid).toBe(true);

    const outputChunks: Buffer[] = [];

    const interceptor = new NdjsonInterceptor(
      async (msg: JsonRpcMessage, _raw: string): Promise<HoldDecision> => {
        if ("method" in msg && "id" in msg && msg.method === "tools/call") {
          const params = (msg as { params?: Record<string, unknown> }).params;
          const toolName = typeof params?.["name"] === "string" ? params["name"] : "";
          const decision = enforcer.evaluate(tokenResult.claims, "tools/call", toolName);
          if (decision.action === "deny") {
            return { action: "deny", errorResponse: "should-not-happen" };
          }
        }
        return { action: "allow" };
      },
      { holdMode: true },
    );

    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => outputChunks.push(chunk));

    const callMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "delete_file" },
    });

    await pipeline(
      async function* () { yield Buffer.from(callMsg + "\n"); },
      interceptor,
      sink,
    );

    const output = Buffer.concat(outputChunks).toString();
    const parsed = JSON.parse(output.trim());
    // Should pass through as-is (allowed)
    expect(parsed.method).toBe("tools/call");
    expect(parsed.params.name).toBe("delete_file");
  });

  it("blocks all tool calls when no token in enforce mode", async () => {
    const validator = new TokenValidator({});
    const enforcer = new PolicyEnforcer("enforce", validator);

    const outputChunks: Buffer[] = [];

    const interceptor = new NdjsonInterceptor(
      async (msg: JsonRpcMessage, _raw: string): Promise<HoldDecision> => {
        if ("method" in msg && "id" in msg && msg.method === "tools/call") {
          const params = (msg as { params?: Record<string, unknown> }).params;
          const toolName = typeof params?.["name"] === "string" ? params["name"] : "";
          // No claims (null) — enforce mode should deny
          const decision = enforcer.evaluate(null, "tools/call", toolName);
          if (decision.action === "deny") {
            const errorResponse = JSON.stringify({
              jsonrpc: "2.0",
              id: (msg as { id: string | number }).id,
              error: { code: -32001, message: `Eigent: permission denied. ${decision.reason}` },
            });
            return { action: "deny", errorResponse };
          }
        }
        return { action: "allow" };
      },
      { holdMode: true },
    );

    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => outputChunks.push(chunk));

    const callMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "read_file" },
    });

    await pipeline(
      async function* () { yield Buffer.from(callMsg + "\n"); },
      interceptor,
      sink,
    );

    const output = Buffer.concat(outputChunks).toString();
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.message).toContain("No eigent token");
  });

  it("allows non-tools/call methods through in enforce mode", async () => {
    const validator = new TokenValidator({});
    const enforcer = new PolicyEnforcer("enforce", validator);

    const outputChunks: Buffer[] = [];

    const interceptor = new NdjsonInterceptor(
      async (msg: JsonRpcMessage, _raw: string): Promise<HoldDecision> => {
        if ("method" in msg && "id" in msg) {
          const params = (msg as { params?: Record<string, unknown> }).params;
          const toolName = typeof params?.["name"] === "string" ? params["name"] : "";
          const decision = enforcer.evaluate(null, (msg as { method: string }).method, toolName);
          if (decision.action === "deny") {
            return { action: "deny" };
          }
        }
        return { action: "allow" };
      },
      { holdMode: true },
    );

    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => outputChunks.push(chunk));

    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    await pipeline(
      async function* () { yield Buffer.from(initMsg + "\n"); },
      interceptor,
      sink,
    );

    const output = Buffer.concat(outputChunks).toString();
    const parsed = JSON.parse(output.trim());
    expect(parsed.method).toBe("initialize");
  });

  it("handles partial messages across chunks in hold mode", async () => {
    const validator = new TokenValidator({});
    const enforcer = new PolicyEnforcer("enforce", validator);

    const token = fakeJwt(validClaims(["read_file"]));
    const tokenResult = await validator.validate(token);

    const outputChunks: Buffer[] = [];

    const interceptor = new NdjsonInterceptor(
      async (msg: JsonRpcMessage, _raw: string): Promise<HoldDecision> => {
        if ("method" in msg && "id" in msg && msg.method === "tools/call") {
          const params = (msg as { params?: Record<string, unknown> }).params;
          const toolName = typeof params?.["name"] === "string" ? params["name"] : "";
          const decision = enforcer.evaluate(tokenResult.claims, "tools/call", toolName);
          if (decision.action === "deny") {
            const errorResponse = JSON.stringify({
              jsonrpc: "2.0",
              id: (msg as { id: string | number }).id,
              error: { code: -32001, message: `Eigent: denied. ${decision.reason}` },
            });
            return { action: "deny", errorResponse };
          }
        }
        return { action: "allow" };
      },
      { holdMode: true },
    );

    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => outputChunks.push(chunk));

    const fullMsg = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file"}}\n';
    const part1 = fullMsg.slice(0, 20);
    const part2 = fullMsg.slice(20);

    await pipeline(
      async function* () {
        yield Buffer.from(part1);
        yield Buffer.from(part2);
      },
      interceptor,
      sink,
    );

    const output = Buffer.concat(outputChunks).toString();
    const parsed = JSON.parse(output.trim());
    // read_file is in scope, should pass through
    expect(parsed.method).toBe("tools/call");
    expect(parsed.params.name).toBe("read_file");
  });

  it("handles malformed JSON gracefully in hold mode", async () => {
    const outputChunks: Buffer[] = [];

    const interceptor = new NdjsonInterceptor(
      async (_msg: JsonRpcMessage, _raw: string): Promise<HoldDecision> => {
        return { action: "allow" };
      },
      { holdMode: true },
    );

    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => outputChunks.push(chunk));

    await pipeline(
      async function* () {
        yield Buffer.from("{bad json}\n");
        yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"test"}\n');
      },
      interceptor,
      sink,
    );

    const output = Buffer.concat(outputChunks).toString();
    const lines = output.trim().split("\n");
    // Both lines should pass through (malformed forwarded as-is, valid forwarded after allow)
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("{bad json}");
    const parsed = JSON.parse(lines[1]);
    expect(parsed.method).toBe("test");
  });
});
