import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { capitalFlow, storeOrder, storeOrderRefund, storeOrderRefundPayment,
  supplierFlowingWater, supplierTransactions, userBill } from '@/models/schema';
import { storeOrderRefundSplit } from '@/models/schema/order_refund_split';
import { assertSupplierProactiveRefundReady } from '@/migrations/supplierProactiveRefund';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { readRefundQuantityReservation, refundClaimCartKey, CUSTOMER_ROW_REFUND_VERSION } from '@/services/order/RefundQuantityReservation';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { HttpApiException, ServiceUnavailableException } from '@/utils/errors';
import type { SupplierProactiveRefundIntent } from './SupplierProactiveRefundInput';

type Order = typeof storeOrder.$inferSelect;
type Refund = typeof storeOrderRefund.$inferSelect;
type Split = typeof storeOrderRefundSplit.$inferSelect;
export const SUPPLIER_PROACTIVE_MONEY_SOURCE_VERSION = 'supplier-proactive-money-source-v1' as const;
export const SUPPLIER_PROACTIVE_MONEY_COMPLETION_VERSION = 'supplier-proactive-money-completion-v1' as const;
export interface SupplierProactiveMoneyPaymentIdentity {
  readonly id: number; readonly order_no: string; readonly uid: number; readonly supplier_id: number; readonly store_id: number;
  readonly pay_type: 'cash' | 'offline' | 'yue'; readonly paid: 1; readonly pay_time: number; readonly trade_no: string;
  readonly pay_price: string; readonly pid: number; readonly supplier_allocation_status: number;
}
export interface SupplierProactiveFirstGoodsReference {
  readonly operation_id: string; readonly actor_id: number; readonly supplier_id: number; readonly order_id: number;
  readonly refund_id: number; readonly request_hash: string; readonly source_hash: string; readonly amount: string;
  readonly split_fingerprint: string; readonly invoice_allocation_hash: string;
}
export interface SupplierProactiveMoneyCompletionReference {
  readonly operation_id: string; readonly amount: string; readonly before_refunded: string; readonly after_refunded: string;
  readonly proof_hash: string;
}
export interface SupplierProactiveMoneySource {
  readonly version: typeof SUPPLIER_PROACTIVE_MONEY_SOURCE_VERSION;
  readonly order: Order; readonly payment: SupplierProactiveMoneyPaymentIdentity; readonly goods: SupplierProactiveFirstGoodsReference;
  readonly history: { readonly completions: readonly SupplierProactiveMoneyCompletionReference[]; readonly payments: readonly never[] };
  readonly current_source_hash: string;
}
export interface SupplierProactiveMoneyRowReference { readonly id: number; readonly hash: string }
export interface SupplierProactiveMoneyCompletionProof {
  readonly version: typeof SUPPLIER_PROACTIVE_MONEY_COMPLETION_VERSION;
  readonly operation_id: string; readonly actor_id: number; readonly supplier_id: number; readonly order_id: number;
  readonly first_refund_id: number; readonly payment_order_id: number; readonly amount: string;
  readonly pay_type: SupplierProactiveMoneyPaymentIdentity['pay_type']; readonly source_hash: string; readonly request_hash: string;
  readonly before_refunded: string; readonly after_refunded: string; readonly goods: SupplierProactiveFirstGoodsReference;
  readonly bill: SupplierProactiveMoneyRowReference | null; readonly flow: SupplierProactiveMoneyRowReference | null;
  readonly supplier_transaction: SupplierProactiveMoneyRowReference;
}
declare const baselineBrand: unique symbol;
export type SupplierProactiveMoneyBaseline = { readonly [baselineBrand]: true };
export interface SupplierProactiveMoneyEvidence {
  readonly first: SupplierProactiveFirstGoodsReference; readonly firstRefund: Refund; readonly firstSplit: Split;
  readonly originalInvoice: Readonly<Record<string, unknown>> | null; readonly firstSource: Readonly<Record<string, unknown>>;
  readonly payment: SupplierProactiveMoneyPaymentIdentity; readonly paymentRoot: Order;
  readonly completions: readonly SupplierProactiveMoneyCompletionReference[]; readonly payments: readonly never[];
  readonly refunded: string; readonly paid: string; readonly available: string; readonly baseline: SupplierProactiveMoneyBaseline;
}
interface Transaction extends Record<string, unknown> { transaction_id: string; backend_id: number }
const baselines = new WeakMap<object, { transaction: Transaction; orderHash: string; first: SupplierProactiveFirstGoodsReference }>();
const evidenceStates = new WeakMap<object, { orderJson: string }>();
const fail = () => new HttpApiException('整单退款后的原始款项、完整补退链或实际账单无法核对，请保留原请求', 409, 409);
const fact = (condition: unknown): void => { if (!condition) throw fail(); };
const orderKeys = Object.keys(getTableColumns(storeOrder));
const paymentKeys = ['id','order_no','uid','supplier_id','store_id','pay_type','paid','pay_time','trade_no','pay_price','pid','supplier_allocation_status'];
const firstKeys = ['operation_id','actor_id','supplier_id','order_id','refund_id','request_hash','source_hash','amount','split_fingerprint','invoice_allocation_hash'];
const completionKeys = ['operation_id','amount','before_refunded','after_refunded','proof_hash'];
const proofKeys = ['version','operation_id','actor_id','supplier_id','order_id','first_refund_id','payment_order_id','amount','pay_type',
  'source_hash','request_hash','before_refunded','after_refunded','goods','bill','flow','supplier_transaction'];
const operationKeys = ['operation_id','actor_id','supplier_id','order_id','state','kind','request_hash','intent','intent_json','source','source_json','source_hash','result','created_at'];
const decisionKeys = ['operation_id','actor_id','supplier_id','order_id','kind','outcome','request_hash','evidence','evidence_json','evidence_hash','created_at'];
const moneyRowKeys = ['operation_id','actor_id','supplier_id','order_id','first_refund_id','payment_order_id','amount','pay_type',
  'source_hash','request_hash','before_refunded','after_refunded','proof','proof_json','proof_hash','created_at'];
