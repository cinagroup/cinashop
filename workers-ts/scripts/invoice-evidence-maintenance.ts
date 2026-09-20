/** Explicit offline maintenance command. No default URL, .env loading, retries,
 * runtime credentials, provider calls, invoice payload output or auto-run hook. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { inspectInvoiceEvidence, runInvoiceEvidence } from '../src/migrations/runInvoiceEvidence';

const [mode,database,role,confirmation,...extra] = process.argv.slice(2);
if (!['inspect','install','complete-orm'].includes(mode) || !database || !role || extra.length
  || (mode!=='inspect' ? confirmation!=='--confirm-install' : confirmation!==undefined)) {
  throw Error('Usage: tsx scripts/invoice-evidence-maintenance.ts inspect|install|complete-orm <expected-database> <runtime-role> [--confirm-install]');
}
const target = process.env.INVOICE_MAINTENANCE_DATABASE_URL;
if (!target) throw Error('Explicit INVOICE_MAINTENANCE_DATABASE_URL is required; no runtime URL fallback');
let url: URL;
try { url = new URL(target); } catch { throw Error('Invalid maintenance database URL'); }
if (!['postgres:','postgresql:'].includes(url.protocol) || !url.username || !url.hostname
  || decodeURIComponent(url.pathname.slice(1))!==database)
  throw Error('Maintenance database identity does not match explicit target');
// postgres.js verifies TLS for non-loopback targets. Do not inherit URL options
// that can override transport, search_path or other reviewed session settings.
if (url.search || url.hash) throw Error('Maintenance URL must not contain query options or fragments');
const client = postgres(target,{max:1,prepare:false,connect_timeout:5,idle_timeout:5,
  ssl:['127.0.0.1','localhost','[::1]'].includes(url.hostname) ? false : 'verify-full',
  connection:{options:'-c statement_timeout=30000 -c lock_timeout=1000 -c search_path=public,pg_temp'}});
try {
  const db = drizzle(client);
  const [identity] = await db.execute(sql`SELECT current_database() AS database`);
  if (identity?.database!==database) throw Error('Connected maintenance database identity mismatch');
  const result = await (mode==='inspect' ? inspectInvoiceEvidence(db,role) : runInvoiceEvidence(db,role,mode==='complete-orm'));
  process.stdout.write(JSON.stringify({mode,...result})+'\n');
  if (result.state!=='v2' || !result.runtimeReady || result.preInstallHistoryUnknown) process.exitCode=2;
} catch {
  // Database errors can contain SQL and row values. Intentionally do not emit
  // raw errors; the inspect result and maintenance audit are the review path.
  process.stderr.write('Invoice maintenance failed; no automatic retry or privilege repair was attempted.\n');
  process.exitCode=1;
} finally { await client.end({timeout:5}); }
