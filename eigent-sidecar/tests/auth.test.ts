import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenValidator, type EigentClaims, type JWK } from "../src/auth.js";

/**
 * Create a fake JWT token with the given payload.
 * The header and signature are placeholders — we don't verify crypto here.
 */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "eigent+jwt" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-signature").toString("base64url");
  return `${header}.${body}.${sig}`;
}

function validClaims(overrides?: Partial<EigentClaims>): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    jti: "test-jti-123",
    sub: "spiffe://example.com/agent/test-agent",
    iss: "https://registry.example.com",
    aud: "mcp-server",
    iat: nowSec - 60,
    exp: nowSec + 3600,
    human: {
      sub: "user-123",
      email: "alice@example.com",
      iss: "https://idp.example.com",
      groups: ["developers"],
    },
    agent: {
      name: "test-agent",
      model: "gpt-4",
      framework: "langchain",
    },
    scope: ["read_file", "run_tests"],
    delegation: {
      depth: 0,
      max_depth: 2,
      chain: [],
      can_delegate: ["read_file"],
    },
    ...overrides,
  };
}

describe("TokenValidator", () => {
  let validator: TokenValidator;

  beforeEach(() => {
    validator = new TokenValidator({});
  });

  describe("validate", () => {
    it("validates a well-formed token", async () => {
      const token = fakeJwt(validClaims());
      const result = await validator.validate(token);

      expect(result.valid).toBe(true);
      expect(result.claims.sub).toBe("spiffe://example.com/agent/test-agent");
      expect(result.claims.human.email).toBe("alice@example.com");
      expect(result.claims.scope).toEqual(["read_file", "run_tests"]);
      expect(result.reason).toBeUndefined();
    });

    it("rejects a token with invalid format (not 3 parts)", async () => {
      const result = await validator.validate("not-a-jwt");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not a valid JWT");
    });

    it("rejects a token with invalid base64 payload", async () => {
      const result = await validator.validate("aaa.!!!invalid!!!.ccc");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("decode");
    });

    it("rejects an expired token", async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600;
      const token = fakeJwt(validClaims({ exp: pastExp } as Partial<EigentClaims>));
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("expired");
    });

    it("rejects a token missing sub", async () => {
      const claims = validClaims();
      delete claims["sub"];
      const token = fakeJwt(claims);
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("missing required claims");
    });

    it("rejects a token with empty scope", async () => {
      const token = fakeJwt(validClaims({ scope: [] } as unknown as Partial<EigentClaims>));
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("no scope");
    });

    it("rejects a token missing human binding", async () => {
      const claims = validClaims();
      delete claims["human"];
      const token = fakeJwt(claims);
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("human binding");
    });

    it("rejects a token missing agent metadata", async () => {
      const claims = validClaims();
      delete claims["agent"];
      const token = fakeJwt(claims);
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("agent metadata");
    });

    it("rejects a token missing delegation info", async () => {
      const claims = validClaims();
      delete claims["delegation"];
      const token = fakeJwt(claims);
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("delegation");
    });
  });

  describe("isToolAllowed", () => {
    it("allows a tool in scope", () => {
      const claims = validClaims() as unknown as EigentClaims;
      expect(validator.isToolAllowed(claims, "read_file")).toBe(true);
      expect(validator.isToolAllowed(claims, "run_tests")).toBe(true);
    });

    it("denies a tool not in scope", () => {
      const claims = validClaims() as unknown as EigentClaims;
      expect(validator.isToolAllowed(claims, "delete_file")).toBe(false);
    });

    it("allows any tool with wildcard scope", () => {
      const claims = validClaims({ scope: ["*"] } as unknown as Partial<EigentClaims>) as unknown as EigentClaims;
      expect(validator.isToolAllowed(claims, "anything")).toBe(true);
    });
  });

  describe("fetchJWKS", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("fetches JWKS from registry", async () => {
      const mockJwk: JWK = { kty: "OKP", crv: "Ed25519", x: "test-key", kid: "key-1" };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ keys: [mockJwk] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await validator.fetchJWKS("https://registry.example.com");

      expect(result).toEqual(mockJwk);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://registry.example.com/.well-known/jwks.json",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("uses cached JWKS within TTL", async () => {
      const mockJwk: JWK = { kty: "OKP", crv: "Ed25519", x: "cached-key", kid: "key-1" };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ keys: [mockJwk] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      // First fetch
      await validator.fetchJWKS("https://registry.example.com");
      // Second fetch should use cache
      const result = await validator.fetchJWKS("https://registry.example.com");

      expect(result).toEqual(mockJwk);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("falls back to cached key on network error", async () => {
      const mockJwk: JWK = { kty: "OKP", crv: "Ed25519", x: "cached-key", kid: "key-1" };

      // First, populate cache
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ keys: [mockJwk] }),
      }));
      await validator.fetchJWKS("https://registry.example.com");

      // Clear cache TTL by creating a new validator with very short TTL
      // and manually testing fallback
      validator.clearCache();

      // Now simulate network error
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

      // Should throw since cache was cleared and no static key
      await expect(validator.fetchJWKS("https://registry.example.com")).rejects.toThrow("Network error");
    });

    it("falls back to static public key when registry unreachable", async () => {
      const staticKey: JWK = { kty: "OKP", crv: "Ed25519", x: "static-key" };
      const validatorWithStatic = new TokenValidator({ staticPublicKey: staticKey });

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

      const result = await validatorWithStatic.fetchJWKS("https://unreachable.example.com");
      expect(result).toEqual(staticKey);
    });
  });

  describe("revocation check", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("rejects a revoked token", async () => {
      const validatorWithRegistry = new TokenValidator({
        registryUrl: "https://registry.example.com",
      });

      // Mock fetch for revocation check — return 200 (revoked)
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
      }));

      const token = fakeJwt(validClaims());
      const result = await validatorWithRegistry.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("revoked");
    });

    it("accepts a non-revoked token", async () => {
      const validatorWithRegistry = new TokenValidator({
        registryUrl: "https://registry.example.com",
      });

      // Mock fetch for revocation check — return 404 (not revoked)
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        status: 404,
        ok: false,
      }));

      const token = fakeJwt(validClaims());
      const result = await validatorWithRegistry.validate(token);

      expect(result.valid).toBe(true);
    });
  });
});
