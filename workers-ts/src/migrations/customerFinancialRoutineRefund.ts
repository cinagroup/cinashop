import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query=Pick<DbClient,'execute'>;
export interface CustomerFinancialRoutineRefundAddon { routineRefund:true }
export const CUSTOMER_FINANCIAL_ROUTINE_REFUND_SOURCE_TABLES=[
 'routine_original_payment_evidence','routine_payment_account_policy','routine_payment_account_use',
] as const;
export const CUSTOMER_FINANCIAL_ROUTINE_REFUND_TABLE_PRIVILEGES={
 routine_original_payment_evidence:['SELECT'],routine_payment_account_policy:['SELECT'],routine_payment_account_use:['SELECT'],
 routine_refund_account_policy:['SELECT'],routine_refund_dispatch:['SELECT','INSERT'],routine_refund_provider_evidence:['SELECT','INSERT'],
} as const;
export function captureCustomerFinancialRoutineRefund(value:CustomerFinancialRoutineRefundAddon):CustomerFinancialRoutineRefundAddon {
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==1
  ||Object.getOwnPropertyDescriptor(value,'routineRefund')?.value!==true)throw Error('Explicit complete Routine refund Financial addon required');
 return{routineRefund:true};
}

/** Leaf proof used by the two historical catalog inspectors. It never calls
 * them recursively and accepts only the joint canonical three-table addon
 * plus exactly the three declared immutable source reads. No ACL discovery. */
export async function inspectCustomerFinancialRoutineRefundReaders(tx:Query,names:{maintenance:string;app:string}):Promise<boolean> {
 const {inspectRoutineRefundCatalog}=await import('./routineRefund');
 const catalog=await inspectRoutineRefundCatalog(tx),b=catalog.binding;
 if(!catalog.ready||b?.maintenance!==names.maintenance||b.app!==names.app||b.financial!==CUSTOMER_FINANCIAL_RUNTIME_ROLE||!b.financialOid)return false;
 return inspectCustomerFinancialRoutineRefundSourceAcls(tx,names);
}
export async function inspectCustomerFinancialRoutineRefundSourceAcls(tx:Query,names:{maintenance:string;app:string}):Promise<boolean> {
 for(const table of CUSTOMER_FINANCIAL_ROUTINE_REFUND_SOURCE_TABLES) {
  const [row]=await tx.execute<{owner:string;grants:unknown}>(sql`SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner,
   COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.rolname,a.privilege_type,a.is_grantable,pg_catalog.pg_get_userbyid(a.grantor))
    ORDER BY r.rolname COLLATE "C",a.privilege_type COLLATE "C")
    FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
    WHERE a.grantee<>c.relowner),'[]'::jsonb) AS grants FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass(${`public.${table}`})`);
  const appPrivileges=table==='routine_payment_account_policy'?['SELECT']:['INSERT','SELECT'];
  const expected:Array<[string,string,boolean,string]>=appPrivileges.map(p=>[names.app,p,false,names.maintenance]);
  expected.push([CUSTOMER_FINANCIAL_RUNTIME_ROLE,'SELECT',false,names.maintenance]);
  expected.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0);
  if(row?.owner!==names.maintenance||JSON.stringify(row.grants)!==JSON.stringify(expected))return false;
 }
 return true;
}

export async function inspectCustomerFinancialRoutineRefund(tx:Query,options:{maintenance:string;app:string;admin:string;
 addon:CustomerFinancialRoutineRefundAddon;requirePrivileges:boolean}) {
 captureCustomerFinancialRoutineRefund(options.addon);
 [options.maintenance,options.app,options.admin].forEach(pricingIdentifier);
 if(typeof options.requirePrivileges!=='boolean')throw Error('Explicit Routine refund Financial inspection stage required');
 const {inspectRoutineRefundCatalog}=await import('./routineRefund');
 const {inspectRoutineOriginalPaymentEvidenceCatalog}=await import('./routineOriginalPaymentEvidence');
 const {inspectRoutinePaymentAccountPolicyCatalog}=await import('./routinePaymentAccountPolicy');
 const names={maintenance:options.maintenance,app:options.app,admin:options.admin};
 const refund=await inspectRoutineRefundCatalog(tx,names),original=await inspectRoutineOriginalPaymentEvidenceCatalog(tx,names),
  account=await inspectRoutinePaymentAccountPolicyCatalog(tx,names);
 const failures:string[]=[];
 if(!refund.ready)failures.push('refund_catalog');if(!original.ready)failures.push('original_catalog');if(!account.ready)failures.push('account_catalog');
 if(options.requirePrivileges) {
  if(!await inspectCustomerFinancialRoutineRefundReaders(tx,names))failures.push('joint_source_readers');
 }else {
  if(refund.binding?.financial!==null)failures.push('existing_financial_addon');
  const [extra]=await tx.execute<{safe:boolean}>(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
   CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
   WHERE c.oid IN(pg_catalog.to_regclass('public.routine_original_payment_evidence'),pg_catalog.to_regclass('public.routine_payment_account_policy'),pg_catalog.to_regclass('public.routine_payment_account_use'))
   AND a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${CUSTOMER_FINANCIAL_RUNTIME_ROLE})) AS safe`);
  if(extra?.safe!==true)failures.push('partial_source_readers');
 }
 return{ready:!failures.length,catalogReady:refund.ready&&original.ready&&account.ready,failures,
  sourceWritesGranted:false as const,completeServiceCoverageVerified:false as const,
  binding:refund.binding};
}
