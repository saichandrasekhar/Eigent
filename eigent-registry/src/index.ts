import { serve } from '@hono/node-server';
import { initDb } from './db.js';
import { ensureSigningKey } from './tokens.js';
import { app, startBackgroundJobs, stopBackgroundJobs } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);
const DB_PATH = process.env.DB_PATH;

async function main(): Promise<void> {
  process.stdout.write('[eigent-registry] Initializing database...\n');
  initDb(DB_PATH);

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
