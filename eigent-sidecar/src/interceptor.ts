/**
 * Core interception logic for the Eigent sidecar.
 *
 * Spawns the real MCP server as a child process, transparently proxies
 * stdio between the MCP client (parent) and MCP server (child), and
 * creates OpenTelemetry spans for every JSON-RPC message that passes
 * through.
 *
 * Optionally enforces IAM permissions by validating eigent tokens and
 * blocking unauthorized tool calls.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { Span } from "@opentelemetry/api";

import {
  NdjsonInterceptor,
  type JsonRpcMessage,
  type HoldDecision,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcNotification,
  isJsonRpcErrorResponse,
  extractToolName,
  extractResourceUri,
  extractServerInfo,
} from "./parser.js";

import { TelemetryManager, MCP_ATTR } from "./telemetry.js";
import { TokenValidator, type EigentClaims } from "./auth.js";
import { PolicyEnforcer, type EnforcementMode } from "./enforcer.js";
import type { PolicyConfig } from "./policy.js";
import { loadPolicy, watchPolicy } from "./policy-loader.js";

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
  /** Optional API key for the OTLP endpoint. */
  otelApiKey?: string;
  /** Whether to force TLS for the OTLP exporter. */
  otelTls?: boolean;
  /** Enforcement mode: enforce, monitor, or permissive. Default: monitor. */
  mode?: EnforcementMode;
  /** Static eigent token for this agent. */
  eigentToken?: string;
  /** Registry URL for token validation and JWKS. */
  registryUrl?: string;
  /** Path to YAML policy file. */
  policyPath?: string;
}

// ── Interceptor ────────────────────────────────────────────────────────

export class McpInterceptor {
  private child: ChildProcess | null = null;
  private telemetry: TelemetryManager;
  private readonly options: InterceptorOptions;
  private readonly validator: TokenValidator;
  private readonly enforcer: PolicyEnforcer;
  private readonly mode: EnforcementMode;

  /** Cached parsed claims from the static eigent token. */
  private cachedClaims: EigentClaims | null = null;
  private claimsValidated = false;

  /** In-flight request spans keyed by JSON-RPC message id. */
  private readonly pendingSpans = new Map<string | number, { span: Span; method: string; createdAt: number }>();

  /** Maps request IDs to their method names (so we know what a response is for). */
  private readonly requestMethods = new Map<string | number, string>();

  /** Interval handle for the pending-span TTL reaper. */
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  /** Cleanup function for the policy file watcher. */
  private stopPolicyWatch: (() => void) | null = null;

  /** Maximum age (ms) for a pending span before it is reaped with a timeout error. */
  private static readonly SPAN_TTL_MS = 60_000;

  constructor(options: InterceptorOptions) {
    this.options = options;
    this.mode = options.mode ?? "monitor";

    this.telemetry = new TelemetryManager({
      otelEndpoint: options.otelEndpoint,
      agentId: options.agentId,
      otelApiKey: options.otelApiKey,
      otelTls: options.otelTls,
    });

    this.validator = new TokenValidator({
      registryUrl: options.registryUrl,
    });

    // Load YAML policy if configured
    let policyConfig: PolicyConfig | undefined;
    if (options.policyPath) {
      try {
        policyConfig = loadPolicy(options.policyPath);
        this.log(`Loaded policy from ${options.policyPath} (${policyConfig.rules.length} rules)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Failed to load policy: ${message}`);
      }

      // Watch for hot-reload
      this.stopPolicyWatch = watchPolicy(options.policyPath, (config, error) => {
        if (error) {
          this.log(`Policy reload error: ${error.message}`);
          return;
        }
        if (config) {
          this.enforcer.updatePolicy(config);
          this.log(`Policy hot-reloaded (${config.rules.length} rules)`);
        }
      });
    }

    this.enforcer = new PolicyEnforcer(this.mode, this.validator, policyConfig);
  }

