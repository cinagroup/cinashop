import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { auditRoutinePaymentRuntime, runRoutinePaymentRuntimeInstallation,
  type RoutinePaymentRuntimeTarget } from '../../src/migrations/routinePaymentRuntime';
import { ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';
import { ownsSequenceRunnerEndpoint } from './kefuSequenceRunnerDatabase';

const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw Error('Unsafe owned routine fixture identity');
  return '"' + value + '"';
};

/** Fresh owned PG16 database only. Companion roles are genuine independent
 * LOGINs, never aliases for the local financial principal. Only the production
 * installer creates/grants the raw ledgers. This proves the storage addon,
 * not a complete Customer/Supplier base profile or deployment commissioning.
 * Keep this binding for the lifetime of the database; immutable storage is
 * never reset or silently expanded for later, dynamically created roles. */
export async function routinePaymentRuntimeFixture(ownerDb: DbClient, localRole: string) {
  identifier(localRole);
  if (!Object.hasOwn(ownerDb, '$client')) throw Error('Owned maintenance root connection required');
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const [origin] = await ownerDb.execute<{ database: string; schema: string; role: string; session: string;
    host: string; port: number; major: number; superuser: boolean }>(sql`SELECT current_database() AS database,
    current_schema() AS schema,current_user AS role,session_user AS session,host(inet_server_addr()) AS host,
    inet_server_port() AS port,current_setting('server_version_num')::integer/10000 AS major,
    (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser`);
  if (!origin || origin.schema !== 'public' || origin.role !== 'finance_test' || origin.session !== origin.role
    || origin.major !== 16 || origin.superuser !== true
    || !(ownsFinanceFixtureEndpoint(origin.database, 'public', base.href, origin.host, origin.port)
      || ownsSequenceRunnerEndpoint(origin.database, 'public', base.href, origin.host, origin.port))) {
    throw Error('Routine runtime fixture target is not this process owned PG16 database');
  }
  identifier(origin.database);
  const [fresh] = await ownerDb.execute<{ ready: boolean; direct: boolean }>(sql`SELECT
    to_regclass('public.routine_identity_witness') IS NULL AND to_regclass('public.routine_payment_attempt') IS NULL AS ready,
    has_table_privilege(${localRole},'public.payment_reconciliation_case','SELECT')
      AND has_table_privilege(${localRole},'public.payment_reconciliation_case','UPDATE') AS direct`);
  if (fresh?.ready !== true || fresh.direct !== true) throw Error('Fresh storage and approved existing local case writer required');
  const companions: { role: string; oid: string; client?: ReturnType<typeof postgres>; db?: DbClient }[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    const failures: unknown[] = [];
    for (const result of await Promise.allSettled(companions.map(peer => peer.client?.end({ timeout: 5 }))))
      if (result.status === 'rejected') failures.push(result.reason);
    for (const peer of [...companions].reverse()) {
      try {
        const [current] = await ownerDb.execute<{ oid: string; database: string; role: string }>(sql`
          SELECT oid::text AS oid,current_database() AS database,current_user AS role
          FROM pg_catalog.pg_roles WHERE rolname=${peer.role}`);
        if (current?.oid !== peer.oid || current.database !== origin.database || current.role !== origin.role)
          throw Error('Owned companion role cleanup identity changed');
        await ownerDb.execute(sql.raw(`DROP OWNED BY ${identifier(peer.role)}; DROP ROLE ${identifier(peer.role)}`));
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned routine companion cleanup was not fully confirmed');
  };
  try {
    for (const kind of ['app', 'admin']) {
      const role = `routine_${kind}_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
      await ownerDb.execute(sql.raw(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}' CONNECTION LIMIT 1`));
      const [created] = await ownerDb.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${role}`);
      if (!created) throw Error('Companion creation was not observed');
      const peer: typeof companions[number] = { role, oid: created.oid }; companions.push(peer);
      await ownerDb.execute(sql.raw(`GRANT CONNECT ON DATABASE ${identifier(origin.database)} TO ${identifier(role)};
        GRANT USAGE ON SCHEMA public TO ${identifier(role)}`));
      const endpoint = new URL(base.href); endpoint.pathname = '/' + origin.database;
      endpoint.username = role; endpoint.password = password;
      peer.client = postgres(endpoint.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
        connection: { options: '-c search_path=public,pg_temp -c statement_timeout=5000 -c lock_timeout=1000' } });
      peer.db = drizzle(peer.client) as unknown as DbClient;
    }
    const target: RoutinePaymentRuntimeTarget = Object.freeze({ database: origin.database, maintenance: origin.role,
      app: companions[0].role, admin: companions[1].role, local: Object.freeze([localRole]) });
    const installation = await runRoutinePaymentRuntimeInstallation(ownerDb, target);
    if (!installation.applied || !installation.after.ready) throw Error('Fresh production addon installation was not confirmed');
    for (const [index, kind] of ['app', 'admin'].entries()) {
      const result = await auditRoutinePaymentRuntime(companions[index].db!, kind as 'app' | 'admin', target);
      if (!result.ready || !result.realLogin) throw Error('Actual companion LOGIN addon audit failed');
    }
    return { target, installation, fullCustomProfileVerified: false as const,
      // Independent root pool, not SET ROLE or the owner's SQL connection.
      auditLocal: (db: DbClient) => auditRoutinePaymentRuntime(db, 'local', target, localRole),
      replayInstallation: () => runRoutinePaymentRuntimeInstallation(ownerDb, target), close };
  } catch (error) { await close(); throw error; }
}
