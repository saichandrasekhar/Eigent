import { describe, it, expect } from "vitest";
import { PolicyEvaluator, type PolicyConfig, type PolicyRule } from "../src/policy.js";
import type { EigentClaims } from "../src/auth.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeClaims(overrides?: Partial<EigentClaims>): EigentClaims {
  return {
    jti: "test-jti",
    sub: "spiffe://example.com/agent/test-agent",
    iss: "https://registry.example.com",
    aud: "mcp-server",
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
    human: {
      sub: "user-123",
      email: "alice@example.com",
      iss: "https://idp.example.com",
      groups: ["developers"],
    },
    agent: {
      name: "test-agent",
      model: "gpt-4",
    },
    scope: ["*"],
    delegation: {
      depth: 0,
      max_depth: 2,
      chain: [],
      can_delegate: [],
    },
    ...overrides,
  };
}

function makeConfig(rules: PolicyRule[], defaultAction: "allow" | "deny" = "allow"): PolicyConfig {
  return {
    version: "1",
    default_action: defaultAction,
    rules,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("PolicyEvaluator", () => {
  describe("tool name matching", () => {
    it("matches an exact tool name", () => {
      const config = makeConfig([
        { name: "block-write", match: { tool: "write_file" }, action: "deny", reason: "blocked" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("write_file", makeClaims());
      expect(result.action).toBe("deny");
      expect(result.rule_name).toBe("block-write");
    });

    it("does not match a different tool name", () => {
      const config = makeConfig([
        { name: "block-write", match: { tool: "write_file" }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("read_file", makeClaims());
      expect(result.action).toBe("allow");
      expect(result.rule_name).toBeNull();
    });

    it("matches tool name from an array", () => {
      const config = makeConfig([
        { name: "block-shells", match: { tool: ["bash", "execute_command", "run_shell"] }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      expect(evaluator.evaluate("bash", makeClaims()).action).toBe("deny");
      expect(evaluator.evaluate("execute_command", makeClaims()).action).toBe("deny");
      expect(evaluator.evaluate("read_file", makeClaims()).action).toBe("allow");
    });

    it("matches glob pattern with wildcard", () => {
      const config = makeConfig([
        { name: "block-all", match: { tool: "*" }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      expect(evaluator.evaluate("anything", makeClaims()).action).toBe("deny");
    });

    it("matches glob pattern with partial wildcard", () => {
      const config = makeConfig([
        { name: "block-db", match: { tool: "db_*" }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      expect(evaluator.evaluate("db_query", makeClaims()).action).toBe("deny");
      expect(evaluator.evaluate("db_write", makeClaims()).action).toBe("deny");
      expect(evaluator.evaluate("read_file", makeClaims()).action).toBe("allow");
    });
  });

  describe("agent_id matching", () => {
    it("matches a specific agent_id", () => {
      const config = makeConfig([
        { name: "agent-rule", match: { agent_id: "test-agent" }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("read_file", makeClaims({ agent: { name: "test-agent" } }));
      expect(result.action).toBe("deny");
    });

    it("does not match a different agent_id", () => {
      const config = makeConfig([
        { name: "agent-rule", match: { agent_id: "other-agent" }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("read_file", makeClaims({ agent: { name: "test-agent" } }));
      expect(result.action).toBe("allow");
    });

    it("matches null agent_id for unauthenticated requests", () => {
      const config = makeConfig([
        { name: "no-anon", match: { agent_id: null }, action: "deny", reason: "No anonymous" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("read_file", null);
      expect(result.action).toBe("deny");
      expect(result.reason).toBe("No anonymous");
    });

    it("does not match null agent_id when claims are present", () => {
      const config = makeConfig([
        { name: "no-anon", match: { agent_id: null }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("read_file", makeClaims());
      expect(result.action).toBe("allow");
    });
  });

  describe("human_email matching", () => {
    it("matches a specific email", () => {
      const config = makeConfig([
        { name: "email-rule", match: { human_email: "alice@example.com" }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("read_file", makeClaims());
      expect(result.action).toBe("deny");
    });

    it("matches email from array", () => {
      const config = makeConfig([
        { name: "email-rule", match: { human_email: ["alice@example.com", "bob@example.com"] }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      expect(evaluator.evaluate("read_file", makeClaims()).action).toBe("deny");
    });

    it("does not match without claims", () => {
      const config = makeConfig([
        { name: "email-rule", match: { human_email: "alice@example.com" }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      expect(evaluator.evaluate("read_file", null).action).toBe("allow");
    });
  });

  describe("delegation_depth matching", () => {
    it("matches depth greater than threshold", () => {
      const config = makeConfig([
        { name: "depth-rule", match: { delegation_depth: { gt: 1 } }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const claims = makeClaims({ delegation: { depth: 2, max_depth: 3, chain: [], can_delegate: [] } });
      expect(evaluator.evaluate("read_file", claims).action).toBe("deny");
    });

    it("does not match depth not greater than threshold", () => {
      const config = makeConfig([
        { name: "depth-rule", match: { delegation_depth: { gt: 1 } }, action: "deny" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const claims = makeClaims({ delegation: { depth: 1, max_depth: 3, chain: [], can_delegate: [] } });
      expect(evaluator.evaluate("read_file", claims).action).toBe("allow");
    });

    it("matches depth less than threshold", () => {
      const config = makeConfig([
        { name: "depth-rule", match: { delegation_depth: { lt: 2 } }, action: "log" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const claims = makeClaims({ delegation: { depth: 1, max_depth: 3, chain: [], can_delegate: [] } });
      expect(evaluator.evaluate("read_file", claims).action).toBe("log");
    });

    it("matches depth equal to value", () => {
      const config = makeConfig([
        { name: "depth-rule", match: { delegation_depth: { eq: 0 } }, action: "allow" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const claims = makeClaims({ delegation: { depth: 0, max_depth: 3, chain: [], can_delegate: [] } });
      expect(evaluator.evaluate("read_file", claims).action).toBe("allow");
    });

    it("supports combined depth conditions (gt + lt)", () => {
      const config = makeConfig([
        { name: "depth-range", match: { delegation_depth: { gt: 0, lt: 3 } }, action: "log" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const claimsInRange = makeClaims({ delegation: { depth: 2, max_depth: 5, chain: [], can_delegate: [] } });
      const claimsOutRange = makeClaims({ delegation: { depth: 0, max_depth: 5, chain: [], can_delegate: [] } });
      expect(evaluator.evaluate("read_file", claimsInRange).action).toBe("log");
      expect(evaluator.evaluate("read_file", claimsOutRange).action).toBe("allow");
    });
  });

  describe("time_window matching", () => {
    it("matches before a given time", () => {
      const config = makeConfig([
        { name: "early-morning", match: { time_window: { before: "08:00" } }, action: "log" },
      ]);
      const evaluator = new PolicyEvaluator(config);

      // 7:30 AM - should match (before 08:00)
      const earlyMorning = new Date(2025, 0, 6, 7, 30); // Monday
      expect(evaluator.evaluate("read_file", makeClaims(), undefined, earlyMorning).action).toBe("log");

      // 9:00 AM - should not match
      const morning = new Date(2025, 0, 6, 9, 0);
      expect(evaluator.evaluate("read_file", makeClaims(), undefined, morning).action).toBe("allow");
    });

    it("matches after a given time", () => {
      const config = makeConfig([
        { name: "late-evening", match: { time_window: { after: "18:00" } }, action: "log" },
      ]);
      const evaluator = new PolicyEvaluator(config);

      // 7:00 PM - should match (after 18:00)
      const evening = new Date(2025, 0, 6, 19, 0);
      expect(evaluator.evaluate("read_file", makeClaims(), undefined, evening).action).toBe("log");

      // 5:00 PM - should not match
      const afternoon = new Date(2025, 0, 6, 17, 0);
      expect(evaluator.evaluate("read_file", makeClaims(), undefined, afternoon).action).toBe("allow");
    });

    it("matches outside business hours (before + after)", () => {
      const config = makeConfig([
        {
          name: "outside-hours",
          match: { time_window: { before: "08:00", after: "18:00" } },
          action: "log",
          reason: "After-hours",
        },
      ]);
      const evaluator = new PolicyEvaluator(config);

      // 7:00 AM - outside hours (before 08:00)
      expect(evaluator.evaluate("x", makeClaims(), undefined, new Date(2025, 0, 6, 7, 0)).action).toBe("log");
      // 10:00 AM - inside hours
      expect(evaluator.evaluate("x", makeClaims(), undefined, new Date(2025, 0, 6, 10, 0)).action).toBe("allow");
      // 7:00 PM - outside hours (after 18:00)
      expect(evaluator.evaluate("x", makeClaims(), undefined, new Date(2025, 0, 6, 19, 0)).action).toBe("log");
    });

    it("matches specific days of the week", () => {
      const config = makeConfig([
        { name: "weekdays-only", match: { time_window: { days: ["mon", "tue", "wed", "thu", "fri"] } }, action: "allow" },
      ]);
      const evaluator = new PolicyEvaluator(config);

      // Monday Jan 6, 2025
      expect(evaluator.evaluate("x", makeClaims(), undefined, new Date(2025, 0, 6, 12, 0)).action).toBe("allow");
      // Saturday Jan 11, 2025
      expect(evaluator.evaluate("x", makeClaims(), undefined, new Date(2025, 0, 11, 12, 0)).action).toBe("allow"); // default_action
    });
  });

  describe("arguments regex matching", () => {
    it("matches argument with regex pattern", () => {
      const config = makeConfig([
        {
          name: "block-system-write",
          match: { tool: "write_file", arguments: { path: "^/etc/.*|^/usr/.*" } },
          action: "deny",
          reason: "System write blocked",
        },
      ]);
      const evaluator = new PolicyEvaluator(config);

      const result = evaluator.evaluate("write_file", makeClaims(), { path: "/etc/passwd" });
      expect(result.action).toBe("deny");
      expect(result.reason).toBe("System write blocked");
    });

    it("does not match when argument does not match regex", () => {
      const config = makeConfig([
        {
          name: "block-system-write",
          match: { tool: "write_file", arguments: { path: "^/etc/.*" } },
          action: "deny",
        },
      ]);
      const evaluator = new PolicyEvaluator(config);

      const result = evaluator.evaluate("write_file", makeClaims(), { path: "/home/user/file.txt" });
      expect(result.action).toBe("allow");
    });

    it("does not match when arguments are not provided", () => {
      const config = makeConfig([
        {
          name: "block-system-write",
          match: { tool: "write_file", arguments: { path: "^/etc/.*" } },
          action: "deny",
        },
      ]);
      const evaluator = new PolicyEvaluator(config);
      expect(evaluator.evaluate("write_file", makeClaims()).action).toBe("allow");
    });

    it("matches multiple argument conditions (all must match)", () => {
      const config = makeConfig([
        {
          name: "block-specific-query",
          match: {
            tool: "query_database",
            arguments: { database: "^production$", query: "DROP|DELETE" },
          },
          action: "deny",
        },
      ]);
      const evaluator = new PolicyEvaluator(config);

      // Both match
      expect(evaluator.evaluate("query_database", makeClaims(), { database: "production", query: "DROP TABLE users" }).action).toBe("deny");
      // Only one matches
      expect(evaluator.evaluate("query_database", makeClaims(), { database: "staging", query: "DROP TABLE users" }).action).toBe("allow");
    });
  });

  describe("priority ordering", () => {
    it("higher priority rules are evaluated first", () => {
      const config = makeConfig([
        { name: "allow-all", match: { tool: "*" }, action: "allow", priority: 0 },
        { name: "block-write", match: { tool: "write_file" }, action: "deny", priority: 100 },
      ]);
      const evaluator = new PolicyEvaluator(config);
      // block-write has higher priority, so it should win even though allow-all also matches
      expect(evaluator.evaluate("write_file", makeClaims()).action).toBe("deny");
      expect(evaluator.evaluate("write_file", makeClaims()).rule_name).toBe("block-write");
    });

    it("preserves file order for same priority", () => {
      const config = makeConfig([
        { name: "first-rule", match: { tool: "write_file" }, action: "deny" },
        { name: "second-rule", match: { tool: "write_file" }, action: "allow" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      // Both have priority 0 (default), first-rule appears first
      const result = evaluator.evaluate("write_file", makeClaims());
      expect(result.action).toBe("deny");
      expect(result.rule_name).toBe("first-rule");
    });
  });

  describe("default_action", () => {
    it("uses allow default when no rule matches", () => {
      const config = makeConfig(
        [{ name: "specific-rule", match: { tool: "special_tool" }, action: "deny" }],
        "allow",
      );
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("read_file", makeClaims());
      expect(result.action).toBe("allow");
      expect(result.rule_name).toBeNull();
    });

    it("uses deny default when no rule matches", () => {
      const config = makeConfig(
        [{ name: "allow-read", match: { tool: "read_file" }, action: "allow" }],
        "deny",
      );
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("write_file", makeClaims());
      expect(result.action).toBe("deny");
      expect(result.rule_name).toBeNull();
    });
  });

  describe("require_approval action", () => {
    it("returns require_approval when rule matches", () => {
      const config = makeConfig([
        {
          name: "approve-deploys",
          match: { tool: "deploy_*" },
          action: "require_approval",
          reason: "Deployments require human approval",
        },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("deploy_production", makeClaims());
      expect(result.action).toBe("require_approval");
      expect(result.reason).toBe("Deployments require human approval");
    });
  });

  describe("combined match criteria", () => {
    it("requires all match criteria to be true (AND logic)", () => {
      const config = makeConfig([
        {
          name: "block-deep-db",
          match: {
            tool: "query_database",
            delegation_depth: { gt: 1 },
            agent_id: "sub-agent",
          },
          action: "deny",
        },
      ]);
      const evaluator = new PolicyEvaluator(config);

      // All conditions met
      const deepSubAgent = makeClaims({
        agent: { name: "sub-agent" },
        delegation: { depth: 2, max_depth: 3, chain: [], can_delegate: [] },
      });
      expect(evaluator.evaluate("query_database", deepSubAgent).action).toBe("deny");

      // Tool doesn't match
      expect(evaluator.evaluate("read_file", deepSubAgent).action).toBe("allow");

      // Depth doesn't match
      const shallowSubAgent = makeClaims({
        agent: { name: "sub-agent" },
        delegation: { depth: 0, max_depth: 3, chain: [], can_delegate: [] },
      });
      expect(evaluator.evaluate("query_database", shallowSubAgent).action).toBe("allow");

      // Agent doesn't match
      const deepOtherAgent = makeClaims({
        agent: { name: "other-agent" },
        delegation: { depth: 2, max_depth: 3, chain: [], can_delegate: [] },
      });
      expect(evaluator.evaluate("query_database", deepOtherAgent).action).toBe("allow");
    });
  });

  describe("log action", () => {
    it("returns log action", () => {
      const config = makeConfig([
        { name: "log-all", match: { tool: "*" }, action: "log", reason: "Audit trail" },
      ]);
      const evaluator = new PolicyEvaluator(config);
      const result = evaluator.evaluate("anything", makeClaims());
      expect(result.action).toBe("log");
      expect(result.reason).toBe("Audit trail");
    });
  });

  describe("empty rule set", () => {
    it("falls back to default_action when no rules", () => {
      const allowConfig = makeConfig([], "allow");
      expect(new PolicyEvaluator(allowConfig).evaluate("x", makeClaims()).action).toBe("allow");

      const denyConfig = makeConfig([], "deny");
      expect(new PolicyEvaluator(denyConfig).evaluate("x", makeClaims()).action).toBe("deny");
    });
  });
});
