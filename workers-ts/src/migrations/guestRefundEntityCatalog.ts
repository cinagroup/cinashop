import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {INVOICE_CATALOG_VERSIONS,INVOICE_EVIDENCE_STATE_SQL,INVOICE_EVIDENCE_CATALOG_SQL} from './invoiceEvidenceCatalog';
import {REFUND_SPLIT_CATALOG_VERSIONS,REFUND_SPLIT_STATE_SQL,REFUND_SPLIT_CATALOG_SQL} from './refundOrderSplitCatalog';
import {GUEST_REFUND_ENTITY_PINS} from './guestRefundEntityPins';

const shared={store_order_invoice:INVOICE_CATALOG_VERSIONS.capturedBase,capture_invoice_evidence:INVOICE_CATALOG_VERSIONS.capture,protect_invoice_evidence:INVOICE_CATALOG_VERSIONS.protect,protect_refund_order_split:REFUND_SPLIT_CATALOG_VERSIONS.protect};
/** Eight complete catalog components, one coherent generation at a time. */
export const REFUND_ENTITY_CATALOG_PROFILES=Object.freeze({
 legacy:Object.freeze({...shared,store_order_invoice_evidence:INVOICE_CATALOG_VERSIONS.history,store_order_invoice_allocation:INVOICE_CATALOG_VERSIONS.allocation,store_order_refund_split:REFUND_SPLIT_CATALOG_VERSIONS.split,store_order_fulfillment_branch:REFUND_SPLIT_CATALOG_VERSIONS.branch}),
 guest:Object.freeze({...shared,store_order_invoice_evidence:GUEST_REFUND_ENTITY_PINS.historyGuest,store_order_invoice_allocation:GUEST_REFUND_ENTITY_PINS.allocationGuest,store_order_refund_split:GUEST_REFUND_ENTITY_PINS.splitGuest,store_order_fulfillment_branch:GUEST_REFUND_ENTITY_PINS.branchGuest}),
});
export type RefundEntityProfile='legacy'|'guest'|'drift';
export function refundEntityCatalogProfile(fingerprints:ReadonlyMap<string,string>):RefundEntityProfile{
 for(const name of['legacy','guest'] as const){const expected=Object.entries(REFUND_ENTITY_CATALOG_PROFILES[name]);if(fingerprints.size===expected.length&&expected.every(([key,pin])=>/^[a-f0-9]{64}$/.test(pin)&&fingerprints.get(key)===pin))return name;}
 return'drift';
}
const exact=(name:string,pin:string)=>`(objects->'${name}') @> '${JSON.stringify({present:true,owned:true,safe:true,fingerprint:pin})}'::jsonb`;
const invoiceGuest=Object.entries(REFUND_ENTITY_CATALOG_PROFILES.guest).filter(([name])=>!['store_order_refund_split','store_order_fulfillment_branch','protect_refund_order_split'].includes(name)).map(([name,pin])=>exact(name,pin)).join(' AND ');
const splitGuest=Object.entries(REFUND_ENTITY_CATALOG_PROFILES.guest).filter(([name])=>['store_order_refund_split','store_order_fulfillment_branch','protect_refund_order_split'].includes(name)).map(([name,pin])=>exact(name,pin)).join(' AND ');
/** Published state/installer strings remain byte-for-byte unchanged. These
 * additional states never accept mixed old/guest relation fingerprints. */
export const GUEST_INVOICE_EVIDENCE_STATE_SQL=INVOICE_EVIDENCE_STATE_SQL.replace("WHEN components<>5 THEN 'drift'",()=>`WHEN components<>5 THEN 'drift' WHEN ${invoiceGuest} THEN 'v3'`);
export const GUEST_REFUND_SPLIT_STATE_SQL=REFUND_SPLIT_STATE_SQL.replace("WHEN components<>3 THEN 'drift'",()=>`WHEN components<>3 THEN 'drift' WHEN ${splitGuest} THEN 'v2'`);
export function refundEntityAcceptedPairSql(runtimeOwner=false):string{
 let query=`SELECT i.state AS invoice,r.state AS split,CASE WHEN i.state='v2' AND r.state='v1' THEN 'legacy' WHEN i.state='v3' AND r.state='v2' THEN 'guest' ELSE 'drift' END AS profile FROM (${GUEST_INVOICE_EVIDENCE_STATE_SQL}) i CROSS JOIN (${GUEST_REFUND_SPLIT_STATE_SQL}) r`;
 if(runtimeOwner){const owner="owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned";if(!query.includes(owner))throw Error('Refund entity ownership projection changed');query=query.replaceAll(owner,"owner=(SELECT relowner FROM pg_catalog.pg_class WHERE oid=to_regclass('public.store_order_invoice')) AS owned");}
 return query;
}
export async function customerManualGuestIdentityReadiness(db:Pick<DbClient,'execute'>){
 const rows=await db.execute<{invoice:string;split:string;profile:RefundEntityProfile}>(sql.raw(refundEntityAcceptedPairSql(true)));
 return{ready:rows.length===1&&rows[0].profile==='guest',state:rows[0]??null};
}
/** Owner-only commissioning evidence. All component metadata, not source rows. */
export async function inspectGuestRefundEntityCatalog(db:Pick<DbClient,'execute'>){
 const invoice=await db.execute<Record<string,unknown>>(sql.raw(INVOICE_EVIDENCE_CATALOG_SQL)),split=await db.execute<Record<string,unknown>>(sql.raw(REFUND_SPLIT_CATALOG_SQL));return[...invoice,...split];
}