  /**
   * Start the child MCP server process and begin intercepting.
   * Returns a promise that resolves when the child process exits.
   */
  async run(): Promise<number> {
    const { command, args, verbose } = this.options;

    this.log(`Spawning MCP server: ${command} ${args.join(" ")}`);
    if (this.mode !== "permissive") {
      this.log(`Enforcement mode: ${this.mode}`);
    }

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

    // Start the pending-span TTL reaper (every 10 seconds, reap spans older than 60s)
    this.reaperInterval = setInterval(() => {
      this.reapExpiredSpans();
    }, 10_000);
    // Do not let the reaper keep the process alive
    if (this.reaperInterval && typeof this.reaperInterval === "object" && "unref" in this.reaperInterval) {
      this.reaperInterval.unref();
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
    // In enforce mode, use hold mode so we can block unauthorized calls.
    const useHoldMode = this.mode === "enforce";

    let clientToServer: NdjsonInterceptor;

    if (useHoldMode) {
      clientToServer = new NdjsonInterceptor(
        async (msg: JsonRpcMessage, raw: string): Promise<HoldDecision> => {
          if (verbose) {
            this.log(`[client→server] ${raw.trim()}`);
          }
          return this.handleClientMessageHold(msg);
        },
        { holdMode: true },
      );
    } else {
      clientToServer = new NdjsonInterceptor(
        (msg: JsonRpcMessage, raw: string) => {
          if (verbose) {
            this.log(`[client→server] ${raw.trim()}`);
          }
          this.handleClientMessage(msg);
        },
      );
    }

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

    if (useHoldMode) {
      // In enforce/hold mode, the client→server interceptor's output does NOT
      // go to child.stdin. Instead, allowed messages go to child.stdin and
      // denied messages need to go to parent stdout as error responses.
      //
      // We split the output: the NdjsonInterceptor in hold mode replaces denied
      // messages with error responses. These error responses should go to parent
      // stdout (not child stdin). But the pipeline architecture means everything
      // from the interceptor goes to one destination.
      //
      // Solution: In hold mode, the interceptor:
      // - For allowed messages: pushes original bytes (forwarded to child stdin)
      // - For denied messages: pushes error response bytes
      //
      // We need to route denied messages to parent stdout instead. We handle this
      // by writing denied error responses directly to process.stdout in
      // handleClientMessageHold, and returning a "deny" decision that drops the
      // original bytes (the hold mode NdjsonInterceptor pushes nothing for deny
      // without errorResponse).
      //
      // Actually, the simpler approach: pipe interceptor output to child.stdin,
      // and for denied messages, write the error response directly to stdout.
      const stdinPipeline = pipeline(
        process.stdin,
        clientToServer,
        child.stdin,
      ).catch((err: NodeJS.ErrnoException) => {
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

      const exitCode = await this.waitForChildExit(child, stdinPipeline, stdoutPipeline);
      return exitCode;
    }

    // Non-hold mode (monitor/permissive): standard passthrough pipeline
    const stdinPipeline = pipeline(
      process.stdin,
      clientToServer,
      child.stdin,
    ).catch((err: NodeJS.ErrnoException) => {
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

    const exitCode = await this.waitForChildExit(child, stdinPipeline, stdoutPipeline);
    return exitCode;
  }

  /**
   * Wait for the child process to exit and clean up.
   */
  private async waitForChildExit(
    child: ChildProcess,
    stdinPipeline: Promise<void>,
    stdoutPipeline: Promise<void>,
  ): Promise<number> {
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

    // Stop the reaper
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }

    // End any in-flight spans
    for (const [id, { span, method }] of this.pendingSpans) {
      this.telemetry.endSpan(span, {
        code: -1,
        message: `MCP server exited before responding to ${method} (id=${String(id)})`,
      });
    }
    this.pendingSpans.clear();

    // Wait for pipelines to finish
    await Promise.allSettled([stdinPipeline, stdoutPipeline]);

    // Flush telemetry
    await this.telemetry.shutdown();

    return exitCode;
  }

  /**
   * Gracefully stop the child process.
   */
  async stop(): Promise<void> {
    if (this.stopPolicyWatch) {
      this.stopPolicyWatch();
      this.stopPolicyWatch = null;
    }
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
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

  /**
   * Reap pending spans that have exceeded the TTL (60 seconds).
   * Ends them with a timeout error and removes from the map.
   */
  private reapExpiredSpans(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingSpans) {
      if (now - entry.createdAt > McpInterceptor.SPAN_TTL_MS) {
        this.telemetry.endSpan(entry.span, {
          code: -1,
          message: `Span timed out after ${McpInterceptor.SPAN_TTL_MS}ms for ${entry.method} (id=${String(id)})`,
        });
        this.pendingSpans.delete(id);
        this.requestMethods.delete(id);
      }
    }
  }

  // ── Token resolution ────────────────────────────────────────────────

  /**
   * Get the eigent claims for the current agent.
   * Uses the static token from CLI options or the EIGENT_TOKEN env var.
   */
  private async resolveEigentClaims(): Promise<EigentClaims | null> {
    if (this.claimsValidated) return this.cachedClaims;

    const token = this.options.eigentToken ?? process.env["EIGENT_TOKEN"];
    if (!token) {
      this.claimsValidated = true;
      this.cachedClaims = null;
      return null;
    }

    const result = await this.validator.validate(token);
    this.claimsValidated = true;

    if (result.valid) {
      this.cachedClaims = result.claims;
      return result.claims;
    }

    this.log(`Eigent token validation failed: ${result.reason ?? "unknown"}`);
    this.cachedClaims = null;
    return null;
  }

  // ── Message handlers ─────────────────────────────────────────────────

  /**
   * Handle a message coming FROM the MCP client (going TO the server).
   * Passthrough mode — fire-and-forget (monitor/permissive).
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

        // In monitor/permissive mode, evaluate policy and add span attributes
        // (async, fire-and-forget for telemetry only)
        if (toolName) {
          const toolArgs = this.extractToolArgs(msg);
          this.resolveEigentClaims().then((claims) => {
            const decision = this.enforcer.evaluate(claims, msg.method, toolName, toolArgs);

            // Add enforcement attributes to the span
            const pending = this.pendingSpans.get(msg.id);
            if (pending) {
              pending.span.setAttribute(MCP_ATTR.EIGENT_DECISION, decision.action);
              if (decision.policy_rule_name) {
                pending.span.setAttribute("eigent.policy.rule_name", decision.policy_rule_name);
              }
              if (decision.policy_action) {
                pending.span.setAttribute("eigent.policy.action", decision.policy_action);
              }
              if (decision.policy_reason) {
                pending.span.setAttribute("eigent.policy.reason", decision.policy_reason);
              }
              if (claims) {
                this.setEigentSpanAttributes(pending.span, claims);
              }
            }

            if (decision.action === "log_only") {
              this.log(`[monitor] ${decision.reason}`);
            }
          }).catch(() => {
            // Best effort
          });
        }
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
      this.pendingSpans.set(msg.id, { span, method: msg.method, createdAt: Date.now() });

    } else if (isJsonRpcNotification(msg)) {
      // Notifications are fire-and-forget — record as a single-shot event
      this.telemetry.recordEvent(`notification/${msg.method}`);
    }
  }

  /**
   * Handle a message coming FROM the MCP client (going TO the server).
   * Hold mode — async, returns decision for the parser to act on (enforce mode).
   */
  private async handleClientMessageHold(msg: JsonRpcMessage): Promise<HoldDecision> {
    if (isJsonRpcRequest(msg)) {
      this.requestMethods.set(msg.id, msg.method);

      const attributes: Record<string, string | number | undefined> = {};

      if (msg.method === "tools/call") {
        const toolName = extractToolName(msg);
        if (toolName) attributes[MCP_ATTR.TOOL_NAME] = toolName;

        if (toolName) {
          const toolArgs = this.extractToolArgs(msg);
          const claims = await this.resolveEigentClaims();
          const decision = this.enforcer.evaluate(claims, msg.method, toolName, toolArgs);

          // Start span with enforcement attributes
          attributes[MCP_ATTR.EIGENT_DECISION] = decision.action;
          if (decision.policy_rule_name) {
            attributes["eigent.policy.rule_name"] = decision.policy_rule_name;
          }
          if (decision.policy_action) {
            attributes["eigent.policy.action"] = decision.policy_action;
          }
          if (decision.policy_reason) {
            attributes["eigent.policy.reason"] = decision.policy_reason;
          }
          if (claims) {
            attributes[MCP_ATTR.EIGENT_AGENT_ID] = claims.agent.name;
            attributes[MCP_ATTR.EIGENT_HUMAN_EMAIL] = claims.human.email;
            attributes[MCP_ATTR.EIGENT_DELEGATION_DEPTH] = claims.delegation.depth;
            attributes[MCP_ATTR.EIGENT_DELEGATION_CHAIN] = claims.delegation.chain.join(" -> ");
          }

          if (decision.action === "deny") {
            // Create and immediately end a span for the denied request
            const span = this.telemetry.startRequestSpan(
              msg.method,
              msg.id,
              attributes,
            );
            this.telemetry.endSpan(span, {
              code: -32001,
              message: `Eigent: permission denied. ${decision.reason}`,
            });

            this.log(`[enforce] DENIED: ${decision.reason}`);

            // Synthesize JSON-RPC error and write directly to parent stdout
            const errorResponse = JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32001,
                message: `Eigent: permission denied. ${decision.reason}`,
              },
            });

            // Write error to parent stdout
            process.stdout.write(errorResponse + "\n");

            // Return deny with no errorResponse so the hold-mode parser drops the message
            // (we already wrote the error to stdout ourselves)
            return { action: "deny" };
          }

          if (decision.action === "require_approval") {
            this.log(`[enforce] HELD for approval: ${decision.reason}`);

            // Hold the request: wait up to 30 seconds for approval (future: webhook)
            // For now, timeout with deny after 30 seconds
            const span = this.telemetry.startRequestSpan(
              msg.method,
              msg.id,
              attributes,
            );

            await new Promise((resolve) => setTimeout(resolve, 30_000));

            this.telemetry.endSpan(span, {
              code: -32001,
              message: `Eigent: approval timeout. ${decision.reason}`,
            });

            this.log(`[enforce] DENIED (approval timeout): ${decision.reason}`);

            const errorResponse = JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32001,
                message: `Eigent: approval timeout after 30s. ${decision.reason}`,
              },
            });
            process.stdout.write(errorResponse + "\n");
            return { action: "deny" };
          }
        }
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
      this.pendingSpans.set(msg.id, { span, method: msg.method, createdAt: Date.now() });

    } else if (isJsonRpcNotification(msg)) {
      this.telemetry.recordEvent(`notification/${msg.method}`);
    }