// Purchase/payment identity only. Refund totals and legitimate later notes or
// delivery metadata are not rewritten to manufacture a historical order.
const stableOrderKeys = ['id','pid','orderId','uid','supplierId','storeId','type','productType','activityId','pinkId','paid','payType','payTime',
  'tradeNo','totalNum','payPrice','totalPrice','totalPostage','payPostage','freightPrice','payIntegral','deductionPrice','couponId','couponPrice',
  'promotionsPrice','firstOrderPrice','changePrice','gainIntegral','useIntegral','cost','spreadUid','spreadTwoUid','oneBrokerage','twoBrokerage',
  'divisionId','divisionBrokerage','divisionAgentId','divisionAgentBrokerage','divisionStaffId','divisionStaffBrokerage','addTime','unique'];

function object(value: unknown): Record<string, unknown> {
  fact(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, keys: readonly string[]): void {
  const own = Reflect.ownKeys(row); fact(own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(row, key)!, 'value')));
}
function integer(value: unknown, minimum = 1): number {
  fact(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647); return value as number;
}
function uuid(value: unknown): string {
  fact(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)); return value as string;
}
function hash(value: unknown): string { fact(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); return value as string; }
function money(value: unknown): string { fact(typeof value === 'string' && /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value)); return value as string; }
const minor = (value: unknown) => BigInt(money(value).replace('.', ''));
function decimal(value: bigint): string { fact(value >= 0n && value <= 999_999_999_999n); return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') { const text=JSON.stringify(value);fact(typeof text==='string');return text!; }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
function snapshot<T>(value: T, limit: number): T {
  const visiting = new Set<object>(); let count = 0;
  function copy(item: unknown, depth: number): unknown {
    fact(++count <= 1_000_000 && depth <= 100);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { fact(Number.isFinite(item)); return item; }
    fact(item && typeof item === 'object' && !visiting.has(item as object)); visiting.add(item as object);
    let result: object;
    if (Array.isArray(item)) {
      fact(Reflect.ownKeys(item).length === item.length + 1);
      result = Array.from({length: item.length}, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(item, String(index)); fact(property && Object.hasOwn(property, 'value'));
        return copy(property!.value, depth + 1);
      });
    } else {
      const source = object(item), row: Record<string, unknown> = Object.create(null);
      for (const key of Reflect.ownKeys(source)) {
        const property = Object.getOwnPropertyDescriptor(source, key);
        fact(typeof key === 'string' && property && Object.hasOwn(property, 'value') && property.enumerable);
        row[key as string] = copy(property!.value, depth + 1);
      }
      result = row;
    }
    visiting.delete(item as object); return Object.freeze(result);
  }
  const result = copy(value, 0); fact(new TextEncoder().encode(canonical(result)).length <= limit); return result as T;
}
function parsed(text: unknown, maximum: number, requireCanonical = true): Record<string, unknown> {
  fact(typeof text === 'string' && new TextEncoder().encode(text as string).length <= maximum);
  let value: unknown; try { value = JSON.parse(text as string); } catch { throw fail(); }
  const row = object(snapshot(value, maximum)); if (requireCanonical) fact(canonical(row) === text); return row;
}
function sameOrder(original: unknown, current: unknown): void {
  const before = object(original), after = object(current);
  fact(stableOrderKeys.every(key => Object.hasOwn(before, key) && Object.hasOwn(after, key) && before[key] === after[key]));
}
function paymentIdentity(order: Order): SupplierProactiveMoneyPaymentIdentity {
  fact(['cash','offline','yue'].includes(order.payType) && order.paid === 1 && order.payTime > 0);
  return Object.freeze({ id: integer(order.id), order_no: order.orderId, uid: integer(order.uid, 0), supplier_id: integer(order.supplierId, 0),
    store_id: integer(order.storeId, 0), pay_type: order.payType as SupplierProactiveMoneyPaymentIdentity['pay_type'], paid: 1,
    pay_time: integer(order.payTime), trade_no: order.tradeNo, pay_price: money(order.payPrice), pid: integer(order.pid, -1),
    supplier_allocation_status: integer(order.supplierAllocationStatus, 0) });
}
function verifyPayment(value: unknown): SupplierProactiveMoneyPaymentIdentity {
  const row = object(value); exact(row, paymentKeys); integer(row.id); integer(row.uid,0); integer(row.supplier_id,0); integer(row.store_id,0);
  integer(row.pay_time); integer(row.pid,-1); fact([0,1,2].includes(Number(row.supplier_allocation_status)) && typeof row.supplier_allocation_status === 'number');
  fact(row.paid === 1 && ['cash','offline','yue'].includes(String(row.pay_type)) && typeof row.order_no === 'string' && row.order_no.length > 0
    && row.order_no.length <= 50 && typeof row.trade_no === 'string' && row.trade_no.length <= 100); money(row.pay_price);
  return row as unknown as SupplierProactiveMoneyPaymentIdentity;
}
function verifyFirst(value: unknown): SupplierProactiveFirstGoodsReference {
  const row = object(value); exact(row, firstKeys); uuid(row.operation_id);
  for (const key of ['actor_id','supplier_id','order_id','refund_id']) integer(row[key]);
  for (const key of ['request_hash','source_hash','split_fingerprint','invoice_allocation_hash']) hash(row[key]);
  fact(minor(row.amount) > 0n); return row as unknown as SupplierProactiveFirstGoodsReference;
}
function verifyCompletionReference(value: unknown): SupplierProactiveMoneyCompletionReference {
  const row=object(value);exact(row,completionKeys);uuid(row.operation_id);hash(row.proof_hash);
  fact(minor(row.amount)>0n && minor(row.after_refunded)===minor(row.before_refunded)+minor(row.amount));
  return row as unknown as SupplierProactiveMoneyCompletionReference;
}
export function supplierProactiveMoneyBusinessNumber(actorId: number, operationId: string): string {
  const actor=integer(actorId),hex=uuid(operationId).replaceAll('-',''),bytes=hex.match(/../g)!.map(pair=>Number.parseInt(pair,16));
  return `SR${actor.toString(36)}_${btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}`;
}
/** Syntactic protocol validation only. It neither proves a live source nor
 * grants an execution or baseline capability. Historical MACs are not replayed. */
