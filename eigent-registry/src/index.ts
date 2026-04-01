import { serve } from '@hono/node-server';
import { initDb } from './db.js';
import { createDatabase } from './db-factory.js';
import { ensureSigningKey } from './tokens.js';
import { isEncryptionEnabled } from './crypto.js';
import { app, startBackgroundJobs, stopBackgroundJobs } from './server.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);
const DB_PATH = process.env.DB_PATH;
const DATABASE_URL = process.env.DATABASE_URL;

const log = logger.child('startup');

async function main(): Promise<void> {
  // Initialize database: use DATABASE_URL if set, otherwise fall back to DB_PATH / SQLite
  if (DATABASE_URL) {
    log.info('Initializing database from DATABASE_URL');
  } else {
    log.info('Initializing SQLite database', { db_path: DB_PATH ?? 'default' });
    initDb(DB_PATH);
  }

  if (DATABASE_URL) {
    await createDatabase(DATABASE_URL);
  }

  // Warn about encryption status
  if (isEncryptionEnabled()) {
    log.info('Encryption at rest: ENABLED');
  } else {
    log.warn('EIGENT_MASTER_KEY not set. Private keys stored in plaintext.');
  }

  log.info('Ensuring signing key exists');
  await ensureSigningKey();

  log.info('Starting lifecycle background jobs');
  startBackgroundJobs();

  log.info('Starting server', { port: PORT });
  serve({
    fetch: app.fetch,
    port: PORT,
  }, (info) => {
    log.info('Server running', { url: `http://localhost:${info.port}` });
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    log.info('Received SIGTERM, shutting down');
    stopBackgroundJobs();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    log.info('Received SIGINT, shutting down');
    stopBackgroundJobs();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
