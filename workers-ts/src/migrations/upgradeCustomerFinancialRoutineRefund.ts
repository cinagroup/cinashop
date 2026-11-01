import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { CUSTOMER_FINANCIAL_PROVISION_GATE } from './provisionCustomerFinancialRuntime';
import { inspectCustomerFinancialRuntimePrivileges, type CustomerFinancialManualRefundAddon } from './auditCustomerFinancialRuntimePrivileges';
import { captureCustomerFinancialOriginalPaymentReaders, type CustomerFinancialOriginalPaymentReadersAddon } from './customerFinancialOriginalPaymentReaders';
import { captureCustomerFinancialRoutineRefund, inspectCustomerFinancialRoutineRefund,
 CUSTOMER_FINANCIAL_ROUTINE_REFUND_TABLE_PRIVILEGES, type CustomerFinancialRoutineRefundAddon } from './customerFinancialRoutineRefund';
import { inspectRoutineRefundCatalog } from './routineRefund';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';

type Query=Pick<DbClient,'execute'>;
export interface CustomerFinancialRoutineRefundDeclaration {
 routineRefund:CustomerFinancialRoutineRefundAddon;
 manualRefund?:CustomerFinancialManualRefundAddon;
 originalPaymentReaders?:CustomerFinancialOriginalPaymentReadersAddon;
}
export const CUSTOMER_FINANCIAL_ROUTINE_REFUND_UPGRADE='customer-financial-routine-refund-v1';
function capture(target:RoutinePaymentRuntimeTarget,input:CustomerFinancialRoutineRefundDeclaration,
 peers:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon) {
 const declaredPeers=captureRuntimeGiftPeerDeclarations(peers),t:RoutinePaymentRuntimeTarget={database:target.database,maintenance:target.maintenance,
  app:target.app,admin:target.admin,...(target.local?{local:[...target.local]}:{}),
  ...(target.caseLock?{caseLock:{owner:target.caseLock.owner,runtimeRoles:[...target.caseLock.runtimeRoles]}}:{})};
 for(const name of[t.database,t.maintenance,t.app,t.admin,...(t.local??[]),...(t.caseLock?[t.caseLock.owner,...t.caseLock.runtimeRoles]:[])])pricingIdentifier(name);
 if(!t.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE)||[t.maintenance,t.app,t.admin,...(t.caseLock?.runtimeRoles??[])].includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE)
  ||new Set([t.maintenance,t.app,t.admin,...t.local]).size!==3+t.local.length)throw Error('Explicit distinct Financial Routine binding required');
 const binding=(v:RoutinePaymentRuntimeTarget)=>JSON.stringify([v.database,v.maintenance,v.app,v.admin,[...(v.local??[])].sort(),
  v.caseLock?[v.caseLock.owner,[...v.caseLock.runtimeRoles].sort()]:null]);
 if(binding(t)!==binding(declaredPeers.target)||!declaredPeers.financial)throw Error('Complete exact Financial peer declaration required');
 if(!input||typeof input!=='object'||Array.isArray(input)
  ||Reflect.ownKeys(input).some(k=>typeof k!=='string'||!['routineRefund','manualRefund','originalPaymentReaders'].includes(k))
  ||Object.values(Object.getOwnPropertyDescriptors(input)).some(d=>!d.enumerable||!('value'in d)))throw Error('Explicit Financial refund forward declaration required');
 const routineRefund=captureCustomerFinancialRoutineRefund(input.routineRefund);
 if(input.manualRefund!==undefined&&(!input.manualRefund||typeof input.manualRefund!=='object'||Reflect.ownKeys(input.manualRefund).length!==1
  ||!Object.getOwnPropertyDescriptor(input.manualRefund,'promotionOwner')?.enumerable
  ||typeof Object.getOwnPropertyDescriptor(input.manualRefund,'promotionOwner')?.value!=='string'))throw Error('Exact manual Financial promotion owner required');
 const manualRefund=input.manualRefund?{promotionOwner:input.manualRefund.promotionOwner}:undefined;
 if(manualRefund)pricingIdentifier(manualRefund.promotionOwner);
 const originalPaymentReaders=input.originalPaymentReaders===undefined?undefined:captureCustomerFinancialOriginalPaymentReaders(input.originalPaymentReaders);
 if(JSON.stringify(manualRefund)!==JSON.stringify(declaredPeers.financial.manualRefund)
  ||JSON.stringify(originalPaymentReaders)!==JSON.stringify(declaredPeers.financial.originalPaymentReaders))throw Error('Financial previous profile declarations must match peers');
 const previous={...(manualRefund?{manualRefund}:{}),...(originalPaymentReaders?{originalPaymentReaders}:{})};
 const beforePeers={...declaredPeers,financial:previous},afterPeers={...declaredPeers,financial:{...previous,routineRefund}};
 return{target:t,previous,routineRefund,beforePeers,afterPeers,reader:reader?captureRuntimeAppCashierOriginReader(reader):undefined};
}
/** The entire previous Financial profile, exact old sources and both complete
 * App/Admin profiles precede the atomic six-table ACL forward. No source DML,
 * history adoption, provider operation, base-plan change or partial repair. */
