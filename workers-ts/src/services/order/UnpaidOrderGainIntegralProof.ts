import { asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefundSplit } from '@/models/schema';
import { assertSupplierOrderEditOperationReadable } from '@/migrations/supplierOrderEditOperation';
import { assertLegacyOrderGainPartitionReady } from '@/migrations/legacyOrderGainPartition';
import { ValidateException } from '@/utils/errors';
import { planOrderFinancialSplit } from './OrderSplitFinance';
import { loadRefundOrderGeneration } from './RefundOrderGeneration';
import { parseSecondCardValiditySnapshot, resolveSecondCardValidityAtCheckout, resolveSecondCardValidityAtPayment } from './SecondCardValidityService';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
export const LEGACY_GAIN_EDIT_MARKER = 'unpaid_gain_integral_edit';
export const LEGACY_EDITED_GAIN_FINANCIAL_VERSION = 'legacy-php-edited-line-finance-v1';
export const LEGACY_EDITED_GAIN_SOURCE = 'edited-php-purchase-facts-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const invalid = () => new ValidateException('旧订单已编辑赠分的受保护来源凭据不一致，请核对订单');
declare const proofBrand: unique symbol;
/** Only this module can mint an instance; deserialized JSON is not a proof. */
export interface LegacyGainIntegralProof { readonly [proofBrand]: true }
interface LineState {
  row_id: number; cart_id: string; order_id: number; buyer_id: number; product_id: number;
  owner_type: number; relation_id: number; sku_unique: string; quantity: number; is_gift: number;
  sha256: string; purchase_sql_sha256: string;
}
interface State { order_id: number; buyer_id: number; supplier_id: number; lines: LineState[] }
interface Reference { kind: 'operation' | 'partition'; id: string; hash: string }
interface ProofData {
  operationId: string; originalOrderId: number; supplierId: number; buyerId: number;
  reference: Reference; bindings: Map<string, number>; durable: boolean;
}
const proofs = new WeakMap<object, ProofData>();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, canonical(item)]));
  return value;
}
const canonicalJson = (value: unknown) => JSON.stringify(canonical(value));
function parse(value: string | null): Record<string, unknown> {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 65_536) throw invalid();
  try { return object(JSON.parse(value)); } catch { throw invalid(); }
}
function whole(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^(?:0|[1-9]\d{0,9})(?:\.00)?$/.test(String(value))) throw invalid();
  const result = Number(value); if (!Number.isSafeInteger(result) || result < 0 || result > 9_999_999_999) throw invalid();
  return result;
}
function positive(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2_147_483_647) throw invalid();
  return value;
}
export async function gainEditSha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
/** Stable purchase/line identity SQL facts. Refund/fulfillment/writeoff
 * counters, notification flags and current staff/delivery assignments are
 * lifecycle state, independently proved by the owning business operation. */
function purchaseFacts(row: Cart) {
  return {id:row.id,oid:row.oid,uid:row.uid,cartId:row.cartId,type:row.type,relationId:row.relationId,
    productId:row.productId,productType:row.productType,skuUnique:row.skuUnique,promotionsId:row.promotionsId,
    isGift:row.isGift,isSupportRefund:row.isSupportRefund,cartNum:row.cartNum,oldCartId:row.oldCartId,
    settlePrice:row.settlePrice,writeTimes:row.writeTimes,writeStart:row.writeStart,writeEnd:row.writeEnd,
    unique:row.unique,addTime:row.addTime};
}
/** A relative second-card validity window is activated by the real paid
 * consumer. Validate that lifecycle transition before hashing its immutable
 * checkout form; a changed window must never masquerade as purchase facts. */
