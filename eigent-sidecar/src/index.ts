#!/usr/bin/env node

/**
 * eigent-sidecar — MCP stdio sidecar for agent telemetry.
 *
 * Wraps any MCP server command, transparently proxies stdio, and exports
 * OpenTelemetry spans for every JSON-RPC message that passes through.
 *
 * Optionally enforces IAM permissions by validating eigent tokens and
 * blocking unauthorized tool calls.
 *
 * Usage:
 *   eigent-sidecar wrap -- npx @modelcontextprotocol/server-filesystem /tmp
 *   eigent-sidecar wrap --otel-endpoint http://localhost:4318 -- node my-server.js
 *   eigent-sidecar wrap --mode enforce --eigent-token <token> -- node my-server.js
 */

import { Command } from "commander";
import { McpInterceptor } from "./interceptor.js";
import type { EnforcementMode } from "./enforcer.js";

const program = new Command();

program
  .name("eigent-sidecar")
  .description(
    "MCP stdio sidecar that captures agent telemetry as OpenTelemetry spans",
  )
  .version("0.1.0");

program
  .command("wrap")
  .description("Wrap an MCP server command and intercept stdio traffic")
  .argument("<command>", "The MCP server command to run")
  .argument("[args...]", "Arguments to pass to the MCP server command")
  .option(
    "--otel-endpoint <url>",
    "OpenTelemetry collector endpoint",
    "http://localhost:4318",
  )
  .option(
    "--agent-id <id>",
    "Agent identity to attach to all spans",
  )
  .option(
    "--otel-api-key <key>",
    "API key to send as x-api-key header to the OTLP endpoint",
  )
  .option(
    "--otel-tls",
    "Force TLS (https) for the OTLP exporter connection",
    false,
  )
  .option(
    "--verbose",
    "Log intercepted messages to stderr",
    false,
  )
  .option(
    "--mode <mode>",
    "Enforcement mode: enforce, monitor, or permissive",
    "monitor",
  )
  .option(
    "--eigent-token <token>",
    "Static eigent token for this agent",
  )
  .option(
    "--registry-url <url>",
    "Registry URL for token validation and JWKS",
  )
  .allowUnknownOption(false)
  .action(async (command: string, args: string[], options: {
    otelEndpoint: string;
    agentId?: string;
    otelApiKey?: string;
    otelTls: boolean;
    verbose: boolean;
    mode: string;
    eigentToken?: string;
    registryUrl?: string;
  }) => {
    // Validate mode
    const validModes: EnforcementMode[] = ["enforce", "monitor", "permissive"];
    const mode = options.mode as EnforcementMode;
    if (!validModes.includes(mode)) {
      process.stderr.write(
        `[eigent-sidecar] Invalid mode '${options.mode}'. Must be one of: ${validModes.join(", ")}\n`,
      );
      process.exit(1);
    }

    const interceptor = new McpInterceptor({
      command,
      args,
      otelEndpoint: options.otelEndpoint,
      agentId: options.agentId,
      otelApiKey: options.otelApiKey,
      otelTls: options.otelTls,
      verbose: options.verbose,
      mode,
      eigentToken: options.eigentToken,
      registryUrl: options.registryUrl,
    });

    // ── Graceful shutdown ──────────────────────────────────────────
    let stopping = false;

    const handleSignal = (signal: string) => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(
        `[eigent-sidecar] Received ${signal}, shutting down...\n`,
      );
      interceptor.stop().then(() => {
        process.exit(0);
      }).catch(() => {
        process.exit(1);
      });
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    // ── Run ────────────────────────────────────────────────────────
    try {
      const exitCode = await interceptor.run();
      process.exit(exitCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[eigent-sidecar] Fatal error: ${message}\n`);
      process.exit(1);
    }
  });

// ── Parse CLI ──────────────────────────────────────────────────────────

program.parse();
