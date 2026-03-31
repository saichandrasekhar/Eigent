/**
 * Core interception logic for the AgentVault sidecar.
 *
 * Spawns the real MCP server as a child process, transparently proxies
 * stdio between the MCP client (parent) and MCP server (child), and
 * creates OpenTelemetry spans for every JSON-RPC message that passes
 * through.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { Span } from "@opentelemetry/api";

import {
  NdjsonInterceptor,
  type JsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcNotification,
  isJsonRpcErrorResponse,
  extractToolName,
  extractResourceUri,
  extractServerInfo,
} from "./parser.js";

import { TelemetryManager, MCP_ATTR } from "./telemetry.js";

// ── Options ────────────────────────────────────────────────────────────

export interface InterceptorOptions {
  /** The command + args to spawn as the MCP server. */
  command: string;
  args: string[];
  /** OTLP endpoint URL. */
  otelEndpoint: string;
  /** Optional agent identity string. */
  agentId?: string;
  /** Print intercepted messages to stderr. */
  verbose: boolean;
}

// ── Interceptor ────────────────────────────────────────────────────────

export class McpInterceptor {
  private child: ChildProcess | null = null;
  private telemetry: TelemetryManager;
  private readonly options: InterceptorOptions;

  /** In-flight request spans keyed by JSON-RPC message id. */
  private readonly pendingSpans = new Map<string | number, { span: Span; method: string }>();

  /** Maps request IDs to their method names (so we know what a response is for). */
  private readonly requestMethods = new Map<string | number, string>();

  constructor(options: InterceptorOptions) {
    this.options = options;
    this.telemetry = new TelemetryManager({
      otelEndpoint: options.otelEndpoint,
      agentId: options.agentId,
    });
  }

