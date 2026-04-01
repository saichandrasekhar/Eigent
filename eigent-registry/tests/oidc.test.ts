import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as jose from 'jose';
import { app } from '../src/server.js';
import { initDb, closeDb, insertSession, getActiveSession } from '../src/db.js';
import { ensureSigningKey } from '../src/tokens.js';
import {
  extractHumanIdentity,
  clearJWKSCache,
  type DecodedIdToken,
} from '../src/oidc.js';

// ─── Test Helpers ───

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

async function post(path: string, body: unknown) {
  const res = await request('POST', path, body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string) {
  const res = await request('GET', path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function del(path: string) {
  const res = await request('DELETE', path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const HUMAN = {
  human_sub: 'oidc-user-456',
  human_email: 'bob@acme.com',
  human_iss: 'https://accounts.google.com',
};

// ─── Setup ───

beforeAll(async () => {
  initDb(':memory:');
  await ensureSigningKey();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  clearJWKSCache();
});

// ─── OIDC Tests ───

describe('OIDC Identity Extraction', () => {
  it('extracts identity from a standard OIDC token payload', () => {
    const decoded: DecodedIdToken = {
      sub: 'user-123',
      email: 'alice@acme.com',
      email_verified: true,
      groups: ['engineering', 'admin'],
      name: 'Alice Smith',
      iss: 'https://login.okta.com/oauth2/default',
      aud: 'client-id-abc',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };

    const identity = extractHumanIdentity(decoded);

    expect(identity.sub).toBe('user-123');
    expect(identity.email).toBe('alice@acme.com');
    expect(identity.emailVerified).toBe(true);
    expect(identity.groups).toEqual(['engineering', 'admin']);
    expect(identity.issuer).toBe('https://login.okta.com/oauth2/default');
    expect(identity.name).toBe('Alice Smith');
  });

  it('extracts identity from Microsoft Entra token with tenant ID', () => {
    const decoded: DecodedIdToken = {
      sub: 'entra-user-789',
      email: 'bob@contoso.com',
      email_verified: true,
      tid: 'tenant-uuid-123',
      name: 'Bob Jones',
      iss: 'https://login.microsoftonline.com/tenant-uuid-123/v2.0',
      aud: 'entra-client-id',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };

    const identity = extractHumanIdentity(decoded);

    expect(identity.sub).toBe('entra-user-789');
    expect(identity.email).toBe('bob@contoso.com');
    expect(identity.org).toBe('tenant-uuid-123');
    expect(identity.issuer).toBe('https://login.microsoftonline.com/tenant-uuid-123/v2.0');
  });

  it('handles token with missing optional fields gracefully', () => {
    const decoded: DecodedIdToken = {
      sub: 'minimal-user',
      iss: 'https://generic-idp.com',
      aud: 'some-client',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };

    const identity = extractHumanIdentity(decoded);

    expect(identity.sub).toBe('minimal-user');
    expect(identity.email).toBe('');
    expect(identity.emailVerified).toBe(false);
    expect(identity.groups).toEqual([]);
    expect(identity.org).toBe('');
    expect(identity.name).toBeUndefined();
  });

  it('extracts Cognito groups format', () => {
    const decoded: DecodedIdToken = {
      sub: 'cognito-user',
      email: 'user@example.com',
      'cognito:groups': ['admins', 'developers'],
      iss: 'https://cognito-idp.us-east-1.amazonaws.com/pool-id',
      aud: 'cognito-client',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };

    const identity = extractHumanIdentity(decoded);
    expect(identity.groups).toEqual(['admins', 'developers']);
  });
});

describe('ID Token Verification (real JWT)', () => {
  it('creates and verifies a real JWT using a test JWKS', async () => {
    // Generate a key pair for testing
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256', {
      extractable: true,
    });

    const kid = 'test-key-1';
    const publicJwk = await jose.exportJWK(publicKey);
    publicJwk.kid = kid;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    // Create a real ID token
    const idToken = await new jose.SignJWT({
      sub: 'real-user-123',
      email: 'verified@acme.com',
      email_verified: true,
      groups: ['eng'],
      name: 'Verified User',
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer('https://test-idp.example.com')
      .setAudience('test-client-id')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    // Verify the token manually (simulating what verifyIdToken does)
    const jwks = jose.createLocalJWKSet({ keys: [publicJwk] });
    const { payload } = await jose.jwtVerify(idToken, jwks, {
      issuer: 'https://test-idp.example.com',
      audience: 'test-client-id',
    });

    expect(payload.sub).toBe('real-user-123');
    expect(payload.email).toBe('verified@acme.com');
    expect(payload.email_verified).toBe(true);

    // Extract identity from the verified payload
    const identity = extractHumanIdentity(payload as unknown as DecodedIdToken);
    expect(identity.sub).toBe('real-user-123');
    expect(identity.email).toBe('verified@acme.com');
    expect(identity.emailVerified).toBe(true);
    expect(identity.groups).toEqual(['eng']);
  });

  it('rejects a JWT with wrong audience', async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');

    const kid = 'test-key-2';
    const publicJwk = await jose.exportJWK(publicKey);
    publicJwk.kid = kid;

    const idToken = await new jose.SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://test-idp.example.com')
      .setAudience('wrong-client')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const jwks = jose.createLocalJWKSet({ keys: [publicJwk] });

    await expect(
      jose.jwtVerify(idToken, jwks, {
        issuer: 'https://test-idp.example.com',
        audience: 'correct-client',
      }),
    ).rejects.toThrow();
  });

  it('rejects an expired JWT', async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');

    const kid = 'test-key-3';
    const publicJwk = await jose.exportJWK(publicKey);
    publicJwk.kid = kid;

    // Create a token that expired 1 hour ago
    const idToken = await new jose.SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://test-idp.example.com')
      .setAudience('test-client')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

    const jwks = jose.createLocalJWKSet({ keys: [publicJwk] });

    await expect(
      jose.jwtVerify(idToken, jwks, {
        issuer: 'https://test-idp.example.com',
        audience: 'test-client',
      }),
    ).rejects.toThrow();
  });

  it('rejects a JWT with wrong issuer', async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');

    const kid = 'test-key-4';
    const publicJwk = await jose.exportJWK(publicKey);
    publicJwk.kid = kid;

    const idToken = await new jose.SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://evil-idp.example.com')
      .setAudience('test-client')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const jwks = jose.createLocalJWKSet({ keys: [publicJwk] });

    await expect(
      jose.jwtVerify(idToken, jwks, {
        issuer: 'https://trusted-idp.example.com',
        audience: 'test-client',
      }),
    ).rejects.toThrow();
  });
});

describe('Agent Registration with Dev Mode (no OIDC token)', () => {
  it('registers agent with explicit human fields (dev mode)', async () => {
    const res = await post('/api/agents', {
      name: 'dev-mode-agent',
      ...HUMAN,
      scope: ['read_file'],
      ttl_seconds: 3600,
    });

    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBeDefined();
    expect(res.body.token).toBeDefined();
    expect(res.body.identity_verified).toBe(false);
  });

  it('rejects registration without human fields or id token', async () => {
    const res = await post('/api/agents', {
      name: 'no-identity-agent',
      scope: ['read_file'],
      ttl_seconds: 3600,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('human_sub');
  });
});

// ─── SCIM Webhook Tests ───

describe('SCIM Webhook — Human Deprovisioning', () => {
  it('revokes all agents when human is deprovisioned', async () => {
    // Create multiple agents for the same human
    const agent1 = await post('/api/agents', {
      name: 'scim-agent-1',
      human_sub: 'scim-user-001',
      human_email: 'departing@acme.com',
      human_iss: 'https://acme.okta.com',
      scope: ['read_file', 'write_file'],
      can_delegate: ['read_file'],
      max_delegation_depth: 2,
      ttl_seconds: 7200,
    });
    expect(agent1.status).toBe(201);
    const agent1Id = agent1.body.agent_id as string;
    const agent1Token = agent1.body.token as string;

    const agent2 = await post('/api/agents', {
      name: 'scim-agent-2',
      human_sub: 'scim-user-001',
      human_email: 'departing@acme.com',
      human_iss: 'https://acme.okta.com',
      scope: ['deploy'],
      ttl_seconds: 3600,
    });
    expect(agent2.status).toBe(201);
    const agent2Id = agent2.body.agent_id as string;

    // Delegate from agent1 to a child
    const child = await post(`/api/agents/${agent1Id}/delegate`, {
      parent_token: agent1Token,
      child_name: 'scim-child',
      requested_scope: ['read_file'],
      ttl_seconds: 1800,
    });
    expect(child.status).toBe(201);
    const childId = child.body.child_agent_id as string;

    // Fire SCIM deprovisioning webhook
    const scimRes = await post('/api/scim/webhook', {
      event_type: 'user.deprovisioned',
      user: {
        id: 'scim-user-001',
        email: 'departing@acme.com',
        issuer: 'https://acme.okta.com',
      },
      source: {
        type: 'okta',
        provider: 'acme-okta',
      },
    });

    expect(scimRes.status).toBe(200);
    expect(scimRes.body.status).toBe('processed');
    expect(scimRes.body.agents_revoked).toBe(2); // agent1 and agent2
    expect(scimRes.body.total_cascade_revoked).toBe(3); // agent1, agent2, and child

    // Verify all agents are revoked
    const agent1Status = await get(`/api/agents/${agent1Id}`);
    expect(agent1Status.body.status).toBe('revoked');

    const agent2Status = await get(`/api/agents/${agent2Id}`);
    expect(agent2Status.body.status).toBe('revoked');

    const childStatus = await get(`/api/agents/${childId}`);
    expect(childStatus.body.status).toBe('revoked');

    // Verify audit log records the deprovisioning
    const auditRes = await get('/api/audit?action=human_deprovisioned');
    const entries = auditRes.body.entries as Array<{ action: string; details: Record<string, unknown> }>;
    const deprovisionEntry = entries.find(
      (e) => e.details && (e.details as Record<string, unknown>).human_sub === 'scim-user-001',
    );
    expect(deprovisionEntry).toBeDefined();
  });

  it('handles deprovisioning for user with no agents', async () => {
    const res = await post('/api/scim/webhook', {
      event_type: 'user.deprovisioned',
      user: {
        id: 'nonexistent-user',
        email: 'nobody@acme.com',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.agents_revoked).toBe(0);
  });

  it('ignores non-deprovision events', async () => {
    const res = await post('/api/scim/webhook', {
      event_type: 'user.updated',
      user: {
        id: 'some-user',
        email: 'user@acme.com',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
  });

  it('handles user.suspended event', async () => {
    // Create an agent for a user who will be suspended
    const agent = await post('/api/agents', {
      name: 'suspend-agent',
      human_sub: 'suspend-user-001',
      human_email: 'suspended@acme.com',
      human_iss: 'https://acme.okta.com',
      scope: ['read_file'],
      ttl_seconds: 3600,
    });
    expect(agent.status).toBe(201);
    const agentId = agent.body.agent_id as string;

    const res = await post('/api/scim/webhook', {
      event_type: 'user.suspended',
      user: {
        id: 'suspend-user-001',
        email: 'suspended@acme.com',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.agents_revoked).toBe(1);

    // Agent should be revoked
    const agentStatus = await get(`/api/agents/${agentId}`);
    expect(agentStatus.body.status).toBe('revoked');
  });

  it('rejects invalid SCIM payload', async () => {
    const res = await post('/api/scim/webhook', {
      event_type: '',
      user: {},
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid SCIM');
  });
});

// ─── SCIM Health Check ───

describe('SCIM Health Check', () => {
  it('returns ok', async () => {
    const res = await get('/api/scim/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('eigent-scim-webhook');
  });
});

// ─── Session Management Tests ───

describe('Session Management', () => {
  it('creates and retrieves an active session from DB', () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    insertSession({
      id: 'test-session-1',
      human_sub: 'session-user-1',
      human_email: 'session@acme.com',
      human_iss: 'https://accounts.google.com',
      id_token_hash: 'abc123hash',
      provider_id: null,
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString(),
    });

    const session = getActiveSession('test-session-1');
    expect(session).toBeDefined();
    expect(session!.human_email).toBe('session@acme.com');
    expect(session!.human_sub).toBe('session-user-1');
  });

  it('returns undefined for expired sessions', () => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 1000); // expired 1 second ago

    insertSession({
      id: 'test-session-expired',
      human_sub: 'session-user-2',
      human_email: 'expired@acme.com',
      human_iss: 'https://accounts.google.com',
      id_token_hash: 'def456hash',
      provider_id: null,
      expires_at: expiredAt.toISOString(),
      created_at: now.toISOString(),
    });

    const session = getActiveSession('test-session-expired');
    expect(session).toBeUndefined();
  });

  it('session verify endpoint validates active sessions', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    insertSession({
      id: 'test-session-verify',
      human_sub: 'verify-user',
      human_email: 'verify@acme.com',
      human_iss: 'https://accounts.google.com',
      id_token_hash: 'ghi789hash',
      provider_id: null,
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString(),
    });

    const res = await post('/api/auth/session/verify', {
      session_token: 'test-session-verify',
    });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.human_email).toBe('verify@acme.com');
  });

  it('session verify rejects invalid session', async () => {
    const res = await post('/api/auth/session/verify', {
      session_token: 'nonexistent-session',
    });

    expect(res.status).toBe(401);
    expect(res.body.valid).toBe(false);
  });

  it('logout destroys a session', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    insertSession({
      id: 'test-session-logout',
      human_sub: 'logout-user',
      human_email: 'logout@acme.com',
      human_iss: 'https://accounts.google.com',
      id_token_hash: 'logouthash',
      provider_id: null,
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString(),
    });

    // Logout
    const logoutRes = await post('/api/auth/logout', {
      session_token: 'test-session-logout',
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.status).toBe('logged_out');

    // Verify session is gone
    const verifyRes = await post('/api/auth/session/verify', {
      session_token: 'test-session-logout',
    });
    expect(verifyRes.status).toBe(401);
    expect(verifyRes.body.valid).toBe(false);
  });
});

// ─── Auth Providers Endpoint ───

describe('Auth Providers', () => {
  it('lists configured providers (empty by default)', async () => {
    const res = await get('/api/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body.providers).toBeDefined();
    expect(Array.isArray(res.body.providers)).toBe(true);
  });
});

// ─── OIDC Login Flow (without real provider) ───

describe('OIDC Login Flow', () => {
  it('login returns error when OIDC is not configured', async () => {
    // Since env vars are not set in test, login should fail gracefully
    const res = await post('/api/auth/login', {});
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('OIDC not configured');
  });

  it('callback rejects invalid state', async () => {
    const res = await post('/api/auth/callback', {
      code: 'some-code',
      state: 'invalid-state',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid or expired');
  });
});