export function verifySupplierProactiveMoneySource(value: unknown, intent: SupplierProactiveRefundIntent): SupplierProactiveMoneySource {
  const source=object(snapshot(value,65_536));exact(source,['version','order','payment','goods','history','current_source_hash']);
  fact(source.version===SUPPLIER_PROACTIVE_MONEY_SOURCE_VERSION);hash(source.current_source_hash);
  const order=object(source.order);exact(order,orderKeys);const payment=verifyPayment(source.payment),goods=verifyFirst(source.goods),history=object(source.history);
  exact(history,['completions','payments']);fact(Array.isArray(history.completions)&&history.completions.length<=200&&Array.isArray(history.payments)&&history.payments.length===0);
  fact(order.id===intent.order_id&&order.supplierId===intent.supplier_id&&order.uid===payment.uid&&order.paid===1
    &&order.payType===payment.pay_type&&order.payTime===payment.pay_time&&(order.pid||order.id)===payment.id
    &&goods.order_id===order.id&&goods.supplier_id===order.supplierId&&intent.type===1&&minor(intent.refund_price)>0n
    &&['cash','offline','yue'].includes(String(order.payType))&&completedMetadata(order)&&!order.isDel&&!order.isSystemDel);
  fact((['cash','offline'].includes(String(order.payType))) ? intent.cash_returned===true : !Object.hasOwn(intent,'cash_returned'));
  let refunded=minor(goods.amount);const seen=new Set<string>([goods.operation_id,uuid(intent.operation_id)]);
  for(const entry of history.completions as unknown[]) {
    const row=verifyCompletionReference(entry);fact(!seen.has(row.operation_id)&&minor(row.before_refunded)===refunded);seen.add(row.operation_id);refunded=minor(row.after_refunded);
  }
  fact(refunded===minor(order.refundPrice)&&minor(order.payPrice)>=refunded&&minor(intent.refund_price)<=minor(order.payPrice)-refunded
    &&minor(payment.pay_price)>=minor(order.payPrice));
  return source as unknown as SupplierProactiveMoneySource;
}
export function makeSupplierProactiveMoneySource(order: Order, evidence: SupplierProactiveMoneyEvidence, currentSourceHash: string): SupplierProactiveMoneySource {
  const state=evidenceStates.get(evidence);fact(state&&canonical(order)===state.orderJson);hash(currentSourceHash);
  return snapshot({version:SUPPLIER_PROACTIVE_MONEY_SOURCE_VERSION,order,payment:evidence.payment,goods:evidence.first,
    history:{completions:evidence.completions,payments:[]},current_source_hash:currentSourceHash},65_536);
}
async function transaction(tx: DbClient): Promise<Transaction> {
  fact(!Object.hasOwn(tx,'$client'));
  const [row]=await tx.execute<Transaction>(sql`SELECT txid_current()::text AS transaction_id,pg_backend_pid() AS backend_id`);
  fact(row&&/^[1-9][0-9]*$/.test(row.transaction_id)&&Number.isSafeInteger(row.backend_id)&&row.backend_id>0);return row;
}
async function readOperation(tx: DbClient, operationId: string, maximum: number) {
  const rows=await tx.execute<Record<string,unknown>>(sql`SELECT operation_id::text,actor_id,supplier_id,order_id,state,kind,request_hash,
    intent,CASE WHEN octet_length(intent_json)<=16384 THEN intent_json END AS intent_json,
    CASE WHEN octet_length(source_json)<=${maximum} THEN source END AS source,
    CASE WHEN octet_length(source_json)<=${maximum} THEN source_json END AS source_json,source_hash,result,created_at
    FROM public.supplier_proactive_refund_operation_v1 WHERE operation_id=${uuid(operationId)}::uuid LIMIT 2`);
  fact(rows.length===1);const row=object(snapshot(rows[0],100_800_768));exact(row,operationKeys);
  fact(row.operation_id===operationId&&row.state==='committed'&&['goods','money','refuse'].includes(String(row.kind)));
  const refused=row.kind==='refuse';
  integer(row.actor_id);integer(row.supplier_id);integer(row.order_id);integer(row.created_at);hash(row.request_hash);hash(row.source_hash);
  const intent=parsed(row.intent_json,16_384),source=parsed(row.source_json,maximum),cash=Object.hasOwn(intent,'cash_returned');
  exact(intent,['version','operation_id','actor_id','supplier_id','order_id','revision','refund_price','type',...(cash?['cash_returned']:[])]);
  fact(intent.version==='supplier-proactive-refund-intent-v1'&&intent.operation_id===operationId&&intent.actor_id===row.actor_id
    &&intent.supplier_id===row.supplier_id&&intent.order_id===row.order_id&&intent.type===(refused?2:1));hash(intent.revision);fact(minor(intent.refund_price)>0n);
  fact(refused?!cash:!cash||intent.cash_returned===true);
  fact(canonical(intent)===canonical(row.intent)&&canonical(source)===canonical(row.source)
    &&await outRequestHash(intent)===row.request_hash&&await outRequestHash(source)===row.source_hash);
  const result=object(row.result);exact(result,['order_id','refund_id','amount','kind','status']);
  fact(result.order_id===row.order_id&&result.kind===row.kind&&result.amount===intent.refund_price);
  if(refused)fact(result.refund_id===null&&result.status==='REFUSED');else integer(result.refund_id);
  return {row,intent:intent as unknown as SupplierProactiveRefundIntent,source,result};
}
async function readDecision(tx: DbClient, operation: Awaited<ReturnType<typeof readOperation>>) {
  const rows=await tx.execute<Record<string,unknown>>(sql`SELECT operation_id::text,actor_id,supplier_id,order_id,kind,outcome,request_hash,
    evidence,evidence_json,evidence_hash,created_at FROM public.supplier_proactive_refund_decision_v1 WHERE operation_id=${String(operation.row.operation_id)}::uuid LIMIT 2`);
  fact(rows.length===1);const row=object(snapshot(rows[0],131_072));exact(row,decisionKeys);const evidence=parsed(row.evidence_json,65_536);exact(evidence,['refund_id']);
  fact(row.operation_id===operation.row.operation_id&&row.actor_id===operation.row.actor_id&&row.supplier_id===operation.row.supplier_id
    &&row.order_id===operation.row.order_id&&row.kind===operation.row.kind&&row.outcome===(operation.row.kind==='refuse'?'refused':'local-settled')&&row.request_hash===operation.row.request_hash
    &&evidence.refund_id===operation.result.refund_id&&canonical(evidence)===canonical(row.evidence)
    &&await outRequestHash(evidence)===hash(row.evidence_hash)&&integer(row.created_at)>=Number(operation.row.created_at));return row;
}
function completedMetadata(order: Pick<Order,'refundType'|'refundStatus'> | Record<string,unknown>): boolean {
  return order.refundType===6&&order.refundStatus===2||order.refundType===3&&order.refundStatus===0;
}
/** A refusal changes presentation metadata, never the already settled goods
 * or money. A0/3 row is accepted only with an immutable6/2 admission at the
 * SAME cumulative amount. Later, larger amounts cannot certify an older money
 * source. Repeated0/3 decisions share that anchor, not a timestamp/UUID order.
 * IDs are loaded once per financial leaf; each requested basis is checked once.
 */
