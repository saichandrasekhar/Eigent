import { describe, it, expect } from 'vitest';
import { intersectScopes, isActionAllowed, canDelegate } from '../src/permissions.js';
import type { EigentToken } from '../src/types.js';

function makeToken(overrides?: Partial<EigentToken>): EigentToken {
  return {
    alg: 'EdDSA',
    typ: 'eigent+jwt',
    kid: 'test-kid',
    jti: 'test-jti',
    sub: 'spiffe://acme.corp/agent/test',
    iss: 'https://registry.eigent.dev',
    aud: 'https://mcp.acme.corp/tools',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    human: {
      sub: 'user-1',
      email: 'alice@acme.corp',
      iss: 'https://login.acme.corp',
      groups: ['eng'],
    },
    agent: { name: 'test-bot' },
    scope: ['read_file', 'run_tests', 'write_file'],
    delegation: {
      depth: 0,
      max_depth: 3,
      chain: [],
      can_delegate: ['read_file', 'run_tests'],
    },
    ...overrides,
  };
}

describe('permissions', () => {
  describe('intersectScopes', () => {
    it('should return intersection of all three sets', () => {
      const result = intersectScopes(
        ['read_file', 'write_file', 'run_tests'],
        ['read_file', 'run_tests'],
        ['read_file', 'run_tests', 'write_file'],
      );
      expect(result.granted).toEqual(['read_file', 'run_tests']);
      expect(result.denied).toEqual([]);
    });

    it('should deny scopes not in parent', () => {
      const result = intersectScopes(
        ['read_file'],
        ['read_file', 'delete_all'],
        ['read_file', 'delete_all'],
      );
      expect(result.granted).toEqual(['read_file']);
      expect(result.denied).toEqual(['delete_all']);
    });

    it('should deny scopes not in delegatable', () => {
      const result = intersectScopes(
        ['read_file', 'write_file'],
        ['read_file', 'write_file'],
        ['read_file'], // write_file not delegatable
      );
      expect(result.granted).toEqual(['read_file']);
      expect(result.denied).toEqual(['write_file']);
    });

    it('should return all denied when no overlap', () => {
      const result = intersectScopes(['a', 'b'], ['c', 'd'], ['e', 'f']);
      expect(result.granted).toEqual([]);
      expect(result.denied).toEqual(['c', 'd']);
    });

    it('should handle empty requested scopes', () => {
      const result = intersectScopes(['a', 'b'], [], ['a', 'b']);
      expect(result.granted).toEqual([]);
      expect(result.denied).toEqual([]);
    });

    it('should handle empty parent scopes', () => {
      const result = intersectScopes([], ['a', 'b'], ['a', 'b']);
      expect(result.granted).toEqual([]);
      expect(result.denied).toEqual(['a', 'b']);
    });

    it('should handle empty delegatable scopes', () => {
      const result = intersectScopes(['a', 'b'], ['a', 'b'], []);
      expect(result.granted).toEqual([]);
      expect(result.denied).toEqual(['a', 'b']);
    });

    it('should preserve order of requested scopes', () => {
      const result = intersectScopes(
        ['c', 'b', 'a'],
        ['a', 'b', 'c'],
        ['a', 'b', 'c'],
      );
      expect(result.granted).toEqual(['a', 'b', 'c']);
    });
  });

  describe('isActionAllowed', () => {
    it('should allow exact scope match', () => {
      const token = makeToken({ scope: ['read_file', 'run_tests'] });
      expect(isActionAllowed(token, 'read_file')).toBe(true);
      expect(isActionAllowed(token, 'run_tests')).toBe(true);
    });

    it('should deny scope not in list', () => {
      const token = makeToken({ scope: ['read_file'] });
      expect(isActionAllowed(token, 'write_file')).toBe(false);
    });

    it('should support global wildcard', () => {
      const token = makeToken({ scope: ['*'] });
      expect(isActionAllowed(token, 'anything')).toBe(true);
      expect(isActionAllowed(token, 'db:read')).toBe(true);
    });

    it('should support prefix wildcard', () => {
      const token = makeToken({ scope: ['db:*'] });
      expect(isActionAllowed(token, 'db:read')).toBe(true);
      expect(isActionAllowed(token, 'db:write')).toBe(true);
      expect(isActionAllowed(token, 'db:delete')).toBe(true);
      expect(isActionAllowed(token, 'file:read')).toBe(false);
    });

    it('should not match partial prefix without wildcard', () => {
      const token = makeToken({ scope: ['read_file'] });
      expect(isActionAllowed(token, 'read_file_extra')).toBe(false);
      expect(isActionAllowed(token, 'read_fil')).toBe(false);
    });

    it('should return false for empty tool name', () => {
      const token = makeToken({ scope: ['*'] });
      expect(isActionAllowed(token, '')).toBe(false);
    });

    it('should return false for empty scope', () => {
      const token = makeToken({ scope: [] });
      expect(isActionAllowed(token, 'read_file')).toBe(false);
    });
  });

  describe('canDelegate', () => {
    it('should return true when scopes are delegatable and within depth', () => {
      const token = makeToken({
        scope: ['read_file', 'run_tests'],
        delegation: {
          depth: 0,
          max_depth: 3,
          chain: [],
          can_delegate: ['read_file', 'run_tests'],
        },
      });
      expect(canDelegate(token, ['read_file'])).toBe(true);
      expect(canDelegate(token, ['read_file', 'run_tests'])).toBe(true);
    });

    it('should return false when at max depth', () => {
      const token = makeToken({
        delegation: {
          depth: 3,
          max_depth: 3,
          chain: ['a', 'b', 'c'].map((id) => `spiffe://acme.corp/agent/${id}`),
          can_delegate: ['read_file'],
        },
      });
      expect(canDelegate(token, ['read_file'])).toBe(false);
    });

    it('should return false when scope is not in can_delegate', () => {
      const token = makeToken({
        scope: ['read_file', 'write_file'],
        delegation: {
          depth: 0,
          max_depth: 3,
          chain: [],
          can_delegate: ['read_file'], // write_file missing
        },
      });
      expect(canDelegate(token, ['write_file'])).toBe(false);
    });

    it('should return false when scope is in can_delegate but not in token scope', () => {
      const token = makeToken({
        scope: ['read_file'],
        delegation: {
          depth: 0,
          max_depth: 3,
          chain: [],
          can_delegate: ['read_file', 'write_file'], // write_file delegatable but not in scope
        },
      });
      expect(canDelegate(token, ['write_file'])).toBe(false);
    });

    it('should return false for empty scope array', () => {
      const token = makeToken();
      expect(canDelegate(token, [])).toBe(false);
    });

    it('should return false if any scope is not delegatable', () => {
      const token = makeToken({
        scope: ['read_file', 'run_tests', 'write_file'],
        delegation: {
          depth: 0,
          max_depth: 3,
          chain: [],
          can_delegate: ['read_file', 'run_tests'],
        },
      });
      // All three requested, but write_file is not delegatable
      expect(canDelegate(token, ['read_file', 'run_tests', 'write_file'])).toBe(false);
    });
  });
});
