#!/usr/bin/env node

/**
 * agentvault-sidecar — MCP stdio sidecar for agent telemetry.
 *
 * Wraps any MCP server command, transparently proxies stdio, and exports
 * OpenTelemetry spans for every JSON-RPC message that passes through.
 *
 * Usage:
 *   agentvault-sidecar wrap -- npx @modelcontextprotocol/server-filesystem /tmp
 *   agentvault-sidecar wrap --otel-endpoint http://localhost:4318 -- node my-server.js
 */

import { Command } from "commander";
import { McpInterceptor } from "./interceptor.js";

const program = new Command();

program
  .name("agentvault-sidecar")
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
    "--verbose",
    "Log intercepted messages to stderr",
    false,
  )
  .allowUnknownOption(false)
  .action(async (command: string, args: string[], options: {
    otelEndpoint: string;
    agentId?: string;
    verbose: boolean;
  }) => {
    const interceptor = new McpInterceptor({
      command,
      args,
      otelEndpoint: options.otelEndpoint,
      agentId: options.agentId,
      verbose: options.verbose,
    });

    // ── Graceful shutdown ──────────────────────────────────────────
    let stopping = false;

    const handleSignal = (signal: string) => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(
        `[agentvault-sidecar] Received ${signal}, shutting down...\n`,
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
      process.stderr.write(`[agentvault-sidecar] Fatal error: ${message}\n`);
      process.exit(1);
    }
  });

// ── Parse CLI ──────────────────────────────────────────────────────────

program.parse();
