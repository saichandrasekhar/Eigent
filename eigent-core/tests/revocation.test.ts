import { describe, it, expect } from 'vitest';
import { InMemoryRevocationStore } from '../src/revocation.js';

describe('revocation', () => {
  describe('InMemoryRevocationStore', () => {
    describe('revoke / isRevoked', () => {
      it('should mark a token as revoked', () => {
        const store = new InMemoryRevocationStore();
        const futureExp = Math.floor(Date.now() / 1000) + 3600;
        store.revoke('token-1', futureExp);
        expect(store.isRevoked('token-1')).toBe(true);
      });

      it('should return false for non-revoked tokens', () => {
        const store = new InMemoryRevocationStore();
        expect(store.isRevoked('token-1')).toBe(false);
      });

      it('should handle multiple revocations', () => {
        const store = new InMemoryRevocationStore();
        const futureExp = Math.floor(Date.now() / 1000) + 3600;
        store.revoke('token-1', futureExp);
        store.revoke('token-2', futureExp);
        store.revoke('token-3', futureExp);
        expect(store.isRevoked('token-1')).toBe(true);
        expect(store.isRevoked('token-2')).toBe(true);
        expect(store.isRevoked('token-3')).toBe(true);
        expect(store.isRevoked('token-4')).toBe(false);
      });

      it('should throw on empty token ID', () => {
        const store = new InMemoryRevocationStore();
        expect(() => store.revoke('', 9999999999)).toThrow('Token ID is required');
      });
    });

    describe('revokeWithCascade', () => {
      it('should revoke parent and all children', () => {
        const store = new InMemoryRevocationStore();
        const futureExp = Math.floor(Date.now() / 1000) + 3600;

        const result = store.revokeWithCascade('parent', futureExp, [
          'child-1',
          'child-2',
          'child-3',
        ]);

        expect(result.revoked_agent_id).toBe('parent');
        expect(result.cascade_revoked).toEqual(['child-1', 'child-2', 'child-3']);
        expect(result.total_revoked).toBe(4);

        expect(store.isRevoked('parent')).toBe(true);
        expect(store.isRevoked('child-1')).toBe(true);
        expect(store.isRevoked('child-2')).toBe(true);
        expect(store.isRevoked('child-3')).toBe(true);
      });

      it('should handle empty children list', () => {
        const store = new InMemoryRevocationStore();
        const futureExp = Math.floor(Date.now() / 1000) + 3600;

        const result = store.revokeWithCascade('parent', futureExp, []);
        expect(result.total_revoked).toBe(1);
        expect(result.cascade_revoked).toEqual([]);
        expect(store.isRevoked('parent')).toBe(true);
      });

      it('should skip empty child IDs', () => {
        const store = new InMemoryRevocationStore();
        const futureExp = Math.floor(Date.now() / 1000) + 3600;

        const result = store.revokeWithCascade('parent', futureExp, ['child-1', '', 'child-2']);
        expect(result.cascade_revoked).toEqual(['child-1', 'child-2']);
        expect(result.total_revoked).toBe(3);
      });
    });

    describe('cleanup', () => {
      it('should remove expired entries', () => {
        const store = new InMemoryRevocationStore();
        const pastExp = Math.floor(Date.now() / 1000) - 100; // already expired
        const futureExp = Math.floor(Date.now() / 1000) + 3600;

        store.revoke('expired-token', pastExp);
        store.revoke('active-token', futureExp);

        expect(store.size()).toBe(2);

        const removed = store.cleanup();
        expect(removed).toBe(1);
        expect(store.size()).toBe(1);
        expect(store.isRevoked('expired-token')).toBe(false);
        expect(store.isRevoked('active-token')).toBe(true);
      });

      it('should return 0 when nothing to clean', () => {
        const store = new InMemoryRevocationStore();
        const futureExp = Math.floor(Date.now() / 1000) + 3600;
        store.revoke('token-1', futureExp);
        expect(store.cleanup()).toBe(0);
      });

      it('should handle empty store', () => {
        const store = new InMemoryRevocationStore();
        expect(store.cleanup()).toBe(0);
      });
    });

    describe('size', () => {
      it('should return 0 for empty store', () => {
        const store = new InMemoryRevocationStore();
        expect(store.size()).toBe(0);
      });

      it('should track number of entries', () => {
        const store = new InMemoryRevocationStore();
        const futureExp = Math.floor(Date.now() / 1000) + 3600;
        store.revoke('a', futureExp);
        expect(store.size()).toBe(1);
        store.revoke('b', futureExp);
        expect(store.size()).toBe(2);
      });

      it('should not double-count re-revocations', () => {
        const store = new InMemoryRevocationStore();
        const futureExp = Math.floor(Date.now() / 1000) + 3600;
        store.revoke('a', futureExp);
        store.revoke('a', futureExp);
        expect(store.size()).toBe(1);
      });
    });
  });
});
