import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { memberRight, systemConfig, user } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ApiErrorCode, AuthException, ValidateException } from '@/utils/errors';

/** other_order.pay_price is NUMERIC(10,2). Convert validated decimals without rounding. */
export function offlineAmountCents(value: unknown, allowZero = false): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidateException('请输入有效的消费金额');
  }
  const text = String(value);
  if (text.length > 11 || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(text)) {
    throw new ValidateException('消费金额须为不超过99999999.99的两位小数');
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents === 0n && !allowZero) throw new ValidateException('消费金额必须大于0');
  return cents;
}

export function offlineMoney(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Explicit merchant policy: reject, never round a sub-cent discount up or
 * reinterpret it as a free membership/payment. Historical zero rows remain readable. */
export const OFFLINE_MIN_PAYABLE_MESSAGE = '线下消费应付金额至少为0.01元，折扣后不足0.01元不能建单或付款';
export function offlinePayableCents(value: unknown): bigint {
  const cents = offlineAmountCents(value, true);
  if (cents < 1n) throw new ValidateException(OFFLINE_MIN_PAYABLE_MESSAGE);
  return cents;
}

type OfflineRight = Pick<typeof memberRight.$inferSelect, 'status' | 'number'>;

/** Preview only: numeric 0 means NO member quote, not a free payment.
 * Creation/payment must independently admit immutable pricing evidence; this
 * response is neither an authorization nor a promise to charge this amount.
 */
export async function quoteOfflineOrder(db: DbClient, uid: number, amount: unknown): Promise<{ pay_price: string | 0 }> {
  const pricing = await readOfflineOrderPricing(db, uid, amount);
  return { pay_price: pricing.discountPercent > 0 ? pricing.payPrice : 0 };
}

/** Authoritative pricing projection for a future transaction-owned admission.
 * Unlike the legacy preview DTO, payPrice is always the actual charge amount.
 * A caller writing an order must protect the user/config sources until commit.
 */
export async function readOfflineOrderPricing(db: DbClient, uid: number, amount: unknown) {
  const cents = offlineAmountCents(amount);
  // One bounded SQL/MVCC snapshot, including membership expiry at statement time.
  // No cached auth-user membership, KV config, writes or provider calls.
  const [source] = await db.select({
    quotedAt: sql<number>`floor(extract(epoch FROM statement_timestamp()))::integer`,
    eligible: sql<boolean>`(${user.isEverLevel} = 1 OR
      (${user.isMoneyLevel} > 0 AND ${user.overdueTime} > floor(extract(epoch FROM statement_timestamp()))))`,
    enabled: sql<string | null>`(
      SELECT ${systemConfig.value} FROM ${systemConfig}
      WHERE ${systemConfig.isStore} = 0 AND ${systemConfig.menuName} = 'member_card_status'
      ORDER BY ${systemConfig.sort} DESC, ${systemConfig.id} DESC LIMIT 1
    )`,
    right: sql<OfflineRight | null>`(
      SELECT json_build_object('status', ${memberRight.status}, 'number', ${memberRight.number})
      FROM ${memberRight} WHERE ${memberRight.rightType} = 'offline'
      ORDER BY ${memberRight.id} LIMIT 1
    )`,
  }).from(user).where(and(eq(user.uid, uid), eq(user.isDel, 0), eq(user.status, 1))).limit(1);
  if (!source) throw new AuthException('用户状态已变更,请重新登录', ApiErrorCode.ERR_EXPIRED);
  const enabled = normalizeConfigScalar(source.enabled ?? '');
  if (enabled !== '' && (!/^-?\d+$/.test(enabled) || !Number.isSafeInteger(Number(enabled)))) {
    throw new ValidateException('会员计价配置无效');
  }
  const memberActive = source.eligible && (enabled === '' || Number(enabled) === 1);
  const percent = memberActive && source.right?.status === 1 ? source.right.number : 0;
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new ValidateException('线下消费会员折扣配置无效');
  }
  const discounted = percent > 0 ? cents * BigInt(percent) / 100n : cents;
  if (discounted < 1n) throw new ValidateException(OFFLINE_MIN_PAYABLE_MESSAGE);
  return { rawPrice: offlineMoney(cents), payPrice: offlineMoney(discounted), memberActive,
    discountPercent: percent, quotedAt: source.quotedAt };
}
