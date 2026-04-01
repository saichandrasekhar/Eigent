import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../src/keys.js';
import { issueToken, decodeToken, validateToken } from '../src/token.js';
import { delegateToken, validateDelegationChain, DelegationError } from '../src/delegation.js';
import { buildTestClaims } from './helpers.js';
import type { DelegationRequest } from '../src/types.js';

describe('delegation', () => {
  describe('delegateToken', () => {
    it('should create a child token with narrowed scope', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims();
      const parentToken = await issueToken(claims, registryKp.privateKey);

      const request: DelegationRequest = {
        parent_token: parentToken,
        child_agent: {
          name: 'test-runner-bot',
          model: 'gpt-4',
          framework: 'LangChain',
        },
        requested_scope: ['read_file', 'run_tests'],
      };

      const result = await delegateToken(request, registryKp.publicKey, registryKp.privateKey);

      expect(result.granted_scope).toEqual(['read_file', 'run_tests']);
      expect(result.denied_scope).toEqual([]);
      expect(result.delegation_depth).toBe(1);
      expect(result.token).toBeDefined();

      // Verify the child token
      const childToken = await validateToken(result.token, registryKp.publicKey);
      expect(childToken.agent.name).toBe('test-runner-bot');
      expect(childToken.scope).toEqual(['read_file', 'run_tests']);
      expect(childToken.delegation.depth).toBe(1);
      expect(childToken.delegation.chain).toHaveLength(1);
      expect(childToken.delegation.chain[0]).toBe(claims.sub);
    });

    it('should deny scopes not in parent', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims({
        scope: ['read_file', 'run_tests'],
        delegation: {
          depth: 0,
          max_depth: 3,
          chain: [],
          can_delegate: ['read_file', 'run_tests'],
        },
      });
      const parentToken = await issueToken(claims, registryKp.privateKey);

      const request: DelegationRequest = {
        parent_token: parentToken,
        child_agent: { name: 'child' },
        requested_scope: ['read_file', 'delete_all'],
      };

      const result = await delegateToken(request, registryKp.publicKey, registryKp.privateKey);
      expect(result.granted_scope).toEqual(['read_file']);
      expect(result.denied_scope).toEqual(['delete_all']);
    });

    it('should deny scopes not in can_delegate', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims({
        scope: ['read_file', 'run_tests', 'write_file'],
        delegation: {
          depth: 0,
          max_depth: 3,
          chain: [],
          can_delegate: ['read_file'], // Only read_file is delegatable
        },
      });
      const parentToken = await issueToken(claims, registryKp.privateKey);

      const request: DelegationRequest = {
        parent_token: parentToken,
        child_agent: { name: 'child' },
        requested_scope: ['read_file', 'run_tests', 'write_file'],
      };

      const result = await delegateToken(request, registryKp.publicKey, registryKp.privateKey);
      expect(result.granted_scope).toEqual(['read_file']);
      expect(result.denied_scope).toEqual(['run_tests', 'write_file']);
    });

    it('should fail when delegation depth is at max', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims({
        delegation: {
          depth: 3,
          max_depth: 3,
          chain: [
            'spiffe://acme.corp/agent/grandparent',
            'spiffe://acme.corp/agent/parent',
            'spiffe://acme.corp/agent/current',
          ],
          can_delegate: ['read_file'],
        },
      });
      const parentToken = await issueToken(claims, registryKp.privateKey);

      const request: DelegationRequest = {
        parent_token: parentToken,
        child_agent: { name: 'child' },
        requested_scope: ['read_file'],
      };

      await expect(
        delegateToken(request, registryKp.publicKey, registryKp.privateKey),
      ).rejects.toThrow('Delegation depth limit reached');
    });

    it('should fail when no scopes can be granted', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims({
        scope: ['read_file'],
        delegation: {
          depth: 0,
          max_depth: 3,
          chain: [],
          can_delegate: ['read_file'],
        },
      });
      const parentToken = await issueToken(claims, registryKp.privateKey);

      const request: DelegationRequest = {
        parent_token: parentToken,
        child_agent: { name: 'child' },
        requested_scope: ['delete_all'],
      };

      await expect(
        delegateToken(request, registryKp.publicKey, registryKp.privateKey),
      ).rejects.toThrow('No scopes can be granted');
    });

    it('should fail with invalid parent token', async () => {
      const registryKp = await generateKeyPair();
      const otherKp = await generateKeyPair();

      const claims = buildTestClaims();
      const parentToken = await issueToken(claims, otherKp.privateKey);

      const request: DelegationRequest = {
        parent_token: parentToken,
        child_agent: { name: 'child' },
        requested_scope: ['read_file'],
      };

      await expect(
        delegateToken(request, registryKp.publicKey, registryKp.privateKey),
      ).rejects.toThrow('Parent token validation failed');
    });

    it('should cap child TTL to parent remaining lifetime', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims({ exp_seconds: 300 }); // 5 minutes
      const parentToken = await issueToken(claims, registryKp.privateKey);

      const request: DelegationRequest = {
        parent_token: parentToken,
        child_agent: { name: 'child' },
        requested_scope: ['read_file'],
        ttl_seconds: 7200, // Request 2 hours
      };

      const result = await delegateToken(request, registryKp.publicKey, registryKp.privateKey);
      const childToken = decodeToken(result.token);
      const childTtl = childToken.exp - childToken.iat;
      // Child TTL should be <= parent remaining (~300s), not 7200
      expect(childTtl).toBeLessThanOrEqual(300);
    });

    it('should preserve human binding through delegation', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims();
      const parentToken = await issueToken(claims, registryKp.privateKey);

      const request: DelegationRequest = {
        parent_token: parentToken,
        child_agent: { name: 'sub-agent' },
        requested_scope: ['read_file'],
      };

      const result = await delegateToken(request, registryKp.publicKey, registryKp.privateKey);
      const childToken = await validateToken(result.token, registryKp.publicKey);

      expect(childToken.human).toEqual(claims.human);
    });

    it('should support multi-level delegation', async () => {
      const registryKp = await generateKeyPair();

      // Level 0: root token
      const rootClaims = buildTestClaims({
        delegation: {
          depth: 0,
          max_depth: 3,
          chain: [],
          can_delegate: ['read_file', 'run_tests'],
        },
      });
      const rootToken = await issueToken(rootClaims, registryKp.privateKey);

      // Level 1: first delegation
      const level1Result = await delegateToken(
        {
          parent_token: rootToken,
          child_agent: { name: 'level-1-agent' },
          requested_scope: ['read_file', 'run_tests'],
        },
        registryKp.publicKey,
        registryKp.privateKey,
      );
      expect(level1Result.delegation_depth).toBe(1);

      // Level 2: second delegation
      const level2Result = await delegateToken(
        {
          parent_token: level1Result.token,
          child_agent: { name: 'level-2-agent' },
          requested_scope: ['read_file'],
        },
        registryKp.publicKey,
        registryKp.privateKey,
      );
      expect(level2Result.delegation_depth).toBe(2);

      const level2Token = await validateToken(level2Result.token, registryKp.publicKey);
      expect(level2Token.delegation.chain).toHaveLength(2);
      expect(level2Token.scope).toEqual(['read_file']);
    });

    it('should reject invalid request structure', async () => {
      const registryKp = await generateKeyPair();

      await expect(
        delegateToken(
          {
            parent_token: '',
            child_agent: { name: 'child' },
            requested_scope: ['read_file'],
          },
          registryKp.publicKey,
          registryKp.privateKey,
        ),
      ).rejects.toThrow(DelegationError);
    });
  });

  describe('validateDelegationChain', () => {
    it('should validate a root token (depth 0)', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims();
      const token = await issueToken(claims, registryKp.privateKey);

      const result = await validateDelegationChain(token, registryKp.publicKey);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.chain).toHaveLength(1);
    });

    it('should validate a properly delegated token', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims();
      const parentToken = await issueToken(claims, registryKp.privateKey);

      const result = await delegateToken(
        {
          parent_token: parentToken,
          child_agent: { name: 'child' },
          requested_scope: ['read_file'],
        },
        registryKp.publicKey,
        registryKp.privateKey,
      );

      const validation = await validateDelegationChain(result.token, registryKp.publicKey);
      expect(validation.valid).toBe(true);
      expect(validation.violations).toHaveLength(0);
    });

    it('should detect can_delegate scopes not in scope', async () => {
      const registryKp = await generateKeyPair();
      // Craft a token where can_delegate has something not in scope
      // This is a malformed token — we create it by direct issuance
      const claims = buildTestClaims({
        scope: ['read_file'],
        delegation: {
          depth: 0,
          max_depth: 3,
          chain: [],
          can_delegate: ['read_file', 'delete_all'], // delete_all not in scope
        },
      });
      const token = await issueToken(claims, registryKp.privateKey);

      const validation = await validateDelegationChain(token, registryKp.publicKey);
      expect(validation.valid).toBe(false);
      expect(validation.violations.length).toBeGreaterThan(0);
      expect(validation.violations[0]).toContain('delete_all');
    });

    it('should detect depth exceeding max_depth', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims({
        delegation: {
          depth: 5,
          max_depth: 3,
          chain: ['a', 'b', 'c', 'd', 'e'].map(
            (id) => `spiffe://acme.corp/agent/${id}`,
          ),
          can_delegate: ['read_file'],
        },
      });
      const token = await issueToken(claims, registryKp.privateKey);

      const validation = await validateDelegationChain(token, registryKp.publicKey);
      expect(validation.valid).toBe(false);
      expect(validation.violations.some((v) => v.includes('exceeds max_depth'))).toBe(true);
    });

    it('should detect depth/chain length mismatch', async () => {
      const registryKp = await generateKeyPair();
      const claims = buildTestClaims({
        delegation: {
          depth: 2,
          max_depth: 5,
          chain: ['spiffe://acme.corp/agent/only-one'], // chain length 1, depth 2
          can_delegate: ['read_file'],
        },
      });
      const token = await issueToken(claims, registryKp.privateKey);

      const validation = await validateDelegationChain(token, registryKp.publicKey);
      expect(validation.valid).toBe(false);
      expect(validation.violations.some((v) => v.includes('does not match chain length'))).toBe(
        true,
      );
    });

    it('should reject token signed with wrong key', async () => {
      const registryKp = await generateKeyPair();
      const otherKp = await generateKeyPair();
      const claims = buildTestClaims();
      const token = await issueToken(claims, otherKp.privateKey);

      const validation = await validateDelegationChain(token, registryKp.publicKey);
      expect(validation.valid).toBe(false);
      expect(validation.violations[0]).toContain('Token validation failed');
    });
  });
});
