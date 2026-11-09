/** Real PG16 source storage/SELECT commissioning only. Deliberate structural
 * history rows below establish no authenticated payment or provider authority. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { runRechargeRefundSourceReaderCommission } from '@/migrations/rechargeRefundSourceReaderCommission';
import type { RechargeRefundSourceGoodsDeclaration } from '@/migrations/rechargeRefundSourceReaderCommission';
import { inspectRechargeRefundCatalog } from '@/migrations/rechargeRefund';
import { inspectRoutineOriginalPaymentEvidenceCatalog, ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_IMMUTABLE_BODY } from '@/migrations/routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from '@/migrations/routinePaymentAccountPolicy';
import { inspectRoutineRefundCatalog } from '@/migrations/routineRefund';
import { inspectRoutineRefundSourceAclMatrix, readRoutineRefundSourceReaders } from '@/migrations/routineRefundActorAddon';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { rechargeRefundSourceReaderFixture, rechargeRefundSourceSnapshot, rechargeRefundSourceTables,
 observeSourceCommissionRoot, type RechargeRefundSourceReaderFixture } from './helpers/rechargeRefundSourceReaderNative';

const names=(f:RechargeRefundSourceReaderFixture)=>({maintenance:f.binding.maintenance,app:f.binding.app});
const readers=(f:RechargeRefundSourceReaderFixture)=>[f.binding.admin,f.binding.financial].sort();
const commission=(f:RechargeRefundSourceReaderFixture,goods?:RechargeRefundSourceGoodsDeclaration)=>
 runRechargeRefundSourceReaderCommission(f.owner,f.binding,goods);
async function denyUnchanged(f:RechargeRefundSourceReaderFixture,run:()=>Promise<unknown>) {
 const before=await rechargeRefundSourceSnapshot(f.owner);await expect(run()).rejects.toThrow();
 expect(await rechargeRefundSourceSnapshot(f.owner)).toBe(before);
}
async function sourceReady(f:RechargeRefundSourceReaderFixture) {
 for(const catalog of [await inspectRoutineOriginalPaymentEvidenceCatalog(f.owner),await inspectRoutinePaymentAccountPolicyCatalog(f.owner)])
  expect(catalog).toMatchObject({ready:true,binding:{maintenance:f.binding.maintenance,maintenanceOid:f.binding.maintenanceOid,
   app:f.binding.app,appOid:f.binding.appOid}});
}
const grant=(f:RechargeRefundSourceReaderFixture,role:string,privilege='SELECT',tables:readonly string[]=rechargeRefundSourceTables)=>
 f.owner.execute(sql`GRANT ${sql.raw(privilege)} ON TABLE ${sql.join(tables.map(table=>sql`public.${sql.identifier(table)}`),sql`, `)} TO ${sql.identifier(role)}`);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('recharge refund independent PG16 historical source SELECT successor',()=>{
 let f:RechargeRefundSourceReaderFixture;
 beforeAll(async()=>{f=await rechargeRefundSourceReaderFixture();},30000);
 beforeEach(async()=>{await f.resetReaders();await sourceReady(f);});
 afterAll(async()=>{await f?.close();},30000);

 it('advances actual App-only sources without any goods namespace to exactly six SELECT grants and preserves nonempty history/OIDs/comments',async()=>{
  const actors=[f.maintenance,...Object.values(f.peers)];
  expect(new Set(actors.map(a=>a.role)).size).toBe(5);expect(new Set(actors.map(a=>a.oid)).size).toBe(5);
  expect(new Set(actors.map(a=>a.pid)).size).toBe(5);
  expect((await inspectRoutineRefundCatalog(f.owner)).present).toBe(false);
  expect(await inspectRoutineRefundSourceAclMatrix(f.owner,names(f),[])).toBe(true);
  const before=await rechargeRefundSourceSnapshot(f.owner,false),traced=observeSourceCommissionRoot(f.owner);
  expect(await runRechargeRefundSourceReaderCommission(traced.db,f.binding)).toEqual({binding:f.binding,goods:null,replayed:false,grantedPrivileges:6});
  expect(traced.statements.filter(s=>/^\s*GRANT\b/u.test(s))).toHaveLength(6);
  expect(await rechargeRefundSourceSnapshot(f.owner,false)).toBe(before);
  expect(await inspectRoutineRefundSourceAclMatrix(f.owner,names(f),readers(f))).toBe(true);
  expect(await readRoutineRefundSourceReaders(f.owner,names(f))).toEqual(readers(f));await sourceReady(f);
  for(const role of ['admin','financial'] as const)for(const table of rechargeRefundSourceTables) {
   expect(await f.peers[role].db.execute(sql`SELECT * FROM public.${sql.identifier(table)}`)).toHaveLength(1);
   for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE'] as const) {
    const [row]=await f.peers[role].db.execute<{allowed:boolean}>(sql`SELECT has_table_privilege(current_user,${'public.'+table},${privilege}) AS allowed`);
    expect(row.allowed).toBe(false);
   }
  }
  for(const table of rechargeRefundSourceTables)
   await expect(f.peers.manager.db.execute(sql`SELECT * FROM public.${sql.identifier(table)}`)).rejects.toMatchObject({cause:{code:'42501'}});
 },5000);

 it('replays the complete successor with no dispatched GRANT and identical catalog/data xmin',async()=>{
  await commission(f);const before=await rechargeRefundSourceSnapshot(f.owner),traced=observeSourceCommissionRoot(f.owner);
  expect(await runRechargeRefundSourceReaderCommission(traced.db,f.binding)).toMatchObject({replayed:true,grantedPrivileges:0});
  expect(traced.statements.filter(s=>/^\s*GRANT\b/u.test(s))).toEqual([]);
  expect(await rechargeRefundSourceSnapshot(f.owner)).toBe(before);
 },5000);

 it('rejects a one-table partial reader grant instead of repairing it',async()=>{
  await grant(f,f.binding.admin,'SELECT',[rechargeRefundSourceTables[0]]);await denyUnchanged(f,()=>commission(f));
 },5000);
 it('rejects an unknown reader even when it is the otherwise valid bound Manager',async()=>{
  await grant(f,f.binding.manager);expect((await inspectRechargeRefundCatalog(f.owner)).commissioned).toBe(true);
  await denyUnchanged(f,()=>commission(f));
 },5000);
 it('rejects PUBLIC SELECT instead of adopting or revoking it',async()=>{
  await f.exec('GRANT SELECT ON public.routine_original_payment_evidence TO PUBLIC');await denyUnchanged(f,()=>commission(f));
 },5000);
 it('rejects SELECT WITH GRANT OPTION',async()=>{
  await f.owner.execute(sql`GRANT SELECT ON public.routine_original_payment_evidence,public.routine_payment_account_policy,
   public.routine_payment_account_use TO ${sql.identifier(f.binding.admin)} WITH GRANT OPTION`);
  await denyUnchanged(f,()=>commission(f));
 },5000);
 it('rejects actual runtime-issued SELECT grants with nonowner grantor and their prerequisite grant options',async()=>{
  await f.owner.execute(sql`GRANT SELECT ON public.routine_original_payment_evidence,public.routine_payment_account_policy,
   public.routine_payment_account_use TO ${sql.identifier(f.binding.admin)} WITH GRANT OPTION`);
  await f.peers.admin.db.execute(sql`GRANT SELECT ON public.routine_original_payment_evidence,public.routine_payment_account_policy,
   public.routine_payment_account_use TO ${sql.identifier(f.binding.financial)}`);
  const rows=await f.owner.execute<{grantor:string;grantee:string}>(sql`SELECT pg_get_userbyid(a.grantor) AS grantor,pg_get_userbyid(a.grantee) AS grantee
   FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid='public.routine_original_payment_evidence'::regclass
   AND a.grantee=${f.binding.financialOid}::oid AND a.privilege_type='SELECT'`);
  expect(rows).toContainEqual({grantor:f.binding.admin,grantee:f.binding.financial});
  await denyUnchanged(f,()=>commission(f));
 },5000);
 it('rejects a column-only reader privilege even when the table-only predecessor matrix still matches',async()=>{
  await f.owner.execute(sql`GRANT SELECT(payload) ON public.routine_original_payment_evidence TO ${sql.identifier(f.binding.admin)}`);
  try {
   expect(await inspectRoutineRefundSourceAclMatrix(f.owner,names(f),[])).toBe(true);await denyUnchanged(f,()=>commission(f));
  } finally {await f.owner.execute(sql`REVOKE SELECT(payload) ON public.routine_original_payment_evidence FROM ${sql.identifier(f.binding.admin)}`);}
 },5000);
 it('rejects extra source UPDATE authority',async()=>{
  await grant(f,f.binding.admin,'UPDATE',[rechargeRefundSourceTables[0]]);await denyUnchanged(f,()=>commission(f));
 },5000);
 it('does not learn a replacement App identity from a new INSERT grantee',async()=>{
  await f.owner.execute(sql`REVOKE INSERT ON public.routine_original_payment_evidence FROM ${sql.identifier(f.binding.app)}`);
  try {await grant(f,f.binding.admin,'SELECT,INSERT',[rechargeRefundSourceTables[0]]);await denyUnchanged(f,()=>commission(f));}
  finally {await f.owner.execute(sql`GRANT INSERT ON public.routine_original_payment_evidence TO ${sql.identifier(f.binding.app)}`);}
 },5000);
 it('rejects source column drift after the exact ACL predecessor passes',async()=>{
  await f.exec('ALTER TABLE public.routine_original_payment_evidence ALTER COLUMN order_no DROP NOT NULL');
  try {expect(await inspectRoutineRefundSourceAclMatrix(f.owner,names(f),[])).toBe(true);await denyUnchanged(f,()=>commission(f));}
  finally {await f.exec('ALTER TABLE public.routine_original_payment_evidence ALTER COLUMN order_no SET NOT NULL');}
 },5000);
 it('rejects source immutable-function body drift without replacing it',async()=>{
  await f.exec('CREATE OR REPLACE FUNCTION public.routine_original_payment_evidence_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN RETURN OLD; END$$');
  try {await denyUnchanged(f,()=>commission(f));}
  finally {await f.exec('CREATE OR REPLACE FUNCTION public.routine_original_payment_evidence_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$'+ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_IMMUTABLE_BODY+'$$');}
 },5000);
 it('rejects a source owner different from the bound maintenance OID',async()=>{
  await f.owner.execute(sql`ALTER TABLE public.routine_original_payment_evidence OWNER TO ${sql.identifier(f.binding.manager)}`);
  try {await denyUnchanged(f,()=>commission(f));}
  finally {await f.owner.execute(sql`ALTER TABLE public.routine_original_payment_evidence OWNER TO ${sql.identifier(f.binding.maintenance)}`);}
 },5000);
 for(const field of ['databaseOid','adminOid'] as const)it('rejects a reviewed declaration with wrong '+field,async()=>{
  await denyUnchanged(f,()=>runRechargeRefundSourceReaderCommission(f.owner,{...f.binding,[field]:'4294967295'}));
 },5000);
 it('rejects an actual stored binding OID drift without repairing COMMENT or ACLs',async()=>{
  const [row]=await f.owner.execute<{comment:string}>(sql`SELECT obj_description('public.recharge_refund_operation'::regclass,'pg_class') AS comment`);
  const changed={...JSON.parse(row.comment),adminOid:'4294967295'};
  await f.exec("COMMENT ON TABLE public.recharge_refund_operation IS '"+JSON.stringify(changed).replaceAll("'","''")+"'");
  try {await denyUnchanged(f,()=>commission(f));}
  finally {await f.exec("COMMENT ON TABLE public.recharge_refund_operation IS '"+row.comment.replaceAll("'","''")+"'");}
 },5000);
 it('captures primitive declarations before BEGIN can yield',async()=>{
  const input={...f.binding},pending=runRechargeRefundSourceReaderCommission(f.owner,input);input.app=f.binding.manager;input.adminOid='4294967295';
  expect(await pending).toMatchObject({binding:f.binding,replayed:false,grantedPrivileges:6});
 },5000);
 it('rejects an accessor declaration without invoking it or changing the catalog',async()=>{
  let invoked=false;const input={...f.binding};Object.defineProperty(input,'app',{enumerable:true,get(){invoked=true;return f.binding.app;}});
  await denyUnchanged(f,()=>runRechargeRefundSourceReaderCommission(f.owner,input));expect(invoked).toBe(false);
 },5000);
 it('rejects an actual runtime LOGIN attempting maintenance commissioning',async()=>{
  await denyUnchanged(f,()=>runRechargeRefundSourceReaderCommission(f.peers.admin.db,f.binding));
 },5000);
 for(const key of [731714,731717,731718,731729])it('refuses the actual busy '+key+' gate without changing source grants',async()=>{
  await f.withMaintenancePeer(db=>db.transaction(async tx=>{
   await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},0)`);await denyUnchanged(f,()=>commission(f));
  }));
 },5000);
 it('refuses a conflicting physical source lock NOWAIT and leaves all catalog/data unchanged',async()=>{
  await f.withMaintenancePeer(db=>db.transaction(async tx=>{
   await tx.execute(sql`LOCK TABLE public.routine_original_payment_evidence IN ACCESS SHARE MODE`);
   const before=await rechargeRefundSourceSnapshot(f.owner);await expect(commission(f)).rejects.toMatchObject({cause:{code:'55P03'}});
   expect(await rechargeRefundSourceSnapshot(f.owner)).toBe(before);
  }));
 },5000);
 it('rolls all six actually executed SELECT grants back when the real owning transaction fails before COMMIT',async()=>{
  const before=await rechargeRefundSourceSnapshot(f.owner),traced=observeSourceCommissionRoot(f.owner,async tx=>{
   expect(await inspectRoutineRefundSourceAclMatrix(tx,names(f),readers(f))).toBe(true);
   const [row]=await tx.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid IN('public.routine_original_payment_evidence'::regclass,'public.routine_payment_account_policy'::regclass,'public.routine_payment_account_use'::regclass)
    AND a.grantee IN(${f.binding.adminOid}::oid,${f.binding.financialOid}::oid) AND a.privilege_type='SELECT'`);
   expect(row.n).toBe(6);throw Error('owned failure after six real grants');
  });
  await expect(runRechargeRefundSourceReaderCommission(traced.db,f.binding)).rejects.toThrow('owned failure after six real grants');
  expect(traced.statements.filter(s=>/^\s*GRANT\b/u.test(s))).toHaveLength(6);
  expect(await rechargeRefundSourceSnapshot(f.owner)).toBe(before);
 },5000);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('recharge source SELECT union with the formally commissioned fixed Financial goods predecessor',()=>{
 let f:RechargeRefundSourceReaderFixture,goods:RechargeRefundSourceGoodsDeclaration;
 // Existing full canonical/fixed-role factory and formal source/profile
 // successors retain their established setup budget; each case stays 5s.
 beforeAll(async()=>{
  const previous=await customerCashierRuntimeHttpFixture();
  try {
   await runRoutineOriginalPaymentEvidenceUpgrade(previous.maintenanceDb,previous.target,previous.peers,previous.appReaders);
   await runRoutinePaymentAccountPolicyUpgrade(previous.maintenanceDb,previous.target,previous.peers,previous.appReaders);
   await runRoutineRefundUpgrade(previous.maintenanceDb,previous.target,previous.peers,previous.appReaders);
   const old=await upgradeCustomerFinancialRoutineRefund(previous.maintenanceDb,previous.target,
    {routineRefund:{routineRefund:true},manualRefund:previous.manual,originalPaymentReaders:previous.readers},previous.peers,previous.appReaders);
   expect(old.applied).toBe(true);
   expect(await auditCustomerFinancialRuntimePrivileges(previous.financialRuntime.db,previous.target,previous.manual,previous.readers,{routineRefund:true})).toMatchObject({ready:true,realLogin:true});
   for(const [kind,peer] of [['app',previous.appRuntime],['admin',previous.adminRuntime]] as const)
    expect(await auditRuntimeBusinessPrivileges(peer.db,kind,previous.target,undefined,old.peers,kind==='app'?previous.appReaders:undefined)).toMatchObject({ready:true,failures:[]});
   f=await rechargeRefundSourceReaderFixture({owner:previous.maintenanceDb,exec:previous.exec,close:previous.close,
    app:previous.appRuntime,sourcesInstalled:true});
   const catalog=await inspectRoutineRefundCatalog(f.owner);if(!catalog.ready||!catalog.binding)throw Error('Real complete goods predecessor required');
   goods=catalog.binding;expect(goods.financial).toBe(previous.financialRuntime.role);expect(goods.financialOid).not.toBe(f.binding.financialOid);
  } catch(error){await previous.close();throw error;}
 },180000);
 beforeEach(async()=>{await f.resetReaders();await sourceReady(f);});
 afterAll(async()=>{await f?.close();},30000);
 it('preserves the complete goods-only predecessor before adding the independently bound union',async()=>{
  expect((await inspectRoutineRefundCatalog(f.owner)).ready).toBe(true);
  const before=await rechargeRefundSourceSnapshot(f.owner,false);
  expect(await commission(f,goods)).toMatchObject({replayed:false,grantedPrivileges:6});
  expect(await rechargeRefundSourceSnapshot(f.owner,false)).toBe(before);await sourceReady(f);
  expect((await inspectRoutineRefundCatalog(f.owner)).binding).toEqual(goods);
  expect(await readRoutineRefundSourceReaders(f.owner,names(f))).toEqual([...readers(f),goods.financial!].sort());
 },5000);
 it('replays the exact declared union with zero GRANT and identical catalog/data xmin',async()=>{
  await commission(f,goods);const before=await rechargeRefundSourceSnapshot(f.owner),traced=observeSourceCommissionRoot(f.owner);
  expect(await runRechargeRefundSourceReaderCommission(traced.db,f.binding,goods)).toMatchObject({replayed:true,grantedPrivileges:0});
  expect(traced.statements.filter(s=>/^\s*GRANT\b/u.test(s))).toEqual([]);expect(await rechargeRefundSourceSnapshot(f.owner)).toBe(before);
 },5000);
 it('does not adopt existing goods readers when the independent goods declaration is omitted',async()=>{
  await denyUnchanged(f,()=>commission(f));
 },5000);
 it('rejects a changed explicitly declared goods actor OID without repairing the old predecessor',async()=>{
  await denyUnchanged(f,()=>commission(f,{...goods,financialOid:'4294967295'}));
 },5000);
});