export function unpaidGainPurchaseRows(order: Pick<Order, 'paid' | 'payTime'>, rows: readonly Cart[]): Cart[] {
  return rows.map(row => {
    if (row.productType !== 4) return row;
    const snapshot = parseSecondCardValiditySnapshot(row.cartInfo);
    if (!snapshot) return row;
    try {
      const checkout = resolveSecondCardValidityAtCheckout(snapshot);
      const paid = order.paid === 1 ? resolveSecondCardValidityAtPayment(snapshot, order.payTime, checkout) : checkout;
      if (!(row.writeStart === checkout.writeStart && row.writeEnd === checkout.writeEnd)
        && !(order.paid === 1 && row.writeStart === paid.writeStart && row.writeEnd === paid.writeEnd)) throw invalid();
      return { ...row, ...checkout };
    } catch { throw invalid(); }
  });
}
function key(row: Cart): string {
  return canonicalJson([purchaseFacts(row),row.cartInfo]);
}
function marker(info: Record<string, unknown>): string | null {
  if (!Object.hasOwn(info, LEGACY_GAIN_EDIT_MARKER)) return null;
  const item = object(info[LEGACY_GAIN_EDIT_MARKER]);
  if (Object.keys(item).sort().join(',') !== 'operation_id,version' || item.version !== 'supplier-unpaid-gain-edit-v1'
    || typeof item.operation_id !== 'string' || !UUID.test(item.operation_id)) throw invalid();
  return item.operation_id;
}
function mint(data: Omit<ProofData, 'bindings'>, rows: readonly Cart[]): LegacyGainIntegralProof {
  const value = Object.freeze({}) as LegacyGainIntegralProof;
  proofs.set(value, { ...data, bindings: new Map(rows.map(row => {
    const info = parse(row.cartInfo); if (marker(info) !== data.operationId) throw invalid();
    return [key(row), whole(info.gain_integral)];
  })) });
  return value;
}
export function legacyGainIntegralForLine(proof: LegacyGainIntegralProof | null | undefined, row: Cart): number | undefined {
  const info = parse(row.cartInfo);
  if (!marker(info)) return undefined;
  const data = proof && proofs.get(proof), result = data?.bindings.get(key(row));
  if (!data || data.operationId !== marker(info) || result === undefined) throw invalid();
  return result;
}
export function hasLegacyGainIntegralMarker(rows: readonly Pick<Cart, 'cartInfo'>[]): boolean {
  return rows.some(row => typeof row.cartInfo === 'string' && row.cartInfo.includes(LEGACY_GAIN_EDIT_MARKER)
    && Object.hasOwn(parse(row.cartInfo), LEGACY_GAIN_EDIT_MARKER));
}
export async function legacyGainIntegralState(order: Pick<Order, 'id' | 'uid' | 'supplierId' | 'paid' | 'payTime'>, rows: readonly Cart[]): Promise<{ state: State; hash: string }> {
  if (!rows.length || rows.length > 200) throw invalid();
  const sorted = unpaidGainPurchaseRows(order, rows).sort((a, b) => a.id - b.id);
  if (new Set(sorted.map(row => row.id)).size !== sorted.length) throw invalid();
  const lines = await Promise.all(sorted.map(async row => {
    if (row.oid !== order.id || row.uid !== order.uid || typeof row.cartInfo !== 'string') throw invalid();
    return { row_id: positive(row.id), cart_id: row.cartId, order_id: row.oid, buyer_id: row.uid,
      product_id: positive(row.productId), owner_type: row.type, relation_id: row.relationId,
      sku_unique: row.skuUnique, quantity: positive(row.cartNum), is_gift: row.isGift, sha256: await gainEditSha256(row.cartInfo),
      purchase_sql_sha256:await gainEditSha256(canonicalJson(purchaseFacts(row))) };
  }));
  const state: State = { order_id: positive(order.id), buyer_id: positive(order.uid, true), supplier_id: positive(order.supplierId, true), lines };
  return { state, hash: await gainEditSha256(canonicalJson(state)) };
}

/** Internal transition capability, not durable SQL authority. Only used after
 * the editor's complete BEFORE proof and for its exact proposed AFTER rows. */
export function plannedLegacyGainIntegralProof(order: Order, rows: readonly Cart[], operationId: string): LegacyGainIntegralProof {
  if (!UUID.test(operationId) || order.supplierId <= 0) throw invalid();
  return mint({ operationId, originalOrderId: order.id, supplierId: order.supplierId, buyerId: order.uid,
    reference: { kind: 'operation', id: operationId, hash: '' }, durable: false }, rows);
}
/** Called only by the reconciled pure financial partition. No SQL authority is
 * added: actual child identities/hashes still need an immutable baseline. */
