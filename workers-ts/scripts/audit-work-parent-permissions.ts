import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { auditWorkParentIdentityPermissions } from '../src/migrations/auditWorkParentIdentityPermissions';

// No generic DATABASE_URL, dotenv, Wrangler or Hyperdrive discovery fallback.
// A dedicated environment variable avoids accidentally auditing a maintenance
// connection when the operator intended to inspect the application's identity.
const connectionString = process.env.WORK_PARENT_AUDIT_DATABASE_URL;
let valid = false;
let remote = false;
try {
  const target = new URL(connectionString ?? '');
  remote = !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  valid = process.argv.length === 2 && ['postgres:', 'postgresql:'].includes(target.protocol)
    && Boolean(target.hostname && target.username && target.pathname.length > 1)
    && !target.search && !target.hash
    && (!remote || process.env.WORK_PARENT_AUDIT_ALLOW_REMOTE === '1');
} catch { /* Never print input, connection strings or parser exceptions. */ }

if (!valid || !connectionString) {
  process.stderr.write('Set WORK_PARENT_AUDIT_DATABASE_URL explicitly; remote targets require WORK_PARENT_AUDIT_ALLOW_REMOTE=1. Arguments and URL query/fragment options are not accepted. No database was contacted.\n');
  process.exitCode = 2;
} else {
  // postgres-js otherwise inherits PGPORT/PGPASSWORD and other PG* defaults.
  // This dedicated CLI process must use only its explicit audit target/options.
  for (const key of Object.keys(process.env)) if (/^PG/i.test(key)) delete process.env[key];
  let client: ReturnType<typeof postgres> | undefined;
  try {
    client = postgres(connectionString, {
      max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
      // Direct remote connections must verify TLS. Local tunnels retain their
      // explicitly chosen transport; URL options cannot weaken either policy.
      ssl: remote ? { rejectUnauthorized: true } : false,
      connection: { options: '-c search_path=public,pg_temp -c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000' },
    });
    const [version] = await client`SELECT current_setting('server_version_num') AS version`;
    if (Math.floor(Number(version.version) / 10000) !== 16) throw new Error('Unsupported audit server');
    const result = await auditWorkParentIdentityPermissions(drizzle(client));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    process.stderr.write('Work parent permission audit could not complete. No grants, migrations or business writes were performed.\n');
    process.exitCode = 2;
  } finally {
    try { await client?.end({ timeout: 5 }); }
    catch {
      process.stderr.write('Work parent permission audit connection cleanup could not be confirmed.\n');
      process.exitCode = 2;
    }
  }
}
