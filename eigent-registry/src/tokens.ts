import * as jose from 'jose';
import { v7 as uuidv7 } from 'uuid';
import { getDb, getLatestKey, insertKey, getAllPublicKeys, type KeyRow } from './db.js';
import { encryptIfEnabled, decryptIfEnabled, encrypt, decrypt } from './crypto.js';

const ALGORITHM = 'EdDSA';
const ISSUER = 'eigent-registry';

/**
 * Ensure a signing key exists in the database. Generate one if not.
 * Uses Ed25519 (EdDSA) to align with eigent-core key generation.
 */
export async function ensureSigningKey(): Promise<void> {
  const existing = getLatestKey();
  if (existing) return;

  const { publicKey, privateKey } = await jose.generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });

  const publicJwk = await jose.exportJWK(publicKey);
  const privateJwk = await jose.exportJWK(privateKey);

  const kid = uuidv7();
  publicJwk.kid = kid;
  publicJwk.alg = ALGORITHM;
  publicJwk.use = 'sig';

  const privateKeyJson = JSON.stringify(privateJwk);
  const encryptedPrivateKey = encryptIfEnabled(privateKeyJson);

  const keyRow: KeyRow = {
    id: kid,
    org_id: 'default',
    public_key: JSON.stringify(publicJwk),
    private_key: encryptedPrivateKey,
    created_at: new Date().toISOString(),
  };

  insertKey(keyRow);
}

/**
 * Get the current signing private key from the database.
 * Decrypts the private key if encryption is enabled.
 */
async function getSigningKey(): Promise<{ key: jose.CryptoKey | jose.KeyObject; kid: string }> {
  const keyRow = getLatestKey();
  if (!keyRow) {
    throw new Error('No signing key available. Call ensureSigningKey() first.');
  }

  const decryptedPrivateKey = decryptIfEnabled(keyRow.private_key);
  const privateJwk = JSON.parse(decryptedPrivateKey);
  const key = await jose.importJWK(privateJwk, ALGORITHM);
  return { key: key as jose.CryptoKey | jose.KeyObject, kid: keyRow.id };
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
 * Uses Ed25519 (EdDSA) for signature.
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
 * Supports both EdDSA (new) and ES256 (legacy) keys for smooth migration.
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
      // Determine algorithm from the key itself
      const keyAlg = publicJwk.alg ?? (publicJwk.kty === 'OKP' ? 'EdDSA' : 'ES256');
      const publicKey = await jose.importJWK(publicJwk, keyAlg);

      const { payload } = await jose.jwtVerify(token, publicKey as jose.CryptoKey | jose.KeyObject, {
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

/**
 * Rotate encryption key: re-encrypts all stored private keys from oldKey to newKey.
 * Returns the number of keys that were re-encrypted.
 */
export function rotateEncryptionKey(oldKey: string, newKey: string): number {
  const db = getDb();
  const allKeys = db.prepare('SELECT * FROM keys ORDER BY created_at DESC').all() as KeyRow[];
  let rotatedCount = 0;

  for (const keyRow of allKeys) {
    // Decrypt with old key
    let plaintext: string;
    const parts = keyRow.private_key.split(':');
    if (parts.length === 3) {
      plaintext = decrypt(keyRow.private_key, oldKey);
    } else {
      // Already plaintext (dev mode migration)
      plaintext = keyRow.private_key;
    }

    // Re-encrypt with new key
    const reEncrypted = encrypt(plaintext, newKey);
    db.prepare('UPDATE keys SET private_key = ? WHERE id = ?').run(reEncrypted, keyRow.id);
    rotatedCount++;
  }

  return rotatedCount;
}

/**
 * Check if a signing key is available (for readiness checks).
 */
export function hasSigningKey(): boolean {
  const keyRow = getLatestKey();
  return keyRow !== undefined;
}
