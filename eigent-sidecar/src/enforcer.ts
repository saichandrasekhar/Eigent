/**
 * Policy enforcement module for the Eigent sidecar.
 *
 * Evaluates whether a given tool call should be allowed, denied,
 * or logged based on the token claims and the enforcement mode.
 */

import type { EigentClaims } from "./auth.js";
import { TokenValidator } from "./auth.js";

// ── Types ───────────────────────────────────────────────────────────────

export type EnforcementMode = "enforce" | "monitor" | "permissive";

export interface PolicyDecision {
  action: "allow" | "deny" | "log_only";
  reason: string;
}

// ── Policy enforcer ─────────────────────────────────────────────────────

export class PolicyEnforcer {
  private readonly mode: EnforcementMode;
  private readonly validator: TokenValidator;

  constructor(mode: EnforcementMode, validator: TokenValidator) {
    this.mode = mode;
    this.validator = validator;
  }

  /**
   * Evaluate whether a tool call should be allowed or denied.
   *
   * @param claims - Parsed eigent claims, or null if no token was provided.
   * @param method - The JSON-RPC method (e.g. "tools/call").
   * @param toolName - The specific tool name being called.
   * @returns PolicyDecision with action and reason.
   */
  evaluate(
    claims: EigentClaims | null,
    method: string,
    toolName: string,
  ): PolicyDecision {
    // Only enforce on tools/call — other methods pass through
    if (method !== "tools/call") {
      return { action: "allow", reason: "Non-tool-call method; always allowed" };
    }

    // No token present
    if (claims === null) {
      return this.decideNoToken(toolName);
    }

    // Token present — check if tool is in scope
    const allowed = this.validator.isToolAllowed(claims, toolName);

    if (allowed) {
      return {
        action: "allow",
        reason: `Tool '${toolName}' is in agent scope`,
      };
    }

    // Tool not in scope
    return this.decideDenied(claims, toolName);
  }

  /**
   * Get the current enforcement mode.
   */
  getMode(): EnforcementMode {
    return this.mode;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private decideNoToken(toolName: string): PolicyDecision {
    const reason = `No eigent token provided for tool '${toolName}'`;

    switch (this.mode) {
      case "enforce":
        return { action: "deny", reason };
      case "monitor":
        return { action: "log_only", reason };
      case "permissive":
        return { action: "allow", reason };
    }
  }

  private decideDenied(claims: EigentClaims, toolName: string): PolicyDecision {
    const scopeList = claims.scope.join(", ");
    const reason = `Tool '${toolName}' is not in agent scope [${scopeList}]`;

    switch (this.mode) {
      case "enforce":
        return { action: "deny", reason };
      case "monitor":
        return { action: "log_only", reason };
      case "permissive":
        return { action: "allow", reason };
    }
  }
}