function refusalMetadataReader(tx: DbClient, current: Order, firstRefund: Refund,
  payment: SupplierProactiveMoneyPaymentIdentity, firstTime: number) {
  let admissions: Promise<Array<{operation_id:string;basis:string}>> | undefined;
  const checked=new Map<string,Promise<void>>();
  return async (order: Order): Promise<void> => {
    fact(completedMetadata(order));sameOrder(current,order);
    fact(order.backIntegral===current.backIntegral);
    if(order.refundType===6)return;
    const basis=money(order.refundPrice);
    if(!checked.has(basis))checked.set(basis,(async()=>{
      admissions??=Promise.resolve(tx.execute<{operation_id:string;basis:string}>(sql`SELECT operation_id::text,
        source->'order'->>'refundPrice' AS basis FROM public.supplier_proactive_refund_operation_v1
        WHERE order_id=${order.id} AND kind='refuse' ORDER BY operation_id LIMIT 201`)).then(rows=>[...rows]);
      const all=await admissions;fact(all.length<=200);
      const rows=all.filter(row=>row.basis===basis);fact(rows.length>0);
      let anchor=false;
      for(const identity of rows) {
        const admission=await readOperation(tx,identity.operation_id,16_777_216);await readDecision(tx,admission);
        const {source,intent,row}=admission;
        fact(row.kind==='refuse'&&row.order_id===order.id&&row.supplier_id===order.supplierId&&Number(row.created_at)>=firstTime);
        exact(source,['version','order','carts','payment','refunds','refund_payments','invoices','promotion_rows']);
        fact(source.version==='supplier-proactive-refund-source-v1');
        const before=object(source.order);exact(before,orderKeys);sameOrder(before,order);
        fact(completedMetadata(before)&&before.refundPrice===basis&&before.backIntegral===order.backIntegral
          &&minor(intent.refund_price)>0n&&minor(intent.refund_price)<=minor(order.payPrice)-minor(basis));
        for(const key of ['carts','refunds','refund_payments','invoices','promotion_rows'])
          fact(Array.isArray(source[key])&&(source[key] as unknown[]).length<=200);
        fact((source.carts as unknown[]).length>0);
        const first=(source.refunds as unknown[]).map(object).filter(refund=>refund.id===firstRefund.id);
        fact(first.length===1);exact(first[0],Object.keys(getTableColumns(storeOrderRefund)));
        // Completed refunds retain their public editable remark. This one
        // descriptive field cannot alter any quantity, ownership or money.
        fact(typeof first[0].remark==='string'&&first[0].remark.length<=255
          &&await outRequestHash({...first[0],remark:firstRefund.remark})===await outRequestHash(firstRefund));
        const original=object(source.payment);fact(original.root_id===payment.id);
        if(order.payType==='yue')fact(canonical(paymentIdentity(object(original.root) as unknown as Order))===canonical(payment));
        else fact(original.order_no===payment.order_no&&original.buyer_uid===payment.uid&&original.pay_type===payment.pay_type
          &&original.pay_time===payment.pay_time&&original.amount===payment.pay_price);
        if(before.refundType===6)anchor=true;
      }
      fact(anchor);
    })());
    await checked.get(basis);
  };
}
function rowReference(value: unknown): SupplierProactiveMoneyRowReference {
  const row=object(value);exact(row,['id','hash']);integer(row.id);hash(row.hash);return row as unknown as SupplierProactiveMoneyRowReference;
}
function verifyProof(value: unknown): SupplierProactiveMoneyCompletionProof {
  const proof=object(snapshot(value,65_536));exact(proof,proofKeys);fact(proof.version===SUPPLIER_PROACTIVE_MONEY_COMPLETION_VERSION);
  uuid(proof.operation_id);for(const key of ['actor_id','supplier_id','order_id','first_refund_id','payment_order_id'])integer(proof[key]);
  hash(proof.source_hash);hash(proof.request_hash);fact(minor(proof.amount)>0n&&minor(proof.after_refunded)===minor(proof.before_refunded)+minor(proof.amount));
  const goods=verifyFirst(proof.goods);fact(goods.refund_id===proof.first_refund_id&&goods.order_id===proof.order_id&&goods.supplier_id===proof.supplier_id
    &&['cash','offline','yue'].includes(String(proof.pay_type)));
  rowReference(proof.supplier_transaction);
  if(proof.pay_type==='yue'){rowReference(proof.bill);fact(proof.flow===null);}
  else {fact(proof.bill===null);if(proof.pay_type==='offline')rowReference(proof.flow);else fact(proof.flow===null);}
  return proof as unknown as SupplierProactiveMoneyCompletionProof;
}
async function actualMoneyRows(tx: DbClient, proof: SupplierProactiveMoneyCompletionProof, source: SupplierProactiveMoneySource) {
  const number=supplierProactiveMoneyBusinessNumber(proof.actor_id,proof.operation_id),order=source.order;
  const bills=await tx.select().from(userBill).where(eq(userBill.linkId,number)).limit(2);
  if(proof.pay_type==='yue') {
    fact(bills.length===1);const bill=bills[0];
    fact(bill.id===proof.bill!.id&&bill.uid===order.uid&&bill.type==='pay_product_refund'&&bill.pm===1&&bill.category==='now_money'&&bill.status===1&&bill.eventKey==='supplier_proactive_money_refund'
      &&bill.number===proof.amount&&await outRequestHash(bill)===proof.bill!.hash);
  }else fact(bills.length===0);
  const eventKey=`supplier.proactive-refund:${proof.operation_id}`;
  const flows=await tx.select().from(capitalFlow).where(eq(capitalFlow.eventKey,eventKey)).limit(2);
  if(proof.pay_type==='offline') {
    fact(flows.length===1);const flow=flows[0];fact(flow.id===proof.flow!.id&&flow.uid===order.uid&&flow.storeId===order.storeId
      &&flow.orderId===order.orderId&&flow.flowId===number&&flow.tradingType===2&&flow.payType===order.payType
      &&flow.price===`-${proof.amount}`&&await outRequestHash(flow)===proof.flow!.hash);
  }else fact(flows.length===0);
  const transactions=await tx.select().from(supplierTransactions).where(eq(supplierTransactions.orderId,number)).limit(2);
  fact(transactions.length===1);const actual=transactions[0];
  fact(actual.id===proof.supplier_transaction.id&&actual.supplierId===order.supplierId&&actual.uid===order.uid&&actual.linkId===order.orderId
    &&actual.type===2&&actual.pm===0&&!actual.isDel&&actual.payType===order.payType&&actual.payPrice===proof.amount
    &&actual.totalPrice===order.totalPrice&&actual.payPostage==='0.00'&&await outRequestHash(actual)===proof.supplier_transaction.hash);
}

