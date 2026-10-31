/** Owned PG16 maintenance and real restricted LOGIN acceptance only. The
 * synthetic rows exercise storage/checks and are deliberately not authenticated
 * provider observations, historical account ownership or a paid transition. */
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
import { ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_SQL, ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_GATE,
  ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_EXPECTED_CONSTRAINTS, assertRoutineOriginalPaymentEvidenceReady,
  inspectRoutineOriginalPaymentEvidence, inspectRoutineOriginalPaymentEvidenceCatalog } from '@/migrations/routineOriginalPaymentEvidence';
import { runRoutineOriginalPaymentEvidenceUpgrade, installRoutineOriginalPaymentEvidenceUpgradeInTransaction,
  ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_UPGRADE } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
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
    'users',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY uid) FROM public."user" t),
    'config',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.system_config t),
    'store_orders',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.store_order t),
    'recharges',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.user_recharge t),
    'other_orders',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.other_order t)) AS value`);
  const [presence] = await db.execute<{ present: boolean }>(sql`SELECT to_regclass('public.routine_original_payment_evidence') IS NOT NULL AS present`);
  const rows = presence.present ? Array.from(await db.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version
    FROM public.routine_original_payment_evidence t ORDER BY evidence_id`)) : null;
  return { metadata: metadata.value, rows };
}

async function audits(c: Context) {
  for (const [peer, kind] of [[c.app, 'app'], [c.admin, 'admin']] as const)
    expect(await auditRuntimeBusinessPrivileges(peer.db, kind, c.target)).toMatchObject({ ready: true, failures: [] });
}

type Evidence = { id: string; order: string; transaction: string; source: string; sourceId: string;
  format: number; payload: unknown; created: number; signature: string };
const evidence = (patch: Partial<Evidence> = {}): Evidence => ({ id: 'a'.repeat(64), order: 'owned_storage_order',
  transaction: 'owned_storage_transaction', source: 'callback', sourceId: 'owned-storage-event', format: 1,
  payload: { synthetic_storage_only: true }, created: 1, signature: 'b'.repeat(64), ...patch });
