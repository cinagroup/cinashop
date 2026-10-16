import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder,storeOrderStatus,storeOrderOutbox} from '@/models/schema';
import {ValidateException} from '@/utils/errors';
import {outRequestHash,normalizeOutRequestKey} from '@/services/out/OutIdempotency';
import {financialRecord,financialId,financialHash} from '@/services/customer-work/CustomerWorkFinancialProtocol';
import {customerManualManagerOriginReadiness} from '@/migrations/customerManualOfflineOriginCatalog';
import {parseSupplierOfflinePaymentOrigin,readSupplierOfflinePaymentOrigin,type SupplierOfflinePaymentOrigin} from '@/services/supplier/SupplierOfflinePaymentOrigin';
export const CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION='customer-manual-offline-payment-origin-v2' as const;
const managerVersion='merchant-order-operation-v1' as const;
type Order=typeof storeOrder.$inferSelect;
type Audit=typeof storeOrderStatus.$inferSelect;
type Event=typeof storeOrderOutbox.$inferSelect;
const bad=()=>new ValidateException('人工退款原线下付款来源、完整原请求或只读权限无法核对');
function fact(ok:unknown):asserts ok{if(!ok)throw bad();}
function timestamp(value:unknown):string{
 fact(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value));
 const milliseconds=value.slice(0,23)+'Z',parsed=new Date(milliseconds);
 fact(Number.isFinite(parsed.getTime())&&parsed.toISOString()===milliseconds);return value;
}
interface OriginalManagerIntent{version:typeof managerVersion;store_id:number;scope_key:string;order_id:number;expected_order_revision:string;payload:Record<string,never>}
interface OriginalManagerReceipt{
 actor_uid:number;request_key:string;request_hash:string;store_id:number;staff_id:number;order_id:number;kind:'confirm_offline';outcome:'offline-paid';scope_key:string;expected_revision:string;
 intent:OriginalManagerIntent;evidence:{order_id:number;outbox_id:number};created_at:string;
}
export type CustomerManualOfflineOrigin=
 |SupplierOfflinePaymentOrigin
 |{version:typeof CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION;kind:'manager_order_offline';primary_audit_id:number;actor_uid:number;receipt:OriginalManagerReceipt}
 |{version:typeof CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION;kind:'admin_order_offline';primary_audit_id:number;admin_id:number};
async function managerReceipt(value:unknown):Promise<OriginalManagerReceipt>{
 const r=financialRecord(value,['actor_uid','request_key','request_hash','store_id','staff_id','order_id','kind','outcome','scope_key','expected_revision','intent','evidence','created_at']);
 fact(r.kind==='confirm_offline'&&r.outcome==='offline-paid');
 const actor_uid=financialId(r.actor_uid),store_id=financialId(r.store_id),staff_id=financialId(r.staff_id,true),order_id=financialId(r.order_id),request_hash=financialHash(r.request_hash),scope_key=financialHash(r.scope_key),expected_revision=financialHash(r.expected_revision);
 const request_key=normalizeOutRequestKey(r.request_key);fact(request_key===r.request_key);
 const i=financialRecord(r.intent,['version','store_id','scope_key','order_id','expected_order_revision','payload']);
 fact(i.version===managerVersion&&i.store_id===store_id&&i.order_id===order_id&&i.scope_key===scope_key&&i.expected_order_revision===expected_revision);financialRecord(i.payload,[]);
 const intent:OriginalManagerIntent={version:managerVersion,store_id,order_id,scope_key,expected_order_revision:expected_revision,payload:{}};
 const e=financialRecord(r.evidence,['order_id','outbox_id']),outbox_id=financialId(e.outbox_id);fact(e.order_id===order_id);
 // These revisions describe the original unpaid order and then-current scope.
 // Their full immutable intent/hash is proof; today's paid root or roles cannot
 // reproduce them and must never retroactively revoke a genuine payment.
 fact(await outRequestHash({version:managerVersion,actor_uid,kind:'confirm_offline',input:intent})===request_hash);
 return{actor_uid,request_key,request_hash,store_id,staff_id,order_id,kind:'confirm_offline',outcome:'offline-paid',scope_key,expected_revision,intent,evidence:{order_id,outbox_id},created_at:timestamp(r.created_at)};
}
/** Only newly introduced origins use this strict nested version. Published
 * cashier/customer/PHP objects and their existing hashes are not rewritten. */
