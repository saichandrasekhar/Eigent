import * as jose from 'jose';
import { v7 as uuidv7 } from 'uuid';
import { getLatestKey, insertKey, getAllPublicKeys, type KeyRow } from './db.js';

const ALGORITHM = 'ES256';
const ISSUER = 'eigent-registry';

/**
 * Ensure a signing key exists in the database. Generate one if not.
 */
export async function ensureSigningKey(): Promise<void> {
  const existing = getLatestKey();
  if (existing) return;

  const { publicKey, privateKey } = await jose.generateKeyPair(ALGORITHM, {
    extractable: true,
  });

  const publicJwk = await jose.exportJWK(publicKey);
  const privateJwk = await jose.exportJWK(privateKey);

  const kid = uuidv7();
  publicJwk.kid = kid;
  publicJwk.alg = ALGORITHM;
  publicJwk.use = 'sig';

  const keyRow: KeyRow = {
    id: kid,
    public_key: JSON.stringify(publicJwk),
    private_key: JSON.stringify(privateJwk),
    created_at: new Date().toISOString(),
  };

  insertKey(keyRow);
}

/**
 * Get the current signing private key from the database.
 */
async function getSigningKey(): Promise<{ key: jose.KeyLike; kid: string }> {
  const keyRow = getLatestKey();
  if (!keyRow) {
    throw new Error('No signing key available. Call ensureSigningKey() first.');
  }

  const privateJwk = JSON.parse(keyRow.private_key);
  const key = await jose.importJWK(privateJwk, ALGORITHM);
  return { key: key as jose.KeyLike, kid: keyRow.id };
}

export interface EigentTokenPayload {
  agent_id: string;
  human_sub: string;
  human_email: string;
  human_iss: string;
  scope: string[];
  delegation_depth: number;
  max_delegation_depth: number;
  delegation_chain: string[];
  can_delegate: string[];
}

/**
 * Issue a signed eigent token (JWS).
 */
export async function issueToken(
  payload: EigentTokenPayload,
  expiresAt: Date
): Promise<{ token: string; jti: string }> {
  const { key, kid } = await getSigningKey();
  const jti = uuidv7();

  const token = await new jose.SignJWT({
    agent_id: payload.agent_id,
    human_sub: payload.human_sub,
    human_email: payload.human_email,
    human_iss: payload.human_iss,
    scope: payload.scope,
    delegation_depth: payload.delegation_depth,
    max_delegation_depth: payload.max_delegation_depth,
    delegation_chain: payload.delegation_chain,
    can_delegate: payload.can_delegate,
  })
    .setProtectedHeader({ alg: ALGORITHM, kid, typ: 'eigent+jwt' })
    .setIssuer(ISSUER)
    .setSubject(payload.agent_id)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(key);

  return { token, jti };
}

export interface VerifiedToken {
  payload: jose.JWTPayload & EigentTokenPayload;
  jti: string;
}

/**
 * Verify a token signature and decode the payload.
 */
export async function verifyToken(token: string): Promise<VerifiedToken> {
  const keys = getAllPublicKeys();
  if (keys.length === 0) {
    throw new Error('No public keys available for verification.');
  }

  // Try each key until one works (supports key rotation)
  let lastError: Error | null = null;
  for (const keyRow of keys) {
    try {
      const publicJwk = JSON.parse(keyRow.public_key);
      const publicKey = await jose.importJWK(publicJwk, ALGORITHM);

      const { payload } = await jose.jwtVerify(token, publicKey as jose.KeyLike, {
        issuer: ISSUER,
      });

      return {
        payload: payload as jose.JWTPayload & EigentTokenPayload,
        jti: payload.jti!,
      };
    } catch (err) {
      lastError = err as Error;
      continue;
    }
  }

  throw lastError ?? new Error('Token verification failed.');
}

/**
 * Build the JWKS (JSON Web Key Set) for public consumption.
 */
export function getJwks(): { keys: jose.JWK[] } {
  const publicKeys = getAllPublicKeys();
  return {
    keys: publicKeys.map((k) => JSON.parse(k.public_key)),
  };
}