export async function upgradeCustomerFinancialRoutineRefundInTransaction(tx:Query,target:RoutinePaymentRuntimeTarget,
 input:CustomerFinancialRoutineRefundDeclaration,peers:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon) {
 if(Object.hasOwn(tx,'$client'))throw Error('Caller-owned Financial refund maintenance transaction required');
 const c=capture(target,input,peers,reader),t=c.target;
 await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true),
  pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
 const [identity]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_database()=${t.database} AND current_user=${t.maintenance}
  AND current_user=session_user AND pg_catalog.current_schema()='public'
  AND pg_catalog.current_setting('server_version_num')::integer/10000=16
  AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
  AND pg_catalog.current_setting('session_replication_role')='origin' AND r.rolsuper AND r.rolcanlogin
  AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
 if(identity?.ready!==true)throw Error('Actual PG16 maintenance LOGIN/database refused');
 // Keep the existing Financial provision hierarchy, then old source gates and
 // the new addon gate. Every acquisition is try-only; no waiting lock cycle.
 for(const[key,subkey]of[[731669,0],[731670,0],CUSTOMER_FINANCIAL_PROVISION_GATE,[731714,0],[731717,0],[731718,0]]) {
  const[g]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
  if(g?.locked!==true)throw Error('Financial refund forward is busy');
 }
 await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_original_payment_evidence, ONLY public.routine_payment_account_policy, ONLY public.routine_payment_account_use, '
  +'ONLY public.routine_refund_account_policy, ONLY public.routine_refund_dispatch, ONLY public.routine_refund_provider_evidence, '
  +'ONLY public.customer_financial_operation_request IN ACCESS EXCLUSIVE MODE NOWAIT'));
 if(!(await inspectRoutinePaymentRuntime(tx,t)).ready)throw Error('Existing Financial Routine binding refused');
 const inspectFinancial=(addon:boolean)=>inspectCustomerFinancialRuntimePrivileges(tx,{requireLogin:true,routine:{target:t,stage:'ready'},
  ...c.previous,...(addon?{routineRefund:c.routineRefund}:{})});
 const inspectBusiness=async(addon:boolean)=>({
  app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',t,'current',addon?c.afterPeers:c.beforePeers,c.reader),
  admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',t,'current',addon?c.afterPeers:c.beforePeers),
 });
 const existing=await inspectFinancial(true);
 if(existing.ready){const p=await inspectBusiness(true);if(!p.app.ready||!p.admin.ready)throw Error('Complete repeated refund profiles refused');
  return{operation:CUSTOMER_FINANCIAL_ROUTINE_REFUND_UPGRADE,applied:false as const,target:t,routineRefund:c.routineRefund,peers:c.afterPeers};}
 const previous=await inspectFinancial(false),profiles=await inspectBusiness(false);
 if(!previous.ready||!profiles.app.ready||!profiles.admin.ready)throw Error('Exact previous Financial/App/Admin profiles required; partial addon is not repaired');
 const names={maintenance:t.maintenance,app:t.app,admin:t.admin};
 if(!(await inspectCustomerFinancialRoutineRefund(tx,{...names,addon:c.routineRefund,requirePrivileges:false})).ready)throw Error('Complete canonical original/refund sources required');
 const before=await inspectRoutineRefundCatalog(tx,names);
 if(!before.ready||before.binding?.financial!==null)throw Error('Unexpected refund source binding');
 for(const[table,privileges]of Object.entries(CUSTOMER_FINANCIAL_ROUTINE_REFUND_TABLE_PRIVILEGES))
  await tx.execute(sql.raw(`GRANT ${privileges.join(',')} ON TABLE public.${pricingIdentifier(table)} TO ${pricingIdentifier(CUSTOMER_FINANCIAL_RUNTIME_ROLE)}`));
 const after=await inspectFinancial(true),afterProfiles=await inspectBusiness(true);
 if(!after.ready||!afterProfiles.app.ready||!afterProfiles.admin.ready)throw Error('Final complete Financial refund profiles refused');
 return{operation:CUSTOMER_FINANCIAL_ROUTINE_REFUND_UPGRADE,applied:true as const,target:t,routineRefund:c.routineRefund,peers:c.afterPeers};
}
export async function upgradeCustomerFinancialRoutineRefund(db:DbClient,target:RoutinePaymentRuntimeTarget,
 input:CustomerFinancialRoutineRefundDeclaration,peers:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon) {
 if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Root Financial refund maintenance connection required');
 const c=capture(target,input,peers,reader);
 return db.transaction(tx=>upgradeCustomerFinancialRoutineRefundInTransaction(tx,c.target,{...c.previous,routineRefund:c.routineRefund},c.afterPeers,c.reader),
  {isolationLevel:'read committed',accessMode:'read write'});
}