/** A missing admission must not make an existing payout disappear from the
 * budget. Inspect this order's actual effects, including archived rows. Bills
 * have no order column: classify other-order markers by protected identities
 * and their actual supplier transaction, without certifying that other order. */
async function assertNoUnregisteredMoneyEffects(tx: DbClient, order: Order, transactionIds: number[], flowIds: number[]): Promise<void> {
  const unexpectedTransactions=await tx.select({id:supplierTransactions.id}).from(supplierTransactions).where(and(
    eq(supplierTransactions.linkId,order.orderId),sql`${supplierTransactions.orderId} LIKE 'SR%'`,
    sql`${supplierTransactions.id} NOT IN (${sql.join(transactionIds.map(id=>sql`${id}`),sql`,`)})`)).limit(1);
  const unexpectedFlows=await tx.select({id:capitalFlow.id}).from(capitalFlow).where(and(eq(capitalFlow.orderId,order.orderId),
    sql`${capitalFlow.eventKey} LIKE 'supplier.proactive-refund:%'`,
    flowIds.length?sql`${capitalFlow.id} NOT IN (${sql.join(flowIds.map(id=>sql`${id}`),sql`,`)})`:sql`true`)).limit(1);
  fact(unexpectedTransactions.length===0&&unexpectedFlows.length===0);
  // No buyer-wide history limit: an unmatched dedicated marker is ambiguous,
  // while a fully bound foreign identity contributes nothing to this budget.
  const unknownBills=await tx.execute(sql`SELECT bill.id FROM public.user_bill AS bill
    WHERE bill.uid=${order.uid} AND bill.event_key='supplier_proactive_money_refund' AND NOT EXISTS (
      SELECT 1 FROM public.supplier_refund_money_completion_v1 AS completion
      JOIN public.supplier_proactive_refund_operation_v1 AS operation USING(operation_id)
      JOIN public.supplier_proactive_refund_decision_v1 AS decision USING(operation_id)
      JOIN public.store_order AS original_order ON original_order.id=completion.order_id
      JOIN public.supplier_transactions AS effect ON effect.id::text=completion.proof->'supplier_transaction'->>'id'
      WHERE completion.pay_type='yue' AND completion.proof->>'version'=${SUPPLIER_PROACTIVE_MONEY_COMPLETION_VERSION}
        AND completion.proof->'bill'->>'id'=bill.id::text AND bill.type='pay_product_refund'
        AND bill.category='now_money' AND bill.pm=1 AND bill.status=1 AND bill.number=completion.amount
        AND bill.uid=original_order.uid AND original_order.supplier_id=completion.supplier_id
        AND effect.order_id=bill.link_id AND effect.link_id=original_order.order_id
        AND effect.supplier_id=completion.supplier_id AND effect.uid=bill.uid AND effect.type=2 AND effect.pm=0
        AND effect.pay_type='yue' AND effect.pay_price=completion.amount AND effect.is_del=0
        AND bill.link_id ~ ('^SR[0-9a-z]{1,6}_'||rtrim(translate(encode(uuid_send(completion.operation_id),'base64'),'+/','-_'),'=')||'$')
        AND operation.state='committed' AND operation.kind='money' AND decision.kind='money' AND decision.outcome='local-settled'
        AND operation.actor_id=completion.actor_id AND decision.actor_id=completion.actor_id
        AND operation.supplier_id=completion.supplier_id AND decision.supplier_id=completion.supplier_id
        AND operation.order_id=completion.order_id AND decision.order_id=completion.order_id
        AND operation.request_hash=completion.request_hash AND decision.request_hash=completion.request_hash
        AND operation.source_hash=completion.source_hash
        AND operation.source->>'version'=${SUPPLIER_PROACTIVE_MONEY_SOURCE_VERSION}
        AND operation.result->>'refund_id'=completion.first_refund_id::text
        AND operation.result->>'amount'=completion.amount::text AND operation.result->>'kind'='money'
        AND operation.result->>'status'='BALANCE_SUCCESS' AND decision.evidence->>'refund_id'=completion.first_refund_id::text
        AND completion.proof @> jsonb_build_object('operation_id',completion.operation_id::text,'actor_id',completion.actor_id,
          'supplier_id',completion.supplier_id,'order_id',completion.order_id,'first_refund_id',completion.first_refund_id,
          'payment_order_id',completion.payment_order_id,'pay_type',completion.pay_type,'amount',completion.amount::text,
          'source_hash',completion.source_hash,'request_hash',completion.request_hash,
          'before_refunded',completion.before_refunded::text,'after_refunded',completion.after_refunded::text)
        AND operation.source->'order'->>'id'=completion.order_id::text
        AND operation.source->'order'->>'uid'=bill.uid::text
        AND operation.source->'order'->>'supplierId'=completion.supplier_id::text
        AND operation.source->'goods'=completion.proof->'goods'
    ) LIMIT 1`);
  fact(unknownBills.length===0);
}

