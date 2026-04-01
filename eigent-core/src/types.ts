import { z } from 'zod';

// --- Zod schemas for runtime validation ---

export const HumanBindingSchema = z.object({
  sub: z.string().min(1, 'Human subject is required'),
  email: z.string().email('Valid email is required'),
  iss: z.string().url('Human IdP issuer must be a valid URL'),
  groups: z.array(z.string()),
});

export const AgentMetadataSchema = z.object({
  name: z.string().min(1, 'Agent name is required'),
  model: z.string().optional(),
  framework: z.string().optional(),
});

export const DelegationSchema = z.object({
  depth: z.number().int().min(0),
  max_depth: z.number().int().min(0),
  chain: z.array(z.string()),
  can_delegate: z.array(z.string()),
});

export const EigentTokenClaimsSchema = z.object({
  sub: z.string().regex(
    /^spiffe:\/\/.+\/agent\/.+$/,
    'Subject must be a SPIFFE URI: spiffe://<trust-domain>/agent/<agent-id>',
  ),
  iss: z.string().url('Issuer must be a valid URL'),
  aud: z.string().min(1, 'Audience is required'),
  human: HumanBindingSchema,
  agent: AgentMetadataSchema,
  scope: z.array(z.string()).min(1, 'At least one scope is required'),
  delegation: DelegationSchema,
  exp_seconds: z.number().int().positive().optional(),
});

export const DelegationRequestSchema = z.object({
  parent_token: z.string().min(1, 'Parent token is required'),
  child_agent: AgentMetadataSchema,
  requested_scope: z.array(z.string()).min(1, 'At least one scope must be requested'),
  ttl_seconds: z.number().int().positive().optional(),
});

// --- TypeScript interfaces ---

export interface HumanBinding {
  sub: string;
  email: string;
  iss: string;
  groups: string[];
}

export interface AgentMetadata {
  name: string;
  model?: string;
  framework?: string;
}

export interface Delegation {
  depth: number;
  max_depth: number;
  chain: string[];
  can_delegate: string[];
}

export interface EigentToken {
  // Header fields (from JWS header)
  alg: 'EdDSA';
  typ: 'eigent+jwt';
  kid: string;

  // Standard JWT claims
  jti: string;
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;

  // Eigent-specific claims
  human: HumanBinding;
  agent: AgentMetadata;
  scope: string[];
  delegation: Delegation;
}

/** Input claims for token issuance (jti, iat, exp are generated) */
export interface EigentTokenClaims {
  sub: string;
  iss: string;
  aud: string;
  human: HumanBinding;
  agent: AgentMetadata;
  scope: string[];
  delegation: Delegation;
  /** Token lifetime in seconds. Defaults to 3600 (1 hour). */
  exp_seconds?: number;
}

export interface DelegationRequest {
  parent_token: string;
  child_agent: AgentMetadata;
  requested_scope: string[];
  ttl_seconds?: number;
}

export interface DelegationResult {
  token: string;
  granted_scope: string[];
  denied_scope: string[];
  delegation_depth: number;
}

export interface RevocationResult {
  revoked_agent_id: string;
  cascade_revoked: string[];
  total_revoked: number;
}

export interface DelegationChainValidation {
  valid: boolean;
  chain: EigentToken[];
  violations: string[];
}
