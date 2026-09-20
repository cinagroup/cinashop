/** Explicit runtime connection only. Never loads .env or uses maintenance URLs. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { auditOfflineOrderRuntimePermissions } from '../src/migrations/auditOfflineOrderRuntimePermissions';

async function main() {
  const [database, role, ...extra] = process.argv.slice(2);
  const raw = process.env.OFFLINE_RUNTIME_AUDIT_DATABASE_URL;
  if (!raw || !database || !role || extra.length || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role) || role.trim() !== role)
    throw Error('Explicit runtime target required');
  const target = new URL(raw), local = ['127.0.0.1','localhost','[::1]'].includes(target.hostname);
  if (!['postgres:','postgresql:'].includes(target.protocol) || !target.hostname || target.search || target.hash
    || decodeURIComponent(target.pathname.slice(1)) !== database || decodeURIComponent(target.username) !== role
    || (!local && process.env.OFFLINE_RUNTIME_AUDIT_ALLOW_REMOTE !== '1')) throw Error('Invalid explicit runtime target');
  const client = postgres(raw, { max:1,prepare:false,connect_timeout:5,idle_timeout:0,
    ssl:local ? false : 'verify-full', connection:{ options:'-c search_path=public,pg_temp -c statement_timeout=5000 -c lock_timeout=1000' } });
  try {
    const db = drizzle(client), [identity] = await db.execute(sql`SELECT current_database()=${database}
      AND current_user=${role} AND session_user=${role} AS matched`);
    if (identity?.matched !== true) throw Error('Runtime identity mismatch');
    const report = await auditOfflineOrderRuntimePermissions(db);
    process.stdout.write(JSON.stringify(report)+'\n'); process.exitCode = report.ready ? 0 : 1;
  } finally { await client.end({timeout:5}); }
}
try { await main(); } catch {
  process.stderr.write('Offline runtime audit could not complete. No grants, migrations or business writes were performed.\n');
  process.exitCode=2;
}
