import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { MigrationService } from '../../src/services/MigrationService';
import { PRICING_OWNER_SETTING } from '../../src/migrations/checkoutPricingLockCatalog';
import { memberRight } from '../../src/models/schema';
import { financePostgres, ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';
import { seckillTimeReferenceLockFixture } from './seckillTimeReferenceLockFixture';

/** Explicit canonical factory inside financePostgres's existing owned endpoint
 * registry. Session-scoped migration settings and all migrations use the same
 * dedicated max:1 maintenance connection; the registry's original pool supplies
 * no migrations, business execution or paid-consumer substitution. */
export async function customerFinancialCanonicalFixtureDatabase(_tables: PgTable[] = []) {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL);
  const owned = await financePostgres([], { namespace: 'public' });
  const pricingOwner = 'original_pricing_' + randomUUID().replaceAll('-', '');
  let pricingOid: string | undefined, client: ReturnType<typeof postgres> | undefined, closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try {
      if (client && pricingOid) {
        const rows = await client<{ oid: string }[]>`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${pricingOwner}`;
        if (rows.length !== 1 || rows[0].oid !== pricingOid) throw Error('Owned canonical pricing OID changed');
        await client`SELECT set_config(${PRICING_OWNER_SETTING},'',false)`;
        await client.unsafe(`DROP OWNED BY "${pricingOwner}"; DROP ROLE "${pricingOwner}"`);
        if ((await client`SELECT oid FROM pg_roles WHERE rolname=${pricingOwner}`).length) throw Error('Canonical pricing cleanup unconfirmed');
      }
    } finally { try { await client?.end({ timeout: 5 }); } finally { await owned.close(); } }
  };
  try {
    const [origin] = await owned.db.execute<{ database: string; role: string; session: string; host: string; port: number }>(sql`
      SELECT current_database() AS database,current_user AS role,session_user AS session,
        host(inet_server_addr()) AS host,inet_server_port() AS port`);
    if (!origin || origin.role !== 'finance_test' || origin.session !== origin.role
      || !ownsFinanceFixtureEndpoint(origin.database, 'public', base.href, origin.host, origin.port))
      throw Error('Canonical finance target is not registered');
    const target = new URL(base.href); target.pathname = '/' + origin.database;
    client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5,
      connection: { options: '-c search_path=public,pg_temp -c statement_timeout=180000 -c lock_timeout=1000' } });
    const db = drizzle(client) as unknown as DbClient;
    const [session] = await db.execute<{ pid: number; ready: boolean }>(sql`SELECT pg_backend_pid() AS pid,
      current_database()=${origin.database} AND current_user='finance_test' AND current_user=session_user
      AND current_setting('server_version_num')::integer/10000=16
      AND host(inet_server_addr())=${origin.host} AND inet_server_port()=${origin.port} AS ready`);
    if (session?.ready !== true) throw Error('Canonical dedicated maintenance identity differs');
    await client.unsafe(`CREATE ROLE "${pricingOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    const [role] = await client<{ oid: string }[]>`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${pricingOwner}`;
    if (!role?.oid) throw Error('Canonical pricing creation not observed');
    pricingOid = role.oid;
    await db.execute(sql`SELECT set_config(${PRICING_OWNER_SETTING},${pricingOwner},false)`);
    const f = await seckillTimeReferenceLockFixture({ db, exec: (statement: string) => client!.unsafe(statement),
      close, format: 'pg16' as const }, false);
    try {
      const migration = await new MigrationService(createContainerFromDb(db)).runAll();
      if (migration.errors.length || JSON.stringify(migration.executed)
        !== JSON.stringify(Array.from({ length: 185 }, (_, i) => String(i).padStart(4, '0'))))
        throw Error('Complete canonical migration sequence refused');
      const [after] = await db.execute<{ pid: number; count: number; pricing: string }>(sql`SELECT pg_backend_pid() AS pid,
        (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r') AS count,
        current_setting(${PRICING_OWNER_SETTING}) AS pricing`);
      if (after.pid !== session.pid || after.count !== 283 || after.pricing !== pricingOwner)
        throw Error('Canonical session/base catalog changed during migration');
      const integral = await db.select().from(memberRight).where(and(eq(memberRight.id, 1), eq(memberRight.rightType, 'integral')));
      if (integral.length !== 1) throw Error('Canonical integral seed is absent');
      const moved = await db.update(memberRight).set({ id: 3 }).where(and(eq(memberRight.id, 1), eq(memberRight.rightType, 'integral'))).returning();
      if (moved.length !== 1 || JSON.stringify(moved[0]) !== JSON.stringify({ ...integral[0], id: 3 }))
        throw Error('Canonical integral seed content changed while relocating quote ids');
      return { ...f, database: origin.database, pricingOwner, canonicalOrm: true as const, connectionString: target.href };
    } catch (error) { await f.close(); throw error; }
  } catch (error) { await close(); throw error; }
}
