import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder,storeOrderCartInfo,storeOrderInvoice} from '@/models/schema';
import type {RefundMaterializationIdentity} from '@/services/order/RefundOrderSplitIdentity';
import {refundOrderSplitFingerprint} from '@/services/order/RefundOrderSplitIdentity';
import {readRefundQuantityReservation,refundClaimCartKey} from '@/services/order/RefundQuantityReservation';
import {assertUnissuedInvoiceHistory} from '@/services/order/InvoiceIssuanceEvidence';
import {invoiceHasReportedHistory,readInvoiceManualDisposition,readSupplierProactiveInvoiceOperation,SUPPLIER_WHOLE_INVOICE_VERSION,
 assertSupplierProactiveInvoiceOrderIdentity,type ManualInvoiceDisposition} from '@/services/order/InvoiceManualRedNoteEvidence';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {ValidateException} from '@/utils/errors';
import {authorizeSupplierProactiveRefundApplication,assertSupplierProactiveRefundAuthority,
 type SupplierProactiveRefundApplicationCapability,type SupplierProactiveRefundAuthorization} from './SupplierProactiveRefundCapability';
import {planSupplierProactiveWholeInvoice} from './SupplierProactiveRefundInvoicePlan';
import {supplierProactiveRefundJson} from './SupplierProactiveRefundInput';

type Order=typeof storeOrder.$inferSelect;type Cart=typeof storeOrderCartInfo.$inferSelect;type Invoice=typeof storeOrderInvoice.$inferSelect;
interface Transaction extends Record<string,unknown>{transaction_id:string;backend_id:number}
interface Prepared {transaction:Transaction;cap:SupplierProactiveRefundApplicationCapability;authorization:SupplierProactiveRefundAuthorization;
 order:Order;carts:Cart[];original:Invoice;manual:ManualInvoiceDisposition|null;plan:ReturnType<typeof planSupplierProactiveWholeInvoice>}
const preparedInvoices=new WeakMap<Invoice,Prepared>();
const invalid=()=>new ValidateException('主动整单退款原票、数量或原操作证明不完整，请核对原请求');
const fact=(condition:unknown):void=>{if(!condition)throw invalid();};
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const orderIds=(order:Order)=>order.pid>0?[order.pid,order.id]:[order.id];
async function transaction(tx:DbClient){
 fact(!Object.hasOwn(tx,'$client'));
 const [row]=await tx.execute<Transaction>(sql`SELECT txid_current()::text AS transaction_id,pg_backend_pid() AS backend_id`);
 fact(row&&/^[1-9][0-9]*$/.test(row.transaction_id)&&Number.isSafeInteger(row.backend_id)&&row.backend_id>0);return row;
}
/** The opaque capability is checked against the complete phase source before
 * financial writes. A pure invoice plan is never execution authority. */
export async function prepareSupplierProactiveWholeInvoice(tx:DbClient,cap:SupplierProactiveRefundApplicationCapability,
 source:Order,selectedPayment:string,refundAmount:string):Promise<Invoice|null>{
 const identity=await transaction(tx);
 const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,source.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201).for('update');
 const authorization=await authorizeSupplierProactiveRefundApplication(tx,cap,source,carts);
 fact(carts.length>0&&carts.length<=200&&source.payPrice===selectedPayment);
 const rows=await tx.select().from(storeOrderInvoice).where(and(inArray(storeOrderInvoice.orderId,orderIds(source)),eq(storeOrderInvoice.isDel,0)))
  .orderBy(asc(storeOrderInvoice.id)).limit(3).for('update');
 if(!rows.length){await assertUnissuedInvoiceHistory(tx,source);return null;}
 fact(rows.length===1);const original=rows[0];
 await assertUnissuedInvoiceHistory(tx,source,original);
 const manual=await invoiceHasReportedHistory(tx,source)?await readInvoiceManualDisposition(tx,source):null;
 const plan=planSupplierProactiveWholeInvoice(source,carts,new Map(carts.map(row=>[row.id,row.cartNum])),original,refundAmount,manual);
 // Keep a detached original. Only this exact prepared object in this same DB
 // transaction can authorize the update; serialized snapshots cannot mint it.
 const prepared=Object.freeze(clone(original));
 fact(new TextEncoder().encode(JSON.stringify(prepared)).length<=16384);
 preparedInvoices.set(prepared,{transaction:identity,cap,authorization,order:clone(source),carts:clone(carts),original:clone(original),manual:clone(manual),plan});
 return prepared;
}
export function isSupplierProactiveWholeInvoice(prepared:Invoice|null|undefined):boolean{
 return !!prepared&&preparedInvoices.has(prepared);
}

/** Core has legitimately changed money and reservation state by now. Recheck
 * the real authority/transaction and immutable full-goods identity, not the
 * execution source hash from before those changes. No new late row locks. */
