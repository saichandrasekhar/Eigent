import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/server.js';
import { initDb, closeDb, getLatestKey, getDb } from '../src/db.js';
import { ensureSigningKey, rotateEncryptionKey, hasSigningKey } from '../src/tokens.js';
import { encrypt, decrypt, encryptIfEnabled, decryptIfEnabled, isEncryptionEnabled } from '../src/crypto.js';
import { generateOpenAPISpec } from '../src/openapi.js';

// Hono test helper
async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: () => Promise<unknown>; headers: Headers }> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  const res = await app.request(path, init);
  return { status: res.status, json: () => res.json(), headers: res.headers };
}

async function post(path: string, body: unknown) {
  const res = await request('POST', path, body);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

async function get(path: string) {
  const res = await request('GET', path);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

const HUMAN = {
  human_sub: 'user-phase2',
  human_email: 'bob@example.com',
  human_iss: 'https://accounts.google.com',
};

beforeAll(async () => {
  initDb(':memory:');
  await ensureSigningKey();
});

afterAll(() => {
  closeDb();
});

// ─── 1. Encryption at rest ───

describe('Encryption (crypto.ts)', () => {
  const masterKey = 'test-master-key-for-aes-256-gcm';

  it('encrypts and decrypts a string correctly', () => {
    const plaintext = '{"kty":"EC","crv":"P-256","x":"abc","y":"def","d":"secret"}';
    const encrypted = encrypt(plaintext, masterKey);

    // Format should be iv:ciphertext:tag
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);

    const decrypted = decrypt(encrypted, masterKey);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'same-plaintext';
    const enc1 = encrypt(plaintext, masterKey);
    const enc2 = encrypt(plaintext, masterKey);
    expect(enc1).not.toBe(enc2);
  });

  it('fails to decrypt with wrong key', () => {
    const encrypted = encrypt('secret-data', masterKey);
    expect(() => decrypt(encrypted, 'wrong-key-here-1234567890abcd')).toThrow();
  });

  it('fails to decrypt invalid format', () => {
    expect(() => decrypt('not-valid-encrypted-data', masterKey)).toThrow(
      'Invalid encrypted format',
    );
  });

  it('encryptIfEnabled returns plaintext when no master key (dev mode)', () => {
    // No EIGENT_MASTER_KEY set in test env
    const result = encryptIfEnabled('my-private-key');
    // Without master key, should return plaintext
    expect(result).toBe('my-private-key');
  });

  it('decryptIfEnabled returns plaintext when no master key', () => {
    const result = decryptIfEnabled('my-private-key');
    expect(result).toBe('my-private-key');
  });

  it('isEncryptionEnabled returns false without env var', () => {
    expect(isEncryptionEnabled()).toBe(false);
  });
});

describe('Encryption key rotation', () => {
  it('rotateEncryptionKey re-encrypts keys', () => {
    const oldKey = 'old-master-key-for-rotation-test';
    const newKey = 'new-master-key-for-rotation-test';

    // First, manually encrypt a private key with the old key
    const keyRow = getLatestKey();
    expect(keyRow).toBeDefined();

    // Store an encrypted private key
    const originalPrivateKey = keyRow!.private_key;
    const encryptedWithOld = encrypt(originalPrivateKey, oldKey);
    getDb()
      .prepare('UPDATE keys SET private_key = ? WHERE id = ?')
      .run(encryptedWithOld, keyRow!.id);

    // Rotate
    const count = rotateEncryptionKey(oldKey, newKey);
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify the key is now encrypted with the new key
    const updatedRow = getLatestKey();
    expect(updatedRow).toBeDefined();
    const decrypted = decrypt(updatedRow!.private_key, newKey);
    expect(decrypted).toBe(originalPrivateKey);

    // Restore original for other tests
    getDb()
      .prepare('UPDATE keys SET private_key = ? WHERE id = ?')
      .run(originalPrivateKey, keyRow!.id);
  });
});

// ─── 2. Health checks ───

describe('Health checks', () => {
  it('GET /healthz returns ok with uptime', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('1.0.0');
    expect(typeof res.body.uptime_seconds).toBe('number');
    expect((res.body.uptime_seconds as number)).toBeGreaterThanOrEqual(0);
  });

  it('GET /readyz returns ready when DB and key are available', async () => {
    const res = await get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect((res.body.checks as Record<string, string>).database).toBe('ok');
    expect((res.body.checks as Record<string, string>).signing_key).toBe('ok');
  });

  it('hasSigningKey returns true when key exists', () => {
    expect(hasSigningKey()).toBe(true);
  });
});

