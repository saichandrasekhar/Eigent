# Core Library

The `@eigent/core` package provides the cryptographic primitives for token issuance, validation, delegation, permission checking, and revocation. Use it when building custom integrations or embedding Eigent into your own applications.

**Installation:**

```bash
npm install @eigent/core
```

## Token Operations

### issueToken

Issue and sign an Eigent token (JWS) with Ed25519.

```typescript
import { issueToken } from '@eigent/core';
import { generateKeyPair } from 'jose';

const { privateKey, publicKey } = await generateKeyPair('EdDSA');

const jws = await issueToken(
  {
    sub: 'spiffe://company.example/agent/my-agent',
    iss: 'https://eigent.dev/registry',
    aud: 'company.example',
    human: {
      sub: 'user-abc123',
      email: 'alice@company.com',
      iss: 'https://accounts.google.com',
      groups: ['engineering'],
    },
    agent: {
      name: 'code-agent',
      model: 'claude-sonnet-4-20250514',
      framework: 'claude-desktop',
    },
    scope: ['read_file', 'write_file', 'run_tests'],
    delegation: {
      depth: 0,
      max_depth: 3,
      chain: [],
      can_delegate: ['run_tests'],
    },
    exp_seconds: 3600, // optional, defaults to 3600
  },
  privateKey
);

console.log(jws); // eyJhbGciOiJFZERTQSI...
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `claims` | `EigentTokenClaims` | Token payload (see below) |
| `privateKey` | `KeyLike` | Ed25519 private key |

**Returns:** `Promise<string>` — Compact JWS string

**Throws:** `TokenError` if claims fail validation

### validateToken

Verify a token's signature, expiry, and required fields.

```typescript
import { validateToken } from '@eigent/core';

try {
  const token = await validateToken(jws, publicKey);
  console.log(token.human.email);  // alice@company.com
  console.log(token.scope);        // ['read_file', 'write_file', 'run_tests']
  console.log(token.delegation);   // { depth: 0, max_depth: 3, ... }
} catch (err) {
  if (err instanceof TokenError) {
    console.error('Validation failed:', err.message);
    // "Token has expired"
    // "Invalid token signature"
    // "Token missing human binding"
  }
}
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | `string` | Compact JWS string |
| `publicKey` | `KeyLike` | Ed25519 public key |

**Returns:** `Promise<EigentToken>` — Decoded and validated token

**Throws:** `TokenError` with descriptive messages for each failure case

### decodeToken

Decode a token without verifying the signature. For debugging only.

```typescript
import { decodeToken } from '@eigent/core';

const decoded = decodeToken(jws);
console.log(decoded.agent.name);        // 'code-agent'
console.log(decoded.delegation.depth);  // 0
```

!!! danger "No signature verification"
    `decodeToken` does not check the signature. Never use it for authorization decisions. Always use `validateToken` for that.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | `string` | Compact JWS string |

**Returns:** `EigentToken` — Decoded token (unverified)

**Throws:** `TokenError` if the JWS is malformed

## Delegation Operations

### delegateToken

Delegate an Eigent token from a parent agent to a child agent. Implements RFC 8693-style token exchange with scope narrowing.

```typescript
import { delegateToken } from '@eigent/core';

const result = await delegateToken(
  {
    parent_token: parentJws,
    child_agent: {
      name: 'test-runner',
      model: 'gpt-4o',
    },
    requested_scope: ['run_tests'],
    ttl_seconds: 1800,
  },
  parentPublicKey,     // to verify the parent token
  registryPrivateKey   // to sign the child token
);

console.log(result.token);           // child JWS
console.log(result.granted_scope);   // ['run_tests']
console.log(result.denied_scope);    // []
console.log(result.delegation_depth); // 1
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `request` | `DelegationRequest` | Delegation parameters |
| `parentPublicKey` | `KeyLike` | Public key to verify parent token |
| `registryPrivateKey` | `KeyLike` | Private key to sign child token |

**Returns:** `Promise<DelegationResult>`

**Throws:** `DelegationError` for depth exceeded, no grantable scopes, expired parent, etc.

### validateDelegationChain

Validate the delegation metadata embedded in a token.

```typescript
import { validateDelegationChain } from '@eigent/core';

const result = await validateDelegationChain(jws, registryPublicKey);

if (result.valid) {
  console.log('Chain is valid');
  console.log('Chain length:', result.chain.length);
} else {
  console.error('Violations:', result.violations);
  // "Delegation depth (3) exceeds max_depth (2)"
  // "can_delegate scope 'write' is not in the token's scope list"
  // "Chain entry 'invalid' is not a valid SPIFFE URI"
}
```

**Returns:** `Promise<DelegationChainValidation>`

```typescript
interface DelegationChainValidation {
  valid: boolean;
  chain: EigentToken[];
  violations: string[];
}
```

## Permission Operations

### intersectScopes

Compute the three-way scope intersection for delegation.

```typescript
import { intersectScopes } from '@eigent/core';

