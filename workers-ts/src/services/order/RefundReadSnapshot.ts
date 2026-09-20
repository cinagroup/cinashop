import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrderRefundSplit } from '@/models/schema/order_refund_split';
import { ValidateException } from '@/utils/errors';
import { MATERIALIZED_REFUND_VERSION, readRefundQuantityReservation } from './RefundQuantityReservation';
import { refundOrderSplitFingerprint, type RefundMaterializationIdentity } from './RefundOrderSplitIdentity';

export interface RefundReadItem { id: number; cartId: number; name: string; sku: string; image: string; quantity: number | null }
export interface RefundHistoryView {
  version: 1; refundId: number; sourceOrderId: number; physicalOrderId: number | null;
  items: RefundReadItem[]; itemsError: string;
}
type Refund = RefundMaterializationIdentity & { refundType: number; refundedPrice: string; isCancel: number };
const invalid = () => new ValidateException('退款历史商品证据不一致，请联系商家核对');
const integer = (n: unknown, zero = false): n is number => typeof n === 'number' && Number.isSafeInteger(n)
  && n >= (zero ? 0 : 1) && n <= 2147483647;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, fallback: string) {
  if (value === null) return fallback;
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 4096) throw invalid();
  return value;
}

/** Caller already authorized the original refund/order and owns one read-only
 * snapshot transaction. Never reinterpret current remainder carts as history.
 * Legacy/nonterminal applications do not require the new evidence relation. */
