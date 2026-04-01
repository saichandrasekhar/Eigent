// Types
export type {
  EigentToken,
  EigentTokenClaims,
  HumanBinding,
  AgentMetadata,
  Delegation,
  DelegationRequest,
  DelegationResult,
  RevocationResult,
  DelegationChainValidation,
} from './types.js';

export {
  EigentTokenClaimsSchema,
  DelegationRequestSchema,
  HumanBindingSchema,
  AgentMetadataSchema,
  DelegationSchema,
} from './types.js';

// Keys
export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  getKeyId,
  type EigentKeyPair,
} from './keys.js';

// Token
export { issueToken, validateToken, decodeToken, TokenError } from './token.js';

// Delegation
export { delegateToken, validateDelegationChain, DelegationError } from './delegation.js';

// Permissions
export {
  intersectScopes,
  isActionAllowed,
  canDelegate,
  type ScopeIntersectionResult,
} from './permissions.js';

// Revocation
export {
  InMemoryRevocationStore,
  type RevocationStore,
} from './revocation.js';