export async function parseCustomerManualOfflineOrigin(value:unknown):Promise<CustomerManualOfflineOrigin>{
 fact(value&&typeof value==='object'&&!Array.isArray(value));const discriminator=value as Record<string,unknown>;
 if(discriminator.kind==='supplier_order_offline')return parseSupplierOfflinePaymentOrigin(value);
 if(discriminator.kind==='manager_order_offline'){
  const r=financialRecord(value,['version','kind','primary_audit_id','actor_uid','receipt']);fact(r.version===CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION);
  const actor_uid=financialId(r.actor_uid),receipt=await managerReceipt(r.receipt);fact(receipt.actor_uid===actor_uid);
  return{version:CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION,kind:'manager_order_offline',primary_audit_id:financialId(r.primary_audit_id),actor_uid,receipt};
 }
 const r=financialRecord(value,['version','kind','primary_audit_id','admin_id']);fact(r.version===CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION&&r.kind==='admin_order_offline');
 return{version:CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION,kind:'admin_order_offline',primary_audit_id:financialId(r.primary_audit_id),admin_id:financialId(r.admin_id)};
}
export async function readCustomerManualOfflineOrigin(db:DbClient,root:Order,primary:Audit,event:Event):Promise<CustomerManualOfflineOrigin>{
 if(primary.changeType==='supplier_order_offline')return readSupplierOfflinePaymentOrigin(db,root,primary,event);
 fact(root.payType==='offline'&&primary.changeTime===root.payTime&&root.paid===1&&root.payTime>0&&event.status==='COMPLETED');
 const payload=financialRecord(event.payload,['orderId','orderNo']);fact(payload.orderId===root.id&&payload.orderNo===root.orderId);
 if(primary.changeType==='admin_order_offline'){
  const match=/^管理员 ([1-9][0-9]*) 确认订单线下收款$/.exec(primary.changeMessage);fact(match);
  return parseCustomerManualOfflineOrigin({version:CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION,kind:'admin_order_offline',primary_audit_id:primary.id,admin_id:financialId(Number(match[1]))});
 }
 fact(primary.changeType==='manager_order_offline');
 // Predictable catalog/SELECT/authority loss is a local unavailable action,
 // before any ledger SELECT can fail as a raw permission exception. Real SQL
 // and transport failures are not turned into fabricated rejection receipts.
 const readiness=await customerManualManagerOriginReadiness(db);fact(readiness.ready);
 const rows=await db.execute<Record<string,unknown>>(sql`SELECT actor_uid,request_key::text,request_hash,store_id,staff_id,order_id,kind,outcome,scope_key,expected_revision,intent,evidence,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
 FROM public.manager_order_operation_request WHERE order_id=${root.id} AND kind='confirm_offline' AND outcome='offline-paid' ORDER BY actor_uid,request_key LIMIT 2`);
 fact(rows.length===1);const receipt=await managerReceipt(rows[0]);
 // PG clock_timestamp and the worker's payTime use independent clocks. Freeze
 // the exact recorded timestamp; their ordering is not a payment predicate.
 fact(receipt.order_id===root.id&&receipt.store_id===root.storeId&&receipt.evidence.outbox_id===event.id
  &&primary.changeMessage===`用户 ${receipt.actor_uid} / 门店 ${receipt.store_id} / 员工 ${receipt.staff_id} 确认实际线下收款`);
 return parseCustomerManualOfflineOrigin({version:CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION,kind:'manager_order_offline',primary_audit_id:primary.id,actor_uid:receipt.actor_uid,receipt});
}
