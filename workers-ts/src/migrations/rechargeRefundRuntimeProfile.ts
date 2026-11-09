/** Explicit closed successor for reviewed runtime profiles.
 * No full-role audit is called here: gift peer/profile proofs must terminate at
 * this independent catalog leaf. Installed objects never imply declaration. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';
import { inspectRechargeRefundCatalog } from './rechargeRefundCatalog';
import { inspectRechargeRoutineRefundAccountCatalog } from './rechargeRoutineRefundAccount';
import { RECHARGE_REFUND_RUNTIME_TABLE_PRIVILEGES, RECHARGE_REFUND_STATE_UPDATE_COLUMNS } from './rechargeRefundContract';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from './routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from './routinePaymentAccountPolicy';
import { inspectRoutineRefundCatalog } from './routineRefund';
import { inspectRoutineRefundSourceAclMatrix } from './routineRefundActorAddon';

type Query=Pick<DbClient,'execute'>;
export interface RechargeRefundRuntimeAddon { readonly rechargeRefund:true }
export const RECHARGE_REFUND_PROFILE_FUNCTIONS=[
 'recharge_refund_valid_v1(text, jsonb)',
 'recharge_refund_lock_source_v1(integer)',
] as const;
const sourceTables=['routine_original_payment_evidence','routine_payment_account_policy','routine_payment_account_use'] as const;
export function captureRechargeRefundRuntimeAddon(value:RechargeRefundRuntimeAddon):Readonly<RechargeRefundRuntimeAddon> {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
  throw Error('Exact recharge refund runtime declaration required');
 const d=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(d).length!==1||!d.rechargeRefund?.enumerable||!('value'in d.rechargeRefund)||d.rechargeRefund.value!==true)
  throw Error('Exact recharge refund runtime declaration required');
 return Object.freeze({rechargeRefund:true as const});
}

/** Extend a fresh historical plan only after explicit declaration. Never use
 * this compiler to learn current grants, add broad business writes or repair. */
export function applyRechargeRefundRuntimePlan(plan:RuntimePrivilegePlan,kind:'app'|'admin'|'financial'):void {
 for(const [table,privileges]of Object.entries(RECHARGE_REFUND_RUNTIME_TABLE_PRIVILEGES[kind]))plan.tables[table]=[...privileges];
 plan.updateColumns.recharge_refund_state=[...RECHARGE_REFUND_STATE_UPDATE_COLUMNS];
 plan.tables.recharge_routine_refund_account_policy=['SELECT'];
 for(const table of sourceTables)plan.tables[table]=[...new Set([...(plan.tables[table]??[]),'SELECT' as const])];
 plan.functions=[...new Set([...plan.functions,...RECHARGE_REFUND_PROFILE_FUNCTIONS])];
}

/** Scope/identity comes from reviewed fixed profiles and the full four-table
 * binding, never a new SELECT grantee. Account/old-source inspectors do not
 * call whole-profile auditors, so the peer proof cannot recurse. */
export async function inspectRechargeRefundRuntimeProfile(tx:Query,target:RoutinePaymentRuntimeTarget,
 input:RechargeRefundRuntimeAddon) {
 captureRechargeRefundRuntimeAddon(input);
 const failures:string[]=[],check=(name:string,ok:boolean)=>{if(!ok)failures.push(name);};
 const refund=await inspectRechargeRefundCatalog(tx),b=refund.binding;
 check('commissioned_catalog',refund.commissioned&&!!b);
 if(!b)return{ready:false,failures,binding:null,lockSourceFunctionOid:null,validFunctionOid:null};
 check('target_binding',b.database===target.database&&b.maintenance===target.maintenance&&b.app===target.app&&b.admin===target.admin
  &&b.financial===CUSTOMER_FINANCIAL_RUNTIME_ROLE&&b.manager===MANAGER_RUNTIME_ROLE
  &&target.local?.includes(b.financial)===true&&target.local?.includes(b.manager)===true);
 const account=await inspectRechargeRoutineRefundAccountCatalog(tx);
 check('account_catalog',account.ready&&!!account.binding&&Object.entries(b).every(([key,value])=>
  account.binding?.[key as keyof typeof b]===value));
 const original=await inspectRoutineOriginalPaymentEvidenceCatalog(tx),payment=await inspectRoutinePaymentAccountPolicyCatalog(tx);
 for(const [name,catalog]of [['original',original],['payment',payment]] as const)
  check(name+'_catalog',catalog.ready&&catalog.binding?.maintenance===b.maintenance&&catalog.binding?.maintenanceOid===b.maintenanceOid
   &&catalog.binding?.app===b.app&&catalog.binding?.appOid===b.appOid);
 const goods=await inspectRoutineRefundCatalog(tx),g=goods.binding;
 check('goods_catalog',!goods.present||goods.ready&&!!g&&g.maintenance===b.maintenance&&g.maintenanceOid===b.maintenanceOid
  &&g.app===b.app&&g.appOid===b.appOid);
 const previous=goods.present&&goods.ready&&g?[...(g.financial?[g.financial]:[]),
  ...(g.adminRefund&&g.admin?[g.admin]:[]),...(g.manager?[g.manager]:[])]:[];
 check('source_select_union',await inspectRoutineRefundSourceAclMatrix(tx,{maintenance:b.maintenance,app:b.app},
  [...new Set([...previous,b.admin,b.financial])].sort()));
 // These are the actual tables read by the quote/admission/cancel source and
 // fresh Admin author. Reuse existing closed business privileges; do not grant
 // UPDATE merely to take locks. The purpose-specific definer owns source locks.
 const business=['user','user_recharge','user_bill','store_order','other_order','store_order_outbox',
  'payment_callback_event','payment_reconciliation_case','system_admin','system_role','system_menus'];
 const [owners]=await tx.execute<{safe:boolean}>(sql`SELECT count(*)=${business.length} AND bool_and(
  c.relowner::text=${b.maintenanceOid} AND c.relkind='r' AND c.relpersistence='p' AND NOT(c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid)) AS safe
  FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
  AND c.relname IN(${sql.join(business.map(name=>sql`${name}`),sql`,`)})`);
 check('business_source_owners',owners?.safe===true);
 const functions=await tx.execute<{oid:string;name:string;security:boolean}>(sql`SELECT p.oid::text AS oid,p.proname AS name,p.prosecdef AS security
  FROM pg_catalog.pg_proc p WHERE p.oid IN(pg_catalog.to_regprocedure('public.recharge_refund_valid_v1(text,jsonb)'),
   pg_catalog.to_regprocedure('public.recharge_refund_lock_source_v1(integer)'))`);
 const lock=functions.find(f=>f.name==='recharge_refund_lock_source_v1'),valid=functions.find(f=>f.name==='recharge_refund_valid_v1');
 check('proved_functions',functions.length===2&&lock?.security===true&&valid?.security===false);
 const ready=!failures.length;
 return{ready,failures,binding:b,lockSourceFunctionOid:ready?lock!.oid:null,validFunctionOid:ready?valid!.oid:null};
}
