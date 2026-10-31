/** Owned PG16 maintenance and real restricted LOGIN acceptance only. The
 * synthetic JSON exercises storage/checks only: no account is approved and no
 * credential, historical ownership or provider evidence is authenticated. */
import { randomUUID } from 'node:crypto';
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
import { ROUTINE_PAYMENT_ACCOUNT_POLICY_SQL, ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE,
  ROUTINE_PAYMENT_ACCOUNT_POLICY_EXPECTED_CONSTRAINTS, assertRoutinePaymentAccountPolicyReady,
  assertRoutinePaymentAccountPolicyReadInTx, inspectRoutinePaymentAccountPolicyCatalog, assertRoutinePaymentAccountPolicyInstalledTx } from '@/migrations/routinePaymentAccountPolicy';
import { runRoutinePaymentAccountPolicyUpgrade, installRoutinePaymentAccountPolicyUpgradeInTransaction,
  ROUTINE_PAYMENT_ACCOUNT_POLICY_UPGRADE } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
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
  const [presence] = await db.execute<{ policy: boolean; uses: boolean }>(sql`SELECT
    to_regclass('public.routine_payment_account_policy') IS NOT NULL AS policy,
    to_regclass('public.routine_payment_account_use') IS NOT NULL AS uses`);
  const policy = presence.policy ? Array.from(await db.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version
    FROM public.routine_payment_account_policy t ORDER BY record_id`)) : null;
  const uses = presence.uses ? Array.from(await db.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version
    FROM public.routine_payment_account_use t ORDER BY use_id`)) : null;
  return { metadata: metadata.value, policy, uses };
}

async function audits(c: Context) {
  for (const [peer, kind] of [[c.app, 'app'], [c.admin, 'admin']] as const)
    expect(await auditRuntimeBusinessPrivileges(peer.db, kind, c.target)).toMatchObject({ ready: true, failures: [] });
}


type PolicyRow = { id:string;kind:string;subject:string;revision:number;payload:unknown;created:number;signature:string };
const policy=(patch:Partial<PolicyRow>={}):PolicyRow=>({id:randomUUID(),kind:'account',subject:'fixture_account',revision:1,
  payload:{synthetic:true},created:1,signature:'a'.repeat(64),...patch});
const insertPolicy=(db:Query,row=policy())=>db.execute(sql`INSERT INTO public.routine_payment_account_policy
  (record_id,kind,subject_id,revision,payload,created_at,signature)
  VALUES(${row.id}::uuid,${row.kind},${row.subject},${row.revision},${JSON.stringify(row.payload)}::text::jsonb,${row.created},${row.signature}) RETURNING record_id`);
type UseRow={id:string;evidence:string;payload:unknown;created:number;signature:string};
const use=(patch:Partial<UseRow>={}):UseRow=>({id:'b'.repeat(64),evidence:'c'.repeat(64),payload:{synthetic:true},created:1,signature:'d'.repeat(64),...patch});
const insertUse=(db:Query,row=use())=>db.execute(sql`INSERT INTO public.routine_payment_account_use
  (use_id,evidence_id,payload,created_at,signature) VALUES(${row.id},${row.evidence},${JSON.stringify(row.payload)}::text::jsonb,${row.created},${row.signature}) RETURNING use_id`);
