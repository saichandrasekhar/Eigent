/**
 * Token validation module for the Eigent sidecar.
 *
 * Validates eigent JWTs by verifying cryptographic signatures via JWKS
 * fetched from the registry, checking expiry, and optionally checking
 * revocation status.
 */

import { jwtVerify, importJWK, type JWTPayload, type CryptoKey as JoseCryptoKey, type KeyObject as JoseKeyObject } from "jose";

/** Key type accepted by jose v6 for verification. */
type VerifyKey = JoseCryptoKey | JoseKeyObject | Uint8Array;

// ── Eigent claims types (aligned with eigent-core) ──────────────────────

export interface HumanBinding {
  sub: string;
  email: string;
  iss: string;
  groups: string[];
}

export interface AgentMetadata {
  name: string;
  model?: string;
  framework?: string;
}

export interface Delegation {
  depth: number;
  max_depth: number;
  chain: string[];
  can_delegate: string[];
}

export interface EigentClaims {
  // Standard JWT fields
  jti?: string;
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;

  // Eigent-specific
  human: HumanBinding;
  agent: AgentMetadata;
  scope: string[];
  delegation: Delegation;
}

export interface ValidationResult {
  valid: boolean;
  claims: EigentClaims;
  reason?: string;
}

export interface JWKSResponse {
  keys: JWK[];
}

export interface JWK {
  kty: string;
  crv?: string;
  x?: string;
  kid?: string;
  use?: string;
  alg?: string;
  [key: string]: unknown;
}

// ── JWKS cache entry ────────────────────────────────────────────────────

interface JwksCacheEntry {
  keys: JWK[];
  fetchedAt: number;
}

/** Default JWKS cache TTL: 5 minutes. */
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Fail mode ────────────────────────────────────────────────────────────

export type FailMode = "open" | "closed";

// ── Registry health tracking ─────────────────────────────────────────────

export interface RegistryHealth {
  reachable: boolean;
  lastCheckedAt: number;
  lastReachableAt: number | null;
}

// ── Token validator ─────────────────────────────────────────────────────

export class TokenValidator {
  private readonly registryUrl: string | undefined;
  private readonly staticPublicKey: JWK | undefined;
  private jwksCache: JwksCacheEntry | null = null;
  private readonly cacheTtlMs: number;
  private readonly failMode: FailMode;
  private registryHealth: RegistryHealth = {
    reachable: true,
    lastCheckedAt: 0,
    lastReachableAt: null,
  };

  constructor(options: {
    registryUrl?: string;
    staticPublicKey?: JWK;
    cacheTtlMs?: number;
    failMode?: FailMode;
  }) {
    this.registryUrl = options.registryUrl;
    this.staticPublicKey = options.staticPublicKey;
    this.cacheTtlMs = options.cacheTtlMs ?? JWKS_CACHE_TTL_MS;
    this.failMode = options.failMode ?? "closed";
  }

