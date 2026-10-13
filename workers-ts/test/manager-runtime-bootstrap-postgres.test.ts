import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { inspectManagerRuntimeBootstrap, installManagerRuntimeBootstrap, MANAGER_BOOTSTRAP_SCOPE_OWNER, type ManagerBootstrapTarget } from '../src/migrations/managerRuntimeBootstrap';
import { runManagerOrderOperation } from '../src/migrations/runManagerOrderOperation';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { MigrationService } from '../src/services/MigrationService';
import { validateFinanceFixtureUrl } from './helpers/financePostgres';

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).sequential('fixed Manager core additive bootstrap on owned native PG16', () => {
  let f: Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>, target: ManagerBootstrapTarget, ownerOid: string | null;
  const owner = sql.raw('"' + MANAGER_BOOTSTRAP_SCOPE_OWNER + '"');
  const markOwned = async () => {
    const rows = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${MANAGER_BOOTSTRAP_SCOPE_OWNER}`);
    if (rows.length !== 1 || ownerOid && ownerOid !== rows[0].oid) throw Error('Owned bootstrap role identity changed'); ownerOid = rows[0].oid;
  };
  beforeEach(async () => {
    validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? ''); ownerOid = null;
    f = await checkoutPricingMigrationDatabase();
    expect(await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${MANAGER_BOOTSTRAP_SCOPE_OWNER}`)).toHaveLength(0);
    const [identity] = await f.db.execute(sql`SELECT current_database() AS database,current_user AS role`);
    target = { database: String(identity.database), maintenanceRole: String(identity.role) };
    // Full canonical fixture only, independent from optional Manager capability
    // setup. The production installer never runs runAll or repairs a catalog.
    const result = await new MigrationService(createContainerFromDb(f.db)).runAll();
    if (result.errors.length) throw Error('Canonical bootstrap fixture migration failed');
    expect(await inspectManagerRuntimeBootstrap(f.db, target)).toMatchObject({ state: 'fresh', ready: false, dependencies: { pricing: true, refund: true } });
  }, 180000);
  afterEach(async () => {
    if (f) try {
      const [identity] = await f.db.execute(sql`SELECT current_database() AS database,current_user AS role`);
      if (identity.database !== target.database || identity.role !== target.maintenanceRole) throw Error('Owned bootstrap cleanup target changed');
      const rows = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${MANAGER_BOOTSTRAP_SCOPE_OWNER}`);
      if (rows.length) {
        if (rows.length !== 1 || rows[0].oid !== ownerOid) throw Error('Unmarked bootstrap role is not authorized for cleanup');
        await f.db.execute(sql`DROP OWNED BY ${owner}`); await f.db.execute(sql`DROP ROLE ${owner}`);
      }
    } finally { await f.close(); }
  }, 30000);
  const businessData = async () => {
    const relations = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname<>'manager_order_operation_request' ORDER BY relname`);
    const rows: unknown[] = [];
    for (const { name } of relations) {
      const [data] = await f.db.execute(sql.raw(`SELECT count(*)::text AS count,md5(COALESCE(string_agg(row::text,E'\\n' ORDER BY row::text),'')) AS hash FROM (SELECT to_jsonb(t) AS row FROM public."${name.replaceAll('"','""')}" t) q`));
      rows.push({ name, ...data });
    }
    return rows;
  };
  it('atomically installs exact empty protocols and only their owner grants, preserving all old business rows; canonical replay is read-only', async () => {
    const before = await businessData(); const installed = await installManagerRuntimeBootstrap(f.db, target); await markOwned();
    expect(installed).toMatchObject({ applied: true, state: { state: 'canonical', ready: true, owner: { restricted: true, no_memberships: true } },
      preservation: { newObjects: 33, oldPrincipalGrantsPreserved: true }, newLedgerRows: 0, applicationAdminGrantsApplied: false, businessDataWrites: false });
    expect(await businessData()).toEqual(before);
    const first = await inspectManagerRuntimeBootstrap(f.db, target);
    expect(await installManagerRuntimeBootstrap(f.db, target)).toMatchObject({ applied: false, state: first });
    expect(await inspectManagerRuntimeBootstrap(f.db, target)).toEqual(first); expect(await businessData()).toEqual(before);
  });
  it('refuses partial catalogs, fixed owner collisions, wrong maintenance targets and canonical drift without repair', async () => {
    await expect(installManagerRuntimeBootstrap(f.db, { ...target, database: 'wrong_database' })).rejects.toThrow('outcome not confirmed');
    await runManagerOrderOperation(f.db); const partial = await inspectManagerRuntimeBootstrap(f.db, target); expect(partial.state).toBe('unavailable');
    await expect(installManagerRuntimeBootstrap(f.db, target)).rejects.toThrow('outcome not confirmed');
    expect(await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${MANAGER_BOOTSTRAP_SCOPE_OWNER}`)).toHaveLength(0);
    await f.exec('DROP TABLE public.manager_order_operation_request');
    await f.db.execute(sql`CREATE ROLE ${owner} NOLOGIN`); await markOwned();
    await expect(installManagerRuntimeBootstrap(f.db, target)).rejects.toThrow('outcome not confirmed'); expect((await inspectManagerRuntimeBootstrap(f.db, target)).ledger?.present).toBe(false);
    await f.db.execute(sql`DROP ROLE ${owner}`); ownerOid = null;
    await installManagerRuntimeBootstrap(f.db, target); await markOwned();
    await f.exec("ALTER TABLE public.manager_order_operation_request ADD COLUMN unreviewed text");
    const drift = await inspectManagerRuntimeBootstrap(f.db, target); expect(drift.state).toBe('unavailable');
    await expect(installManagerRuntimeBootstrap(f.db, target)).rejects.toThrow('outcome not confirmed'); expect(await inspectManagerRuntimeBootstrap(f.db, target)).toEqual(drift);
  });
  it('rolls back actual DDL and grants when inherited PUBLIC authority fails the late restricted owner audit', async () => {
    await f.exec('CREATE TABLE public.unreviewed_owner_authority(id integer); GRANT UPDATE ON public.unreviewed_owner_authority TO PUBLIC');
    const existing = await f.db.execute(sql`SELECT oid,relowner,relacl::text FROM pg_class WHERE oid='public.unreviewed_owner_authority'::regclass`);
    const before = await businessData();
    await expect(installManagerRuntimeBootstrap(f.db, target)).rejects.toThrow('outcome not confirmed');
    expect(await inspectManagerRuntimeBootstrap(f.db, target)).toMatchObject({ state: 'fresh', owner: null }); expect(await businessData()).toEqual(before);
    expect(await f.db.execute(sql`SELECT oid,relowner,relacl::text FROM pg_class WHERE oid='public.unreviewed_owner_authority'::regclass`)).toEqual(existing);
  });
  it('recovers a committed but lost response by read-only exact catalogs and idempotent inspection without replacing owner or functions', async () => {
    const lost = { $client: f.db.$client, transaction: async (...args: Parameters<typeof f.db.transaction>) => { await f.db.transaction(...args); throw Error('synthetic reply lost after actual commit'); } } as unknown as DbClient;
    await expect(installManagerRuntimeBootstrap(lost, target)).rejects.toThrow('outcome not confirmed'); await markOwned();
    const state = await inspectManagerRuntimeBootstrap(f.db, target); expect(state).toMatchObject({ state: 'canonical', ready: true });
    expect(await installManagerRuntimeBootstrap(f.db, target)).toMatchObject({ applied: false, state }); expect(await inspectManagerRuntimeBootstrap(f.db, target)).toEqual(state);
  });
});