/** Financial-history leaf only. The caller MUST also run the mature complete
 * goods/invoice/manual proof with the returned narrowly scoped baseline before
 * issuing a money execution capability. No Supplier login or historical MAC is
 * invented here, and no active-business-row SUM can reset a protected payout. */
export async function readSupplierProactiveMoneyEvidence(tx: DbClient, orderValue: Order): Promise<SupplierProactiveMoneyEvidence> {
  const order=snapshot(orderValue,262_144);exact(object(order),orderKeys);
  const identity=await transaction(tx);await assertSupplierProactiveRefundReady(tx,'read');
  if(!['cash','offline','yue'].includes(order.payType))throw new ServiceUnavailableException('原渠道资金补退的持久回调与对账尚未就绪');
  fact(order.paid===1&&!order.isDel&&!order.isSystemDel&&order.pid>=0&&completedMetadata(order)&&order.supplierId>0);
  const [actualOrder]=await tx.select().from(storeOrder).where(eq(storeOrder.id,order.id)).limit(1);
  fact(actualOrder&&await outRequestHash(actualOrder)===await outRequestHash(order));
  // Inspect protected goods identities before loading any full16MiB source.
  // Deleted/cancelled business history is deliberately absent from this WHERE.
  const goodsRows=await tx.execute<{operation_id:string}>(sql`SELECT operation_id::text FROM public.supplier_proactive_refund_operation_v1
    WHERE order_id=${order.id} AND kind='goods' ORDER BY operation_id LIMIT 2`);
  fact(goodsRows.length===1);const original=await readOperation(tx,goodsRows[0].operation_id,16_777_216);await readDecision(tx,original);
  fact(original.row.kind==='goods'&&original.row.order_id===order.id&&original.row.supplier_id===order.supplierId
    &&original.result.status===(order.payType==='yue'?'BALANCE_SUCCESS':'CASH_SUCCESS'));
  const firstSource=original.source;exact(firstSource,['version','order','carts','payment','refunds','refund_payments','invoices','promotion_rows']);
  fact(firstSource.version==='supplier-proactive-refund-source-v1');
  for(const key of ['carts','refunds','refund_payments','invoices','promotion_rows'])fact(Array.isArray(firstSource[key])&&(firstSource[key] as unknown[]).length<=200);
  const originalOrder=object(firstSource.order);exact(originalOrder,orderKeys);sameOrder(originalOrder,order);
  fact(original.intent.cash_returned===true?order.payType!=='yue':order.payType==='yue');
  const refundId=integer(original.result.refund_id),[firstRefund]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)).limit(1);
  // Archive/cancellation never erases its amount or authorizes a new goods
  // claim. Existing strict historical readers cannot certify it, so fail closed.
  if(!firstRefund||firstRefund.isDel||firstRefund.isCancel)throw new ServiceUnavailableException('原整单完成记录已归档、取消或缺失，已退资金不能重新计算为零');
  fact(firstRefund.storeOrderId===order.id&&firstRefund.uid===order.uid&&firstRefund.supplierId===order.supplierId&&firstRefund.storeId===order.storeId
    &&firstRefund.applyType===4&&firstRefund.refundType===6&&firstRefund.refundPrice===original.intent.refund_price
    &&firstRefund.refundedPrice===firstRefund.refundPrice&&firstRefund.orderId===supplierProactiveMoneyBusinessNumber(Number(original.row.actor_id),original.intent.operation_id));
  const [firstSplit]=await tx.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,refundId)).limit(1);
  fact(firstSplit&&firstSplit.sourceOrderId===order.id&&firstSplit.selectedOrderId===order.id&&firstSplit.remainingOrderId===null
    &&firstSplit.disposition==='whole'&&firstSplit.uid===order.uid&&firstSplit.supplierId===order.supplierId&&firstSplit.storeId===order.storeId
    &&firstSplit.paymentOrderId===(order.pid||order.id)&&firstSplit.fingerprint===await refundOrderSplitFingerprint(firstRefund));
  const archive=parsed(firstSplit.sourceSnapshot,16_777_216,false);fact(archive.version==='refund-order-materialization-v1');sameOrder(archive.source,order);
  const frozenRefund=object(archive.refund);fact(await refundOrderSplitFingerprint(frozenRefund as unknown as Refund)===firstSplit.fingerprint
    &&frozenRefund.refundType===6&&frozenRefund.refundedPrice===firstRefund.refundPrice);
  const claim=readRefundQuantityReservation(firstRefund);fact(claim?.version===CUSTOMER_ROW_REFUND_VERSION&&Array.isArray(firstSource.carts)
    &&firstSource.carts.length>0&&firstSource.carts.length<=200&&claim.items.length===firstSource.carts.length&&firstRefund.refundNum===order.totalNum);
  for(const item of claim!.items) {
    const cart=(firstSource.carts as unknown[]).map(object).find(row=>row.id===item.rowId);
    fact(cart&&cart.oid===order.id&&cart.uid===order.uid&&cart.cartId===refundClaimCartKey(item)&&cart.cartNum===item.totalNum
      &&item.cartNum===item.totalNum&&item.beforeRefundNum===0);
  }
  const [root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,firstSplit.paymentOrderId)).limit(1);
  fact(root&&root.paid===1&&!root.isDel&&!root.isSystemDel&&root.uid===order.uid&&root.payType===order.payType&&root.payTime===order.payTime
    &&(root.id===order.id||root.pid===-1)&&minor(root.payPrice)>=minor(order.payPrice)
    &&(root.supplierId===order.supplierId||root.supplierId===0&&root.supplierAllocationStatus===2)
    &&(root.storeId===order.storeId||root.supplierAllocationStatus===2));
  const payment=paymentIdentity(root),frozenPayment=object(archive.payment);exact(frozenPayment,['id','orderId','payPrice','payType','tradeNo']);
  fact(frozenPayment.id===root.id&&frozenPayment.orderId===root.orderId&&frozenPayment.payPrice===root.payPrice&&frozenPayment.payType===root.payType&&frozenPayment.tradeNo===root.tradeNo);
  const originalPayment=object(firstSource.payment);fact(originalPayment.root_id===root.id);
  if(order.payType==='yue')fact(canonical(paymentIdentity(object(originalPayment.root) as unknown as Order))===canonical(payment));
  else fact(originalPayment.order_no===root.orderId&&originalPayment.buyer_uid===root.uid&&originalPayment.pay_type===root.payType
    &&originalPayment.amount===root.payPrice&&originalPayment.pay_time===root.payTime);
  const firstBills=await tx.select().from(userBill).where(and(eq(userBill.uid,order.uid),eq(userBill.linkId,firstRefund.orderId),eq(userBill.type,'pay_product_refund'))).limit(2);
  if(order.payType==='yue')fact(firstBills.length===1&&firstBills[0].pm===1&&firstBills[0].category==='now_money'&&firstBills[0].status===1&&firstBills[0].number===firstRefund.refundPrice);
  else fact(firstBills.length===0);
  const firstFlows=await tx.select().from(capitalFlow).where(eq(capitalFlow.eventKey,`supplier.proactive-refund:${original.intent.operation_id}`)).limit(2);
  if(order.payType==='offline')fact(firstFlows.length===1&&firstFlows[0].uid===order.uid&&firstFlows[0].storeId===order.storeId
    &&firstFlows[0].orderId===order.orderId&&firstFlows[0].flowId===firstRefund.orderId&&firstFlows[0].tradingType===2
    &&firstFlows[0].payType==='offline'&&firstFlows[0].price===`-${firstRefund.refundPrice}`);
  else fact(firstFlows.length===0);
  const channels=await tx.select({id:storeOrderRefundPayment.id}).from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refundId)).limit(1);fact(channels.length===0);
  const ledger=object(archive.supplierLedger);
  const originalFlowIds=new Set([integer(object(ledger.income).id),integer(object(ledger.expense).id)]);
  const activeFlows=await tx.select({id:supplierFlowingWater.id}).from(supplierFlowingWater).where(and(
    eq(supplierFlowingWater.supplierId,order.supplierId),eq(supplierFlowingWater.linkId,order.orderId),
    eq(supplierFlowingWater.isDel,0),sql`${supplierFlowingWater.status} IN (0,1)`)).limit(3);
  fact(originalFlowIds.size===2&&activeFlows.length===2&&activeFlows.every(row=>originalFlowIds.has(row.id)));
  for(const key of ['income','expense']) {
    const frozen=object(ledger[key]),rows=await tx.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.id,integer(frozen.id))).limit(1);
    fact(rows.length===1&&await outRequestHash(rows[0])===await outRequestHash(frozen));
  }
  const frozenTransaction=object(ledger.transaction),firstTransactions=await tx.select().from(supplierTransactions).where(eq(supplierTransactions.id,integer(frozenTransaction.id))).limit(1);
  fact(firstTransactions.length===1&&await outRequestHash(firstTransactions[0])===await outRequestHash(frozenTransaction)
    &&Array.isArray(ledger.derivedFlowIds)&&ledger.derivedFlowIds.length===0);
  fact(new TextEncoder().encode(firstSplit.invoiceAllocation).length<=16_384);
  let allocation:unknown;try{allocation=snapshot(JSON.parse(firstSplit.invoiceAllocation),16_384);}catch{throw fail();}
  const originalInvoice=allocation===null?null:object(object(allocation).original);
  const first:SupplierProactiveFirstGoodsReference=Object.freeze({operation_id:original.intent.operation_id,actor_id:Number(original.row.actor_id),supplier_id:order.supplierId,
    order_id:order.id,refund_id:refundId,request_hash:String(original.row.request_hash),source_hash:String(original.row.source_hash),amount:firstRefund.refundPrice,
    split_fingerprint:firstSplit.fingerprint,invoice_allocation_hash:await outRequestHash(allocation)});
  verifyFirst(first);
  const verifyMetadata=refusalMetadataReader(tx,order,firstRefund,payment,Number(original.row.created_at));
  const paymentRows=await tx.execute(sql`SELECT operation_id FROM public.supplier_refund_money_payment_v1 WHERE order_id=${order.id} LIMIT 201`);fact(paymentRows.length===0);
  const moneyOperations=await tx.execute<{operation_id:string}>(sql`SELECT operation_id::text FROM public.supplier_proactive_refund_operation_v1
    WHERE order_id=${order.id} AND kind='money' ORDER BY operation_id LIMIT 201`);fact(moneyOperations.length<=200);
  const rows=await tx.execute<Record<string,unknown>>(sql`SELECT operation_id::text,actor_id,supplier_id,order_id,first_refund_id,payment_order_id,
    amount::text,pay_type,source_hash,request_hash,before_refunded::text,after_refunded::text,
    CASE WHEN octet_length(proof_json)<=65536 THEN proof END AS proof,CASE WHEN octet_length(proof_json)<=65536 THEN proof_json END AS proof_json,
    proof_hash,created_at FROM public.supplier_refund_money_completion_v1 AS completion WHERE order_id=${order.id}
    ORDER BY completion.before_refunded,completion.operation_id LIMIT 201`);
  fact(rows.length<=200&&rows.length===moneyOperations.length);
  const operations=new Set(moneyOperations.map(row=>uuid(row.operation_id))),completions:SupplierProactiveMoneyCompletionReference[]=[];
  const actualTransactionIds=[firstTransactions[0].id],actualFlowIds=firstFlows.map(row=>row.id);
  let refunded=minor(first.amount);
  for(const raw of rows) {
    const row=object(snapshot(raw,262_144));exact(row,moneyRowKeys);const proof=verifyProof(parsed(row.proof_json,65_536));
    fact(canonical(proof)===canonical(row.proof)&&await outRequestHash(proof)===hash(row.proof_hash)&&operations.delete(uuid(row.operation_id))
      &&row.operation_id===proof.operation_id&&canonical(proof.goods)===canonical(first)&&proof.pay_type===order.payType
      &&integer(row.created_at)>=Number(original.row.created_at)&&minor(row.before_refunded)===refunded);
    for(const key of ['actor_id','supplier_id','order_id','first_refund_id','payment_order_id','amount','pay_type','source_hash','request_hash','before_refunded','after_refunded'])
      fact(row[key]===(proof as unknown as Record<string,unknown>)[key]);
    fact(proof.order_id===order.id&&proof.supplier_id===order.supplierId&&proof.first_refund_id===refundId&&proof.payment_order_id===root.id);
    const operation=await readOperation(tx,proof.operation_id,65_536);await readDecision(tx,operation);
    fact(operation.row.kind==='money'&&operation.row.actor_id===proof.actor_id&&operation.row.supplier_id===proof.supplier_id
      &&operation.row.order_id===order.id&&operation.row.request_hash===proof.request_hash&&operation.row.source_hash===proof.source_hash
      &&operation.result.refund_id===refundId&&operation.result.amount===proof.amount&&operation.result.status===(order.payType==='yue'?'BALANCE_SUCCESS':'CASH_SUCCESS'));
    const source=verifySupplierProactiveMoneySource(operation.source,operation.intent);sameOrder(source.order,order);
    fact(canonical(source.goods)===canonical(first)&&canonical(source.payment)===canonical(payment)&&canonical(source.history.completions)===canonical(completions)
      &&source.order.refundPrice===proof.before_refunded&&minor(proof.after_refunded)<=minor(order.payPrice));
    await verifyMetadata(source.order);
    await actualMoneyRows(tx,proof,source);refunded=minor(proof.after_refunded);
    actualTransactionIds.push(proof.supplier_transaction.id);if(proof.flow)actualFlowIds.push(proof.flow.id);
    completions.push(Object.freeze({operation_id:proof.operation_id,amount:proof.amount,before_refunded:proof.before_refunded,after_refunded:proof.after_refunded,proof_hash:String(row.proof_hash)}));
  }
  fact(operations.size===0&&refunded===minor(order.refundPrice)&&refunded<=minor(order.payPrice));
  await assertNoUnregisteredMoneyEffects(tx,order,actualTransactionIds,actualFlowIds);
  await verifyMetadata(order);
  const baseline=Object.freeze({}) as SupplierProactiveMoneyBaseline;
  baselines.set(baseline,{transaction:identity,orderHash:await outRequestHash(order),first});
  const evidence=Object.freeze({first,firstRefund:snapshot(firstRefund,262_144),firstSplit:snapshot(firstSplit,100_800_768),originalInvoice,
    firstSource,payment,paymentRoot:snapshot(root,262_144),completions:Object.freeze(completions),payments:Object.freeze([]) as readonly never[],
    refunded:decimal(refunded),paid:money(order.payPrice),available:decimal(minor(order.payPrice)-refunded),baseline});
  evidenceStates.set(evidence,{orderJson:canonical(order)});return evidence;
}
/** Only the certified first-goods amount and its proven completed metadata
 * receive a projected view. Every other field and every write uses the actual
 * row; unproved0/3 state never mints this same-transaction baseline. */