const ready=async(db:Query,target?:RoutinePaymentRuntimeTarget)=>(await inspectRoutinePaymentAccountPolicyCatalog(db,target)).ready;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine payment account policy formal PG16 addon',()=>{
  afterEach(()=>vi.restoreAllMocks());

  it('installs exact empty storage with canonical constraints, indexes and ACLs and repeats without changing rows or catalog',async()=>fixture(async c=>{
    const before=await snapshot(c.f.db);
    await expect(c.app.db.transaction(tx=>assertRoutinePaymentAccountPolicyInstalledTx(tx))).resolves.toBe(false);
    await expect(c.app.db.transaction(tx=>assertRoutinePaymentAccountPolicyReadInTx(tx))).resolves.toBe(false);
    expect(await inspectRoutinePaymentAccountPolicyCatalog(c.f.db,c.target)).toEqual({present:false,ready:false,binding:null,failures:[]});
    await audits(c);
    const installed=await runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target);
    expect(installed).toEqual({operation:ROUTINE_PAYMENT_ACCOUNT_POLICY_UPGRADE,applied:true});
    expect(await inspectRoutinePaymentAccountPolicyCatalog(c.f.db,c.target)).toMatchObject({present:true,ready:true,failures:[],
      binding:{maintenance:c.target.maintenance,app:c.app.role,admin:c.admin.role}});
    expect(await c.app.exec('SELECT * FROM public.routine_payment_account_policy')).toEqual([]);
    expect(await c.app.exec('SELECT * FROM public.routine_payment_account_use')).toEqual([]);
    for(const table of ['routine_payment_account_policy','routine_payment_account_use']){
      const definitions=await c.f.db.execute<{name:string;definition:string}>(sql`SELECT conname AS name,pg_get_constraintdef(oid,false) AS definition
        FROM pg_catalog.pg_constraint WHERE conrelid=to_regclass(${`public.${table}`}) ORDER BY conname`);
      expect(Object.fromEntries(definitions.map(r=>[r.name,r.definition]))).toEqual(ROUTINE_PAYMENT_ACCOUNT_POLICY_EXPECTED_CONSTRAINTS[table]);
      expect(definitions).toHaveLength(table.endsWith('policy')?8:6);
      const [grants]=await c.f.db.execute(sql`SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable)
        ORDER BY a.privilege_type) AS grants FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
        WHERE c.oid=to_regclass(${`public.${table}`}) AND a.grantee<>c.relowner`);
      expect(grants.grants).toEqual(table.endsWith('policy')?[[c.app.role,'SELECT',false]]:[[c.app.role,'INSERT',false],[c.app.role,'SELECT',false]]);
    }
    const indexes=await c.f.db.execute(sql`SELECT c.relname AS name,pg_get_indexdef(c.oid) AS definition FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid WHERE i.indrelid IN
      ('public.routine_payment_account_policy'::regclass,'public.routine_payment_account_use'::regclass) ORDER BY c.relname`);
    expect(Array.from(indexes)).toEqual([
      {name:'rpap_pk',definition:'CREATE UNIQUE INDEX rpap_pk ON public.routine_payment_account_policy USING btree (record_id)'},
      {name:'rpap_revision_uq',definition:'CREATE UNIQUE INDEX rpap_revision_uq ON public.routine_payment_account_policy USING btree (kind, subject_id, revision)'},
      {name:'rpau_evidence_idx',definition:'CREATE INDEX rpau_evidence_idx ON public.routine_payment_account_use USING btree (evidence_id, use_id)'},
      {name:'rpau_pk',definition:'CREATE UNIQUE INDEX rpau_pk ON public.routine_payment_account_use USING btree (use_id)'},
    ]);
    await c.app.db.transaction(tx=>assertRoutinePaymentAccountPolicyReady(tx));
    await expect(c.app.db.transaction(tx=>assertRoutinePaymentAccountPolicyReadInTx(tx))).resolves.toBe(true);
    for(const wrong of [c.f.db,c.admin.db]) await expect(wrong.transaction(tx=>assertRoutinePaymentAccountPolicyInstalledTx(tx))).rejects.toMatchObject({code:503});
    await insertPolicy(c.f.db);await insertUse(c.app.db);
    const after=await snapshot(c.f.db);
    expect(after.metadata).toMatchObject(Object.fromEntries(Object.entries(before.metadata as Record<string,unknown>)
      .filter(([key])=>['bindings','users','config','store_orders','recharges','other_orders'].includes(key))));
    expect(await runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target)).toEqual({...installed,applied:false});
    expect(await snapshot(c.f.db)).toEqual(after);await audits(c);
  }),180000);

  it('rolls both tables, grants and synthetic rows back with the caller maintenance transaction',async()=>fixture(async c=>{
    const before=await snapshot(c.f.db),abort=Error('Owned policy transaction rollback');
    await expect(c.f.db.transaction(async tx=>{
      expect(await installRoutinePaymentAccountPolicyUpgradeInTransaction(tx,c.target)).toMatchObject({applied:true});
      expect(await ready(tx,c.target)).toBe(true);await insertPolicy(tx);await insertUse(tx);throw abort;
    },{isolationLevel:'read committed',accessMode:'read write'})).rejects.toBe(abort);
    expect(await snapshot(c.f.db)).toEqual(before);await audits(c);
  }),180000);

  it('refuses owner-only, one-table and orphan namespaces without completing or repairing them',async()=>fixture(async c=>{
    const clean=await snapshot(c.f.db);
    for(const ddl of [ROUTINE_PAYMENT_ACCOUNT_POLICY_SQL,
      'CREATE TABLE public.routine_payment_account_policy(record_id uuid)',
      'CREATE FUNCTION public.rpap_orphan_v1() RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$BEGIN RETURN; END$$']){
      const abort=Error('Owned partial policy rollback');
      await expect(c.f.db.transaction(async tx=>{
        await tx.execute(sql.raw(ddl));expect(await ready(tx,c.target)).toBe(false);
        await expect(assertRoutinePaymentAccountPolicyInstalledTx(tx)).rejects.toMatchObject({code:503});
        await expect(assertRoutinePaymentAccountPolicyReadInTx(tx)).rejects.toMatchObject({code:503});
        const before=await snapshot(tx);
        await expect(installRoutinePaymentAccountPolicyUpgradeInTransaction(tx,c.target)).rejects.toThrow('Partial or drifted');
        expect(await snapshot(tx)).toEqual(before);throw abort;
      },{isolationLevel:'read committed',accessMode:'read write'})).rejects.toBe(abort);
      expect(await snapshot(c.f.db)).toEqual(clean);
    }
    expect(await runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target)).toMatchObject({applied:true});await audits(c);
  }),180000);

  it('refuses policy INSERT grants, column ACL, shared function-body and index drift without repair',async()=>fixture(async c=>{
    await runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target);await insertPolicy(c.f.db);await insertUse(c.app.db);
    const clean=await snapshot(c.f.db);
    for(const ddl of [
      `GRANT INSERT ON public.routine_payment_account_policy TO ${pricingIdentifier(c.app.role)}`,
      `GRANT UPDATE(payload) ON public.routine_payment_account_use TO ${pricingIdentifier(c.app.role)}`,
      `CREATE OR REPLACE FUNCTION public.routine_payment_account_immutable_v1() RETURNS trigger
        LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN RETURN OLD; END$$`,
      'ALTER INDEX public.rpau_evidence_idx RENAME TO rpau_unreviewed_index',
      'ALTER TABLE public.routine_payment_account_policy ADD COLUMN unreviewed integer',
    ]){
      const abort=Error('Owned policy drift rollback');
      await expect(c.f.db.transaction(async tx=>{
        await tx.execute(sql.raw(ddl));expect(await ready(tx,c.target)).toBe(false);const before=await snapshot(tx);
        await expect(installRoutinePaymentAccountPolicyUpgradeInTransaction(tx,c.target)).rejects.toThrow('Partial or drifted');
        expect(await snapshot(tx)).toEqual(before);throw abort;
      },{isolationLevel:'read committed',accessMode:'read write'})).rejects.toBe(abort);
      expect(await snapshot(c.f.db)).toEqual(clean);
    }
    expect(await runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target)).toMatchObject({applied:false});await audits(c);
  }),180000);

  it('fences fresh authorization with its gate while durable reads take no gate and table locks remain NOWAIT',async()=>fixture(async c=>{
    const before=await snapshot(c.f.db),[key,subkey]=ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE;
    if(!c.f.withPeer)throw Error('Independent maintenance peer required');
    await c.f.withPeer(peer=>peer.db.transaction(async tx=>{
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey})`);
      await expect(runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target)).rejects.toThrow('commissioning is busy');
      expect(await snapshot(c.f.db)).toEqual(before);
    }));
    expect(await runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target)).toMatchObject({applied:true});
    const installed=await snapshot(c.f.db);
    await c.f.withPeer(peer=>peer.db.transaction(async tx=>{
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey})`);
      await expect(c.app.db.transaction(appTx=>assertRoutinePaymentAccountPolicyReady(appTx))).rejects.toMatchObject({code:503});
      await c.app.db.transaction(async appTx=>{
        expect(await assertRoutinePaymentAccountPolicyReadInTx(appTx)).toBe(true);
        const [held]=await appTx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid()
          AND locktype='advisory' AND classid=${key}::oid AND objid=${subkey}::oid AND objsubid=2 AND granted) AS held`);
        expect(held.held).toBe(false);
      });
    }));
    await c.app.db.transaction(async tx=>{
      await assertRoutinePaymentAccountPolicyReady(tx);
      const [held]=await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid()
        AND locktype='advisory' AND classid=${key}::oid AND objid=${subkey}::oid AND objsubid=2 AND mode='ShareLock' AND granted) AS held`);
      expect(held.held).toBe(true);
      await expect(runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target)).rejects.toThrow('commissioning is busy');
    });
    for(const table of ['routine_payment_account_policy','routine_payment_account_use']) await c.f.withPeer(peer=>peer.db.transaction(async tx=>{
      await tx.execute(sql.raw(`LOCK TABLE ONLY public.${table} IN ACCESS SHARE MODE`));
      await expect(runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target)).rejects.toMatchObject({cause:{code:'55P03'}});
    }));
    expect(await runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target)).toMatchObject({applied:false});
    expect(await snapshot(c.f.db)).toEqual(installed);await audits(c);
  }),180000);

  it('enforces maintenance-only policy append, App use checks and immutable rows through real separate LOGINs',async()=>fixture(async c=>{
    await runRoutinePaymentAccountPolicyUpgrade(c.f.db,c.target);const p=policy();await insertPolicy(c.f.db,p);await insertUse(c.app.db);
    await expect(insertPolicy(c.app.db,policy({revision:2}))).rejects.toMatchObject({cause:{code:'42501'}});
    const before=await snapshot(c.f.db);
    const invalidPolicy:Array<[Partial<PolicyRow>,string]>=[
      [{kind:'other'},'rpap_kind_ck'],[{subject:''},'rpap_subject_ck'],[{revision:0},'rpap_revision_ck'],
      [{payload:[]},'rpap_payload_ck'],[{payload:{big:'x'.repeat(16384)}},'rpap_payload_ck'],
      [{created:0},'rpap_created_ck'],[{signature:'Z'.repeat(64)},'rpap_signature_ck'],
    ];
    for(const [patch,constraint] of invalidPolicy)await expect(insertPolicy(c.f.db,policy({subject:'unused',...patch})))
      .rejects.toMatchObject({cause:{code:'23514',constraint_name:constraint}});
    await expect(insertPolicy(c.f.db,policy({subject:p.subject}))).rejects.toMatchObject({cause:{code:'23505',constraint_name:'rpap_revision_uq'}});
    await expect(insertPolicy(c.f.db,policy({id:p.id,subject:'unused'}))).rejects.toMatchObject({cause:{code:'23505',constraint_name:'rpap_pk'}});
    const invalidUse:Array<[Partial<UseRow>,string]>=[
      [{id:'Z'.repeat(64)},'rpau_id_ck'],[{evidence:''},'rpau_evidence_ck'],[{payload:[]},'rpau_payload_ck'],
      [{payload:{big:'x'.repeat(16384)}},'rpau_payload_ck'],[{created:0},'rpau_created_ck'],[{signature:'Z'.repeat(64)},'rpau_signature_ck'],
    ];
    for(const [patch,constraint] of invalidUse)await expect(insertUse(c.app.db,use({id:'e'.repeat(64),...patch})))
      .rejects.toMatchObject({cause:{code:'23514',constraint_name:constraint}});
    await expect(insertUse(c.app.db)).rejects.toMatchObject({cause:{code:'23505',constraint_name:'rpau_pk'}});
    for(const table of ['routine_payment_account_policy','routine_payment_account_use']){
      for(const statement of [`UPDATE public.${table} SET payload=payload`,`DELETE FROM public.${table}`,`TRUNCATE public.${table}`]){
        await expect(c.app.exec(statement)).rejects.toMatchObject({code:'42501'});
        // Maintenance can reach the trigger; this separately proves immutability.
        await expect(c.f.exec(statement)).rejects.toMatchObject({code:'42501'});
      }
      for(const statement of [`SELECT * FROM public.${table}`,`INSERT INTO public.${table} DEFAULT VALUES`,
        `UPDATE public.${table} SET payload=payload`,`DELETE FROM public.${table}`,`TRUNCATE public.${table}`])
        await expect(c.admin.exec(statement)).rejects.toMatchObject({code:'42501'});
    }
    await expect(assertRoutinePaymentAccountPolicyReady(c.app.db)).rejects.toMatchObject({code:503});
    await expect(c.app.db.transaction(tx=>assertRoutinePaymentAccountPolicyReadInTx(tx),
      {isolationLevel:'repeatable read',accessMode:'read write'})).rejects.toMatchObject({code:503});
    await expect(c.app.db.transaction(tx=>assertRoutinePaymentAccountPolicyReadInTx(tx),
      {isolationLevel:'read committed',accessMode:'read only'})).rejects.toMatchObject({code:503});
    for(const wrong of [c.f.db,c.admin.db])await expect(wrong.transaction(tx=>assertRoutinePaymentAccountPolicyReadInTx(tx))).rejects.toMatchObject({code:503});
    await c.f.withRuntimeRole!(async other=>{
      for(const table of ['routine_payment_account_policy','routine_payment_account_use']){
        await expect(other.exec(`SELECT * FROM public.${table}`)).rejects.toMatchObject({code:'42501'});
        await expect(other.exec(`INSERT INTO public.${table} DEFAULT VALUES`)).rejects.toMatchObject({code:'42501'});
      }
      await expect(other.db.transaction(tx=>assertRoutinePaymentAccountPolicyReadInTx(tx))).rejects.toMatchObject({code:503});
    });
    expect(await snapshot(c.f.db)).toEqual(before);await audits(c);
  }),180000);

  it('retains complete local/case-lock, peer and App-reader declarations captured before asynchronous BEGIN', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider I/O in ownership maintenance acceptance'));
    const f = await customerCashierRuntimeHttpFixture();
    try {
      if (!f.target.local?.length || !f.target.caseLock?.runtimeRoles.length) throw Error('Full local and case-lock binding required');
      const before = await snapshot(f.maintenanceDb), business = await f.facts();
      await expect(runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, undefined, f.appReaders)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      await expect(runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      await expect(runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, { ...f.target, local: [] }, f.peers, f.appReaders)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      await expect(runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, { ...f.target, caseLock: undefined }, f.peers, f.appReaders)).rejects.toThrow();
      expect(await snapshot(f.maintenanceDb)).toEqual(before);
      const callerTarget = { ...f.target, local: [...f.target.local],
        caseLock: { ...f.target.caseLock, runtimeRoles: [...f.target.caseLock.runtimeRoles] } };
      const callerPeers = structuredClone(f.peers), callerReader = structuredClone(f.appReaders);
      const pending = runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, callerTarget, callerPeers, callerReader);
      callerTarget.database = 'owned_mutated_target'; callerTarget.app = f.adminRuntime.role;
      callerTarget.local.splice(0); callerTarget.caseLock.runtimeRoles.splice(0);
      callerPeers.target.admin = f.appRuntime.role; callerPeers.target.local = [];
      expect(Reflect.set(callerReader, 'cashierOrigin', false)).toBe(true);
      expect(await pending).toEqual({ operation: ROUTINE_PAYMENT_ACCOUNT_POLICY_UPGRADE, applied: true });
      const installed = await snapshot(f.maintenanceDb);
      expect(await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders))
        .toEqual({ operation: ROUTINE_PAYMENT_ACCOUNT_POLICY_UPGRADE, applied: false });
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
      await expect(f.appRuntime.db.transaction(tx => assertRoutinePaymentAccountPolicyReady(tx))).resolves.toBeUndefined();
      for (const runtime of [f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime]) {
        await expect(runtime.db.execute(sql`SELECT * FROM public.routine_payment_account_use LIMIT 0`)).rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(runtime.db.execute(sql`INSERT INTO public.routine_payment_account_use DEFAULT VALUES`)).rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(runtime.db.execute(sql`SELECT * FROM public.routine_payment_account_policy LIMIT 0`))
          .rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(runtime.db.execute(sql`INSERT INTO public.routine_payment_account_policy DEFAULT VALUES`))
          .rejects.toMatchObject({ cause: { code: '42501' } });
      }
      expect(await f.facts()).toEqual(business); expect(network).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }, 180000);
});
