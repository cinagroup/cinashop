/** Owned PG16 storage/commissioning acceptance. Synthetic JSON below is only
 * a storage specimen, not notification intent, consent, provider attempt or outcome evidence. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade, installRoutineSubscriptionDeliveryUpgradeInTransaction } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { assertRoutineSubscriptionDeliveryReadyTx, assertRoutineSubscriptionDeliveryReadTx, inspectRoutineSubscriptionDeliveryCatalog,
  ROUTINE_SUBSCRIPTION_DELIVERY_SQL, ROUTINE_SUBSCRIPTION_DELIVERY_RUNTIME_PRIVILEGES, ROUTINE_SUBSCRIPTION_DELIVERY_EXPECTED_COLUMNS,
  ROUTINE_SUBSCRIPTION_DELIVERY_EXPECTED_CONSTRAINTS } from '@/migrations/routineSubscriptionDelivery';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Query = Pick<DbClient, 'execute'>;
type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
const tables = ['routine_subscribe_attempt','routine_subscribe_result'] as const, hex = 'a'.repeat(64);
const sourceTables = ['routine_original_payment_evidence','routine_identity_ownership','routine_subscription_account_policy'] as const;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('formal Routine subscription delivery append-only storage commissioning', () => {
  let f: Fixture, peers: RuntimeGiftPeerDeclarations, lookalike: string;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const target = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin,
    ...(f.target.local ? { local: [...f.target.local] } : {}),
    ...(f.target.caseLock ? { caseLock: { owner: f.target.caseLock.owner, runtimeRoles: [...f.target.caseLock.runtimeRoles] } } : {}) });
  const install = () => runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, f.target, peers, f.appReaders);

  async function snapshot(db: Query) {
    const [catalog] = await db.execute<{ value: unknown }>(sql`SELECT pg_catalog.jsonb_build_object(
      'relations',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl::text,c.reloptions,c.relchecks)
        ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
          AND(c.relname ~ '^(routine_subscribe|rsnd_)' OR c.relname IN('routine_original_payment_evidence','routine_identity_ownership','routine_subscription_account_policy'))),
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum)
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
        WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND c.relname ~ '^(routine_subscribe|rsnd_)'),
      'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(k.oid::text,k.conname,pg_catalog.pg_get_constraintdef(k.oid,false)) ORDER BY k.oid)
        FROM pg_catalog.pg_constraint k WHERE k.connamespace='public'::regnamespace AND k.conname ~ '^(routine_subscribe|rsnd_)'),
      'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.indexrelid)
        FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
        WHERE c.relnamespace='public'::regnamespace AND c.relname ~ '^routine_subscribe'),
      'types',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_type t
        WHERE t.typnamespace='public'::regnamespace AND t.typname ~ '^(_?routine_subscribe|_?rsnd_)'),
      'defaults',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid) FROM pg_catalog.pg_default_acl d),
      'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.oid::text,p.proname,p.proowner::text,p.proacl::text,
        pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))) ORDER BY p.oid) FROM pg_catalog.pg_proc p
        WHERE p.pronamespace='public'::regnamespace AND p.proname IN
          ('routine_subscribe_immutable_v1','routine_subscription_immutable_v1','routine_original_payment_evidence_immutable_v1','routine_identity_ownership_immutable_v1')),
      'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t
        WHERE t.tgname ~ '^(routine_subscribe|rsnd_)'),
      'memberships',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.roleid,m.member) FROM pg_catalog.pg_auth_members m
        WHERE m.member IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(${f.appRuntime.role},${f.adminRuntime.role}))
          OR m.roleid IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(${f.appRuntime.role},${f.adminRuntime.role}))),
      'roles',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.oid) FROM pg_catalog.pg_roles r
        WHERE r.rolname IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role},${f.managerRuntime.role},${f.cashierRuntime.role}))
      ) AS value`);
    const rows: Record<string, unknown> = {};
    for (const table of [...tables,...sourceTables]) {
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
      await expect(tx.transaction(inner => installRoutineSubscriptionDeliveryUpgradeInTransaction(inner, f.target, peers, f.appReaders))).rejects.toThrow();
      expect(await snapshot(tx)).toEqual(changed);
      throw Error('owned subscription drift rollback');
    })).rejects.toThrow('owned subscription drift rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  }
  async function hold(acquire: (tx: Query) => Promise<unknown>, work: () => Promise<void>) {
    await f.withMaintenancePeer(async peer => {
      let ready!: () => void, release!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
      const held = peer.transaction(async tx => { await acquire(tx); ready(); await released; });
      try { await Promise.race([acquired, held.then(() => { throw Error('Owned subscription resource exited before release'); })]); await work(); }
      finally { release(); await held; }
    });
  }

  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Provider transport is forbidden in subscription storage acceptance'));
    f = await customerCashierRuntimeHttpFixture();
    peers = f.peers; lookalike = (await f.createOwnedRole('subscribespeer', true)).role;
    expect(new Set(await Promise.all([f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime].map(peer => peer.verify()))).size).toBe(5);
  }, 180000);
  afterAll(async () => { try { if (f) await f.close(); } finally { network?.mockRestore(); } }, 30000);

  it('requires all three fully commissioned sources without creating or adopting history', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    await expect(install()).rejects.toThrow('exact complete named subscription source');
    await expect(f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadyTx(tx))).rejects.toMatchObject({ code: 503 });
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, peers, f.appReaders);
    const oneSource = await snapshot(f.maintenanceDb);
    await expect(install()).rejects.toThrow('exact complete named subscription source');
    expect(await snapshot(f.maintenanceDb)).toEqual(oneSource);
    await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, peers, f.appReaders);
    const twoSources = await snapshot(f.maintenanceDb);
    await expect(install()).rejects.toThrow('exact complete named subscription source');
    expect(await snapshot(f.maintenanceDb)).toEqual(twoSources);
    await runRoutineSubscriptionUpgrade(f.maintenanceDb, f.target, peers, f.appReaders);
    expect(await f.facts()).toEqual(business);
  }, 90000);

  it('distinguishes a wholly absent addon only for the actual App and refuses false maintenance identities', async () => {
    expect(await inspectRoutineSubscriptionDeliveryCatalog(f.maintenanceDb, f.target)).toEqual({ present: false, ready: false, binding: null, failures: [] });
    expect(await f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadyTx(tx))).toBe(false);
    expect(await f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadTx(tx), { isolationLevel: 'repeatable read', accessMode: 'read only' })).toBe(false);
    const before = await snapshot(f.maintenanceDb);
    for (const peer of [f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime]) {
      await expect(peer.db.transaction(tx => assertRoutineSubscriptionDeliveryReadyTx(tx))).rejects.toMatchObject({ code: 503 });
      await expect(runRoutineSubscriptionDeliveryUpgrade(peer.db, f.target, peers, f.appReaders)).rejects.toThrow();
    }
    await expect(runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, { ...f.target, database: 'wrong_subscription_database' }, peers, f.appReaders)).rejects.toThrow();
    await expect(runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, { ...f.target, app: lookalike })).rejects.toThrow('exact complete named subscription source');
    await expect(runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, f.target)).rejects.toThrow();
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`);
      await installRoutineSubscriptionDeliveryUpgradeInTransaction(tx, f.target, peers, f.appReaders);
    })).rejects.toThrow();
    let getters = 0;
    await expect(runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, { ...f.target, get app() { getters++; return f.target.app; } }, peers, f.appReaders)).rejects.toThrow();
    expect(getters).toBe(0); expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('refuses partial, orphan and owner-only namespaces without repairing them', async () => {
    await refusedWithoutRepair(tx => tx.execute(sql`CREATE TABLE public.routine_subscribe_orphan(id integer)`));
    await refusedWithoutRepair(tx => tx.execute(sql`CREATE TYPE public.routine_subscribe_orphan AS ENUM('metadata')`));
    await refusedWithoutRepair(tx => tx.execute(sql`CREATE TABLE public.routine_subscribe_result(id integer)`));
    await refusedWithoutRepair(tx => tx.execute(sql.raw(ROUTINE_SUBSCRIPTION_DELIVERY_SQL)));
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`CREATE TABLE public.routine_subscribe_attempt(id integer)`);
      expect(await inspectRoutineSubscriptionDeliveryCatalog(tx, f.target)).toMatchObject({ present: true, ready: false, binding: null });
      throw Error('owned partial runtime rollback');
    })).rejects.toThrow('owned partial runtime rollback');
    const before = await snapshot(f.maintenanceDb);
    await f.maintenanceDb.execute(sql`CREATE TABLE public.routine_subscribe_orphan(id integer)`);
    try {
      await expect(f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadyTx(tx))).rejects.toMatchObject({ code: 503 });
      await expect(f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadTx(tx))).rejects.toMatchObject({ code: 503 });
      await expect(install()).rejects.toThrow();
    } finally { await f.maintenanceDb.execute(sql`DROP TABLE public.routine_subscribe_orphan`); }
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('rolls back a complete formal installation atomically with its caller transaction', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    await expect(f.maintenanceDb.transaction(async tx => {
      const result = await installRoutineSubscriptionDeliveryUpgradeInTransaction(tx, f.target, peers, f.appReaders);
      expect(result).toMatchObject({ operation: 'routine-subscription-delivery-v1', applied: true });
      expect(await inspectRoutineSubscriptionDeliveryCatalog(tx, f.target)).toMatchObject({ present: true, ready: true,
        binding: { app: f.appRuntime.role, maintenance: f.target.maintenance } });
      for (const table of tables) expect(await tx.execute(sql.raw(`SELECT * FROM public.${table}`))).toHaveLength(0);
      // A real failing tail statement aborts the actual PostgreSQL transaction.
      await tx.execute(sql`SELECT 1/0`);
    })).rejects.toMatchObject({ cause: { code: '22012' } });
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(business);
  }, 90000);

  it('refuses a real independent gate holder then installs with captured full peer, reader and local declarations', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    for (const key of [731714,731716,731725,731726]) await hold(tx => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${key},0)`),
      async () => { await expect(install()).rejects.toThrow('busy'); });
    for (const table of [...sourceTables,'system_admin','system_role'])
      await hold(tx => tx.execute(sql.raw(`LOCK TABLE ONLY public.${table} IN ROW EXCLUSIVE MODE NOWAIT`)),
        async () => { await expect(install()).rejects.toMatchObject({ cause: { code: '55P03' } }); });
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
    if (!f.target.local || !f.target.caseLock) throw Error('Complete local/case-lock fixture required');
    const callerTarget = { ...target(), local: [...f.target.local], caseLock: { owner: f.target.caseLock.owner,
      runtimeRoles: [...f.target.caseLock.runtimeRoles] }, unknown: { neverEcho: true } };
    const expectedPeers = { ...structuredClone(peers), target: target() }, callerPeers = structuredClone(peers), reader = structuredClone(f.appReaders);
    const pending = runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, callerTarget, callerPeers, reader);
    callerTarget.database = 'changed_after_await'; callerTarget.local.splice(0); callerTarget.caseLock.runtimeRoles.splice(0);
    callerTarget.unknown.neverEcho = false; callerPeers.target.local = []; delete callerPeers.manager; Reflect.set(reader, 'cashierOrigin', false);
    const result = await pending;
    expect(result).toMatchObject({ operation: 'routine-subscription-delivery-v1', applied: true }); expect(result.target).toEqual(target());
    expect(Object.hasOwn(result.target, 'unknown')).toBe(false); expect(Object.hasOwn(result.target, 'pricingOwner')).toBe(false);
    expect(result.peers).toEqual(expectedPeers); expect(result.appReader).toEqual(f.appReaders);
    for (const table of tables) expect(await f.maintenanceDb.execute(sql.raw(`SELECT * FROM public.${table}`))).toHaveLength(0);
    expect(await f.facts()).toEqual(business);
  }, 90000);

  it('has exact PG16 seven/five columns, fifteen constraints, five indexes and only non-delegable App SELECT/INSERT', async () => {
    expect(await inspectRoutineSubscriptionDeliveryCatalog(f.maintenanceDb, f.target)).toMatchObject({ present: true, ready: true, failures: [],
      binding: { app: f.appRuntime.role, maintenance: f.target.maintenance } });
    let constraints = 0, indexes = 0;
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
      expect(actual.columns).toEqual(ROUTINE_SUBSCRIPTION_DELIVERY_EXPECTED_COLUMNS[table]);
      expect(actual.constraints).toEqual(ROUTINE_SUBSCRIPTION_DELIVERY_EXPECTED_CONSTRAINTS[table]);
      expect(Object.keys(actual.constraints)).toHaveLength(table === 'routine_subscribe_attempt' ? 9 : 6);
      expect(actual.indexes).toBe(table === 'routine_subscribe_attempt' ? 3 : 2); expect(actual.forbidden).toBe(false);
      constraints += Object.keys(actual.constraints).length; indexes += actual.indexes;
      for (const peer of [f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime]) {
        const rights = await f.maintenanceDb.execute<{ privilege: string; allowed: boolean; delegated: boolean }>(sql`
          SELECT p.privilege,pg_catalog.has_table_privilege(${peer.role},${`public.${table}`},p.privilege) AS allowed,
            pg_catalog.has_table_privilege(${peer.role},${`public.${table}`},p.privilege||' WITH GRANT OPTION') AS delegated
          FROM(VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)`);
        expect(rights).toHaveLength(7);
        for (const row of rights) {
          expect(row.allowed).toBe(peer === f.appRuntime && ['SELECT','INSERT'].includes(row.privilege)); expect(row.delegated).toBe(false);
        }
        if (peer === f.appRuntime) await peer.db.execute(sql.raw(`SELECT * FROM public.${table}`));
        else {
          await expect(peer.db.execute(sql.raw(`SELECT * FROM public.${table}`))).rejects.toMatchObject({ cause: { code: '42501' } });
          await expect(peer.db.execute(sql.raw(`INSERT INTO public.${table} DEFAULT VALUES`))).rejects.toMatchObject({ cause: { code: '42501' } });
        }
        for (const command of [`UPDATE public.${table} SET payload=payload`,`DELETE FROM public.${table} WHERE false`,`TRUNCATE public.${table}`])
          await expect(peer.db.execute(sql.raw(command))).rejects.toMatchObject({ cause: { code: '42501' } });
      }
    }
    expect(constraints).toBe(15); expect(indexes).toBe(5);
    expect(ROUTINE_SUBSCRIPTION_DELIVERY_RUNTIME_PRIVILEGES).toEqual({
      app: { routine_subscribe_attempt: ['SELECT','INSERT'], routine_subscribe_result: ['SELECT','INSERT'] },
      admin: { routine_subscribe_attempt: [], routine_subscribe_result: [] },
    });
    for (const peer of [f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime])
      await expect(peer.db.execute(sql`SELECT public.routine_subscribe_immutable_v1()`)).rejects.toMatchObject({ cause: { code: '42501' } });
    // Explicit direct-SQL structure specimens: no matching notification exists,
    // and these raw JSON/signatures are not business attempt/outcome evidence.
    const attempt = randomUUID(), orphan = randomUUID(), result = 'b'.repeat(64), source = 'd'.repeat(64);
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_subscribe_attempt(attempt_id,delivery_id,attempt_no,source_key,payload,created_at,signature)
      VALUES(${attempt}::uuid,900001,1,${source},'{"synthetic":true}',1,${hex})`);
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_subscribe_result(result_id,attempt_id,payload,created_at,signature)
      VALUES(${result},${attempt}::uuid,'{"synthetic":true}',1,${hex})`);
    // There is deliberately no SQL FK: semantic linkage is the service's job.
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_subscribe_result(result_id,attempt_id,payload,created_at,signature)
      VALUES(${'c'.repeat(64)},${orphan}::uuid,'{"synthetic":true}',1,${hex})`);
    for (const [delivery,no,payload,created,signature] of [[0,1,'{}',1,hex],[900002,0,'{}',1,hex],[900002,6,'{}',1,hex],
      [900002,1,'[]',1,hex],[900002,1,JSON.stringify({ tooLarge: 'x'.repeat(65536) }),1,hex],
      [900002,1,'{}',0,hex],[900002,1,'{}',1,'wrong']] as const)
      await expect(f.appRuntime.db.execute(sql`INSERT INTO public.routine_subscribe_attempt(attempt_id,delivery_id,attempt_no,source_key,payload,created_at,signature)
        VALUES(${randomUUID()}::uuid,${delivery},${no},${source},${payload}::jsonb,${created},${signature})`)).rejects.toMatchObject({ cause: { code: '23514' } });
    for (const [id,payload,created,signature] of [['wrong','{}',1,hex],[hex,'[]',1,hex],
      [hex,JSON.stringify({ tooLarge: 'x'.repeat(32768) }),1,hex],[hex,'{}',0,hex],[hex,'{}',1,'wrong']] as const)
      await expect(f.appRuntime.db.execute(sql`INSERT INTO public.routine_subscribe_result(result_id,attempt_id,payload,created_at,signature)
        VALUES(${id},${randomUUID()}::uuid,${payload}::jsonb,${created},${signature})`)).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(f.appRuntime.db.execute(sql`INSERT INTO public.routine_subscribe_attempt(attempt_id,delivery_id,attempt_no,source_key,payload,created_at,signature)
      VALUES(${randomUUID()}::uuid,900002,1,'wrong','{}',1,${hex})`)).rejects.toMatchObject({ cause: { code: '23514' } });
    for (const [id,delivery,no,key] of [[attempt,900002,1,'e'.repeat(64)],[randomUUID(),900001,1,'f'.repeat(64)],
      [randomUUID(),900002,1,source]] as const)
      await expect(f.appRuntime.db.execute(sql`INSERT INTO public.routine_subscribe_attempt(attempt_id,delivery_id,attempt_no,source_key,payload,created_at,signature)
        VALUES(${id}::uuid,${delivery},${no},${key},'{}',1,${hex})`)).rejects.toMatchObject({ cause: { code: '23505' } });
    // Source-key ordinals cannot be reused through a replacement delivery ID;
    // a different ordinal remains valid within the storage-only five-attempt cap.
    await f.appRuntime.db.execute(sql`INSERT INTO public.routine_subscribe_attempt(attempt_id,delivery_id,attempt_no,source_key,payload,created_at,signature)
      VALUES(${randomUUID()}::uuid,900002,5,${source},'{"synthetic":true}',1,${hex})`);
    for (const [id,aid] of [[result,randomUUID()],[hex,attempt]] as const)
      await expect(f.appRuntime.db.execute(sql`INSERT INTO public.routine_subscribe_result(result_id,attempt_id,payload,created_at,signature)
        VALUES(${id},${aid}::uuid,'{}',1,${hex})`)).rejects.toMatchObject({ cause: { code: '23505' } });
    for (const table of tables) for (const command of [`UPDATE public.${table} SET payload=payload`,`DELETE FROM public.${table}`,`TRUNCATE public.${table}`])
      await expect(f.maintenanceDb.execute(sql.raw(command))).rejects.toMatchObject({ cause: { code: '42501' } });
  }, 90000);

  it('repeats without row, xmin, ACL or catalog changes and preserves all five complete runtime profiles', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    const result = await install(); expect(result).toMatchObject({ operation: 'routine-subscription-delivery-v1', applied: false });
    expect(result.target).toEqual(target()); expect(result.peers).toEqual({ ...structuredClone(peers), target: target() }); expect(result.appReader).toEqual(f.appReaders);
    for (const audit of [
      await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, peers, f.appReaders),
      await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, peers),
      await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db, f.target, f.manual, f.readers),
      await auditManagerRuntimePrivileges(f.managerRuntime.db, f.target),
      await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role, f.target,
        { abandon: true, conditionalGuards: true, formImages: true }),
    ]) expect(audit).toMatchObject({ ready: true, failures: [] });
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(business); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('refuses constraints, triggers, source identity, function, ACL, membership and namespace drift without repair', async () => {
    for (const change of [
      (tx: Query) => tx.execute(sql`GRANT SELECT ON public.routine_subscribe_attempt TO ${sql.identifier(lookalike)}`),
      (tx: Query) => tx.execute(sql`GRANT SELECT(payload) ON public.routine_subscribe_result TO ${sql.identifier(f.adminRuntime.role)}`),
      (tx: Query) => tx.execute(sql`GRANT SELECT ON public.routine_subscribe_result TO PUBLIC`),
      (tx: Query) => tx.execute(sql`GRANT INSERT ON public.routine_subscribe_attempt TO ${sql.identifier(f.appRuntime.role)} WITH GRANT OPTION`),
      (tx: Query) => tx.execute(sql`GRANT UPDATE ON public.routine_subscribe_result TO ${sql.identifier(f.appRuntime.role)}`),
      (tx: Query) => tx.execute(sql`GRANT ${sql.identifier(lookalike)} TO ${sql.identifier(f.appRuntime.role)}`),
      (tx: Query) => tx.execute(sql`ALTER ROLE ${sql.identifier(f.appRuntime.role)} NOLOGIN`),
      (tx: Query) => tx.execute(sql`ALTER ROLE ${sql.identifier(f.appRuntime.role)} INHERIT`),
      (tx: Query) => tx.execute(sql`REVOKE SELECT ON public.routine_subscription_account_policy FROM ${sql.identifier(f.appRuntime.role)}`),
      (tx: Query) => tx.execute(sql`REVOKE SELECT ON public.routine_identity_ownership FROM ${sql.identifier(f.appRuntime.role)}`),
      (tx: Query) => tx.execute(sql`REVOKE INSERT ON public.routine_original_payment_evidence FROM ${sql.identifier(f.appRuntime.role)}`),
      (tx: Query) => tx.execute(sql`ALTER FUNCTION public.routine_subscribe_immutable_v1() COST 101`),
      (tx: Query) => tx.execute(sql.raw('CREATE OR REPLACE FUNCTION public.routine_subscribe_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN RETURN OLD; END$$')),
      (tx: Query) => tx.execute(sql`ALTER TABLE public.routine_subscribe_attempt DISABLE TRIGGER rsnd_a_immutable_rows`),
      (tx: Query) => tx.execute(sql`ALTER TABLE public.routine_subscribe_result DISABLE TRIGGER rsnd_r_immutable_truncate`),
      (tx: Query) => tx.execute(sql`ALTER TABLE public.routine_subscribe_attempt DROP CONSTRAINT rsnd_a_payload_ck`),
      (tx: Query) => tx.execute(sql`ALTER TABLE public.routine_subscribe_result DROP CONSTRAINT rsnd_r_attempt_uq`),
      (tx: Query) => tx.execute(sql`ALTER TABLE public.routine_subscribe_result ALTER COLUMN created_at SET DEFAULT 1`),
      (tx: Query) => tx.execute(sql`CREATE TABLE public.routine_subscribe_child() INHERITS(public.routine_subscribe_attempt)`),
      (tx: Query) => tx.execute(sql`ALTER TABLE public.routine_subscribe_result ADD CONSTRAINT rsnd_foreign
        FOREIGN KEY(attempt_id) REFERENCES public.routine_subscribe_attempt(attempt_id) NOT VALID`),
      (tx: Query) => tx.execute(sql`CREATE INDEX rsnd_unknown_idx ON public.routine_subscribe_attempt(created_at)`),
      (tx: Query) => tx.execute(sql`CREATE TYPE public.routine_subscribe_orphan AS ENUM('metadata')`),
      (tx: Query) => tx.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${sql.identifier(f.appRuntime.role)}`),
    ]) await refusedWithoutRepair(change);
  }, 90000);

  it('enforces try-only fresh gates and NOWAIT table locks while durable reads avoid the gate and reject context or TEMP shadow', async () => {
    const before = await snapshot(f.maintenanceDb);
    await hold(tx => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731726,0)`), async () => {
      await expect(f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadyTx(tx))).rejects.toMatchObject({ code: 503 });
      expect(await f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadTx(tx))).toBe(true);
      expect(await f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadTx(tx), { isolationLevel: 'repeatable read', accessMode: 'read only' })).toBe(true);
    });
    await hold(tx => tx.execute(sql`LOCK TABLE ONLY public.routine_subscribe_result IN ACCESS EXCLUSIVE MODE NOWAIT`), async () => {
      await expect(install()).rejects.toThrow();
    });
    expect((await install()).applied).toBe(false);
    await expect(f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadyTx(tx), { isolationLevel: 'repeatable read', accessMode: 'read only' })).rejects.toMatchObject({ code: 503 });
    await expect(f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadTx(tx), { isolationLevel: 'read committed', accessMode: 'read only' })).rejects.toMatchObject({ code: 503 });
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`); await assertRoutineSubscriptionDeliveryReadTx(tx);
    })).rejects.toMatchObject({ code: 503 });
    // TEMP is granted only for this owned negative fixture. A public-only
    // explicit path retains public as current_schema but searches temp heaps
    // first; the runtime must reject the real shadow, not a mocked catalog.
    await f.maintenanceDb.execute(sql`GRANT TEMPORARY ON DATABASE ${sql.identifier(f.target.database)} TO ${sql.identifier(f.appRuntime.role)}`);
    try {
      for (const table of [...tables,...sourceTables])
        await expect(f.appRuntime.db.transaction(async tx => {
          await tx.execute(sql.raw(`CREATE TEMP TABLE ${table}(id integer) ON COMMIT DROP`));
          await tx.execute(sql`SET LOCAL search_path=public`);
          await assertRoutineSubscriptionDeliveryReadTx(tx);
        })).rejects.toMatchObject({ code: 503 });
    } finally {
      await f.maintenanceDb.execute(sql`REVOKE TEMPORARY ON DATABASE ${sql.identifier(f.target.database)} FROM ${sql.identifier(f.appRuntime.role)}`);
    }
    for (const peer of [f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime])
      await expect(peer.db.transaction(tx => assertRoutineSubscriptionDeliveryReadTx(tx))).rejects.toMatchObject({ code: 503 });
    await expect(f.maintenanceDb.transaction(tx => assertRoutineSubscriptionDeliveryReadyTx(tx))).rejects.toMatchObject({ code: 503 });
    await expect(assertRoutineSubscriptionDeliveryReadTx(f.appRuntime.db)).rejects.toMatchObject({ code: 503 });
    await expect(f.appRuntime.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SELECT pg_catalog.pg_sleep(5.05)`);
      await assertRoutineSubscriptionDeliveryReadTx(tx);
    })).rejects.toMatchObject({ code: 503 });
    // Maintenance performs complete before/after profile audits, so its
    // established bounds apply to each statement/idle/lock, not total age.
    // Runtime above still refuses this actual five-second-old transaction.
    await f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SELECT pg_catalog.pg_sleep(5.05)`);
      expect((await installRoutineSubscriptionDeliveryUpgradeInTransaction(tx, f.target, peers, f.appReaders)).applied).toBe(false);
      const [limits] = await tx.execute<{ statement: number; idle: number; lock: number; older: boolean }>(sql`SELECT
        (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS statement,
        (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle,
        (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS lock,
        pg_catalog.clock_timestamp()>pg_catalog.transaction_timestamp()+interval '5 seconds' AS older`);
      expect(limits).toEqual({ statement: 5000, idle: 5000, lock: 1000, older: true });
    });
    expect(await f.appRuntime.db.transaction(tx => assertRoutineSubscriptionDeliveryReadyTx(tx))).toBe(true);
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(network).not.toHaveBeenCalled();
  }, 90000);
});
