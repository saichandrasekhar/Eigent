import { serve } from '@hono/node-server';
import { initDb } from './db.js';
import { createDatabase } from './db-factory.js';
import { ensureSigningKey } from './tokens.js';
import { isEncryptionEnabled } from './crypto.js';
import { app, startBackgroundJobs, stopBackgroundJobs } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);
const DB_PATH = process.env.DB_PATH;
const DATABASE_URL = process.env.DATABASE_URL;

async function main(): Promise<void> {
  // Initialize database: use DATABASE_URL if set, otherwise fall back to DB_PATH / SQLite
  if (DATABASE_URL) {
    process.stdout.write(`[eigent-registry] Initializing database from DATABASE_URL...\n`);
    await createDatabase(DATABASE_URL);
  } else {
    process.stdout.write('[eigent-registry] Initializing SQLite database...\n');
    initDb(DB_PATH);
  }

  // Warn about encryption status
  if (isEncryptionEnabled()) {
    process.stdout.write('[eigent-registry] Encryption at rest: ENABLED\n');
  } else {
    process.stderr.write(
      '[eigent-registry] WARNING: EIGENT_MASTER_KEY not set. Private keys stored in plaintext.\n',
    );
  }

  process.stdout.write('[eigent-registry] Ensuring signing key exists...\n');
  await ensureSigningKey();

  process.stdout.write('[eigent-registry] Starting lifecycle background jobs...\n');
  startBackgroundJobs();

  process.stdout.write(`[eigent-registry] Starting server on port ${PORT}...\n`);
  serve({
    fetch: app.fetch,
    port: PORT,
  }, (info) => {
    process.stdout.write(`[eigent-registry] Server running at http://localhost:${info.port}\n`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    process.stdout.write('[eigent-registry] Shutting down...\n');
    stopBackgroundJobs();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    process.stdout.write('[eigent-registry] Shutting down...\n');
    stopBackgroundJobs();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[eigent-registry] Fatal error:', err);
  process.exit(1);
});
