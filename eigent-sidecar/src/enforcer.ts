/**
 * Policy enforcement module for the Eigent sidecar.
 *
 * Evaluates whether a given tool call should be allowed, denied,
 * or logged based on the token claims, the enforcement mode, and
 * optional YAML policy rules.
 */

import type { EigentClaims } from "./auth.js";
import { TokenValidator } from "./auth.js";
import { PolicyEvaluator, type PolicyConfig, type PolicyEvalResult } from "./policy.js";

// ── Types ───────────────────────────────────────────────────────────────

export type EnforcementMode = "enforce" | "monitor" | "permissive";

export interface PolicyDecision {
  action: "allow" | "deny" | "log_only" | "require_approval";
  reason: string;
  /** Name of the YAML policy rule that matched, if any. */
  policy_rule_name?: string;
  /** Action from the YAML policy rule, if any. */
  policy_action?: string;
  /** Reason from the YAML policy rule, if any. */
  policy_reason?: string;
}

// ── Policy enforcer ─────────────────────────────────────────────────────

export class PolicyEnforcer {
  private readonly mode: EnforcementMode;
  private readonly validator: TokenValidator;
  private policyEvaluator: PolicyEvaluator | null = null;

  constructor(mode: EnforcementMode, validator: TokenValidator, policyConfig?: PolicyConfig) {
    this.mode = mode;
    this.validator = validator;
    if (policyConfig) {
      this.policyEvaluator = new PolicyEvaluator(policyConfig);
    }
  }

  /**
   * Update the YAML policy configuration (for hot-reload).
   */
  updatePolicy(config: PolicyConfig): void {
    this.policyEvaluator = new PolicyEvaluator(config);
  }

  /**
   * Clear the YAML policy configuration.
   */
  clearPolicy(): void {
    this.policyEvaluator = null;
  }

  /**
   * Evaluate whether a tool call should be allowed or denied.
   *
   * Evaluation order:
   * 1. Non-tool-call methods are always allowed.
   * 2. Token scope check (binary allow/deny).
   * 3. YAML policy rules (if configured) are evaluated AFTER token validation.
   *    A policy deny overrides a token allow.
   *
   * @param claims   - Parsed eigent claims, or null if no token was provided.
   * @param method   - The JSON-RPC method (e.g. "tools/call").
   * @param toolName - The specific tool name being called.
   * @param toolArgs - Arguments passed to the tool call.
   * @returns PolicyDecision with action and reason.
   */
  evaluate(
    claims: EigentClaims | null,
    method: string,
    toolName: string,
    toolArgs?: Record<string, unknown>,
  ): PolicyDecision {
    // Only enforce on tools/call -- other methods pass through
    if (method !== "tools/call") {
      return { action: "allow", reason: "Non-tool-call method; always allowed" };
    }

    // No token present
    if (claims === null) {
      const noTokenDecision = this.decideNoToken(toolName);

      // Even without a token, check policy rules (they may match on agent_id: null)
      if (this.policyEvaluator) {
        const policyResult = this.policyEvaluator.evaluate(toolName, null, toolArgs);
        const merged = this.mergeWithPolicy(noTokenDecision, policyResult);
        return merged;
      }

      return noTokenDecision;
    }

    // Token present -- check if tool is in scope
    const allowed = this.validator.isToolAllowed(claims, toolName);

    if (allowed) {
      const baseDecision: PolicyDecision = {
        action: "allow",
        reason: `Tool '${toolName}' is in agent scope`,
      };

      // Apply YAML policy rules (may override token allow with deny)
      if (this.policyEvaluator) {
        const policyResult = this.policyEvaluator.evaluate(toolName, claims, toolArgs);
        return this.mergeWithPolicy(baseDecision, policyResult);
      }

      return baseDecision;
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

  /**
   * Check if a YAML policy is loaded.
   */
  hasPolicy(): boolean {
    return this.policyEvaluator !== null;
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

  /**
   * Merge a base decision from token-scope check with a YAML policy result.
   *
   * Policy rules can escalate (allow -> deny) but the enforcement mode
   * still governs the final behaviour for deny/log decisions.
   */
  private mergeWithPolicy(
    baseDecision: PolicyDecision,
    policyResult: PolicyEvalResult,
  ): PolicyDecision {
    const result: PolicyDecision = { ...baseDecision };

    if (policyResult.rule_name) {
      result.policy_rule_name = policyResult.rule_name;
      result.policy_action = policyResult.action;
      result.policy_reason = policyResult.reason;
    }

    switch (policyResult.action) {
      case "deny": {
        const reason = policyResult.reason;
        switch (this.mode) {
          case "enforce":
            return { ...result, action: "deny", reason };
          case "monitor":
            return { ...result, action: "log_only", reason };
          case "permissive":
            return { ...result, action: "allow", reason };
        }
        break;
      }
      case "log":
        // Log action: always log regardless of mode, but don't block
        return { ...result, action: baseDecision.action, reason: policyResult.reason };
      case "require_approval":
        switch (this.mode) {
          case "enforce":
            return { ...result, action: "require_approval", reason: policyResult.reason };
          case "monitor":
            return { ...result, action: "log_only", reason: policyResult.reason };
          case "permissive":
            return { ...result, action: "allow", reason: policyResult.reason };
        }
        break;
      case "allow":
        // Policy explicitly allows -- keep the base decision
        return { ...result, reason: policyResult.reason };
    }

    return result;
  }
}
