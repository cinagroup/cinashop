import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderRefund } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { isMaterializedRefundClaim, readRefundQuantityReservation, refundClaimCartKey } from '@/services/order/RefundQuantityReservation';
import { readSupplierCarts, supplierSnapshotObject } from './SupplierReadSupport';

export interface SupplierRefundApplicationItem {
  row_id: number | null; cart_id: string; product_id: number; product_name: string; sku: string; code: string;
  is_gift: 0 | 1 | null; quantity: number; settlement_unit: string | null; settlement_subtotal: string | null;
}
export interface SupplierRefundApplicationContext {
  basis: 'linked_order_record'; order_id: string; paid: 0 | 1; pay_type: string; pay_price: string; pay_time: number;
  recipient: { name: string; phone: string; address: string }; mark: string;
}
export interface SupplierRefundApplicationReview {
  version: 1; refund_id: number; source_order_id: number; state: 'recorded' | 'archived' | 'unavailable';
  basis: 'quantity_claim' | 'php_legacy_snapshot' | null; items: SupplierRefundApplicationItem[]; error: string;
  order_context: SupplierRefundApplicationContext | null;
}
// Do not transfer the old complete order row (virtualInfo, financial/provider
// payloads, customer answers). Only these linked-record facts enter the reader.
export const supplierRefundApplicationOrderColumns = {
  id: storeOrder.id, uid: storeOrder.uid, supplierId: storeOrder.supplierId, storeId: storeOrder.storeId,
  orderId: storeOrder.orderId, pid: storeOrder.pid, paid: storeOrder.paid, payType: storeOrder.payType,
  payPrice: storeOrder.payPrice, payTime: storeOrder.payTime, realName: storeOrder.realName,
  userPhone: storeOrder.userPhone, userAddress: storeOrder.userAddress, mark: storeOrder.mark,
};
export type SupplierRefundApplicationOrder = Pick<typeof storeOrder.$inferSelect, keyof typeof supplierRefundApplicationOrderColumns>;
type Refund = Pick<typeof storeOrderRefund.$inferSelect, 'id' | 'storeOrderId' | 'uid' | 'supplierId' | 'storeId' | 'refundType' | 'isCancel' | 'refundNum' | 'cartInfo'>;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const invalid = () => new ValidateException('售后申请商品证据不一致，请核对原申请');
function integer(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647) throw invalid();
  return value;
}
function legacyInteger(value: unknown) {
  if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)) return integer(Number(value));
  return integer(value);
}
function text(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || bytes(value) > 4096) throw invalid();
  return value;
}
function cartKey(value: unknown): string {
  const key = typeof value === 'number' ? String(integer(value)) : value;
  if (typeof key !== 'string' || !key || key !== key.trim() || Array.from(key).length > 128
    || bytes(key) > 512 || /[\u0000-\u001f\u007f]/.test(key)) throw invalid();
  return key;
}
function cents(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(0|[1-9]\d{0,23})(?:\.(\d{1,2}))?$/.exec(String(value));
  return match ? BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')) : null;
}
function decimal(value: bigint): string {
  const integral = value / 100n;
  if (value < 0n || integral.toString().length > 24) throw invalid();
  return `${integral}.${String(value % 100n).padStart(2, '0')}`;
}
function price(value: unknown, quantity: number, knownZero: boolean) {
  const amount = cents(value), known = amount !== null && (amount !== 0n || knownZero);
  return { settlement_unit: known ? decimal(amount!) : null,
    settlement_subtotal: known ? decimal(amount! * BigInt(quantity)) : null };
}
function zeroEvidence(record: Record<string, unknown> | null) {
  if (!record) return false;
  if (typeof record.financial_version === 'string' && ['checkout-line-finance-v1', 'refund-order-line-finance-v1'].includes(record.financial_version)
    && !Object.hasOwn(record, 'legacy_php_financial_source')) return true;
  const product = supplierSnapshotObject(record.productInfo ?? record.product_info);
  const attr = supplierSnapshotObject(product?.attrInfo ?? product?.attr_info);
  return [attr?.settle_price, attr?.settlePrice].some(value => cents(value) === 0n);
}
function flag(value: unknown): 0 | 1 {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  throw invalid();
}
function labels(record: Record<string, unknown> | null, productId: number, skuUnique?: string) {
  const modern = supplierSnapshotObject(record?.product), legacy = supplierSnapshotObject(record?.productInfo);
  if (!record || !modern && !legacy) throw invalid();
  for (const product of [modern, legacy]) if (product && legacyInteger(product.id) !== productId) throw invalid();
  const sku = modern ? supplierSnapshotObject(record.sku) : supplierSnapshotObject(legacy?.attrInfo);
  if (modern && !sku) throw invalid();
  if (skuUnique !== undefined) {
    if (!skuUnique || skuUnique !== skuUnique.trim() || bytes(skuUnique) > 4096) throw invalid();
    if (sku && Object.hasOwn(sku, 'unique') && sku.unique !== skuUnique) throw invalid();
  }
  const name = text(modern?.storeName ?? modern?.store_name ?? legacy?.store_name ?? legacy?.storeName);
  if (!name.trim()) throw invalid();
  const spec = legacy?.spec_type === undefined ? 0 : flag(legacy.spec_type);
  return { product_name: name, sku: text(sku?.suk), code: text(modern ? sku?.code ?? modern.code : spec ? sku?.code : legacy?.code) };
}
function boundedItems(items: SupplierRefundApplicationItem[]) {
  if (bytes(JSON.stringify(items)) > 524288) throw invalid();
  return items;
}
function context(order: SupplierRefundApplicationOrder): SupplierRefundApplicationContext | null {
  try {
    if (order.paid !== 0 && order.paid !== 1) throw invalid();
    const paid = cents(order.payPrice); if (paid === null) throw invalid();
    return { basis: 'linked_order_record', order_id: text(order.orderId), paid: order.paid,
      pay_type: text(order.payType), pay_price: decimal(paid), pay_time: integer(order.payTime, true),
      recipient: { name: text(order.realName), phone: text(order.userPhone), address: text(order.userAddress) }, mark: text(order.mark) };
  } catch (error) { if (!(error instanceof ValidateException)) throw error; return null; }
}
/** SQL budgets precede transport: complete PHP arrays may be 1MiB, but a
 * recognized modern claim remains <=64KiB. Invalid JSON is never cast to jsonb. */
