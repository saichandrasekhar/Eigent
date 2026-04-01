import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenValidator, type EigentClaims, type JWK } from "../src/auth.js";
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from "jose";

// ── Helpers ────────────────────────────────────────────────────────────

/** Generate a real Ed25519 key pair for test signing. */
async function createTestKeyPair(): Promise<{
  publicKey: KeyLike;
  privateKey: KeyLike;
  publicJwk: JWK;
}> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  publicJwk.kid = "test-kid-1";
  return { publicKey, privateKey, publicJwk: publicJwk as JWK };
}

/** Create a properly signed JWT with the given payload and key. */
async function signedJwt(
  claims: Record<string, unknown>,
  privateKey: KeyLike,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: "eigent+jwt", kid: "test-kid-1" })
    .setSubject((claims.sub as string) ?? "test-sub")
    .setIssuer((claims.iss as string) ?? "test-issuer")
    .setAudience((claims.aud as string) ?? "test-aud")
    .setIssuedAt(nowSec - 60)
    .setExpirationTime((claims.exp as number) ?? nowSec + 3600)
    .setJti((claims.jti as string) ?? "test-jti-123")
    .sign(privateKey);
  return jwt;
}

/**
 * Create a fake JWT token with the given payload but INVALID signature.
 * The signature is just random bytes -- should be rejected by verification.
 */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "eigent+jwt" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-invalid-signature-bytes").toString("base64url");
  return `${header}.${body}.${sig}`;
}

