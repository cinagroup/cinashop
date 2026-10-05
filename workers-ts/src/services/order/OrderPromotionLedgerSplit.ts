import { asc, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrderPromotions } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { readPromotionLineEvidence } from './RefundSplitAllocation';

type Cart = { productId: number; cartNum: number; cartInfo: string | null };
type Order = { id: number; uid: number; promotionsPrice: string };
interface LedgerAmount { productId: number; promotionId: number; cents: number }
const invalid = () => new ValidateException('促销订单账本与商品快照不一致，请核对订单');
function cents(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value)) throw invalid();
  const [whole, fraction] = value.split('.');
  const number = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(number)) throw invalid();
  return number;
}
function amounts(rows: readonly Cart[]): { versioned: boolean; list: LedgerAmount[] } {
  const byKey = new Map<string, LedgerAmount>();
  let versioned = false;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.productId) || row.productId <= 0 || !Number.isSafeInteger(row.cartNum)
      || row.cartNum <= 0) throw invalid();
    if (!row.cartInfo?.includes('promotion_')) continue;
    if (row.cartInfo.length > 65536) throw invalid();
    let snapshot: unknown;
    try { snapshot = JSON.parse(row.cartInfo); } catch { throw invalid(); }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw invalid();
    const evidence = readPromotionLineEvidence(snapshot as Record<string, unknown>, row.cartNum);
    if (!evidence) continue;
    versioned = true;
    for (const item of evidence.allocations) {
      if (!item.savingsCents) continue;
      const key = `${row.productId}:${item.promotionId}`;
      const previous = byKey.get(key);
      byKey.set(key, { productId: row.productId, promotionId: item.promotionId,
        cents: (previous?.cents ?? 0) + item.savingsCents });
    }
  }
  return { versioned, list: [...byKey.values()].sort((a, b) =>
    a.productId - b.productId || a.promotionId - b.promotionId) };
}

/** Caller already holds the source order and carts. Locks its ledger before
 * splitting so no child can acquire a different promotion amount. */
export async function assertOrderPromotionLedger(tx: DbClient, order: Order, carts: readonly Cart[]): Promise<boolean> {
  const expected = amounts(carts);
  if (!expected.versioned) {
    if (cents(order.promotionsPrice) !== 0) throw invalid();
    return false;
  }
  if (expected.list.reduce((sum, row) => sum + row.cents, 0) !== cents(order.promotionsPrice)) throw invalid();
  const booked = await tx.select().from(storeOrderPromotions).where(eq(storeOrderPromotions.oid, order.id))
    .orderBy(asc(storeOrderPromotions.id)).for('update');
  const actual = new Map<string, number>();
  for (const row of booked) {
    if (row.uid !== order.uid) throw invalid();
    const key = `${row.productId}:${row.promotionsId}`;
    actual.set(key, (actual.get(key) ?? 0) + cents(row.promotionsPrice));
  }
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected.list.map((row) =>
    [`${row.productId}:${row.promotionId}`, row.cents]).sort())) throw invalid();
  return true;
}

/** Clone or replace the exact ledger for a physical child/remaining order. */
export async function writeOrderPromotionLedger(tx: DbClient, order: Order, carts: readonly Cart[],
  now: number, replace = false): Promise<void> {
  const expected = amounts(carts);
  if (!expected.versioned && !replace) return;
  if (!Number.isSafeInteger(now) || now <= 0 || expected.list.reduce((sum, row) => sum + row.cents, 0)
    !== cents(order.promotionsPrice)) throw invalid();
  if (replace) await tx.delete(storeOrderPromotions).where(eq(storeOrderPromotions.oid, order.id));
  if (expected.list.length) await tx.insert(storeOrderPromotions).values(expected.list.map((row) => ({
    oid: order.id, uid: order.uid, productId: row.productId,
    promotionsId: row.promotionId, promotionsPrice: (row.cents / 100).toFixed(2), addTime: now,
  })));
}
