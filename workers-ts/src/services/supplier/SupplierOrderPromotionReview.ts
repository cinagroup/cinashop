import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderPromotions, storePromotions } from '@/models/schema';
import { readPromotionLineEvidence } from '@/services/order/RefundSplitAllocation';
import { ValidateException } from '@/utils/errors';
import { LEGACY_PHP_REFUND_LINE_VERSION } from '@/services/order/LegacyPhpRefundLineFinance';
import { LEGACY_EDITED_GAIN_FINANCIAL_VERSION, LEGACY_EDITED_GAIN_SOURCE } from '@/services/order/UnpaidOrderGainIntegralProof';

type Order = Pick<typeof storeOrder.$inferSelect, 'id' | 'pid' | 'uid' | 'supplierId' | 'storeId' | 'promotionsPrice'>;
type Cart = Pick<typeof storeOrderCartInfo.$inferSelect, 'productId' | 'cartNum' | 'cartInfo'>;
export type SupplierOrderPromotionItem = {
  promotion_id: number; promotion_type: 1 | 2 | 3 | 4 | null;
  frozen_name: string | null; current_title: string | null; amount: string;
};
export type SupplierOrderPromotionReview = {
  order_id: number; state: 'recorded' | 'none' | 'unavailable'; reason: string;
  basis: 'modern' | 'legacy' | null; total: string | null; items: SupplierOrderPromotionItem[];
};
const maximumRows = 600;
const bad = () => new ValidateException('促销分摊记录无法核对');
function cents(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,10}\.\d{2}$/.test(value)) throw bad();
  const [whole, fraction] = value.split('.'); return BigInt(whole) * 100n + BigInt(fraction);
}
function money(value: bigint): string {
  if (value < 0n || value > 999999999999n) throw bad();
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
const id = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function text(value: unknown, codepoints: number, utf16 = codepoints * 2): value is string {
  return typeof value === 'string' && value.length <= utf16 && [...value].length <= codepoints
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value);
}

/** Exact physical-order historical discount allocation, in the caller's short
 * RR/READ ONLY snapshot. Current catalog title is explicitly separate from
 * frozen allocation name and never supplies or recomputes historical amounts. */