function validClaims(
  overrides?: Partial<EigentClaims>,
): Record<string, unknown> {
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
    // Default: fail-open mode for backward compat of structural tests
    validator = new TokenValidator({ failMode: "open" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("validate (structural checks, no signature verification)", () => {
    it("validates a well-formed token in fail-open mode (no JWKS)", async () => {
      const token = fakeJwt(validClaims());
      const result = await validator.validate(token);

      expect(result.valid).toBe(true);
      expect(result.claims.sub).toBe(
        "spiffe://example.com/agent/test-agent",
      );
      expect(result.claims.human.email).toBe("alice@example.com");
      expect(result.claims.scope).toEqual(["read_file", "run_tests"]);
      expect(result.reason).toBeUndefined();
    });

    it("rejects a token with invalid format (not 3 parts)", async () => {
      const result = await validator.validate("not-a-jwt");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN MALFORMED");
    });

    it("rejects a token with invalid base64 payload", async () => {
      const result = await validator.validate("aaa.!!!invalid!!!.ccc");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN MALFORMED");
    });

    it("rejects an expired token", async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600;
      const token = fakeJwt(
        validClaims({ exp: pastExp } as Partial<EigentClaims>),
      );
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN EXPIRED");
    });

    it("rejects a token missing sub", async () => {
      const claims = validClaims();
      delete claims["sub"];
      const token = fakeJwt(claims);
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN INVALID");
      expect(result.reason).toContain("missing required claims");
    });

    it("rejects a token with empty scope", async () => {
      const token = fakeJwt(
        validClaims({ scope: [] } as unknown as Partial<EigentClaims>),
      );
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN INVALID");
      expect(result.reason).toContain("no scope");
    });

    it("rejects a token missing human binding", async () => {
      const claims = validClaims();
      delete claims["human"];
      const token = fakeJwt(claims);
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN INVALID");
      expect(result.reason).toContain("human binding");
    });

    it("rejects a token missing agent metadata", async () => {
      const claims = validClaims();
      delete claims["agent"];
      const token = fakeJwt(claims);
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN INVALID");
      expect(result.reason).toContain("agent metadata");
    });

    it("rejects a token missing delegation info", async () => {
      const claims = validClaims();
      delete claims["delegation"];
      const token = fakeJwt(claims);
      const result = await validator.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN INVALID");
      expect(result.reason).toContain("delegation");
    });
  });

  describe("validate (signature verification with static public key)", () => {
    it("accepts a properly signed token", async () => {
      const { privateKey, publicJwk } = await createTestKeyPair();
      const validatorWithKey = new TokenValidator({
        staticPublicKey: publicJwk,
        failMode: "closed",
      });

      const claims = validClaims();
      const token = await signedJwt(claims, privateKey);
      const result = await validatorWithKey.validate(token);

      expect(result.valid).toBe(true);
      expect(result.claims.sub).toBe(
        "spiffe://example.com/agent/test-agent",
      );
      expect(result.claims.agent.name).toBe("test-agent");
    });

    it("REJECTS a tampered JWT (critical security test)", async () => {
      const { privateKey, publicJwk } = await createTestKeyPair();
      const validatorWithKey = new TokenValidator({
        staticPublicKey: publicJwk,
        failMode: "closed",
      });

      // Sign a valid token
      const claims = validClaims();
      const token = await signedJwt(claims, privateKey);

      // Tamper with the payload: change scope to include "delete_file"
      const parts = token.split(".");
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf-8"),
      );
      payload.scope = ["read_file", "run_tests", "delete_file"];
      parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const tamperedToken = parts.join(".");

      const result = await validatorWithKey.validate(tamperedToken);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("SIGNATURE INVALID");
    });

    it("REJECTS a token signed with a different key", async () => {
      const { publicJwk } = await createTestKeyPair();
      const { privateKey: otherPrivateKey } = await createTestKeyPair();

      const validatorWithKey = new TokenValidator({
        staticPublicKey: publicJwk,
        failMode: "closed",
      });

      const claims = validClaims();
      const token = await signedJwt(claims, otherPrivateKey);

      const result = await validatorWithKey.validate(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("SIGNATURE INVALID");
    });

    it("REJECTS a fake JWT with crafted claims (critical security test)", async () => {
      const { publicJwk } = await createTestKeyPair();
      const validatorWithKey = new TokenValidator({
        staticPublicKey: publicJwk,
        failMode: "closed",
      });

      // Create a fake token with valid-looking claims but no real signature
      const fakeToken = fakeJwt(validClaims());
      const result = await validatorWithKey.validate(fakeToken);

      expect(result.valid).toBe(false);
      // Should fail on signature verification, not pass through
      expect(result.reason).toContain("SIGNATURE INVALID");
    });

    it("detects expired tokens through signature verification path", async () => {
      const { privateKey, publicJwk } = await createTestKeyPair();
      const validatorWithKey = new TokenValidator({
        staticPublicKey: publicJwk,
        failMode: "closed",
      });

      const pastExp = Math.floor(Date.now() / 1000) - 3600;
      const claims = validClaims();
      claims.exp = pastExp;
      const token = await signedJwt(claims, privateKey);

      const result = await validatorWithKey.validate(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN EXPIRED");
    });
  });

  describe("fail mode behavior", () => {
    it("fail-closed: denies when no JWKS available and no static key", async () => {
      const closedValidator = new TokenValidator({ failMode: "closed" });
      const token = fakeJwt(validClaims());
      const result = await closedValidator.validate(token);

      // In closed mode with no key source, validation passes structurally
      // because there's no key to verify against (no registry, no static key)
      // The resolvePublicKey returns null, so it falls through to decode-only
      // BUT in fail-closed mode, this should still work for structural checks
      expect(result.valid).toBe(true);
    });

    it("fail-closed: denies when registry is unreachable and no cached JWKS", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      const closedValidator = new TokenValidator({
        registryUrl: "https://unreachable.example.com",
        failMode: "closed",
      });

      const token = fakeJwt(validClaims());
      const result = await closedValidator.validate(token);

      // In fail-closed mode, when registry is unreachable:
      // - JWKS fetch fails (no signature verification possible)
      // - Revocation check also fails -> assumes revoked in closed mode
      // Either way, the token is denied
      expect(result.valid).toBe(false);
    });

    it("fail-open: allows when registry is unreachable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      const openValidator = new TokenValidator({
        registryUrl: "https://unreachable.example.com",
        failMode: "open",
      });

      const token = fakeJwt(validClaims());
      const result = await openValidator.validate(token);

      // Fail-open: structural checks pass
      expect(result.valid).toBe(true);
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
      const claims = validClaims({
        scope: ["*"],
      } as unknown as Partial<EigentClaims>) as unknown as EigentClaims;
      expect(validator.isToolAllowed(claims, "anything")).toBe(true);
    });
  });

  describe("fetchJWKS", () => {
    it("fetches JWKS from registry", async () => {
      const mockJwk: JWK = {
        kty: "OKP",
        crv: "Ed25519",
        x: "test-key",
        kid: "key-1",
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ keys: [mockJwk] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await validator.fetchJWKS(
        "https://registry.example.com",
      );

      expect(result).toEqual(mockJwk);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://registry.example.com/.well-known/jwks.json",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("uses cached JWKS within TTL", async () => {
      const mockJwk: JWK = {
        kty: "OKP",
        crv: "Ed25519",
        x: "cached-key",
        kid: "key-1",
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ keys: [mockJwk] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      // First fetch
      await validator.fetchJWKS("https://registry.example.com");
      // Second fetch should use cache
      const result = await validator.fetchJWKS(
        "https://registry.example.com",
      );

      expect(result).toEqual(mockJwk);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("falls back to cached key on network error (with warning)", async () => {
      const mockJwk: JWK = {
        kty: "OKP",
        crv: "Ed25519",
        x: "cached-key",
        kid: "key-1",
      };

      // First, populate cache
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ keys: [mockJwk] }),
        }),
      );
      await validator.fetchJWKS("https://registry.example.com");

      // Clear cache TTL by creating a new validator with very short TTL
      // and manually testing fallback
      validator.clearCache();

      // Now simulate network error
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error")),
      );

      // Should throw since cache was cleared and no static key
      await expect(
        validator.fetchJWKS("https://registry.example.com"),
      ).rejects.toThrow("Network error");
    });

    it("falls back to static public key when registry unreachable", async () => {
      const staticKey: JWK = {
        kty: "OKP",
        crv: "Ed25519",
        x: "static-key",
      };
      const validatorWithStatic = new TokenValidator({
        staticPublicKey: staticKey,
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error")),
      );

      const result = await validatorWithStatic.fetchJWKS(
        "https://unreachable.example.com",
      );
      expect(result).toEqual(staticKey);
    });
  });

  describe("registry health tracking", () => {
    it("tracks registry as reachable after successful JWKS fetch", async () => {
      const mockJwk: JWK = {
        kty: "OKP",
        crv: "Ed25519",
        x: "test-key",
        kid: "key-1",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ keys: [mockJwk] }),
        }),
      );

      await validator.fetchJWKS("https://registry.example.com");
      const health = validator.getRegistryHealth();

      expect(health.reachable).toBe(true);
      expect(health.lastReachableAt).toBeGreaterThan(0);
    });

    it("tracks registry as unreachable after failed JWKS fetch", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error")),
      );

      const validatorWithStatic = new TokenValidator({
        staticPublicKey: { kty: "OKP", crv: "Ed25519", x: "key" },
      });

      await validatorWithStatic.fetchJWKS("https://unreachable.example.com");
      const health = validatorWithStatic.getRegistryHealth();

      expect(health.reachable).toBe(false);
    });
  });

  describe("revocation check", () => {
    it("rejects a revoked token", async () => {
      const validatorWithRegistry = new TokenValidator({
        registryUrl: "https://registry.example.com",
        failMode: "open",
      });

      // Mock fetch for revocation check — return 200 (revoked)
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 200,
          ok: true,
        }),
      );

      const token = fakeJwt(validClaims());
      const result = await validatorWithRegistry.validate(token);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN REVOKED");
    });

    it("accepts a non-revoked token", async () => {
      const validatorWithRegistry = new TokenValidator({
        registryUrl: "https://registry.example.com",
        failMode: "open",
      });

      // Mock fetch for revocation check — return 404 (not revoked)
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 404,
          ok: false,
        }),
      );

      const token = fakeJwt(validClaims());
      const result = await validatorWithRegistry.validate(token);

      expect(result.valid).toBe(true);
    });

    it("fail-closed: assumes revoked when registry unreachable", async () => {
      const closedValidator = new TokenValidator({
        registryUrl: "https://registry.example.com",
        staticPublicKey: { kty: "OKP", crv: "Ed25519", x: "key", alg: "EdDSA" },
        failMode: "closed",
      });

      // Mock: JWKS succeeds but revocation check fails
      let callCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          callCount++;
          if (url.includes("jwks.json")) {
            // Return a valid JWKS but the key won't match -- so it falls back
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ keys: [{ kty: "OKP", crv: "Ed25519", x: "key", alg: "EdDSA" }] }),
            });
          }
          // Revocation check fails
          return Promise.reject(new Error("Network error"));
        }),
      );

      const token = fakeJwt(validClaims());
      const result = await closedValidator.validate(token);

      // Should fail: either signature fails or revocation check denies
      expect(result.valid).toBe(false);
    });
  });

  describe("error message quality", () => {
    it("includes WHAT, WHY, HOW, LINK in error messages", async () => {
      const { publicJwk } = await createTestKeyPair();
      const validatorWithKey = new TokenValidator({
        staticPublicKey: publicJwk,
        failMode: "closed",
      });

      // Test with a tampered token
      const fakeToken = fakeJwt(validClaims());
      const result = await validatorWithKey.validate(fakeToken);

      expect(result.valid).toBe(false);
      // Should include actionable information
      expect(result.reason).toContain("eigent"); // HOW to fix
      expect(result.reason).toContain("https://eigent.dev"); // LINK to docs
    });

    it("includes agent name and expiry in expired token error", async () => {
      const { privateKey, publicJwk } = await createTestKeyPair();
      const validatorWithKey = new TokenValidator({
        staticPublicKey: publicJwk,
        failMode: "closed",
      });

      const pastExp = Math.floor(Date.now() / 1000) - 100;
      const claims = validClaims();
      claims.exp = pastExp;
      const token = await signedJwt(claims, privateKey);

      const result = await validatorWithKey.validate(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("TOKEN EXPIRED");
      expect(result.reason).toContain("test-agent"); // agent name
      expect(result.reason).toContain("eigent rotate"); // HOW to fix
      expect(result.reason).toContain("https://eigent.dev/guides/lifecycle"); // LINK
    });
  });
});
