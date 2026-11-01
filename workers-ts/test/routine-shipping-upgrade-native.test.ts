/** Owned PG16 storage/commissioning acceptance. Synthetic JSON below is only
 * a catalog specimen, not shipping approval, TLS success or payment evidence. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { runRoutineShippingUpgrade, installRoutineShippingUpgradeInTransaction } from '@/migrations/runRoutineShippingUpgrade';
import { assertRoutineShippingReadyTx, assertRoutineShippingReadTx, inspectRoutineShippingCatalog,
  ROUTINE_SHIPPING_SQL, ROUTINE_SHIPPING_RUNTIME_PRIVILEGES, ROUTINE_SHIPPING_EXPECTED_COLUMNS,
  ROUTINE_SHIPPING_EXPECTED_CONSTRAINTS } from '@/migrations/routineShipping';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Query = Pick<DbClient, 'execute'>;
type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
const tables = Object.keys(ROUTINE_SHIPPING_RUNTIME_PRIVILEGES.app), hex = 'a'.repeat(64);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('formal Routine shipping App-only storage commissioning', () => {
  let f: Fixture, peers: RuntimeGiftPeerDeclarations, lookalike: string;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const target = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin,
    ...(f.target.local ? { local: [...f.target.local] } : {}),
    ...(f.target.caseLock ? { caseLock: { owner: f.target.caseLock.owner, runtimeRoles: [...f.target.caseLock.runtimeRoles] } } : {}) });
  const install = () => runRoutineShippingUpgrade(f.maintenanceDb, f.target, peers, f.appReaders);

  async function snapshot(db: Query) {
    const [catalog] = await db.execute<{ value: unknown }>(sql`SELECT pg_catalog.jsonb_build_object(
      'relations',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl::text,c.reloptions,c.relchecks)
        ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
          AND(c.relname ~ '^(routine_shipping|rsh[pde]_)' OR c.relname IN('routine_original_payment_evidence','routine_payment_account_policy','routine_payment_account_use'))),
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum)
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
        WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND c.relname ~ '^(routine_shipping|rsh[pde]_)'),
      'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(k.oid::text,k.conname,pg_catalog.pg_get_constraintdef(k.oid,false)) ORDER BY k.oid)
        FROM pg_catalog.pg_constraint k WHERE k.connamespace='public'::regnamespace AND k.conname ~ '^(routine_shipping|rsh[pde]_)'),
      'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.indexrelid)
        FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
        WHERE c.relnamespace='public'::regnamespace AND c.relname ~ '^routine_shipping'),
      'types',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_type t
        WHERE t.typnamespace='public'::regnamespace AND t.typname ~ '^(_?routine_shipping|_?rsh[pde]_)'),
      'defaults',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid) FROM pg_catalog.pg_default_acl d),
      'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.oid::text,p.proname,p.proowner::text,p.proacl::text,
        pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))) ORDER BY p.oid) FROM pg_catalog.pg_proc p
        WHERE p.pronamespace='public'::regnamespace AND p.proname IN
          ('routine_shipping_immutable_v1','routine_original_payment_evidence_immutable_v1','routine_payment_account_immutable_v1')),
      'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t
        WHERE t.tgname ~ '^(routine_shipping|rsh[pde]_)'),
      'roles',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.oid) FROM pg_catalog.pg_roles r
        WHERE r.rolname IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role},${f.managerRuntime.role},${f.cashierRuntime.role}))
      ) AS value`);
    const rows: Record<string, unknown> = {};
    for (const table of tables) {
      const [present] = await db.execute<{ exists: boolean }>(sql`SELECT pg_catalog.to_regclass(${`public.${table}`}) IS NOT NULL AS exists`);
      if (present.exists) rows[table] = Array.from(await db.execute(sql.raw(`SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin
        FROM public.${table} t ORDER BY pg_catalog.to_jsonb(t)::text`)));
    }
    return { catalog: catalog.value, rows };
  }
  async function refusedWithoutRepair(change: (tx: Query) => Promise<unknown>) {
    const before = await snapshot(f.maintenanceDb);
    await expect(f.maintenanceDb.transaction(async tx => {
      await change(tx); const changed = await snapshot(tx);
      await expect(tx.transaction(inner => installRoutineShippingUpgradeInTransaction(inner, f.target, peers, f.appReaders))).rejects.toThrow();
      expect(await snapshot(tx)).toEqual(changed);
      throw Error('owned shipping drift rollback');
    })).rejects.toThrow('owned shipping drift rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  }
  async function hold(acquire: (tx: Query) => Promise<unknown>, work: () => Promise<void>) {
    await f.withMaintenancePeer(async peer => {
      let ready!: () => void, release!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
      const held = peer.transaction(async tx => { await acquire(tx); ready(); await released; });
      try { await Promise.race([acquired, held.then(() => { throw Error('Owned shipping resource exited before release'); })]); await work(); }
      finally { release(); await held; }
    });
  }

  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Provider transport is forbidden in shipping storage acceptance'));
    f = await customerCashierRuntimeHttpFixture();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineRefundUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    const financial = await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb, f.target,
      { routineRefund: { routineRefund: true }, manualRefund: f.manual, originalPaymentReaders: f.readers }, f.peers, f.appReaders);
    peers = financial.peers; lookalike = (await f.createOwnedRole('shippingpeer', true)).role;
    expect(new Set(await Promise.all([f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime].map(peer => peer.verify()))).size).toBe(5);
  }, 180000);
  afterAll(async () => { try { if (f) await f.close(); } finally { network?.mockRestore(); } }, 30000);

  it('distinguishes a wholly absent addon only for the actual App and refuses false maintenance identities', async () => {
    expect(await inspectRoutineShippingCatalog(f.maintenanceDb, f.target)).toEqual({ present: false, ready: false, binding: null, failures: [] });
    expect(await f.appRuntime.db.transaction(tx => assertRoutineShippingReadyTx(tx))).toBe(false);
    expect(await f.appRuntime.db.transaction(tx => assertRoutineShippingReadTx(tx), { isolationLevel: 'repeatable read', accessMode: 'read only' })).toBe(false);
    const before = await snapshot(f.maintenanceDb);
    for (const peer of [f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime]) {
      await expect(peer.db.transaction(tx => assertRoutineShippingReadyTx(tx))).rejects.toMatchObject({ code: 503 });
      await expect(runRoutineShippingUpgrade(peer.db, f.target, peers, f.appReaders)).rejects.toThrow();
    }
    await expect(runRoutineShippingUpgrade(f.maintenanceDb, { ...f.target, database: 'wrong_shipping_database' }, peers, f.appReaders)).rejects.toThrow();
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`);
      await installRoutineShippingUpgradeInTransaction(tx, f.target, peers, f.appReaders);
    })).rejects.toThrow();
    let getters = 0;
    await expect(runRoutineShippingUpgrade(f.maintenanceDb, { ...f.target, get app() { getters++; return f.target.app; } }, peers, f.appReaders)).rejects.toThrow();
    expect(getters).toBe(0); expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('refuses partial, orphan and owner-only namespaces without repairing them', async () => {
    await refusedWithoutRepair(tx => tx.execute(sql`CREATE TABLE public.routine_shipping_orphan(id integer)`));
    await refusedWithoutRepair(tx => tx.execute(sql`CREATE TYPE public.routine_shipping_orphan AS ENUM('metadata')`));
    await refusedWithoutRepair(tx => tx.execute(sql.raw(ROUTINE_SHIPPING_SQL)));
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`CREATE TABLE public.routine_shipping_dispatch(id integer)`);
      expect(await inspectRoutineShippingCatalog(tx, f.target)).toMatchObject({ present: true, ready: false, binding: null });
      throw Error('owned partial runtime rollback');
    })).rejects.toThrow('owned partial runtime rollback');
    const before = await snapshot(f.maintenanceDb);
    await f.maintenanceDb.execute(sql`CREATE TABLE public.routine_shipping_orphan(id integer)`);
    try {
      await expect(f.appRuntime.db.transaction(tx => assertRoutineShippingReadyTx(tx))).rejects.toMatchObject({ code: 503 });
      await expect(f.appRuntime.db.transaction(tx => assertRoutineShippingReadTx(tx))).rejects.toMatchObject({ code: 503 });
      await expect(install()).rejects.toThrow();
    } finally { await f.maintenanceDb.execute(sql`DROP TABLE public.routine_shipping_orphan`); }
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('rolls back a complete formal installation atomically with its caller transaction', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    await expect(f.maintenanceDb.transaction(async tx => {
      const result = await installRoutineShippingUpgradeInTransaction(tx, f.target, peers, f.appReaders);
      expect(result).toMatchObject({ operation: 'routine-shipping-v1', applied: true });
      expect(await inspectRoutineShippingCatalog(tx, f.target)).toMatchObject({ present: true, ready: true,
        binding: { app: f.appRuntime.role, admin: f.adminRuntime.role, maintenance: f.target.maintenance } });
      for (const table of tables) expect(await tx.execute(sql.raw(`SELECT * FROM public.${table}`))).toHaveLength(0);
      throw Error('owned shipping install rollback');
    })).rejects.toThrow('owned shipping install rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(business);
  }, 90000);

  it('refuses a real independent gate holder then installs with captured full peer, reader and local declarations', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    await hold(tx => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731719,0)`), async () => { await expect(install()).rejects.toThrow('busy'); });
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
    if (!f.target.local || !f.target.caseLock) throw Error('Complete local/case-lock fixture required');
    const callerTarget = { ...target(), local: [...f.target.local], caseLock: { owner: f.target.caseLock.owner,
      runtimeRoles: [...f.target.caseLock.runtimeRoles] }, unknown: { neverEcho: true } };
    const expectedPeers = structuredClone(peers), callerPeers = structuredClone(peers), reader = structuredClone(f.appReaders);
    const pending = runRoutineShippingUpgrade(f.maintenanceDb, callerTarget, callerPeers, reader);
    callerTarget.database = 'changed_after_await'; callerTarget.local.splice(0); callerTarget.caseLock.runtimeRoles.splice(0);
    callerTarget.unknown.neverEcho = false; callerPeers.target.local = []; delete callerPeers.manager; Reflect.set(reader, 'cashierOrigin', false);
    const result = await pending;
    expect(result).toMatchObject({ operation: 'routine-shipping-v1', applied: true }); expect(result.target).toEqual(target());
    expect(Object.hasOwn(result.target, 'unknown')).toBe(false); expect(Object.hasOwn(result.target, 'pricingOwner')).toBe(false);
    expect(result.peers).toEqual(expectedPeers); expect(result.appReader).toEqual(f.appReaders);
    for (const table of tables) expect(await f.maintenanceDb.execute(sql.raw(`SELECT * FROM public.${table}`))).toHaveLength(0);
    expect(await f.facts()).toEqual(business);
  }, 90000);

  it('has exact PG16 columns, nineteen constraints and seven indexes, and only the fixed App grants', async () => {
    expect(await inspectRoutineShippingCatalog(f.maintenanceDb, f.target)).toMatchObject({ present: true, ready: true, failures: [],
      binding: { app: f.appRuntime.role, admin: f.adminRuntime.role } });
    let constraintCount = 0, indexCount = 0;
    for (const table of tables) {
      const [actual] = await f.maintenanceDb.execute<{ columns: unknown; constraints: Record<string,string>; indexes: number; forbidden: boolean }>(sql`SELECT
        (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attnum,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,
          CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END) ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) AS columns,
        (SELECT pg_catalog.jsonb_object_agg(k.conname,pg_catalog.pg_get_constraintdef(k.oid,false)) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
        (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid) AS indexes,
        EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND(a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'' OR a.attacl IS NOT NULL))
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='f') AS forbidden
        FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass(${`public.${table}`})`);
      expect(actual.columns).toEqual(ROUTINE_SHIPPING_EXPECTED_COLUMNS[table as keyof typeof ROUTINE_SHIPPING_EXPECTED_COLUMNS]);
      expect(actual.constraints).toEqual(ROUTINE_SHIPPING_EXPECTED_CONSTRAINTS[table]); expect(actual.forbidden).toBe(false);
      constraintCount += Object.keys(actual.constraints).length; indexCount += actual.indexes;
    }
    expect(constraintCount).toBe(19); expect(indexCount).toBe(7);
    for (const peer of [f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime]) {
      const rights = await f.maintenanceDb.execute<{ table: string; privilege: string; allowed: boolean; delegated: boolean }>(sql`
        SELECT c.relname AS table,p.privilege,pg_catalog.has_table_privilege(${peer.role},c.oid,p.privilege) AS allowed,
          pg_catalog.has_table_privilege(${peer.role},c.oid,p.privilege||' WITH GRANT OPTION') AS delegated
        FROM pg_catalog.pg_class c CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN(SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(tables)}::jsonb))`);
      expect(rights).toHaveLength(21);
      for (const row of rights) {
        const expected: readonly string[] = peer === f.appRuntime
          ? ROUTINE_SHIPPING_RUNTIME_PRIVILEGES.app[row.table as keyof typeof ROUTINE_SHIPPING_RUNTIME_PRIVILEGES.app] : [];
        expect(row.allowed).toBe(expected.includes(row.privilege)); expect(row.delegated).toBe(false);
      }
      await expect(peer.db.execute(sql`SELECT public.routine_shipping_immutable_v1()`)).rejects.toMatchObject({ cause: { code: '42501' } });
      for (const table of tables) {
        if (peer !== f.appRuntime) {
          await expect(peer.db.execute(sql.raw(`SELECT * FROM public.${table}`))).rejects.toMatchObject({ cause: { code: '42501' } });
          await expect(peer.db.execute(sql.raw(`INSERT INTO public.${table} DEFAULT VALUES`))).rejects.toMatchObject({ cause: { code: '42501' } });
        } else await peer.db.execute(sql.raw(`SELECT * FROM public.${table}`));
        for (const command of [`UPDATE public.${table} SET payload=payload`, `DELETE FROM public.${table} WHERE false`, `TRUNCATE public.${table}`])
          await expect(peer.db.execute(sql.raw(command))).rejects.toMatchObject({ cause: { code: '42501' } });
      }
    }
    const dispatch = randomUUID();
    await f.maintenanceDb.execute(sql`INSERT INTO public.routine_shipping_account_policy(record_id,account_id,revision,payload,created_at,signature)
      VALUES(${randomUUID()}::uuid,'metadata_storage',1,'{"synthetic":true}',1,${hex})`);
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_shipping_dispatch(dispatch_id,delivery_id,source_key,payload,created_at,signature)
      VALUES(${dispatch}::uuid,991,${hex},'{"synthetic":true}',1,${hex})`);
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_shipping_provider_evidence(evidence_id,dispatch_id,payload,created_at,signature)
      VALUES(${hex},${dispatch}::uuid,'{"synthetic":true}',1,${hex})`);
    await expect(f.appRuntime.db.execute(sql`INSERT INTO public.routine_shipping_account_policy(record_id,account_id,revision,payload,created_at,signature)
      VALUES(${randomUUID()}::uuid,'not_allowed',1,'{}',1,${hex})`)).rejects.toMatchObject({ cause: { code: '42501' } });
    for (const [delivery, source, payload, created, signature] of [[0,hex,'{}',1,hex],[992,'wrong','{}',1,hex],
      [992,hex,'[]',1,hex],[992,hex,JSON.stringify({ tooLarge: 'x'.repeat(65536) }),1,hex],[992,hex,'{}',0,hex],[992,hex,'{}',1,'wrong']] as const)
      await expect(f.appRuntime.db.execute(sql`INSERT INTO public.routine_shipping_dispatch(dispatch_id,delivery_id,source_key,payload,created_at,signature)
        VALUES(${randomUUID()}::uuid,${delivery},${source},${payload}::jsonb,${created},${signature})`)).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(f.appRuntime.db.execute(sql`INSERT INTO public.routine_shipping_dispatch(dispatch_id,delivery_id,source_key,payload,created_at,signature)
      VALUES(${randomUUID()}::uuid,991,${hex},'{}',1,${hex})`)).rejects.toMatchObject({ cause: { code: '23505' } });
    for (const table of tables) for (const command of [`UPDATE public.${table} SET payload=payload`, `DELETE FROM public.${table}`, `TRUNCATE public.${table}`])
      await expect(f.maintenanceDb.execute(sql.raw(command))).rejects.toMatchObject({ cause: { code: '42501' } });
  }, 90000);

  it('repeats without row, xmin, ACL or catalog changes and preserves all five complete runtime profiles', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    const result = await install(); expect(result).toMatchObject({ operation: 'routine-shipping-v1', applied: false });
    expect(result.target).toEqual(target()); expect(result.peers).toEqual(peers); expect(result.appReader).toEqual(f.appReaders);
    for (const audit of [
      await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, peers, f.appReaders),
      await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, peers),
      await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db, f.target, f.manual, f.readers, { routineRefund: true }),
      await auditManagerRuntimePrivileges(f.managerRuntime.db, f.target),
      await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role, f.target,
        { abandon: true, conditionalGuards: true, formImages: true }),
    ]) expect(audit).toMatchObject({ ready: true, failures: [] });
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(business); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('refuses table, column, source, function and extra-object drift without inferring identity or repairing', async () => {
    for (const change of [
      (tx: Query) => tx.execute(sql`GRANT SELECT ON public.routine_shipping_dispatch TO ${sql.identifier(lookalike)}`),
      (tx: Query) => tx.execute(sql`GRANT SELECT(payload) ON public.routine_shipping_dispatch TO ${sql.identifier(f.adminRuntime.role)}`),
      (tx: Query) => tx.execute(sql`REVOKE SELECT ON public.routine_payment_account_policy FROM ${sql.identifier(f.appRuntime.role)}`),
      (tx: Query) => tx.execute(sql`ALTER FUNCTION public.routine_shipping_immutable_v1() COST 101`),
      (tx: Query) => tx.execute(sql.raw('CREATE OR REPLACE FUNCTION public.routine_shipping_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN RETURN OLD; END$$')),
      (tx: Query) => tx.execute(sql`CREATE INDEX rshd_unknown_idx ON public.routine_shipping_dispatch(created_at)`),
    ]) await refusedWithoutRepair(change);
  });

  it('enforces try-only fresh gates and NOWAIT table locks while durable reads avoid the gate and reject context or TEMP shadow', async () => {
    const before = await snapshot(f.maintenanceDb);
    await hold(tx => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731719,0)`), async () => {
      await expect(f.appRuntime.db.transaction(tx => assertRoutineShippingReadyTx(tx))).rejects.toMatchObject({ code: 503 });
      expect(await f.appRuntime.db.transaction(tx => assertRoutineShippingReadTx(tx))).toBe(true);
      expect(await f.appRuntime.db.transaction(tx => assertRoutineShippingReadTx(tx), { isolationLevel: 'repeatable read', accessMode: 'read only' })).toBe(true);
    });
    await hold(tx => tx.execute(sql`LOCK TABLE ONLY public.routine_shipping_dispatch IN ACCESS EXCLUSIVE MODE NOWAIT`), async () => {
      await expect(install()).rejects.toThrow();
    });
    expect((await install()).applied).toBe(false);
    await expect(f.appRuntime.db.transaction(tx => assertRoutineShippingReadyTx(tx), { isolationLevel: 'repeatable read', accessMode: 'read only' })).rejects.toMatchObject({ code: 503 });
    await expect(f.appRuntime.db.transaction(tx => assertRoutineShippingReadTx(tx), { isolationLevel: 'read committed', accessMode: 'read only' })).rejects.toMatchObject({ code: 503 });
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`); await assertRoutineShippingReadTx(tx);
    })).rejects.toMatchObject({ code: 503 });
    // TEMP is granted only for this owned negative fixture. A public-only
    // explicit path retains public as current_schema but searches temp heaps
    // first; the runtime must reject the real shadow, not a mocked catalog.
    await f.maintenanceDb.execute(sql`GRANT TEMPORARY ON DATABASE ${sql.identifier(f.target.database)} TO ${sql.identifier(f.appRuntime.role)}`);
    try {
      for (const table of ['routine_shipping_dispatch','routine_original_payment_evidence'])
        await expect(f.appRuntime.db.transaction(async tx => {
          await tx.execute(sql.raw(`CREATE TEMP TABLE ${table}(id integer) ON COMMIT DROP`));
          await tx.execute(sql`SET LOCAL search_path=public`);
          await assertRoutineShippingReadTx(tx);
        })).rejects.toMatchObject({ code: 503 });
    } finally {
      await f.maintenanceDb.execute(sql`REVOKE TEMPORARY ON DATABASE ${sql.identifier(f.target.database)} FROM ${sql.identifier(f.appRuntime.role)}`);
    }
    for (const peer of [f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime])
      await expect(peer.db.transaction(tx => assertRoutineShippingReadTx(tx))).rejects.toMatchObject({ code: 503 });
    expect(await f.appRuntime.db.transaction(tx => assertRoutineShippingReadyTx(tx))).toBe(true);
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(network).not.toHaveBeenCalled();
  }, 90000);
});