export const supplierRefundApplicationCartInfo = sql<string | null>`CASE
  WHEN octet_length(${storeOrderRefund.cartInfo}) <= 1048576 THEN
    CASE WHEN pg_input_is_valid(${storeOrderRefund.cartInfo},'jsonb') THEN
      CASE WHEN jsonb_typeof(${storeOrderRefund.cartInfo}::jsonb)='object'
        AND ${storeOrderRefund.cartInfo}::jsonb ? 'quantityReservation'
        THEN CASE WHEN octet_length(${storeOrderRefund.cartInfo}) <= 65536 THEN ${storeOrderRefund.cartInfo} ELSE NULL END
        ELSE ${storeOrderRefund.cartInfo} END
      ELSE ${storeOrderRefund.cartInfo} END
  ELSE NULL END`;

/** Exact already-authorized refund/order, inside the caller's RR READ ONLY
 * snapshot. Labels are order snapshots or the PHP application snapshot, never
 * today's remainder/catalog. The request itself freezes modern IDs/quantities. */
export async function readSupplierRefundApplicationReview(db: DbClient, refund: Refund,
  order: SupplierRefundApplicationOrder): Promise<SupplierRefundApplicationReview> {
  const common = { version: 1 as const, refund_id: refund.id, source_order_id: refund.storeOrderId, order_context: context(order) };
  const unavailable = (): SupplierRefundApplicationReview => ({ ...common, state: 'unavailable', basis: null, items: [], error: '申请商品记录暂不可核对，请联系用户确认' });
  try {
    integer(refund.id); integer(refund.storeOrderId); integer(refund.refundNum);
    if (order.id !== refund.storeOrderId || order.uid !== refund.uid || order.supplierId !== refund.supplierId || order.storeId !== refund.storeId
      || ![0, 1, 2, 3, 4, 5, 6].includes(refund.refundType) || ![0, 1].includes(refund.isCancel)) throw invalid();
    if (!refund.cartInfo || bytes(refund.cartInfo) > 1048576) throw invalid();
    let raw: unknown; try { raw = JSON.parse(refund.cartInfo); } catch { throw invalid(); }
    const object = supplierSnapshotObject(raw);
    if (object && Object.hasOwn(object, 'quantityReservation')) {
      const claim = readRefundQuantityReservation(refund); if (!claim) throw invalid();
      // Completed materialization is displayed solely by the protected existing
      // refundHistory archive, even if original rows now belong to a remainder.
      if (refund.refundType === 6 && !refund.isCancel && isMaterializedRefundClaim(claim))
        return { ...common, state: 'archived', basis: null, items: [], error: '' };
      if (refund.refundType === 6 || order.pid < 0) throw invalid();
      const rows = await readSupplierCarts(db, refund.supplierId, [{ id: order.id, uid: order.uid }]);
      const selected = new Map(rows.map(row => [row.id, row]));
      const active = !refund.isCancel && [0, 1, 2, 4, 5].includes(refund.refundType);
      const items = claim.items.map(item => {
        const row = selected.get(item.rowId);
        if (!row || row.oid !== order.id || row.uid !== refund.uid || row.cartId !== refundClaimCartKey(item)
          || row.cartNum !== item.totalNum || row.refundNum < 0 || row.refundNum > row.cartNum
          || active && row.refundNum !== item.beforeRefundNum + item.cartNum) throw invalid();
        return { row_id: row.id, cart_id: cartKey(row.cartId), product_id: integer(row.productId),
          ...labels(row.snapshot, row.productId, row.skuUnique),
          is_gift: row.isGift as 0 | 1, quantity: item.cartNum, ...price(row.settlePrice, item.cartNum, zeroEvidence(row.snapshot)) };
      });
      return { ...common, state: 'recorded', basis: 'quantity_claim', items: boundedItems(items), error: '' };
    }
    if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw invalid();
    const seen = new Set<string>(); let total = 0;
    const items = raw.map(value => {
      const snapshot = supplierSnapshotObject(value), product = supplierSnapshotObject(snapshot?.productInfo);
      if (!snapshot || !product) throw invalid();
      // Real PHP stores array_column(selected rows,'cart_info'), whose id is the
      // original opaque cart key and cart_num is the requested (split) quantity.
      const key = cartKey(snapshot.id), quantity = legacyInteger(snapshot.cart_num), productId = legacyInteger(snapshot.product_id ?? product.id);
      if (seen.has(key) || snapshot.uid !== undefined && snapshot.uid !== refund.uid
        || product.id !== undefined && legacyInteger(product.id) !== productId) throw invalid();
      seen.add(key); total += quantity; if (total > 2147483647) throw invalid();
      const attr = supplierSnapshotObject(product.attrInfo);
      const gift = snapshot.is_gift === undefined ? null : flag(snapshot.is_gift);
      return { row_id: null, cart_id: key, product_id: productId, ...labels(snapshot, productId), is_gift: gift, quantity,
        ...price(attr?.settle_price, quantity, cents(attr?.settle_price) === 0n) };
    });
    if (total !== refund.refundNum) throw invalid();
    return { ...common, state: 'recorded', basis: 'php_legacy_snapshot', items: boundedItems(items), error: '' };
  } catch (error) { if (!(error instanceof ValidateException)) throw error; return unavailable(); }
}
