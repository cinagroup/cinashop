import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { readPromotionLineEvidence } from '@/services/order/RefundSplitAllocation';
import { ValidateException } from '@/utils/errors';

const snapshotBatchSize = 32;
const maxSnapshotBytes = 256 * 1_024;
const moneyPattern = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const evidenceHint = /"promotion_(?:quote_version|line_price|line_savings|line_member_savings|discount_quantity|allocations|segments)"/;

function cents(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw new ValidateException('促销统计金额证据无效');
  const text = String(value);
  if (!moneyPattern.test(text)) throw new ValidateException('促销统计金额证据无效');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
function money(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
function snapshotAmount(raw: string | null, cartNum: number, linked: ReadonlySet<number>): bigint {
  if (!raw) return 0n;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch {
    if (evidenceHint.test(raw)) throw new ValidateException('促销统计商品快照无法验证');
    return 0n;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0n;
  const record = parsed as Record<string, unknown>;
  const quantity = cartNum === 0 ? Number(record.cart_num) : cartNum;
  const promotion = readPromotionLineEvidence(record, quantity);
  if (promotion) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0
      || record.cart_num !== quantity && record.cart_num !== String(quantity)) {
      throw new ValidateException('促销统计商品数量与快照不一致');
    }
    const attributed = promotion.allocations.filter(item => linked.has(item.promotionId));
    if (!attributed.length) throw new ValidateException('促销统计快照与活动归属不一致');
    return attributed.reduce((sum, item) => sum + BigInt(item.savingsCents), 0n);
  }
  // Preserve historical, unversioned PHP snapshots. Their promotional saving
  // was stored per item, and no allocation can distinguish overlapping offers.
  const unit = record.promotions_true_price;
  if ((typeof unit !== 'string' && typeof unit !== 'number') || !moneyPattern.test(String(unit))) return 0n;
  const rawQuantity = /^[1-9]\d{0,7}$/.test(String(record.cart_num ?? '')) ? Number(record.cart_num) : cartNum;
  if (!Number.isSafeInteger(rawQuantity) || rawQuantity < 0) throw new ValidateException('促销统计商品数量无效');
  return cents(unit) * BigInt(rawQuantity);
}

/** Historical sales of one platform root, including its one-level derived
 * promotion IDs. The caller owns a read-only repeatable-read transaction.
 * A paid original root may become pid=-1 after supplier splitting; fulfillment
 * children pid>0 never add another order or another copy of pay_price. */
export async function adminPromotionSales(tx: DbClient, rootId: number, promotionsType: 1 | 2 | 3) {
  const linkedRows = await tx.execute(sql<{ id: number }>`SELECT id FROM store_promotions
    WHERE promotions_type=${promotionsType} AND (id=${rootId} OR pid=${rootId})`);
  const linked = new Set(linkedRows.map(row => Number(row.id)));
  // Let PostgreSQL count distinct orders and buyers; no cart row or UID map
  // grows with the campaign's history in Worker memory. Ledger amounts take
  // precedence over every cart snapshot for the same original paid order.
  const [summary] = await tx.execute(sql<{ sum_pay_price: string; ledger_amount: string;
    sum_order: number; sum_user: number; old_user: number }>`
    WITH linked AS (SELECT id FROM store_promotions
      WHERE promotions_type=${promotionsType} AND (id=${rootId} OR pid=${rootId})),
    ledger AS (SELECT a.oid, SUM(a.promotions_price)::numeric AS amount
      FROM store_order_promotions a JOIN linked p ON p.id=a.promotions_id GROUP BY a.oid),
    qualified AS (SELECT o.id,o.uid,o.pay_price,COALESCE(l.amount,0)::numeric AS ledger_amount
      FROM store_order o LEFT JOIN ledger l ON l.oid=o.id
      WHERE o.paid=1 AND o.is_del=0 AND o.is_system_del=0
        AND o.pid IN (0,-1) AND o.refund_status IN (0,3)
        AND (l.oid IS NOT NULL OR EXISTS (SELECT 1 FROM store_order_cart_info c
          WHERE c.oid=o.id AND EXISTS (SELECT 1 FROM linked p WHERE COALESCE(c.promotions_id,'')
            ~ ('(^|[^0-9])' || p.id::text || '([^0-9]|$)'))))),
    buyers AS (SELECT uid,COUNT(*)::integer AS n FROM qualified GROUP BY uid)
    SELECT COALESCE((SELECT SUM(pay_price) FROM qualified),0)::text AS sum_pay_price,
      COALESCE((SELECT SUM(ledger_amount) FROM qualified),0)::text AS ledger_amount,
      (SELECT COUNT(*)::integer FROM qualified) AS sum_order,
      (SELECT COUNT(*)::integer FROM buyers) AS sum_user,
      (SELECT COUNT(*)::integer FROM buyers WHERE n>1) AS old_user`);
  let promotionCents = cents(summary?.ledger_amount ?? '0');

  let lastSnapshotOrder = 0, lastCartId = 0;
  for (;;) {
    const rows = await tx.execute(sql<{ id: number; oid: number;
      cart_num: number; cart_info: string | null; oversized: boolean }>`
      WITH linked AS (SELECT id FROM store_promotions
        WHERE promotions_type=${promotionsType} AND (id=${rootId} OR pid=${rootId}))
      SELECT c.id, o.id AS oid, c.cart_num,
        CASE WHEN octet_length(c.cart_info)<=${maxSnapshotBytes} THEN c.cart_info ELSE NULL END AS cart_info,
        (octet_length(c.cart_info)>${maxSnapshotBytes}) AS oversized
      FROM store_order_cart_info c JOIN store_order o ON o.id=c.oid
      WHERE (o.id>${lastSnapshotOrder} OR (o.id=${lastSnapshotOrder} AND c.id>${lastCartId}))
        AND o.paid=1 AND o.is_del=0 AND o.is_system_del=0
        AND o.pid IN (0,-1) AND o.refund_status IN (0,3)
        AND NOT EXISTS (SELECT 1 FROM store_order_promotions a JOIN linked p ON p.id=a.promotions_id
          WHERE a.oid=o.id)
        AND EXISTS (SELECT 1 FROM linked p WHERE COALESCE(c.promotions_id,'')
          ~ ('(^|[^0-9])' || p.id::text || '([^0-9]|$)'))
      ORDER BY o.id,c.id LIMIT ${snapshotBatchSize}`);
    for (const row of rows) {
      if (row.oversized) throw new ValidateException('促销统计商品快照过大');
      const raw = row.cart_info;
      if (raw !== null && typeof raw !== 'string') throw new ValidateException('促销统计商品快照无法读取');
      promotionCents += snapshotAmount(raw, Number(row.cart_num), linked);
      lastSnapshotOrder = Number(row.oid);
      lastCartId = Number(row.id);
    }
    if (rows.length < snapshotBatchSize) break;
  }
  const sumUser = Number(summary?.sum_user ?? 0), oldUser = Number(summary?.old_user ?? 0);
  return { sum_pay_price: money(cents(summary?.sum_pay_price ?? '0')),
    sum_promotions_price: money(promotionCents),
    sum_order: Number(summary?.sum_order ?? 0), sum_user: sumUser,
    old_user: oldUser, new_user: sumUser - oldUser };
}
