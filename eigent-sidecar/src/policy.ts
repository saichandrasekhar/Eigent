/**
 * YAML policy engine types and evaluation logic for the Eigent sidecar.
 *
 * Provides fine-grained, rule-based policy evaluation beyond the binary
 * token-scope check. Rules can match on tool name, agent identity, human
 * email, delegation depth, time windows, and tool call arguments.
 */

import type { EigentClaims } from "./auth.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface PolicyRule {
  name: string;
  description?: string;
  match: {
    tool?: string | string[];
    agent_id?: string | string[] | null;
    human_email?: string | string[];
    delegation_depth?: { gt?: number; lt?: number; eq?: number };
    time_window?: { after?: string; before?: string; days?: string[] };
    arguments?: Record<string, string>;
  };
  action: "allow" | "deny" | "log" | "require_approval";
  reason?: string;
  priority?: number;
}

export interface PolicyConfig {
  version: "1";
  default_action: "allow" | "deny";
  rules: PolicyRule[];
}

export interface PolicyEvalResult {
  action: "allow" | "deny" | "log" | "require_approval";
  rule_name: string | null;
  reason: string;
}

// ── Glob matching utility ───────────────────────────────────────────────

/**
 * Simple glob matching: supports `*` as wildcard for any characters.
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  // Escape regex special chars except `*`, then replace `*` with `.*`
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

// ── Time utilities ──────────────────────────────────────────────────────

/**
 * Parse "HH:MM" to minutes since midnight.
 */
function parseTimeToMinutes(time: string): number {
  const parts = time.split(":");
  if (parts.length !== 2) return -1;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes)) return -1;
  return hours * 60 + minutes;
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// ── Policy evaluator ────────────────────────────────────────────────────

export class PolicyEvaluator {
  private readonly config: PolicyConfig;
  /** Rules sorted by priority descending, then original index ascending. */
  private readonly sortedRules: PolicyRule[];

  constructor(config: PolicyConfig) {
    this.config = config;
    // Sort rules: higher priority first; within same priority, preserve file order
    this.sortedRules = [...config.rules].sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      return pb - pa;
    });
  }

  /**
   * Evaluate a tool call against the policy rules.
   *
   * @param toolName - The tool being called.
   * @param claims   - Parsed eigent claims, or null if no token.
   * @param toolArgs - Arguments passed to the tool call.
   * @param now      - Optional Date override for testing time windows.
   */
  evaluate(
    toolName: string,
    claims: EigentClaims | null,
    toolArgs?: Record<string, unknown>,
    now?: Date,
  ): PolicyEvalResult {
    const currentTime = now ?? new Date();

    for (const rule of this.sortedRules) {
      if (this.ruleMatches(rule, toolName, claims, toolArgs, currentTime)) {
        return {
          action: rule.action,
          rule_name: rule.name,
          reason: rule.reason ?? `Matched rule '${rule.name}'`,
        };
      }
    }

    // No rule matched — use default_action
    return {
      action: this.config.default_action,
      rule_name: null,
      reason: `No matching rule; default action '${this.config.default_action}'`,
    };
  }

  getConfig(): PolicyConfig {
    return this.config;
  }

  // ── Private matching ────────────────────────────────────────────────

  private ruleMatches(
    rule: PolicyRule,
    toolName: string,
    claims: EigentClaims | null,
    toolArgs: Record<string, unknown> | undefined,
    now: Date,
  ): boolean {
    const { match } = rule;

    // Tool name matching
    if (match.tool !== undefined) {
      const patterns = Array.isArray(match.tool) ? match.tool : [match.tool];
      const toolMatched = patterns.some((p) => globMatch(p, toolName));
      if (!toolMatched) return false;
    }

    // Agent ID matching (null means "no agent / unauthenticated")
    if ("agent_id" in match) {
      if (match.agent_id === null) {
        // Match only when there are no claims (unauthenticated)
        if (claims !== null) return false;
      } else {
        const agentId = claims?.agent?.name ?? null;
        const patterns = Array.isArray(match.agent_id) ? match.agent_id : [match.agent_id];
        if (agentId === null) return false;
        const agentMatched = patterns.some((p) => p !== undefined && globMatch(p, agentId as string));
        if (!agentMatched) return false;
      }
    }

    // Human email matching
    if (match.human_email !== undefined) {
      const email = claims?.human?.email ?? null;
      if (email === null) return false;
      const patterns = Array.isArray(match.human_email) ? match.human_email : [match.human_email];
      const emailMatched = patterns.some((p) => globMatch(p, email));
      if (!emailMatched) return false;
    }

    // Delegation depth matching
    if (match.delegation_depth !== undefined) {
      const depth = claims?.delegation?.depth;
      if (depth === undefined || depth === null) return false;
      const { gt, lt, eq } = match.delegation_depth;
      if (gt !== undefined && !(depth > gt)) return false;
      if (lt !== undefined && !(depth < lt)) return false;
      if (eq !== undefined && !(depth === eq)) return false;
    }

    // Time window matching
    if (match.time_window !== undefined) {
      if (!this.timeWindowMatches(match.time_window, now)) return false;
    }

    // Arguments regex matching
    if (match.arguments !== undefined && toolArgs !== undefined) {
      for (const [key, pattern] of Object.entries(match.arguments)) {
        const argValue = toolArgs[key];
        if (argValue === undefined || argValue === null) return false;
        const regex = new RegExp(pattern);
        if (!regex.test(String(argValue))) return false;
      }
    } else if (match.arguments !== undefined && toolArgs === undefined) {
      // Rule requires argument matching but no arguments provided
      return false;
    }

    return true;
  }

  /**
   * Check if the current time falls within the time window.
   *
   * The `after` and `before` fields define the EXCLUDED range:
   * - `before: "08:00"` means block calls BEFORE 8 AM (i.e., 00:00-07:59)
   * - `after: "18:00"` means block calls AFTER 6 PM (i.e., 18:01-23:59)
   *
   * When both are specified, they define "outside business hours":
   * - `before: "08:00", after: "18:00"` matches times < 08:00 OR > 18:00
   *
   * The `days` field matches on specific day names (e.g., ["mon", "tue"]).
   */
  private timeWindowMatches(
    window: { after?: string; before?: string; days?: string[] },
    now: Date,
  ): boolean {
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const currentDay = DAY_NAMES[now.getDay()];

    // Check days filter
    if (window.days !== undefined) {
      const lowerDays = window.days.map((d) => d.toLowerCase());
      if (!lowerDays.includes(currentDay)) return false;
    }

    // Check time range
    const hasAfter = window.after !== undefined;
    const hasBefore = window.before !== undefined;

    if (hasAfter && hasBefore) {
      const afterMinutes = parseTimeToMinutes(window.after!);
      const beforeMinutes = parseTimeToMinutes(window.before!);
      // Outside-hours pattern: matches when time < before OR time >= after
      return currentMinutes < beforeMinutes || currentMinutes >= afterMinutes;
    }

    if (hasBefore) {
      const beforeMinutes = parseTimeToMinutes(window.before!);
      return currentMinutes < beforeMinutes;
    }

    if (hasAfter) {
      const afterMinutes = parseTimeToMinutes(window.after!);
      return currentMinutes >= afterMinutes;
    }

    return true;
  }
}
