/** Actual fixed Financial/Manager and independent complete App/Admin/Cashier
 * PG16 profiles. Storage/ACL commissioning only: no provider/payment/refund
 * business result is manufactured by this suite. Every case remains 5 seconds. */
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '@/migrations/customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from '@/migrations/managerRuntimePrivilegePlan';
import { inspectRechargeRefundCatalog } from '@/migrations/rechargeRefund';
import { inspectRechargeRoutineRefundAccountCatalog } from '@/migrations/rechargeRoutineRefundAccount';
import { inspectRechargeRefundRuntimeProfile } from '@/migrations/rechargeRefundRuntimeProfile';
import { RECHARGE_REFUND_RUNTIME_PROFILE_GATE } from '@/migrations/upgradeRechargeRefundRuntimeProfiles';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from '@/migrations/routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from '@/migrations/routinePaymentAccountPolicy';
import { inspectRoutineRefundCatalog } from '@/migrations/routineRefund';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { inspectCustomerFinancialRuntimeCatalogPrerequisites } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { rechargeRefundRuntimeProfileFixture,rechargeProfileKinds,rechargeProfileOldBusinessAcl,
 rechargeProfileEffectivePrivileges,rechargeProfileSnapshot,observeRechargeProfileRoot,
 type RechargeRefundRuntimeProfileFixture } from './helpers/rechargeRefundRuntimeProfileNative';

