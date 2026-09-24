import { asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrderCartInfo } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

const MAX_SNAPSHOT_BYTES = 65_536;
const MAX_LINES = 200;
const MAX_INT = 2_147_483_647;
const invalid = () => new ValidateException('预售订单履约快照缺失或无效，请先核对订单凭据');

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= MAX_INT;
}

// PHP JSON may contain canonical decimal strings from database scalar fields.
// No boolean/null/empty/whitespace/exponent coercions, and no live product lookup.
function legacyInteger(value: unknown): number {
  const parsed = typeof value === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(value) ? Number(value) : value;
  if (!integer(parsed)) throw invalid();
  return parsed;
}

/** Only persisted order evidence can authorize dispatch. A present but invalid
 * versioned marker must never downgrade to an otherwise valid legacy snapshot.
 * Returns the PHP dispatch boundary, NOT the purchase cutoff (end + 1 second)
 * or the shipping promise (end + N days).
 */
export function presaleDispatchBoundary(raw: string | null, productId: number): number {
  if (!integer(productId, 1) || typeof raw !== 'string' || raw.length > MAX_SNAPSHOT_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES) throw invalid();
  let snapshot: Record<string, unknown> | undefined;
  try { snapshot = record(JSON.parse(raw)); } catch { throw invalid(); }
  if (!snapshot) throw invalid();
  if (Object.prototype.hasOwnProperty.call(snapshot, 'presale')) {
    const terms = record(snapshot.presale);
    if (!terms || terms.version !== 'presale-full-payment-v1' || terms.productId !== productId ||
      !integer(terms.startsAt) || !integer(terms.endsAt) || terms.endsAt < terms.startsAt ||
      !integer(terms.shippingDaysAfterEnd) || typeof terms.paidMemberOnly !== 'boolean' ||
      !(terms.perOrderLimit === null || integer(terms.perOrderLimit, 1))) throw invalid();
    return terms.endsAt;
  }
  const legacy = record(snapshot.productInfo);
  if (!legacy || legacyInteger(legacy.id) !== productId) throw invalid();
  const end = legacyInteger(legacy.presale_end_time);
  if ('presale_start_time' in legacy && legacyInteger(legacy.presale_start_time) > end) throw invalid();
  if ('presale_day' in legacy) legacyInteger(legacy.presale_day);
  if ('is_presale_product' in legacy && legacyInteger(legacy.is_presale_product) !== 1) throw invalid();
  return end;
}

/** Caller owns a short transaction and holds the exact active order FOR UPDATE.
 * SHARE, unlike KEY SHARE, protects cartInfo against non-key edits until commit.
 * NOWAIT introduces no reverse cart->order wait edge. Bounds are applied in SQL
 * before large snapshot bodies cross the database/Worker boundary.
 * Owner-confirmed policy also gates pickup/automatic fulfillment at this boundary.
 * Automatic delivery additionally needs a durable due-time task, not failed retries.
 */
export async function assertPresaleDispatchReady(tx: DbClient, order: { id: number; type: number },
  action: '发货' | '核销' = '发货'): Promise<void> {
  if (order.type !== 6) return;
  if (Object.hasOwn(tx, '$client')) throw new Error('Presale dispatch requires a caller-owned transaction');
  if (!integer(order.id, 1)) throw invalid();
  let latestEnd = 0;
  try {
    const rows = await tx.select({ productId: storeOrderCartInfo.productId,
      cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo}) <= ${MAX_SNAPSHOT_BYTES}
        THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
    }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id))
      .orderBy(asc(storeOrderCartInfo.id)).limit(MAX_LINES + 1).for('share', { noWait: true });
    if (!rows.length || rows.length > MAX_LINES) throw invalid();
    for (const row of rows) latestEnd = Math.max(latestEnd, presaleDispatchBoundary(row.cartInfo, row.productId));
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('预售订单履约快照正在更新，请稍后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
  const [clock] = await tx.select({ ready: sql<boolean>`clock_timestamp() >= to_timestamp(${latestEnd})` })
    .from(sql`(VALUES(1)) AS presale_dispatch_clock(n)`);
  if (clock?.ready !== true) throw new ValidateException(`预售活动尚未结束，不能${action}`);
}
