/** Explicit maintenance entry; never discovers runtime/production credentials. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { inspectOfflineOrder, runOfflineOrder } from '../src/migrations/runOfflineOrder';

async function main() {
  const [mode, database, role, confirmation, ...extra] = process.argv.slice(2);
  if (!['inspect', 'install', 'complete-orm'].includes(mode) || !database || !role || extra.length
    || (mode !== 'inspect' ? confirmation !== '--confirm-install' : confirmation !== undefined))
    throw Error('Explicit mode, database, role and installation confirmation required');
  const target = process.env.OFFLINE_ORDER_MAINTENANCE_DATABASE_URL;
  if (!target) throw Error('Explicit maintenance URL required');
  const url = new URL(target);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.hostname
    || decodeURIComponent(url.pathname.slice(1)) !== database || url.search || url.hash)
    throw Error('Invalid explicit maintenance target');
  const client = postgres(target, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 5,
    ssl: ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? false : 'verify-full',
    connection: { options: '-c statement_timeout=30000 -c lock_timeout=1000 -c search_path=public,pg_temp' } });
  try {
    const db = drizzle(client), [identity] = await db.execute(sql`SELECT current_database() AS database`);
    if (identity?.database !== database) throw Error('Connected maintenance database identity mismatch');
    const result = await (mode === 'inspect' ? inspectOfflineOrder(db, role) : runOfflineOrder(db, role, mode === 'complete-orm'));
    process.stdout.write(JSON.stringify({ mode, ...result }) + '\n');
    if (result.state !== 'v1' || !result.protocolPrivilegesReady) process.exitCode = 2;
  } finally { await client.end({ timeout: 5 }); }
}
try { await main(); } catch {
  process.stderr.write('Offline maintenance failed; no automatic retry or evidence repair was attempted.\n');
  process.exitCode = 1;
}
