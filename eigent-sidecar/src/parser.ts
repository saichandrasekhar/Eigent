/**
 * JSON-RPC message parser for MCP stdio streams.
 *
 * Handles newline-delimited JSON (NDJSON) parsing, message classification,
 * and graceful recovery from malformed input.
 *
 * Supports two modes:
 * - Passthrough (default): bytes are forwarded immediately, callback is fire-and-forget.
 * - Hold mode: bytes are buffered, callback returns a decision, and bytes are
 *   either forwarded or replaced with a synthesized error response.
 */

import { Transform, type TransformCallback } from "node:stream";

// ── JSON-RPC message types ─────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// ── Type guards ────────────────────────────────────────────────────────

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function isJsonRpcNotification(
  msg: JsonRpcMessage,
): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

export function isJsonRpcResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcResponse {
  return !("method" in msg) && "id" in msg;
}

export function isJsonRpcErrorResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcErrorResponse {
  return isJsonRpcResponse(msg) && "error" in msg;
}

export function isJsonRpcSuccessResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcSuccessResponse {
  return isJsonRpcResponse(msg) && "result" in msg;
}

// ── Parsing helpers ────────────────────────────────────────────────────

/**
 * Attempt to parse a single line as a JSON-RPC message.
 * Returns null for blank lines or malformed input.
 */
export function parseLine(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;

    const obj = parsed as Record<string, unknown>;

    // Must be JSON-RPC 2.0 (or at least look like JSON-RPC)
    if (obj["jsonrpc"] !== "2.0") {
      // Be lenient — some implementations omit jsonrpc field
      // but still send valid request/response shapes.
      if (!("method" in obj) && !("result" in obj) && !("error" in obj)) {
        return null;
      }
    }

    return parsed as JsonRpcMessage;
  } catch {
    return null;
  }
}

// ── Callback types ─────────────────────────────────────────────────────

/** Fire-and-forget callback (passthrough mode). */
export type MessageCallback = (
  message: JsonRpcMessage,
  raw: string,
) => void;

/** Hold-mode decision returned by async callback. */
export interface HoldDecision {
  action: "allow" | "deny";
  /** If deny, the error response JSON to inject (including trailing newline). */
  errorResponse?: string;
}

/** Async callback for hold mode. */
export type HoldMessageCallback = (
  message: JsonRpcMessage,
  raw: string,
) => Promise<HoldDecision>;

// ── NDJSON Stream Transform ────────────────────────────────────────────

/**
 * A Transform stream that splits incoming data on newlines, parses each
 * line as JSON-RPC, fires the callback for valid messages, and forwards
 * all raw bytes downstream unchanged (for transparent proxying).
 *
 * This ensures the sidecar never corrupts the byte stream between
 * MCP client and server, regardless of parsing success.
 *
 * In hold mode, the stream buffers bytes per-line, calls the async
 * callback, and based on the decision either forwards the original bytes
 * or injects a synthesized error response.
 */
/** Maximum buffer size: 10 MB. Lines exceeding this are dropped. */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

export interface NdjsonInterceptorOptions {
  holdMode?: boolean;
}

export class NdjsonInterceptor extends Transform {
  /** Buffered chunks that have not yet been split on newline. */
  private chunks: string[] = [];
  /** Running byte-length of the buffered chunks. */
  private bufferSize = 0;
  private readonly onMessage: MessageCallback | undefined;
  private readonly onHoldMessage: HoldMessageCallback | undefined;
  private readonly holdMode: boolean;

