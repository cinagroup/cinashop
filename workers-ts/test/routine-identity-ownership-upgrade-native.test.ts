/** Owned PG16 maintenance and real restricted LOGIN acceptance only. The
 * synthetic rows exercise storage/checks and are deliberately not authenticated
 * observations, historical adoption, UID migration or a paid transition. */
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import type { RoutinePaymentRuntimeTarget } from '@/migrations/routinePaymentRuntime';
import { ROUTINE_IDENTITY_OWNERSHIP_SQL, ROUTINE_IDENTITY_OWNERSHIP_GATE,
  ROUTINE_IDENTITY_OWNERSHIP_EXPECTED_CONSTRAINTS, assertRoutineIdentityOwnershipReady,
  inspectRoutineIdentityOwnership, inspectRoutineIdentityOwnershipCatalog, assertRoutineIdentityOwnershipInstalledTx } from '@/migrations/routineIdentityOwnership';
import { runRoutineIdentityOwnershipUpgrade, installRoutineIdentityOwnershipUpgradeInTransaction,
  ROUTINE_IDENTITY_OWNERSHIP_UPGRADE } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Query = Pick<DbClient, 'execute'>;
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer: infer P) => unknown ? P : never;
type Context = { f: Fixture; app: Peer; admin: Peer; target: RoutinePaymentRuntimeTarget };

async function fixture(run: (c: Context) => Promise<void>) {
  const f = await refundRuntimeFixture();
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Owned PG16 and independent LOGIN/maintenance peers required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.db.execute<{ database: string; maintenance: string }>(sql`
        SELECT current_database() AS database,current_user AS maintenance`);
      const target = { ...identity, app: app.role, admin: admin.role };
      await runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner });
      expect(app.pid).not.toBe(admin.pid);
      await run({ f, app, admin, target });
    }));
  } finally { await f.close(); }
}

/** Catalog fields which this protocol must retain, plus exact synthetic
 * business rows and xmin. Accepting Query permits snapshots inside the same
 * caller transaction without waiting on the fixture's max-one root pool. */