export function partitionLegacyGainIntegralProof(proof: LegacyGainIntegralProof | null | undefined,
  rows: readonly Cart[]): LegacyGainIntegralProof | null {
  if (!proof) return null;
  const data = proofs.get(proof); if (!data) throw invalid();
  return rows.length ? mint({ ...data, durable: false }, rows) : null;
}

interface Operation {
  operation_id: string; supplier_id: number; order_id: number; state: string;
  before_hash: string; after_hash: string; evidence: unknown; result: unknown;
}
interface Partition {
  partition_id: string; operation_id: string; source_order_id: number; child_order_id: number;
  buyer_id: number; supplier_id: number; source_hash: string; child_hash: string; evidence: unknown;
  kind: 'allocation'|'fulfillment'|'refund'; created_at: number;
}
function reference(value: unknown): Reference {
  const item = object(value);
  if (Object.keys(item).sort().join(',') !== 'hash,id,kind' || !['operation', 'partition'].includes(String(item.kind))
    || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.hash !== 'string' || !SHA.test(item.hash)) throw invalid();
  return { kind: item.kind as Reference['kind'], id: item.id, hash: item.hash };
}
/** No marker means NO new table prerequisite. A marker never authorizes a
 * grant: the exact original receipt or exact immutable child-state hash does.
 * Only compact ancestry is read; no recursive full purchase snapshots. */
