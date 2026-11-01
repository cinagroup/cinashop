/** Real PG16 storage/role commissioning only. Synthetic dispatch/result JSON
 * is explicitly not a verified refund, provider effect or historical adoption. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { createContainerFromDb,withTx,type DbClient } from '@/lib/di';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { ROUTINE_REFUND_SQL,ROUTINE_REFUND_EXPECTED_CONSTRAINTS,inspectRoutineRefundCatalog,
 assertRoutineRefundInstalledTx,assertRoutineRefundReadInTx } from '@/migrations/routineRefund';
import { runRoutineRefundUpgrade,installRoutineRefundUpgradeInTransaction } from '@/migrations/runRoutineRefundUpgrade';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from '@/migrations/routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from '@/migrations/routinePaymentAccountPolicy';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import { upgradeCustomerFinancialRoutineRefund,upgradeCustomerFinancialRoutineRefundInTransaction } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '@/migrations/customerFinancialRuntimePlan';
import { CUSTOMER_FINANCIAL_ROUTINE_REFUND_TABLE_PRIVILEGES } from '@/migrations/customerFinancialRoutineRefund';
import { appendRoutineRefundAccountPolicy,readRoutineRefundAccountPolicyTx } from '@/services/payment/RoutineRefundAccountPolicy';
import { routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { routineRefundRuntimeFixture,type RoutineRefundRuntimeContext } from './helpers/routineRefundRuntimeFixture';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Query=Pick<DbClient,'execute'>;
const tables=['routine_refund_account_policy','routine_refund_dispatch','routine_refund_provider_evidence'] as const;
const id=(s:string)=>s.repeat(64);
const dispatch=(db:Query,refund=1,key=id('a'))=>db.execute(sql`INSERT INTO public.routine_refund_dispatch
 (dispatch_id,refund_id,out_refund_no,payload,created_at,signature)VALUES(${key},${refund},${'CNSR'+refund},'{"synthetic":true}',1,${id('b')})`);
const evidence=(db:Query,key=id('c'),source='request',sourceId='synthetic_request')=>db.execute(sql`INSERT INTO public.routine_refund_provider_evidence
 (evidence_id,dispatch_id,source,source_id,payload,created_at,signature)VALUES(${key},${id('a')},${source},${sourceId},'{"synthetic":true}',1,${id('d')})`);
async function snapshot(db:Query) {
 const [catalog]=await db.execute<{value:unknown}>(sql`SELECT pg_catalog.jsonb_build_object(
  'relations',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(oid::text,relname,relkind,relowner::text,relacl::text,reloptions,relrowsecurity,relchecks) ORDER BY oid) FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attnum>0),
  'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(oid::text,conname,convalidated,pg_catalog.pg_get_constraintdef(oid,false)) ORDER BY oid) FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace),
  'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.indexrelid) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace),
  'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE pronamespace='public'::regnamespace),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace),
  'types',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY oid) FROM pg_catalog.pg_type t WHERE typnamespace='public'::regnamespace),
  'defaults',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY oid) FROM pg_catalog.pg_default_acl t),
  'users',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(t),t.xmin::text) ORDER BY uid) FROM public."user" t),
  'bindings',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.wechat_user t),
  'orders',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.store_order t)) AS value`);
 const rows:Record<string,unknown>={};
 for(const table of tables){const[p]=await db.execute<{present:boolean}>(sql`SELECT pg_catalog.to_regclass(${`public.${table}`}) IS NOT NULL AS present`);
  rows[table]=p.present?Array.from(await db.execute(sql.raw(`SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS version FROM public.${table} t ORDER BY pg_catalog.to_jsonb(t)::text`))):null;}
 return{catalog:catalog.value,rows};
}
async function audits(c:RoutineRefundRuntimeContext){
 expect(await auditRuntimeBusinessPrivileges(c.app.db,'app',c.target)).toMatchObject({ready:true,failures:[]});
 expect(await auditRuntimeBusinessPrivileges(c.admin.db,'admin',c.target)).toMatchObject({ready:true,failures:[]});
}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine refund storage and formal Financial forward',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('installs exact empty three-table storage and repeats without changing catalog, rows or xmin',async()=>routineRefundRuntimeFixture(async c=>{
  expect(await c.app.db.transaction(tx=>assertRoutineRefundInstalledTx(tx))).toBe(false);
  await runRoutineRefundUpgrade(c.f.db,c.target);
  expect(await inspectRoutineRefundCatalog(c.f.db,c.target)).toMatchObject({ready:true,binding:{app:c.app.role,financial:null}});
  const constraints=await c.f.db.execute<{table:string;name:string;definition:string}>(sql`SELECT c.relname AS table,k.conname AS name,pg_catalog.pg_get_constraintdef(k.oid,false) AS definition
   FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid WHERE c.relname IN('routine_refund_account_policy','routine_refund_dispatch','routine_refund_provider_evidence')`);
  for(const[table,expected]of Object.entries(ROUTINE_REFUND_EXPECTED_CONSTRAINTS))
   expect(Object.fromEntries(constraints.filter(r=>r.table===table).map(r=>[r.name,r.definition]))).toEqual(expected);
  expect(constraints).toHaveLength(25);
  const[indices]=await c.f.db.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_index WHERE indrelid IN
   ('public.routine_refund_account_policy'::regclass,'public.routine_refund_dispatch'::regclass,'public.routine_refund_provider_evidence'::regclass)`);
  expect(indices.n).toBe(8);
  await dispatch(c.app.db);await evidence(c.app.db);
  const before=await snapshot(c.f.db);
  expect(await runRoutineRefundUpgrade(c.f.db,c.target)).toMatchObject({applied:false});
  expect(await snapshot(c.f.db)).toEqual(before);await audits(c);
 },false),180000);
 it('rolls new objects, grants and rows back in the caller maintenance transaction',async()=>routineRefundRuntimeFixture(async c=>{
  const before=await snapshot(c.f.db);
  await expect(c.f.db.transaction(async tx=>{
   await installRoutineRefundUpgradeInTransaction(tx,c.target);await dispatch(tx);await evidence(tx);throw Error('owned refund rollback');
  })).rejects.toThrow('owned refund rollback');
  expect(await snapshot(c.f.db)).toEqual(before);await audits(c);
 },false),180000);
 it('rejects owner-only, partial and orphan namespaces without repairing them',async()=>routineRefundRuntimeFixture(async c=>{
  for(const mutation of[ROUTINE_REFUND_SQL,'CREATE TABLE public.routine_refund_dispatch(x integer)','CREATE TYPE public.rrpe_orphan AS ENUM(\'x\')']){
   await expect(c.f.db.transaction(async tx=>{await tx.execute(sql.raw(mutation));const before=await snapshot(tx);
    await tx.execute(sql`SAVEPOINT refused`);await expect(installRoutineRefundUpgradeInTransaction(tx,c.target)).rejects.toThrow();
    await tx.execute(sql`ROLLBACK TO SAVEPOINT refused`);expect(await snapshot(tx)).toEqual(before);throw Error('owned cleanup');
   })).rejects.toThrow('owned cleanup');
  }
 },false),180000);
 it('rejects extra ACL, column ACL, function, column and index drift with no repair',async()=>routineRefundRuntimeFixture(async c=>{
  const mutations=[`GRANT INSERT ON public.routine_refund_account_policy TO ${pricingIdentifier(c.app.role)}`,
   `GRANT SELECT(payload) ON public.routine_refund_dispatch TO ${pricingIdentifier(c.admin.role)}`,
   'ALTER TABLE public.routine_refund_dispatch ADD COLUMN drift integer',
   'CREATE INDEX rrd_extra ON public.routine_refund_dispatch(created_at)',
   "CREATE OR REPLACE FUNCTION public.routine_refund_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN RETURN OLD; END$$"];
  for(const mutation of mutations)await expect(c.f.db.transaction(async tx=>{await tx.execute(sql.raw(mutation));
   expect((await inspectRoutineRefundCatalog(tx,c.target)).ready).toBe(false);const before=await snapshot(tx);
   await tx.execute(sql`SAVEPOINT refused`);await expect(installRoutineRefundUpgradeInTransaction(tx,c.target)).rejects.toThrow();
   await tx.execute(sql`ROLLBACK TO SAVEPOINT refused`);expect(await snapshot(tx)).toEqual(before);throw Error('owned cleanup');
  })).rejects.toThrow('owned cleanup');
 }),180000);
 it('uses a real maintenance gate, takes no late-read gate and refuses busy table locks NOWAIT',async()=>routineRefundRuntimeFixture(async c=>{
  const before=await snapshot(c.f.db);
  await c.f.withPeer!(peer=>peer.db.transaction(async tx=>{
   await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731718,0)`);
   await expect(c.app.db.transaction(t=>assertRoutineRefundInstalledTx(t))).rejects.toMatchObject({code:503});
   expect(await c.app.db.transaction(async t=>{expect(await assertRoutineRefundReadInTx(t)).toBe(true);
    const[locks]=await t.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
     AND locktype='advisory' AND classid=731718::oid AND objid=0::oid`);return locks.n;})).toBe(0);
   await expect(runRoutineRefundUpgrade(c.f.db,c.target)).rejects.toThrow();
  }));
  await c.f.withPeer!(peer=>peer.db.transaction(async tx=>{await tx.execute(sql`LOCK TABLE public.routine_refund_dispatch IN ACCESS SHARE MODE`);
   await expect(runRoutineRefundUpgrade(c.f.db,c.target)).rejects.toMatchObject({cause:{code:'55P03'}});
  }));
  expect(await runRoutineRefundUpgrade(c.f.db,c.target)).toMatchObject({applied:false});expect(await snapshot(c.f.db)).toEqual(before);
 }),180000);
 it('enforces App checks, maintenance-only approval append and immutable rows through actual independent roles',async()=>routineRefundRuntimeFixture(async c=>{
  await dispatch(c.app.db);await evidence(c.app.db);await c.f.db.execute(sql`INSERT INTO public.routine_refund_account_policy
   VALUES(${randomUUID()}::uuid,'synthetic',1,'{}',1,${id('e')})`);
  const before=await snapshot(c.f.db);
  await expect(c.app.db.execute(sql`INSERT INTO public.routine_refund_account_policy VALUES(${randomUUID()}::uuid,'denied',1,'{}',1,${id('e')})`)).rejects.toMatchObject({cause:{code:'42501'}});
  for(const statement of["INSERT INTO public.routine_refund_dispatch VALUES('bad',2,'CNSR2','{}',1,'"+id('b')+"')",
   "INSERT INTO public.routine_refund_dispatch VALUES('"+id('f')+"',2,'CNSR3','{}',1,'"+id('b')+"')",
   "INSERT INTO public.routine_refund_provider_evidence VALUES('"+id('f')+"','"+id('a')+"','invalid','bad','{}',1,'"+id('b')+"')"])
   await expect(c.app.exec(statement)).rejects.toMatchObject({code:'23514'});
  for(const table of tables){for(const statement of[`UPDATE public.${table} SET payload=payload`,`DELETE FROM public.${table}`,`TRUNCATE public.${table}`]){
   await expect(c.app.exec(statement)).rejects.toMatchObject({code:'42501'});
   await expect(c.f.exec(statement)).rejects.toMatchObject({code:'42501'});
  }await expect(c.admin.exec(`SELECT * FROM public.${table}`)).rejects.toMatchObject({code:'42501'});}
  for(const wrong of[c.admin.db,c.f.db])await expect(wrong.transaction(tx=>assertRoutineRefundReadInTx(tx))).rejects.toMatchObject({code:503});
  await expect(c.app.db.transaction(tx=>assertRoutineRefundInstalledTx(tx,'financial'))).rejects.toMatchObject({code:503});
  await expect(c.app.db.transaction(tx=>assertRoutineRefundReadInTx(tx),{accessMode:'read only'})).rejects.toMatchObject({code:503});
  await expect(c.app.db.transaction(tx=>assertRoutineRefundReadInTx(tx),{isolationLevel:'repeatable read'})).rejects.toMatchObject({code:503});
  expect(await snapshot(c.f.db)).toEqual(before);await audits(c);
 }),180000);
 it('rejects real TEMP shadows while leaving canonical catalog and role grants unchanged',async()=>routineRefundRuntimeFixture(async c=>{
  // TEMP is granted only for this negative fixture, never by commissioning.
  await c.f.exec(`GRANT TEMPORARY ON DATABASE ${pricingIdentifier(c.target.database)} TO ${pricingIdentifier(c.app.role)}`);
  try{await expect(c.app.db.transaction(async tx=>{await tx.execute(sql`CREATE TEMP TABLE routine_refund_dispatch(x integer) ON COMMIT DROP`);
   await expect(assertRoutineRefundInstalledTx(tx)).rejects.toMatchObject({code:503});throw Error('owned shadow rollback');
  })).rejects.toThrow('owned shadow rollback');}finally{await c.f.exec(`REVOKE TEMPORARY ON DATABASE ${pricingIdentifier(c.target.database)} FROM ${pricingIdentifier(c.app.role)}`);}
  expect(await c.app.db.transaction(tx=>assertRoutineRefundInstalledTx(tx))).toBe(true);await audits(c);
 }),180000);
 it('formally forwards the real Financial addon, preserves all peers and replays only the exact complete joint reader state',async()=>{
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider I/O in refund foundation acceptance'));
  const f=await customerCashierRuntimeHttpFixture();
  try{
   await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
   await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
   await runRoutineRefundUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
   const declaration={routineRefund:{routineRefund:true as const},manualRefund:f.manual,originalPaymentReaders:f.readers};
   const before=await snapshot(f.maintenanceDb),business=await f.facts();
   const invalidManual={...f.manual,unknown:true};
   await expect(upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,f.target,{...declaration,manualRefund:invalidManual},f.peers,f.appReaders)).rejects.toThrow();
   expect(await snapshot(f.maintenanceDb)).toEqual(before);
   await f.exec(`GRANT SELECT ON public.routine_original_payment_evidence TO ${pricingIdentifier(CUSTOMER_FINANCIAL_RUNTIME_ROLE)}`);
   try{expect((await inspectRoutineOriginalPaymentEvidenceCatalog(f.maintenanceDb,f.target)).ready).toBe(false);
    const partial=await snapshot(f.maintenanceDb);await expect(upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,f.target,declaration,f.peers,f.appReaders)).rejects.toThrow();
    expect(await snapshot(f.maintenanceDb)).toEqual(partial);
   }finally{await f.exec(`REVOKE SELECT ON public.routine_original_payment_evidence FROM ${pricingIdentifier(CUSTOMER_FINANCIAL_RUNTIME_ROLE)}`);}
   expect(await snapshot(f.maintenanceDb)).toEqual(before);
   await expect(f.maintenanceDb.transaction(async tx=>{await upgradeCustomerFinancialRoutineRefundInTransaction(tx,f.target,declaration,f.peers,f.appReaders);
    await dispatch(tx);throw Error('owned Financial rollback');})).rejects.toThrow('owned Financial rollback');
   expect(await snapshot(f.maintenanceDb)).toEqual(before);
   const result=await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,f.target,declaration,f.peers,f.appReaders),peers=result.peers;
   expect(result.applied).toBe(true);
   expect((await inspectRoutineOriginalPaymentEvidenceCatalog(f.maintenanceDb,f.target)).ready).toBe(true);
   expect((await inspectRoutinePaymentAccountPolicyCatalog(f.maintenanceDb,f.target)).ready).toBe(true);
   expect(await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db,f.target,f.manual,f.readers,declaration.routineRefund)).toMatchObject({ready:true,realLogin:true});
   expect((await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db,f.target,f.manual,f.readers)).ready).toBe(false);
   for(const[table,privileges]of Object.entries(CUSTOMER_FINANCIAL_ROUTINE_REFUND_TABLE_PRIVILEGES)){
    await f.financialRuntime.db.execute(sql.raw(`SELECT * FROM public.${table} LIMIT 0`));
    if(!privileges.includes('INSERT' as never))await expect(f.financialRuntime.db.execute(sql.raw(`INSERT INTO public.${table} DEFAULT VALUES`))).rejects.toMatchObject({cause:{code:'42501'}});
   }
   await dispatch(f.financialRuntime.db);await evidence(f.financialRuntime.db);
   expect(await f.financialRuntime.db.transaction(tx=>assertRoutineRefundInstalledTx(tx,'financial'))).toBe(true);
   await expect(f.financialRuntime.db.transaction(tx=>assertRoutineRefundInstalledTx(tx,'app'))).rejects.toMatchObject({code:503});
   const env={APP_KEY:'owned-refund-policy-key',ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[{
    ref:'fixture',version:1,appId:'wx_original_fixture',merchantId:'1900000001',serialNo:'A1',apiV3Key:'1'.repeat(32),
    privateKey:'-----BEGIN PRIVATE KEY-----fixture-----END PRIVATE KEY-----',platformPublicKey:'-----BEGIN PUBLIC KEY-----fixture-----END PUBLIC KEY-----',platformPublicKeyId:'PUB_FIXTURE'}]})};
   const now=Math.floor(Date.now()/1000),commitment=routinePaymentCredentialCommitment(env,'fixture',1);
   await appendRoutineRefundAccountPolicy(f.maintenanceDb,env,f.target,{operationId:randomUUID(),expectedRevision:0,data:{accountId:'fixture_refund',state:'active',
    ...commitment,credentialRef:'fixture',credentialVersion:1,purposes:['refund_query'],validFrom:now-60,validUntil:now+3600}});
   const latest=await withTx(createContainerFromDb(f.financialRuntime.db),tx=>readRoutineRefundAccountPolicyTx(tx,env,'fixture_refund','refund_query','financial'));
   expect(latest.revision).toBe(1);expect(latest.payload.data.accountId).toBe('fixture_refund');
   const installed=await snapshot(f.maintenanceDb);
   if(!f.target.local||!f.target.caseLock)throw Error('Full peer fixture needs exact local/case-lock declarations');
   const callerTarget={...f.target,local:[...f.target.local],caseLock:{...f.target.caseLock,runtimeRoles:[...f.target.caseLock.runtimeRoles]},unknown:{data:'ignored'}},
    callerDeclaration=structuredClone(declaration),callerPeers=structuredClone(peers),callerReader=structuredClone(f.appReaders);
   const pending=upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,callerTarget,callerDeclaration,callerPeers,callerReader);
   callerTarget.database='late_changed';callerTarget.local.splice(0);callerTarget.caseLock.runtimeRoles.splice(0);callerTarget.unknown.data='changed';
   callerDeclaration.manualRefund.promotionOwner='late_changed';callerPeers.target.local=[];Reflect.set(callerReader,'cashierOrigin',false);
   const repeated=await pending;
   expect(repeated.applied).toBe(false);expect(repeated.target).toEqual({database:f.target.database,maintenance:f.target.maintenance,
    app:f.target.app,admin:f.target.admin,local:[...f.target.local],caseLock:{owner:f.target.caseLock.owner,runtimeRoles:[...f.target.caseLock.runtimeRoles]}});
   expect(Object.hasOwn(repeated.target,'unknown')).toBe(false);expect(Object.hasOwn(repeated.target,'pricingOwner')).toBe(false);
   expect(await snapshot(f.maintenanceDb)).toEqual(installed);expect(await f.facts()).toEqual(business);
   for(const p of[await auditRuntimeBusinessPrivileges(f.appRuntime.db,'app',f.target,undefined,peers,f.appReaders),
    await auditRuntimeBusinessPrivileges(f.adminRuntime.db,'admin',f.target,undefined,peers),
    await auditManagerRuntimePrivileges(f.managerRuntime.db,f.target),
    await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db,f.cashierRuntime.role,f.target,{abandon:true,conditionalGuards:true,formImages:true})])expect(p).toMatchObject({ready:true,failures:[]});
   // Actual source-name shadow: the same fixed Financial identity must reject it.
   await f.exec(`GRANT TEMPORARY ON DATABASE ${pricingIdentifier(f.target.database)} TO ${pricingIdentifier(CUSTOMER_FINANCIAL_RUNTIME_ROLE)}`);
   try{await expect(f.financialRuntime.db.transaction(async tx=>{await tx.execute(sql`CREATE TEMP TABLE routine_payment_account_use(x integer) ON COMMIT DROP`);
    await expect(assertRoutineRefundInstalledTx(tx,'financial')).rejects.toMatchObject({code:503});throw Error('owned source shadow');
   })).rejects.toThrow('owned source shadow');}finally{await f.exec(`REVOKE TEMPORARY ON DATABASE ${pricingIdentifier(f.target.database)} FROM ${pricingIdentifier(CUSTOMER_FINANCIAL_RUNTIME_ROLE)}`);}
   expect(network).not.toHaveBeenCalled();
  }finally{await f.close();}
 },180000);
});
