import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';

type Query=Pick<DbClient,'execute'>;
export type RoutineRefundRuntimeRole='app'|'financial'|'admin'|'manager';
export interface RoutineRefundActorAddons {admin?:true;manager?:true}
export const ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES={
 routine_original_payment_evidence:['SELECT'],routine_payment_account_policy:['SELECT'],routine_payment_account_use:['SELECT'],
 routine_refund_account_policy:['SELECT'],routine_refund_dispatch:['SELECT','INSERT'],routine_refund_provider_evidence:['SELECT','INSERT'],
} as const;
const sourceTables=['routine_original_payment_evidence','routine_payment_account_policy','routine_payment_account_use'] as const;

/** A complete successor declaration, never an ACL-derived list of actors. */
export function captureRoutineRefundActorAddons(value:RoutineRefundActorAddons):RoutineRefundActorAddons {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
  throw Error('Explicit Routine refund actor declaration required');
 const keys=Reflect.ownKeys(value),ds=Object.getOwnPropertyDescriptors(value);
 if(!keys.length||keys.length>2||keys.some(k=>typeof k!=='string'||!['admin','manager'].includes(k)
  ||!ds[k]?.enumerable||!('value'in ds[k])||ds[k].value!==true))throw Error('Exact Routine refund actor flags required');
 return{...(ds.admin?{admin:true as const}:{}),...(ds.manager?{manager:true as const}:{})};
}

/** The historical use journal has exactly one nonowner INSERT principal: App.
 * New actors can only read it. This is a candidate for later canonical catalog
 * validation, never proof that any other grantee is Admin or Manager. */
export async function routineRefundSourceAppCandidate(tx:Query):Promise<{maintenance:string;app:string;appOid:string}|null> {
 const rows=await tx.execute<{maintenance:string;app:string;appOid:string;safe:boolean}>(sql`SELECT
  pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,r.rolname AS app,r.oid::text AS "appOid",
  a.grantor=c.relowner AND NOT a.is_grantable AND a.grantee<>0 AS safe
  FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
  WHERE c.oid=pg_catalog.to_regclass('public.routine_payment_account_use')
   AND a.grantee<>c.relowner AND a.privilege_type='INSERT' LIMIT 2`);
 if(rows.length!==1||rows[0].safe!==true)return null;
 return{maintenance:rows[0].maintenance,app:rows[0].app,appOid:rows[0].appOid};
}

/** Leaf ACL matrix: callers supply only independently proved closed principals.
 * It never invokes source/refund inspectors, so the joint proof cannot recurse. */
export async function inspectRoutineRefundSourceAclMatrix(tx:Query,names:{maintenance:string;app:string},readers:readonly string[]):Promise<boolean> {
 try{[names.maintenance,names.app,...readers].forEach(pricingIdentifier);}catch{return false;}
 if(new Set([names.maintenance,names.app,...readers]).size!==2+readers.length)return false;
 for(const table of sourceTables){
  const [row]=await tx.execute<{owner:string;grants:unknown}>(sql`SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner,
   COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.rolname,a.privilege_type,a.is_grantable,pg_catalog.pg_get_userbyid(a.grantor))
    ORDER BY r.rolname COLLATE "C",a.privilege_type COLLATE "C")
    FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
    WHERE a.grantee<>c.relowner),'[]'::jsonb) AS grants FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass(${`public.${table}`})`);
  const expected:Array<[string,string,boolean,string]>=(table==='routine_payment_account_policy'?['SELECT']:['INSERT','SELECT'])
   .map(p=>[names.app,p,false,names.maintenance] as [string,string,boolean,string]);
  expected.push(...readers.map(role=>[role,'SELECT',false,names.maintenance] as [string,string,boolean,string]));
  expected.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0);
  if(row?.owner!==names.maintenance||JSON.stringify(row.grants)!==JSON.stringify(expected))return false;
 }
 return true;
}

/** Used only when an old source has extra readers. The complete refund catalog
 * proves the named actor identities and all three refund ACLs before the old
 * source accepts those exact SELECT deltas. No arbitrary grantee is adopted. */
export async function readRoutineRefundSourceReaders(tx:Query,names:{maintenance:string;app:string}):Promise<string[]|null> {
 const {inspectRoutineRefundCatalog}=await import('./routineRefund');
 const c=await inspectRoutineRefundCatalog(tx),b=c.binding;
 if(!c.ready||b?.maintenance!==names.maintenance||b.app!==names.app)return null;
 const readers=[...(b.financial===CUSTOMER_FINANCIAL_RUNTIME_ROLE?[b.financial]:[]),
  ...(b.adminRefund&&b.admin?[b.admin]:[]),...(b.manager?[b.manager]:[])];
 if(!readers.length||!await inspectRoutineRefundSourceAclMatrix(tx,names,readers))return null;
 return readers;
}

export async function inspectRoutineRefundActorAddon(tx:Query,names:{maintenance:string;app:string;admin:string},kind:'admin'|'manager') {
 const {inspectRoutineRefundCatalog}=await import('./routineRefund');
 const {inspectRoutineOriginalPaymentEvidenceCatalog}=await import('./routineOriginalPaymentEvidence');
 const {inspectRoutinePaymentAccountPolicyCatalog}=await import('./routinePaymentAccountPolicy');
 const catalog=await inspectRoutineRefundCatalog(tx,names),b=catalog.binding;
 if(!catalog.ready||!b||(kind==='admin'?!b.adminRefund||b.admin!==names.admin:!b.manager))return false;
 return(await inspectRoutineOriginalPaymentEvidenceCatalog(tx,names)).ready
  &&(await inspectRoutinePaymentAccountPolicyCatalog(tx,names)).ready;
}
