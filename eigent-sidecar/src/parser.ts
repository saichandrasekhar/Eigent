/**
 * JSON-RPC message parser for MCP stdio streams.
 *
 * Handles newline-delimited JSON (NDJSON) parsing, message classification,
 * and graceful recovery from malformed input.
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

// ── NDJSON Stream Transform ────────────────────────────────────────────

export type MessageCallback = (
  message: JsonRpcMessage,
  raw: string,
) => void;

/**
 * A Transform stream that splits incoming data on newlines, parses each
 * line as JSON-RPC, fires the callback for valid messages, and forwards
 * all raw bytes downstream unchanged (for transparent proxying).
 *
 * This ensures the sidecar never corrupts the byte stream between
 * MCP client and server, regardless of parsing success.
 */
export class NdjsonInterceptor extends Transform {
  private buffer = "";
  private readonly onMessage: MessageCallback;

  constructor(onMessage: MessageCallback) {
    super();
    this.onMessage = onMessage;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    // Always forward the raw bytes downstream first.
    // Parse is side-effect only.
    this.push(chunk);

    this.buffer += chunk.toString("utf-8");

    // Process all complete lines
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      const msg = parseLine(line);
      if (msg !== null) {
        try {
          this.onMessage(msg, line);
        } catch {
          // Never let a callback error break the stream
        }
      }
    }

    callback();
  }

  override _flush(callback: TransformCallback): void {
    // Handle any remaining data without a trailing newline
    if (this.buffer.length > 0) {
      const msg = parseLine(this.buffer);
      if (msg !== null) {
        try {
          this.onMessage(msg, this.buffer);
        } catch {
          // swallow
        }
      }
      this.buffer = "";
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