  constructor(onMessage: MessageCallback, options?: NdjsonInterceptorOptions);
  constructor(onMessage: HoldMessageCallback, options: NdjsonInterceptorOptions & { holdMode: true });
  constructor(
    onMessage: MessageCallback | HoldMessageCallback,
    options?: NdjsonInterceptorOptions,
  ) {
    super();
    this.holdMode = options?.holdMode ?? false;
    if (this.holdMode) {
      this.onHoldMessage = onMessage as HoldMessageCallback;
      this.onMessage = undefined;
    } else {
      this.onMessage = onMessage as MessageCallback;
      this.onHoldMessage = undefined;
    }
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.holdMode) {
      this.transformHoldMode(chunk, callback);
    } else {
      this.transformPassthrough(chunk, callback);
    }
  }

  /**
   * Original passthrough transform: push bytes immediately, parse as side-effect.
   */
  private transformPassthrough(chunk: Buffer, callback: TransformCallback): void {
    // Always forward the raw bytes downstream first.
    // Parse is side-effect only.
    this.push(chunk);

    const str = chunk.toString("utf-8");

    // Check buffer size limit before accumulating
    if (this.bufferSize + str.length > MAX_BUFFER_SIZE && !str.includes("\n")) {
      process.stderr.write(
        `[eigent-sidecar] WARNING: dropping line exceeding ${MAX_BUFFER_SIZE} byte buffer limit\n`,
      );
      this.chunks.length = 0;
      this.bufferSize = 0;
      callback();
      return;
    }

    this.chunks.push(str);
    this.bufferSize += str.length;

    // Only join and split when the incoming chunk contains a newline
    if (!str.includes("\n")) {
      callback();
      return;
    }

    // Join all buffered chunks and split on newlines
    let combined = this.chunks.join("");
    this.chunks.length = 0;
    this.bufferSize = 0;

    // Process all complete lines
    let newlineIdx: number;
    while ((newlineIdx = combined.indexOf("\n")) !== -1) {
      const line = combined.slice(0, newlineIdx);
      combined = combined.slice(newlineIdx + 1);

      if (line.length <= MAX_BUFFER_SIZE) {
        const msg = parseLine(line);
        if (msg !== null) {
          try {
            this.onMessage!(msg, line);
          } catch {
            // Never let a callback error break the stream
          }
        }
      } else {
        process.stderr.write(
          `[eigent-sidecar] WARNING: dropping line exceeding ${MAX_BUFFER_SIZE} byte buffer limit\n`,
        );
      }
    }

    // Store remainder back
    if (combined.length > 0) {
      if (combined.length > MAX_BUFFER_SIZE) {
        process.stderr.write(
          `[eigent-sidecar] WARNING: dropping line exceeding ${MAX_BUFFER_SIZE} byte buffer limit\n`,
        );
      } else {
        this.chunks.push(combined);
        this.bufferSize = combined.length;
      }
    }

    callback();
  }

  /**
   * Hold-mode transform: buffer bytes, parse, get async decision,
   * then either forward original bytes or inject error response.
   */
  private transformHoldMode(chunk: Buffer, callback: TransformCallback): void {
    const str = chunk.toString("utf-8");

    // Check buffer size limit before accumulating
    if (this.bufferSize + str.length > MAX_BUFFER_SIZE && !str.includes("\n")) {
      process.stderr.write(
        `[eigent-sidecar] WARNING: dropping line exceeding ${MAX_BUFFER_SIZE} byte buffer limit\n`,
      );
      this.chunks.length = 0;
      this.bufferSize = 0;
      // In hold mode, still push the oversized chunk through (it's not JSON-RPC)
      this.push(chunk);
      callback();
      return;
    }

    this.chunks.push(str);
    this.bufferSize += str.length;

    // If no newline yet, buffer and wait
    if (!str.includes("\n")) {
      callback();
      return;
    }

    // Join all buffered chunks and split on newlines
    let combined = this.chunks.join("");
    this.chunks.length = 0;
    this.bufferSize = 0;

    // Collect lines to process
    const lines: string[] = [];
    let newlineIdx: number;
    while ((newlineIdx = combined.indexOf("\n")) !== -1) {
      const line = combined.slice(0, newlineIdx);
      lines.push(line);
      combined = combined.slice(newlineIdx + 1);
    }

    // Store remainder back
    if (combined.length > 0) {
      if (combined.length > MAX_BUFFER_SIZE) {
        process.stderr.write(
          `[eigent-sidecar] WARNING: dropping line exceeding ${MAX_BUFFER_SIZE} byte buffer limit\n`,
        );
      } else {
        this.chunks.push(combined);
        this.bufferSize = combined.length;
      }
    }

    // Process each line, getting async decisions
    this.processLinesHold(lines)
      .then(() => callback())
      .catch((err) => callback(err instanceof Error ? err : new Error(String(err))));
  }

  /**
   * Process buffered lines in hold mode. For each line that is a valid
   * JSON-RPC message, call the async callback to get a decision.
   */
  private async processLinesHold(lines: string[]): Promise<void> {
    for (const line of lines) {
      if (line.length > MAX_BUFFER_SIZE) {
        process.stderr.write(
          `[eigent-sidecar] WARNING: dropping line exceeding ${MAX_BUFFER_SIZE} byte buffer limit\n`,
        );
        // Push the raw line + newline anyway (it's not valid JSON-RPC)
        this.push(Buffer.from(line + "\n"));
        continue;
      }

      const msg = parseLine(line);

      if (msg === null) {
        // Not a valid JSON-RPC message — forward raw bytes unchanged
        this.push(Buffer.from(line + "\n"));
        continue;
      }

      // Valid message — ask the callback for a decision
      try {
        const decision = await this.onHoldMessage!(msg, line);

        if (decision.action === "allow") {
          // Forward original bytes
          this.push(Buffer.from(line + "\n"));
        } else if (decision.action === "deny" && decision.errorResponse) {
          // Inject error response instead of forwarding
          const errBytes = decision.errorResponse.endsWith("\n")
            ? decision.errorResponse
            : decision.errorResponse + "\n";
          this.push(Buffer.from(errBytes));
        } else {
          // Deny without error response — drop the message silently
          // (no bytes forwarded downstream)
        }
      } catch {
        // Callback error — fail open, forward original bytes
        this.push(Buffer.from(line + "\n"));
      }
    }
  }

  override _flush(callback: TransformCallback): void {
    // Handle any remaining data without a trailing newline
    if (this.chunks.length > 0) {
      const remaining = this.chunks.join("");
      this.chunks.length = 0;
      this.bufferSize = 0;

      if (remaining.length > MAX_BUFFER_SIZE) {
        process.stderr.write(
          `[eigent-sidecar] WARNING: dropping line exceeding ${MAX_BUFFER_SIZE} byte buffer limit\n`,
        );
      } else if (remaining.length > 0) {
        if (this.holdMode) {
          // In hold mode, process remaining data through the async callback
          const msg = parseLine(remaining);
          if (msg !== null && this.onHoldMessage) {
            this.onHoldMessage(msg, remaining)
              .then((decision) => {
                if (decision.action === "allow") {
                  this.push(Buffer.from(remaining));
                } else if (decision.action === "deny" && decision.errorResponse) {
                  this.push(Buffer.from(decision.errorResponse));
                }
                callback();
              })
              .catch(() => {
                // Fail open
                this.push(Buffer.from(remaining));
                callback();
              });
            return;
          }
          // Not a valid message — forward
          this.push(Buffer.from(remaining));
        } else {
          const msg = parseLine(remaining);
          if (msg !== null) {
            try {
              this.onMessage!(msg, remaining);
            } catch {
              // swallow
            }
          }
        }
      }
    }
    callback();
  }
}

/**
 * Extract the tool name from a tools/call request's params.
 */
export function extractToolName(msg: JsonRpcRequest): string | undefined {
  if (msg.method !== "tools/call") return undefined;
  const params = msg.params as Record<string, unknown> | undefined;
  if (!params) return undefined;
  return typeof params["name"] === "string" ? params["name"] : undefined;
}

/**
 * Extract the resource URI from a resources/read request's params.
 */
export function extractResourceUri(msg: JsonRpcRequest): string | undefined {
  if (msg.method !== "resources/read") return undefined;
  const params = msg.params as Record<string, unknown> | undefined;
  if (!params) return undefined;
  const uri = params["uri"];
  return typeof uri === "string" ? uri : undefined;
}

/**
 * Extract the server name from an initialize response result.
 */
export function extractServerInfo(
  result: unknown,
): { name?: string; version?: string } | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  const serverInfo = r["serverInfo"] as Record<string, unknown> | undefined;
  if (!serverInfo) return undefined;
  return {
    name: typeof serverInfo["name"] === "string" ? serverInfo["name"] : undefined,
    version:
      typeof serverInfo["version"] === "string"
        ? serverInfo["version"]
        : undefined,
  };
}
