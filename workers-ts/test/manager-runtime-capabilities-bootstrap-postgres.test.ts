import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { installManagerRuntimeBootstrap, MANAGER_BOOTSTRAP_SCOPE_OWNER, type ManagerBootstrapTarget } from '../src/migrations/managerRuntimeBootstrap';
import { bootstrapManagerRuntimeCapabilities, inspectManagerCapabilityBootstrap, MANAGER_PROMOTION_OWNER } from '../src/migrations/managerCapabilityBootstrap';
import { MANAGER_WAYBILL_OWNER } from '../src/migrations/managerRuntimeCapabilities';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { validateFinanceFixtureUrl } from './helpers/financePostgres';

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).sequential('fixed Manager capability bootstrap on owned native PG16', () => {
  let f: Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>, target: ManagerBootstrapTarget;
  let inFlightBody: Promise<void> | undefined;
  const trackBody = (body: () => Promise<void>) => () => {
    const pending = body(); inFlightBody = pending; return pending;
  };
  const owned = new Map<string, string>();
  const markOwned = async (name: string) => {
    const rows = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${name}`);
    if (rows.length !== 1 || owned.has(name) && owned.get(name) !== rows[0].oid) throw Error('Owned capability role identity changed'); owned.set(name, rows[0].oid);
  };
  const markCapabilities = async () => { await markOwned(MANAGER_WAYBILL_OWNER); await markOwned(MANAGER_PROMOTION_OWNER); };
  beforeEach(async () => {
    inFlightBody = undefined;
    owned.clear(); validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? ''); f = await checkoutPricingMigrationDatabase();
    const [identity] = await f.db.execute(sql`SELECT current_database() AS database,current_user AS role`);
    target = { database: String(identity.database), maintenanceRole: String(identity.role) };
    expect(await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname IN(${MANAGER_BOOTSTRAP_SCOPE_OWNER},${MANAGER_WAYBILL_OWNER},${MANAGER_PROMOTION_OWNER})`)).toHaveLength(0);
    const result = await new MigrationService(createContainerFromDb(f.db)).runAll(); if (result.errors.length) throw Error('Canonical capability fixture migration failed');
    await installManagerRuntimeBootstrap(f.db, target); await markOwned(MANAGER_BOOTSTRAP_SCOPE_OWNER);
    expect(await inspectManagerCapabilityBootstrap(f.db, target)).toMatchObject({ state: 'fresh', ready: false, promotionOwner: { reuse: false }, prerequisites: { presence: { ready: true } } });
  }, 180000);
  afterEach(async () => {
    // Vitest's test deadline does not cancel an already running async body.
    // Let its own OID registration finish before the existing guarded cleanup.
    const bodyOutcome = await inFlightBody?.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    if (f) try {
      const [identity] = await f.db.execute(sql`SELECT current_database() AS database,current_user AS role`);
      if (identity.database !== target.database || identity.role !== target.maintenanceRole) throw Error('Owned capability cleanup target changed');
      for (const name of [...owned.keys()].reverse()) {
        const [role] = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${name}`);
        if (role) {
          if (role.oid !== owned.get(name)) throw Error('Owned capability role changed');
          await f.db.execute(sql`DROP OWNED BY ${sql.identifier(name)}`); await f.db.execute(sql`DROP ROLE ${sql.identifier(name)}`);
        }
      }
    } finally { await f.close(); }
    if (bodyOutcome?.ok === false) throw bodyOutcome.error;
  }, 30000);
  const businessData = async () => {
    const relations = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
    if (!relations.length) return [];
    const snapshots = relations.map(({ name }, ordinal) => sql`SELECT ${ordinal}::integer AS ordinal,${name}::text AS name,data.count,data.hash FROM (${sql.raw(`SELECT count(*)::text AS count,md5(COALESCE(string_agg(row::text,E'\\n' ORDER BY row::text),'')) AS hash FROM (SELECT to_jsonb(t) AS row FROM public."${name.replaceAll('"','""')}" t) q`)}) data`);
    const rows = await f.db.execute<{ ordinal: number; name: string; count: string; hash: string }>(sql`SELECT * FROM (${sql.join(snapshots, sql.raw(' UNION ALL '))}) business_rows ORDER BY ordinal`);
    expect(rows.map(row => row.ordinal)).toEqual(relations.map((_, ordinal) => ordinal));
    expect(rows.map(row => row.name)).toEqual(relations.map(row => row.name));
    return rows.map(({ name, count, hash }) => ({ name, count, hash }));
  };
  it('installs only exact purpose roles and three functions with old objects, grants and all business rows preserved; replays without replacement', trackBody(async () => {
    const before = await businessData(); const result = await bootstrapManagerRuntimeCapabilities(f.db, target); await markCapabilities();
    expect(result).toMatchObject({ applied: true, state: { ready: true, state: 'canonical' }, preservation: { newObjects: 5, oldPrincipalGrantsPreserved: true, existingManualOwnerReused: false }, credentialsCreated: false, businessDataWrites: false, applicationAdminGrantsApplied: false });
    expect(await businessData()).toEqual(before); const state = await inspectManagerCapabilityBootstrap(f.db, target);
    expect(await bootstrapManagerRuntimeCapabilities(f.db, target)).toMatchObject({ applied: false, state }); expect(await businessData()).toEqual(before);
  }), 30_000);
  it('refuses owner collisions, unknown promotion DELETE grantees, partial catalogs and function drift without repair', trackBody(async () => {
    const cashierSignal = "CREATE FUNCTION public.cashier_second_card_promotion_lock_v1() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; REVOKE ALL ON FUNCTION public.cashier_second_card_promotion_lock_v1() FROM PUBLIC";
    await f.exec(cashierSignal); expect((await inspectManagerCapabilityBootstrap(f.db, target)).state).toBe('unavailable');
    await expect(bootstrapManagerRuntimeCapabilities(f.db, target)).rejects.toThrow('outcome not confirmed'); await f.exec('DROP FUNCTION public.cashier_second_card_promotion_lock_v1()');
    await f.db.execute(sql`CREATE ROLE ${sql.identifier(MANAGER_WAYBILL_OWNER)} NOLOGIN NOINHERIT`); await markOwned(MANAGER_WAYBILL_OWNER);
    await expect(bootstrapManagerRuntimeCapabilities(f.db, target)).rejects.toThrow('outcome not confirmed');
    await f.db.execute(sql`DROP ROLE ${sql.identifier(MANAGER_WAYBILL_OWNER)}`); owned.delete(MANAGER_WAYBILL_OWNER);
    const outsider = 'manager_delete_' + randomUUID().replaceAll('-', ''); await f.db.execute(sql`CREATE ROLE ${sql.identifier(outsider)} NOLOGIN`); await markOwned(outsider);
    await f.db.execute(sql`GRANT DELETE ON public.store_order_promotions TO ${sql.identifier(outsider)}`);
    await expect(bootstrapManagerRuntimeCapabilities(f.db, target)).rejects.toThrow('outcome not confirmed');
    await f.db.execute(sql`REVOKE DELETE ON public.store_order_promotions FROM ${sql.identifier(outsider)}`);
    await bootstrapManagerRuntimeCapabilities(f.db, target); await markCapabilities();
    await f.exec(cashierSignal); expect((await inspectManagerCapabilityBootstrap(f.db, target)).state).toBe('unavailable');
    await expect(bootstrapManagerRuntimeCapabilities(f.db, target)).rejects.toThrow('outcome not confirmed'); await f.exec('DROP FUNCTION public.cashier_second_card_promotion_lock_v1()');
    await f.exec("ALTER FUNCTION public.manager_lock_waybill_v1() SET search_path=public,pg_temp");
    const drift = await inspectManagerCapabilityBootstrap(f.db, target); expect(drift.state).toBe('unavailable');
    await expect(bootstrapManagerRuntimeCapabilities(f.db, target)).rejects.toThrow('outcome not confirmed'); expect(await inspectManagerCapabilityBootstrap(f.db, target)).toEqual(drift);
    await f.exec('DROP FUNCTION public.manager_lock_waybill_v1()'); expect((await inspectManagerCapabilityBootstrap(f.db, target)).state).toBe('unavailable');
    await expect(bootstrapManagerRuntimeCapabilities(f.db, target)).rejects.toThrow('outcome not confirmed');
  }), 30_000);
  it('rolls back real role, function and grant DDL when inherited default function grants fail the late fixed owner-only audit', trackBody(async () => {
    const outsider = 'manager_default_' + randomUUID().replaceAll('-', ''); await f.db.execute(sql`CREATE ROLE ${sql.identifier(outsider)} NOLOGIN`); await markOwned(outsider);
    await f.db.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${sql.identifier(outsider)}`);
    const before = await businessData(); await expect(bootstrapManagerRuntimeCapabilities(f.db, target)).rejects.toThrow('outcome not confirmed');
    expect(await inspectManagerCapabilityBootstrap(f.db, target)).toMatchObject({ state: 'fresh' }); expect(await businessData()).toEqual(before);
    expect(await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname IN(${MANAGER_WAYBILL_OWNER},${MANAGER_PROMOTION_OWNER})`)).toHaveLength(0);
  }), 30_000);
  it('recovers committed reply loss through fixed readonly catalogs and keeps the original owners/functions on replay', trackBody(async () => {
    const lost = { $client: f.db.$client, transaction: async (...args: Parameters<typeof f.db.transaction>) => { await f.db.transaction(...args); throw Error('synthetic reply lost after actual commit'); } } as unknown as DbClient;
    await expect(bootstrapManagerRuntimeCapabilities(lost, target)).rejects.toThrow('outcome not confirmed'); await markCapabilities();
    const state = await inspectManagerCapabilityBootstrap(f.db, target); expect(state).toMatchObject({ state: 'canonical', ready: true });
    expect(await bootstrapManagerRuntimeCapabilities(f.db, target)).toMatchObject({ applied: false, state }); expect(await inspectManagerCapabilityBootstrap(f.db, target)).toEqual(state);
  }), 30_000);
});
