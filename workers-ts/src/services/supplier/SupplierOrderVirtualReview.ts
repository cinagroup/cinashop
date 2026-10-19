import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeProductVirtual } from '@/models/schema';
import { supplierSnapshotObject } from './SupplierReadSupport';
import { LEGACY_PHP_REFUND_LINE_VERSION } from '@/services/order/LegacyPhpRefundLineFinance';
import { LEGACY_EDITED_GAIN_FINANCIAL_VERSION, LEGACY_EDITED_GAIN_SOURCE } from '@/services/order/UnpaidOrderGainIntegralProof';

const maximumBytes = 1_048_576, maximumEntries = 2000;
type Order = Pick<typeof storeOrder.$inferSelect,
  'id' | 'pid' | 'uid' | 'supplierId' | 'storeId' | 'orderId' | 'productType' | 'paid' | 'status' | 'deliveryType'>;
type Cart = typeof storeOrderCartInfo.$inferSelect;
type Labels = { product_id: number; sku_unique: string; product_name: string; sku: string };
export type SupplierVirtualEntry = (Labels & { kind: 'card'; quantity: 1; card_no: string; card_pwd: string })
  | (Labels & { kind: 'content'; quantity: number; content: string });
export type SupplierVirtualReview = { order_id: number; state: 'not_applicable' | 'not_delivered' | 'recorded' | 'unavailable';
  basis: 'modern' | 'php_legacy' | null; reason: string; entries: SupplierVirtualEntry[] };
class InvalidRecord extends Error {}
function invalid(): never { throw new InvalidRecord(); }
const object = supplierSnapshotObject;
function text(value: unknown, length: number): string {
  if (typeof value !== 'string' || value.length > length) return invalid();
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) return invalid();
  return value;
}
function skuIdentity(value: unknown) {
  const result = text(value, 40);
  if (!result || [...result].length > 20) return invalid();
  return result;
}
function secret(value: unknown, card = false) {
  const result = text(value, maximumBytes);
  if (card && [...result].length > 255) return invalid();
  return result;
}
function exact(row: Record<string, unknown>, keys: string[]) {
  if (Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key))) invalid();
}
const key = (product: number, sku: string) => JSON.stringify([product, sku]);
function legacySource(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  if (!Object.hasOwn(record, 'legacy_php_financial_source')) return !Object.hasOwn(record, 'financial_version');
  const marker = record.legacy_php_financial_source, version = record.financial_version;
  if (typeof marker !== 'string' || typeof version !== 'string'
    || (marker === 'original-php-purchase-facts-v1'
      ? ![LEGACY_PHP_REFUND_LINE_VERSION, 'refund-order-line-finance-v1'].includes(version)
      : marker !== LEGACY_EDITED_GAIN_SOURCE || ![LEGACY_EDITED_GAIN_FINANCIAL_VERSION, 'refund-order-line-finance-v1'].includes(version))) invalid();
  return true;
}
type Group = { labels: Labels; original: number; remaining: number; disk: string | null; legacy: boolean };
function groupsFor(carts: Cart[]) {
  if (!carts.length || carts.length > 200) return invalid();
  const groups = new Map<string, Group>();
  for (const cart of carts) {
    if (cart.productType !== 1 || !Number.isSafeInteger(cart.refundNum) || cart.refundNum < 0 || cart.refundNum > cart.cartNum) invalid();
    const count = positive(cart.cartNum), productId = positive(cart.productId), skuUnique = skuIdentity(cart.skuUnique);
    const record = cart.cartInfo ? object(JSON.parse(cart.cartInfo)) : null;
    const product = object(record?.product), previous = object(record?.productInfo), attr = object(previous?.attrInfo), sku = object(record?.sku);
    const labels = { product_id: productId, sku_unique: skuUnique,
      product_name: text(product?.storeName ?? product?.store_name ?? previous?.store_name ?? previous?.storeName ?? '商品快照', 1024),
      sku: text(sku?.suk ?? attr?.suk ?? skuUnique, 1024) };
    // PHP's actual author treated a missing legacy disk_info as card mode. A
    // malformed modern snapshot cannot acquire that compatibility fallback.
    const legacy = !!previous && !!attr && legacySource(record);
    let disk: string | null = null;
    if (legacy) {
      // PHP uses ?? '' and if ($disk_info): NULL, missing and the string '0'
      // select inventory-card mode. Modern JS treats the string '0' as content.
      const value = attr?.disk_info;
      disk = value === undefined || value === null || value === '0' ? '' : secret(value);
    }
    else if (sku && Object.hasOwn(sku, 'disk_info')) disk = secret(sku.disk_info).trim();
    const identity = key(productId, skuUnique), previousGroup = groups.get(identity);
    if (previousGroup) {
      if (JSON.stringify(previousGroup.labels) !== JSON.stringify(labels) || previousGroup.disk !== disk || previousGroup.legacy !== legacy) invalid();
      previousGroup.original += count; previousGroup.remaining += count - cart.refundNum;
      positive(previousGroup.original);
    } else groups.set(identity, { labels, original: count, remaining: count - cart.refundNum, disk, legacy });
  }
  return groups;
}