export async function projectSupplierProactiveMoneyBaseline(tx: DbClient, baseline: SupplierProactiveMoneyBaseline,
  selected: Order, refund: Refund, record: Split): Promise<Order> {
  const order=snapshot(selected,262_144),state=baselines.get(baseline);fact(state);if(!state)throw fail();
  const identity=await transaction(tx),first=state.first;
  fact(identity.transaction_id===state.transaction.transaction_id&&identity.backend_id===state.transaction.backend_id
    &&await outRequestHash(order)===state.orderHash&&order.id===first.order_id&&refund.id===first.refund_id
    &&refund.storeOrderId===order.id&&refund.supplierId===order.supplierId&&refund.refundPrice===first.amount
    &&record.refundId===refund.id&&record.sourceOrderId===order.id&&record.selectedOrderId===order.id&&record.disposition==='whole'
    &&record.remainingOrderId===null&&record.fingerprint===first.split_fingerprint&&await refundOrderSplitFingerprint(refund)===first.split_fingerprint);
  const [actual]=await tx.select().from(storeOrder).where(eq(storeOrder.id,order.id)).limit(1);fact(actual&&await outRequestHash(actual)===state.orderHash);
  return {...order,refundPrice:first.amount,refundType:6,refundStatus:2};
}
/** Append within the owning payout transaction, after its actual rows and
 * immutable decision exist. Read the COMPLETE resulting history before return;
 * any failure must escape the caller's transaction and roll every write back. */
