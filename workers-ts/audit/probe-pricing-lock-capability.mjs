// Isolated feasibility evidence only: NOT a migration or production installer.
// Requires an explicit loopback control URL; creates/drops only random owned
// database and roles. No DATABASE_URL fallback, environment discovery or values.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

const url = new URL(process.env.PRICING_LOCK_PROBE_URL || 'invalid:');
if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/cinashop_finance_test') {
  throw new Error('Dedicated loopback test target required');
}
const suffix = randomBytes(10).toString('hex');
const database = `pricing_cap_${suffix}`;
const owner = `pcap_owner_${suffix}`;
const reader = `pcap_reader_${suffix}`;
const outsider = `pcap_outside_${suffix}`;
const password = randomBytes(24).toString('hex');
const ident = value => { assert.match(value, /^[a-z_][a-z_0-9]*$/); return `"${value}"`; };
const options = { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 5,
  connection: { application_name: 'pricing_capability_probe', statement_timeout: '8000', lock_timeout: '1500', idle_in_transaction_session_timeout: '10000' },
  onnotice() {} };
const control = postgres(url.toString(), options);
const clients = [];
const rolesCreated = [];
let databaseCreated = false;
const checks = [];
let failure;
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
const denied = async (client, statement, state = '42501') => {
  let code;
  try { await client.unsafe(statement); } catch (error) { code = error.code; }
  assert.equal(code, state, 'Expected SQLSTATE');
};
const connect = role => {
  const target = new URL(url); target.pathname = `/${database}`;
  if (role) { target.username = role; target.password = password; }
  const client = postgres(target.toString(), options); clients.push(client); return client;
};
try {
  await control.unsafe(`CREATE DATABASE ${ident(database)}`); databaseCreated = true;
  for (const role of [owner, reader, outsider]) {
    await control.unsafe(`CREATE ROLE ${ident(role)} ${role === owner ? 'NOLOGIN' : `LOGIN PASSWORD '${password}'`} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    rolesCreated.push(role);
  }
  const admin = connect(); const runtime = connect(reader); const other = connect(outsider); const writer = connect();
  await admin.begin(async tx => {
    await tx.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await tx.unsafe('CREATE SCHEMA cap');
    await tx.unsafe('CREATE TABLE cap.system_config (id integer PRIMARY KEY, value text NOT NULL)');
    await tx.unsafe('CREATE TABLE cap.member_right (id integer PRIMARY KEY, value text NOT NULL)');
    await tx.unsafe("INSERT INTO cap.system_config VALUES (1, 'original')");
    await tx.unsafe("INSERT INTO cap.member_right VALUES (1, 'original')");
    await tx.unsafe(`GRANT USAGE ON SCHEMA cap TO ${ident(owner)}, ${ident(reader)}, ${ident(outsider)}`);
    // Owner is neither table/schema owner nor a login; only its fixed function
    // may borrow these privileges. Runtime has no membership in this role.
    await tx.unsafe(`GRANT SELECT, UPDATE ON cap.system_config, cap.member_right TO ${ident(owner)}`);
    await tx.unsafe(`GRANT SELECT ON cap.system_config, cap.member_right TO ${ident(reader)}`);
    await tx.unsafe(`CREATE FUNCTION cap.lock_pricing() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp AS $body$
      BEGIN
        IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
          RAISE EXCEPTION 'READ COMMITTED required' USING ERRCODE = '25001';
        END IF;
        LOCK TABLE cap.member_right, cap.system_config IN SHARE MODE NOWAIT;
      END $body$`);
    await tx.unsafe('REVOKE ALL ON FUNCTION cap.lock_pricing() FROM PUBLIC');
    await tx.unsafe(`ALTER FUNCTION cap.lock_pricing() OWNER TO ${ident(owner)}`);
    await tx.unsafe(`GRANT EXECUTE ON FUNCTION cap.lock_pricing() TO ${ident(reader)}`);
  });
  const [identity] = await runtime`SELECT current_user = session_user AND current_user = a.usename AS real_login,
    r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls AS elevated
    FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.rolname = current_user
    WHERE a.pid = pg_catalog.pg_backend_pid()`;
  check('independent_nonprivileged_login', identity.real_login && !identity.elevated);
  await runtime.unsafe('BEGIN');
  await denied(runtime, 'LOCK TABLE cap.member_right, cap.system_config IN SHARE MODE NOWAIT');
  await runtime.unsafe('ROLLBACK');
  checks.push('direct_table_fence_denied');
  for (const table of ['system_config', 'member_right']) {
    for (const statement of [
      `UPDATE cap.${table} SET value = 'changed'`, `DELETE FROM cap.${table}`,
      `INSERT INTO cap.${table} VALUES (2, 'changed')`, `TRUNCATE cap.${table}`,
      `ALTER TABLE cap.${table} ADD COLUMN unauthorized integer`,
    ]) await denied(runtime, statement);
  }
  checks.push('both_tables_direct_dml_and_ddl_denied');
  await denied(runtime, `SET ROLE ${ident(owner)}`);
  await denied(other, 'SELECT cap.lock_pricing()');
  await denied(runtime, 'ALTER FUNCTION cap.lock_pricing() SECURITY INVOKER');
  checks.push('owner_assumption_ungranted_execute_and_function_edit_denied');
  for (const terminal of ['COMMIT', 'ROLLBACK']) {
    await runtime.unsafe('BEGIN');
    try {
      await runtime.unsafe('CREATE TEMP TABLE system_config (id integer)');
      await runtime.unsafe('CREATE TEMP TABLE member_right (id integer)');
      await runtime.unsafe('SET LOCAL search_path = pg_temp, public');
      await runtime.unsafe('SELECT cap.lock_pricing()');
      const [state] = await runtime`SELECT current_user = session_user AS restored`;
      check(`${terminal.toLowerCase()}_identity_restored_after_function`, state.restored);
      const locks = await runtime`SELECT c.relname FROM pg_catalog.pg_locks l
        JOIN pg_catalog.pg_class c ON c.oid=l.relation JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE l.pid=pg_catalog.pg_backend_pid() AND n.nspname='cap' AND l.mode='ShareLock' AND l.granted ORDER BY c.relname`;
      assert.deepEqual(locks.map(row => row.relname), ['member_right', 'system_config']);
      for (const table of ['system_config', 'member_right']) {
        await writer.unsafe('BEGIN');
        await writer.unsafe("SET LOCAL lock_timeout = '100ms'");
        await denied(writer, `UPDATE cap.${table} SET value = 'blocked' WHERE id = 1`, '55P03');
        await writer.unsafe('ROLLBACK');
      }
      checks.push(`${terminal.toLowerCase()}_fixed_real_relations_block_both_writers`);
    } finally { await runtime.unsafe(terminal); }
    for (const table of ['system_config', 'member_right']) await writer.unsafe(`UPDATE cap.${table} SET value = 'original' WHERE id = 1`);
    // COMMIT retains temp tables; rollback may remove them. Do not depend on search path.
    await runtime.unsafe('DROP TABLE IF EXISTS pg_temp.system_config, pg_temp.member_right');
    checks.push(`${terminal.toLowerCase()}_releases_fence`);
  }
  await writer.unsafe('BEGIN');
  try {
    await writer.unsafe("UPDATE cap.system_config SET value = 'uncommitted' WHERE id = 1");
    await denied(runtime, 'SELECT cap.lock_pricing()', '55P03');
    checks.push('competing_writer_nowait_fails_closed');
  } finally { await writer.unsafe('ROLLBACK'); }
  await runtime.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await denied(runtime, 'SELECT cap.lock_pricing()', '25001');
  await runtime.unsafe('ROLLBACK');
  checks.push('higher_isolation_rejected');
  const values = await admin`SELECT value FROM cap.system_config UNION ALL SELECT value FROM cap.member_right`;
  check('synthetic_configuration_values_preserved', values.length === 2 && values.every(row => row.value === 'original'));
} catch (error) { failure = { name: error.name, code: error.code ?? null }; }
finally {
  await Promise.all(clients.map(client => client.end({ timeout: 2 })));
  if (databaseCreated) await control.unsafe(`DROP DATABASE ${ident(database)}`);
  for (const role of [...rolesCreated].reverse()) await control.unsafe(`DROP ROLE ${ident(role)}`);
  const [residue] = await control`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${database}) AS db,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN (${owner}, ${reader}, ${outsider})) AS roles`;
  check('owned_database_and_roles_removed', !residue.db && !residue.roles);
  await control.end({ timeout: 2 });
}
console.log(JSON.stringify({ status: failure ? 'failed' : 'feasibility-only-passed', failure, checks,
  limitations: ['Minimal isolated tables, not full ORM or application HTTP', 'Not installed in application or production',
    'Existing runtime audit rejects all executable non-system SECURITY DEFINER functions; audited protocol integration still required',
    'Table-wide contention, maintenance trust and production Hyperdrive role remain unaccepted'] }));
if (failure) process.exitCode = 1;
