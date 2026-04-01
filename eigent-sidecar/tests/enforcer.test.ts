import { describe, it, expect } from "vitest";
import { PolicyEnforcer, type EnforcementMode } from "../src/enforcer.js";
import { TokenValidator, type EigentClaims } from "../src/auth.js";

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

function createEnforcer(mode: EnforcementMode): PolicyEnforcer {
  const validator = new TokenValidator({});
  return new PolicyEnforcer(mode, validator);
}

describe("PolicyEnforcer", () => {
  describe("enforce mode", () => {
    const enforcer = createEnforcer("enforce");

    it("allows a tool in scope", () => {
      const claims = makeClaims(["read_file", "run_tests"]);
      const decision = enforcer.evaluate(claims, "tools/call", "read_file");

      expect(decision.action).toBe("allow");
      expect(decision.reason).toContain("in agent scope");
    });

    it("denies a tool not in scope", () => {
      const claims = makeClaims(["read_file", "run_tests"]);
      const decision = enforcer.evaluate(claims, "tools/call", "delete_file");

      expect(decision.action).toBe("deny");
      expect(decision.reason).toContain("delete_file");
      expect(decision.reason).toContain("not in agent scope");
    });

    it("denies when no token is present", () => {
      const decision = enforcer.evaluate(null, "tools/call", "read_file");

      expect(decision.action).toBe("deny");
      expect(decision.reason).toContain("No eigent token");
    });

    it("allows non-tool-call methods", () => {
      const decision = enforcer.evaluate(null, "initialize", "");

      expect(decision.action).toBe("allow");
      expect(decision.reason).toContain("Non-tool-call");
    });

    it("allows wildcard scope", () => {
      const claims = makeClaims(["*"]);
      const decision = enforcer.evaluate(claims, "tools/call", "anything");

      expect(decision.action).toBe("allow");
    });
  });

  describe("monitor mode", () => {
    const enforcer = createEnforcer("monitor");

    it("logs (not denies) a tool not in scope", () => {
      const claims = makeClaims(["read_file"]);
      const decision = enforcer.evaluate(claims, "tools/call", "delete_file");

      expect(decision.action).toBe("log_only");
      expect(decision.reason).toContain("delete_file");
      expect(decision.reason).toContain("not in agent scope");
    });

    it("logs when no token is present", () => {
      const decision = enforcer.evaluate(null, "tools/call", "read_file");

      expect(decision.action).toBe("log_only");
      expect(decision.reason).toContain("No eigent token");
    });

    it("allows a tool in scope", () => {
      const claims = makeClaims(["read_file"]);
      const decision = enforcer.evaluate(claims, "tools/call", "read_file");

      expect(decision.action).toBe("allow");
    });
  });

  describe("permissive mode", () => {
    const enforcer = createEnforcer("permissive");

    it("allows a tool not in scope", () => {
      const claims = makeClaims(["read_file"]);
      const decision = enforcer.evaluate(claims, "tools/call", "delete_file");

      expect(decision.action).toBe("allow");
    });

    it("allows when no token is present", () => {
      const decision = enforcer.evaluate(null, "tools/call", "read_file");

      expect(decision.action).toBe("allow");
    });

    it("allows a tool in scope", () => {
      const claims = makeClaims(["read_file"]);
      const decision = enforcer.evaluate(claims, "tools/call", "read_file");

      expect(decision.action).toBe("allow");
    });
  });

  describe("getMode", () => {
    it("returns the configured mode", () => {
      expect(createEnforcer("enforce").getMode()).toBe("enforce");
      expect(createEnforcer("monitor").getMode()).toBe("monitor");
      expect(createEnforcer("permissive").getMode()).toBe("permissive");
    });
  });
});