const sqlStates=(input:unknown)=>{
 const codes:unknown[]=[];let value=input;
 for(let depth=0;depth<8&&value&&typeof value==='object';depth++) {
  const r=value as {code?:unknown;cause?:unknown};codes.push(r.code);value=r.cause;
 }return codes;
};
async function denyUnchanged(f:RechargeRefundRuntimeProfileFixture,run:()=>Promise<unknown>) {
 const before=await rechargeProfileSnapshot(f.maintenanceDb),business=await rechargeProfileOldBusinessAcl(f.maintenanceDb);
 await expect(run()).rejects.toThrow();
 expect(await rechargeProfileSnapshot(f.maintenanceDb)).toBe(before);
 expect(await rechargeProfileOldBusinessAcl(f.maintenanceDb)).toBe(business);
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('formal recharge refund complete five-LOGIN profile successor',()=>{
 let f:RechargeRefundRuntimeProfileFixture,oldBusiness:string,oldManager:string,oldCashier:string;
 let committed=false;
 // Existing canonical/fixed-role source fixture and formal upgrade budget.
 // No refund operation or result runs in setup. All individual cases are 5s.
 beforeAll(async()=>{
  f=await rechargeRefundRuntimeProfileFixture();
  oldBusiness=await rechargeProfileOldBusinessAcl(f.maintenanceDb);
  oldManager=await rechargeProfileEffectivePrivileges(f.maintenanceDb,f.binding.manager);
  oldCashier=await rechargeProfileEffectivePrivileges(f.maintenanceDb,f.profilePeers.cashier.role);
 },180000);
 afterAll(async()=>{await f?.close();},30000);
 const required=()=>{if(!committed)throw Error('The real formal forward must have committed');};

 it('retains the real fixed identities, six backend PIDs and exact owner-only full-profile predecessor',async()=>{
  expect(f.identities.financial.role).toBe(CUSTOMER_FINANCIAL_RUNTIME_ROLE);
  expect(f.identities.manager.role).toBe(MANAGER_RUNTIME_ROLE);
  expect(new Set([f.owner.pid,...Object.values(f.identities).map(r=>r.pid)]).size).toBe(6);
  expect(new Set(Object.values(f.identities).map(r=>r.oid)).size).toBe(5);
  for(const kind of rechargeProfileKinds)expect(f.beforeAudits[kind]).toMatchObject({ready:true,failures:[]});
  expect(await inspectRechargeRefundCatalog(f.maintenanceDb)).toMatchObject({installed:true,commissioned:false,binding:null,failures:[]});
  expect(await inspectRechargeRoutineRefundAccountCatalog(f.maintenanceDb)).toMatchObject({present:false,ready:false});
  expect((await inspectRoutineRefundCatalog(f.maintenanceDb)).present).toBe(false);
  const [r]=await f.maintenanceDb.execute<{safe:boolean}>(sql`SELECT rolconnlimit=15 AS safe FROM pg_catalog.pg_roles WHERE rolname=${f.binding.financial}`);
  expect(r.safe).toBe(true);
 },5000);

 for(const field of ['databaseOid','maintenanceOid','appOid','adminOid','financialOid','managerOid'] as const)
 it('rejects a wrong reviewed '+field+' before any partial successor',async()=>{
  const traced=observeRechargeProfileRoot(f.maintenanceDb);
  await denyUnchanged(f,()=>f.commission(traced.db,{...f.input,binding:{...f.binding,[field]:'4294967295'}}));
  expect(traced.mutations).toEqual([]);
 },5000);
 it('refuses a missing successor declaration before any SQL mutation',async()=>{
  const traced=observeRechargeProfileRoot(f.maintenanceDb);
  await denyUnchanged(f,()=>f.commission(traced.db,{...f.input,peers:f.beforePeers}));
  expect(traced.mutations).toEqual([]);
 },5000);
 it('rejects an accessor declaration without invoking it or replacing any reviewed identity',async()=>{
  let called=false;const input={...f.input};Object.defineProperty(input,'binding',{enumerable:true,get(){called=true;return f.binding;}});
  await denyUnchanged(f,()=>f.commission(undefined,input));expect(called).toBe(false);
 },5000);
 it('honors the actual busy new gate and leaves the entire owner-only predecessor intact',async()=>{
  await f.withMaintenancePeer(peer=>peer.transaction(async held=>{
   await held.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${RECHARGE_REFUND_RUNTIME_PROFILE_GATE[0]},${RECHARGE_REFUND_RUNTIME_PROFILE_GATE[1]})`);
   await denyUnchanged(f,()=>f.commission());
  }));
 },5000);
 it('rolls binding, every new table/source grant and account DDL back after the real final checks and a late SQL failure',async()=>{
  const before=await rechargeProfileSnapshot(f.maintenanceDb);
  let witnessed=false;
  const traced=observeRechargeProfileRoot(f.maintenanceDb,async tx=>{
   expect(await inspectRechargeRefundRuntimeProfile(tx,f.target,f.input.addon)).toMatchObject({ready:true,failures:[],binding:f.binding});
   const [r]=await tx.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE c.oid IN('public.routine_original_payment_evidence'::regclass,
     'public.routine_payment_account_policy'::regclass,'public.routine_payment_account_use'::regclass)
    AND a.grantee IN(${f.binding.adminOid}::oid,${f.binding.financialOid}::oid) AND a.privilege_type='SELECT'`);
   expect(r.n).toBe(6);witnessed=true;
   // The owning backend aborts after the actual author's after-profile checks.
   // There is no mocked driver result, mocked catalog, savepoint or fake COMMIT.
   await tx.execute(sql`SELECT 1/0`);
  });
  let error:unknown;try{await f.commission(traced.db);}catch(caught){error=caught;}
  expect(witnessed).toBe(true);expect(sqlStates(error)).toContain('22012');
  expect(traced.mutations.some(s=>/^\s*GRANT\b/u.test(s))).toBe(true);
  expect(traced.mutations.some(s=>s.includes('CREATE TABLE public.recharge_routine_refund_account_policy'))).toBe(true);
  expect(await rechargeProfileSnapshot(f.maintenanceDb)).toBe(before);
  expect(await rechargeProfileOldBusinessAcl(f.maintenanceDb)).toBe(oldBusiness);
  expect(await rechargeProfileEffectivePrivileges(f.maintenanceDb,f.binding.manager)).toBe(oldManager);
  expect(await rechargeProfileEffectivePrivileges(f.maintenanceDb,f.profilePeers.cashier.role)).toBe(oldCashier);
  expect(await inspectRechargeRefundCatalog(f.maintenanceDb)).toMatchObject({installed:true,commissioned:false,binding:null});
  expect((await inspectRechargeRoutineRefundAccountCatalog(f.maintenanceDb)).present).toBe(false);
 },5000);

 it('atomically commissions the complete successor using the existing five roles and no old business GRANT',async()=>{
  const traced=observeRechargeProfileRoot(f.maintenanceDb),result=await f.commission(traced.db);
  expect(result).toMatchObject({applied:true,binding:f.binding,peers:f.afterPeers});committed=true;
  expect(await inspectRechargeRefundRuntimeProfile(f.maintenanceDb,f.target,f.input.addon)).toMatchObject({ready:true,failures:[],binding:f.binding});
  const grants=traced.mutations.filter(s=>/^\s*GRANT\b/u.test(s));expect(grants.length).toBeGreaterThan(0);
  for(const statement of grants) {
   // Every GRANT belongs to a new ledger/account function/table or exact
   // historical SELECT. No wallet, staff, source UPDATE or sequence grant.
   const newObject=/\b(?:recharge_refund_|recharge_routine_refund_account_policy)\w*/u.test(statement.replaceAll('"',''));
   const sourceSelect=/^\s*GRANT SELECT ON TABLE public\."?routine_(?:original_payment_evidence|payment_account_policy|payment_account_use)"? TO /u.test(statement);
   expect(newObject||sourceSelect,statement).toBe(true);
   expect(statement).not.toMatch(/\bSEQUENCE\b/u);
  }
  expect(await rechargeProfileOldBusinessAcl(f.maintenanceDb)).toBe(oldBusiness);
 },5000);

 for(const kind of rechargeProfileKinds)it('passes the complete actual '+kind+' LOGIN audit after commissioning',async()=>{
  required();const result=await f.audit(kind,true);expect(result).toMatchObject({ready:true,failures:[]});
  if(kind==='financial'||kind==='cashier')expect(result).toHaveProperty('realLogin',true);
 },5000);

 for(const kind of ['app','admin','financial'] as const)it('rejects the old undeclared '+kind+' profile against new effective authority',async()=>{
  required();const result=await f.audit(kind,false);expect(result.ready).toBe(false);
  expect(result.failures).toContain('table:recharge_refund_operation:SELECT');
  if(kind==='financial')expect(result.failures).toContain('unreviewed_routine:recharge_refund_valid_v1(text, jsonb)');
 },5000);

 it('requires complete new-addon target/catalog proof even for the direct public Financial prerequisite API',async()=>{
  required();
  const missing=await inspectCustomerFinancialRuntimeCatalogPrerequisites(f.maintenanceDb,f.binding.maintenance,
   f.manual,f.readers,undefined,f.target,f.input.addon);
  expect(missing.ready).toBe(false);expect(missing.failures).toContain('recharge_refund_target');
  const complete=await inspectCustomerFinancialRuntimeCatalogPrerequisites(f.maintenanceDb,f.binding.maintenance,
   f.manual,f.readers,undefined,f.target,f.input.addon,f.target);
  expect(complete).toMatchObject({ready:true,failures:[],rechargeProfile:{ready:true,binding:f.binding}});
  expect(complete.rechargeProfile?.lockSourceFunctionOid).toMatch(/^[1-9][0-9]*$/u);
  expect(complete.rechargeProfile?.validFunctionOid).toMatch(/^[1-9][0-9]*$/u);
 },5000);

 it('preserves every effective Manager and Cashier privilege with zero new capability',async()=>{
  required();expect(await rechargeProfileEffectivePrivileges(f.maintenanceDb,f.binding.manager)).toBe(oldManager);
  expect(await rechargeProfileEffectivePrivileges(f.maintenanceDb,f.profilePeers.cashier.role)).toBe(oldCashier);
  for(const peer of [f.profilePeers.manager,f.profilePeers.cashier]) {
   const [r]=await peer.db.execute<{safe:boolean}>(sql`SELECT
    NOT has_table_privilege(current_user,'public.recharge_refund_operation','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(current_user,'public.recharge_routine_refund_account_policy','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_function_privilege(current_user,'public.recharge_refund_lock_source_v1(integer)','EXECUTE')
    AND NOT has_function_privilege(current_user,'public.recharge_refund_valid_v1(text,jsonb)','EXECUTE') AS safe`);
   expect(r.safe).toBe(true);
  }
 },5000);
 it('replays the exact complete successor with zero DDL/GRANT/COMMENT/DML and identical catalog/data xmin',async()=>{
  required();const before=await rechargeProfileSnapshot(f.maintenanceDb),traced=observeRechargeProfileRoot(f.maintenanceDb);
  expect(await f.commission(traced.db)).toMatchObject({applied:false,binding:f.binding});expect(traced.mutations).toEqual([]);
  expect(await rechargeProfileSnapshot(f.maintenanceDb)).toBe(before);
  expect(await rechargeProfileOldBusinessAcl(f.maintenanceDb)).toBe(oldBusiness);
 },5000);
 it('captures the actual reviewed binding before the root BEGIN yields',async()=>{
  required();const binding={...f.binding},input={...f.input,binding},pending=f.commission(undefined,input);
  binding.adminOid='4294967295';binding.app=f.binding.manager;
  expect(await pending).toMatchObject({applied:false,binding:f.binding});
 },5000);
 it('refuses a missing account SELECT without repairing that partial successor',async()=>{
  required();await f.maintenanceDb.execute(sql`REVOKE SELECT ON TABLE public.recharge_routine_refund_account_policy FROM ${sql.identifier(f.binding.admin)}`);
  try{
   const prerequisite=await inspectCustomerFinancialRuntimeCatalogPrerequisites(f.maintenanceDb,f.binding.maintenance,
    f.manual,f.readers,undefined,f.target,f.input.addon,f.target);
   expect(prerequisite.ready).toBe(false);expect(prerequisite.failures).toContain('recharge_refund:account_catalog');
   await denyUnchanged(f,()=>f.commission());
  }
  finally{await f.maintenanceDb.execute(sql`GRANT SELECT ON TABLE public.recharge_routine_refund_account_policy TO ${sql.identifier(f.binding.admin)}`);}
 },5000);
 it('refuses a new Manager source reader without adopting or removing it',async()=>{
  required();await f.maintenanceDb.execute(sql`GRANT SELECT ON TABLE public.routine_original_payment_evidence TO ${sql.identifier(f.binding.manager)}`);
  try{await denyUnchanged(f,()=>f.commission());}
  finally{await f.maintenanceDb.execute(sql`REVOKE SELECT ON TABLE public.routine_original_payment_evidence FROM ${sql.identifier(f.binding.manager)}`);}
 },5000);
 it('refuses a delegated historical SELECT and preserves it until explicit owned-fixture cleanup',async()=>{
  required();await f.maintenanceDb.execute(sql`GRANT SELECT ON TABLE public.routine_original_payment_evidence TO ${sql.identifier(f.binding.admin)} WITH GRANT OPTION`);
  try{await denyUnchanged(f,()=>f.commission());}
  finally{await f.maintenanceDb.execute(sql`REVOKE GRANT OPTION FOR SELECT ON TABLE public.routine_original_payment_evidence FROM ${sql.identifier(f.binding.admin)} CASCADE`);}
 },5000);
 it('rejects an unrelated recharge-prefixed invoker instead of widening the Financial routine allowlist',async()=>{
  required();await f.exec('CREATE FUNCTION public.recharge_unreviewed_probe_v1() RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT true$$;REVOKE ALL ON FUNCTION public.recharge_unreviewed_probe_v1() FROM PUBLIC');
  await f.maintenanceDb.execute(sql`GRANT EXECUTE ON FUNCTION public.recharge_unreviewed_probe_v1() TO ${sql.identifier(f.binding.financial)}`);
  try {
   const [r]=await f.profilePeers.financial.db.execute<{value:boolean}>(sql`SELECT public.recharge_unreviewed_probe_v1() AS value`);expect(r.value).toBe(true);
   const audit=await f.audit('financial',true);expect(audit.ready).toBe(false);
   expect(audit.failures).toContain('unreviewed_routine:recharge_unreviewed_probe_v1()');
   await denyUnchanged(f,()=>f.commission());
  }finally{await f.exec('DROP FUNCTION public.recharge_unreviewed_probe_v1()');}
 },5000);
 it('keeps both real historical source catalogs and the exact final authority closed after negative cases',async()=>{
  required();expect(await inspectRoutineOriginalPaymentEvidenceCatalog(f.maintenanceDb)).toMatchObject({ready:true});
  expect(await inspectRoutinePaymentAccountPolicyCatalog(f.maintenanceDb)).toMatchObject({ready:true});
  expect(await inspectRechargeRefundRuntimeProfile(f.maintenanceDb,f.target,f.input.addon)).toMatchObject({ready:true,failures:[]});
  expect(await rechargeProfileOldBusinessAcl(f.maintenanceDb)).toBe(oldBusiness);
 },5000);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('formal recharge successor preserving the complete pre-existing goods Financial profile',()=>{
 let f:RechargeRefundRuntimeProfileFixture,oldBusiness:string,financialSource:string;
 let committed=false;
 beforeAll(async()=>{
  f=await rechargeRefundRuntimeProfileFixture(true);oldBusiness=await rechargeProfileOldBusinessAcl(f.maintenanceDb);
  financialSource=JSON.stringify(await f.maintenanceDb.execute(sql`SELECT c.relname,a.grantee::text,a.grantor::text,a.privilege_type,a.is_grantable
   FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
   WHERE c.oid IN('public.routine_original_payment_evidence'::regclass,'public.routine_payment_account_policy'::regclass,'public.routine_payment_account_use'::regclass)
    AND a.grantee=${f.binding.financialOid}::oid ORDER BY c.relname COLLATE "C",a.privilege_type COLLATE "C"`));
 },180000);
 afterAll(async()=>{await f?.close();},30000);
 it('adds only the three missing Admin SELECTs while preserving the formally declared Financial source predecessor',async()=>{
  expect(f.input.goods).toMatchObject({financial:CUSTOMER_FINANCIAL_RUNTIME_ROLE,financialOid:f.binding.financialOid});
  const goods=await inspectRoutineRefundCatalog(f.maintenanceDb);expect(goods).toMatchObject({ready:true,binding:f.input.goods});
  const traced=observeRechargeProfileRoot(f.maintenanceDb);expect(await f.commission(traced.db)).toMatchObject({applied:true});committed=true;
  const sourceGrants=traced.mutations.filter(s=>/^\s*GRANT SELECT ON TABLE public\."?routine_(original_payment_evidence|payment_account_policy|payment_account_use)"? TO /u.test(s));
  expect(sourceGrants).toHaveLength(3);for(const statement of sourceGrants)expect(statement).toContain(f.binding.admin);
  const after=JSON.stringify(await f.maintenanceDb.execute(sql`SELECT c.relname,a.grantee::text,a.grantor::text,a.privilege_type,a.is_grantable
   FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
   WHERE c.oid IN('public.routine_original_payment_evidence'::regclass,'public.routine_payment_account_policy'::regclass,'public.routine_payment_account_use'::regclass)
    AND a.grantee=${f.binding.financialOid}::oid ORDER BY c.relname COLLATE "C",a.privilege_type COLLATE "C"`));
  expect(after).toBe(financialSource);expect((await inspectRoutineRefundCatalog(f.maintenanceDb)).binding).toEqual(goods.binding);
  expect(await rechargeProfileOldBusinessAcl(f.maintenanceDb)).toBe(oldBusiness);
 },5000);
 for(const kind of rechargeProfileKinds)it('retains the actual '+kind+' complete profile in the goods+recharge union',async()=>{
  if(!committed)throw Error('The real goods+recharge successor must have committed');
  expect(await f.audit(kind,true)).toMatchObject({ready:true,failures:[]});
 },5000);
 it('explicitly replays the formal old goods Financial tool under the new complete profiles with zero mutation',async()=>{
  if(!committed)throw Error('The real goods+recharge successor must have committed');
  const before=await rechargeProfileSnapshot(f.maintenanceDb),traced=observeRechargeProfileRoot(f.maintenanceDb);
  const result=await upgradeCustomerFinancialRoutineRefund(traced.db,f.target,
   {routineRefund:{routineRefund:true},manualRefund:f.manual,originalPaymentReaders:f.readers},f.afterPeers,f.appReaders);
  expect(result).toMatchObject({applied:false,peers:f.afterPeers});expect(traced.mutations).toEqual([]);
  expect(await rechargeProfileSnapshot(f.maintenanceDb)).toBe(before);
  expect(await rechargeProfileOldBusinessAcl(f.maintenanceDb)).toBe(oldBusiness);
 },5000);
 it('does not infer the new Financial addon when old goods maintenance omits its explicit peers declaration',async()=>{
  if(!committed)throw Error('The real goods+recharge successor must have committed');
  const traced=observeRechargeProfileRoot(f.maintenanceDb);
  await denyUnchanged(f,()=>upgradeCustomerFinancialRoutineRefund(traced.db,f.target,
   {routineRefund:{routineRefund:true},manualRefund:f.manual,originalPaymentReaders:f.readers},f.beforePeers,f.appReaders));
  expect(traced.mutations).toEqual([]);
 },5000);
 it('rejects a changed independently reviewed goods OID rather than projecting or repairing it',async()=>{
  if(!committed)throw Error('The real goods+recharge successor must have committed');
  await denyUnchanged(f,()=>f.commission(undefined,{...f.input,goods:{...f.input.goods!,financialOid:'4294967295'}}));
 },5000);
});
