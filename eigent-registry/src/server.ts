import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import * as crypto from 'node:crypto';
import {
  insertAgent,
  getAgentById,
  listAgents,
  revokeAgentCascade,
  getDelegationChain,
  insertAuditLog,
  queryAuditLog,
  getAgentByTokenJti,
  listOIDCProviders,
  insertSession,
  getActiveSession,
  deleteSession,
  type AgentRow,
  type SessionRow,
} from './db.js';
import { issueToken, verifyToken, getJwks, type EigentTokenPayload } from './tokens.js';
import { generateComplianceReport, type ComplianceFramework } from './compliance-report.js';
import {
  discoverProvider,
  verifyIdToken,
  extractHumanIdentity,
  generatePKCE,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  loadProviderFromEnv,
  type OIDCProviderConfig,
  type PKCEChallenge,
} from './oidc.js';
import { scimApp } from './scim.js';
import {
  rotateToken,
  recordHeartbeat,
  findStaleAgents,
  deprovisionAgent,
  deprovisionHuman,
  getAgentUsage,
  getUsageSummary,
  startBackgroundJobs,
  stopBackgroundJobs,
} from './lifecycle.js';

export const app = new Hono();

// Mount SCIM webhook routes
app.route('/', scimApp);

// ─── In-memory PKCE state store (for auth flow) ───
// In production, use Redis or a database-backed store
const pendingAuthFlows = new Map<string, {
  pkce: PKCEChallenge;
  provider: OIDCProviderConfig;
  redirectUri: string;
  createdAt: number;
}>();

// Clean up expired auth flows every 5 minutes
const AUTH_FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Validation Schemas ───

const RegisterAgentSchema = z.object({
  name: z.string().min(1).max(255),
  // human_sub, human_email, human_iss are optional when human_id_token is provided
  human_sub: z.string().min(1).optional(),
  human_email: z.string().email().optional(),
  human_iss: z.string().url().optional(),
  scope: z.array(z.string().min(1)).min(1),
  max_delegation_depth: z.number().int().min(0).max(10).default(3),
  can_delegate: z.array(z.string()).default([]),
  ttl_seconds: z.number().int().min(60).max(86400 * 30).default(3600),
  metadata: z.record(z.unknown()).optional(),
  // Optional OIDC ID token for verified human binding
  human_id_token: z.string().optional(),
});

const DelegateSchema = z.object({
  parent_token: z.string().min(1),
  child_name: z.string().min(1).max(255),
  requested_scope: z.array(z.string().min(1)).min(1),
  ttl_seconds: z.number().int().min(60).max(86400 * 30).default(3600),
  metadata: z.record(z.unknown()).optional(),
});

const VerifySchema = z.object({
  token: z.string().min(1),
  tool_name: z.string().min(1),
});

// ─── Helper ───

function auditId(): string {
  return uuidv7();
}

function buildDelegationChainIds(agent: AgentRow): string[] {
  const chain = getDelegationChain(agent.id);
  return chain.map((a) => a.id);
}

// ─── Routes ───

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'eigent-registry' });
});