export async function loadUnpaidOrderGainIntegralProof(tx: DbClient, order: Order, rows: readonly Cart[]): Promise<LegacyGainIntegralProof | null> {
  if (!hasLegacyGainIntegralMarker(rows)) return null;
  const ids = rows.map(row => marker(parse(row.cartInfo)));
  const operationId = ids[0];
  if (!operationId || ids.some(id => id !== operationId)) throw invalid();
  await assertSupplierOrderEditOperationReadable(tx);
  const [operation] = await tx.execute(sql`SELECT operation_id::text,supplier_id,order_id,state,before_hash,after_hash,
    CASE WHEN octet_length(evidence::text)<=196608 THEN evidence ELSE NULL END AS evidence,result
    FROM public.supplier_order_edit_operation_v1 WHERE operation_id=${operationId}::uuid`) as unknown as Operation[];
  if (!operation || operation.state !== 'committed' || operation.operation_id !== operationId
    || !SHA.test(operation.before_hash) || !SHA.test(operation.after_hash)) throw invalid();
  const evidence = object(operation.evidence), source = object(evidence.source), result = object(operation.result);
  if (evidence.version !== 'supplier-unpaid-gain-edit-v1' || evidence.operation_id !== operationId
    || evidence.source_format !== 'legacy-php' || source.order_id !== operation.order_id
    || source.supplier_id !== operation.supplier_id || source.buyer_id !== order.uid
    || !SHA.test(String(evidence.after_state_sha256)) || result.id !== operation.order_id
    || !Array.isArray(evidence.lines) || !evidence.lines.length || evidence.lines.length > 200
    || whole(result.gain_integral)!==whole(evidence.after_total)) throw invalid();
  positive(operation.supplier_id); positive(operation.order_id);
  const current = await legacyGainIntegralState(order, rows);
  if (current.hash === evidence.after_state_sha256 && order.id === operation.order_id) {
    for (const row of rows) {
      const matches = evidence.lines.filter(value => object(value).row_id === row.id);
      if (matches.length !== 1) throw invalid();
      const line = object(matches[0]), state = current.state.lines.find(item => item.row_id === row.id)!;
      if (line.cart_id !== row.cartId || line.product_id !== row.productId || line.quantity !== row.cartNum
        || line.is_gift !== row.isGift || line.after_sha256 !== state.sha256
        || whole(line.after_gain_integral) !== whole(parse(row.cartInfo).gain_integral)) throw invalid();
    }
    if (evidence.lines.length !== rows.length) throw invalid();
    return mint({ operationId, originalOrderId: operation.order_id, supplierId: operation.supplier_id,
      buyerId: order.uid, reference: { kind: 'operation', id: operationId, hash: current.hash }, durable: true }, rows);
  }
  await assertLegacyOrderGainPartitionReady(tx, 'read');
  const records = await tx.execute(sql`SELECT partition_id::text,operation_id::text,source_order_id,child_order_id,
    buyer_id,supplier_id,source_hash,child_hash,CASE WHEN octet_length(evidence::text)<=196608 THEN evidence ELSE NULL END AS evidence
    FROM public.legacy_order_gain_partition_v1 WHERE child_order_id=${order.id} AND child_hash=${current.hash} LIMIT 2`) as unknown as Partition[];
  if (records.length !== 1) throw invalid();
  const leaf = records[0], body = object(leaf.evidence);
  if (leaf.operation_id !== operationId || leaf.child_order_id !== order.id || leaf.buyer_id !== order.uid
    || leaf.supplier_id !== operation.supplier_id || leaf.child_hash !== current.hash
    || body.version !== 'legacy-order-gain-partition-v1'
    || canonicalJson(body.child) !== canonicalJson(current.state)) throw invalid();
  if(Object.keys(body).sort().join(',')!=='amounts,child,mappings,role,selection,source,source_reference,version'
    || !['selected','remaining'].includes(String(body.role)) || !Array.isArray(body.selection)
    || !body.selection.length || body.selection.length>200 || !Array.isArray(body.mappings)
    || body.mappings.length!==rows.length || await gainEditSha256(canonicalJson(body.source))!==leaf.source_hash)throw invalid();
  const frozen=object(body.source);
  if(frozen.order_id!==leaf.source_order_id||frozen.buyer_id!==order.uid||!Array.isArray(frozen.lines)
    ||!frozen.lines.length||frozen.lines.length>200)throw invalid();
  const quantities=new Map<string,number>();
  for(const value of body.selection){const item=object(value);if(Object.keys(item).sort().join(',')!=='cart_id,cart_num'
    ||typeof item.cart_id!=='string'||!item.cart_id||item.cart_id.length>128||quantities.has(item.cart_id))throw invalid();
    quantities.set(item.cart_id,positive(item.cart_num));}
  const seen=new Set<number>();
  for(const value of body.mappings){const item=object(value),row=rows.find(cart=>cart.id===item.rowId);
    const original=frozen.lines.map(object).find(line=>line.row_id===item.sourceRowId);
    if(Object.keys(item).sort().join(',')!=='cartId,quantity,rowId,sourceRowId'||!row||!original||seen.has(row.id)
      ||item.cartId!==row.cartId||item.quantity!==row.cartNum||original.product_id!==row.productId
      ||original.owner_type!==row.type||original.relation_id!==row.relationId||original.sku_unique!==row.skuUnique
      ||original.is_gift!==row.isGift)throw invalid();
    const selected=quantities.get(String(original.cart_id))??0,total=positive(original.quantity);
    if(selected>total||row.cartNum!==(body.role==='selected'?selected:total-selected))throw invalid();seen.add(row.id);
  }
  for(const [field,value]of Object.entries(object(body.amounts))){
    if(['giveIntegral','giveCoupon','promotionsGive'].includes(field))continue;
    if(order[field as keyof Order]!==value)throw invalid();
  }
  let child = leaf, ref = reference(body.source_reference);
  const visited = new Set<string>();
  for (let depth = 0; ; depth++) {
    if (depth > 402 || visited.has(ref.id) || ref.hash !== child.source_hash) throw invalid();
    visited.add(ref.id);
    if (ref.kind === 'operation') {
      if (ref.id !== operationId || ref.hash !== evidence.after_state_sha256 || child.source_order_id !== operation.order_id) throw invalid();
      break;
    }
    const [parent] = await tx.execute(sql`SELECT partition_id::text,operation_id::text,source_order_id,child_order_id,
      buyer_id,supplier_id,source_hash,child_hash,jsonb_build_object('source_reference',evidence->'source_reference') AS evidence
      FROM public.legacy_order_gain_partition_v1 WHERE partition_id=${ref.id}::uuid`) as unknown as Partition[];
    if (!parent || parent.operation_id !== operationId || parent.child_order_id !== child.source_order_id
      || parent.buyer_id !== order.uid || parent.supplier_id !== operation.supplier_id || parent.child_hash !== ref.hash) throw invalid();
    child = parent; ref = reference(object(parent.evidence).source_reference);
  }
  return mint({ operationId, originalOrderId: operation.order_id, supplierId: operation.supplier_id,
    buyerId: order.uid, reference: { kind: 'partition', id: leaf.partition_id, hash: current.hash }, durable: true }, rows);
}

