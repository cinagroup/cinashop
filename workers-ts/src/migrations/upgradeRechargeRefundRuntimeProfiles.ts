/** Compose the entire reviewed ACL successor in one owning transaction.
 * No business grants or provider calls. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { captureRechargeRefundJson, captureRechargeRefundScope } from '@/services/payment/RechargeRefundJournalCodec';
import type { RechargeRefundBinding } from './rechargeRefundContract';
import { inspectRechargeRefundCatalog } from './rechargeRefundCatalog';
import { commissionRechargeRefundRuntimeInTransaction } from './rechargeRefundRuntimeCommission';
import { commissionRechargeRefundSourceReadersInTransaction, captureRechargeRefundSourceGoodsDeclaration, type RechargeRefundSourceGoodsDeclaration } from './rechargeRefundSourceReaderCommission';
import { installRechargeRoutineRefundAccountInTransaction, inspectRechargeRoutineRefundAccountCatalog } from './rechargeRoutineRefundAccount';
import { captureRechargeRefundRuntimeAddon, inspectRechargeRefundRuntimeProfile, type RechargeRefundRuntimeAddon } from './rechargeRefundRuntimeProfile';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectCustomerFinancialRuntimePrivileges } from './auditCustomerFinancialRuntimePrivileges';
import { inspectManagerRuntimePrivileges } from './auditManagerRuntimePrivileges';
import { inspectCustomerCashierSecondCardRuntimePrivileges } from './auditCustomerCashierSecondCardRuntimePrivileges';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { inspectRoutineRefundCatalog } from './routineRefund';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';
import { CUSTOMER_FINANCIAL_PROVISION_GATE } from './provisionCustomerFinancialRuntime';
import { FULFILLMENT_CITY_CONFLICT_GATE } from './fulfillmentCityConflictReader';
import { STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE } from './storeOrderFulfillmentAssignment';
import { MANAGER_ASSIGNED_FULFILLMENT_GATE } from './managerAssignedFulfillment';

type Query=Pick<DbClient,'execute'>;
export const RECHARGE_REFUND_RUNTIME_PROFILE_UPGRADE='recharge-refund-runtime-profiles-v1';
// Dedicated gate for this complete runtime-profile successor.
export const RECHARGE_REFUND_RUNTIME_PROFILE_GATE=[731732,0] as const;
export interface RechargeRefundRuntimeProfileInput {
 readonly binding:RechargeRefundBinding;
 readonly target:RoutinePaymentRuntimeTarget;
 readonly addon:RechargeRefundRuntimeAddon;
 readonly peers:RuntimeGiftPeerDeclarations;
 readonly appReader?:RuntimeAppCashierOriginReaderAddon;
 readonly goods?:RechargeRefundSourceGoodsDeclaration;
}
const fail=(reason:string):never=>{throw Error('Recharge refund runtime profile forward refused: '+reason);};
const canonical=(v:unknown):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
function capture(input:RechargeRefundRuntimeProfileInput) {
 const r=captureRechargeRefundJson(input) as unknown as RechargeRefundRuntimeProfileInput;
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(key=>!['binding','target','addon','peers','appReader','goods'].includes(key)))
  return fail('exact profile forward fields');
 const b=captureRechargeRefundScope(r.binding),p=captureRuntimeGiftPeerDeclarations(r.peers),addon=captureRechargeRefundRuntimeAddon(r.addon);
 const t=p.target,rt={database:r.target.database,maintenance:r.target.maintenance,app:r.target.app,admin:r.target.admin,
  ...(r.target.local?{local:[...r.target.local]}:{}),...(r.target.caseLock?{caseLock:{owner:r.target.caseLock.owner,runtimeRoles:[...r.target.caseLock.runtimeRoles]}}:{})};
 if(canonical(rt)!==canonical(t)||!p.rechargeRefund||canonical(p.rechargeRefund)!==canonical(addon)
  ||!p.financial||p.manager!==true||!p.cashierSecondCard||!t.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE)
  ||t.local?.includes(MANAGER_RUNTIME_ROLE)!==true)return fail('complete exact existing five-profile successor declarations');
 if(b.database!==t.database||b.maintenance!==t.maintenance||b.app!==t.app||b.admin!==t.admin
  ||b.financial!==CUSTOMER_FINANCIAL_RUNTIME_ROLE||b.manager!==MANAGER_RUNTIME_ROLE)return fail('reviewed binding differs from published profile names');
 const {rechargeRefund:_,...previous}=p;
 return {binding:b,target:t,addon,beforePeers:previous as RuntimeGiftPeerDeclarations,afterPeers:p,
  reader:r.appReader===undefined?undefined:captureRuntimeAppCashierOriginReader(r.appReader),
  goods:captureRechargeRefundSourceGoodsDeclaration(r.goods,b)};
}
async function context(tx:Query,b:RechargeRefundBinding) {
 if(Object.hasOwn(tx,'$client'))return fail('caller-owned transaction required');
 await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
 await tx.execute(sql`SET LOCAL row_security TO off`);await tx.execute(sql`SET LOCAL standard_conforming_strings TO on`);
 await tx.execute(sql`SELECT
  pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
 const [r]=await tx.execute<{safe:boolean}>(sql`SELECT current_database()=${b.database}
  AND (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database())=${b.databaseOid}
  AND current_user=session_user AND current_user=${b.maintenance} AND current_setting('role')='none'
  AND r.oid::text=${b.maintenanceOid} AND r.rolcanlogin AND r.rolsuper
  AND (SELECT count(*)=5 AND count(DISTINCT actual.oid)=5
   AND bool_and(actual.oid IS NOT NULL AND actual.oid::text=declared.expected_oid)
   FROM (VALUES (${b.maintenance},${b.maintenanceOid}),(${b.app},${b.appOid}),
    (${b.admin},${b.adminOid}),(${b.financial},${b.financialOid}),(${b.manager},${b.managerOid}))
    AS declared(name,expected_oid)
   LEFT JOIN pg_catalog.pg_roles actual ON actual.rolname=declared.name)
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid() AND usesysid=r.oid)
  AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
  AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS safe
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
 if(r?.safe!==true)return fail('direct PG16 maintenance LOGIN/database/context');
}
async function profiles(tx:Query,c:ReturnType<typeof capture>,p:RuntimeGiftPeerDeclarations) {
 const t=c.target,financial=p.financial!,cashier=p.cashierSecondCard!;
 const app=await inspectRuntimeBusinessProfileInTransaction(tx,'app',t,'current',p,c.reader);
 const admin=await inspectRuntimeBusinessProfileInTransaction(tx,'admin',t,'current',p);
 const money=await inspectCustomerFinancialRuntimePrivileges(tx,{requireLogin:true,routine:{target:t,stage:'ready'},
  ...financial,...(p.rechargeRefund?{rechargeRefund:p.rechargeRefund}:{})});
 const manager=await inspectManagerRuntimePrivileges(tx,{requireLogin:true,routine:{target:t,stage:'ready'},
  ...(p.routineRefundActors?.manager?{routineRefund:true}:{}),...(p.cityConflictReaders?.manager?{cityConflictReaders:p.cityConflictReaders}:{}),
  ...(p.fulfillmentAssignments?{fulfillmentAssignments:p.fulfillmentAssignments}:{}),
  ...(p.managerAssignedWholeExpress?{managerAssignedWholeExpress:p.managerAssignedWholeExpress}:{})});
 const cash=await inspectCustomerCashierSecondCardRuntimePrivileges(tx,{role:cashier.role,requireLogin:true,routine:{target:t,stage:'ready'},
  abandon:true,...(cashier.conditionalGuards?{conditionalGuards:true}:{}),...(cashier.formImages?{formImages:true}:{})});
 const results={app,admin,financial:money,manager,cashier:cash};
 return{ready:Object.values(results).every(r=>r.ready),failures:Object.entries(results).flatMap(([kind,r])=>r.failures.map(name=>kind+':'+name))};
}
async function run(tx:Query,c:ReturnType<typeof capture>) {
 await context(tx,c.binding);
 // Existing cross-profile order; all try-only and before physical resources.
 // The complete existing addon declarations pass through without modification.
 for(const[key,subkey]of[[731669,0],[731670,0],[731625,2],[731624,0],CUSTOMER_FINANCIAL_PROVISION_GATE,[731685,0],[731812,1],
  [731714,0],[731717,0],[731718,0],[731719,0],[731735,0],FULFILLMENT_CITY_CONFLICT_GATE,[731722,0],
  STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE,MANAGER_ASSIGNED_FULFILLMENT_GATE,[731729,0],[731731,0],RECHARGE_REFUND_RUNTIME_PROFILE_GATE]) {
  const [g]=await tx.execute<{held:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${key},${subkey}) AS held`);
  if(g?.held!==true)return fail('existing/runtime/source/account maintenance gate busy');
 }
 if(c.goods){const goods=await inspectRoutineRefundCatalog(tx);
  if(!goods.ready||canonical(goods.binding)!==canonical(c.goods))return fail('reviewed goods declaration differs from the full catalog');}
 const final=await inspectRechargeRefundRuntimeProfile(tx,c.target,c.addon);
 if(final.ready) {
  if(canonical(final.binding)!==canonical(c.binding))return fail('reviewed binding OID differs');
  await tx.execute(sql`LOCK TABLE ONLY public.recharge_refund_operation,ONLY public.recharge_refund_attempt,
   ONLY public.recharge_refund_result,ONLY public.recharge_refund_state,ONLY public.recharge_routine_refund_account_policy,
   ONLY public.routine_original_payment_evidence,ONLY public.routine_payment_account_policy,ONLY public.routine_payment_account_use
   IN ACCESS SHARE MODE NOWAIT`);
  const locked=await inspectRechargeRefundRuntimeProfile(tx,c.target,c.addon),repeated=await profiles(tx,c,c.afterPeers);
  if(!locked.ready||canonical(locked.binding)!==canonical(c.binding)||!repeated.ready)return fail('complete replay refused: '+repeated.failures.join(','));
  await context(tx,c.binding);
  return{operation:RECHARGE_REFUND_RUNTIME_PROFILE_UPGRADE,applied:false as const,binding:c.binding,peers:c.afterPeers};
 }
 const installed=await inspectRechargeRefundCatalog(tx),account=await inspectRechargeRoutineRefundAccountCatalog(tx);
 if(!installed.installed||installed.commissioned||installed.binding!==null||account.present)return fail('only exact staged owner-only ledger plus absent account namespace can advance');
 await tx.execute(sql`LOCK TABLE ONLY public.recharge_refund_operation,ONLY public.recharge_refund_attempt,
  ONLY public.recharge_refund_result,ONLY public.recharge_refund_state,ONLY public.routine_original_payment_evidence,
  ONLY public.routine_payment_account_policy,ONLY public.routine_payment_account_use IN ACCESS EXCLUSIVE MODE NOWAIT`);
 await tx.execute(sql`LOCK TABLE ONLY public.system_admin,ONLY public.system_role,ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
 const previous=await profiles(tx,c,c.beforePeers);
 if(!previous.ready)return fail('complete exact predecessor profiles: '+previous.failures.join(','));
 // These are extracted existing authors; no nested transactions/savepoints.
 // Any later refusal rolls binding, SELECTs, new DDL and ACLs back together.
 await commissionRechargeRefundRuntimeInTransaction(tx,c.binding);
 await installRechargeRoutineRefundAccountInTransaction(tx,c.binding);
 await commissionRechargeRefundSourceReadersInTransaction(tx,c.binding,c.goods);
 const post=await inspectRechargeRefundRuntimeProfile(tx,c.target,c.addon),after=await profiles(tx,c,c.afterPeers);
 if(!post.ready||canonical(post.binding)!==canonical(c.binding)||!after.ready)return fail('final whole successor: '+[...post.failures,...after.failures].join(','));
 await context(tx,c.binding);
 return{operation:RECHARGE_REFUND_RUNTIME_PROFILE_UPGRADE,applied:true as const,binding:c.binding,peers:c.afterPeers};
}
export async function upgradeRechargeRefundRuntimeProfiles(root:DbClient,input:RechargeRefundRuntimeProfileInput) {
 const c=capture(input),client=Object.getOwnPropertyDescriptor(root,'$client');
 if(!client||!('value'in client)||!client.value||typeof client.value.begin!=='function')return fail('root postgres-js connection');
 return root.transaction(tx=>run(tx,c),{isolationLevel:'read committed',accessMode:'read write'});
}