// POST /api/agents — Register a new agent
app.post('/api/agents', async (c) => {
  const body = await c.req.json();
  const parsed = RegisterAgentSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const input = parsed.data;

  // Resolve human identity: from OIDC token or from request fields (dev mode)
  let humanSub: string;
  let humanEmail: string;
  let humanIss: string;
  let identityVerified = false;

  if (input.human_id_token) {
    // OIDC-verified path: verify the ID token and extract identity
    const envProvider = loadProviderFromEnv();
    if (!envProvider) {
      return c.json({
        error: 'OIDC not configured. Set EIGENT_OIDC_ISSUER, EIGENT_OIDC_CLIENT_ID, and EIGENT_OIDC_CLIENT_SECRET.',
      }, 500);
    }

    try {
      const decoded = await verifyIdToken(input.human_id_token, envProvider);
      const identity = extractHumanIdentity(decoded);
      humanSub = identity.sub;
      humanEmail = identity.email;
      humanIss = identity.issuer;
      identityVerified = true;
    } catch (err) {
      return c.json({
        error: 'ID token verification failed',
        details: (err as Error).message,
      }, 401);
    }
  } else {
    // Dev mode: use provided fields directly (unverified)
    if (!input.human_sub || !input.human_email || !input.human_iss) {
      return c.json({
        error: 'When human_id_token is not provided, human_sub, human_email, and human_iss are required (dev mode)',
      }, 400);
    }
    humanSub = input.human_sub;
    humanEmail = input.human_email;
    humanIss = input.human_iss;
  }

  const agentId = uuidv7();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttl_seconds * 1000);

  // Determine delegatable scopes: default to full scope if not specified
  const canDelegate = input.can_delegate.length > 0 ? input.can_delegate : input.scope;

  const tokenPayload: EigentTokenPayload = {
    agent_id: agentId,
    human_sub: humanSub,
    human_email: humanEmail,
    human_iss: humanIss,
    scope: input.scope,
    delegation_depth: 0,
    max_delegation_depth: input.max_delegation_depth,
    delegation_chain: [agentId],
    can_delegate: canDelegate,
  };

  const { token, jti } = await issueToken(tokenPayload, expiresAt);

  const agent: AgentRow = {
    id: agentId,
    name: input.name,
    human_sub: humanSub,
    human_email: humanEmail,
    human_iss: humanIss,
    scope: JSON.stringify(input.scope),
    parent_id: null,
    delegation_depth: 0,
    max_delegation_depth: input.max_delegation_depth,
    can_delegate: JSON.stringify(canDelegate),
    token_jti: jti,
    status: 'active',
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    revoked_at: null,
    last_seen_at: null,
    deprovisioned_at: null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  };

  insertAgent(agent);

  insertAuditLog({
    id: auditId(),
    timestamp: now.toISOString(),
    agent_id: agentId,
    human_email: humanEmail,
    action: 'issued',
    tool_name: null,
    delegation_chain: JSON.stringify([agentId]),
    details: JSON.stringify({
      scope: input.scope,
      ttl_seconds: input.ttl_seconds,
      identity_verified: identityVerified,
    }),
  });

  return c.json({
    agent_id: agentId,
    token,
    scope: input.scope,
    expires_at: expiresAt.toISOString(),
    identity_verified: identityVerified,
  }, 201);
});

