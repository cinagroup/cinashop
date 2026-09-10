import { URL } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { auditPaidOrderRuntimePermissions } from '../src/migrations/auditPaidOrderRuntimePermissions';

// Deliberately no DATABASE_URL, .env or Hyperdrive discovery fallback. The
// operator must explicitly identify the runtime connection being audited.
const connectionString = process.env.PAID_RUNTIME_AUDIT_DATABASE_URL;
let valid = false;
try {
  const target = new URL(connectionString ?? '');
  valid = ['postgres:', 'postgresql:'].includes(target.protocol)
    && Boolean(target.hostname && target.username && target.pathname.length > 1)
    && (['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || process.env.PAID_RUNTIME_AUDIT_ALLOW_REMOTE === '1');
} catch { /* Do not print the URL, credentials or parse error. */ }

if (!valid || !connectionString) {
  process.stderr.write('Set PAID_RUNTIME_AUDIT_DATABASE_URL explicitly; remote targets also require PAID_RUNTIME_AUDIT_ALLOW_REMOTE=1. No database was contacted.\n');
  process.exitCode = 2;
} else {
  const client = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0,
    connection: { options: '-c search_path=public,pg_temp -c statement_timeout=5000 -c lock_timeout=1000' } });
  try {
    const result = await auditPaidOrderRuntimePermissions(drizzle(client));
    // Only fixed check names and booleans: no identities, URLs, SQL or secrets.
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    process.stderr.write('Runtime permission audit could not complete. No grants, migrations or business writes were performed.\n');
    process.exitCode = 2;
  } finally { await client.end({ timeout: 5 }); }
}
