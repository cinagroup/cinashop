/** Owned PG16 formal actor commissioning only. Synthetic storage specimens
 * below are not signed provider facts, refund approval or a money movement.
 * Real original-merchant request/query/callback belongs to integration tests. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { upgradeRoutineRefundActors, upgradeRoutineRefundActorsInTransaction } from '@/migrations/upgradeRoutineRefundActors';
import { ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES, type RoutineRefundActorAddons } from '@/migrations/routineRefundActorAddon';
import { inspectRoutineRefundCatalog, assertRoutineRefundInstalledTx, assertRoutineRefundReadInTx } from '@/migrations/routineRefund';
import { inspectRoutineOriginalPaymentEvidenceCatalog, assertRoutineOriginalPaymentEvidenceReady } from '@/migrations/routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from '@/migrations/routinePaymentAccountPolicy';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Query = Pick<DbClient, 'execute'>;
type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
const tables = Object.keys(ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES);
const fullActors = { admin: true, manager: true } as const;
const hex = 'a'.repeat(64);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('formal Routine refund Admin and Manager actor forward', () => {
  let f: Fixture, peers: RuntimeGiftPeerDeclarations, lookalike: string;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const desired = (actors: RoutineRefundActorAddons): RuntimeGiftPeerDeclarations => ({ ...peers, routineRefundActors: { ...actors } });
  const target = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin,
    ...(f.target.local ? { local: [...f.target.local] } : {}),
    ...(f.target.caseLock ? { caseLock: { owner: f.target.caseLock.owner, runtimeRoles: [...f.target.caseLock.runtimeRoles] } } : {}) });
  async function snapshot(db: Query) {
    const [catalog] = await db.execute<{ value: unknown }>(sql`SELECT pg_catalog.jsonb_build_object(
      'relations',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl::text,c.reloptions,c.relchecks)
        ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN
          (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(tables)}::jsonb))),
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum)
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
        WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND c.relname IN
          (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(tables)}::jsonb))),
      'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(k.oid::text,k.conname,pg_catalog.pg_get_constraintdef(k.oid,false)) ORDER BY k.oid)
        FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN
          (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(tables)}::jsonb))),
      'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.indexrelid)
        FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN
          (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(tables)}::jsonb))),
      'types',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_type t
        WHERE t.typnamespace='public'::regnamespace AND t.typname IN
          (SELECT name FROM pg_catalog.jsonb_array_elements_text(${JSON.stringify([...tables, ...tables.map(name => '_' + name)])}::jsonb) name)),
      'defaults',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid) FROM pg_catalog.pg_default_acl d),
      'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.oid::text,p.proname,p.proowner::text,p.proacl::text,
          pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))) ORDER BY p.oid) FROM pg_catalog.pg_proc p
        WHERE p.pronamespace='public'::regnamespace AND p.proname IN
          ('routine_original_payment_evidence_immutable_v1','routine_payment_account_immutable_v1','routine_refund_immutable_v1',
           'cinashop_runtime_admin_boundary_v1','cinashop_runtime_lock_only_v1',
           'cinashop_runtime_agent_level_catalog_fence_v1','cinashop_runtime_agent_level_row_guard_v1')),
      'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid)
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN
          (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(tables)}::jsonb))),
      'native',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid::text,c.relname,c.relacl::text) ORDER BY c.oid)
        FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND pg_catalog.starts_with(c.relname,'native_app_payment_'))
    ) AS value`);
    const rows: Record<string, unknown> = {};
    for (const table of tables) rows[table] = Array.from(await db.execute(sql.raw(`SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin
      FROM public.${table} t ORDER BY pg_catalog.to_jsonb(t)::text`)));
    return { catalog: catalog.value, rows };
  }
  async function refusedWithoutRepair(change: (tx: Query) => Promise<unknown>, actors = fullActors, previousActors: RoutineRefundActorAddons | undefined = undefined) {
    const outer = await snapshot(f.maintenanceDb);
    await expect(f.maintenanceDb.transaction(async tx => {
      await change(tx); const changed = await snapshot(tx);
      // A savepoint contains SQL errors as well as JavaScript refusals, so the
      // following read can detect repair instead of outer rollback hiding it.
      await expect(tx.transaction(inner => upgradeRoutineRefundActorsInTransaction(inner, f.target,
        { actors, ...(previousActors ? { previousActors } : {}) }, desired(actors), f.appReaders))).rejects.toThrow();
      expect(await snapshot(tx)).toEqual(changed);
      throw Error('owned actor drift rollback');
    })).rejects.toThrow('owned actor drift rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(outer);
  }
  async function hold(run: (tx: Query) => Promise<unknown>, work: () => Promise<void>) {
    await f.withMaintenancePeer(async peer => {
      let ready!: () => void, release!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
      const held = peer.transaction(async tx => { await run(tx); ready(); await released; });
      try {
        await Promise.race([acquired, held.then(() => { throw Error('Owned resource holder exited before release'); })]);
        await work();
      } finally { release(); await held; }
    });
  }
  async function actorPermissions(db: DbClient, role: string) {
    const actual = await f.maintenanceDb.execute<{ table: string; privilege: string; allowed: boolean; delegate: boolean }>(sql`
      SELECT c.relname AS table,p.privilege,pg_catalog.has_table_privilege(${role},c.oid,p.privilege) AS allowed,
        pg_catalog.has_table_privilege(${role},c.oid,p.privilege||' WITH GRANT OPTION') AS delegate
      FROM pg_catalog.pg_class c CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN
        (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(tables)}::jsonb))`);
    expect(actual).toHaveLength(tables.length * 7);
    for (const row of actual) {
      const permitted: readonly string[] = ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES[row.table as keyof typeof ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES];
      expect(row.allowed).toBe(permitted.includes(row.privilege)); expect(row.delegate).toBe(false);
    }
    for (const table of tables) {
      await db.execute(sql.raw(`SELECT * FROM public.${table} LIMIT 0`));
      for (const command of [`UPDATE public.${table} SET payload=payload`, `DELETE FROM public.${table} WHERE false`, `TRUNCATE public.${table}`])
        await expect(db.execute(sql.raw(command))).rejects.toMatchObject({ cause: { code: '42501' } });
      if (!ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES[table as keyof typeof ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES].includes('INSERT' as never))
        await expect(db.execute(sql.raw(`INSERT INTO public.${table} DEFAULT VALUES`))).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    await expect(db.transaction(tx => assertRoutineOriginalPaymentEvidenceReady(tx))).rejects.toMatchObject({ code: 503 });
    await expect(db.transaction(async tx => {
      const id = randomUUID().replaceAll('-', '').padEnd(64, '0');
      await tx.execute(sql`INSERT INTO public.routine_refund_dispatch(dispatch_id,refund_id,out_refund_no,payload,created_at,signature)
        VALUES(${id},991,'CNSR991','{"synthetic":"actor-storage-only"}',1,${hex})`);
      await tx.execute(sql`INSERT INTO public.routine_refund_provider_evidence(evidence_id,dispatch_id,source,source_id,payload,created_at,signature)
        VALUES(${id},${id},'query',${'metadata_' + id},'{"synthetic":"actor-storage-only"}',1,${hex})`);
      throw Error('owned actor inserts rollback');
    })).rejects.toThrow('owned actor inserts rollback');
  }

  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Provider transport is forbidden in actor commissioning acceptance'));
    f = await customerCashierRuntimeHttpFixture();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineRefundUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    const financial = await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb, f.target,
      { routineRefund: { routineRefund: true }, manualRefund: f.manual, originalPaymentReaders: f.readers }, f.peers, f.appReaders);
    peers = financial.peers; lookalike = (await f.createOwnedRole('actorpeer', true)).role;
    const evidence = 'b'.repeat(64);
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_original_payment_evidence
      (evidence_id,order_no,transaction_id,source,source_id,format_version,payload,created_at,signature)
      VALUES(${evidence},'ORIGINAL_METADATA_ONLY','metadata_transaction','callback','metadata_original',1,'{"synthetic":true}',1,${hex})`);
    await f.maintenanceDb.execute(sql`INSERT INTO public.routine_payment_account_policy(record_id,kind,subject_id,revision,payload,created_at,signature)
      VALUES(${randomUUID()}::uuid,'account','metadata_account',1,'{"synthetic":true}',1,${hex})`);
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_payment_account_use(use_id,evidence_id,payload,created_at,signature)
      VALUES(${hex},${evidence},'{"synthetic":true}',1,${hex})`);
    await f.maintenanceDb.execute(sql`INSERT INTO public.routine_refund_account_policy(record_id,account_id,revision,payload,created_at,signature)
      VALUES(${randomUUID()}::uuid,'metadata_refund',1,'{"synthetic":true}',1,${hex})`);
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_refund_dispatch(dispatch_id,refund_id,out_refund_no,payload,created_at,signature)
      VALUES(${hex},990,'CNSR990','{"synthetic":true}',1,${hex})`);
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_refund_provider_evidence(evidence_id,dispatch_id,source,source_id,payload,created_at,signature)
      VALUES(${evidence},${hex},'request','metadata_request','{"synthetic":true}',1,${hex})`);
    const pids = await Promise.all([f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime].map(peer => peer.verify()));
    expect(new Set(pids).size).toBe(5);
  }, 180000);
  afterAll(async () => { try { if (f) await f.close(); } finally { network?.mockRestore(); } }, 30000);

  it('requires complete matching flags and preserves the exact prior catalog on declaration refusal', async () => {
    const before = await snapshot(f.maintenanceDb);
    const invalid = [
      { actors: {} }, { actors: { admin: false } }, { actors: { cashier: true } },
      { actors: { admin: true }, previousActors: { manager: true } },
    ];
    for (const input of invalid) await expect(upgradeRoutineRefundActors(f.maintenanceDb, f.target,
      input as Parameters<typeof upgradeRoutineRefundActors>[2], desired({ admin: true }), f.appReaders)).rejects.toThrow();
    let getters = 0;
    await expect(upgradeRoutineRefundActors(f.maintenanceDb, f.target,
      { get actors() { getters++; return { admin: true as const }; } }, desired({ admin: true }), f.appReaders)).rejects.toThrow();
    expect(getters).toBe(0);
    await expect(upgradeRoutineRefundActors(f.maintenanceDb, f.target, { actors: fullActors }, peers, f.appReaders)).rejects.toThrow();
    const noManager = { ...desired(fullActors) }; delete noManager.manager;
    await expect(upgradeRoutineRefundActors(f.maintenanceDb, f.target, { actors: fullActors }, noManager, f.appReaders)).rejects.toThrow();
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('rolls a complete actor forward back with the caller transaction without changing rows or xmin', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    await expect(f.maintenanceDb.transaction(async tx => {
      const result = await upgradeRoutineRefundActorsInTransaction(tx, f.target, { actors: fullActors }, desired(fullActors), f.appReaders);
      expect(result).toMatchObject({ operation: 'routine-refund-actors-v1', applied: true, actors: fullActors });
      expect(await inspectRoutineRefundCatalog(tx, f.target)).toMatchObject({ ready: true,
        binding: { adminRefund: true, admin: f.adminRuntime.role, manager: f.managerRuntime.role } });
      throw Error('owned actor forward rollback');
    })).rejects.toThrow('owned actor forward rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(business);
  }, 90000);

  it('refuses partial, unrecognized, column and function drift without repairing it', async () => {
    for (const change of [
      (tx: Query) => tx.execute(sql`GRANT SELECT ON public.routine_original_payment_evidence TO ${sql.identifier(f.adminRuntime.role)}`),
      (tx: Query) => tx.execute(sql`GRANT SELECT ON public.routine_refund_account_policy TO ${sql.identifier(lookalike)}`),
      (tx: Query) => tx.execute(sql`GRANT SELECT(payload) ON public.routine_refund_dispatch TO ${sql.identifier(f.managerRuntime.role)}`),
      (tx: Query) => tx.execute(sql`ALTER FUNCTION public.routine_refund_immutable_v1() COST 101`),
    ]) await refusedWithoutRepair(change);
  });

  it('requires the actual maintenance LOGIN and database, rejecting runtime clients and SET ROLE', async () => {
    const before = await snapshot(f.maintenanceDb);
    for (const db of [f.appRuntime.db, f.adminRuntime.db, f.financialRuntime.db, f.managerRuntime.db, f.cashierRuntime.db])
      await expect(upgradeRoutineRefundActors(db, f.target, { actors: fullActors }, desired(fullActors), f.appReaders)).rejects.toThrow();
    await expect(upgradeRoutineRefundActors(f.maintenanceDb, { ...f.target, database: 'wrong_owned_actor_database' },
      { actors: fullActors }, desired(fullActors), f.appReaders)).rejects.toThrow();
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.adminRuntime.role)}`);
      await upgradeRoutineRefundActorsInTransaction(tx, f.target, { actors: fullActors }, desired(fullActors), f.appReaders);
    })).rejects.toThrow();
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('refuses a held gate and NOWAIT table lock, then commissions only Admin after both are released', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    const refused = async () => {
      await expect(upgradeRoutineRefundActors(f.maintenanceDb, f.target, { actors: { admin: true } }, desired({ admin: true }), f.appReaders)).rejects.toThrow();
    };
    await hold(tx => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731718,0)`), refused);
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
    await hold(tx => tx.execute(sql`LOCK TABLE ONLY public.routine_refund_dispatch IN ACCESS EXCLUSIVE MODE NOWAIT`), refused);
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
    const result = await upgradeRoutineRefundActors(f.maintenanceDb, f.target, { actors: { admin: true } }, desired({ admin: true }), f.appReaders);
    expect(result).toMatchObject({ operation: 'routine-refund-actors-v1', applied: true, actors: { admin: true } }); peers = result.peers;
    expect(await inspectRoutineRefundCatalog(f.maintenanceDb, f.target)).toMatchObject({ ready: true,
      binding: { adminRefund: true, admin: f.adminRuntime.role, manager: null } });
    expect((await snapshot(f.maintenanceDb)).rows).toEqual(before.rows); expect(await f.facts()).toEqual(business);
  }, 90000);

  it('grants Admin only the fixed addon while preserving App/Financial and leaving Manager/Cashier uncommissioned', async () => {
    await actorPermissions(f.adminRuntime.db, f.adminRuntime.role);
    expect(await f.adminRuntime.db.transaction(tx => assertRoutineRefundInstalledTx(tx, 'admin'))).toBe(true);
    expect(await f.appRuntime.db.transaction(tx => assertRoutineRefundInstalledTx(tx, 'app'))).toBe(true);
    expect(await f.financialRuntime.db.transaction(tx => assertRoutineRefundInstalledTx(tx, 'financial'))).toBe(true);
    for (const peer of [f.managerRuntime, f.cashierRuntime])
      await expect(peer.db.transaction(tx => assertRoutineRefundInstalledTx(tx))).rejects.toMatchObject({ code: 503 });
    expect((await inspectRoutineOriginalPaymentEvidenceCatalog(f.maintenanceDb, f.target)).ready).toBe(true);
    expect((await inspectRoutinePaymentAccountPolicyCatalog(f.maintenanceDb, f.target)).ready).toBe(true);
  });

  it('adds Manager from the explicit Admin predecessor and captures target, flags, peers and reader before await', async () => {
    if (!f.target.local || !f.target.caseLock) throw Error('Complete local/case-lock fixture required');
    const before = await snapshot(f.maintenanceDb), business = await f.facts(), expectedPeers = structuredClone(desired(fullActors));
    const callerTarget = { ...target(), local: [...f.target.local], caseLock: { owner: f.target.caseLock.owner,
      runtimeRoles: [...f.target.caseLock.runtimeRoles] }, unknown: { neverEcho: true } };
    const input: { actors: RoutineRefundActorAddons; previousActors: RoutineRefundActorAddons } = {
      actors: { ...fullActors }, previousActors: { admin: true } };
    const callerPeers = structuredClone(expectedPeers), reader = structuredClone(f.appReaders);
    const pending = upgradeRoutineRefundActors(f.maintenanceDb, callerTarget, input, callerPeers, reader);
    callerTarget.database = 'changed_after_call'; callerTarget.local.splice(0); callerTarget.caseLock.runtimeRoles.splice(0);
    callerTarget.unknown.neverEcho = false; delete input.actors.manager; delete input.previousActors.admin;
    callerPeers.target.local = []; delete callerPeers.manager; delete callerPeers.routineRefundActors;
    Reflect.set(reader, 'cashierOrigin', false);
    const result = await pending;
    expect(result).toMatchObject({ operation: 'routine-refund-actors-v1', applied: true, actors: fullActors });
    expect(result.target).toEqual(target()); expect(Object.hasOwn(result.target, 'unknown')).toBe(false);
    expect(Object.hasOwn(result.target, 'pricingOwner')).toBe(false); expect(result.peers).toEqual(expectedPeers); peers = result.peers;
    expect(await inspectRoutineRefundCatalog(f.maintenanceDb, f.target)).toMatchObject({ ready: true,
      binding: { adminRefund: true, admin: f.adminRuntime.role, manager: f.managerRuntime.role } });
    expect((await snapshot(f.maintenanceDb)).rows).toEqual(before.rows); expect(await f.facts()).toEqual(business);
  }, 90000);

  it('repeats without catalog or row changes and validates all five actual profiles with Cashier still denied', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    const result = await upgradeRoutineRefundActors(f.maintenanceDb, f.target, { actors: fullActors }, peers, f.appReaders);
    expect(result).toMatchObject({ operation: 'routine-refund-actors-v1', applied: false, actors: fullActors });
    expect(result.target).toEqual(target()); expect(result.peers).toEqual(peers);
    await actorPermissions(f.managerRuntime.db, f.managerRuntime.role);
    for (const [peer, role] of [[f.appRuntime, 'app'], [f.financialRuntime, 'financial'], [f.adminRuntime, 'admin'], [f.managerRuntime, 'manager']] as const)
      expect(await peer.db.transaction(tx => assertRoutineRefundReadInTx(tx, role))).toBe(true);
    await expect(f.cashierRuntime.db.transaction(tx => assertRoutineRefundInstalledTx(tx))).rejects.toMatchObject({ code: 503 });
    const [cashier] = await f.maintenanceDb.execute<{ denied: boolean }>(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(tables)}::jsonb))
        AND (pg_catalog.has_table_privilege(${f.cashierRuntime.role},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(${f.cashierRuntime.role},c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS denied`);
    expect(cashier.denied).toBe(true);
    for (const audit of [
      await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, peers, f.appReaders),
      await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, peers),
      await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db, f.target, f.manual, f.readers, { routineRefund: true }),
      await auditManagerRuntimePrivileges(f.managerRuntime.db, f.target, true),
      await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role, f.target,
        { abandon: true, conditionalGuards: true, formImages: true }),
    ]) expect(audit).toMatchObject({ ready: true, failures: [] });
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(business); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rejects successor drift or privilege removal and does not repair an already-installed addon', async () => {
    await refusedWithoutRepair(tx => tx.execute(sql`REVOKE SELECT ON public.routine_original_payment_evidence FROM ${sql.identifier(f.managerRuntime.role)}`), fullActors, { admin: true });
    await refusedWithoutRepair(tx => tx.execute(sql`GRANT SELECT ON public.routine_payment_account_use TO ${sql.identifier(lookalike)}`), fullActors, { admin: true });
    await refusedWithoutRepair(tx => tx.execute(sql`ALTER FUNCTION public.cinashop_runtime_agent_level_row_guard_v1() COST 101`), fullActors, { admin: true });
    const before = await snapshot(f.maintenanceDb);
    await expect(upgradeRoutineRefundActors(f.maintenanceDb, f.target,
      { actors: { admin: true }, previousActors: fullActors }, desired({ admin: true }), f.appReaders)).rejects.toThrow();
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(network).not.toHaveBeenCalled();
  });
});