// POST /api/agents/:id/delegate — Delegate to a child agent
app.post('/api/agents/:id/delegate', async (c) => {
  const parentId = c.req.param('id');
  const body = await c.req.json();
  const parsed = DelegateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const input = parsed.data;

  // Verify parent token
  let parentTokenPayload;
  try {
    const verified = await verifyToken(input.parent_token);
    parentTokenPayload = verified.payload;
  } catch (err) {
    return c.json({ error: 'Invalid parent token', details: (err as Error).message }, 401);
  }

  // Verify the token belongs to the specified parent agent
  if (parentTokenPayload.agent_id !== parentId) {
    return c.json({ error: 'Token does not match the specified parent agent' }, 403);
  }

  // Get parent agent from DB
  const parentAgent = getAgentById(parentId);
  if (!parentAgent) {
    return c.json({ error: 'Parent agent not found' }, 404);
  }

  if (parentAgent.status !== 'active') {
    return c.json({ error: 'Parent agent is not active', status: parentAgent.status }, 403);
  }

  // Check delegation depth
  const currentDepth = parentAgent.delegation_depth;
  if (currentDepth >= parentAgent.max_delegation_depth) {
    return c.json({
      error: 'Maximum delegation depth exceeded',
      current_depth: currentDepth,
      max_depth: parentAgent.max_delegation_depth,
    }, 403);
  }

  // Compute scope intersection: child gets only scopes the parent can delegate
  const parentDelegatable: string[] = parentAgent.can_delegate
    ? JSON.parse(parentAgent.can_delegate)
    : [];
  const grantedScope = input.requested_scope.filter((s) => parentDelegatable.includes(s));
  const deniedScope = input.requested_scope.filter((s) => !parentDelegatable.includes(s));

  if (grantedScope.length === 0) {
    return c.json({
      error: 'No requested scopes are delegatable by the parent',
      requested: input.requested_scope,
      parent_can_delegate: parentDelegatable,
    }, 403);
  }

  const childId = uuidv7();
  const now = new Date();

  // Child TTL cannot exceed parent's remaining TTL
  const parentExpiresAt = new Date(parentAgent.expires_at);
  const maxChildExpiry = parentExpiresAt.getTime();
  const requestedExpiry = now.getTime() + input.ttl_seconds * 1000;
  const childExpiresAt = new Date(Math.min(maxChildExpiry, requestedExpiry));

  const parentChain = buildDelegationChainIds(parentAgent);
  const childChain = [...parentChain, childId];
  const childDepth = currentDepth + 1;

  // Child can only delegate what it was granted (further narrowing)
  const childCanDelegate = grantedScope;

  const tokenPayload: EigentTokenPayload = {
    agent_id: childId,
    human_sub: parentAgent.human_sub,
    human_email: parentAgent.human_email,
    human_iss: parentAgent.human_iss,
    scope: grantedScope,
    delegation_depth: childDepth,
    max_delegation_depth: parentAgent.max_delegation_depth,
    delegation_chain: childChain,
    can_delegate: childCanDelegate,
  };

  const { token, jti } = await issueToken(tokenPayload, childExpiresAt);

  const childAgent: AgentRow = {
    id: childId,
    name: input.child_name,
    human_sub: parentAgent.human_sub,
    human_email: parentAgent.human_email,
    human_iss: parentAgent.human_iss,
    scope: JSON.stringify(grantedScope),
    parent_id: parentId,
    delegation_depth: childDepth,
    max_delegation_depth: parentAgent.max_delegation_depth,
    can_delegate: JSON.stringify(childCanDelegate),
    token_jti: jti,
    status: 'active',
    created_at: now.toISOString(),
    expires_at: childExpiresAt.toISOString(),
    revoked_at: null,
    last_seen_at: null,
    deprovisioned_at: null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  };

  insertAgent(childAgent);

  insertAuditLog({
    id: auditId(),
    timestamp: now.toISOString(),
    agent_id: childId,
    human_email: parentAgent.human_email,
    action: 'delegated',
    tool_name: null,
    delegation_chain: JSON.stringify(childChain),
    details: JSON.stringify({
      parent_id: parentId,
      granted_scope: grantedScope,
      denied_scope: deniedScope,
      delegation_depth: childDepth,
    }),
  });

  return c.json({
    child_agent_id: childId,
    token,
    granted_scope: grantedScope,
    denied_scope: deniedScope,
    delegation_depth: childDepth,
    expires_at: childExpiresAt.toISOString(),
  }, 201);
});

// DELETE /api/agents/:id — Revoke agent (cascade)
app.delete('/api/agents/:id', (c) => {
  const agentId = c.req.param('id');
  const agent = getAgentById(agentId);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  if (agent.status === 'revoked') {
    return c.json({ error: 'Agent is already revoked' }, 409);
  }

  const revokedIds = revokeAgentCascade(agentId);
  const now = new Date().toISOString();

  // Log each revocation
  for (const id of revokedIds) {
    const revokedAgent = getAgentById(id)!;
    insertAuditLog({
      id: auditId(),
      timestamp: now,
      agent_id: id,
      human_email: revokedAgent.human_email,
      action: 'revoked',
      tool_name: null,
      delegation_chain: JSON.stringify(buildDelegationChainIds(revokedAgent)),
      details: JSON.stringify({
        reason: id === agentId ? 'direct_revocation' : 'cascade_revocation',
        triggered_by: agentId,
      }),
    });
  }

  const cascadeRevoked = revokedIds.filter((id) => id !== agentId);

  return c.json({
    revoked_agent_id: agentId,
    cascade_revoked: cascadeRevoked,
    total_revoked: revokedIds.length,
  });
});

// GET /api/agents/stale — List stale agents (must be before :id route)
app.get('/api/agents/stale', (c) => {
  const threshold = c.req.query('threshold_minutes');
  const thresholdMinutes = threshold ? parseInt(threshold, 10) : undefined;

  const staleAgents = findStaleAgents(thresholdMinutes);
  return c.json({
    stale_agents: staleAgents,
    total: staleAgents.length,
    threshold_minutes: thresholdMinutes ?? 30,
  });
});

