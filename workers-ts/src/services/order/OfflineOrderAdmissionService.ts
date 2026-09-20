import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { otherOrder, otherOrderStatus, user } from '@/models/schema';
import { offlineOrderAdmission } from '@/models/candidates/offline_order_admission';
import { ApiException, AuthException, ValidateException } from '@/utils/errors';
import { offlineAmountCents, offlineMoney, offlinePayableCents, readOfflineOrderPricing } from './OfflineOrderQuoteService';

const CHANNELS: Readonly<Record<string, string>> = {
  weixin: 'wechat', wechat: 'wechat', weixinh5: 'weixinh5', routine: 'routine', h5: 'h5',
};
export interface OfflineOrderAdmissionInput {
  uid: number;
  requestKey: string;
  /** Strict decimal strings at the write boundary; never client-computed discounts. */
  money: string;
  expectedPayPrice: string;
  from: string;
  /** Server-allocated before the transaction; not a client-supplied identifier. */
  orderNo: string;
}

/** Unreleased write core, now used by the authenticated offline create route.
 * Controlled production migration/activation is still outstanding. Atomically
 * creates an unpaid type=3 order and immutable admission receipt, no funds,
 * membership extension, gifts or external calls. A replay never creates again.
 */
export async function admitOfflineOrder(container: Container, input: OfflineOrderAdmissionInput) {
  if (!Number.isSafeInteger(input.uid) || input.uid <= 0) throw new ValidateException('用户 ID 无效');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.requestKey)) {
    throw new ValidateException('线下消费请求标识无效');
  }
  if (!/^xx[0-9a-f]{30}$/.test(input.orderNo)) throw new ValidateException('线下消费订单号无效');
  if (typeof input.money !== 'string' || typeof input.expectedPayPrice !== 'string') {
    throw new ValidateException('消费金额必须使用十进制字符串');
  }
  const money = offlineMoney(offlineAmountCents(input.money));
  const expectedPayPrice = offlineMoney(offlinePayableCents(input.expectedPayPrice));
  const channel = typeof input.from === 'string' && Object.hasOwn(CHANNELS, input.from) ? CHANNELS[input.from] : undefined;
  if (!channel) throw new ValidateException('非法渠道');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    'offline-admission-v1', input.uid, money, expectedPayPrice, channel,
  ])));
  const requestHash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');

  return withTx(container, async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true)`);
    // Serialize absent request keys by user. Replays never lock an existing
    // order, so they cannot invert the payment order -> user lock sequence.
    const [account] = await tx.select({ uid: user.uid }).from(user)
      .where(and(eq(user.uid, input.uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1).for('update');
    if (!account) throw new AuthException('用户状态不可用，请重新登录');
    const [prior] = await tx.select().from(offlineOrderAdmission)
      .where(and(eq(offlineOrderAdmission.uid, input.uid), eq(offlineOrderAdmission.requestKey, input.requestKey))).limit(1);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new ApiException('相同请求标识的消费信息已变更', 409);
      const rows = await tx.select().from(otherOrder).where(eq(otherOrder.orderId, prior.orderNo)).limit(2);
      const order = rows[0];
      if (rows.length !== 1 || !order || order.id !== prior.orderId || order.uid !== input.uid || order.type !== 3
        || order.money !== prior.rawPrice || order.payPrice !== prior.payPrice || order.channelType !== prior.channel) {
        throw new ValidateException('线下消费原订单证据不一致');
      }
      return { id: order.id, order_id: order.orderId, pay_price: order.payPrice,
        paid: order.paid === 1, cancelled: order.isDel !== 0, replayed: true };
    }
    // Fixed, separately granted definer capability: SHARE locking in PG16 needs
    // table-level write privileges, which this caller must not receive merely
    // to read pricing. Covers missing/duplicate keys until this transaction ends.
    try { await tx.execute(sql`SELECT public.ooa_lock_pricing()`); }
    catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
        if ('code' in cause && cause.code === '55P03') throw new ValidateException('订单计价配置正在更新，请稍后重新确认');
        if ('code' in cause && cause.code === '25000') throw new ValidateException('线下消费建单必须使用READ COMMITTED事务');
        if (!('cause' in cause) || cause.cause === cause) break;
        cause = cause.cause;
      }
      throw error;
    }
    const pricing = await readOfflineOrderPricing(tx, input.uid, money);
    if (pricing.payPrice !== expectedPayPrice) {
      throw new ApiException('消费报价已变更，请重新确认', 409, { pay_price: pricing.payPrice });
    }
    const occupied = await tx.select({ id: otherOrder.id }).from(otherOrder)
      .where(eq(otherOrder.orderId, input.orderNo)).limit(1);
    if (occupied.length) throw new ValidateException('线下消费订单号已存在');
    const [order] = await tx.insert(otherOrder).values({ uid: input.uid, type: 3, orderId: input.orderNo,
      money, payPrice: pricing.payPrice, memberPrice: pricing.payPrice, channelType: channel, addTime: pricing.quotedAt,
    }).returning({ id: otherOrder.id });
    if (!order) throw Error('Offline order insert failed');
    await tx.insert(offlineOrderAdmission).values({ uid: input.uid, requestKey: input.requestKey, requestHash,
      orderId: order.id, orderNo: input.orderNo, rawPrice: money, payPrice: pricing.payPrice,
      memberActive: pricing.memberActive, discountPercent: pricing.discountPercent, channel, createdAt: pricing.quotedAt,
    });
    await tx.insert(otherOrderStatus).values({ oid: order.id, changeType: 'create_offline_scan_order',
      changeMessage: '线下收银订单生成', shopType: 3, changeTime: pricing.quotedAt });
    return { id: order.id, order_id: input.orderNo, pay_price: pricing.payPrice,
      paid: false, cancelled: false, replayed: false };
  });
}
