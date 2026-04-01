import { describe, it, expect } from "vitest";
import { PolicyEnforcer, type EnforcementMode } from "../src/enforcer.js";
import { TokenValidator, type EigentClaims } from "../src/auth.js";
import type { PolicyConfig } from "../src/policy.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeClaims(scope: string[], overrides?: Partial<EigentClaims>): EigentClaims {
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
    scope,
    delegation: {
      depth: 0,
      max_depth: 2,
      chain: [],
      can_delegate: [],
    },
    ...overrides,
  };
}

function createEnforcer(mode: EnforcementMode, policyConfig?: PolicyConfig): PolicyEnforcer {
  const validator = new TokenValidator({});
  return new PolicyEnforcer(mode, validator, policyConfig);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("PolicyEnforcer with YAML policy", () => {
  describe("token allows, policy blocks", () => {
    const policy: PolicyConfig = {
      version: "1",
      default_action: "allow",
      rules: [
        {
          name: "block-system-writes",
          match: {
            tool: "write_file",
            arguments: { path: "^/etc/.*|^/usr/.*|^/var/.*" },
          },
          action: "deny",
          reason: "Write to system directory blocked",
          priority: 100,
        },
      ],
    };

    it("denies in enforce mode when token allows but policy blocks", () => {
      const enforcer = createEnforcer("enforce", policy);
      const claims = makeClaims(["write_file"]);
      const decision = enforcer.evaluate(claims, "tools/call", "write_file", { path: "/etc/passwd" });

      expect(decision.action).toBe("deny");
      expect(decision.reason).toBe("Write to system directory blocked");
      expect(decision.policy_rule_name).toBe("block-system-writes");
    });

    it("allows in enforce mode when token allows and policy allows", () => {
      const enforcer = createEnforcer("enforce", policy);
      const claims = makeClaims(["write_file"]);
      const decision = enforcer.evaluate(claims, "tools/call", "write_file", { path: "/home/user/file.txt" });

      expect(decision.action).toBe("allow");
    });

    it("logs in monitor mode when policy blocks", () => {
      const enforcer = createEnforcer("monitor", policy);
      const claims = makeClaims(["write_file"]);
      const decision = enforcer.evaluate(claims, "tools/call", "write_file", { path: "/etc/passwd" });

      expect(decision.action).toBe("log_only");
      expect(decision.policy_rule_name).toBe("block-system-writes");
    });

    it("allows in permissive mode even when policy blocks", () => {
      const enforcer = createEnforcer("permissive", policy);
      const claims = makeClaims(["write_file"]);
      const decision = enforcer.evaluate(claims, "tools/call", "write_file", { path: "/etc/passwd" });

      expect(decision.action).toBe("allow");
      expect(decision.policy_rule_name).toBe("block-system-writes");
    });
  });

  describe("token denies, regardless of policy", () => {
    const policy: PolicyConfig = {
      version: "1",
      default_action: "allow",
      rules: [],
    };

    it("token deny takes precedence even with allow-all policy", () => {
      const enforcer = createEnforcer("enforce", policy);
      const claims = makeClaims(["read_file"]); // write_file not in scope
      const decision = enforcer.evaluate(claims, "tools/call", "write_file");

      expect(decision.action).toBe("deny");
      expect(decision.reason).toContain("not in agent scope");
    });
  });

  describe("no-anonymous-agents policy", () => {
    const policy: PolicyConfig = {
      version: "1",
      default_action: "allow",
      rules: [
        {
          name: "no-anonymous",
          match: { agent_id: null },
          action: "deny",
          reason: "Unauthenticated agents are not permitted",
          priority: 200,
        },
      ],
    };

    it("denies anonymous agents in enforce mode via policy", () => {
      const enforcer = createEnforcer("enforce", policy);
      const decision = enforcer.evaluate(null, "tools/call", "read_file");

      // The enforcer first decides "deny" for no token, then policy also says deny
      expect(decision.action).toBe("deny");
    });
  });

  describe("delegation depth policy", () => {
    const policy: PolicyConfig = {
      version: "1",
      default_action: "allow",
      rules: [
        {
          name: "restrict-db-by-depth",
          match: { tool: "query_database", delegation_depth: { gt: 1 } },
          action: "deny",
          reason: "Database access only allowed for direct agents (depth 0-1)",
        },
      ],
    };

    it("allows direct agents (depth 0) to query database", () => {
      const enforcer = createEnforcer("enforce", policy);
      const claims = makeClaims(["query_database"], {
        delegation: { depth: 0, max_depth: 3, chain: [], can_delegate: [] },
      });
      const decision = enforcer.evaluate(claims, "tools/call", "query_database");

      expect(decision.action).toBe("allow");
    });

    it("allows depth-1 agents to query database", () => {
      const enforcer = createEnforcer("enforce", policy);
      const claims = makeClaims(["query_database"], {
        delegation: { depth: 1, max_depth: 3, chain: ["parent"], can_delegate: [] },
      });
      const decision = enforcer.evaluate(claims, "tools/call", "query_database");

      expect(decision.action).toBe("allow");
    });

    it("denies depth-2+ agents from querying database", () => {
      const enforcer = createEnforcer("enforce", policy);
      const claims = makeClaims(["query_database"], {
        delegation: { depth: 2, max_depth: 3, chain: ["grandparent", "parent"], can_delegate: [] },
      });
      const decision = enforcer.evaluate(claims, "tools/call", "query_database");

      expect(decision.action).toBe("deny");
      expect(decision.policy_rule_name).toBe("restrict-db-by-depth");
    });
  });

  describe("require_approval action", () => {
    const policy: PolicyConfig = {
      version: "1",
      default_action: "allow",
      rules: [
        {
          name: "approve-deploys",
          match: { tool: "deploy_production" },
          action: "require_approval",
          reason: "Production deploys need human approval",
        },
      ],
    };

    it("returns require_approval in enforce mode", () => {
      const enforcer = createEnforcer("enforce", policy);
      const claims = makeClaims(["deploy_production"]);
      const decision = enforcer.evaluate(claims, "tools/call", "deploy_production");

      expect(decision.action).toBe("require_approval");
      expect(decision.reason).toBe("Production deploys need human approval");
    });

    it("returns log_only in monitor mode", () => {
      const enforcer = createEnforcer("monitor", policy);
      const claims = makeClaims(["deploy_production"]);
      const decision = enforcer.evaluate(claims, "tools/call", "deploy_production");

      expect(decision.action).toBe("log_only");
    });

    it("returns allow in permissive mode", () => {
      const enforcer = createEnforcer("permissive", policy);
      const claims = makeClaims(["deploy_production"]);
      const decision = enforcer.evaluate(claims, "tools/call", "deploy_production");

      expect(decision.action).toBe("allow");
    });
  });

  describe("policy hot-reload", () => {
    it("updates policy via updatePolicy()", () => {
      const initialPolicy: PolicyConfig = {
        version: "1",
        default_action: "allow",
        rules: [],
      };
      const enforcer = createEnforcer("enforce", initialPolicy);

      // Initially, write_file is allowed
      const claims = makeClaims(["write_file"]);
      expect(enforcer.evaluate(claims, "tools/call", "write_file").action).toBe("allow");

      // Hot-reload with a new policy that blocks write_file
      const updatedPolicy: PolicyConfig = {
        version: "1",
        default_action: "allow",
        rules: [
          { name: "block-writes", match: { tool: "write_file" }, action: "deny", reason: "Blocked" },
        ],
      };
      enforcer.updatePolicy(updatedPolicy);

      expect(enforcer.evaluate(claims, "tools/call", "write_file").action).toBe("deny");
    });

    it("clearPolicy() removes policy enforcement", () => {
      const policy: PolicyConfig = {
        version: "1",
        default_action: "allow",
        rules: [
          { name: "block-all", match: { tool: "*" }, action: "deny" },
        ],
      };
      const enforcer = createEnforcer("enforce", policy);
      const claims = makeClaims(["read_file"]);

      expect(enforcer.evaluate(claims, "tools/call", "read_file").action).toBe("deny");

      enforcer.clearPolicy();
      expect(enforcer.hasPolicy()).toBe(false);
      expect(enforcer.evaluate(claims, "tools/call", "read_file").action).toBe("allow");
    });
  });

  describe("non-tool-call methods bypass policy", () => {
    const policy: PolicyConfig = {
      version: "1",
      default_action: "deny",
      rules: [
        { name: "block-all", match: { tool: "*" }, action: "deny" },
      ],
    };

    it("always allows initialize method", () => {
      const enforcer = createEnforcer("enforce", policy);
      const decision = enforcer.evaluate(null, "initialize", "");
      expect(decision.action).toBe("allow");
    });
  });

  describe("backward compatibility without policy", () => {
    it("works exactly like before when no policy is provided", () => {
      const enforcer = createEnforcer("enforce");

      const claims = makeClaims(["read_file"]);
      expect(enforcer.evaluate(claims, "tools/call", "read_file").action).toBe("allow");
      expect(enforcer.evaluate(claims, "tools/call", "write_file").action).toBe("deny");
      expect(enforcer.evaluate(null, "tools/call", "read_file").action).toBe("deny");
      expect(enforcer.evaluate(null, "initialize", "").action).toBe("allow");
    });
  });
});