export async function readMaterializedRefundSnapshot(db: DbClient, refund: Refund): Promise<{
  physicalOrderId: number; items: RefundReadItem[];
} | null> {
  const claim = readRefundQuantityReservation(refund);
  if (claim?.version !== MATERIALIZED_REFUND_VERSION || refund.refundType !== 6) return null;
  if (refund.isCancel || refund.refundedPrice !== refund.refundPrice) throw invalid();
  if (Object.hasOwn(db, '$client')) throw Error('Refund history requires a caller-owned read snapshot');
  const fingerprint = await refundOrderSplitFingerprint(refund);
  const ids = sql.join(claim.items.map(item => sql`to_jsonb(${item.rowId}::integer)`), sql`, `);
  // Parse the bounded archive in PostgreSQL, not in the Worker. Only whitelisted
  // public scalars cross the wire; no address, provider, financial snapshot or
  // unrelated cart payload is selected. At most 100 selected items / 512 KiB,
  // plus <=200 compact source identities / 64 KiB for partition validation.
  const [row] = await db.execute(sql`WITH receipt AS MATERIALIZED (
    SELECT refund_id,source_order_id,payment_order_id,selected_order_id,remaining_order_id,disposition,
      source_snapshot::jsonb AS archive,partitions::jsonb AS partitions
    FROM ${storeOrderRefundSplit}
    WHERE refund_id=${refund.id} AND fingerprint=${fingerprint} AND uid=${refund.uid}
      AND supplier_id=${refund.supplierId} AND store_id=${refund.storeId} AND source_order_id=${refund.storeOrderId}
      AND octet_length(source_snapshot)<=16777216 AND octet_length(partitions)<=131072
  ), bounded AS MATERIALIZED (
    SELECT receipt.*,
      CASE WHEN jsonb_typeof(archive->'carts')='array' THEN jsonb_array_length(archive->'carts') ELSE 0 END AS cart_count,
      archive @> jsonb_build_object('version','refund-order-materialization-v1',
        'source',jsonb_build_object('id',${refund.storeOrderId}::integer,'uid',${refund.uid}::integer,
          'supplierId',${refund.supplierId}::integer,'storeId',${refund.storeId}::integer),
        'refund',jsonb_build_object('id',${refund.id}::integer,'storeOrderId',${refund.storeOrderId}::integer,
          'uid',${refund.uid}::integer,'supplierId',${refund.supplierId}::integer,'storeId',${refund.storeId}::integer,
          'orderId',${refund.orderId}::text,'refundPrice',${refund.refundPrice}::text,'refundedPrice',${refund.refundedPrice}::text,
          'refundNum',${refund.refundNum}::integer,'refundType',6,'isCancel',0,'cartInfo',${refund.cartInfo}::text),
        'payment',jsonb_build_object('id',payment_order_id)) AS identity_matches
    FROM receipt
  ) SELECT selected_order_id,source_order_id,remaining_order_id,disposition,partitions,cart_count,identity_matches,
    payment_order_id, payment_order_id=source_order_id AS first_split,
    archive->'source'->'pid'=to_jsonb(CASE WHEN payment_order_id=source_order_id THEN 0 ELSE payment_order_id END) AS lineage_matches,
    CASE WHEN octet_length(source_identities.payload::text)<=65536 THEN source_identities.payload ELSE NULL END AS source_carts,
    CASE WHEN octet_length(public_items.payload::text)<=524288 THEN public_items.payload ELSE NULL END AS items
  FROM bounded CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id',cart->'id','uid',cart->'uid','oid',cart->'oid',
      'cartId',cart->'cartId','cartNum',cart->'cartNum')) AS payload
    FROM jsonb_array_elements(CASE WHEN cart_count BETWEEN 1 AND 200 THEN archive->'carts' ELSE '[]'::jsonb END) AS lines(cart)
  ) source_identities CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id',cart->'id','uid',cart->'uid','oid',cart->'oid',
      'cartId',cart->'cartId','cartNum',cart->'cartNum',
      'valid',jsonb_typeof(info)='object' AND jsonb_typeof(product)='object' AND jsonb_typeof(sku)='object',
      'name',CASE WHEN jsonb_typeof(name)='string' THEN name ELSE NULL END,
      'sku',CASE WHEN jsonb_typeof(sku->'suk')='string' THEN sku->'suk' ELSE NULL END,
      'image',CASE WHEN jsonb_typeof(image)='string' THEN image ELSE NULL END) ORDER BY cart->>'id') AS payload
    FROM jsonb_array_elements(CASE WHEN cart_count BETWEEN 1 AND 200 THEN archive->'carts' ELSE '[]'::jsonb END) AS lines(cart)
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(cart->'cartInfo')='string' AND octet_length(cart->>'cartInfo')<=65536
      THEN CASE WHEN pg_input_is_valid(cart->>'cartInfo','jsonb') THEN (cart->>'cartInfo')::jsonb ELSE NULL END
      ELSE NULL END AS info) i
    CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(info->'product','null'::jsonb),NULLIF(info->'productInfo','null'::jsonb),'{}'::jsonb) AS product) p
    CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(info->'sku','null'::jsonb),NULLIF(product->'attrInfo','null'::jsonb),'{}'::jsonb) AS sku) k
    CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(product->'storeName','null'::jsonb),product->'store_name') AS name,
      COALESCE(NULLIF(sku->'image','null'::jsonb),product->'image') AS image) v
    WHERE cart->'id' IN (${ids})
  ) public_items`);
  if (!row || row.identity_matches !== true || row.lineage_matches !== true || !integer(row.selected_order_id)
    || !integer(row.cart_count) || row.cart_count > 200 || !Array.isArray(row.partitions)
    || row.partitions.length !== row.cart_count || !Array.isArray(row.source_carts) || row.source_carts.length !== row.cart_count
    || !Array.isArray(row.items) || row.items.length !== claim.items.length) throw invalid();
  if (row.disposition === 'whole') {
    if (row.selected_order_id !== refund.storeOrderId || row.remaining_order_id !== null) throw invalid();
  } else if (row.disposition !== 'split' || !integer(row.remaining_order_id)
    || row.selected_order_id === refund.storeOrderId || row.selected_order_id === row.remaining_order_id
    || row.selected_order_id === row.payment_order_id || row.remaining_order_id === row.payment_order_id
    || (row.first_split ? row.remaining_order_id === refund.storeOrderId : row.remaining_order_id !== refund.storeOrderId)) throw invalid();
  const sourceCarts = new Map<number, Record<string, unknown>>(), cartIds = new Set<string>();
  for (const raw of row.source_carts) {
    const cart = object(raw);
    if (!integer(cart.id) || sourceCarts.has(cart.id) || cart.uid !== refund.uid || cart.oid !== refund.storeOrderId
      || !integer(cart.cartNum) || typeof cart.cartId !== 'string' || !/^[1-9]\d{0,9}$/.test(cart.cartId)
      || !integer(Number(cart.cartId)) || cartIds.has(cart.cartId)) throw invalid();
    sourceCarts.set(cart.id, cart); cartIds.add(cart.cartId);
  }
  const selected = new Map<number, Record<string, unknown>>(), sources = new Set<number>(), targets = new Set<number>();
  let remainingQuantity = 0;
  for (const raw of row.partitions) {
    const part = object(raw);
    if (Object.keys(part).sort().join(',') !== 'remainingNum,remainingRowId,selectedNum,selectedRowId,sourceCartId,sourceRowId'
      || !integer(part.sourceRowId) || sources.has(part.sourceRowId) || typeof part.sourceCartId !== 'string'
      || !/^[1-9]\d{0,9}$/.test(part.sourceCartId) || !integer(part.selectedNum, true) || !integer(part.remainingNum, true)
      || part.selectedNum + part.remainingNum <= 0
      || (part.selectedNum > 0 ? !integer(part.selectedRowId) : part.selectedRowId !== null)
      || (part.remainingNum > 0 ? !integer(part.remainingRowId) : part.remainingRowId !== null)) throw invalid();
    sources.add(part.sourceRowId);
    const cart = sourceCarts.get(part.sourceRowId);
    if (!cart || part.sourceCartId !== cart.cartId || part.selectedNum + part.remainingNum !== cart.cartNum) throw invalid();
    if (row.disposition === 'whole') {
      if (part.selectedRowId !== part.sourceRowId || part.remainingNum !== 0) throw invalid();
    } else if ((part.selectedRowId !== null && sourceCarts.has(Number(part.selectedRowId)))
      || (part.remainingRowId !== null && (row.first_split
        ? sourceCarts.has(Number(part.remainingRowId)) : part.remainingRowId !== part.sourceRowId))) throw invalid();
    for (const target of [part.selectedRowId, part.remainingRowId]) {
      if (target === null) continue;
      if (!integer(target) || targets.has(target)) throw invalid();
      targets.add(target);
    }
    remainingQuantity += part.remainingNum;
    if (integer(part.selectedRowId)) selected.set(part.sourceRowId, part);
  }
  if (selected.size !== claim.items.length || (row.disposition === 'split' && remainingQuantity === 0)) throw invalid();
  const carts = row.items.map(object);
  if (new Set(carts.map(cart => cart.id)).size !== carts.length) throw invalid();
  const items = claim.items.map(item => {
    const part = selected.get(item.rowId), cart = carts.find(cart => cart.id === item.rowId);
    if (!part || !cart || part.sourceCartId !== String(item.cartId) || part.selectedNum !== item.cartNum
      || Number(part.selectedNum) + Number(part.remainingNum) !== item.totalNum
      || cart.cartId !== String(item.cartId) || cart.cartNum !== item.totalNum || cart.uid !== refund.uid
      || cart.oid !== refund.storeOrderId || cart.valid !== true) throw invalid();
    return { id: item.rowId, cartId: item.cartId, quantity: item.cartNum,
      name: text(cart.name, '订单商品'), sku: text(cart.sku, ''), image: text(cart.image, '') };
  });
  return { physicalOrderId: row.selected_order_id, items };
}

/** Additive staff read contract. Null means no materialized history contract,
 * not an empty historical refund. Never swallow storage/permission failures. */
export async function readStaffRefundHistory(db: DbClient, refund: Refund): Promise<RefundHistoryView | null> {
  if (refund.refundType !== 6) return null;
  const identity = { version: 1 as const, refundId: refund.id, sourceOrderId: refund.storeOrderId };
  try {
    const snapshot = await readMaterializedRefundSnapshot(db, refund);
    return snapshot ? { ...identity, ...snapshot, itemsError: '' } : null;
  } catch (error) {
    if (!(error instanceof ValidateException)) throw error;
    return { ...identity, physicalOrderId: null, items: [], itemsError: '退款历史商品证据不一致，请核对后重试' };
  }
}
