import {
  generateKeyPair as joseGenerateKeyPair,
  exportJWK,
  importJWK,
  calculateJwkThumbprint,
  type KeyLike,
  type JWK,
} from 'jose';

export interface EigentKeyPair {
  publicKey: KeyLike;
  privateKey: KeyLike;
}

/**
 * Generate an Ed25519 key pair for signing Eigent tokens.
 */
export async function generateKeyPair(): Promise<EigentKeyPair> {
  const { publicKey, privateKey } = await joseGenerateKeyPair('EdDSA', {
    crv: 'Ed25519',
  });
  return { publicKey, privateKey };
}

/**
 * Export a public key as a JWK object.
 */
export async function exportPublicKey(key: KeyLike): Promise<JWK> {
  const jwk = await exportJWK(key);
  // Ensure no private key material leaks
  delete jwk.d;
  return jwk;
}

/**
 * Import a public key from a JWK object.
 */
export async function importPublicKey(jwk: JWK): Promise<KeyLike> {
  // Strip any private key material before import
  const publicJwk = { ...jwk };
  delete publicJwk.d;
  const key = await importJWK(publicJwk, 'EdDSA');
  return key as KeyLike;
}

/**
 * Derive a Key ID (kid) from a public key using JWK Thumbprint (RFC 7638).
 * Returns a base64url-encoded SHA-256 thumbprint.
 */
export async function getKeyId(publicKey: KeyLike): Promise<string> {
  const jwk = await exportJWK(publicKey);
  // Strip private material before thumbprint calculation
  delete jwk.d;
  const thumbprint = await calculateJwkThumbprint(jwk, 'sha256');
  return thumbprint;
}
