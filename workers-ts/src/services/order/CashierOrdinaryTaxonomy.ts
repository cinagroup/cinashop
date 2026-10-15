import {eq,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder} from '@/models/schema';
import {ValidateException} from '@/utils/errors';
import {acquireCustomerProductCatalogLock} from '@/migrations/runCustomerProductCatalogLock';
import {acquireCustomerUserCatalogLock} from '@/migrations/runCustomerUserCatalogLock';
import {cashierOrdinaryCreationFacts,readCashierOrdinaryConsumerOrigin,type CashierOrdinaryCreationCapability} from './CashierOrdinaryOrigin';

type Kind='category'|'level'|'label';
declare const proofBrand:unique symbol;
export interface OrdinaryTaxonomyProof{readonly[proofBrand]:true}
const issued=new WeakMap<object,{tx:object;kind:Kind;ids:string}>();
const invalid=()=>new ValidateException('普通收银税目锁与实际来源无法核对');
async function acquire(tx:DbClient,kind:Kind,ids:readonly number[]){
 if(Object.hasOwn(tx,'$client')||ids.length>10000||ids.some((id,i)=>!Number.isSafeInteger(id)||id<1||id>2147483647||(i>0&&id<=ids[i-1]!)))throw invalid();
 // Each mature routine takes SHARE on its entire fixed catalog and locks every
 // row (including ancestors). Its bounded target list does not reduce that
 // fence. One call therefore protects every ID for the fresh SELECT below.
 if(kind==='category')await acquireCustomerProductCatalogLock(tx,'category',ids.slice(0,100));
 else await acquireCustomerUserCatalogLock(tx,kind,ids.slice(0,100));
 const proof=Object.freeze({}) as OrdinaryTaxonomyProof;issued.set(proof,{tx,kind,ids:JSON.stringify(ids)});return proof;
}
export async function lockOrdinaryCheckoutTaxonomy(tx:DbClient,capability:CashierOrdinaryCreationCapability,kind:'category'|'level',ids:readonly number[]){
 if(!cashierOrdinaryCreationFacts(capability))throw invalid();
 return acquire(tx,kind,ids);
}
export async function lockOrdinaryPaidLabels(tx:DbClient,input:{id?:number;uid:number;pid:number;paid:number;promotionsGive:string|null},ids:readonly number[]){
 if(!Number.isSafeInteger(input.id)||!input.id||input.id<1)return null;
 const[root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,input.id)).limit(1);
 if(!root||root.isChannel!==2||root.productType!==0||root.type!==0)return null;
 // Older mature application LOGINs intentionally have no new-realm grants.
 // Inspect permission metadata before reading any protected ordinary table;
 // this is a precise old-profile boundary, never an error-catching fallback.
 const[rights]=await tx.execute<{readable:boolean}>(sql`SELECT count(*)=4 AND bool_and(has_table_privilege(current_user,c.oid,'SELECT')) AS readable
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN('cashier_ordinary_draft_v1','cashier_ordinary_cart_v1','cashier_ordinary_operation_v1','cashier_ordinary_origin_v1')`);
 if(rights?.readable!==true)return null;
 const saved=await readCashierOrdinaryConsumerOrigin(tx,root);if(!saved)return null;
 if(root.uid!==input.uid||root.pid!==input.pid||root.paid!==input.paid||root.promotionsGive!==input.promotionsGive)throw invalid();
 return acquire(tx,'label',ids);
}
export function assertOrdinaryTaxonomyProof(tx:object,proof:OrdinaryTaxonomyProof,kind:Kind,ids:readonly number[]){
 const facts=issued.get(proof);if(!facts||facts.tx!==tx||facts.kind!==kind||facts.ids!==JSON.stringify(ids))throw invalid();
}
