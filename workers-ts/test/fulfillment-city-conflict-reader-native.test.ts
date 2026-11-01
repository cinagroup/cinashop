/** Owned PG16 commissioning and a fixed conflict reader, not a city provider
 * acceptance or shipping proof. Conflict specimens are explicitly maintenance
 * rows; the root is produced by the real assisted checkout. No runtime table
 * grant, fake paid fact or provider result is used to reach the reader. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import {
  captureFulfillmentCityConflictReadersAddon, FULFILLMENT_CITY_CONFLICT_FUNCTION,
  FULFILLMENT_CITY_CONFLICT_GATE, inspectFulfillmentCityConflictReader,
  resolveFulfillmentCityConflictReaderBinding, type FulfillmentCityConflictReadersAddon,
} from '@/migrations/fulfillmentCityConflictReader';
import { upgradeFulfillmentCityConflictReaders, upgradeFulfillmentCityConflictReadersInTransaction } from '@/migrations/upgradeFulfillmentCityConflictReaders';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Query = Pick<DbClient, 'execute'>;
type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
const cityTables = ['customer_city_delivery_job', 'customer_city_delivery_attempt', 'customer_city_delivery_binding'];
const hex = 'a'.repeat(64);
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('formal city fulfillment conflict reader', () => {
  let f: Fixture, peers: RuntimeGiftPeerDeclarations, owner: string, other: string, rootId: number;
  let transport: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const readers = (manager = false): FulfillmentCityConflictReadersAddon => ({ owner, app: true, admin: true, ...(manager ? { manager: true as const } : {}) });
  const desired = (r = readers()): RuntimeGiftPeerDeclarations => ({ ...peers, cityConflictReaders: { ...r } });
  const named = () => ({ maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
  const target = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin,
    ...(f.target.local ? { local: [...f.target.local] } : {}),
    ...(f.target.caseLock ? { caseLock: { owner: f.target.caseLock.owner, runtimeRoles: [...f.target.caseLock.runtimeRoles] } } : {}) });
  async function snapshot(db: Query) {
    const [row] = await db.execute<{ value: unknown }>(sql`SELECT pg_catalog.jsonb_build_object(
      'relations',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl::text,c.reloptions) ORDER BY c.oid)
        FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace),
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attacl::text,a.attisdropped) ORDER BY a.attrelid,a.attnum)
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0),
      'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.oid::text,p.proname,p.proowner::text,p.proacl::text,
        pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))) ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind<>'a'),
      'defaults',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid) FROM pg_catalog.pg_default_acl d),
      'owner',(SELECT pg_catalog.to_jsonb(r) FROM pg_catalog.pg_roles r WHERE r.rolname=${owner}),
      'job',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.customer_city_delivery_job t),
      'attempt',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.customer_city_delivery_attempt t),
      'binding',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(t),t.xmin::text) ORDER BY job_id) FROM public.customer_city_delivery_binding t),
      'delivery',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.store_delivery_order t)
    ) AS value`);
    return row.value;
  }
  async function hold(lock: (tx: Query) => Promise<unknown>, work: () => Promise<void>) {
    await f.withMaintenancePeer(async peer => {
      let ready!: () => void, release!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
      const held = peer.transaction(async tx => { await lock(tx); ready(); await released; });
      try { await Promise.race([acquired, held.then(() => { throw Error('Owned holder exited before release'); })]); await work(); }
      finally { release(); await held; }
    });
  }
  async function call(tx: Query, root = rootId) {
    const [row] = await tx.execute<{ clear: boolean }>(sql`SELECT public.fulfillment_city_conflict_v1(${root}) AS clear`);
    return row.clear;
  }
  async function lockedCall(db: DbClient, root = rootId) {
    return db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`);
      await tx.execute(sql`SET LOCAL lock_timeout='1000ms'`);
      await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(63842,${root})`);
      return call(tx, root);
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
  }
  async function refusedWithoutRepair(change: (tx: Query) => Promise<unknown>, wanted = readers(true)) {
    const before = await snapshot(f.maintenanceDb);
    await expect(f.maintenanceDb.transaction(async tx => {
      await change(tx); const changed = await snapshot(tx);
      await expect(tx.transaction(inner => upgradeFulfillmentCityConflictReadersInTransaction(inner, f.target,
        { readers: wanted }, desired(wanted), f.appReaders))).rejects.toThrow();
      expect(await snapshot(tx)).toEqual(changed);
      throw Error('owned city drift rollback');
    })).rejects.toThrow('owned city drift rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  }
  beforeAll(async () => {
    transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No city/provider transport in formal reader acceptance'));
    f = await customerCashierRuntimeHttpFixture(); peers = f.peers;
    owner = (await f.createOwnedRole('cityreader')).role; other = (await f.createOwnedRole('cityother')).role;
    rootId = (await f.unpaid(11, '7.00', 1)).order.id;
  }, 180000);
  afterAll(async () => { try { if (f) await f.close(); } finally { transport?.mockRestore(); } }, 30000);

  it('strictly captures primitive declarations and separates fresh owner from absent capability', async () => {
    const before = await snapshot(f.maintenanceDb);
    let getters = 0;
    for (const input of [{ owner }, { owner, app: false }, { owner, cashier: true }, { owner, app: true, unknown: 1 },
      { get owner() { getters++; return owner; }, app: true }])
      expect(() => captureFulfillmentCityConflictReadersAddon(input as FulfillmentCityConflictReadersAddon)).toThrow();
    expect(getters).toBe(0);
    const state = await inspectFulfillmentCityConflictReader(f.maintenanceDb, named());
    expect(state).toMatchObject({ present: false, ready: false, cityPresent: true, binding: null, functionOid: null });
    expect(await resolveFulfillmentCityConflictReaderBinding(f.maintenanceDb, named(), readers())).toMatchObject({ ownerState: 'fresh',
      binding: { owner, database: f.database, app: f.appRuntime.role, admin: f.adminRuntime.role, manager: f.managerRuntime.role, actors: { app: true, admin: true } } });
    await expect(upgradeFulfillmentCityConflictReaders(f.maintenanceDb, f.target, { readers: readers() }, peers, f.appReaders)).rejects.toThrow();
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('rolls a complete five-role forward back with its caller without changing data or ACLs', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts();
    await expect(f.maintenanceDb.transaction(async tx => {
      const result = await upgradeFulfillmentCityConflictReadersInTransaction(tx, f.target, { readers: readers(true) }, desired(readers(true)), f.appReaders);
      expect(result.applied).toBe(true);
      expect(await inspectFulfillmentCityConflictReader(tx, named())).toMatchObject({ present: true, ready: true,
        binding: { owner, actors: { app: true, admin: true, manager: true } } });
      throw Error('owned city forward rollback');
    })).rejects.toThrow('owned city forward rollback');
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(await f.facts()).toEqual(business);
  }, 90000);

  it.each([
    ['orphan namespace', (tx: Query) => tx.execute(sql`CREATE TABLE public.fulfillment_city_conflict_orphan(id integer)`)],
    ['partial function', (tx: Query) => tx.execute(sql`CREATE FUNCTION public.fulfillment_city_conflict_v1(p_root_id integer) RETURNS boolean LANGUAGE sql AS 'SELECT true'`)],
    ['source column', (tx: Query) => tx.execute(sql`ALTER TABLE public.customer_city_delivery_job ADD COLUMN unexpected integer`)],
    ['owner whole-job SELECT', (tx: Query) => tx.execute(sql`GRANT SELECT ON public.customer_city_delivery_job TO ${sql.identifier(owner)}`)],
    ['owner attempt SELECT', (tx: Query) => tx.execute(sql`GRANT SELECT ON public.customer_city_delivery_attempt TO ${sql.identifier(owner)}`)],
  ] as const)('rejects fresh %s drift without repair', async (_label, change) => {
    await refusedWithoutRepair(change);
  });

  it('requires real maintenance LOGIN and try-only resources, then commissions App and Admin only', async () => {
    const before = await snapshot(f.maintenanceDb);
    const attempt = () => upgradeFulfillmentCityConflictReaders(f.maintenanceDb, f.target, { readers: readers() }, desired(), f.appReaders);
    for (const peer of [f.appRuntime, f.adminRuntime, f.managerRuntime, f.financialRuntime, f.cashierRuntime])
      await expect(upgradeFulfillmentCityConflictReaders(peer.db, f.target, { readers: readers() }, desired(), f.appReaders)).rejects.toThrow();
    await expect(upgradeFulfillmentCityConflictReaders(f.maintenanceDb, { ...f.target, database: 'wrong_city_database' }, { readers: readers() }, desired(), f.appReaders)).rejects.toThrow();
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`);
      await upgradeFulfillmentCityConflictReadersInTransaction(tx, f.target, { readers: readers() }, desired(), f.appReaders);
    })).rejects.toThrow();
    await hold(tx => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${FULFILLMENT_CITY_CONFLICT_GATE[0]},${FULFILLMENT_CITY_CONFLICT_GATE[1]})`), async () => { await expect(attempt()).rejects.toThrow(); });
    await hold(tx => tx.execute(sql`LOCK TABLE ONLY public.store_delivery_order IN ACCESS EXCLUSIVE MODE NOWAIT`), async () => { await expect(attempt()).rejects.toThrow(); });
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
    const result = await attempt(); expect(result.applied).toBe(true); peers = result.peers;
    expect(await inspectFulfillmentCityConflictReader(f.maintenanceDb)).toMatchObject({ ready: true, binding: { owner, actors: { app: true, admin: true } } });
    expect((await resolveFulfillmentCityConflictReaderBinding(f.maintenanceDb, named(), readers())).ownerState).toBe('installed');
  }, 90000);

  it('uses actual App/Admin EXECUTE without raw city SELECT and enforces root lock, contexts and conflict states', async () => {
    const [ownerPrivileges] = await f.maintenanceDb.execute<{ exact: boolean }>(sql`SELECT
      NOT r.rolcanlogin AND NOT(r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND pg_catalog.has_column_privilege(r.oid,'public.customer_city_delivery_job','id','SELECT')
      AND pg_catalog.has_column_privilege(r.oid,'public.customer_city_delivery_job','root_order_id','SELECT')
      AND pg_catalog.has_column_privilege(r.oid,'public.customer_city_delivery_job','status','SELECT')
      AND NOT pg_catalog.has_column_privilege(r.oid,'public.customer_city_delivery_job','intent','SELECT')
      AND pg_catalog.has_column_privilege(r.oid,'public.customer_city_delivery_binding','job_id','SELECT')
      AND pg_catalog.has_column_privilege(r.oid,'public.customer_city_delivery_binding','active','SELECT')
      AND NOT pg_catalog.has_table_privilege(r.oid,'public.customer_city_delivery_job','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_table_privilege(r.oid,'public.customer_city_delivery_binding','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_table_privilege(r.oid,'public.customer_city_delivery_attempt','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND pg_catalog.has_table_privilege(r.oid,'public.store_delivery_order','UPDATE')
      AND NOT pg_catalog.has_table_privilege(r.oid,'public.store_delivery_order','SELECT,INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_sequence_privilege(r.oid,'public.customer_city_delivery_job_id_seq','USAGE,SELECT,UPDATE') AS exact
      FROM pg_catalog.pg_roles r WHERE r.rolname=${owner}`);
    expect(ownerPrivileges.exact).toBe(true);
    for (const peer of [f.appRuntime, f.adminRuntime]) {
      await expect(peer.db.transaction(tx => call(tx))).rejects.toMatchObject({ cause: { code: 'P2131' } });
      expect(await lockedCall(peer.db)).toBe(true);
      for (const table of cityTables) await expect(peer.db.execute(sql.raw(`SELECT * FROM public.${table} LIMIT 0`))).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(peer.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`); await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(63842,${rootId})`); await call(tx);
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' })).rejects.toMatchObject({ cause: { code: 'P2131' } });
    }
    for (const db of [f.maintenanceDb, f.managerRuntime.db, f.financialRuntime.db, f.cashierRuntime.db]) await expect(lockedCall(db)).rejects.toThrow();
    await expect(f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.appRuntime.role)}`);
      await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`); await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(63842,${rootId})`); await call(tx);
    })).rejects.toMatchObject({ cause: { code: 'P2131' } });
    const key = randomUUID();
    const [job] = await f.maintenanceDb.execute<{ id: string }>(sql`INSERT INTO public.customer_city_delivery_job
      (actor_uid,service_id,actor_auth_version,actor_expires_at,scope_key,request_key,request_hash,intent_hash,requested_order_id,root_order_id,order_id,customer_uid,store_id,supplier_id,provider,provider_order_id,intent,status,add_time,update_time)
      VALUES(101,1,${'a'.repeat(32)},2147483647,${hex},${key},${hex},${hex},${rootId},${rootId},${rootId},11,1,0,'dada',${'reader_' + key.slice(0, 8)},'{"specimen":"conflict-reader-only"}','PENDING',1,1) RETURNING id::text AS id`);
    try {
      for (const status of ['PENDING', 'PROCESSING', 'UNKNOWN']) {
        await f.maintenanceDb.execute(sql`UPDATE public.customer_city_delivery_job SET status=${status} WHERE id=${job.id}::bigint`);
        for (const db of [f.appRuntime.db, f.adminRuntime.db]) await expect(lockedCall(db)).rejects.toMatchObject({ cause: { code: 'P2131' } });
      }
      await f.maintenanceDb.execute(sql`UPDATE public.customer_city_delivery_job SET status='REJECTED' WHERE id=${job.id}::bigint`);
      expect(await lockedCall(f.appRuntime.db)).toBe(true);
      const [attempt] = await f.maintenanceDb.execute<{ id: string }>(sql`INSERT INTO public.customer_city_delivery_attempt(job_id,request_key,phase,started_time,update_time)
        VALUES(${job.id}::bigint,${randomUUID()},'QUOTED',1,1) RETURNING id::text AS id`);
      await f.maintenanceDb.execute(sql`INSERT INTO public.customer_city_delivery_binding(job_id,attempt_id,delivery_order_id,order_id,root_order_id,customer_uid,store_id,supplier_id,provider,provider_order_id,active,add_time,update_time)
        VALUES(${job.id}::bigint,${attempt.id}::bigint,1,${rootId},${rootId},11,1,0,'dada',${'reader_' + key.slice(0, 8)},1,1,1)`);
      await f.maintenanceDb.execute(sql`UPDATE public.customer_city_delivery_job SET status='ADMITTED' WHERE id=${job.id}::bigint`);
      await expect(lockedCall(f.adminRuntime.db)).rejects.toMatchObject({ cause: { code: 'P2131' } });
      await f.maintenanceDb.execute(sql`UPDATE public.customer_city_delivery_binding SET active=0 WHERE job_id=${job.id}::bigint`);
      expect(await lockedCall(f.adminRuntime.db)).toBe(true);
    } finally {
      await f.maintenanceDb.execute(sql`DELETE FROM public.customer_city_delivery_binding WHERE job_id=${job.id}::bigint`);
      await f.maintenanceDb.execute(sql`DELETE FROM public.customer_city_delivery_attempt WHERE job_id=${job.id}::bigint`);
      await f.maintenanceDb.execute(sql`DELETE FROM public.customer_city_delivery_job WHERE id=${job.id}::bigint`);
    }
  });

  it('refuses a table-first city peer NOWAIT and a busy maintenance gate without retaining the root lock', async () => {
    const before = await snapshot(f.maintenanceDb);
    await hold(tx => tx.execute(sql`LOCK TABLE ONLY public.store_delivery_order IN SHARE ROW EXCLUSIVE MODE NOWAIT`), async () => {
      await expect(lockedCall(f.appRuntime.db)).rejects.toMatchObject({ cause: { code: 'P2132' } });
      await f.withMaintenancePeer(async peer => {
        const [row] = await peer.execute<{ acquired: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(63842,${rootId}) AS acquired`);
        expect(row.acquired).toBe(true);
      });
    });
    await hold(tx => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${FULFILLMENT_CITY_CONFLICT_GATE[0]},${FULFILLMENT_CITY_CONFLICT_GATE[1]})`), async () => {
      await expect(lockedCall(f.adminRuntime.db)).rejects.toMatchObject({ cause: { code: 'P2132' } });
    });
    expect(await lockedCall(f.appRuntime.db)).toBe(true); expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('forwards explicitly to Manager, snapshots inputs before await and preserves exact repeat and all five profiles', async () => {
    const before = await snapshot(f.maintenanceDb), business = await f.facts(), old = await inspectFulfillmentCityConflictReader(f.maintenanceDb);
    const input = { readers: readers(true), previousReaders: readers() }, callerTarget = { ...target(), unknown: 'never echoed' };
    const callerPeers = structuredClone(desired(readers(true))), expectedPeers = structuredClone(callerPeers), appReader = structuredClone(f.appReaders);
    const pending = upgradeFulfillmentCityConflictReaders(f.maintenanceDb, callerTarget, input, callerPeers, appReader);
    callerTarget.database = 'mutated_after_call'; delete input.readers.manager; input.readers.owner = other;
    callerPeers.target.local = []; delete callerPeers.cityConflictReaders; Reflect.set(appReader, 'cashierOrigin', false);
    const result = await pending; expect(result.applied).toBe(true); expect(result.target).toEqual(target());
    expect(Object.hasOwn(result.target, 'unknown')).toBe(false); expect(result.peers).toEqual(expectedPeers); peers = result.peers;
    const installed = await inspectFulfillmentCityConflictReader(f.maintenanceDb);
    expect(installed).toMatchObject({ ready: true, functionOid: old.functionOid, binding: { owner, actors: { app: true, admin: true, manager: true } } });
    expect(await lockedCall(f.managerRuntime.db)).toBe(true);
    for (const table of cityTables) await expect(f.managerRuntime.db.execute(sql.raw(`SELECT * FROM public.${table} LIMIT 0`))).rejects.toMatchObject({ cause: { code: '42501' } });
    const committed = await snapshot(f.maintenanceDb);
    expect((await upgradeFulfillmentCityConflictReaders(f.maintenanceDb, f.target, { readers: readers(true) }, peers, f.appReaders)).applied).toBe(false);
    expect(await snapshot(f.maintenanceDb)).toEqual(committed);
    for (const audit of [
      await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, peers, f.appReaders),
      await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, peers),
      await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db, f.target, f.manual, f.readers),
      await auditManagerRuntimePrivileges(f.managerRuntime.db, f.target, undefined, readers(true)),
      await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role, f.target, { abandon: true, conditionalGuards: true, formImages: true }),
    ]) expect(audit).toMatchObject({ ready: true, failures: [] });
    expect(await f.facts()).toEqual(business);
    expect((before as { job: unknown }).job).toEqual((committed as { job: unknown }).job);
  }, 90000);

  it.each([
    ['function flags', (tx: Query) => tx.execute(sql`ALTER FUNCTION public.fulfillment_city_conflict_v1(integer) COST 101`)],
    ['Cashier EXECUTE', (tx: Query) => tx.execute(sql`GRANT EXECUTE ON FUNCTION public.fulfillment_city_conflict_v1(integer) TO ${sql.identifier(f.cashierRuntime.role)}`)],
    ['owner attempt column SELECT', (tx: Query) => tx.execute(sql`GRANT SELECT(id) ON public.customer_city_delivery_attempt TO ${sql.identifier(owner)}`)],
    ['owner role attributes', (tx: Query) => tx.execute(sql`ALTER ROLE ${sql.identifier(owner)} INHERIT`)],
    ['source owner', (tx: Query) => tx.execute(sql`ALTER TABLE public.customer_city_delivery_job OWNER TO ${sql.identifier(other)}`)],
  ] as const)('rejects installed %s drift without repair', async (_label, change) => {
    await refusedWithoutRepair(change);
  });

  it('rejects actor removal or owner replacement without changing the installed addon', async () => {
    const before = await snapshot(f.maintenanceDb);
    await expect(upgradeFulfillmentCityConflictReaders(f.maintenanceDb, f.target, { readers: readers(), previousReaders: readers(true) }, desired(), f.appReaders)).rejects.toThrow();
    await expect(resolveFulfillmentCityConflictReaderBinding(f.maintenanceDb, named(), { ...readers(true), owner: other })).rejects.toThrow();
    expect(await snapshot(f.maintenanceDb)).toEqual(before);
  });

  it('keeps metadata proof independent of search_path and ignores TEMP catalog/source shadows', async () => {
    const before = await snapshot(f.maintenanceDb), expected = await inspectFulfillmentCityConflictReader(f.maintenanceDb);
    // This is a metadata leaf, also used by maintenance auditors. TEMP objects
    // belong to maintenance here; creating them as App would independently
    // violate the existing App no-owned-object principal contract.
    await f.maintenanceDb.transaction(async tx => {
      await tx.execute(sql`CREATE TEMP TABLE pg_proc(fake integer) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE pg_roles(fake integer) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE customer_city_delivery_job(id bigint,root_order_id integer,status text) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO pg_temp.customer_city_delivery_job VALUES(1,${rootId},'UNKNOWN')`);
      await tx.execute(sql`SET LOCAL search_path=pg_temp,pg_catalog`);
      expect(await inspectFulfillmentCityConflictReader(tx)).toEqual(expected);
    });
    expect(await snapshot(f.maintenanceDb)).toEqual(before); expect(transport).not.toHaveBeenCalled();
    expect(FULFILLMENT_CITY_CONFLICT_FUNCTION).toBe('fulfillment_city_conflict_v1');
  });
});