// GET /api/agents/:id — Get agent details
app.get('/api/agents/:id', (c) => {
  const agentId = c.req.param('id');
  const agent = getAgentById(agentId);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  return c.json({
    ...agent,
    scope: JSON.parse(agent.scope),
    can_delegate: agent.can_delegate ? JSON.parse(agent.can_delegate) : null,
    metadata: agent.metadata ? JSON.parse(agent.metadata) : null,
    delegation_chain: buildDelegationChainIds(agent),
  });
});

// GET /api/agents/:id/chain — Get full delegation chain
app.get('/api/agents/:id/chain', (c) => {
  const agentId = c.req.param('id');
  const agent = getAgentById(agentId);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const chain = getDelegationChain(agentId);
  return c.json({
    agent_id: agentId,
    chain: chain.map((a) => ({
      id: a.id,
      name: a.name,
      delegation_depth: a.delegation_depth,
      scope: JSON.parse(a.scope),
      status: a.status,
      human_email: a.human_email,
      created_at: a.created_at,
    })),
    depth: chain.length - 1,
    root_human_email: chain[0]?.human_email,
  });
});

// GET /api/agents — List all agents (with filters)
app.get('/api/agents', (c) => {
  const status = c.req.query('status') ?? 'active';
  const human_email = c.req.query('human_email');
  const parent_id = c.req.query('parent_id');

  const agents = listAgents({
    status: status || undefined,
    human_email: human_email || undefined,
    parent_id: parent_id || undefined,
  });

  return c.json({
    agents: agents.map((a) => ({
      ...a,
      scope: JSON.parse(a.scope),
      can_delegate: a.can_delegate ? JSON.parse(a.can_delegate) : null,
      metadata: a.metadata ? JSON.parse(a.metadata) : null,
    })),
    total: agents.length,
  });
});

// POST /api/verify — Verify a token and check if action is allowed
app.post('/api/verify', async (c) => {
  const body = await c.req.json();
  const parsed = VerifySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { token, tool_name } = parsed.data;

  // Verify token signature and expiration
  let tokenPayload;
  let jti: string;
  try {
    const verified = await verifyToken(token);
    tokenPayload = verified.payload;
    jti = verified.jti;
  } catch (err) {
    return c.json({
      allowed: false,
      reason: `Token verification failed: ${(err as Error).message}`,
    }, 401);
  }

  // Check if agent exists and is active
  const agent = getAgentByTokenJti(jti);
  if (!agent) {
    return c.json({
      allowed: false,
      reason: 'Agent not found for this token',
    }, 404);
  }

  if (agent.status === 'revoked') {
    insertAuditLog({
      id: auditId(),
      timestamp: new Date().toISOString(),
      agent_id: agent.id,
      human_email: agent.human_email,
      action: 'tool_call_blocked',
      tool_name,
      delegation_chain: JSON.stringify(buildDelegationChainIds(agent)),
      details: JSON.stringify({ reason: 'agent_revoked' }),
    });

    return c.json({
      allowed: false,
      agent_id: agent.id,
      human_email: agent.human_email,
      delegation_chain: buildDelegationChainIds(agent),
      reason: 'Agent has been revoked',
    });
  }

  // Check expiration from DB record
  if (new Date(agent.expires_at) < new Date()) {
    insertAuditLog({
      id: auditId(),
      timestamp: new Date().toISOString(),
      agent_id: agent.id,
      human_email: agent.human_email,
      action: 'tool_call_blocked',
      tool_name,
      delegation_chain: JSON.stringify(buildDelegationChainIds(agent)),
      details: JSON.stringify({ reason: 'token_expired' }),
    });

    return c.json({
      allowed: false,
      agent_id: agent.id,
      human_email: agent.human_email,
      delegation_chain: buildDelegationChainIds(agent),
      reason: 'Token has expired',
    });
  }

  // Check scope
  const agentScope: string[] = JSON.parse(agent.scope);
  const allowed = agentScope.includes(tool_name);

  const action = allowed ? 'tool_call_allowed' : 'tool_call_blocked';
  const chain = buildDelegationChainIds(agent);

  insertAuditLog({
    id: auditId(),
    timestamp: new Date().toISOString(),
    agent_id: agent.id,
    human_email: agent.human_email,
    action,
    tool_name,
    delegation_chain: JSON.stringify(chain),
    details: JSON.stringify({
      reason: allowed ? 'in_scope' : 'not_in_scope',
      agent_scope: agentScope,
    }),
  });

  if (!allowed) {
    return c.json({
      allowed: false,
      agent_id: agent.id,
      human_email: agent.human_email,
      delegation_chain: chain,
      reason: `Tool "${tool_name}" is not in agent scope: [${agentScope.join(', ')}]`,
    });
  }

  return c.json({
    allowed: true,
    agent_id: agent.id,
    human_email: agent.human_email,
    delegation_chain: chain,
    reason: 'Tool is within agent scope',
  });
});

