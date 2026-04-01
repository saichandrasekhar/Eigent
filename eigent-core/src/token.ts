import { SignJWT, jwtVerify, decodeJwt, decodeProtectedHeader, type KeyLike } from 'jose';
import { v7 as uuidv7 } from 'uuid';

import type { EigentToken, EigentTokenClaims } from './types.js';
import { EigentTokenClaimsSchema } from './types.js';
import { getKeyId } from './keys.js';

const DEFAULT_TTL_SECONDS = 3600; // 1 hour

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

/**
 * Issue and sign an Eigent token (JWS).
 *
 * @param claims - The token claims (subject, scopes, delegation, etc.)
 * @param privateKey - The Ed25519 private key to sign with
 * @returns A compact JWS string
 */
export async function issueToken(
  claims: EigentTokenClaims,
  privateKey: KeyLike,
): Promise<string> {
  // Validate claims at runtime
  const parseResult = EigentTokenClaimsSchema.safeParse(claims);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((i) => i.message).join('; ');
    throw new TokenError(`Invalid token claims: ${issues}`);
  }

  const ttl = claims.exp_seconds ?? DEFAULT_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const jti = uuidv7();
  const kid = await getKeyId(privateKey);

  const jwt = await new SignJWT({
    human: claims.human,
    agent: claims.agent,
    scope: claims.scope,
    delegation: claims.delegation,
  })
    .setProtectedHeader({
      alg: 'EdDSA',
      typ: 'eigent+jwt',
      kid,
    })
    .setJti(jti)
    .setSubject(claims.sub)
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(privateKey);

  return jwt;
}

/**
 * Validate and verify an Eigent token.
 * Checks signature, expiry, required fields, and token type.
 *
 * @param token - The compact JWS string
 * @param publicKey - The Ed25519 public key to verify against
 * @returns The decoded and validated EigentToken
 * @throws TokenError if validation fails
 */
export async function validateToken(
  token: string,
  publicKey: KeyLike,
): Promise<EigentToken> {
  // Verify signature and standard claims
  let payload;
  let header;
  try {
    const result = await jwtVerify(token, publicKey, {
      algorithms: ['EdDSA'],
    });
    payload = result.payload;
    header = result.protectedHeader;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('expired') || err.message.includes('"exp" claim')) {
        throw new TokenError('Token has expired');
      }
      if (err.message.includes('signature')) {
        throw new TokenError('Invalid token signature');
      }
      throw new TokenError(`Token verification failed: ${err.message}`);
    }
    throw new TokenError('Token verification failed');
  }

  // Validate eigent-specific header
  if (header.typ !== 'eigent+jwt') {
    throw new TokenError(`Invalid token type: expected "eigent+jwt", got "${header.typ}"`);
  }

  if (!header.kid) {
    throw new TokenError('Token header missing kid');
  }

  // Validate required payload fields
  if (!payload.sub) throw new TokenError('Token missing subject (sub)');
  if (!payload.iss) throw new TokenError('Token missing issuer (iss)');
  if (!payload.aud) throw new TokenError('Token missing audience (aud)');
  if (!payload.jti) throw new TokenError('Token missing token ID (jti)');
  if (!payload.iat) throw new TokenError('Token missing issued-at (iat)');
  if (!payload.exp) throw new TokenError('Token missing expiration (exp)');

  const eigentPayload = payload as Record<string, unknown>;

  if (!eigentPayload.human) throw new TokenError('Token missing human binding');
  if (!eigentPayload.agent) throw new TokenError('Token missing agent metadata');
  if (!eigentPayload.scope) throw new TokenError('Token missing scope');
  if (!eigentPayload.delegation) throw new TokenError('Token missing delegation');

  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;

  return {
    alg: header.alg as 'EdDSA',
    typ: header.typ as 'eigent+jwt',
    kid: header.kid,
    jti: payload.jti as string,
    sub: payload.sub as string,
    iss: payload.iss as string,
    aud: aud as string,
    iat: payload.iat as number,
    exp: payload.exp as number,
    human: eigentPayload.human as EigentToken['human'],
    agent: eigentPayload.agent as EigentToken['agent'],
    scope: eigentPayload.scope as string[],
    delegation: eigentPayload.delegation as EigentToken['delegation'],
  };
}

/**
 * Decode an Eigent token without verifying the signature.
 * Useful for inspection and debugging only. Do NOT trust this for authorization.
 *
 * @param token - The compact JWS string
 * @returns The decoded EigentToken (unverified)
 */
export function decodeToken(token: string): EigentToken {
  let payload;
  let header;
  try {
    payload = decodeJwt(token);
    header = decodeProtectedHeader(token);
  } catch {
    throw new TokenError('Failed to decode token: malformed JWS');
  }

  const eigentPayload = payload as Record<string, unknown>;
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;

  return {
    alg: (header.alg ?? 'EdDSA') as 'EdDSA',
    typ: (header.typ ?? 'eigent+jwt') as 'eigent+jwt',
    kid: (header.kid ?? '') as string,
    jti: (payload.jti ?? '') as string,
    sub: (payload.sub ?? '') as string,
    iss: (payload.iss ?? '') as string,
    aud: (aud ?? '') as string,
    iat: (payload.iat ?? 0) as number,
    exp: (payload.exp ?? 0) as number,
    human: (eigentPayload.human ?? {}) as EigentToken['human'],
    agent: (eigentPayload.agent ?? {}) as EigentToken['agent'],
    scope: (eigentPayload.scope ?? []) as string[],
    delegation: (eigentPayload.delegation ?? {}) as EigentToken['delegation'],
  };
}