  /**
   * Validate an eigent token string.
   *
   * Performs full cryptographic signature verification using JWKS from the
   * registry (or a static public key), claims parsing, expiry checking,
   * and optional revocation checking.
   */
  async validate(token: string): Promise<ValidationResult> {
    // Split JWT
    const parts = token.split(".");
    if (parts.length !== 3) {
      return this.invalid(
        "TOKEN MALFORMED: Token is not a valid JWT (expected 3 parts). " +
        "Ensure you are passing a valid eigent token. " +
        "Run: eigent issue <agent-name> --scope <tools> to get a new token. " +
        "Docs: https://eigent.dev/guides/tokens"
      );
    }

    // ── Signature verification ──────────────────────────────────────
    let publicKey: VerifyKey | undefined;
    try {
      const jwk = await this.resolvePublicKey();
      if (jwk) {
        publicKey = await importJWK(jwk, jwk.alg ?? "EdDSA") as VerifyKey;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // If we cannot get a key and fail mode is closed, deny
      if (this.failMode === "closed") {
        return this.invalid(
          `REGISTRY UNREACHABLE: Cannot fetch signing keys. ${errMsg}. ` +
          `Is the registry running? Start with: eigent init or docker compose up. ` +
          `Docs: https://eigent.dev/getting-started`
        );
      }
      // fail open: log warning and skip signature check
      this.log(`WARNING: Cannot fetch JWKS, failing open: ${errMsg}`);
    }

    if (publicKey) {
      // Verify signature cryptographically
      let payload: JWTPayload;
      try {
        const result = await jwtVerify(token, publicKey, {
          algorithms: ["EdDSA"],
        });
        payload = result.payload;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("expired") || errMsg.includes('"exp" claim')) {
          // Decode payload for claims even on expiry
          let claims: EigentClaims;
          try {
            const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
            claims = JSON.parse(payloadJson) as EigentClaims;
          } catch {
            return this.invalid(
              "TOKEN EXPIRED: Token has expired and payload could not be decoded. " +
              "Run: eigent rotate <agent-name>. " +
              "Docs: https://eigent.dev/guides/lifecycle"
            );
          }
          return {
            valid: false,
            claims,
            reason:
              `TOKEN EXPIRED: Agent '${claims.agent?.name ?? claims.sub}' token expired` +
              (claims.exp ? ` at ${new Date(claims.exp * 1000).toISOString()}` : "") +
              `. Run: eigent rotate <agent-name>. ` +
              `Docs: https://eigent.dev/guides/lifecycle`,
          };
        }
        if (errMsg.includes("signature")) {
          return this.invalid(
            "SIGNATURE INVALID: Token signature verification failed. " +
            "The token may have been tampered with or signed with a different key. " +
            "Run: eigent issue <agent-name> --scope <tools> to get a new token. " +
            "Docs: https://eigent.dev/guides/tokens"
          );
        }
        return this.invalid(
          `TOKEN VERIFICATION FAILED: ${errMsg}. ` +
          `Run: eigent issue <agent-name> --scope <tools> to get a new token. ` +
          `Docs: https://eigent.dev/guides/tokens`
        );
      }

      // Extract claims from verified payload
      const claims = this.extractClaims(payload);
      if (!claims) {
        return this.invalid(
          "TOKEN INVALID: Verified token is missing required eigent claims (human, agent, scope, delegation). " +
          "Ensure the token was issued by eigent. " +
          "Docs: https://eigent.dev/concepts/tokens"
        );
      }

      // Validate required fields
      const fieldError = this.validateRequiredFields(claims);
      if (fieldError) {
        return fieldError;
      }

      // Check revocation (if registry is configured)
      if (this.registryUrl && claims.jti) {
        const revoked = await this.checkRevocation(claims.jti);
        if (revoked) {
          return {
            valid: false,
            claims,
            reason:
              `TOKEN REVOKED: Agent '${claims.agent.name}' token has been revoked. ` +
              `Run: eigent issue ${claims.agent.name} --scope ${claims.scope.join(",")} to get a new token. ` +
              `Docs: https://eigent.dev/guides/lifecycle`,
          };
        }
      }

      return { valid: true, claims };
    }

    // ── No public key available: decode-only fallback (fail-open mode) ──
    let claims: EigentClaims;
    try {
      const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
      claims = JSON.parse(payloadJson) as EigentClaims;
    } catch {
      return this.invalid(
        "TOKEN MALFORMED: Failed to decode token payload. " +
        "Run: eigent issue <agent-name> --scope <tools>. " +
        "Docs: https://eigent.dev/guides/tokens"
      );
    }

    // Validate required fields
    const fieldError = this.validateRequiredFields(claims);
    if (fieldError) {
      return fieldError;
    }

    // Check expiry
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === "number" && claims.exp < nowSec) {
      return {
        valid: false,
        claims,
        reason:
          `TOKEN EXPIRED: Agent '${claims.agent?.name ?? claims.sub}' token expired at ` +
          `${new Date(claims.exp * 1000).toISOString()}. ` +
          `Run: eigent rotate <agent-name>. ` +
          `Docs: https://eigent.dev/guides/lifecycle`,
      };
    }

    // Check revocation (if registry is configured)
    if (this.registryUrl && claims.jti) {
      const revoked = await this.checkRevocation(claims.jti);
      if (revoked) {
        return {
          valid: false,
          claims,
          reason:
            `TOKEN REVOKED: Agent '${claims.agent.name}' token has been revoked. ` +
            `Run: eigent issue ${claims.agent.name} --scope ${claims.scope.join(",")} to get a new token. ` +
            `Docs: https://eigent.dev/guides/lifecycle`,
        };
      }
    }