// ─── 3. API versioning ───

describe('API versioning', () => {
  it('adds X-API-Version header on all responses', async () => {
    const res = await get('/healthz');
    expect(res.headers.get('X-API-Version')).toBe('1');
  });

  it('serves routes under /api/v1/ prefix', async () => {
    // Create an agent through /api/v1/agents
    const res = await post('/api/v1/agents', {
      name: 'v1-test-agent',
      ...HUMAN,
      scope: ['read'],
      ttl_seconds: 3600,
    });
    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBeDefined();
  });

  it('GET /api/v1/openapi.json returns OpenAPI spec', async () => {
    const res = await get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect((res.body.info as Record<string, unknown>).title).toBe('Eigent Registry API');
    expect(res.body.paths).toBeDefined();
    expect(res.body.components).toBeDefined();
  });

  it('GET /api/openapi.json also returns the spec', async () => {
    const res = await get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
  });

  it('/api/ routes still work (backward compatibility)', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ─── 4. OpenAPI spec ───

describe('OpenAPI spec generation', () => {
  it('generates valid OpenAPI 3.1 spec', () => {
    const spec = generateOpenAPISpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info).toBeDefined();
    expect(spec.paths).toBeDefined();
    expect(spec.components).toBeDefined();
  });

  it('includes all major endpoints', () => {
    const spec = generateOpenAPISpec();
    const paths = spec.paths as Record<string, unknown>;

    expect(paths['/agents']).toBeDefined();
    expect(paths['/agents/{id}']).toBeDefined();
    expect(paths['/agents/{id}/delegate']).toBeDefined();
    expect(paths['/verify']).toBeDefined();
    expect(paths['/audit']).toBeDefined();
    expect(paths['/auth/login']).toBeDefined();
    expect(paths['/.well-known/jwks.json']).toBeDefined();
    expect(paths['/openapi.json']).toBeDefined();
  });

  it('includes request/response schemas', () => {
    const spec = generateOpenAPISpec();
    const components = spec.components as Record<string, Record<string, unknown>>;
    const schemas = components.schemas;

    expect(schemas.RegisterAgentRequest).toBeDefined();
    expect(schemas.RegisterAgentResponse).toBeDefined();
    expect(schemas.DelegateRequest).toBeDefined();
    expect(schemas.VerifyRequest).toBeDefined();
    expect(schemas.Agent).toBeDefined();
    expect(schemas.HealthResponse).toBeDefined();
    expect(schemas.ReadyResponse).toBeDefined();
    expect(schemas.ErrorResponse).toBeDefined();
  });
});

// ─── 5. Database factory ───

describe('Database factory', () => {
  it('createDatabase with sqlite: scheme works', async () => {
    const { createDatabase } = await import('../src/db-factory.js');
    // The DB is already initialized in beforeAll, so this should succeed
    const adapter = await createDatabase('sqlite::memory:');
    expect(adapter).toBeDefined();
    expect(await adapter.ping()).toBe(true);
  });

  it('createDatabase rejects unsupported scheme', async () => {
    const { createDatabase } = await import('../src/db-factory.js');
    await expect(createDatabase('redis://localhost')).rejects.toThrow(
      'Unsupported database URL scheme',
    );
  });
});