// GET /api/audit — Query audit log
app.get('/api/audit', (c) => {
  const agent_id = c.req.query('agent_id');
  const human_email = c.req.query('human_email');
  const action = c.req.query('action');
  const tool_name = c.req.query('tool_name');
  const from_date = c.req.query('from_date');
  const to_date = c.req.query('to_date');
  const limit = c.req.query('limit');
  const offset = c.req.query('offset');

  const result = queryAuditLog({
    agent_id: agent_id || undefined,
    human_email: human_email || undefined,
    action: action || undefined,
    tool_name: tool_name || undefined,
    from_date: from_date || undefined,
    to_date: to_date || undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  return c.json({
    entries: result.entries.map((e) => ({
      ...e,
      delegation_chain: e.delegation_chain ? JSON.parse(e.delegation_chain) : null,
      details: e.details ? JSON.parse(e.details) : null,
    })),
    total: result.total,
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  });
});

// ─── Auth Routes ───

// POST /api/auth/login — Initiate OIDC Authorization Code + PKCE flow
app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const redirectUri = (body as Record<string, unknown>).redirect_uri as string | undefined
    ?? 'http://localhost:3456/api/auth/callback';

  const envProvider = loadProviderFromEnv();
  if (!envProvider) {
    return c.json({
      error: 'OIDC not configured',
      message: 'Set EIGENT_OIDC_ISSUER, EIGENT_OIDC_CLIENT_ID, and EIGENT_OIDC_CLIENT_SECRET environment variables.',
    }, 500);
  }

  try {
    const discovery = await discoverProvider(envProvider.issuerUrl);
    const pkce = await generatePKCE();

    const authUrl = buildAuthorizationUrl(envProvider, discovery, pkce, redirectUri);

    // Store the PKCE state for the callback
    pendingAuthFlows.set(pkce.state, {
      pkce,
      provider: envProvider,
      redirectUri,
      createdAt: Date.now(),
    });

    // Clean up old flows
    const now = Date.now();
    for (const [key, flow] of pendingAuthFlows) {
      if (now - flow.createdAt > AUTH_FLOW_TTL_MS) {
        pendingAuthFlows.delete(key);
      }
    }

    return c.json({
      authorization_url: authUrl,
      state: pkce.state,
      provider: {
        type: envProvider.type,
        issuer: envProvider.issuerUrl,
      },
    });
  } catch (err) {
    return c.json({
      error: 'Failed to initiate OIDC login',
      details: (err as Error).message,
    }, 500);
  }
});