    return { valid: true, claims };
  }

  /**
   * Check if a tool name is allowed by the token's scope.
   */
  isToolAllowed(claims: EigentClaims, toolName: string): boolean {
    // Wildcard scope
    if (claims.scope.includes("*")) return true;

    return claims.scope.includes(toolName);
  }

  /**
   * Resolve the public key for verification.
   * Tries registry JWKS first, falls back to static key.
   */
  private async resolvePublicKey(): Promise<JWK | null> {
    if (this.registryUrl) {
      try {
        return await this.fetchJWKS(this.registryUrl);
      } catch {
        // Fall through to static key
      }
    }
    if (this.staticPublicKey) {
      return this.staticPublicKey;
    }
    return null;
  }

  /**
   * Fetch JWKS from the registry's well-known endpoint.
   */
  async fetchJWKS(registryUrl: string): Promise<JWK> {
    // Check cache first
    if (this.jwksCache && Date.now() - this.jwksCache.fetchedAt < this.cacheTtlMs) {
      if (this.jwksCache.keys.length > 0) {
        return this.jwksCache.keys[0];
      }
    }

    const url = `${registryUrl.replace(/\/+$/, "")}/.well-known/jwks.json`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
      }

      const jwks = (await response.json()) as JWKSResponse;

      if (!jwks.keys || jwks.keys.length === 0) {
        throw new Error("JWKS response contains no keys");
      }

      // Update registry health
      this.registryHealth = {
        reachable: true,
        lastCheckedAt: Date.now(),
        lastReachableAt: Date.now(),
      };

      // Cache the result
      this.jwksCache = {
        keys: jwks.keys,
        fetchedAt: Date.now(),
      };

      return jwks.keys[0];
    } catch (err) {
      // Update registry health
      this.registryHealth = {
        ...this.registryHealth,
        reachable: false,
        lastCheckedAt: Date.now(),
      };

      // Fallback: use cached key if available (with warning)
      if (this.jwksCache && this.jwksCache.keys.length > 0) {
        this.log(
          "WARNING: Registry unreachable, using cached JWKS. " +
          `Cache age: ${Math.round((Date.now() - this.jwksCache.fetchedAt) / 1000)}s`
        );
        return this.jwksCache.keys[0];
      }

      // Fallback: use static public key if configured
      if (this.staticPublicKey) {
        this.log("WARNING: Registry unreachable, using static public key.");
        return this.staticPublicKey;
      }

      throw err;
    }
  }

  /**
   * Get the current registry health status.
   */
  getRegistryHealth(): RegistryHealth {
    return { ...this.registryHealth };
  }

  /**
   * Get the current fail mode.
   */
  getFailMode(): FailMode {
    return this.failMode;
  }

  /**
   * Check if a token (by jti) has been revoked at the registry.
   */
  private async checkRevocation(jti: string): Promise<boolean> {
    if (!this.registryUrl) return false;

    const url = `${this.registryUrl.replace(/\/+$/, "")}/api/v1/revocations/${encodeURIComponent(jti)}`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3000),
      });

      // 200 means token is revoked; 404 means not revoked
      if (response.status === 200) return true;
      if (response.status === 404) return false;

      // On other errors, apply fail mode
      if (this.failMode === "closed") {
        return true; // Assume revoked in closed mode
      }
      return false;
    } catch {
      // Network error — apply fail mode
      this.registryHealth = {
        ...this.registryHealth,
        reachable: false,
        lastCheckedAt: Date.now(),
      };

      if (this.failMode === "closed") {
        this.log("WARNING: Cannot check revocation status (registry unreachable). Denying in fail-closed mode.");
        return true; // Assume revoked
      }
      this.log("WARNING: Cannot check revocation status (registry unreachable). Allowing in fail-open mode.");
      return false;
    }
  }

  /** Clear the JWKS cache (useful for testing). */
  clearCache(): void {
    this.jwksCache = null;
  }

  /**
   * Extract eigent claims from a verified JWT payload.
   */
  private extractClaims(payload: JWTPayload): EigentClaims | null {
    const p = payload as Record<string, unknown>;
    if (!p.human || !p.agent || !p.scope || !p.delegation) {
      return null;
    }

    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;

    return {
      jti: payload.jti,
      sub: (payload.sub ?? "") as string,
      iss: (payload.iss ?? "") as string,
      aud: (aud ?? "") as string,
      iat: (payload.iat ?? 0) as number,
      exp: (payload.exp ?? 0) as number,
      human: p.human as HumanBinding,
      agent: p.agent as AgentMetadata,
      scope: p.scope as string[],
      delegation: p.delegation as Delegation,
    };
  }

  /**
   * Validate required fields on claims.
   */
  private validateRequiredFields(claims: EigentClaims): ValidationResult | null {
    if (!claims.sub || !claims.iss || !claims.aud) {
      return this.invalid(
        "TOKEN INVALID: Token missing required claims (sub, iss, aud). " +
        "The token may have been created incorrectly. " +
        "Run: eigent issue <agent-name> --scope <tools>. " +
        "Docs: https://eigent.dev/concepts/tokens"
      );
    }

    if (!claims.scope || !Array.isArray(claims.scope) || claims.scope.length === 0) {
      return this.invalid(
        "TOKEN INVALID: Token has no scope. Every agent must have at least one permitted tool. " +
        "Run: eigent issue <agent-name> --scope <tools>. " +
        "Docs: https://eigent.dev/concepts/permissions"
      );
    }

    if (!claims.human || !claims.human.email) {
      return this.invalid(
        "TOKEN INVALID: Token missing human binding (no email). " +
        "Every agent token must be bound to a human operator. " +
        "Run: eigent login first, then eigent issue <agent-name>. " +
        "Docs: https://eigent.dev/concepts/human-binding"
      );
    }

    if (!claims.agent || !claims.agent.name) {
      return this.invalid(
        "TOKEN INVALID: Token missing agent metadata (no name). " +
        "Docs: https://eigent.dev/concepts/tokens"
      );
    }

    if (!claims.delegation || typeof claims.delegation.depth !== "number") {
      return this.invalid(
        "TOKEN INVALID: Token missing delegation info. " +
        "Docs: https://eigent.dev/concepts/delegation"
      );
    }

    return null;
  }

  private invalid(reason: string): ValidationResult {
    return {
      valid: false,
      claims: {
        sub: "",
        iss: "",
        aud: "",
        iat: 0,
        exp: 0,
        human: { sub: "", email: "", iss: "", groups: [] },
        agent: { name: "" },
        scope: [],
        delegation: { depth: 0, max_depth: 0, chain: [], can_delegate: [] },
      },
      reason,
    };
  }

  private log(message: string): void {
    process.stderr.write(`[eigent-sidecar] ${message}\n`);
  }
}
