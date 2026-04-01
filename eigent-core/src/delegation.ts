import type { KeyLike } from 'jose';
import { v7 as uuidv7 } from 'uuid';

import type {
  DelegationRequest,
  DelegationResult,
  DelegationChainValidation,
  EigentToken,
} from './types.js';
import { DelegationRequestSchema } from './types.js';
import { validateToken, decodeToken, issueToken } from './token.js';
import { intersectScopes } from './permissions.js';

export class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationError';
  }
}

const DEFAULT_CHILD_TTL_SECONDS = 1800; // 30 minutes (shorter than parent)

/**
 * Delegate an Eigent token from a parent agent to a child agent.
 *
 * This implements RFC 8693-style token exchange:
 * 1. Validates the parent token
 * 2. Computes scope intersection: granted = parent.scope ∩ requested_scope ∩ parent.delegation.can_delegate
 * 3. Checks delegation depth < max_depth
 * 4. Creates a child token with narrowed scope, incremented depth, extended chain
 * 5. Signs with the registry key
 *
 * @param request - The delegation request
 * @param parentPublicKey - Public key to verify the parent token
 * @param registryPrivateKey - Registry's private key to sign the child token
 * @returns The delegation result with the child token
 */
export async function delegateToken(
  request: DelegationRequest,
  parentPublicKey: KeyLike,
  registryPrivateKey: KeyLike,
): Promise<DelegationResult> {
  // Validate request structure
  const parseResult = DelegationRequestSchema.safeParse(request);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((i) => i.message).join('; ');
    throw new DelegationError(`Invalid delegation request: ${issues}`);
  }

  // Validate and decode the parent token
  let parentToken: EigentToken;
  try {
    parentToken = await validateToken(request.parent_token, parentPublicKey);
  } catch (err) {
    throw new DelegationError(
      `Parent token validation failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  // Check delegation depth
  if (parentToken.delegation.depth >= parentToken.delegation.max_depth) {
    throw new DelegationError(
      `Delegation depth limit reached: current depth ${parentToken.delegation.depth}, max ${parentToken.delegation.max_depth}`,
    );
  }

  // Compute scope intersection
  const { granted, denied } = intersectScopes(
    parentToken.scope,
    request.requested_scope,
    parentToken.delegation.can_delegate,
  );

  if (granted.length === 0) {
    throw new DelegationError(
      `No scopes can be granted. Requested: [${request.requested_scope.join(', ')}], ` +
      `Parent scopes: [${parentToken.scope.join(', ')}], ` +
      `Delegatable: [${parentToken.delegation.can_delegate.join(', ')}]`,
    );
  }

  // Build child agent ID
  const childAgentId = uuidv7();
  const trustDomain = parentToken.sub.split('/agent/')[0]; // spiffe://org.example
  const childSub = `${trustDomain}/agent/${childAgentId}`;

  // Compute child TTL — cannot exceed parent's remaining lifetime
  const now = Math.floor(Date.now() / 1000);
  const parentRemainingTtl = parentToken.exp - now;
  const requestedTtl = request.ttl_seconds ?? DEFAULT_CHILD_TTL_SECONDS;
  const childTtl = Math.min(requestedTtl, parentRemainingTtl);

  if (childTtl <= 0) {
    throw new DelegationError('Parent token has expired or has insufficient remaining lifetime');
  }

  // Build the extended delegation chain
  const childChain = [...parentToken.delegation.chain, parentToken.sub];

  // Child can only delegate scopes that it was granted AND that parent allows
  const childCanDelegate = granted.filter((s) =>
    parentToken.delegation.can_delegate.includes(s),
  );

  const childToken = await issueToken(
    {
      sub: childSub,
      iss: parentToken.iss,
      aud: parentToken.aud,
      human: parentToken.human,
      agent: request.child_agent,
      scope: granted,
      delegation: {
        depth: parentToken.delegation.depth + 1,
        max_depth: parentToken.delegation.max_depth,
        chain: childChain,
        can_delegate: childCanDelegate,
      },
      exp_seconds: childTtl,
    },
    registryPrivateKey,
  );

  return {
    token: childToken,
    granted_scope: granted,
    denied_scope: denied,
    delegation_depth: parentToken.delegation.depth + 1,
  };
}

/**
 * Validate a delegation chain by walking backwards through parent references.
 *
 * For each hop in the chain, verifies that:
 * - The token signature is valid
 * - Each child's scopes are a subset of its parent's scopes
 * - Each child's scopes are within the parent's can_delegate list
 * - Delegation depth is correctly incremented
 * - The chain array is consistent
 *
 * Note: In a full implementation, this would resolve each parent token from
 * the registry. For the core library, it validates the chain metadata
 * embedded in a single token.
 *
 * @param token - The token to validate
 * @param registryPublicKey - The registry's public key
 * @returns Validation result with chain and any violations
 */
export async function validateDelegationChain(
  token: string,
  registryPublicKey: KeyLike,
): Promise<DelegationChainValidation> {
  const violations: string[] = [];
  const chain: EigentToken[] = [];

  // Validate the token itself
  let eigentToken: EigentToken;
  try {
    eigentToken = await validateToken(token, registryPublicKey);
  } catch (err) {
    return {
      valid: false,
      chain: [],
      violations: [`Token validation failed: ${err instanceof Error ? err.message : 'unknown'}`],
    };
  }

  chain.push(eigentToken);

  // Validate delegation metadata consistency
  const { delegation } = eigentToken;

  // Depth must match chain length
  if (delegation.depth !== delegation.chain.length) {
    violations.push(
      `Delegation depth (${delegation.depth}) does not match chain length (${delegation.chain.length})`,
    );
  }

  // Depth must not exceed max_depth
  if (delegation.depth > delegation.max_depth) {
    violations.push(
      `Delegation depth (${delegation.depth}) exceeds max_depth (${delegation.max_depth})`,
    );
  }

  // can_delegate must be a subset of scope
  const scopeSet = new Set(eigentToken.scope);
  for (const s of delegation.can_delegate) {
    if (!scopeSet.has(s)) {
      violations.push(
        `can_delegate scope "${s}" is not in the token's scope list`,
      );
    }
  }

  // Chain entries should be valid SPIFFE URIs
  for (const entry of delegation.chain) {
    if (!entry.startsWith('spiffe://')) {
      violations.push(`Chain entry "${entry}" is not a valid SPIFFE URI`);
    }
  }

  // The token's own subject should not appear in its chain
  if (delegation.chain.includes(eigentToken.sub)) {
    violations.push('Token subject appears in its own delegation chain (circular reference)');
  }

  return {
    valid: violations.length === 0,
    chain,
    violations,
  };
}