// POST /api/auth/callback — OIDC callback: exchange code for tokens
app.post('/api/auth/callback', async (c) => {
  const CallbackSchema = z.object({
    code: z.string().min(1),
    state: z.string().min(1),
  });

  const body = await c.req.json();
  const parsed = CallbackSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid callback payload', details: parsed.error.flatten() }, 400);
  }

  const { code, state } = parsed.data;

  // Look up the pending auth flow
  const authFlow = pendingAuthFlows.get(state);
  if (!authFlow) {
    return c.json({ error: 'Invalid or expired auth state. Please restart login.' }, 400);
  }

  pendingAuthFlows.delete(state);

  // Check TTL
  if (Date.now() - authFlow.createdAt > AUTH_FLOW_TTL_MS) {
    return c.json({ error: 'Auth flow expired. Please restart login.' }, 400);
  }

  try {
    const discovery = await discoverProvider(authFlow.provider.issuerUrl);

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(
      authFlow.provider,
      discovery,
      code,
      authFlow.pkce.codeVerifier,
      authFlow.redirectUri,
    );

    // Verify the ID token
    const decoded = await verifyIdToken(tokens.id_token, authFlow.provider);
    const identity = extractHumanIdentity(decoded);

    // Create a session
    const sessionId = uuidv7();
    const now = new Date();
    const sessionExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

    // Hash the ID token for storage (don't store raw tokens)
    const idTokenHash = crypto
      .createHash('sha256')
      .update(tokens.id_token)
      .digest('hex');

    const session: SessionRow = {
      id: sessionId,
      human_sub: identity.sub,
      human_email: identity.email,
      human_iss: identity.issuer,
      id_token_hash: idTokenHash,
      provider_id: authFlow.provider.id,
      expires_at: sessionExpiry.toISOString(),
      created_at: now.toISOString(),
    };

    insertSession(session);

    insertAuditLog({
      id: auditId(),
      timestamp: now.toISOString(),
      agent_id: 'system',
      human_email: identity.email,
      action: 'oidc_login',
      tool_name: null,
      delegation_chain: null,
      details: JSON.stringify({
        provider_type: authFlow.provider.type,
        issuer: identity.issuer,
        human_sub: identity.sub,
        identity_verified: true,
      }),
    });

    return c.json({
      session_token: sessionId,
      human_email: identity.email,
      human_sub: identity.sub,
      human_iss: identity.issuer,
      provider_type: authFlow.provider.type,
      expires_at: sessionExpiry.toISOString(),
      identity_verified: true,
    });
  } catch (err) {
    return c.json({
      error: 'OIDC callback failed',
      details: (err as Error).message,
    }, 401);
  }
});

// GET /api/auth/providers — List configured OIDC providers
app.get('/api/auth/providers', (c) => {
  const dbProviders = listOIDCProviders(true);

  const providers = dbProviders.map((p) => ({
    id: p.id,
    type: p.type,
    issuer_url: p.issuer_url,
    enabled: p.enabled === 1,
  }));

  // Also include the env-configured provider if present
  const envProvider = loadProviderFromEnv();
  if (envProvider) {
    const alreadyListed = providers.some((p) => p.issuer_url === envProvider.issuerUrl);
    if (!alreadyListed) {
      providers.push({
        id: 'env-default',
        type: envProvider.type,
        issuer_url: envProvider.issuerUrl,
        enabled: true,
      });
    }
  }

  return c.json({ providers });
});

// POST /api/auth/session/verify — Verify a session token is still valid
app.post('/api/auth/session/verify', async (c) => {
  const body = await c.req.json();
  const sessionToken = (body as Record<string, unknown>).session_token as string | undefined;

  if (!sessionToken) {
    return c.json({ error: 'session_token is required' }, 400);
  }

  const session = getActiveSession(sessionToken);
  if (!session) {
    return c.json({ valid: false, reason: 'Session not found or expired' }, 401);
  }

  return c.json({
    valid: true,
    human_email: session.human_email,
    human_sub: session.human_sub,
    human_iss: session.human_iss,
    expires_at: session.expires_at,
  });
});

// POST /api/auth/logout — Destroy a session
app.post('/api/auth/logout', async (c) => {
  const body = await c.req.json();
  const sessionToken = (body as Record<string, unknown>).session_token as string | undefined;

  if (!sessionToken) {
    return c.json({ error: 'session_token is required' }, 400);
  }

  deleteSession(sessionToken);

  return c.json({ status: 'logged_out' });
});

// ─── Lifecycle Routes ───