  /**
   * Start the child MCP server process and begin intercepting.
   * Returns a promise that resolves when the child process exits.
   */
  async run(): Promise<number> {
    const { command, args, verbose } = this.options;

    this.log(`Spawning MCP server: ${command} ${args.join(" ")}`);

    // Spawn the real MCP server.
    // - stdin:  pipe (we feed it from our stdin)
    // - stdout: pipe (we read from it, forward to our stdout)
    // - stderr: inherit (server logs go straight to parent stderr)
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env },
      // Use shell on Windows for .cmd/.bat scripts
      shell: process.platform === "win32",
    });

    const child = this.child;

    if (!child.stdin || !child.stdout) {
      throw new Error("Failed to create stdio pipes for child process");
    }

    // ── Intercept server → client (child stdout → parent stdout) ─────

    const serverToClient = new NdjsonInterceptor(
      (msg: JsonRpcMessage, raw: string) => {
        if (verbose) {
          this.log(`[server→client] ${raw.trim()}`);
        }
        this.handleServerMessage(msg);
      },
    );

    // ── Intercept client → server (parent stdin → child stdin) ───────

    const clientToServer = new NdjsonInterceptor(
      (msg: JsonRpcMessage, raw: string) => {
        if (verbose) {
          this.log(`[client→server] ${raw.trim()}`);
        }
        this.handleClientMessage(msg);
      },
    );

    // ── Wire up the pipelines ────────────────────────────────────────

    // Set up error handlers before piping to avoid unhandled errors
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      // EPIPE is normal when child exits before we finish writing
      if (err.code !== "EPIPE") {
        this.log(`Child stdin error: ${err.message}`);
      }
    });

    child.stdout.on("error", (err) => {
      this.log(`Child stdout error: ${err.message}`);
    });

    // Forward parent stdin → interceptor → child stdin
    // Forward child stdout → interceptor → parent stdout
    const stdinPipeline = pipeline(
      process.stdin,
      clientToServer,
      child.stdin,
    ).catch((err: NodeJS.ErrnoException) => {
      // EPIPE / ERR_STREAM_PREMATURE_CLOSE are expected when child exits
      if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        this.log(`stdin pipeline error: ${err.message}`);
      }
    });

    const stdoutPipeline = pipeline(
      child.stdout,
      serverToClient,
      process.stdout,
    ).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        this.log(`stdout pipeline error: ${err.message}`);
      }
    });

    // ── Wait for child exit ──────────────────────────────────────────

    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code, signal) => {
        if (signal) {
          this.log(`MCP server killed by signal ${signal}`);
          resolve(128 + (signalToNumber(signal) ?? 1));
        } else {
          this.log(`MCP server exited with code ${code ?? 0}`);
          resolve(code ?? 0);
        }
      });

      child.on("error", (err) => {
        this.log(`Failed to start MCP server: ${err.message}`);
        resolve(1);
      });
    });

    // End any in-flight spans
    for (const [id, { span, method }] of this.pendingSpans) {
      this.telemetry.endSpan(span, {
        code: -1,
        message: `MCP server exited before responding to ${method} (id=${String(id)})`,
      });
    }
    this.pendingSpans.clear();

    // Wait for pipelines to finish (they should be done since child exited)
    await Promise.allSettled([stdinPipeline, stdoutPipeline]);

    // Flush telemetry
    await this.telemetry.shutdown();

    return exitCode;
  }

  /**
   * Gracefully stop the child process.
   */
  async stop(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");

      // Give it 5 seconds, then SIGKILL
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.child && !this.child.killed) {
            this.child.kill("SIGKILL");
          }
          resolve();
        }, 5000);

        this.child!.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await this.telemetry.shutdown();
  }

  // ── Message handlers ─────────────────────────────────────────────────

  /**
   * Handle a message coming FROM the MCP client (going TO the server).
   * These are requests and notifications.
   */
  private handleClientMessage(msg: JsonRpcMessage): void {
    if (isJsonRpcRequest(msg)) {
      // Remember the method for this ID so we can label the response span
      this.requestMethods.set(msg.id, msg.method);

      const attributes: Record<string, string | number | undefined> = {};

      // Extract method-specific attributes
      if (msg.method === "tools/call") {
        const toolName = extractToolName(msg);
        if (toolName) attributes[MCP_ATTR.TOOL_NAME] = toolName;
      } else if (msg.method === "resources/read") {
        const uri = extractResourceUri(msg);
        if (uri) attributes[MCP_ATTR.RESOURCE_URI] = uri;
      }

      // Start a span that we will end when the response comes back
      const span = this.telemetry.startRequestSpan(
        msg.method,
        msg.id,
        attributes,
      );
      this.pendingSpans.set(msg.id, { span, method: msg.method });

    } else if (isJsonRpcNotification(msg)) {
      // Notifications are fire-and-forget — record as a single-shot event
      this.telemetry.recordEvent(`notification/${msg.method}`);
    }
  }

  /**
   * Handle a message coming FROM the MCP server (going TO the client).
   * These are responses and server-initiated notifications.
   */
  private handleServerMessage(msg: JsonRpcMessage): void {
    if (isJsonRpcResponse(msg)) {
      const pending = this.pendingSpans.get(msg.id);
      if (pending) {
        const { span, method } = pending;

        // If this is an initialize response, capture server info
        if (method === "initialize" && "result" in msg) {
          const info = extractServerInfo(msg.result);
          if (info) {
            this.telemetry.setServerInfo(info.name, info.version);
            if (info.name) span.setAttribute(MCP_ATTR.SERVER_NAME, info.name);
            if (info.version) span.setAttribute(MCP_ATTR.SERVER_VERSION, info.version);
          }
        }

        // End the span
        if (isJsonRpcErrorResponse(msg)) {
          this.telemetry.endSpan(span, {
            code: msg.error.code,
            message: msg.error.message,
          });
        } else {
          this.telemetry.endSpan(span);
        }

        this.pendingSpans.delete(msg.id);
        this.requestMethods.delete(msg.id);
      }
      // If no pending span, this is a response to an unknown request — skip

    } else if (isJsonRpcRequest(msg)) {
      // Server-to-client request (e.g., sampling, roots/list)
      // Start a span — the response from the client will end it
      const span = this.telemetry.startRequestSpan(
        `server-request/${msg.method}`,
        msg.id,
      );
      this.pendingSpans.set(msg.id, { span, method: msg.method });

    } else if (isJsonRpcNotification(msg)) {
      // Server-initiated notification (e.g., progress, log)
      this.telemetry.recordEvent(`server-notification/${msg.method}`);
    }
  }

  private log(message: string): void {
    process.stderr.write(`[agentvault-sidecar] ${message}\n`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function signalToNumber(signal: string): number | undefined {
  const map: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGTERM: 15,
    SIGKILL: 9,
  };
  return map[signal];
}