export interface LegacyGainPartitionChild {
  orderId: number; role: 'selected' | 'remaining';
  rows: Array<{ sourceRowId: number; rowId: number; cartId: string; quantity: number; expectedUnique:string }>;
  refundId?: number;
}
/** Append only AFTER actual child rows and any existing refund generation have
 * been materialized in this same transaction. Every byte is re-read and
 * compared with a fresh strict financial plan; a suppressed/late SQL mutation
 * aborts the entire caller transaction. No arbitrary keys or claimed hashes. */
export async function recordLegacyGainIntegralPartitions(tx: DbClient, sourceOrder: Order, sourceRows: Cart[],
  proof: LegacyGainIntegralProof | null | undefined, selection: ReadonlyMap<string, number>,
  children: readonly LegacyGainPartitionChild[], kind: 'allocation' | 'fulfillment' | 'refund', now: number): Promise<void> {
  if (!hasLegacyGainIntegralMarker(sourceRows)) return;
  const data = proof && proofs.get(proof);
  if (!data?.durable || Object.hasOwn(tx, '$client') || !children.length || children.length > 200) throw invalid();
  for (const row of sourceRows) legacyGainIntegralForLine(proof, row);
  const original = await legacyGainIntegralState(sourceOrder, sourceRows);
  if (original.hash !== data.reference.hash) throw invalid();
  const plan = planOrderFinancialSplit({ ...sourceOrder, refundPrice: '0.00', backIntegral: '0.00' },
    sourceRows.map(row => ({ ...row, refundNum: 0, splitStatus: 0, splitSurplusNum: row.cartNum })), selection, proof);
  if (!plan) throw invalid();
  await assertLegacyOrderGainPartitionReady(tx);
  for (const child of children) {
    const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, child.orderId)).limit(1);
    if (!order || order.uid !== sourceOrder.uid) throw invalid();
    const rows = await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, child.orderId))
      .orderBy(asc(storeOrderCartInfo.id)).limit(201);
    const current = await legacyGainIntegralState(order, rows);
    if (current.hash === original.hash) continue;
    if (rows.length !== child.rows.length || new Set(child.rows.map(row => row.rowId)).size !== rows.length) throw invalid();
    const amounts = plan[child.role];
    for (const [field, value] of Object.entries(amounts)) {
      if (field === 'giveIntegral' || field === 'giveCoupon' || field === 'promotionsGive') continue;
      if (order[field as keyof Order] !== value) throw invalid();
    }
    let generation: Awaited<ReturnType<typeof loadRefundOrderGeneration>> = null;
    if (child.refundId) {
      const [receipt] = await tx.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, child.refundId)).limit(1);
      if (!receipt || receipt.sourceOrderId !== sourceOrder.id || receipt.uid !== order.uid
        || (child.role === 'selected' ? receipt.selectedOrderId : receipt.remainingOrderId) !== order.id) throw invalid();
    } else if (rows.some(row => parse(row.cartInfo).financial_version === 'refund-order-line-finance-v1')) {
      generation = await loadRefundOrderGeneration(tx, order, rows); if (!generation) throw invalid();
    }
    for (const row of rows) {
      const mapping = child.rows.find(item => item.rowId === row.id), source = sourceRows.find(item => item.id === mapping?.sourceRowId);
      if (!mapping || !source || mapping.cartId !== row.cartId || mapping.quantity !== row.cartNum
        || typeof mapping.expectedUnique!=='string'||row.unique!==mapping.expectedUnique
        || row.uid !== source.uid || row.productId !== source.productId || row.type !== source.type
        || row.relationId !== source.relationId || row.skuUnique !== source.skuUnique || row.isGift !== source.isGift) throw invalid();
      for(const field of ['productType','promotionsId','isSupportRefund','settlePrice','writeStart','writeEnd','addTime'] as const)
        if(row[field]!==source[field])throw invalid();
      const expectedOldCartId=row.id===source.id&&row.oid===source.oid&&kind!=='fulfillment'
        ?source.oldCartId:source.oldCartId||source.cartId;
      if(row.oldCartId!==expectedOldCartId)throw invalid();
      const part = plan.carts.get(source.cartId)?.[child.role]; if (!part) throw invalid();
      const writeoff=plan.carts.get(source.cartId)?.[child.role==='selected'?'selectedWriteoff':'remainingWriteoff'];
      if(!writeoff||row.writeTimes!==writeoff.writeTimes)throw invalid();
      const expected = { ...parse(part), id: row.cartId };
      // A single-owner payment allocation changes only the root Supplier.
      // The original raw PHP purchase bytes legitimately stay unprojected.
      if(kind==='allocation'&&row.cartNum===source.cartNum&&row.cartInfo===source.cartInfo)continue;
      if (child.refundId) Object.assign(expected, { financial_version: 'refund-order-line-finance-v1',
        refund_order_generation: { refundId: child.refundId, role: child.role } });
      else if (generation) Object.assign(expected, { financial_version: 'refund-order-line-finance-v1',
        refund_order_generation: parse(row.cartInfo).refund_order_generation });
      if (JSON.stringify(parse(row.cartInfo)) !== JSON.stringify(expected)) throw invalid();
    }
    const existing = await tx.execute(sql`SELECT partition_id FROM public.legacy_order_gain_partition_v1
      WHERE child_order_id=${order.id} AND child_hash=${current.hash} LIMIT 1`);
    if (existing.length) { await loadUnpaidOrderGainIntegralProof(tx, order, rows); continue; }
    const id = crypto.randomUUID(), evidence = { version: 'legacy-order-gain-partition-v1', source_reference: data.reference,
      source: original.state, child: current.state, selection: [...selection].map(([cart_id, cart_num]) => ({ cart_id, cart_num })),
      role: child.role, amounts, mappings: child.rows.map(({sourceRowId,rowId,cartId,quantity})=>({sourceRowId,rowId,cartId,quantity})) };
    const expected={partition_id:id,operation_id:data.operationId,source_order_id:sourceOrder.id,child_order_id:order.id,
      buyer_id:order.uid,supplier_id:data.supplierId,kind,source_hash:original.hash,child_hash:current.hash,evidence,created_at:positive(now)};
    const [record] = await tx.execute(sql`INSERT INTO public.legacy_order_gain_partition_v1
      (partition_id,operation_id,source_order_id,child_order_id,buyer_id,supplier_id,kind,source_hash,child_hash,evidence,created_at)
      VALUES(${id}::uuid,${data.operationId}::uuid,${sourceOrder.id},${order.id},${order.uid},${data.supplierId},${kind},
        ${original.hash},${current.hash},${JSON.stringify(evidence)}::jsonb,${expected.created_at})
      RETURNING partition_id::text,operation_id::text,source_order_id,child_order_id,buyer_id,supplier_id,
        kind,source_hash,child_hash,evidence,created_at`);
    if (canonicalJson(record)!==canonicalJson(expected)) throw invalid();
    const [readback]=await tx.execute(sql`SELECT partition_id::text,operation_id::text,source_order_id,child_order_id,buyer_id,supplier_id,
      kind,source_hash,child_hash,evidence,created_at FROM public.legacy_order_gain_partition_v1 WHERE partition_id=${id}::uuid`);
    if(canonicalJson(readback)!==canonicalJson(expected))throw invalid();
    await loadUnpaidOrderGainIntegralProof(tx, order, rows);
  }
}
