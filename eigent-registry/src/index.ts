import { serve } from '@hono/node-server';
import { initDb } from './db.js';
import { ensureSigningKey } from './tokens.js';
import { app } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);
const DB_PATH = process.env.DB_PATH;

async function main(): Promise<void> {
  console.log('[eigent-registry] Initializing database...');
  initDb(DB_PATH);

  console.log('[eigent-registry] Ensuring signing key exists...');
  await ensureSigningKey();

  console.log(`[eigent-registry] Starting server on port ${PORT}...`);
  serve({
    fetch: app.fetch,
    port: PORT,
  }, (info) => {
    console.log(`[eigent-registry] Server running at http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error('[eigent-registry] Fatal error:', err);
  process.exit(1);
});
