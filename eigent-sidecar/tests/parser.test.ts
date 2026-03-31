import { describe, it, expect, vi } from "vitest";
import { NdjsonInterceptor, parseLine, type JsonRpcMessage } from "../src/parser.js";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";

// ── parseLine ────────────────────────────────────────────────────────────

describe("parseLine", () => {
  it("parses a valid JSON-RPC request", () => {
    const msg = parseLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo"}}');
    expect(msg).not.toBeNull();
    expect((msg as JsonRpcMessage & { method: string }).method).toBe("tools/call");
  });

  it("parses a valid JSON-RPC response", () => {
    const msg = parseLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(msg).not.toBeNull();
    expect((msg as Record<string, unknown>)["result"]).toEqual({ ok: true });
  });

  it("returns null for empty lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("\t")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseLine("{not json}")).toBeNull();
    expect(parseLine("hello world")).toBeNull();
    expect(parseLine("{")).toBeNull();
  });

  it("returns null for non-JSON-RPC objects", () => {
    expect(parseLine('{"foo":"bar"}')).toBeNull();
  });

  it("is lenient with missing jsonrpc field when method is present", () => {
    const msg = parseLine('{"id":1,"method":"test"}');
    expect(msg).not.toBeNull();
  });
});

// ── NdjsonInterceptor ────────────────────────────────────────────────────

describe("NdjsonInterceptor", () => {
  function collectMessages(interceptor: NdjsonInterceptor): JsonRpcMessage[] {
    const messages: JsonRpcMessage[] = [];
    return messages;
  }

  it("parses a normal JSON-RPC message", async () => {
    const messages: JsonRpcMessage[] = [];
    const interceptor = new NdjsonInterceptor((msg) => messages.push(msg));
    const sink = new PassThrough();

    const data = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo"}}\n';
    await pipeline(
      async function* () { yield Buffer.from(data); },
      interceptor,
      sink,
    );

    expect(messages).toHaveLength(1);
    expect((messages[0] as Record<string, unknown>)["method"]).toBe("tools/call");
  });

  it("handles partial JSON across chunk boundaries", async () => {
    const messages: JsonRpcMessage[] = [];
    const interceptor = new NdjsonInterceptor((msg) => messages.push(msg));
    const sink = new PassThrough();

    const full = '{"jsonrpc":"2.0","id":1,"method":"test"}\n';
    const part1 = full.slice(0, 15);
    const part2 = full.slice(15);

    await pipeline(
      async function* () {
        yield Buffer.from(part1);
        yield Buffer.from(part2);
      },
      interceptor,
      sink,
    );

    expect(messages).toHaveLength(1);
  });

  it("skips malformed JSON without crashing", async () => {
    const messages: JsonRpcMessage[] = [];
    const interceptor = new NdjsonInterceptor((msg) => messages.push(msg));
    const sink = new PassThrough();

    const data = '{bad json}\n{"jsonrpc":"2.0","id":1,"method":"ok"}\n';
    await pipeline(
      async function* () { yield Buffer.from(data); },
      interceptor,
      sink,
    );

    expect(messages).toHaveLength(1);
    expect((messages[0] as Record<string, unknown>)["method"]).toBe("ok");
  });

  it("handles empty lines", async () => {
    const messages: JsonRpcMessage[] = [];
    const interceptor = new NdjsonInterceptor((msg) => messages.push(msg));
    const sink = new PassThrough();

    const data = '\n\n{"jsonrpc":"2.0","id":1,"method":"test"}\n\n';
    await pipeline(
      async function* () { yield Buffer.from(data); },
      interceptor,
      sink,
    );

    expect(messages).toHaveLength(1);
  });

  it("handles binary content mixed with JSON", async () => {
    const messages: JsonRpcMessage[] = [];
    const interceptor = new NdjsonInterceptor((msg) => messages.push(msg));
    const sink = new PassThrough();

    const binary = Buffer.from([0x00, 0x01, 0xFF, 0xFE]);
    const json = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"test"}\n');

    await pipeline(
      async function* () {
        yield Buffer.concat([binary, Buffer.from("\n"), json]);
      },
      interceptor,
      sink,
    );

    expect(messages).toHaveLength(1);
  });

  it("drops lines exceeding 10MB buffer limit", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const messages: JsonRpcMessage[] = [];
    const interceptor = new NdjsonInterceptor((msg) => messages.push(msg));

    // We must consume the output to avoid backpressure blocking the pipeline
    const sink = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
    sink.resume(); // discard output to prevent backpressure

    // Feed chunks in 1MB increments to exceed 10MB without a newline
    const chunkSize = 1024 * 1024;
    const numChunks = 11; // 11MB total
    const oneChunk = Buffer.alloc(chunkSize, 0x78); // 'x'

    await pipeline(
      async function* () {
        for (let i = 0; i < numChunks; i++) {
          yield oneChunk;
        }
        // Newline to flush the oversized buffer (already dropped)
        yield Buffer.from("\n");
        // A valid message after the oversized line
        yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"after"}\n');
      },
      interceptor,
      sink,
    );

    // The oversized line should have been dropped with a warning
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("WARNING: dropping line exceeding"),
    );
    // The message after the oversized line should still parse
    expect(messages).toHaveLength(1);
    expect((messages[0] as Record<string, unknown>)["method"]).toBe("after");

    stderrSpy.mockRestore();
  }, 30_000);

  it("parses multiple messages in a single chunk", async () => {
    const messages: JsonRpcMessage[] = [];
    const interceptor = new NdjsonInterceptor((msg) => messages.push(msg));
    const sink = new PassThrough();

    const data =
      '{"jsonrpc":"2.0","id":1,"method":"a"}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"b"}\n' +
      '{"jsonrpc":"2.0","id":3,"method":"c"}\n';

    await pipeline(
      async function* () { yield Buffer.from(data); },
      interceptor,
      sink,
    );

    expect(messages).toHaveLength(3);
  });

  it("forwards raw bytes unchanged downstream", async () => {
    const interceptor = new NdjsonInterceptor(() => {});
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => chunks.push(chunk));

    const data = '{"jsonrpc":"2.0","id":1,"method":"test"}\n';
    await pipeline(
      async function* () { yield Buffer.from(data); },
      interceptor,
      sink,
    );

    const output = Buffer.concat(chunks).toString();
    expect(output).toBe(data);
  });
});