export async function appendSupplierProactiveMoneyCompletion(tx: DbClient, value: SupplierProactiveMoneyCompletionProof, now: number): Promise<SupplierProactiveMoneyCompletionReference> {
  const proof=verifyProof(value),createdAt=integer(now),proofJson=canonical(proof),proofHash=await outRequestHash(proof);await transaction(tx);
  await assertSupplierProactiveRefundReady(tx);
  await tx.execute(sql`INSERT INTO public.supplier_refund_money_completion_v1
    (operation_id,actor_id,supplier_id,order_id,first_refund_id,payment_order_id,amount,pay_type,source_hash,request_hash,before_refunded,after_refunded,proof,proof_json,proof_hash,created_at)
    VALUES(${proof.operation_id}::uuid,${proof.actor_id},${proof.supplier_id},${proof.order_id},${proof.first_refund_id},${proof.payment_order_id},${proof.amount},${proof.pay_type},
      ${proof.source_hash},${proof.request_hash},${proof.before_refunded},${proof.after_refunded},${proofJson}::jsonb,${proofJson},${proofHash},${createdAt})`);
  const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,proof.order_id)).limit(1);fact(order);if(!order)throw fail();
  const evidence=await readSupplierProactiveMoneyEvidence(tx,order),saved=evidence.completions.find(row=>row.operation_id===proof.operation_id);
  fact(saved&&saved.proof_hash===proofHash);return saved!;
}