async function snapshot(db: Query) {
  const [metadata] = await db.execute<{ value: unknown }>(sql`SELECT jsonb_build_object(
    'relations',(SELECT jsonb_agg(jsonb_build_array(oid::text,relname,relkind,relowner::text,relacl::text,
      relnatts,relchecks,reloptions,relrowsecurity,relforcerowsecurity,relreplident) ORDER BY oid)
      FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace),
    'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,
      a.attnotnull,a.attisdropped,a.attidentity,a.attgenerated,a.attacl::text,a.atthasdef) ORDER BY a.attrelid,a.attnum)
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      WHERE c.relnamespace='public'::regnamespace AND a.attnum>0),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(oid::text,conname,conrelid::text,convalidated,
      condeferrable,condeferred,pg_get_constraintdef(oid,false)) ORDER BY oid)
      FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indexrelid::text,i.indrelid::text,i.indkey::text,
      i.indoption::text,i.indclass::text,i.indcollation::text,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid)
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace),
    'functions',(SELECT jsonb_agg(jsonb_build_array(oid::text,proname,proowner::text,proacl::text,prosrc,proconfig,
      prosecdef,proargtypes::text,prorettype::text) ORDER BY oid) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(t.oid::text,t.tgrelid::text,t.tgname,t.tgfoid::text,t.tgenabled,
      t.tgtype,pg_get_triggerdef(t.oid,false)) ORDER BY t.oid) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      WHERE c.relnamespace='public'::regnamespace),
    'types',(SELECT jsonb_agg(jsonb_build_array(oid::text,typname,typowner::text,typacl::text,typtype,typrelid::text,
      typelem::text,typarray::text) ORDER BY oid) FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace),
    'defaults',(SELECT jsonb_agg(jsonb_build_array(oid::text,defaclrole::text,defaclnamespace::text,defaclobjtype,defaclacl::text)
      ORDER BY oid) FROM pg_catalog.pg_default_acl),
    'bindings',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.wechat_user t),
    'users',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY uid) FROM public."user" t),
    'config',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.system_config t),
    'store_orders',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.store_order t),
    'recharges',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.user_recharge t),
    'other_orders',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.other_order t)) AS value`);
  const [presence] = await db.execute<{ present: boolean }>(sql`SELECT to_regclass('public.routine_identity_ownership') IS NOT NULL AS present`);
  const rows = presence.present ? Array.from(await db.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version
    FROM public.routine_identity_ownership t ORDER BY ownership_id`)) : null;
  return { metadata: metadata.value, rows };
}

async function audits(c: Context) {
  for (const [peer, kind] of [[c.app, 'app'], [c.admin, 'admin']] as const)
    expect(await auditRuntimeBusinessPrivileges(peer.db, kind, c.target)).toMatchObject({ ready: true, failures: [] });
}

type Ownership = { id: string; appId: string; openid: string; uid: number; bindingId: number;
  observationId: string; format: number; observed: number; created: number; signature: string };
const ownership = (patch: Partial<Ownership> = {}): Ownership => ({ id: 'a'.repeat(64), appId: 'owned_app',
  openid: 'owned_openid', uid: 11, bindingId: 901, observationId: '8fe26c6d-ab33-48d4-84bc-3427de3bc70b',
  format: 1, observed: 1, created: 1, signature: 'b'.repeat(64), ...patch });
const insert = (db: Query, row = ownership()) => db.execute(sql`INSERT INTO public.routine_identity_ownership
  (ownership_id,app_id,openid,uid,binding_id,observation_id,format_version,observed_at,created_at,signature)
  VALUES(${row.id},${row.appId},${row.openid},${row.uid},${row.bindingId},${row.observationId}::uuid,
    ${row.format},${row.observed},${row.created},${row.signature}) RETURNING ownership_id`);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine identity ownership formal PG16 addon', () => {
  afterEach(() => vi.restoreAllMocks());

  it('installs the exact PG16 catalog, retains rows and ACLs on a read-only repeat, and passes both full LOGIN audits', async () => fixture(async c => {
    await c.f.exec(`INSERT INTO public.wechat_user(id,uid,openid,user_type) VALUES
      (701,11,'owned_unattributed_routine','routine'),(702,11,'owned_legacy_wechat','wechat')`);
    const before = await snapshot(c.f.db);
    await expect(c.app.db.transaction(tx => assertRoutineIdentityOwnershipInstalledTx(tx))).resolves.toBe(false);
    expect(await inspectRoutineIdentityOwnershipCatalog(c.f.db, c.target)).toEqual({ present: false, ready: false, binding: null, failures: [] });
    await audits(c);
    const installed = await runRoutineIdentityOwnershipUpgrade(c.f.db, c.target);
    expect(installed).toEqual({ operation: ROUTINE_IDENTITY_OWNERSHIP_UPGRADE, applied: true });
    expect(await inspectRoutineIdentityOwnership(c.f.db, c.target)).toBe(true);
    expect(await inspectRoutineIdentityOwnershipCatalog(c.f.db, c.target)).toMatchObject({ present: true, ready: true,
      binding: { maintenance: c.target.maintenance, app: c.app.role }, failures: [] });
    // Installing prospective storage must not assign the old binding's AppID.
    expect(await c.app.exec('SELECT * FROM public.routine_identity_ownership')).toEqual([]);
    await expect(c.f.exec(`INSERT INTO public.wechat_user(id,uid,openid,user_type)
      VALUES(703,11,'owned_unattributed_routine','routine')`)).rejects.toMatchObject({ code: '23505' });
    const definitions = await c.f.db.execute<{ name: string; definition: string }>(sql`SELECT conname AS name,
      pg_get_constraintdef(oid,false) AS definition FROM pg_catalog.pg_constraint
      WHERE conrelid='public.routine_identity_ownership'::regclass ORDER BY conname`);
    expect(Object.fromEntries(definitions.map(row => [row.name, row.definition]))).toEqual(ROUTINE_IDENTITY_OWNERSHIP_EXPECTED_CONSTRAINTS);
    expect(definitions).toHaveLength(12);
    const indexes = await c.f.db.execute<{ name: string; definition: string }>(sql`SELECT c.relname AS name,
      pg_get_indexdef(c.oid) AS definition FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid='public.routine_identity_ownership'::regclass ORDER BY c.relname`);
    expect(Array.from(indexes)).toEqual([
      { name: 'rio_app_uid_idx', definition: 'CREATE INDEX rio_app_uid_idx ON public.routine_identity_ownership USING btree (app_id, uid, binding_id)' },
      { name: 'rio_binding_uq', definition: 'CREATE UNIQUE INDEX rio_binding_uq ON public.routine_identity_ownership USING btree (binding_id)' },
      { name: 'rio_identity_uq', definition: 'CREATE UNIQUE INDEX rio_identity_uq ON public.routine_identity_ownership USING btree (app_id, openid)' },
      { name: 'rio_pk', definition: 'CREATE UNIQUE INDEX rio_pk ON public.routine_identity_ownership USING btree (ownership_id)' },
    ]);
    const [grants] = await c.f.db.execute(sql`SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable)
      ORDER BY a.privilege_type) AS grants FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE c.oid='public.routine_identity_ownership'::regclass AND a.grantee<>c.relowner`);
    expect(grants.grants).toEqual([[c.app.role, 'INSERT', false], [c.app.role, 'SELECT', false]]);
    await c.app.db.transaction(tx => assertRoutineIdentityOwnershipReady(tx));
    await expect(c.app.db.transaction(tx => assertRoutineIdentityOwnershipInstalledTx(tx))).resolves.toBe(true);
    // A genuine catalog is insufficient for a root or another runtime to
    // claim the App's installed transaction authority.
    await expect(c.f.db.transaction(tx => assertRoutineIdentityOwnershipInstalledTx(tx))).rejects.toMatchObject({ code: 503 });
    await expect(c.admin.db.transaction(tx => assertRoutineIdentityOwnershipInstalledTx(tx))).rejects.toMatchObject({ code: 503 });
    expect(await insert(c.app.db)).toEqual([{ ownership_id: ownership().id }]);
    const after = await snapshot(c.f.db);
    expect(after.metadata).toMatchObject(Object.fromEntries(Object.entries(before.metadata as Record<string, unknown>)
      .filter(([key]) => ['bindings', 'users', 'config', 'store_orders', 'recharges', 'other_orders'].includes(key))));
    expect(await runRoutineIdentityOwnershipUpgrade(c.f.db, c.target)).toEqual({ ...installed, applied: false });
    expect(await snapshot(c.f.db)).toEqual(after);
    await audits(c);
  }), 180000);

  it('rolls every addon object, grant and synthetic row back with its caller-owned maintenance transaction', async () => fixture(async c => {
    const before = await snapshot(c.f.db), abort = Error('Owned prospective identity ownership rollback');
    await expect(c.f.db.transaction(async tx => {
      expect(await installRoutineIdentityOwnershipUpgradeInTransaction(tx, c.target)).toMatchObject({ applied: true });
      expect(await inspectRoutineIdentityOwnership(tx, c.target)).toBe(true);
      await insert(tx);
      throw abort;
    }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(abort);
    expect(await snapshot(c.f.db)).toEqual(before);
    expect(await inspectRoutineIdentityOwnershipCatalog(c.f.db, c.target)).toMatchObject({ present: false, ready: false });
    await audits(c);
  }), 180000);

  it('refuses owner-only partial storage and an orphan namespace without completing or repairing either', async () => fixture(async c => {
    const clean = await snapshot(c.f.db);
    for (const ddl of [ROUTINE_IDENTITY_OWNERSHIP_SQL,
      'CREATE FUNCTION public.rio_orphan_v1() RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$BEGIN RETURN; END$$']) {
      const abort = Error('Owned partial namespace rollback');
      await expect(c.f.db.transaction(async tx => {
        await tx.execute(sql.raw(ddl));
        expect(await inspectRoutineIdentityOwnershipCatalog(tx, c.target)).toMatchObject({ present: true, ready: false });
        await expect(assertRoutineIdentityOwnershipInstalledTx(tx)).rejects.toMatchObject({ code: 503 });
        const before = await snapshot(tx);
        await expect(installRoutineIdentityOwnershipUpgradeInTransaction(tx, c.target)).rejects.toThrow('Partial or drifted');
        expect(await snapshot(tx)).toEqual(before);
        throw abort;
      }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(abort);
      expect(await snapshot(c.f.db)).toEqual(clean);
    }
    expect(await runRoutineIdentityOwnershipUpgrade(c.f.db, c.target)).toMatchObject({ applied: true });
    await audits(c);
  }), 180000);

  it('refuses column ACL and trigger-body drift without repairing installed rows or authority', async () => fixture(async c => {
    await runRoutineIdentityOwnershipUpgrade(c.f.db, c.target); await insert(c.app.db);
    const clean = await snapshot(c.f.db);
    const drifts = [
      `GRANT UPDATE(openid) ON public.routine_identity_ownership TO ${pricingIdentifier(c.app.role)}`,
      `CREATE OR REPLACE FUNCTION public.routine_identity_ownership_immutable_v1() RETURNS trigger
        LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN RETURN OLD; END$$`,
      'ALTER TABLE public.routine_identity_ownership ADD COLUMN owned_unreviewed_column integer',
    ];
    for (const ddl of drifts) {
      const abort = Error('Owned catalog drift rollback');
      await expect(c.f.db.transaction(async tx => {
        await tx.execute(sql.raw(ddl));
        expect(await inspectRoutineIdentityOwnership(tx, c.target)).toBe(false);
        const before = await snapshot(tx);
        await expect(installRoutineIdentityOwnershipUpgradeInTransaction(tx, c.target)).rejects.toThrow('Partial or drifted');
        expect(await snapshot(tx)).toEqual(before);
        throw abort;
      }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(abort);
      expect(await snapshot(c.f.db)).toEqual(clean);
    }
    expect(await runRoutineIdentityOwnershipUpgrade(c.f.db, c.target)).toMatchObject({ applied: false });
    await audits(c);
  }), 180000);

  it('uses the independent maintenance gate, rejects actual table contention and succeeds after each peer releases', async () => fixture(async c => {
    const before = await snapshot(c.f.db), [key, subkey] = ROUTINE_IDENTITY_OWNERSHIP_GATE;
    if (!c.f.withPeer) throw Error('Owned independent maintenance peer required');
    await c.f.withPeer(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey})`);
      await expect(runRoutineIdentityOwnershipUpgrade(c.f.db, c.target)).rejects.toThrow('commissioning is busy');
      expect(await snapshot(c.f.db)).toEqual(before);
    }));
    expect(await runRoutineIdentityOwnershipUpgrade(c.f.db, c.target)).toMatchObject({ applied: true });
    const installed = await snapshot(c.f.db);
    await c.f.withPeer(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey})`);
      await expect(c.app.db.transaction(appTx => assertRoutineIdentityOwnershipReady(appTx))).rejects.toMatchObject({ code: 503 });
      expect(await snapshot(c.f.db)).toEqual(installed);
    }));
    await expect(c.app.db.transaction(tx => assertRoutineIdentityOwnershipReady(tx))).resolves.toBeUndefined();
    await c.app.db.transaction(async tx => {
      await assertRoutineIdentityOwnershipReady(tx);
      const [held] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid()
        AND locktype='advisory' AND classid=${key}::oid AND objid=${subkey}::oid AND objsubid=2 AND mode='ShareLock' AND granted) AS held`);
      expect(held.held).toBe(true);
      await expect(runRoutineIdentityOwnershipUpgrade(c.f.db, c.target)).rejects.toThrow('commissioning is busy');
    });
    await c.f.withPeer(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`LOCK TABLE ONLY public.routine_identity_ownership IN ACCESS SHARE MODE`);
      await expect(runRoutineIdentityOwnershipUpgrade(c.f.db, c.target)).rejects.toMatchObject({ cause: { code: '55P03' } });
    }));
    expect(await runRoutineIdentityOwnershipUpgrade(c.f.db, c.target)).toMatchObject({ applied: false });
    expect(await snapshot(c.f.db)).toEqual(installed);
    await audits(c);
  }), 180000);

  it('enforces checks and append-only access through actual App, Admin and unrelated LOGINs', async () => fixture(async c => {
    await runRoutineIdentityOwnershipUpgrade(c.f.db, c.target);
    expect(await c.app.exec('SELECT * FROM public.routine_identity_ownership')).toEqual([]);
    await insert(c.app.db);
    // A different account may retain the same openid under a different exact
    // binding. Storage does not change the legacy global unique binding table.
    await insert(c.app.db, ownership({ id: 'c'.repeat(64), appId: 'owned_other_app', bindingId: 902 }));
    const before = await snapshot(c.f.db);
    const invalid: Array<[Partial<Ownership>, string]> = [
      [{ id: 'Z'.repeat(64) }, 'rio_id_ck'], [{ appId: 'has space' }, 'rio_app_ck'],
      [{ openid: '' }, 'rio_openid_ck'], [{ uid: 0 }, 'rio_uid_ck'], [{ bindingId: 0 }, 'rio_binding_ck'],
      [{ format: 2 }, 'rio_format_ck'], [{ observed: 0 }, 'rio_observed_ck'],
      [{ created: 0 }, 'rio_created_ck'], [{ signature: 'Z'.repeat(64) }, 'rio_signature_ck'],
    ];
    for (const [patch, constraint] of invalid) await expect(insert(c.app.db,
      ownership({ id: 'd'.repeat(64), appId: 'owned_unused_app', openid: 'owned_unused_openid', bindingId: 903, ...patch })))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: constraint } });
    await expect(insert(c.app.db, ownership({ id: 'e'.repeat(64), bindingId: 903 })))
      .rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'rio_identity_uq' } });
    await expect(insert(c.app.db, ownership({ id: 'e'.repeat(64), appId: 'owned_other_unused_app' })))
      .rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'rio_binding_uq' } });
    await expect(insert(c.app.db, ownership({ appId: 'owned_unused_app', openid: 'owned_unused_openid', bindingId: 903 })))
      .rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'rio_pk' } });
    for (const statement of ['UPDATE public.routine_identity_ownership SET openid=openid',
      'DELETE FROM public.routine_identity_ownership', 'TRUNCATE public.routine_identity_ownership']) {
      await expect(c.app.exec(statement)).rejects.toMatchObject({ code: '42501' });
      // Independently prove immutable triggers even for the owned maintenance
      // principal, rather than mistaking an ACL denial for trigger coverage.
      await expect(c.f.exec(statement)).rejects.toMatchObject({ code: '42501' });
    }
    for (const statement of ['SELECT * FROM public.routine_identity_ownership',
      'INSERT INTO public.routine_identity_ownership DEFAULT VALUES',
      'UPDATE public.routine_identity_ownership SET openid=openid',
      'DELETE FROM public.routine_identity_ownership', 'TRUNCATE public.routine_identity_ownership'])
      await expect(c.admin.exec(statement)).rejects.toMatchObject({ code: '42501' });
    await expect(c.admin.db.transaction(tx => assertRoutineIdentityOwnershipReady(tx))).rejects.toMatchObject({ code: 503 });
    await expect(assertRoutineIdentityOwnershipReady(c.app.db)).rejects.toMatchObject({ code: 503 });
    await expect(c.f.db.transaction(tx => assertRoutineIdentityOwnershipReady(tx))).rejects.toMatchObject({ code: 503 });
    await c.f.withRuntimeRole!(async other => {
      await expect(other.exec('SELECT * FROM public.routine_identity_ownership')).rejects.toMatchObject({ code: '42501' });
      await expect(other.exec('INSERT INTO public.routine_identity_ownership DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
      await expect(other.db.transaction(tx => assertRoutineIdentityOwnershipReady(tx))).rejects.toMatchObject({ code: 503 });
    });
    expect(await snapshot(c.f.db)).toEqual(before);
    await audits(c);
  }), 180000);

  it('retains complete local/case-lock, peer and App-reader declarations captured before asynchronous BEGIN', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider I/O in ownership maintenance acceptance'));
    const f = await customerCashierRuntimeHttpFixture();
    try {
      if (!f.target.local?.length || !f.target.caseLock?.runtimeRoles.length) throw Error('Full local and case-lock binding required');
      const before = await snapshot(f.maintenanceDb), business = await f.facts();
      await expect(runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, undefined, f.appReaders)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      await expect(runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, f.peers)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      await expect(runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, { ...f.target, local: [] }, f.peers, f.appReaders)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      await expect(runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, { ...f.target, caseLock: undefined }, f.peers, f.appReaders)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      const callerTarget = { ...f.target, local: [...f.target.local],
        caseLock: { ...f.target.caseLock, runtimeRoles: [...f.target.caseLock.runtimeRoles] } };
      const callerPeers = structuredClone(f.peers), callerReader = structuredClone(f.appReaders);
      const pending = runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, callerTarget, callerPeers, callerReader);
      callerTarget.database = 'owned_mutated_target'; callerTarget.app = f.adminRuntime.role;
      callerTarget.local.splice(0); callerTarget.caseLock.runtimeRoles.splice(0);
      callerPeers.target.admin = f.appRuntime.role; callerPeers.target.local = [];
      expect(Reflect.set(callerReader, 'cashierOrigin', false)).toBe(true);
      expect(await pending).toEqual({ operation: ROUTINE_IDENTITY_OWNERSHIP_UPGRADE, applied: true });
      const installed = await snapshot(f.maintenanceDb);
      expect(await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders))
        .toEqual({ operation: ROUTINE_IDENTITY_OWNERSHIP_UPGRADE, applied: false });
      expect(await snapshot(f.maintenanceDb)).toEqual(installed); expect(await f.facts()).toEqual(business);
      const proofs = [
        await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders),
        await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, f.peers),
        await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db, f.target, f.manual, f.readers),
        await auditManagerRuntimePrivileges(f.managerRuntime.db, f.target),
        await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role, f.target,
          { abandon: true, conditionalGuards: true, formImages: true }),
      ];
      for (const proof of proofs) expect(proof).toMatchObject({ ready: true, failures: [], completeServiceCoverageVerified: false });
      const pids = [];
      for (const runtime of [f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime]) pids.push(await runtime.verify());
      expect(new Set(pids).size).toBe(5);
      await expect(f.appRuntime.db.transaction(tx => assertRoutineIdentityOwnershipReady(tx))).resolves.toBeUndefined();
      for (const runtime of [f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime]) {
        await expect(runtime.db.execute(sql`SELECT * FROM public.routine_identity_ownership LIMIT 0`))
          .rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(runtime.db.execute(sql`INSERT INTO public.routine_identity_ownership DEFAULT VALUES`))
          .rejects.toMatchObject({ cause: { code: '42501' } });
      }
      expect(await f.facts()).toEqual(business); expect(network).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }, 180000);
});
