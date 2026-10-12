import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder,storeOrderCartInfo,storeOrderRefund,storeOrderRefundPayment,storeOrderStatus,storeOrderOutbox,user,userBill,userBrokerage} from '@/models/schema';
import {ValidateException} from '@/utils/errors';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {amountToCents} from '@/services/payment/RefundGateway';
import {assertCustomerManualRefundReady,inspectCustomerManualRefund} from '@/migrations/runCustomerManualRefund';
import {authorizeCustomerWorkActor,type CustomerWorkActor} from '@/services/customer-work/CustomerWorkScope';
import {authorizeCustomerOperationOwner,freezeCustomerActor} from '@/services/customer-work/CustomerWorkOperationRequest';
import {acquireCustomerWorkScopeLock} from '@/migrations/runCustomerWorkScopeLock';
import {financialRecord,validateFinancialPayload,type PreparedFinancialOperation,type FinancialInput} from '@/services/customer-work/CustomerWorkFinancialProtocol';
import {hasInitiatedAssistedProviderPayment} from '@/services/payment/AssistedProviderPaymentClaim';
import {readCashierSecondCardOrigin} from './CashierSecondCardOrigin';
import {readCustomerManualOfflineOrigin,parseCustomerManualOfflineOrigin,type CustomerManualOfflineOrigin} from './CustomerManualOfflineOrigin';
import {assertStoredManualInvoiceAllocation} from './InvoiceManualRedNoteEvidence';
type Order=typeof storeOrder.$inferSelect;type Cart=typeof storeOrderCartInfo.$inferSelect;type Refund=typeof storeOrderRefund.$inferSelect;
const bad=()=>new ValidateException('人工退款原付款、完整意图或实体来源无法核对');
const fact=(ok:unknown)=>{if(!ok)throw bad();};
export const isManualRefundOrder=(order:Pick<Order,'payType'>)=>['cash','offline'].includes(order.payType);
export function manualRefundCanonicalJson(value:unknown):string{if(value instanceof Date)return JSON.stringify(value.toISOString());if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(manualRefundCanonicalJson).join(',')}]`;const r=value as Record<string,unknown>;return`{${Object.keys(r).sort().map(k=>`${JSON.stringify(k)}:${manualRefundCanonicalJson(r[k])}`).join(',')}}`;}
/** uid0 is a buyer identity, never an account. Existing UID0 account/bill rows are
 * contradictory evidence, not permission to credit or deduct a synthetic user. */
export async function assertGuestRefundAccountless(db:DbClient,order:Order){
 if(order.uid!==0)return;
 fact(isManualRefundOrder(order)&&order.couponId===0&&amountToCents(order.useIntegral)===0&&order.payIntegral===0&&amountToCents(order.deductionPrice)===0&&amountToCents(order.gainIntegral)===0);
 const accounts=await db.select({uid:user.uid}).from(user).where(eq(user.uid,0)).limit(1),bills=await db.select({id:userBill.id}).from(userBill).where(eq(userBill.uid,0)).limit(1),brokerages=await db.select({id:userBrokerage.id}).from(userBrokerage).where(eq(userBrokerage.uid,0)).limit(1);
 fact(!accounts.length&&!bills.length&&!brokerages.length);
}
/** Standard cash/offline uses the actual paid root and its audit, including
 * legacy roots. No creator restriction or staff_id-derived authorization. */
export async function manualRefundPaymentFacts(db:DbClient,order:Order){
 fact(isManualRefundOrder(order)&&order.paid===1&&Number.isSafeInteger(order.uid)&&order.uid>=0);
 const id=order.pid>0?order.pid:order.id,roots=await db.select().from(storeOrder).where(eq(storeOrder.id,id)).limit(2);fact(roots.length===1);const root=roots[0];
 const rootAmount=amountToCents(root.payPrice),orderAmount=amountToCents(order.payPrice);
 fact(rootAmount!==null&&orderAmount!==null&&rootAmount>=orderAmount&&orderAmount>=0&&root.paid===1&&root.payTime>0&&root.uid===order.uid&&root.payType===order.payType&&(!order.pid||root.pid===-1)
  &&(root.storeId===order.storeId||root.supplierAllocationStatus===2)&&(root.supplierId===order.supplierId||root.supplierId===0&&root.supplierAllocationStatus===2));
 fact(!await hasInitiatedAssistedProviderPayment(db,root.orderId));
 // PHP queues OrderStatusJob after persisting paid/pay_time. The job's own
 // time() may be arbitrarily later; a guessed time window would reject valid
 // imported payments. Read the whole bounded payment history for this root,
 // then distinguish the actual legacy record from TS's atomic paid protocol.
 const audits=await db.select().from(storeOrderStatus).where(and(eq(storeOrderStatus.oid,root.id),inArray(storeOrderStatus.changeType,['pay_success','customer_cashier_paid','cw_financial_confirm_offline','manager_order_offline','admin_order_offline','offline','pay_cash']))).orderBy(asc(storeOrderStatus.id)).limit(201);
 fact(audits.length>0&&audits.length<=200&&audits.every(x=>x.changeMessage.trim().length>0));
 const events=await db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,`order.paid:${root.id}`)).limit(2);fact(events.length<=1);
 if(events.length){const event=events[0],payload=event.payload as {orderId?:unknown;orderNo?:unknown};fact(event.aggregateType==='order'&&event.aggregateId===root.id&&event.eventType==='order.paid'&&payload?.orderId===root.id&&payload.orderNo===root.orderId);}
 const tsAudits=audits.filter(x=>['customer_cashier_paid','cw_financial_confirm_offline','manager_order_offline','admin_order_offline'].includes(x.changeType));
 // New TS evidence cannot fall back to legacy admission after a missing event
 // or altered timestamp. PHP OrderStatusJob/saveStatus is not idempotent, so a
 // redelivered job can append repeated canonical success records. Every record
 // must attest this same paid root after pay_time; capture them all, rather
 // than mistaking queue repetition for another payment or choosing one row.
 let consumerCompletion:{status:'COMPLETED';processed_time:number;supplier_allocation:unknown|null}|null=null;
 let payment_origin:CustomerManualOfflineOrigin|null=null;
 if(tsAudits.length||events.length){
  fact(events.length===1&&tsAudits.length===1&&tsAudits[0].changeTime===root.payTime);
  const primary=tsAudits[0],event=events[0];
  if(primary.changeType==='customer_cashier_paid')fact(root.payType==='cash'&&/^客户 [1-9][0-9]* 确认次卡收银现金付款$/.test(primary.changeMessage));
  else if(primary.changeType==='cw_financial_confirm_offline')fact(root.payType==='offline'&&/^用户 [1-9][0-9]* \/ 原请求 [0-9a-f-]{36} 确认 confirm_offline$/.test(primary.changeMessage));
  else fact(root.payType==='offline');
  // The original TS consumer must have committed its purchase effects before
  // a new cash refund can freeze them. A pending outbox is a recoverable wait,
  // never permission to commit a proof that a later queue completion changes.
  const consumers=audits.filter(x=>x!==primary);fact(consumers.length===1);
  if(consumers.length){
   const consumer=consumers[0],splitMessage=/^订单支付成功，已生成 ([1-9][0-9]*) 个履约子单$/.exec(consumer.changeMessage);
   fact(consumer.changeType==='pay_success'&&consumer.changeTime>=root.payTime&&event.status==='COMPLETED'&&event.processedTime===consumer.changeTime);
   let supplierAllocation:unknown|null=null;
   // A refund also retires its source as pid=-1. The original consumer message
   // belongs to the payment allocation, not today's refund generation marker.
   if(consumer.changeMessage!=='订单支付成功，后置任务处理完成'){
    fact(splitMessage&&Number(splitMessage[1])<=200&&root.pid===-1&&root.supplierAllocationStatus===2&&root.supplierId===0);
    const count=Number(splitMessage![1]),allocation=await db.select().from(storeOrderStatus).where(and(eq(storeOrderStatus.oid,root.id),eq(storeOrderStatus.changeType,'supplier_order_split'))).orderBy(asc(storeOrderStatus.id)).limit(2);
    fact(allocation.length===1&&allocation[0].changeMessage===`支付后已拆分为 ${count} 个履约订单`&&allocation[0].changeTime===consumer.changeTime);
    const children=await db.select({audit:storeOrderStatus,order:storeOrder}).from(storeOrderStatus).innerJoin(storeOrder,eq(storeOrder.id,storeOrderStatus.oid))
     .where(and(eq(storeOrder.pid,root.id),eq(storeOrderStatus.changeType,'supplier_split_create_order'))).orderBy(asc(storeOrderStatus.id)).limit(201);
    fact(children.length===count&&new Set(children.map(x=>x.order.id)).size===count&&children.every(x=>x.order.uid===root.uid&&x.order.paid===1&&x.order.payType===root.payType&&x.order.payTime===root.payTime&&x.order.supplierAllocationStatus===2&&x.audit.changeTime===consumer.changeTime
     &&x.audit.changeMessage===(x.order.supplierId>0?'支付后按供应商自动拆单':'支付后拆出平台履约订单')));
    supplierAllocation={audit:allocation[0],children:children.map(x=>({audit:x.audit,order_id:x.order.id,order_no:x.order.orderId,buyer_uid:x.order.uid,pay_type:x.order.payType,pay_time:x.order.payTime,store_id:x.order.storeId,supplier_id:x.order.supplierId}))};
   }
   consumerCompletion={status:'COMPLETED',processed_time:event.processedTime,supplier_allocation:supplierAllocation};
  }
  if(['manager_order_offline','admin_order_offline'].includes(primary.changeType))payment_origin=await readCustomerManualOfflineOrigin(db,root,primary,event);
 }
 else fact(audits.every(x=>x.changeType==='pay_success'&&x.changeMessage==='用户付款成功'&&x.changeTime>=root.payTime));
 let origin_hash:string|null=null;
 if(audits.some(x=>x.changeType==='customer_cashier_paid')){const carts=await db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,root.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);const origin=await readCashierSecondCardOrigin(db,root,carts);fact(origin);origin_hash=origin!.origin_hash;}
 await assertGuestRefundAccountless(db,order);
 const payment={root_id:root.id,order_no:root.orderId,buyer_uid:root.uid,pay_type:root.payType,amount:root.payPrice,pay_time:root.payTime,store_id:root.storeId,supplier_id:root.supplierId,
  origin_hash,audits:audits.map(x=>({id:x.id,change_type:x.changeType,change_message:x.changeMessage,change_time:x.changeTime})),event:events.length?{id:events[0].id,payload:events[0].payload,consumer_completion:consumerCompletion}:null};
 // Do not add even a null field to an already-published payment object: its
 // exact bytes/hash remain the recovery contract for previous settlements.
 return payment_origin?{...payment,payment_origin}:payment;
}
/** New writes require the live original paid root. Receipt recovery deliberately
 * uses immutable payment facts alone, so deleting a root cannot erase a prior
 * owner's already-completed manual settlement proof. */
export async function manualRefundWriteFacts(db:DbClient,order:Order){
 const payment=await manualRefundPaymentFacts(db,order),rows=await db.select({isDel:storeOrder.isDel,isSystemDel:storeOrder.isSystemDel}).from(storeOrder).where(eq(storeOrder.id,payment.root_id)).limit(2);
 fact(rows.length===1&&!rows[0].isDel&&!rows[0].isSystemDel&&!order.isDel&&!order.isSystemDel);
 return payment;
}
async function source(db:DbClient,order:Order,carts?:Cart[]){const payment=await manualRefundPaymentFacts(db,order),rows=carts??await db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);fact(rows.length>0&&rows.length<=200&&rows.every(x=>x.oid===order.id&&x.uid===order.uid));const promotion_rows=await db.execute(sql`SELECT id,oid,uid,promotions_id,product_id,promotions_price::text AS promotions_price,add_time FROM public.store_order_promotions WHERE oid=${order.id} ORDER BY id LIMIT 201`);fact(promotion_rows.length<=200);return{version:'customer-manual-refund-source-v1',order,carts:rows,payment,promotion_rows:[...promotion_rows]};}
declare const applicationBrand:unique symbol;export type CustomerManualRefundApplicationCapability={readonly[applicationBrand]:true};
const applications=new WeakMap<object,{actor:CustomerWorkActor;scope_key:string;order_id:number;source_hash:string}>();
export async function prepareCustomerManualRefundApplication(db:DbClient,actorInput:CustomerWorkActor,scope_key:string,order:Order):Promise<CustomerManualRefundApplicationCapability>{
 await assertCustomerManualRefundReady(db);await manualRefundWriteFacts(db,order);const actor=freezeCustomerActor(actorInput),scope=await authorizeCustomerWorkActor(db,actor);fact(scope.scope_key===scope_key);const frozen=await source(db,order),cap=Object.freeze({}) as CustomerManualRefundApplicationCapability;applications.set(cap,{actor,scope_key,order_id:order.id,source_hash:await outRequestHash(frozen)});return cap;
}
export async function authorizeCustomerManualRefundApplication(db:DbClient,cap:CustomerManualRefundApplicationCapability,order:Order,carts:Cart[]){
 const saved=applications.get(cap);fact(saved&&saved.order_id===order.id);await assertCustomerManualRefundReady(db);await manualRefundWriteFacts(db,order);await authorizeCustomerOperationOwner(db,saved!.actor);await acquireCustomerWorkScopeLock(db,saved!.actor.uid);fact((await authorizeCustomerWorkActor(db,saved!.actor)).scope_key===saved!.scope_key);fact(await outRequestHash(await source(db,order,carts))===saved!.source_hash);
}
declare const executionBrand:unique symbol;export type CustomerManualRefundExecutionCapability={readonly[executionBrand]:true};
const executions=new WeakMap<object,PreparedFinancialOperation>();
/** An opaque live object alone reaches the core. A JSON flag cannot bypass
 * provider evidence; the core still reauthorizes the global customer under locks. */
export function prepareCustomerManualRefundExecution(p:PreparedFinancialOperation):CustomerManualRefundExecutionCapability{fact(p.kind==='refund_execute');const cap=Object.freeze({}) as CustomerManualRefundExecutionCapability;executions.set(cap,p);return cap;}
export async function persistCustomerManualRefundProof(db:DbClient,cap:CustomerManualRefundExecutionCapability,refund:Refund,order:Order){
 const p=executions.get(cap);fact(p&&p.input.order_id===order.id&&p.kind==='refund_execute');await assertCustomerManualRefundReady(db);await manualRefundWriteFacts(db,order);await authorizeCustomerOperationOwner(db,p!.actor);await acquireCustomerWorkScopeLock(db,p!.actor.uid);const scope=await authorizeCustomerWorkActor(db,p!.actor);fact(scope.scope_key===p!.input.scope_key);
 const body=p!.input.payload as {refund_id?:unknown;refund_no?:unknown;refund_price?:unknown;decision?:{cash_returned?:unknown}};
 fact(body.refund_id===refund.id&&body.refund_no===refund.orderId&&body.refund_price===refund.refundPrice&&refund.uid===order.uid&&refund.storeOrderId===order.id&&refund.storeId===order.storeId&&refund.supplierId===order.supplierId&&!refund.isCancel&&!refund.isDel);
 const amount=amountToCents(refund.refundPrice);fact(amount!==null&&amount!>=0);const cash=amount!>0;fact(cash?body.decision?.cash_returned===true:!Object.hasOwn(body.decision??{},'cash_returned'));
 const channels=await db.select({id:storeOrderRefundPayment.id}).from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refund.id)).limit(1);fact(!channels.length);
 const frozen=await source(db,order),source_hash=await outRequestHash(frozen),intent_json=manualRefundCanonicalJson({version:'customer-work-financial-operation-v1',actor_uid:p!.actor.uid,kind:p!.kind,input:p!.input});fact(await outRequestHash({version:'customer-work-financial-operation-v1',actor_uid:p!.actor.uid,kind:p!.kind,input:p!.input})===p!.hash);
 const proof={version:'customer-manual-refund-proof-v1',refund_id:refund.id,actor_uid:p!.actor.uid,request_key:p!.key,request_hash:p!.hash,service_id:scope.service_id,order_id:order.id,payment_order_id:frozen.payment.root_id,buyer_uid:order.uid,store_id:order.storeId,supplier_id:order.supplierId,pay_type:order.payType,amount:refund.refundPrice,settlement:cash?'cash':'zero',cash_returned:cash,source_hash},proof_json=manualRefundCanonicalJson(proof),proof_hash=await outRequestHash(proof),source_json=manualRefundCanonicalJson(frozen);
 await db.execute(sql`INSERT INTO public.customer_financial_manual_refund_v1(refund_id,actor_uid,request_key,request_hash,service_id,order_id,payment_order_id,buyer_uid,store_id,supplier_id,pay_type,amount,settlement,cash_returned,intent,intent_json,source,source_json,source_hash,proof,proof_json,proof_hash)
 VALUES(${refund.id},${p!.actor.uid},${p!.key}::uuid,${p!.hash},${scope.service_id},${order.id},${frozen.payment.root_id},${order.uid},${order.storeId},${order.supplierId},${order.payType},${refund.refundPrice},${cash?'cash':'zero'},${cash},${JSON.stringify(p!.input)}::jsonb,${intent_json},${source_json}::jsonb,${source_json},${source_hash},${proof_json}::jsonb,${proof_json},${proof_hash})`);
 return proof;
}
export interface CustomerManualRefundProofRow extends Record<string,unknown> {
 refund_id:number;actor_uid:number;request_key:string;request_hash:string;service_id:number;order_id:number;payment_order_id:number;buyer_uid:number;store_id:number;supplier_id:number;pay_type:string;amount:string;settlement:'cash'|'zero';cash_returned:boolean;
 intent:FinancialInput;intent_json:string;source:Awaited<ReturnType<typeof source>>;source_json:string;source_hash:string;proof:Record<string,unknown>;proof_json:string;proof_hash:string;
}
export async function readCustomerManualRefundProof(db:DbClient,refund:Refund,order:Order):Promise<CustomerManualRefundProofRow>{
 fact((await inspectCustomerManualRefund(db)).complete);
 const materializations=await db.execute<{invoice_allocation:string;uid:number;payment_order_id:number}>(sql`SELECT invoice_allocation,uid,payment_order_id FROM public.store_order_refund_split WHERE refund_id=${refund.id} LIMIT 2`);fact(materializations.length<=1);
 if(materializations.length)await assertStoredManualInvoiceAllocation(db,materializations[0].invoice_allocation,materializations[0].uid,materializations[0].payment_order_id);
 const rows=await db.execute<CustomerManualRefundProofRow>(sql`SELECT * FROM public.customer_financial_manual_refund_v1 WHERE refund_id=${refund.id} LIMIT 2`);fact(rows.length===1);const row=rows[0];
 financialRecord(row.source,['version','order','carts','payment','promotion_rows']);
 fact(row.source.order&&typeof row.source.order==='object'&&!Array.isArray(row.source.order)&&row.source.payment&&typeof row.source.payment==='object'&&!Array.isArray(row.source.payment)&&Array.isArray(row.source.carts)&&row.source.carts.length>0&&row.source.carts.length<=200&&row.source.carts.every(c=>c&&typeof c==='object'&&!Array.isArray(c))&&Array.isArray(row.source.promotion_rows)&&row.source.promotion_rows.length<=200);
 if(Object.hasOwn(row.source.payment,'payment_origin')){
  const payment=financialRecord(row.source.payment,['root_id','order_no','buyer_uid','pay_type','amount','pay_time','store_id','supplier_id','origin_hash','audits','event','payment_origin']);
  fact(payment.pay_type==='offline'&&await outRequestHash(await parseCustomerManualOfflineOrigin(payment.payment_origin))===await outRequestHash(payment.payment_origin));
 }
 financialRecord(row.intent,['version','scope_key','order_id','expected_order_revision','expected_financial_revision','payload']);validateFinancialPayload('refund_execute',row.intent.payload);
 financialRecord(row.proof,['version','refund_id','actor_uid','request_key','request_hash','service_id','order_id','payment_order_id','buyer_uid','store_id','supplier_id','pay_type','amount','settlement','cash_returned','source_hash']);const proof=row.proof;
 fact(proof&&manualRefundCanonicalJson(proof)===row.proof_json&&await outRequestHash(proof)===row.proof_hash&&manualRefundCanonicalJson(row.source)===row.source_json&&await outRequestHash(row.source)===row.source_hash);
 const full={version:'customer-work-financial-operation-v1',actor_uid:row.actor_uid,kind:'refund_execute',input:row.intent};fact(manualRefundCanonicalJson(full)===row.intent_json&&await outRequestHash(full)===row.request_hash);
 const expected={version:'customer-manual-refund-proof-v1',refund_id:refund.id,actor_uid:row.actor_uid,request_key:row.request_key,request_hash:row.request_hash,service_id:row.service_id,order_id:refund.storeOrderId,payment_order_id:row.payment_order_id,buyer_uid:refund.uid,store_id:refund.storeId,supplier_id:refund.supplierId,pay_type:order.payType,amount:refund.refundPrice,settlement:amountToCents(refund.refundPrice)!>0?'cash':'zero',cash_returned:amountToCents(refund.refundPrice)!>0,source_hash:row.source_hash};
 const payload=validateFinancialPayload('refund_execute',row.intent.payload) as {refund_id:number;refund_no:string;refund_price:string};
 fact(await outRequestHash(expected)===row.proof_hash&&row.actor_uid>0&&row.service_id>0&&row.intent.order_id===refund.storeOrderId&&payload.refund_id===refund.id&&payload.refund_no===refund.orderId&&payload.refund_price===refund.refundPrice&&row.source.order.id===refund.storeOrderId&&row.source.order.uid===refund.uid);
 const original={...row.source.order,pid:row.payment_order_id===row.order_id?0:row.payment_order_id} as Order,currentPayment=await manualRefundPaymentFacts(db,original),savedPayment=row.source.payment;
 const legacy=(payment:typeof currentPayment)=>payment.event===null&&payment.origin_hash===null&&payment.audits.length>0&&payment.audits.every(a=>a.change_type==='pay_success'&&a.change_message==='用户付款成功'&&a.change_time>=payment.pay_time);
 if(legacy(savedPayment)&&legacy(currentPayment)){
  // A PHP status job may append another identical success audit after this
  // genuine refund COMMIT. Recovery preserves every frozen ID/content and the
  // entire original paid identity, while admitting only verified canonical
  // queue additions. Deleted/changed history and mixed TS evidence still fail.
  const{audits:savedAudits,...savedIdentity}=savedPayment,{audits:currentAudits,...currentIdentity}=currentPayment;
  fact(await outRequestHash(savedIdentity)===await outRequestHash(currentIdentity)&&new Set(savedAudits.map(a=>a.id)).size===savedAudits.length);
  const currentIds=new Map(currentAudits.map(a=>[a.id,a]));for(const audit of savedAudits)fact(currentIds.has(audit.id)&&await outRequestHash(currentIds.get(audit.id))===await outRequestHash(audit));
 }else fact(await outRequestHash(currentPayment)===await outRequestHash(savedPayment));
 const channels=await db.select({id:storeOrderRefundPayment.id}).from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refund.id)).limit(1);fact(!channels.length);
 return{...row,proof};
}
/** The definer checks same-transaction proof, physical ownership and frozen rows.
 * Runtime never receives table DELETE; only the current materializer invokes it. */
export async function deleteCustomerManualRefundPromotionRows(db:DbClient,refundId:number,orderId:number){
 if(Object.hasOwn(db,'$client'))throw bad();await assertCustomerManualRefundReady(db);
 const rows=await db.execute<{deleted:number}>(sql`SELECT public.customer_manual_refund_promotion_delete_v1(${refundId},${orderId}) AS deleted`);fact(rows.length===1&&Number.isSafeInteger(rows[0].deleted)&&rows[0].deleted>=0);
}
