/**
 * Interface for a revocation store. The core library provides an in-memory
 * implementation. Registry/production implementations should back this
 * with a persistent store (Redis, DB, etc.).
 */
export interface RevocationStore {
  /** Revoke a token by its JTI. */
  revoke(tokenId: string, expiresAt: number): void;
  /** Check if a token is revoked. */
  isRevoked(tokenId: string): boolean;
  /** Revoke a token and all its children (cascade). */
  revokeWithCascade(
    tokenId: string,
    expiresAt: number,
    childTokenIds: string[],
  ): { revoked_agent_id: string; cascade_revoked: string[]; total_revoked: number };
  /** Remove expired entries to keep the store small. */
  cleanup(): number;
  /** Return the number of entries in the store. */
  size(): number;
}

interface RevocationEntry {
  tokenId: string;
  expiresAt: number;
  revokedAt: number;
}

/**
 * In-memory revocation store. Suitable for single-process deployments
 * and testing. For distributed systems, implement RevocationStore
 * backed by Redis or a database.
 *
 * Because Eigent tokens are short-lived (default 1 hour), the revocation
 * list stays small. Expired entries are automatically cleaned up.
 */
export class InMemoryRevocationStore implements RevocationStore {
  private entries = new Map<string, RevocationEntry>();

  revoke(tokenId: string, expiresAt: number): void {
    if (!tokenId) {
      throw new Error('Token ID is required for revocation');
    }
    this.entries.set(tokenId, {
      tokenId,
      expiresAt,
      revokedAt: Math.floor(Date.now() / 1000),
    });
  }

  isRevoked(tokenId: string): boolean {
    return this.entries.has(tokenId);
  }

  revokeWithCascade(
    tokenId: string,
    expiresAt: number,
    childTokenIds: string[],
  ): { revoked_agent_id: string; cascade_revoked: string[]; total_revoked: number } {
    this.revoke(tokenId, expiresAt);

    const cascadeRevoked: string[] = [];
    for (const childId of childTokenIds) {
      if (childId) {
        this.revoke(childId, expiresAt);
        cascadeRevoked.push(childId);
      }
    }

    return {
      revoked_agent_id: tokenId,
      cascade_revoked: cascadeRevoked,
      total_revoked: 1 + cascadeRevoked.length,
    };
  }

  /**
   * Remove all entries whose tokens have expired. Since tokens are short-lived,
   * there is no need to keep revocation records after the token would have
   * expired anyway.
   *
   * @returns The number of entries removed.
   */
  cleanup(): number {
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }
}
