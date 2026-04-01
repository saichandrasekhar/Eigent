/**
 * Token validation module for the Eigent sidecar.
 *
 * Validates eigent JWTs by checking structure, expiry, and optionally
 * verifying signatures via JWKS fetched from the registry.
 * Also checks revocation status against the registry.
 */

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
}

// ── JWKS cache entry ────────────────────────────────────────────────────

interface JwksCacheEntry {
  keys: JWK[];
  fetchedAt: number;
}

/** Default JWKS cache TTL: 5 minutes. */
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Token validator ─────────────────────────────────────────────────────

export class TokenValidator {
  private readonly registryUrl: string | undefined;
  private readonly staticPublicKey: JWK | undefined;
  private jwksCache: JwksCacheEntry | null = null;
  private readonly cacheTtlMs: number;

  constructor(options: {
    registryUrl?: string;
    staticPublicKey?: JWK;
    cacheTtlMs?: number;
  }) {
    this.registryUrl = options.registryUrl;
    this.staticPublicKey = options.staticPublicKey;
    this.cacheTtlMs = options.cacheTtlMs ?? JWKS_CACHE_TTL_MS;
  }

  /**
   * Validate an eigent token string.
   *
   * This performs structural validation (base64url-encoded JWT with three parts),
   * claims parsing, expiry checking, and optional revocation checking.
   *
   * Note: Full cryptographic signature verification requires the `jose` library
   * which is not a current dependency. This validator checks structure, claims,
   * and expiry. In production, add `jose` for proper JWS verification.
   */
  async validate(token: string): Promise<ValidationResult> {
    // Split JWT
    const parts = token.split(".");
    if (parts.length !== 3) {
      return this.invalid("Token is not a valid JWT (expected 3 parts)");
    }

    // Decode payload
    let claims: EigentClaims;
    try {
      const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
      claims = JSON.parse(payloadJson) as EigentClaims;
    } catch {
      return this.invalid("Failed to decode token payload");
    }

    // Validate required fields
    if (!claims.sub || !claims.iss || !claims.aud) {
      return this.invalid("Token missing required claims (sub, iss, aud)");
    }

    if (!claims.scope || !Array.isArray(claims.scope) || claims.scope.length === 0) {
      return this.invalid("Token has no scope");
    }

    if (!claims.human || !claims.human.email) {
      return this.invalid("Token missing human binding");
    }

    if (!claims.agent || !claims.agent.name) {
      return this.invalid("Token missing agent metadata");
    }

    if (!claims.delegation || typeof claims.delegation.depth !== "number") {
      return this.invalid("Token missing delegation info");
    }

    // Check expiry
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === "number" && claims.exp < nowSec) {
      return {
        valid: false,
        claims,
        reason: `Token expired at ${new Date(claims.exp * 1000).toISOString()}`,
      };
    }

    // Check revocation (if registry is configured)
    if (this.registryUrl && claims.jti) {
      const revoked = await this.checkRevocation(claims.jti);
      if (revoked) {
        return { valid: false, claims, reason: "Token has been revoked" };
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

      // Cache the result
      this.jwksCache = {
        keys: jwks.keys,
        fetchedAt: Date.now(),
      };

      return jwks.keys[0];
    } catch (err) {
      // Fallback: use cached key if available
      if (this.jwksCache && this.jwksCache.keys.length > 0) {
        return this.jwksCache.keys[0];
      }

      // Fallback: use static public key if configured
      if (this.staticPublicKey) {
        return this.staticPublicKey;
      }

      throw err;
    }
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

      // On other errors, default to not revoked (fail open)
      return false;
    } catch {
      // Network error — fail open
      return false;
    }
  }

  /** Clear the JWKS cache (useful for testing). */
  clearCache(): void {
    this.jwksCache = null;
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
}
