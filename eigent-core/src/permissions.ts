import type { EigentToken } from './types.js';

export interface ScopeIntersectionResult {
  granted: string[];
  denied: string[];
}

/**
 * Compute the intersection of parent scopes, requested scopes, and delegatable scopes.
 *
 * granted = parent ∩ requested ∩ delegatable
 * denied  = requested \ granted
 *
 * @param parent - Scopes the parent holds
 * @param requested - Scopes the child is requesting
 * @param delegatable - Scopes the parent is allowed to delegate
 * @returns The granted and denied scope sets
 */
export function intersectScopes(
  parent: string[],
  requested: string[],
  delegatable: string[],
): ScopeIntersectionResult {
  const parentSet = new Set(parent);
  const delegatableSet = new Set(delegatable);

  const granted: string[] = [];
  const denied: string[] = [];

  for (const scope of requested) {
    if (parentSet.has(scope) && delegatableSet.has(scope)) {
      granted.push(scope);
    } else {
      denied.push(scope);
    }
  }

  return { granted, denied };
}

/**
 * Check whether a specific tool/action is allowed by the token's scopes.
 *
 * Supports exact matches and wildcard patterns:
 * - "read_file" matches "read_file"
 * - "db:*" matches "db:read", "db:write", etc.
 * - "*" matches everything
 *
 * @param token - The Eigent token
 * @param toolName - The tool or action name to check
 * @returns true if the action is allowed
 */
export function isActionAllowed(token: EigentToken, toolName: string): boolean {
  if (!toolName || toolName.length === 0) {
    return false;
  }

  for (const scope of token.scope) {
    // Global wildcard
    if (scope === '*') {
      return true;
    }

    // Exact match
    if (scope === toolName) {
      return true;
    }

    // Prefix wildcard: "db:*" matches "db:read"
    if (scope.endsWith(':*')) {
      const prefix = scope.slice(0, -1); // "db:"
      if (toolName.startsWith(prefix)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check whether the token holder can delegate the given scopes.
 *
 * A scope can be delegated if:
 * 1. It exists in the token's current scope
 * 2. It exists in the token's delegation.can_delegate list
 * 3. The token has not reached max delegation depth
 *
 * @param token - The Eigent token
 * @param scope - The scopes to check for delegatability
 * @returns true if all scopes can be delegated
 */
export function canDelegate(token: EigentToken, scope: string[]): boolean {
  // Cannot delegate if at max depth
  if (token.delegation.depth >= token.delegation.max_depth) {
    return false;
  }

  // Cannot delegate empty scope
  if (scope.length === 0) {
    return false;
  }

  const ownScopes = new Set(token.scope);
  const delegatableScopes = new Set(token.delegation.can_delegate);

  for (const s of scope) {
    if (!ownScopes.has(s) || !delegatableScopes.has(s)) {
      return false;
    }
  }

  return true;
}
