/** Explicit maintenance target and confirmation only. No runtime URL fallback,
 * automatic retries, role creation, object repair, or historical backfill. */
import { URL } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { inspectPurchaseOriginEvidence, runPurchaseOriginEvidence } from '../src/migrations/runPurchaseOriginEvidence';

let client: ReturnType<typeof postgres> | undefined;
try {
  const [mode,database,role,confirmation,...extra] = process.argv.slice(2);
  if (!['inspect','install'].includes(mode) || !database || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role ?? '')
    || extra.length || (mode === 'install' ? confirmation !== '--confirm-install' : confirmation !== undefined)) throw Error('Invalid explicit command');
  const target = process.env.PURCHASE_ORIGIN_MAINTENANCE_DATABASE_URL;
  if (!target) throw Error('Explicit maintenance URL required');
  const url = new URL(target);
  if (!['postgres:','postgresql:'].includes(url.protocol) || !url.username || !url.hostname || url.search || url.hash
    || decodeURIComponent(url.pathname.slice(1)) !== database) throw Error('Unexpected target');
  client = postgres(target, { max:1, prepare:false, connect_timeout:5, idle_timeout:5,
    ssl:['127.0.0.1','localhost','[::1]'].includes(url.hostname) ? false : 'verify-full',
    connection:{ options:'-c statement_timeout=30000 -c lock_timeout=1000 -c search_path=pg_catalog,public,pg_temp' } });
  const db = drizzle(client), [identity] = await db.execute(sql`SELECT current_database() AS database`);
  if (identity?.database !== database) throw Error('Connected target mismatch');
  const result = await (mode === 'inspect' ? inspectPurchaseOriginEvidence(db,role) : runPurchaseOriginEvidence(db,role));
  process.stdout.write(JSON.stringify({ mode,...result }) + '\n');
  if (result.state !== 'v1' || !('runtimeReady' in result) || !result.runtimeReady) process.exitCode = 2;
} catch {
  process.stderr.write('Purchase origin maintenance failed; explicit target and confirmation required, no fallback, retry or repair attempted.\n');
  process.exitCode = 1;
} finally { await client?.end({ timeout:5 }); }
