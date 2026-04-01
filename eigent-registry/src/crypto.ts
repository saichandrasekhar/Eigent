import * as crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Derive a 256-bit key from the master key string using SHA-256.
 */
function deriveKey(masterKey: string): Buffer {
  return crypto.createHash('sha256').update(masterKey).digest().subarray(0, KEY_LENGTH);
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns a string in the format `iv:ciphertext:tag` (all base64-encoded).
 */
export function encrypt(plaintext: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}

/**
 * Decrypt a string encrypted with `encrypt()`.
 * Expects the format `iv:ciphertext:tag` (all base64-encoded).
 */
export function decrypt(encrypted: string, masterKey: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format. Expected iv:ciphertext:tag');
  }

  const key = deriveKey(masterKey);
  const iv = Buffer.from(parts[0], 'base64');
  const ciphertext = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Get the master key from the environment. Returns null if not set.
 * In production, EIGENT_MASTER_KEY is required.
 */
export function getMasterKey(): string | null {
  return process.env.EIGENT_MASTER_KEY ?? null;
}

/**
 * Check whether encryption is available (master key is configured).
 */
export function isEncryptionEnabled(): boolean {
  return getMasterKey() !== null;
}

/**
 * Encrypt a value if a master key is available, otherwise return plaintext with a warning.
 */
export function encryptIfEnabled(plaintext: string): string {
  const masterKey = getMasterKey();
  if (!masterKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('EIGENT_MASTER_KEY is required in production mode');
    }
    process.stderr.write(
      '[eigent-crypto] WARNING: EIGENT_MASTER_KEY not set. Private keys stored in plaintext.\n',
    );
    return plaintext;
  }
  return encrypt(plaintext, masterKey);
}

/**
 * Decrypt a value if a master key is available. If not, assume the value is plaintext.
 */
export function decryptIfEnabled(value: string): string {
  const masterKey = getMasterKey();
  if (!masterKey) {
    // No master key: assume value is stored as plaintext (dev mode)
    return value;
  }

  // Check if the value looks like an encrypted string (iv:ciphertext:tag)
  if (value.split(':').length === 3) {
    return decrypt(value, masterKey);
  }

  // Value is not encrypted (possibly migrating from plaintext)
  return value;
}
