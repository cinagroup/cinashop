import { and, eq, or, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, user } from '@/models/schema';
import { readOrderSystemFormForOrder } from '@/services/order/OrderSystemFormService';
import { signAttachmentReferences } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';
import { supplierSnapshotObject } from './SupplierReadSupport';

// Detail-only: never merge these private fields into the shared list header.
export const supplierOrderReviewColumns = {
  id: storeOrder.id, pid: storeOrder.pid, uid: storeOrder.uid, supplierId: storeOrder.supplierId,
  storeId: storeOrder.storeId, realName: storeOrder.realName, userPhone: storeOrder.userPhone,
  userAddress: storeOrder.userAddress, mark: storeOrder.mark, totalNum: storeOrder.totalNum,
  totalPrice: storeOrder.totalPrice, totalPostage: storeOrder.totalPostage, payPostage: storeOrder.payPostage,
  couponPrice: storeOrder.couponPrice, deductionPrice: storeOrder.deductionPrice, useIntegral: storeOrder.useIntegral,
  promotionsPrice: storeOrder.promotionsPrice, firstOrderPrice: storeOrder.firstOrderPrice,
  changePrice: storeOrder.changePrice, payPrice: storeOrder.payPrice, refundPrice: storeOrder.refundPrice,
  shippingType: storeOrder.shippingType, staffId: storeOrder.staffId, isChannel: storeOrder.isChannel,
  unique: storeOrder.unique,
  customForm: sql<string | null>`CASE WHEN octet_length(${storeOrder.customForm})<=1000000 THEN ${storeOrder.customForm} ELSE NULL END`,
};
type ReviewOrder = Pick<typeof storeOrder.$inferSelect, keyof typeof supplierOrderReviewColumns>;
type Cart = typeof storeOrderCartInfo.$inferSelect;
const bad = () => new ValidateException('订单核对记录无法读取，请核对历史数据');
function text(value: unknown, maximum: number, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw bad();
  return value;
}
function quantity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw bad();
  return value;
}
function minor(value: unknown, signed = false): bigint {
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,10}(?:\.\d{1,2})?$/ : /^\d{1,10}(?:\.\d{1,2})?$/).test(value)) throw bad();
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > 999999999999n) throw bad();
  return negative ? -cents : cents;
}
function decimal(value: bigint): string {
  if (value > 999999999999n || value < -999999999999n) throw bad();
  const positive = value < 0 ? -value : value;
  return `${value < 0 ? '-' : ''}${positive / 100n}.${String(positive % 100n).padStart(2, '0')}`;
}
function zeroEvidence(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  const legacy = supplierSnapshotObject(record.productInfo ?? record.product_info);
  const attr = supplierSnapshotObject(legacy?.attrInfo ?? legacy?.attr_info);
  // Actual checkout stores the settlement on the protected row, not in sku
  // JSON. A refund generation may relabel a legacy projection, so its legacy
  // marker must not turn an unpopulated historical zero into known evidence.
  if (['checkout-line-finance-v1', 'refund-order-line-finance-v1'].includes(String(record.financial_version))
    && !Object.hasOwn(record, 'legacy_php_financial_source')) return true;
  const values = [attr?.settle_price, attr?.settlePrice];
  return values.some(value => (typeof value === 'string' || typeof value === 'number') && /^0(?:\.0{1,2})?$/.test(String(value)));
}
function projectItem(row: Cart) {
  const record = row.cartInfo ? supplierSnapshotObject(JSON.parse(row.cartInfo)) : null;
  const product = supplierSnapshotObject(record?.product), legacy = supplierSnapshotObject(record?.productInfo ?? record?.product_info);
  const sku = supplierSnapshotObject(record?.sku), attr = supplierSnapshotObject(legacy?.attrInfo ?? legacy?.attr_info);
  const count = quantity(row.cartNum), refunded = quantity(row.refundNum);
  if (refunded > count) throw bad();
  const unit = minor(row.settlePrice), known = unit !== 0n || zeroEvidence(record);
  return { id: row.id, product_id: row.productId,
    product_name: text(product?.storeName ?? product?.store_name ?? legacy?.store_name ?? legacy?.storeName, 1024, '商品快照'),
    sku: text(sku?.suk ?? attr?.suk, 1024, row.skuUnique),
    code: text(sku?.code ?? attr?.code ?? legacy?.code, 1024),
    bar_code: text(sku?.barCode ?? sku?.bar_code ?? attr?.bar_code ?? attr?.barCode, 1024),
    quantity: count, refund_quantity: refunded,
    settlement_unit: known ? decimal(unit) : null,
    settlement_subtotal: known ? decimal(unit * BigInt(count)) : null };
}
function image(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  if (/^\/api\/assets\/[1-9]\d*\?expires=\d+&signature=[A-Za-z0-9_-]+$/.test(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
function projectForm(components: Record<string, unknown>[]) {
  const ids = new Set<string>();
  return components.map((component, index) => {
    const title = supplierSnapshotObject(component.titleConfig)?.value;
    const rawId = component.id;
    let id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId)
      : typeof rawId === 'string' && rawId.length > 0 && rawId.length <= 255 ? rawId : String(index + 1);
    if (ids.has(id)) id = `field-${index + 1}`;
    while (ids.has(id)) id = '_' + id;
    ids.add(id);
    const values = Array.isArray(component.value) ? component.value : [component.value];
    if (values.length > 200) throw bad();
    const images = component.name === 'uploadPicture' ? values.filter(image).slice(0, 9) : [];
    const value = component.name === 'uploadPicture' ? '' : values.map(value => {
      if (value === undefined || value === null) return '';
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw bad();
      return text(String(value), 16384);
    }).join(' / ');
    return { id: text(id, 255), title: text(title, 1024, '留言'), value: text(value, 20000), images };
  });
}

/** Caller has authorized this Supplier order and validated the complete raw cart
 * collection in its short RR/READ ONLY transaction. Amounts are records, never
 * evidence of a paid-out balance or a current catalog price. */
export async function readSupplierOrderReview(db: DbClient, order: ReviewOrder, carts: Cart[], appKey?: string) {
  let original: string | null = null;
  if (order.pid > 0) {
    const [parent] = await db.select({ number: storeOrder.orderId }).from(storeOrder).where(and(
      eq(storeOrder.id, order.pid), eq(storeOrder.pid, -1), eq(storeOrder.uid, order.uid), eq(storeOrder.isSystemDel, 0),
      or(and(eq(storeOrder.supplierId, order.supplierId), eq(storeOrder.storeId, order.storeId)),
        and(eq(storeOrder.supplierId, 0), eq(storeOrder.storeId, 0), eq(storeOrder.supplierAllocationStatus, 2))),
    )).limit(1);
    original = parent ? text(parent.number, 64) : null;
  }
  const [buyer] = order.uid > 0 ? await db.select({ uid: user.uid, nickname: user.nickname, phone: user.phone })
    .from(user).where(and(eq(user.uid, order.uid), eq(user.isDel, 0))).limit(1) : [];
  const items = carts.map(projectItem), available = items.length > 0 && items.every(item => item.settlement_subtotal !== null);
  const goods = available ? items.reduce((sum, item) => sum + minor(item.settlement_subtotal!), 0n) : null;
  const postage = [2, 4].includes(order.shippingType) ? 0n : minor(order.payPostage);
  const components = await readOrderSystemFormForOrder(db,
    { signReferences: references => signAttachmentReferences(appKey, references) }, order);
  // Malformed optional historical form values follow the existing form reader's
  // empty fallback. SQL/signing errors above still propagate, never fake empty.
  let form: ReturnType<typeof projectForm>;
  try { form = projectForm(components); } catch (error) {
    if (!(error instanceof ValidateException)) throw error;
    form = [];
  }
  return { version: 1 as const, order_kind: order.pid === -1 ? 'payment_summary' as const : 'order' as const,
    original_order_id: original,
    recipient: { name: text(order.realName, 64), phone: text(order.userPhone, 36), address: text(order.userAddress, 200), mark: text(order.mark, 1024) },
    buyer: { uid: quantity(order.uid), nickname: text(buyer?.nickname, 120), phone: text(buyer?.phone, 30), available: !!buyer },
    amounts: { quantity: quantity(order.totalNum), total_price: decimal(minor(order.totalPrice)), total_postage: decimal(minor(order.totalPostage)),
      pay_postage: decimal(minor(order.payPostage)), coupon_price: decimal(minor(order.couponPrice)), deduction_price: decimal(minor(order.deductionPrice)),
      use_integral: decimal(minor(order.useIntegral)), promotions_price: decimal(minor(order.promotionsPrice)), first_order_price: decimal(minor(order.firstOrderPrice)),
      change_price: decimal(minor(order.changePrice, true)), pay_price: decimal(minor(order.payPrice)), refund_price: decimal(minor(order.refundPrice)) },
    items, settlement: { items_total: goods === null ? null : decimal(goods), postage: decimal(postage),
      total: goods === null ? null : decimal(goods + postage), availability: available ? 'recorded' as const : 'incomplete' as const }, form };
}