const insert = (db: Query, row = evidence()) => db.execute(sql`INSERT INTO public.routine_original_payment_evidence
  (evidence_id,order_no,transaction_id,source,source_id,format_version,payload,created_at,signature)
  VALUES(${row.id},${row.order},${row.transaction},${row.source},${row.sourceId},${row.format},
    ${JSON.stringify(row.payload)}::jsonb,${row.created},${row.signature}) RETURNING evidence_id`);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine original payment evidence formal PG16 addon', () => {
  afterEach(() => vi.restoreAllMocks());

  it('installs the exact PG16 catalog, retains rows and ACLs on a read-only repeat, and passes both full LOGIN audits', async () => fixture(async c => {
    const before = await snapshot(c.f.db);
    expect(await inspectRoutineOriginalPaymentEvidenceCatalog(c.f.db, c.target)).toEqual({ present: false, ready: false, binding: null, failures: [] });
    await audits(c);
    const installed = await runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target);
    expect(installed).toEqual({ operation: ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_UPGRADE, applied: true });
    expect(await inspectRoutineOriginalPaymentEvidence(c.f.db, c.target)).toBe(true);
    expect(await inspectRoutineOriginalPaymentEvidenceCatalog(c.f.db, c.target)).toMatchObject({ present: true, ready: true,
      binding: { maintenance: c.target.maintenance, app: c.app.role }, failures: [] });
    const definitions = await c.f.db.execute<{ name: string; definition: string }>(sql`SELECT conname AS name,
      pg_get_constraintdef(oid,false) AS definition FROM pg_catalog.pg_constraint
      WHERE conrelid='public.routine_original_payment_evidence'::regclass ORDER BY conname`);
    expect(Object.fromEntries(definitions.map(row => [row.name, row.definition]))).toEqual(ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_EXPECTED_CONSTRAINTS);
    expect(definitions).toHaveLength(11);
    const indexes = await c.f.db.execute<{ name: string; definition: string }>(sql`SELECT c.relname AS name,
      pg_get_indexdef(c.oid) AS definition FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid='public.routine_original_payment_evidence'::regclass ORDER BY c.relname`);
    expect(Array.from(indexes)).toEqual([
      { name: 'rope_order_idx', definition: 'CREATE INDEX rope_order_idx ON public.routine_original_payment_evidence USING btree (order_no, evidence_id)' },
      { name: 'rope_pk', definition: 'CREATE UNIQUE INDEX rope_pk ON public.routine_original_payment_evidence USING btree (evidence_id)' },
      { name: 'rope_source_uq', definition: 'CREATE UNIQUE INDEX rope_source_uq ON public.routine_original_payment_evidence USING btree (source, source_id)' },
      { name: 'rope_transaction_idx', definition: 'CREATE INDEX rope_transaction_idx ON public.routine_original_payment_evidence USING btree (transaction_id, evidence_id)' },
    ]);
    const [grants] = await c.f.db.execute(sql`SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable)
      ORDER BY a.privilege_type) AS grants FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE c.oid='public.routine_original_payment_evidence'::regclass AND a.grantee<>c.relowner`);
    expect(grants.grants).toEqual([[c.app.role, 'INSERT', false], [c.app.role, 'SELECT', false]]);
    await c.app.db.transaction(tx => assertRoutineOriginalPaymentEvidenceReady(tx));
    expect(await insert(c.app.db)).toEqual([{ evidence_id: evidence().id }]);
    const after = await snapshot(c.f.db);
    expect(after.metadata).toMatchObject(Object.fromEntries(Object.entries(before.metadata as Record<string, unknown>)
      .filter(([key]) => ['users', 'config', 'store_orders', 'recharges', 'other_orders'].includes(key))));
    expect(await runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target)).toEqual({ ...installed, applied: false });
    expect(await snapshot(c.f.db)).toEqual(after);
    await audits(c);
  }), 180000);

  it('rolls every addon object, grant and synthetic row back with its caller-owned maintenance transaction', async () => fixture(async c => {
    const before = await snapshot(c.f.db), abort = Error('Owned original payment evidence rollback');
    await expect(c.f.db.transaction(async tx => {
      expect(await installRoutineOriginalPaymentEvidenceUpgradeInTransaction(tx, c.target)).toMatchObject({ applied: true });
      expect(await inspectRoutineOriginalPaymentEvidence(tx, c.target)).toBe(true);
      await insert(tx);
      throw abort;
    }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(abort);
    expect(await snapshot(c.f.db)).toEqual(before);
    expect(await inspectRoutineOriginalPaymentEvidenceCatalog(c.f.db, c.target)).toMatchObject({ present: false, ready: false });
    await audits(c);
  }), 180000);

  it('refuses owner-only partial storage and an orphan namespace without completing or repairing either', async () => fixture(async c => {
    const clean = await snapshot(c.f.db);
    for (const ddl of [ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_SQL,
      'CREATE FUNCTION public.rope_orphan_v1() RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$BEGIN RETURN; END$$']) {
      const abort = Error('Owned partial namespace rollback');
      await expect(c.f.db.transaction(async tx => {
        await tx.execute(sql.raw(ddl));
        expect(await inspectRoutineOriginalPaymentEvidenceCatalog(tx, c.target)).toMatchObject({ present: true, ready: false });
        const before = await snapshot(tx);
        await expect(installRoutineOriginalPaymentEvidenceUpgradeInTransaction(tx, c.target)).rejects.toThrow('Partial or drifted');
        expect(await snapshot(tx)).toEqual(before);
        throw abort;
      }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(abort);
      expect(await snapshot(c.f.db)).toEqual(clean);
    }
    expect(await runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target)).toMatchObject({ applied: true });
    await audits(c);
  }), 180000);

  it('refuses column ACL and trigger-body drift without repairing installed rows or authority', async () => fixture(async c => {
    await runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target); await insert(c.app.db);
    const clean = await snapshot(c.f.db);
    const drifts = [
      `GRANT UPDATE(payload) ON public.routine_original_payment_evidence TO ${pricingIdentifier(c.app.role)}`,
      `CREATE OR REPLACE FUNCTION public.routine_original_payment_evidence_immutable_v1() RETURNS trigger
        LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN RETURN OLD; END$$`,
      'ALTER TABLE public.routine_original_payment_evidence ADD COLUMN owned_unreviewed_column integer',
    ];
    for (const ddl of drifts) {
      const abort = Error('Owned catalog drift rollback');
      await expect(c.f.db.transaction(async tx => {
        await tx.execute(sql.raw(ddl));
        expect(await inspectRoutineOriginalPaymentEvidence(tx, c.target)).toBe(false);
        const before = await snapshot(tx);
        await expect(installRoutineOriginalPaymentEvidenceUpgradeInTransaction(tx, c.target)).rejects.toThrow('Partial or drifted');
        expect(await snapshot(tx)).toEqual(before);
        throw abort;
      }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(abort);
      expect(await snapshot(c.f.db)).toEqual(clean);
    }
    expect(await runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target)).toMatchObject({ applied: false });
    await audits(c);
  }), 180000);

  it('uses the independent maintenance gate, rejects actual table contention and succeeds after each peer releases', async () => fixture(async c => {
    const before = await snapshot(c.f.db), [key, subkey] = ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_GATE;
    if (!c.f.withPeer) throw Error('Owned independent maintenance peer required');
    await c.f.withPeer(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey})`);
      await expect(runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target)).rejects.toThrow('commissioning is busy');
      expect(await snapshot(c.f.db)).toEqual(before);
    }));
    expect(await runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target)).toMatchObject({ applied: true });
    const installed = await snapshot(c.f.db);
    await c.f.withPeer(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey})`);
      await expect(c.app.db.transaction(appTx => assertRoutineOriginalPaymentEvidenceReady(appTx))).rejects.toMatchObject({ code: 503 });
      expect(await snapshot(c.f.db)).toEqual(installed);
    }));
    await expect(c.app.db.transaction(tx => assertRoutineOriginalPaymentEvidenceReady(tx))).resolves.toBeUndefined();
    await c.app.db.transaction(async tx => {
      await assertRoutineOriginalPaymentEvidenceReady(tx);
      const [held] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid()
        AND locktype='advisory' AND classid=${key}::oid AND objid=${subkey}::oid AND objsubid=2 AND mode='ShareLock' AND granted) AS held`);
      expect(held.held).toBe(true);
      await expect(runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target)).rejects.toThrow('commissioning is busy');
    });
    await c.f.withPeer(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`LOCK TABLE ONLY public.routine_original_payment_evidence IN ACCESS SHARE MODE`);
      await expect(runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target)).rejects.toMatchObject({ cause: { code: '55P03' } });
    }));
    expect(await runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target)).toMatchObject({ applied: false });
    expect(await snapshot(c.f.db)).toEqual(installed);
    await audits(c);
  }), 180000);

  it('enforces checks and append-only access through actual App, Admin and unrelated LOGINs', async () => fixture(async c => {
    await runRoutineOriginalPaymentEvidenceUpgrade(c.f.db, c.target);
    expect(await c.app.exec('SELECT * FROM public.routine_original_payment_evidence')).toEqual([]);
    await insert(c.app.db);
    await insert(c.app.db, evidence({ id: 'c'.repeat(64), source: 'signed_query', sourceId: 'owned-query:1.2_3-4' }));
    const before = await snapshot(c.f.db);
    const invalid: Array<[Partial<Evidence>, string]> = [
      [{ id: 'Z'.repeat(64) }, 'rope_id_ck'], [{ order: 'x' }, 'rope_order_ck'],
      [{ transaction: 'has space' }, 'rope_transaction_ck'], [{ source: 'initiation' }, 'rope_source_ck'],
      [{ sourceId: 'has space' }, 'rope_source_id_ck'], [{ format: 2 }, 'rope_format_ck'],
      [{ payload: [] }, 'rope_payload_ck'], [{ payload: { padding: 'x'.repeat(16384) } }, 'rope_payload_ck'],
      [{ created: 0 }, 'rope_created_ck'], [{ signature: 'Z'.repeat(64) }, 'rope_signature_ck'],
    ];
    for (const [patch, constraint] of invalid) await expect(insert(c.app.db,
      evidence({ id: 'd'.repeat(64), sourceId: 'owned-invalid-unused', ...patch })))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: constraint } });
    await expect(insert(c.app.db, evidence({ id: 'e'.repeat(64) }))).rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'rope_source_uq' } });
    await expect(insert(c.app.db, evidence({ sourceId: 'owned-new-source-same-primary-key' })))
      .rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'rope_pk' } });
    for (const statement of ['UPDATE public.routine_original_payment_evidence SET payload=payload',
      'DELETE FROM public.routine_original_payment_evidence', 'TRUNCATE public.routine_original_payment_evidence']) {
      await expect(c.app.exec(statement)).rejects.toMatchObject({ code: '42501' });
      // Independently prove immutable triggers even for the owned maintenance
      // principal, rather than mistaking an ACL denial for trigger coverage.
      await expect(c.f.exec(statement)).rejects.toMatchObject({ code: '42501' });
    }
    for (const statement of ['SELECT * FROM public.routine_original_payment_evidence',
      'INSERT INTO public.routine_original_payment_evidence DEFAULT VALUES',
      'UPDATE public.routine_original_payment_evidence SET payload=payload',
      'DELETE FROM public.routine_original_payment_evidence', 'TRUNCATE public.routine_original_payment_evidence'])
      await expect(c.admin.exec(statement)).rejects.toMatchObject({ code: '42501' });
    await expect(c.admin.db.transaction(tx => assertRoutineOriginalPaymentEvidenceReady(tx))).rejects.toMatchObject({ code: 503 });
    await expect(assertRoutineOriginalPaymentEvidenceReady(c.app.db)).rejects.toMatchObject({ code: 503 });
    await expect(c.f.db.transaction(tx => assertRoutineOriginalPaymentEvidenceReady(tx))).rejects.toMatchObject({ code: 503 });
    await c.f.withRuntimeRole!(async other => {
      await expect(other.exec('SELECT * FROM public.routine_original_payment_evidence')).rejects.toMatchObject({ code: '42501' });
      await expect(other.exec('INSERT INTO public.routine_original_payment_evidence DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
      await expect(other.db.transaction(tx => assertRoutineOriginalPaymentEvidenceReady(tx))).rejects.toMatchObject({ code: 503 });
    });
    expect(await snapshot(c.f.db)).toEqual(before);
    await audits(c);
  }), 180000);

  it('retains complete local/case-lock, peer and App-reader declarations captured before asynchronous BEGIN', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider I/O in evidence maintenance acceptance'));
    const f = await customerCashierRuntimeHttpFixture();
    try {
      if (!f.target.local?.length || !f.target.caseLock?.runtimeRoles.length) throw Error('Full local and case-lock binding required');
      const before = await snapshot(f.maintenanceDb), business = await f.facts();
      await expect(runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, undefined, f.appReaders)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      await expect(runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      await expect(runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, { ...f.target, local: [] }, f.peers, f.appReaders)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      await expect(runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, { ...f.target, caseLock: undefined }, f.peers, f.appReaders)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      const callerTarget = { ...f.target, local: [...f.target.local],
        caseLock: { ...f.target.caseLock, runtimeRoles: [...f.target.caseLock.runtimeRoles] } };
      const callerPeers = structuredClone(f.peers), callerReader = structuredClone(f.appReaders);
      const pending = runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, callerTarget, callerPeers, callerReader);
      callerTarget.database = 'owned_mutated_target'; callerTarget.app = f.adminRuntime.role;
      callerTarget.local.splice(0); callerTarget.caseLock.runtimeRoles.splice(0);
      callerPeers.target.admin = f.appRuntime.role; callerPeers.target.local = [];
      expect(Reflect.set(callerReader, 'cashierOrigin', false)).toBe(true);
      expect(await pending).toEqual({ operation: ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_UPGRADE, applied: true });
      const installed = await snapshot(f.maintenanceDb);
      expect(await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders))
        .toEqual({ operation: ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_UPGRADE, applied: false });
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
      await expect(f.appRuntime.db.transaction(tx => assertRoutineOriginalPaymentEvidenceReady(tx))).resolves.toBeUndefined();
      for (const runtime of [f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime]) {
        await expect(runtime.db.execute(sql`SELECT * FROM public.routine_original_payment_evidence LIMIT 0`))
          .rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(runtime.db.execute(sql`INSERT INTO public.routine_original_payment_evidence DEFAULT VALUES`))
          .rejects.toMatchObject({ cause: { code: '42501' } });
      }
      expect(await f.facts()).toEqual(business); expect(network).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }, 180000);
});
