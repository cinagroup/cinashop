import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderEconomize } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

export const MEMBER_SAVINGS_VERSION = 'checkout-member-savings-v1';
const metadata = ['member_savings_version', 'paid_member', 'member_postage_price', 'member_coupon_price'];
const invalid = () => new ValidateException('会员节省金额快照证据不一致，请核对订单');
type Order = Pick<typeof storeOrder.$inferSelect, 'id' | 'uid' | 'orderId' | 'paid' | 'pid' | 'payPrice' | 'totalNum'>;
type Cart = Pick<typeof storeOrderCartInfo.$inferSelect, 'oid' | 'uid' | 'cartId' | 'cartNum' | 'cartInfo'>;
function money(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(String(value))) throw invalid();
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
function decimal(value: bigint) {
  if (value < 0n || value > 999999999999n) throw invalid();
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
function record(value: string | null): Record<string, unknown> | null {
  if (value === null || value === '') return null;
  if (new TextEncoder().encode(value).length > 65536) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  return parsed as Record<string, unknown>;
}

/** Paid-member benefits, not all price reductions. Null means old evidence is
 * unavailable, never permission to reconstruct it from current products/rights. */
export function orderMembershipSavings(order: Pick<Order, 'id' | 'uid' | 'totalNum'>, carts: readonly Cart[]) {
  if (carts.length > 200) throw invalid();
  if (carts.reduce((bytes, row) => bytes + new TextEncoder().encode(row.cartInfo ?? '').length, 0) > 8388608) throw invalid();
  const snapshots = carts.map(row => record(row.cartInfo));
  if (snapshots.every(info => !info || !metadata.some(key => Object.hasOwn(info, key)))) return null;
  if (!carts.length || new Set(carts.map(row => row.cartId)).size !== carts.length) throw invalid();
  let member = 0n, postage = 0n, coupon = 0n, quantity = 0n;
  let eligible: number | undefined;
  for (const [index, row] of carts.entries()) {
    const info = snapshots[index];
    if (!info || info.member_savings_version !== MEMBER_SAVINGS_VERSION
      || typeof info.financial_version !== 'string'
      || !['checkout-line-finance-v1', 'refund-order-line-finance-v1'].includes(info.financial_version)
      || row.oid !== order.id || row.uid !== order.uid || !Number.isSafeInteger(row.cartNum)
      || row.cartNum <= 0 || row.cartNum > 2147483647 || info.id !== row.cartId
      || (info.cart_num !== row.cartNum && info.cart_num !== String(row.cartNum))
      || (info.paid_member !== 0 && info.paid_member !== 1)
      || (eligible !== undefined && eligible !== info.paid_member)
      || typeof info.price_type !== 'string' || !['', 'level', 'member'].includes(info.price_type)) throw invalid();
    eligible = info.paid_member;
    const benefit = money(info.vip_truePrice), freight = money(info.member_postage_price), voucher = money(info.member_coupon_price);
    const rawFreight = money(info.raw_postage_price), chargedFreight = money(info.postage_price), lineCoupon = money(info.coupon_price);
    if ((info.price_type === '' && benefit !== 0n) || (info.price_type === 'member' && eligible !== 1)
      || (eligible !== 1 && (freight !== 0n || voucher !== 0n))
      || chargedFreight > rawFreight
      || (freight !== 0n && freight !== rawFreight - chargedFreight)
      || (voucher !== 0n && voucher !== lineCoupon)) throw invalid();
    if (info.price_type === 'member') member += benefit * BigInt(row.cartNum);
    postage += freight; coupon += voucher; quantity += BigInt(row.cartNum);
  }
  if (!Number.isSafeInteger(order.totalNum) || quantity !== BigInt(order.totalNum)) throw invalid();
  return { eligible: eligible === 1, memberPrice: decimal(member), postagePrice: decimal(postage), couponPrice: decimal(coupon) };
}

/** The paid-outbox caller already holds the payment root and family locks.
 * Root cart history survives supplier/refund splits; only the root is booked.
 * Bound TEXT before transfer and retain the existing transaction/lock order. */
export async function recordPaidOrderMembershipSavings(
  tx: Pick<DbClient, 'select' | 'insert'> & Partial<Pick<DbClient, '$client'>>, order: Order, now: number,
) {
  if (tx.$client) throw Error('Membership savings require the owning payment-effects transaction');
  if (order.paid !== 1 || order.pid > 0) throw invalid();
  if (order.uid === 0) return; // No account ledger for an assisted guest.
  if (!Number.isSafeInteger(order.uid) || order.uid <= 0 || !Number.isSafeInteger(now) || now <= 0) throw invalid();
  const bytes = sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo})::bigint,0)`;
  const oversized = sql`${bytes}>65536 OR SUM(${bytes}) OVER ()>8388608`;
  const carts = await tx.select({ oid: storeOrderCartInfo.oid, uid: storeOrderCartInfo.uid, cartId: storeOrderCartInfo.cartId,
    cartNum: storeOrderCartInfo.cartNum,
    cartInfo: sql<string | null>`CASE WHEN NOT (${oversized}) THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
    oversized: sql<boolean>`${oversized}`,
  }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  if (carts.some(row => row.oversized)) throw invalid();
  const savings = orderMembershipSavings(order, carts);
  if (!savings?.eligible) return;
  const values = { orderId: order.orderId, uid: order.uid, orderType: 1, payPrice: decimal(money(order.payPrice)),
    memberPrice: savings.memberPrice, postagePrice: savings.postagePrice, couponPrice: savings.couponPrice,
    offlinePrice: '0.00', status: 0, addTime: now };
  const inserted = await tx.insert(storeOrderEconomize).values(values)
    .onConflictDoNothing({ target: [storeOrderEconomize.orderId, storeOrderEconomize.uid] }).returning({ id: storeOrderEconomize.id });
  if (inserted.length) return;
  const [existing] = await tx.select().from(storeOrderEconomize)
    .where(and(eq(storeOrderEconomize.orderId, order.orderId), eq(storeOrderEconomize.uid, order.uid))).limit(1);
  if (!existing || existing.orderType !== 1 || existing.status !== 0
    || ['payPrice', 'memberPrice', 'postagePrice', 'couponPrice', 'offlinePrice'].some(key => {
      const field = key as 'payPrice' | 'memberPrice' | 'postagePrice' | 'couponPrice' | 'offlinePrice';
      return money(existing[field]) !== money(values[field]);
    })) throw invalid();
}