/** Detail-only sensitive projection inside the already authorized short RR/RO
 * transaction. It never claims stock, resolves a live SKU or borrows a parent. */
export async function readSupplierOrderVirtualReview(db: DbClient, order: Order, carts: Cart[]): Promise<SupplierVirtualReview> {
  const result = (state: SupplierVirtualReview['state'], reason: string): SupplierVirtualReview =>
    ({ order_id: order.id, state, basis: null, reason, entries: [] });
  if (order.productType !== 1) return result('not_applicable', '');
  if (order.pid < 0) return result('unavailable', '付款汇总不汇集子订单的交付内容，请查看具体订单');
  if (order.paid !== 1 || order.deliveryType !== 'fictitious' || order.status === 0) return result('not_delivered', '尚无可核对的已交付记录');
  if (![1, 2, 3].includes(order.status)) return result('unavailable', '当前历史状态无法核对卡密交付记录');
  if (order.pid > 0) {
    const [parent] = await db.select({ id: storeOrder.id }).from(storeOrder).where(and(
      eq(storeOrder.id, order.pid), eq(storeOrder.pid, -1), eq(storeOrder.uid, order.uid), eq(storeOrder.isSystemDel, 0),
      or(and(eq(storeOrder.supplierId, order.supplierId), eq(storeOrder.storeId, order.storeId)),
        and(eq(storeOrder.supplierId, 0), eq(storeOrder.storeId, 0), eq(storeOrder.supplierAllocationStatus, 2))),
    )).limit(1);
    if (!parent) return result('unavailable', '订单父子归属不一致，无法核对交付记录');
  }
  const [record] = await db.select({
    raw: sql<string | null>`CASE WHEN octet_length(${storeOrder.virtualInfo})<=${maximumBytes} THEN ${storeOrder.virtualInfo} ELSE NULL END`,
    oversized: sql<boolean>`COALESCE(octet_length(${storeOrder.virtualInfo}),0)>${maximumBytes}`,
  }).from(storeOrder).where(and(eq(storeOrder.id, order.id), eq(storeOrder.uid, order.uid),
    eq(storeOrder.supplierId, order.supplierId), eq(storeOrder.storeId, order.storeId), eq(storeOrder.isSystemDel, 0))).limit(1);
  if (!record || record.oversized || !record.raw) return result('unavailable', '交付记录缺失或超过读取范围');
  let parsed: unknown;
  try { parsed = JSON.parse(record.raw); } catch { return result('unavailable', '历史交付记录格式无法核对'); }
  let groups: Map<string, Group>;
  try { groups = groupsFor(carts); } catch (error) {
    if (!(error instanceof InvalidRecord) && !(error instanceof SyntaxError)) throw error;
    return result('unavailable', '交付商品与冻结快照无法核对');
  }
  // Even legacy card pairs are reconciled with exact claimed records. Guard
  // bytes in SQL before transferring any secret, including a wrong-UID row.
  const bytes = sql`octet_length(${storeProductVirtual.cardNo})+octet_length(${storeProductVirtual.cardPwd})`;
  const over = sql`SUM(${bytes}) OVER ()>${maximumBytes}`;
  const permitted = sql`${storeProductVirtual.uid}=${order.uid} AND ${storeProductVirtual.orderType}=1 AND NOT (${over})`;
  const claimed = await db.select({ id: storeProductVirtual.id, productId: storeProductVirtual.productId,
    skuUnique: storeProductVirtual.attrUnique, uid: storeProductVirtual.uid, orderType: storeProductVirtual.orderType,
    cardNo: sql<string | null>`CASE WHEN ${permitted} THEN ${storeProductVirtual.cardNo} ELSE NULL END`,
    cardPwd: sql<string | null>`CASE WHEN ${permitted} THEN ${storeProductVirtual.cardPwd} ELSE NULL END`,
    oversized: sql<boolean>`${over}`,
  }).from(storeProductVirtual).where(eq(storeProductVirtual.orderId, order.orderId))
    .orderBy(asc(storeProductVirtual.id)).limit(maximumEntries + 1);
  const ordersWithNumber = await db.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.orderId, order.orderId)).limit(2);
  try {
    if (ordersWithNumber.length !== 1 || ordersWithNumber[0].id !== order.id || claimed.length > maximumEntries
      || claimed.some(row => row.uid !== order.uid || row.orderType !== 1 || row.oversized)
      || new Set(claimed.map(row => row.id)).size !== claimed.length) invalid();
    const entries: SupplierVirtualEntry[] = [], delivered = new Map<string, number>(), used = new Set<number>();
    let bytesUsed = 0;
    const add = (entry: SupplierVirtualEntry) => {
      bytesUsed += new TextEncoder().encode(entry.kind === 'card' ? entry.card_no + entry.card_pwd : entry.content).length;
      if (bytesUsed > maximumBytes || entries.length >= maximumEntries) invalid();
      entries.push(entry); const identity = key(entry.product_id, entry.sku_unique);
      delivered.set(identity, (delivered.get(identity) ?? 0) + entry.quantity);
    };
    let basis: 'modern' | 'php_legacy';
    if (typeof parsed === 'string') {
      basis = 'php_legacy';
      if (groups.size !== 1 || claimed.length) invalid();
      const group = [...groups.values()][0];
      if (!group.legacy || !group.disk || parsed !== '密钥自动发放：' + group.disk) invalid();
      add({ kind: 'content', ...group.labels, quantity: group.original, content: secret(parsed) });
    } else {
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > maximumEntries) invalid();
      const values = parsed as unknown[];
      const legacy = values.every(value => { const row = object(value); return row && Object.keys(row).length === 2
        && Object.hasOwn(row, 'card_no') && Object.hasOwn(row, 'card_pwd'); });
      basis = legacy ? 'php_legacy' : 'modern';
      for (const value of values) {
        const row = object(value); if (!row) invalid();
        if (Object.hasOwn(row, 'disk_info')) {
          exact(row, ['disk_info', 'product_id', 'sku_unique', 'quantity']);
          const identity = key(positive(row.product_id), skuIdentity(row.sku_unique)), group = groups.get(identity);
          const content = secret(row.disk_info), count = positive(row.quantity);
          if (!group || !content || group.disk === null || group.disk.trim() !== content) invalid();
          add({ kind: 'content', ...group.labels, quantity: count, content });
        } else {
          exact(row, legacy ? ['card_no', 'card_pwd'] : ['card_no', 'card_pwd', 'product_id', 'sku_unique']);
          const cardNo = secret(row.card_no, true), cardPwd = secret(row.card_pwd, true);
          if (!cardPwd.trim()) invalid();
          const product = legacy ? undefined : positive(row.product_id), sku = legacy ? undefined : skuIdentity(row.sku_unique);
          const card = claimed.find(card => !used.has(card.id) && card.cardNo === cardNo && card.cardPwd === cardPwd
            && (legacy || (card.productId === product && card.skuUnique === sku)));
          if (!card) invalid();
          const group = groups.get(key(card.productId, card.skuUnique));
          // Legacy activity/base aliases absent from immutable carts cannot be
          // guessed through today's activity or SKU tables.
          if (!group || group.disk !== '' || (legacy && !group.legacy)) invalid();
          used.add(card.id); add({ kind: 'card', ...group.labels, quantity: 1, card_no: cardNo, card_pwd: cardPwd });
        }
      }
    }
    if (used.size !== claimed.length) invalid();
    for (const [identity, group] of groups) {
      const count = delivered.get(identity) ?? 0;
      // A later refund cannot erase delivery-time history. No reissue occurs.
      if (count < group.remaining || count > group.original) invalid();
    }
    if (!entries.length) invalid();
    return { order_id: order.id, state: 'recorded', basis, reason: '', entries };
  } catch (error) {
    if (!(error instanceof InvalidRecord)) throw error;
    return result('unavailable', '交付内容、认领卡密或商品数量无法核对，请检查历史记录');
  }
}