    return { action: "allow" };
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
      this.pendingSpans.set(msg.id, { span, method: msg.method, createdAt: Date.now() });

    } else if (isJsonRpcNotification(msg)) {
      // Server-initiated notification (e.g., progress, log)
      this.telemetry.recordEvent(`server-notification/${msg.method}`);
    }
  }

  /**
   * Extract tool call arguments from a JSON-RPC request.
   */
  private extractToolArgs(msg: { params?: Record<string, unknown> }): Record<string, unknown> | undefined {
    const params = msg.params;
    if (!params) return undefined;
    const args = params["arguments"];
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }
    return undefined;
  }

  /**
   * Set eigent-specific span attributes from claims.
   */
  private setEigentSpanAttributes(span: Span, claims: EigentClaims): void {
    span.setAttribute(MCP_ATTR.EIGENT_AGENT_ID, claims.agent.name);
    span.setAttribute(MCP_ATTR.EIGENT_HUMAN_EMAIL, claims.human.email);
    span.setAttribute(MCP_ATTR.EIGENT_DELEGATION_DEPTH, claims.delegation.depth);
    span.setAttribute(MCP_ATTR.EIGENT_DELEGATION_CHAIN, claims.delegation.chain.join(" -> "));
  }

  private log(message: string): void {
    process.stderr.write(`[eigent-sidecar] ${message}\n`);
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