export async function readSupplierOrderPromotionReview(db: DbClient, order: Order, carts: Cart[]): Promise<SupplierOrderPromotionReview> {
  const empty = (state: 'none' | 'unavailable', reason = ''): SupplierOrderPromotionReview => ({
    order_id: order.id, state, reason, basis: null, total: null, items: [],
  });
  if (order.pid < -1) return empty('unavailable', '订单关联无法核对');
  if (order.pid > 0) {
    const roots = await db.select({ id: storeOrder.id }).from(storeOrder).where(and(
      eq(storeOrder.id, order.pid), eq(storeOrder.pid, -1), eq(storeOrder.uid, order.uid), eq(storeOrder.isSystemDel, 0),
      or(and(eq(storeOrder.supplierId, order.supplierId), eq(storeOrder.storeId, order.storeId)),
        and(eq(storeOrder.supplierId, 0), eq(storeOrder.storeId, 0), eq(storeOrder.supplierAllocationStatus, 2))),
    )).limit(1);
    if (!roots.length) return empty('unavailable', '履约子单与付款汇总的关联无法核对');
  }
  // Bound the complete ledger before materialization. Unlike the writer helper,
  // this reader never skips SQL just because an unversioned header says zero.
  const bytes = sql`octet_length(${storeOrderPromotions.promotionsPrice}::text)+24`;
  const oversized = sql`${bytes}>64 OR SUM(${bytes}) OVER ()>131072`;
  const rows = await db.select({ id: storeOrderPromotions.id, uid: storeOrderPromotions.uid,
    productId: storeOrderPromotions.productId, promotionId: storeOrderPromotions.promotionsId,
    amount: sql<string | null>`CASE WHEN NOT (${oversized}) THEN ${storeOrderPromotions.promotionsPrice}::text ELSE NULL END`,
    oversized: sql<boolean>`${oversized}`,
  }).from(storeOrderPromotions).innerJoin(storeOrder, eq(storeOrder.id, storeOrderPromotions.oid)).where(and(
    eq(storeOrder.id, order.id), eq(storeOrder.uid, order.uid), eq(storeOrder.supplierId, order.supplierId), eq(storeOrder.isSystemDel, 0),
  )).orderBy(asc(storeOrderPromotions.id)).limit(maximumRows + 1);
  if (rows.length > maximumRows || rows.some(row => row.oversized)) return empty('unavailable', '促销分摊记录过多或过大，请先核对');
  let basis: 'modern' | 'legacy' = 'legacy';
  const booked = new Map<string, bigint>(), expected = new Map<string, bigint>();
  const grouped = new Map<number, bigint>(), frozen = new Map<number, { name: string; type: 1 | 2 | 3 }>();
  try {
    const products = new Set(carts.map(cart => cart.productId)), modernProducts = new Set<number>(), header = cents(order.promotionsPrice);
    for (const row of rows) {
      if (!id(row.id) || row.uid !== order.uid || !id(row.productId) || !products.has(row.productId) || !id(row.promotionId)) throw bad();
      const amount = cents(row.amount), key = `${row.productId}:${row.promotionId}`;
      booked.set(key, (booked.get(key) ?? 0n) + amount); grouped.set(row.promotionId, (grouped.get(row.promotionId) ?? 0n) + amount);
    }
    for (const cart of carts) {
      if (!cart.cartInfo) continue;
      const snapshot = JSON.parse(cart.cartInfo) as Record<string, unknown>;
      const legacyMarker = Object.hasOwn(snapshot, 'legacy_php_financial_source');
      if (legacyMarker) {
        const marker = snapshot.legacy_php_financial_source, version = snapshot.financial_version;
        if (typeof marker !== 'string' || typeof version !== 'string'
          || (marker === 'original-php-purchase-facts-v1'
            ? ![LEGACY_PHP_REFUND_LINE_VERSION, 'refund-order-line-finance-v1'].includes(version)
            : marker !== LEGACY_EDITED_GAIN_SOURCE || ![LEGACY_EDITED_GAIN_FINANCIAL_VERSION, 'refund-order-line-finance-v1'].includes(version))) throw bad();
      }
      if (['checkout-line-finance-v1', 'refund-order-line-finance-v1'].includes(String(snapshot.financial_version))
        && !legacyMarker) modernProducts.add(cart.productId);
      const evidence = readPromotionLineEvidence(snapshot, cart.cartNum);
      if (!evidence) continue;
      if (!id(cart.productId)) throw bad();
      basis = 'modern';
      for (const part of evidence.allocations) {
        if (!id(part.promotionId) || !text(part.name, 255, 255)) throw bad();
        if (!part.savingsCents) continue;
        const previous = frozen.get(part.promotionId);
        if (previous && (previous.name !== part.name || previous.type !== part.type)) throw bad();
        frozen.set(part.promotionId, { name: part.name, type: part.type as 1 | 2 | 3 });
        const key = `${cart.productId}:${part.promotionId}`;
        expected.set(key, (expected.get(key) ?? 0n) + BigInt(part.savingsCents));
      }
    }
    const total = [...grouped.values()].reduce((sum, value) => sum + value, 0n);
    if (total !== header) throw bad();
    if (basis === 'modern' && (booked.size !== expected.size || [...booked].some(([key, value]) => expected.get(key) !== value))) throw bad();
    // A recognized modern writer never books a promotion without its exact
    // line proof. Do not launder removed proof into a legacy reference; actual
    // legacy-derived refund rows carry the existing explicit legacy marker.
    if (basis === 'legacy' && rows.some(row => modernProducts.has(row.productId))) throw bad();
    if (!rows.length) return empty('none');
    money(total);
    for (const value of grouped.values()) money(value);
  } catch (error) {
    if (!(error instanceof ValidateException) && !(error instanceof SyntaxError)) throw error;
    return empty('unavailable', '促销账本、订单商品与分摊快照无法一致核对');
  }
  // Only public/platform definitions admitted by the ordinary checkout author
  // may supply current metadata. Expiration/disabled status is not historical
  // ownership; soft deletion or a changed owner removes the title, not money.
  const ids = [...grouped.keys()], titleBytes = sql`COALESCE(octet_length(${storePromotions.title}),0)`;
  const titleOversized = sql`${titleBytes}>1024 OR SUM(${titleBytes}) OVER ()>1048576`;
  const catalog = await db.select({ id: storePromotions.id, type: storePromotions.promotionsType,
    title: sql<string | null>`CASE WHEN NOT (${titleOversized}) THEN ${storePromotions.title} ELSE NULL END`,
  }).from(storePromotions).where(and(inArray(storePromotions.id, ids), eq(storePromotions.pid, 0),
    eq(storePromotions.type, 1), eq(storePromotions.storeId, 0), eq(storePromotions.isDel, 0))).orderBy(asc(storePromotions.id)).limit(maximumRows);
  const titles = new Map(catalog.map(row => [row.id, row]));
  const items: SupplierOrderPromotionItem[] = ids.map(promotionId => {
    const saved = frozen.get(promotionId), current = titles.get(promotionId);
    const currentType = current && [1, 2, 3, 4].includes(current.type) ? current.type as 1 | 2 | 3 | 4 : null;
    return { promotion_id: promotionId, promotion_type: saved?.type ?? currentType,
      frozen_name: saved?.name ?? null, current_title: current && currentType !== null && text(current.title, 255) ? current.title : null,
      amount: money(grouped.get(promotionId)!) };
  }).sort((a, b) => (a.promotion_type ?? 5) - (b.promotion_type ?? 5) || a.promotion_id - b.promotion_id);
  return { order_id: order.id, state: 'recorded', reason: '', basis,
    total: money([...grouped.values()].reduce((sum, value) => sum + value, 0n)), items };
}
