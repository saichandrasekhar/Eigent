import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { generateKeyPair } from '../src/keys.js';
import { issueToken, validateToken, decodeToken, TokenError } from '../src/token.js';
import { buildTestClaims } from './helpers.js';

describe('token', () => {
  describe('issueToken', () => {
    it('should issue a valid JWS token string', async () => {
      const kp = await generateKeyPair();
      const claims = buildTestClaims();
      const token = await issueToken(claims, kp.privateKey);
      expect(typeof token).toBe('string');
      // JWS compact serialization has 3 parts
      expect(token.split('.').length).toBe(3);
    });

    it('should reject invalid claims', async () => {
      const kp = await generateKeyPair();
      const badClaims = buildTestClaims({ sub: 'not-a-spiffe-uri' });
      await expect(issueToken(badClaims, kp.privateKey)).rejects.toThrow(TokenError);
    });

    it('should reject claims with empty scope', async () => {
      const kp = await generateKeyPair();
      const badClaims = buildTestClaims({ scope: [] });
      await expect(issueToken(badClaims, kp.privateKey)).rejects.toThrow(TokenError);
    });

    it('should reject claims with invalid email', async () => {
      const kp = await generateKeyPair();
      const badClaims = buildTestClaims({
        human: {
          sub: 'user-1',
          email: 'not-an-email',
          iss: 'https://idp.example.com',
          groups: [],
        },
      });
      await expect(issueToken(badClaims, kp.privateKey)).rejects.toThrow(TokenError);
    });

    it('should use custom TTL when provided', async () => {
      const kp = await generateKeyPair();
      const claims = buildTestClaims({ exp_seconds: 120 });
      const token = await issueToken(claims, kp.privateKey);
      const decoded = decodeToken(token);
      expect(decoded.exp - decoded.iat).toBe(120);
    });

    it('should default to 1-hour TTL', async () => {
      const kp = await generateKeyPair();
      const claims = buildTestClaims();
      const token = await issueToken(claims, kp.privateKey);
      const decoded = decodeToken(token);
      expect(decoded.exp - decoded.iat).toBe(3600);
    });
  });

  describe('validateToken', () => {
    it('should validate a properly signed token', async () => {
      const kp = await generateKeyPair();
      const claims = buildTestClaims();
      const token = await issueToken(claims, kp.privateKey);
      const validated = await validateToken(token, kp.publicKey);

      expect(validated.alg).toBe('EdDSA');
      expect(validated.typ).toBe('eigent+jwt');
      expect(validated.sub).toBe(claims.sub);
      expect(validated.iss).toBe(claims.iss);
      expect(validated.aud).toBe(claims.aud);
      expect(validated.jti).toBeDefined();
      expect(validated.iat).toBeDefined();
      expect(validated.exp).toBeDefined();
      expect(validated.human).toEqual(claims.human);
      expect(validated.agent).toEqual(claims.agent);
      expect(validated.scope).toEqual(claims.scope);
      expect(validated.delegation).toEqual(claims.delegation);
    });

    it('should reject a token signed with a different key', async () => {
      const kp1 = await generateKeyPair();
      const kp2 = await generateKeyPair();
      const claims = buildTestClaims();
      const token = await issueToken(claims, kp1.privateKey);
      await expect(validateToken(token, kp2.publicKey)).rejects.toThrow(TokenError);
    });

    it('should reject an expired token', async () => {
      const kp = await generateKeyPair();
      const claims = buildTestClaims({ exp_seconds: 1 });
      const token = await issueToken(claims, kp.privateKey);

      // Manually create a token that is already expired
      const expiredToken = await new SignJWT({
        human: claims.human,
        agent: claims.agent,
        scope: claims.scope,
        delegation: claims.delegation,
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'eigent+jwt', kid: 'test' })
        .setJti('test-jti')
        .setSubject(claims.sub)
        .setIssuer(claims.iss)
        .setAudience(claims.aud)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(kp.privateKey);

      await expect(validateToken(expiredToken, kp.publicKey)).rejects.toThrow('expired');
    });

    it('should reject a tampered token', async () => {
      const kp = await generateKeyPair();
      const claims = buildTestClaims();
      const token = await issueToken(claims, kp.privateKey);

      // Tamper with the payload (change a character in the middle part)
      const parts = token.split('.');
      const tamperedPayload = parts[1].slice(0, -2) + 'XX';
      const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      await expect(validateToken(tampered, kp.publicKey)).rejects.toThrow(TokenError);
    });

    it('should reject a token with wrong typ header', async () => {
      const kp = await generateKeyPair();
      const claims = buildTestClaims();

      // Create a token with wrong typ
      const wrongTypToken = await new SignJWT({
        human: claims.human,
        agent: claims.agent,
        scope: claims.scope,
        delegation: claims.delegation,
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'test' })
        .setJti('test-jti')
        .setSubject(claims.sub)
        .setIssuer(claims.iss)
        .setAudience(claims.aud)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(kp.privateKey);

      await expect(validateToken(wrongTypToken, kp.publicKey)).rejects.toThrow(
        'Invalid token type',
      );
    });
  });

  describe('decodeToken', () => {
    it('should decode without verification', async () => {
      const kp = await generateKeyPair();
      const claims = buildTestClaims();
      const token = await issueToken(claims, kp.privateKey);
      const decoded = decodeToken(token);

      expect(decoded.sub).toBe(claims.sub);
      expect(decoded.scope).toEqual(claims.scope);
      expect(decoded.human.email).toBe(claims.human.email);
    });

    it('should decode even with a wrong key (no signature verification)', async () => {
      const kp1 = await generateKeyPair();
      const claims = buildTestClaims();
      const token = await issueToken(claims, kp1.privateKey);

      // decodeToken does not verify, so this should work
      const decoded = decodeToken(token);
      expect(decoded.sub).toBe(claims.sub);
    });

    it('should throw on completely malformed input', () => {
      expect(() => decodeToken('not-a-jwt')).toThrow(TokenError);
    });

    it('should throw on empty string', () => {
      expect(() => decodeToken('')).toThrow(TokenError);
    });
  });
});
