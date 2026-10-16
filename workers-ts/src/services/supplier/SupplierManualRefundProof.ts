import { and,asc,eq,sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder,storeOrderCartInfo,storeOrderRefund,storeOrderRefundPayment } from '@/models/schema';
import { assertSupplierManualRefundReady } from '@/migrations/supplierManualRefund';
import { manualRefundPaymentFacts,manualRefundWriteFacts,readCustomerManualRefundProof,deleteCustomerManualRefundPromotionRows } from '@/services/order/CustomerManualRefund';
import { inspectCustomerManualRefund } from '@/migrations/runCustomerManualRefund';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { assertStoredManualInvoiceAllocation } from '@/services/order/InvoiceManualRedNoteEvidence';
import { assertSupplierVideoAuthority,type SupplierVideoActor } from './SupplierVideoAuthority';
import { supplierManualRefundJson,supplierManualRefundRecord,supplierManualRefundConflict,type SupplierManualRefundIntent } from './SupplierManualRefundInput';
import { ServiceUnavailableException,ValidateException } from '@/utils/errors';
import {assertSupplierManualRefundLineOwnership} from './SupplierManualRefundLineOwnership';
import {authorizeSupplierProactiveRefundApplication,type SupplierProactiveRefundApplicationCapability} from './SupplierProactiveRefundCapability';
import {assertSupplierProactiveRefundCash} from './SupplierProactiveRefundInput';
type Order=typeof storeOrder.$inferSelect;type Cart=typeof storeOrderCartInfo.$inferSelect;type Refund=typeof storeOrderRefund.$inferSelect;
const fact=(ok:unknown):void=>{if(!ok)throw supplierManualRefundConflict('供应商现金退款原付款、租户或完整凭据无法核对');};
const bytes=(value:unknown,max:number)=>{const text=supplierManualRefundJson(value);fact(new TextEncoder().encode(text).length<=max);return text;};
export async function readSupplierManualRefundSource(tx:DbClient,order:Order,refund?:Refund,carts?:Cart[]) {
  fact(order.supplierId>0&&['cash','offline'].includes(order.payType));
  const payment=await manualRefundWriteFacts(tx,order);
  const rows=carts??await tx.select().from(storeOrderCartInfo).where(and(eq(storeOrderCartInfo.oid,order.id),
    sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo}),0)<=65536`)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  const [count]=await tx.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM public.store_order_cart_info WHERE oid=${order.id}`);
  fact(rows.length>0&&rows.length<=200&&rows.length===count?.n&&rows.every(r=>r.oid===order.id&&r.uid===order.uid));
  fact(rows.reduce((n,r)=>n+new TextEncoder().encode(r.cartInfo??'').length,0)<=8388608);
  await assertSupplierManualRefundLineOwnership(tx,order,rows,payment,readBoundManualRefundProof);
  const promotion_rows=await tx.execute(sql`SELECT id,oid,uid,promotions_id,product_id,promotions_price::text AS promotions_price,add_time
    FROM public.store_order_promotions WHERE oid=${order.id} ORDER BY id LIMIT 201`);
  fact(promotion_rows.length<=200&&promotion_rows.every(r=>r.uid===order.uid));
  const source={version:'supplier-manual-refund-source-v1' as const,order,carts:rows,payment,promotion_rows:[...promotion_rows],refund:refund??null};
  bytes(source,16777216);return source;
}
export type SupplierManualRefundSource=Awaited<ReturnType<typeof readSupplierManualRefundSource>>;
interface SupplierManualRefundProofRow extends Record<string,unknown> {
  operation_id:string;request_hash:string;source_hash:string;proof_hash:string;
}
interface SupplierRefundTransaction extends Record<string,unknown> {transaction_id:string;backend_id:number}
async function refundTransaction(tx:DbClient):Promise<SupplierRefundTransaction> {
  if(Object.hasOwn(tx,'$client'))throw new ValidateException('供应商人工退款能力须在原业务事务内建立及使用');
  const [identity]=await tx.execute<SupplierRefundTransaction>(sql`SELECT txid_current()::text AS transaction_id,pg_backend_pid() AS backend_id`);
  fact(identity&&/^[1-9][0-9]*$/.test(identity.transaction_id)&&Number.isSafeInteger(identity.backend_id)&&identity.backend_id>0);
  return identity;
}
async function lockAuthority(tx:DbClient,actor:SupplierVideoActor,permission:'supplier.refund.manage'|'supplier.order.manage'='supplier.refund.manage') {
  await tx.execute(sql`LOCK TABLE ONLY public.system_admin,ONLY public.system_supplier,ONLY public.system_role,ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  await assertSupplierVideoAuthority(tx,actor,permission);
}
async function sameTransaction(tx:DbClient,expected:SupplierRefundTransaction,actor:SupplierVideoActor,permission:'supplier.refund.manage'|'supplier.order.manage'='supplier.refund.manage') {
  const current=await refundTransaction(tx);
  fact(current.transaction_id===expected.transaction_id&&current.backend_id===expected.backend_id);
  // Mint acquired this before the core's order/cart locks. A legitimate nested
  // SAVEPOINT reacquires its own lock; another TX is refused before this step.
  await lockAuthority(tx,actor,permission);
}
declare const appBrand:unique symbol;
export type SupplierManualRefundApplicationCapability={readonly[appBrand]:true};
const applications=new WeakMap<object,{actor:SupplierVideoActor;orderId:number;sourceHash:string;transaction:SupplierRefundTransaction}>();
export async function prepareSupplierManualRefundApplication(tx:DbClient,actor:SupplierVideoActor,order:Order):Promise<SupplierManualRefundApplicationCapability> {
  const owner=Object.freeze({...actor}),transaction=await refundTransaction(tx);
  await lockAuthority(tx,owner);await assertSupplierManualRefundReady(tx);fact(order.supplierId===owner.supplierId);
  const cap=Object.freeze({}) as SupplierManualRefundApplicationCapability;
  const sourceHash=await outRequestHash(await readSupplierManualRefundSource(tx,order));
  await assertSupplierVideoAuthority(tx,owner,'supplier.refund.manage');
  applications.set(cap,{actor:owner,orderId:order.id,sourceHash,transaction});return cap;
}
export async function authorizeSupplierManualRefundApplication(tx:DbClient,cap:SupplierManualRefundApplicationCapability,order:Order,carts:Cart[]) {
  const p=applications.get(cap);fact(p&&p.orderId===order.id&&p.actor.supplierId===order.supplierId);
  if(!p)throw supplierManualRefundConflict();
  await sameTransaction(tx,p.transaction,p.actor);await assertSupplierManualRefundReady(tx);
  fact(await outRequestHash(await readSupplierManualRefundSource(tx,order,undefined,carts))===p.sourceHash);
}
declare const executionBrand:unique symbol;
export type SupplierManualRefundExecutionCapability={readonly[executionBrand]:true};
const executions=new WeakMap<object,{actor:SupplierVideoActor;intent:SupplierManualRefundIntent;hash:string;sourceHash:string;transaction:SupplierRefundTransaction;
  permission:'supplier.refund.manage'|'supplier.order.manage'}>();
export async function prepareSupplierManualRefundExecution(tx:DbClient,actor:SupplierVideoActor,intent:SupplierManualRefundIntent,
  hash:string,order:Order,refund:Refund):Promise<SupplierManualRefundExecutionCapability> {
  return prepareExecution(tx,actor,intent,hash,order,refund,'supplier.refund.manage');
}
/** Preserve the existing cash proof format, but require a genuine independent
 * order-management admission. An HTTP flag/string cannot select this policy. */
export async function prepareSupplierProactiveManualRefundExecution(tx:DbClient,capability:SupplierProactiveRefundApplicationCapability,
  actor:SupplierVideoActor,intent:SupplierManualRefundIntent,hash:string,order:Order,refund:Refund):Promise<SupplierManualRefundExecutionCapability> {
  const admission=await authorizeSupplierProactiveRefundApplication(tx,capability,order,
    await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201));
  fact(admission.phase==='execution'&&admission.intent&&admission.operationId===intent.operation_id
    &&admission.intent.actor_id===actor.id&&admission.intent.supplier_id===actor.supplierId
    &&admission.intent.refund_price===intent.refund_price&&admission.intent.cash_returned===intent.cash_returned);
  if(!admission.intent)throw supplierManualRefundConflict();
  assertSupplierProactiveRefundCash(admission.intent,intent.refund_price==='0.00'?'zero':'cash');
  return prepareExecution(tx,actor,intent,hash,order,refund,'supplier.order.manage');
}
async function prepareExecution(tx:DbClient,actor:SupplierVideoActor,intent:SupplierManualRefundIntent,hash:string,order:Order,refund:Refund,
  permission:'supplier.refund.manage'|'supplier.order.manage'):Promise<SupplierManualRefundExecutionCapability> {
  const owner=Object.freeze({...actor}),request=Object.freeze({...intent}),transaction=await refundTransaction(tx);
  await lockAuthority(tx,owner,permission);await assertSupplierManualRefundReady(tx);
  fact(request.actor_id===owner.id&&request.supplier_id===owner.supplierId&&request.refund_id===refund.id&&order.supplierId===owner.supplierId);
  fact(hash===await outRequestHash(request));
  const cap=Object.freeze({}) as SupplierManualRefundExecutionCapability;
  const sourceHash=await outRequestHash(await readSupplierManualRefundSource(tx,order,refund));
  await assertSupplierVideoAuthority(tx,owner,permission);
  executions.set(cap,{actor:owner,intent:request,hash,sourceHash,transaction,permission});return cap;
}
async function oldProofPresent(tx:DbClient,refundId:number) {
  const [present]=await tx.execute(sql`SELECT to_regclass('public.customer_financial_manual_refund_v1') IS NOT NULL AS present`);
  if(present?.present!==true)return false;
  if(!(await inspectCustomerManualRefund(tx)).complete)throw new ServiceUnavailableException('既有人工退款凭据目录无法核对');
  // Explicit composed reader grant only, never Customer execution authority.
  const rows=await tx.execute(sql`SELECT refund_id FROM public.customer_financial_manual_refund_v1 WHERE refund_id=${refundId} LIMIT 2`);
  fact(rows.length<=1);return rows.length===1;
}
export async function persistSupplierManualRefundProof(tx:DbClient,cap:SupplierManualRefundExecutionCapability,refund:Refund,order:Order) {
  const p=executions.get(cap);fact(p&&p.intent.refund_id===refund.id);if(!p)throw supplierManualRefundConflict();
  await sameTransaction(tx,p.transaction,p.actor,p.permission);await assertSupplierManualRefundReady(tx);
  fact(order.supplierId===p.actor.supplierId&&refund.supplierId===order.supplierId&&refund.storeOrderId===order.id&&refund.uid===order.uid
    &&refund.storeId===order.storeId&&!refund.isDel&&!refund.isCancel&&refund.refundPrice===p.intent.refund_price);
  fact(!await oldProofPresent(tx,refund.id));
  const channels=await tx.select({id:storeOrderRefundPayment.id}).from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refund.id)).limit(1);fact(!channels.length);
  const source=await readSupplierManualRefundSource(tx,order,refund);fact(await outRequestHash(source)===p.sourceHash);
  const source_json=bytes(source,16777216),source_hash=await outRequestHash(source),intent_json=bytes(p.intent,16384);
  const proof={version:'supplier-manual-refund-proof-v1',refund_id:refund.id,operation_id:p.intent.operation_id,actor_id:p.actor.id,
    supplier_id:order.supplierId,order_id:order.id,payment_order_id:source.payment.root_id,buyer_id:order.uid,pay_type:order.payType,
    amount:refund.refundPrice,source_hash,request_hash:p.hash},proof_json=bytes(proof,16384),proof_hash=await outRequestHash(proof);
  await tx.execute(sql`INSERT INTO public.supplier_manual_refund_proof_v1(refund_id,operation_id,actor_id,supplier_id,order_id,payment_order_id,buyer_id,pay_type,
    amount,intent,intent_json,request_hash,source,source_json,source_hash,proof,proof_json,proof_hash,created_at)
    VALUES(${refund.id},${p.intent.operation_id}::uuid,${p.actor.id},${order.supplierId},${order.id},${source.payment.root_id},${order.uid},${order.payType},
    ${refund.refundPrice},${JSON.stringify(p.intent)}::jsonb,${intent_json},${p.hash},${source_json}::jsonb,${source_json},${source_hash},${proof_json}::jsonb,${proof_json},${proof_hash},
    floor(extract(epoch FROM clock_timestamp()))::integer)`);
  return {source_hash,proof_hash,proof,source};
}
export async function readSupplierManualRefundProof(tx:DbClient,refund:Refund,order:Order) {
  await assertSupplierManualRefundReady(tx,'read');fact(!await oldProofPresent(tx,refund.id));
  const rows=await tx.execute<SupplierManualRefundProofRow>(sql`SELECT * FROM public.supplier_manual_refund_proof_v1 WHERE refund_id=${refund.id} LIMIT 2`);fact(rows.length===1);
  const r=rows[0],source=supplierManualRefundRecord(r.source),proof=supplierManualRefundRecord(r.proof),intent=supplierManualRefundRecord(r.intent);
  fact(source.version==='supplier-manual-refund-source-v1'&&Array.isArray(source.carts)&&source.carts.length>0&&source.carts.length<=200);
  fact(supplierManualRefundJson(source)===r.source_json&&await outRequestHash(source)===r.source_hash
    &&supplierManualRefundJson(proof)===r.proof_json&&await outRequestHash(proof)===r.proof_hash
    &&supplierManualRefundJson(intent)===r.intent_json&&await outRequestHash(intent)===r.request_hash);
  const original=supplierManualRefundRecord(source.order),savedPayment=supplierManualRefundRecord(source.payment);
  const current=await manualRefundPaymentFacts(tx,{...original,pid:r.payment_order_id===r.order_id?0:r.payment_order_id} as Order);
  const savedAudits=Array.isArray(savedPayment.audits)?savedPayment.audits.map(supplierManualRefundRecord):[];
  const legacySaved=savedPayment.event===null&&savedPayment.origin_hash===null&&savedAudits.length>0
    &&savedAudits.every(a=>a.change_type==='pay_success'&&a.change_message==='用户付款成功'&&Number(a.change_time)>=Number(savedPayment.pay_time));
  const legacyCurrent=current.event===null&&current.origin_hash===null&&current.audits.length>0
    &&current.audits.every(a=>a.change_type==='pay_success'&&a.change_message==='用户付款成功'&&a.change_time>=current.pay_time);
  if(legacySaved&&legacyCurrent) {
    // Same published PHP queue replay exception as the Customer reader: every
    // original paid fact and audit stays exact; only canonical later audits
    // may be appended. It never admits a TS payment discriminator or rewrite.
    const{audits:_saved,...savedIdentity}=savedPayment,{audits:_current,...currentIdentity}=current;
    fact(await outRequestHash(savedIdentity)===await outRequestHash(currentIdentity)
      &&new Set(savedAudits.map(a=>a.id)).size===savedAudits.length);
    const actual=new Map(current.audits.map(a=>[a.id,a]));
    for(const audit of savedAudits)fact(actual.has(Number(audit.id))&&await outRequestHash(actual.get(Number(audit.id)))===await outRequestHash(audit));
  } else fact(await outRequestHash(current)===await outRequestHash(savedPayment));
  fact(r.refund_id===refund.id&&r.order_id===refund.storeOrderId&&r.order_id===order.id&&r.supplier_id===refund.supplierId
    &&r.supplier_id===order.supplierId&&r.buyer_id===refund.uid&&r.buyer_id===order.uid&&r.amount===refund.refundPrice
    &&r.pay_type===order.payType&&r.payment_order_id===current.root_id&&original.id===order.id&&original.uid===order.uid
    &&original.supplierId===order.supplierId&&intent.refund_id===refund.id&&intent.refund_price===refund.refundPrice
    &&proof.operation_id===r.operation_id&&proof.source_hash===r.source_hash&&proof.request_hash===r.request_hash);
  const channels=await tx.select({id:storeOrderRefundPayment.id}).from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refund.id)).limit(1);fact(!channels.length);
  const allocation=await tx.execute<{invoice_allocation:string}>(sql`SELECT invoice_allocation FROM public.store_order_refund_split WHERE refund_id=${refund.id} LIMIT 2`);
  fact(allocation.length<=1);if(allocation.length)await assertStoredManualInvoiceAllocation(tx,allocation[0].invoice_allocation,refund.uid,current.root_id);
  return {...r,source:{...source,carts:source.carts},proof,intent};
}
/** Metadata only: an unchanged Customer LOGIN has no access to the separately
 * commissioned Supplier realm. Do not provoke/catch 42501 inside its business
 * TX. Supplier entry points always assert their own complete readiness first. */
async function supplierProofReadable(tx:DbClient):Promise<boolean> {
  const [state]=await tx.execute<{readable:boolean}>(sql`SELECT CASE WHEN to_regclass('public.supplier_manual_refund_proof_v1') IS NULL
    THEN false ELSE has_table_privilege(current_user,to_regclass('public.supplier_manual_refund_proof_v1'),'SELECT') END AS readable`);
  return state?.readable===true;
}
/** Explicitly composed readers inspect both realms. The frozen Customer
 * profile retains its original complete reader and does not gain cross-realm
 * observability merely because maintenance installed a separate feature. */
export async function readBoundManualRefundProof(tx:DbClient,refund:Refund,order:Order) {
  if(!await supplierProofReadable(tx))return readCustomerManualRefundProof(tx,refund,order);
  await assertSupplierManualRefundReady(tx,'read');
  const rows=await tx.execute(sql`SELECT refund_id FROM public.supplier_manual_refund_proof_v1 WHERE refund_id=${refund.id} LIMIT 2`);fact(rows.length<=1);
  if(rows.length)return readSupplierManualRefundProof(tx,refund,order);
  return readCustomerManualRefundProof(tx,refund,order);
}
export async function deleteBoundManualRefundPromotionRows(tx:DbClient,refundId:number,orderId:number) {
  if(Object.hasOwn(tx,'$client'))throw new ValidateException('人工退款促销清理必须在原事务内');
  if(!await supplierProofReadable(tx))return deleteCustomerManualRefundPromotionRows(tx,refundId,orderId);
  await assertSupplierManualRefundReady(tx,'read');
  const rows=await tx.execute(sql`SELECT refund_id FROM public.supplier_manual_refund_proof_v1 WHERE refund_id=${refundId} LIMIT 2`);fact(rows.length<=1);
  if(!rows.length)return deleteCustomerManualRefundPromotionRows(tx,refundId,orderId);
  fact(!await oldProofPresent(tx,refundId));await assertSupplierManualRefundReady(tx);
  const result=await tx.execute<{deleted:number}>(sql`SELECT public.supplier_manual_refund_promotion_delete_v1(${refundId},${orderId}) AS deleted`);
  fact(result.length===1&&Number.isSafeInteger(result[0].deleted)&&result[0].deleted>=0);
}