const result = intersectScopes(
  ['read', 'write', 'test', 'deploy'],  // parent scope
  ['read', 'write', 'lint'],             // requested scope
  ['read', 'test', 'deploy']             // parent can_delegate
);

console.log(result.granted); // ['read']
console.log(result.denied);  // ['write', 'lint']
```

### isActionAllowed

Check whether a specific tool call is permitted by a token's scopes. Supports exact matches and wildcard patterns.

```typescript
import { isActionAllowed } from '@eigent/core';

isActionAllowed(token, 'read_file');   // true (exact match)
isActionAllowed(token, 'db:read');     // true if scope includes 'db:*'
isActionAllowed(token, 'anything');    // true if scope includes '*'
isActionAllowed(token, 'shell_exec'); // false if not in scope
isActionAllowed(token, '');            // always false
```

### canDelegate

Check whether a token holder can delegate specific scopes.

```typescript
import { canDelegate } from '@eigent/core';

canDelegate(token, ['read']);          // true if in scope AND can_delegate
canDelegate(token, ['write']);         // false if not in can_delegate
canDelegate(token, ['read', 'test']); // true only if ALL are delegatable
```

Returns `false` if the token has reached `max_depth`.

## Revocation

### InMemoryRevocationStore

In-memory revocation store for single-process deployments and testing.

```typescript
import { InMemoryRevocationStore } from '@eigent/core';

const store = new InMemoryRevocationStore();

// Revoke a single token
store.revoke('token-jti', expiresAt);

// Check revocation
store.isRevoked('token-jti'); // true

// Cascade revocation
const result = store.revokeWithCascade('parent-jti', expiresAt, [
  'child-1-jti',
  'child-2-jti',
]);
// result.total_revoked === 3

// Clean up expired entries
const removed = store.cleanup();

// Store size
store.size(); // number of entries
```

### RevocationStore Interface

Implement this interface for production revocation stores (Redis, PostgreSQL, etc.):

```typescript
interface RevocationStore {
  revoke(tokenId: string, expiresAt: number): void;
  isRevoked(tokenId: string): boolean;
  revokeWithCascade(
    tokenId: string,
    expiresAt: number,
    childTokenIds: string[],
  ): { revoked_agent_id: string; cascade_revoked: string[]; total_revoked: number };
  cleanup(): number;
  size(): number;
}
```

## Types

### EigentTokenClaims

Input for token issuance (JTI, IAT, EXP are generated automatically):

```typescript
interface EigentTokenClaims {
  sub: string;          // SPIFFE URI: spiffe://<domain>/agent/<id>
  iss: string;          // Registry URL
  aud: string;          // Trust domain
  human: HumanBinding;
  agent: AgentMetadata;
  scope: string[];      // At least one scope required
  delegation: Delegation;
  exp_seconds?: number; // Default: 3600
}
```

### EigentToken

Full decoded token (includes header fields and generated claims):

```typescript
interface EigentToken {
  alg: 'EdDSA';
  typ: 'eigent+jwt';
  kid: string;
  jti: string;
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  human: HumanBinding;
  agent: AgentMetadata;
  scope: string[];
  delegation: Delegation;
}
```

### HumanBinding

```typescript
interface HumanBinding {
  sub: string;      // Human subject from IdP
  email: string;    // Human email
  iss: string;      // Identity provider URL
  groups: string[]; // Group memberships
}
```

### AgentMetadata

```typescript
interface AgentMetadata {
  name: string;       // Agent name (required)
  model?: string;     // LLM model identifier
  framework?: string; // Agent framework
}
```

### Delegation

```typescript
interface Delegation {
  depth: number;       // Current depth (0 = root)
  max_depth: number;   // Maximum allowed depth
  chain: string[];     // Ancestor SPIFFE URIs
  can_delegate: string[]; // Scopes this agent can delegate
}
```

### DelegationRequest

```typescript
interface DelegationRequest {
  parent_token: string;
  child_agent: AgentMetadata;
  requested_scope: string[];
  ttl_seconds?: number;
}
```

### DelegationResult

```typescript
interface DelegationResult {
  token: string;         // Child JWS
  granted_scope: string[];
  denied_scope: string[];
  delegation_depth: number;
}
```

### RevocationResult

```typescript
interface RevocationResult {
  revoked_agent_id: string;
  cascade_revoked: string[];
  total_revoked: number;
}
```
