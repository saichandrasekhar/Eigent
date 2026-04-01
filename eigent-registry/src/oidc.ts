import * as jose from 'jose';

// ─── Types ───

type OIDCProviderType = 'okta' | 'entra' | 'google' | 'generic';

interface OIDCProviderConfig {
  id: string;
  type: OIDCProviderType;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  enabled: boolean;
}

interface OIDCDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface HumanIdentity {
  sub: string;
  email: string;
  groups: string[];
  org: string;
  issuer: string;
  emailVerified: boolean;
  name?: string;
}

interface DecodedIdToken {
  sub: string;
  email?: string;
  email_verified?: boolean;
  groups?: string[];
  name?: string;
  org?: string;
  organization?: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  [key: string]: unknown;
}

interface TokenExchangeResult {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

// ─── JWKS Cache ───

interface CachedJWKS {
  keySet: jose.JSONWebKeySet;
  fetchedAt: number;
}

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const jwksCache = new Map<string, CachedJWKS>();

/**
 * Fetch and cache JWKS from a provider's jwks_uri.
 * Cache entries expire after 1 hour.
 */
async function fetchJWKS(jwksUri: string): Promise<jose.JSONWebKeySet> {
  const cached = jwksCache.get(jwksUri);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keySet;
  }

  const response = await fetch(jwksUri);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS from ${jwksUri}: ${response.status} ${response.statusText}`);
  }

  const keySet = (await response.json()) as jose.JSONWebKeySet;
  jwksCache.set(jwksUri, { keySet, fetchedAt: now });
  return keySet;
}

/**
 * Clear all cached JWKS entries. Useful for testing.
 */
function clearJWKSCache(): void {
  jwksCache.clear();
}

// ─── OIDC Discovery ───

const discoveryCache = new Map<string, { doc: OIDCDiscoveryDocument; fetchedAt: number }>();

/**
 * Discover an OIDC provider by fetching its .well-known/openid-configuration.
 */
async function discoverProvider(issuerUrl: string): Promise<OIDCDiscoveryDocument> {
  const cached = discoveryCache.get(issuerUrl);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.doc;
  }

  const normalizedIssuer = issuerUrl.replace(/\/$/, '');
  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;

  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(
      `OIDC discovery failed for ${issuerUrl}: ${response.status} ${response.statusText}`
    );
  }

  const doc = (await response.json()) as OIDCDiscoveryDocument;

  // Validate required fields
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error(
      `Invalid OIDC discovery document from ${issuerUrl}: missing required fields`
    );
  }

  discoveryCache.set(issuerUrl, { doc, fetchedAt: now });
  return doc;
}

// ─── ID Token Verification ───

/**
 * Verify an OIDC ID token against the provider's JWKS.
 * Checks signature, issuer, audience, and expiry.
 */
async function verifyIdToken(
  token: string,
  provider: OIDCProviderConfig,
): Promise<DecodedIdToken> {
  const discovery = await discoverProvider(provider.issuerUrl);
  const jwks = await fetchJWKS(discovery.jwks_uri);

  // Build a local JWKS key set for verification
  const keySet = jose.createLocalJWKSet(jwks);

  const { payload } = await jose.jwtVerify(token, keySet, {
    issuer: discovery.issuer,
    audience: provider.clientId,
  });

  // Validate required claims
  if (!payload.sub) {
    throw new Error('ID token missing required claim: sub');
  }

  return payload as unknown as DecodedIdToken;
}

// ─── Identity Extraction ───

/**
 * Extract a normalized HumanIdentity from a verified ID token.
 * Handles provider-specific claim mappings.
 */
function extractHumanIdentity(idToken: DecodedIdToken): HumanIdentity {
  const email = idToken.email ?? '';
  const emailVerified = idToken.email_verified ?? false;

  // Groups claim varies by provider
  let groups: string[] = [];
  if (Array.isArray(idToken.groups)) {
    groups = idToken.groups;
  } else if (Array.isArray(idToken['cognito:groups'])) {
    groups = idToken['cognito:groups'] as string[];
  }

  // Org claim varies by provider
  const org = (idToken.org as string)
    ?? (idToken.organization as string)
    ?? (idToken['tenant'] as string)
    ?? (idToken['tid'] as string)  // Microsoft Entra tenant ID
    ?? '';

  return {
    sub: idToken.sub,
    email,
    groups,
    org,
    issuer: idToken.iss,
    emailVerified,
    name: idToken.name,
  };
}

// ─── PKCE Helpers ───

/**
 * Generate a PKCE code verifier and code challenge for Authorization Code + PKCE flow.
 */
async function generatePKCE(): Promise<PKCEChallenge> {
  // Generate a random code verifier (43-128 chars, URL-safe)
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = Buffer.from(verifierBytes).toString('base64url');

  // Generate code challenge using S256
  const challengeBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  );
  const codeChallenge = Buffer.from(challengeBuffer).toString('base64url');

  // Generate random state
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = Buffer.from(stateBytes).toString('base64url');

  return { codeVerifier, codeChallenge, state };
}

/**
 * Build the authorization URL for the OIDC Authorization Code + PKCE flow.
 */
function buildAuthorizationUrl(
  provider: OIDCProviderConfig,
  discovery: OIDCDiscoveryDocument,
  pkce: PKCEChallenge,
  redirectUri: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: 'openid email profile groups',
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  });

  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens using the token endpoint.
 */
async function exchangeCodeForTokens(
  provider: OIDCProviderConfig,
  discovery: OIDCDiscoveryDocument,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: codeVerifier,
  });

  const response = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Token exchange failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  return (await response.json()) as TokenExchangeResult;
}

// ─── Provider Configuration ───

/**
 * Create a well-known OIDC provider configuration.
 */
function createProviderConfig(
  id: string,
  type: OIDCProviderType,
  issuerUrl: string,
  clientId: string,
  clientSecret: string,
): OIDCProviderConfig {
  // Normalize well-known issuer URLs by provider type
  let normalizedIssuer = issuerUrl.replace(/\/$/, '');

  if (type === 'google' && !normalizedIssuer) {
    normalizedIssuer = 'https://accounts.google.com';
  }

  return {
    id,
    type,
    issuerUrl: normalizedIssuer,
    clientId,
    clientSecret,
    enabled: true,
  };
}

/**
 * Load provider configuration from environment variables.
 * Returns null if env vars are not configured.
 */
function loadProviderFromEnv(): OIDCProviderConfig | null {
  const issuer = process.env.EIGENT_OIDC_ISSUER;
  const clientId = process.env.EIGENT_OIDC_CLIENT_ID;
  const clientSecret = process.env.EIGENT_OIDC_CLIENT_SECRET;

  if (!issuer || !clientId || !clientSecret) {
    return null;
  }

  // Detect provider type from issuer URL
  let type: OIDCProviderType = 'generic';
  if (issuer.includes('okta.com') || issuer.includes('oktapreview.com')) {
    type = 'okta';
  } else if (issuer.includes('login.microsoftonline.com') || issuer.includes('sts.windows.net')) {
    type = 'entra';
  } else if (issuer.includes('accounts.google.com')) {
    type = 'google';
  }

  return createProviderConfig('env-default', type, issuer, clientId, clientSecret);
}

// ─── Exports ───

export {
  discoverProvider,
  verifyIdToken,
  extractHumanIdentity,
  generatePKCE,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchJWKS,
  clearJWKSCache,
  createProviderConfig,
  loadProviderFromEnv,
};

export type {
  OIDCProviderType,
  OIDCProviderConfig,
  OIDCDiscoveryDocument,
  HumanIdentity,
  DecodedIdToken,
  TokenExchangeResult,
  PKCEChallenge,
};