// POST /api/agents/:id/rotate — Rotate agent token
app.post('/api/agents/:id/rotate', async (c) => {
  const agentId = c.req.param('id');

  try {
    const result = await rotateToken(agentId);
    return c.json({
      agent_id: result.agent_id,
      new_token: result.new_token,
      old_token_expires: result.old_token_expires.toISOString(),
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('not found')) {
      return c.json({ error: message }, 404);
    }
    if (message.includes('Cannot rotate')) {
      return c.json({ error: message }, 409);
    }
    return c.json({ error: message }, 500);
  }
});

// POST /api/agents/:id/heartbeat — Record agent heartbeat
app.post('/api/agents/:id/heartbeat', (c) => {
  const agentId = c.req.param('id');

  try {
    const result = recordHeartbeat(agentId);
    return c.json({
      agent_id: agentId,
      last_seen_at: result.last_seen_at,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('not found')) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 500);
  }
});

// POST /api/agents/:id/deprovision — Permanently deprovision an agent
app.post('/api/agents/:id/deprovision', (c) => {
  const agentId = c.req.param('id');

  try {
    const result = deprovisionAgent(agentId);
    return c.json({
      agent_id: result.agent_id,
      agent_name: result.agent_name,
      deprovisioned_at: result.deprovisioned_at,
      cascade_revoked: result.cascade_revoked,
      total_affected: result.cascade_revoked.length + 1,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('not found')) {
      return c.json({ error: message }, 404);
    }
    if (message.includes('already deprovisioned')) {
      return c.json({ error: message }, 409);
    }
    return c.json({ error: message }, 500);
  }
});

// POST /api/humans/:email/deprovision — Deprovision all agents for a human (SCIM hook)
app.post('/api/humans/:email/deprovision', (c) => {
  const email = c.req.param('email');

  const result = deprovisionHuman(email);
  return c.json({
    human_email: result.human_email,
    deprovisioned_at: result.deprovisioned_at,
    agents_affected: result.agents_affected,
    agent_ids: result.agent_ids,
    agent_names: result.agent_names,
    message: `Human ${email} deprovisioned. ${result.agents_affected} agents cascade revoked.`,
  });
});

// GET /api/agents/:id/usage — Get usage stats for an agent
app.get('/api/agents/:id/usage', (c) => {
  const agentId = c.req.param('id');
  const hoursParam = c.req.query('hours');
  const hours = hoursParam ? parseInt(hoursParam, 10) : undefined;

  const agent = getAgentById(agentId);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const usage = getAgentUsage(agentId, hours);
  return c.json({
    agent_id: agentId,
    agent_name: agent.name,
    hours: hours ?? 24,
    usage,
  });
});

// GET /api/usage/summary — Org-wide usage summary
app.get('/api/usage/summary', (c) => {
  const hoursParam = c.req.query('hours');
  const hours = hoursParam ? parseInt(hoursParam, 10) : undefined;

  const summary = getUsageSummary(hours);
  return c.json({
    hours: hours ?? 24,
    ...summary,
  });
});

// Export lifecycle control for index.ts
export { startBackgroundJobs, stopBackgroundJobs };

// GET /api/compliance/report — Generate compliance report
app.get('/api/compliance/report', (c) => {
  const periodParam = c.req.query('period') ?? '30d';
  const framework = (c.req.query('framework') ?? 'all') as ComplianceFramework;
  const format = c.req.query('format') ?? 'html';
  const human = c.req.query('human');
  const agentIds = c.req.query('agents');

  // Validate framework
  const validFrameworks: ComplianceFramework[] = ['eu-ai-act', 'soc2', 'all'];
  if (!validFrameworks.includes(framework)) {
    return c.json({ error: `Invalid framework. Must be one of: ${validFrameworks.join(', ')}` }, 400);
  }

  // Parse period (e.g. "30d", "7d", "90d")
  const periodMatch = periodParam.match(/^(\d+)([dhm])$/);
  if (!periodMatch) {
    return c.json({ error: 'Invalid period format. Use format like 30d, 7d, 90d, 24h' }, 400);
  }

  const periodValue = parseInt(periodMatch[1], 10);
  const periodUnit = periodMatch[2];
  let periodMs: number;
  switch (periodUnit) {
    case 'd': periodMs = periodValue * 86400000; break;
    case 'h': periodMs = periodValue * 3600000; break;
    case 'm': periodMs = periodValue * 60000; break;
    default: periodMs = 30 * 86400000;
  }

  const end = new Date();
  const start = new Date(end.getTime() - periodMs);

  const agents = agentIds ? agentIds.split(',') : 'all' as const;

  const html = generateComplianceReport({
    period: { start, end },
    framework,
    agents,
    human: human || undefined,
  });

  if (format === 'html') {
    return c.html(html);
  }

  return c.json({
    report_html: html,
    generated_at: new Date().toISOString(),
    period: { start: start.toISOString(), end: end.toISOString() },
    framework,
  });
});

// GET /api/.well-known/jwks.json — Public key endpoint
app.get('/api/.well-known/jwks.json', (c) => {
  const jwks = getJwks();
  return c.json(jwks);
});