export async function materializeSupplierProactiveWholeInvoice(tx:DbClient,source:Order,refund:RefundMaterializationIdentity,
 prepared:Invoice,selectedOrderId:number,remainingOrderId:number|null):Promise<string>{
 const state=preparedInvoices.get(prepared);fact(state);
 if(!state)throw invalid();const current=await transaction(tx);
 fact(current.transaction_id===state.transaction.transaction_id&&current.backend_id===state.transaction.backend_id);
 const authorization=await assertSupplierProactiveRefundAuthority(tx,state.cap,source);
 fact(authorization===state.authorization&&authorization.phase==='execution'&&authorization.operationId&&authorization.requestHash
  &&authorization.intent&&authorization.intent.type===1&&authorization.intent.order_id===source.id
  &&authorization.intent.supplier_id===source.supplierId&&authorization.intent.refund_price===refund.refundPrice);
 const intent=authorization.intent;if(!intent||!authorization.operationId||!authorization.requestHash)throw invalid();
 fact(selectedOrderId===source.id&&remainingOrderId===null&&refund.storeOrderId===source.id&&refund.uid===source.uid
  &&refund.supplierId===source.supplierId&&refund.storeId===source.storeId&&refund.refundNum===state.plan.goods_quantity
  &&refund.refundPrice===state.plan.first_refunded&&source.totalNum===state.order.totalNum
  &&['id','pid','uid','supplierId','storeId','orderId','paid','payType','payTime','payPrice','totalNum'].every(key=>
    (source as unknown as Record<string,unknown>)[key]===(state.order as unknown as Record<string,unknown>)[key]));
 const claim=readRefundQuantityReservation(refund);
 fact(claim&&claim.items.length===state.carts.length&&claim.items.every(item=>{const row=state.carts.find(r=>r.id===item.rowId);
  return row&&row.cartId===refundClaimCartKey(item)&&row.oid===source.id&&row.uid===source.uid&&row.cartNum===item.totalNum
   &&item.beforeRefundNum===0&&item.cartNum===item.totalNum;}));
 const actualCarts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,source.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
 fact(actualCarts.length===state.carts.length);
 for(const before of state.carts){const actual=actualCarts.find(row=>row.id===before.id);fact(actual);
  if(!actual)throw invalid();
  for(const key of Object.keys(before) as Array<keyof Cart>){
   if(['refundNum','splitStatus','splitSurplusNum'].includes(key))continue;
   fact(actual[key]===before[key]);
  }
  fact(actual.refundNum===0&&actual.splitStatus===2&&actual.splitSurplusNum===0);
 }
 const rows=await tx.select().from(storeOrderInvoice).where(and(inArray(storeOrderInvoice.orderId,orderIds(source)),eq(storeOrderInvoice.isDel,0)))
  .orderBy(asc(storeOrderInvoice.id)).limit(3);
 fact(rows.length===1&&await outRequestHash(rows[0])===await outRequestHash(state.original));
 await assertUnissuedInvoiceHistory(tx,source,rows[0]);
 if(state.manual)fact(await outRequestHash(await readInvoiceManualDisposition(tx,source))===await outRequestHash(state.manual));
 else fact(!await invoiceHasReportedHistory(tx,source));
 const binding=await readSupplierProactiveInvoiceOperation(tx,{operationId:authorization.operationId,actorId:intent.actor_id,
  supplierId:intent.supplier_id,orderId:source.id,refundId:refund.id,requestHash:authorization.requestHash,
  firstRefunded:refund.refundPrice,original:state.original});
 assertSupplierProactiveInvoiceOrderIdentity(binding.order,state.order);
 assertSupplierProactiveInvoiceOrderIdentity(binding.order,source);
 fact(binding.carts.length===state.carts.length);
 for(const before of state.carts){const original=binding.carts.find(row=>row.id===before.id);fact(original);
  if(!original)throw invalid();for(const key of Object.keys(before) as Array<keyof Cart>){
   if(['refundNum','splitStatus','splitSurplusNum'].includes(key))continue;fact(original[key]===before[key]);
  }
 }
 const expected={...state.original,isRefund:1};
 const updated=await tx.update(storeOrderInvoice).set({isRefund:1}).where(and(eq(storeOrderInvoice.id,state.original.id),
  eq(storeOrderInvoice.orderId,source.id),eq(storeOrderInvoice.isRefund,0),eq(storeOrderInvoice.isDel,0))).returning();
 fact(updated.length===1&&await outRequestHash(updated[0])===await outRequestHash(expected));
 const [after]=await tx.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.id,state.original.id)).limit(1);
 fact(after&&await outRequestHash(after)===await outRequestHash(expected));
 if(state.manual)fact(await outRequestHash(await readInvoiceManualDisposition(tx,source))===await outRequestHash(state.manual));
 else fact(!await invoiceHasReportedHistory(tx,source));
 const receipt={version:SUPPLIER_WHOLE_INVOICE_VERSION,operation_id:authorization.operationId,actor_id:intent.actor_id,
  supplier_id:intent.supplier_id,request_hash:authorization.requestHash,source_hash:binding.sourceHash,
  sourceOrderId:source.id,paymentOrderId:source.pid||source.id,refundId:refund.id,fingerprint:await refundOrderSplitFingerprint(refund),
  original:state.original,after_hash:await outRequestHash(expected),selected:{invoiceId:state.original.id,orderId:source.id,amount:state.original.invoiceAmount},
  remaining:null,goods_quantity:state.plan.goods_quantity,first_refunded:state.plan.first_refunded,
  unreturned_payment:state.plan.unreturned_payment,manual_disposition:state.manual};
 const text=supplierProactiveRefundJson(receipt);fact(new TextEncoder().encode(text).length<=16384);return text;
}
