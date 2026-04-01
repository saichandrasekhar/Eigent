import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportPublicKey, importPublicKey, getKeyId } from '../src/keys.js';

describe('keys', () => {
  describe('generateKeyPair', () => {
    it('should generate an Ed25519 key pair', async () => {
      const kp = await generateKeyPair();
      expect(kp.publicKey).toBeDefined();
      expect(kp.privateKey).toBeDefined();
    });

    it('should generate unique key pairs each time', async () => {
      const kp1 = await generateKeyPair();
      const kp2 = await generateKeyPair();
      const jwk1 = await exportPublicKey(kp1.publicKey);
      const jwk2 = await exportPublicKey(kp2.publicKey);
      expect(jwk1.x).not.toEqual(jwk2.x);
    });
  });

  describe('exportPublicKey', () => {
    it('should export as JWK with correct fields', async () => {
      const kp = await generateKeyPair();
      const jwk = await exportPublicKey(kp.publicKey);
      expect(jwk.kty).toBe('OKP');
      expect(jwk.crv).toBe('Ed25519');
      expect(jwk.x).toBeDefined();
      expect(typeof jwk.x).toBe('string');
    });

    it('should not include private key material', async () => {
      const kp = await generateKeyPair();
      const jwk = await exportPublicKey(kp.publicKey);
      expect(jwk.d).toBeUndefined();
    });

    it('should not leak private material even if private key is passed', async () => {
      const kp = await generateKeyPair();
      // Intentionally pass the private key — exportPublicKey must strip d
      const jwk = await exportPublicKey(kp.privateKey);
      expect(jwk.d).toBeUndefined();
      expect(jwk.kty).toBe('OKP');
    });
  });

  describe('importPublicKey', () => {
    it('should round-trip export and import', async () => {
      const kp = await generateKeyPair();
      const jwk = await exportPublicKey(kp.publicKey);
      const imported = await importPublicKey(jwk);
      expect(imported).toBeDefined();

      // Verify the imported key produces the same JWK
      const reExported = await exportPublicKey(imported);
      expect(reExported.x).toBe(jwk.x);
      expect(reExported.crv).toBe(jwk.crv);
    });

    it('should strip private key material from JWK before import', async () => {
      const kp = await generateKeyPair();
      // Manually build a JWK with a d parameter
      const jwk = await exportPublicKey(kp.publicKey);
      const jwkWithPrivate = { ...jwk, d: 'fake-private-data' };
      // Should not throw — it strips d before import
      const imported = await importPublicKey(jwkWithPrivate);
      expect(imported).toBeDefined();
    });
  });

  describe('getKeyId', () => {
    it('should return a non-empty string', async () => {
      const kp = await generateKeyPair();
      const kid = await getKeyId(kp.publicKey);
      expect(typeof kid).toBe('string');
      expect(kid.length).toBeGreaterThan(0);
    });

    it('should be deterministic for the same key', async () => {
      const kp = await generateKeyPair();
      const kid1 = await getKeyId(kp.publicKey);
      const kid2 = await getKeyId(kp.publicKey);
      expect(kid1).toBe(kid2);
    });

    it('should differ for different keys', async () => {
      const kp1 = await generateKeyPair();
      const kp2 = await generateKeyPair();
      const kid1 = await getKeyId(kp1.publicKey);
      const kid2 = await getKeyId(kp2.publicKey);
      expect(kid1).not.toBe(kid2);
    });

    it('should produce the same kid for public and private key of the same pair', async () => {
      const kp = await generateKeyPair();
      const kidPub = await getKeyId(kp.publicKey);
      const kidPriv = await getKeyId(kp.privateKey);
      expect(kidPub).toBe(kidPriv);
    });
  });
});
