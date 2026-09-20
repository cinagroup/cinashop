import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { otherOrder, user } from '@/models/schema';
import { offlineOrderAdmission } from '@/models/candidates/offline_order_admission';
import { AuthException, ValidateException } from '@/utils/errors';

/** Shared order -> account lock order for all admitted offline payment paths. */
export async function lockOfflineOrderPayment(tx: DbClient, input: { uid: number; orderNo: string }) {
  return lockContext(tx, input, false);
}

/** Only for already verified, durable provider collection. A later account ban
 * or hidden order must not erase an external financial fact. Not an initiation
 * bypass: the caller must validate the immutable callback binding first.
 */
export async function lockOfflineCollectedPayment(tx: DbClient, input: { uid: number; orderNo: string }) {
  return lockContext(tx, input, true);
}

/** Internal read-only recovery preflight, not permission to initiate or settle a
 * payment. It must also inspect pending collection after an account ban. The
 * caller revalidates the immutable selection and releases locks before I/O.
 */
export async function lockOfflinePaymentQuery(tx: DbClient, input: { uid: number; orderNo: string }) {
  return lockContext(tx, input, true);
}

export async function prepareOfflinePaymentTransaction(tx: DbClient) {
  const [settings] = await tx.execute<{ isolation: string }>(sql`SELECT current_setting('transaction_isolation') AS isolation,
    set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true)`);
  if (settings.isolation !== 'read committed') throw new ValidateException('线下消费支付必须使用READ COMMITTED事务');
}

async function lockContext(tx: DbClient, input: { uid: number; orderNo: string }, collected: boolean) {
  if (!Number.isSafeInteger(input.uid) || input.uid <= 0 || !/^xx[0-9a-f]{30}$/.test(input.orderNo)) {
    throw new ValidateException('线下消费支付标识无效');
  }
  await prepareOfflinePaymentTransaction(tx);
  const orders = await tx.select().from(otherOrder).where(eq(otherOrder.orderId, input.orderNo))
    .orderBy(asc(otherOrder.id)).limit(2).for('update');
  const order = orders[0];
  if (orders.length !== 1 || !order || order.uid !== input.uid || order.type !== 3) throw new ValidateException('线下消费订单不存在或身份异常');
  const [admission] = await tx.select().from(offlineOrderAdmission).where(eq(offlineOrderAdmission.orderId, order.id));
  assertOfflineAdmission(order, admission, input.uid);
  const [account] = await tx.select().from(user).where(and(eq(user.uid, input.uid),
    ...(collected ? [] : [eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime)]))).limit(1).for('update');
  if (!account) throw new AuthException('用户状态不可用，请重新登录');
  return { order, admission, account };
}
/** Same immutable identity validation for locked writers and read-only snapshots. */
export function assertOfflineAdmission(order: typeof otherOrder.$inferSelect,
  admission: typeof offlineOrderAdmission.$inferSelect | undefined, uid: number): asserts admission is typeof offlineOrderAdmission.$inferSelect {
  if (order.uid !== uid || order.type !== 3) throw new ValidateException('线下消费订单不存在或身份异常');
  if (!admission || admission.uid !== uid || admission.orderId !== order.id || admission.orderNo !== order.orderId || admission.rawPrice !== order.money
    || admission.payPrice !== order.payPrice || admission.payPrice !== order.memberPrice || admission.channel !== order.channelType
    || admission.createdAt !== order.addTime || order.storeId !== 0 || order.staffId !== 0 || order.memberType !== ''
    || order.isFree !== 0 || order.isPermanent !== 0 || order.overdueTime !== 0 || order.vipDay !== 0) {
    throw new ValidateException('线下消费建单凭据不一致');
  }
}
export type OfflineOrderPaymentContext = Awaited<ReturnType<typeof lockOfflineOrderPayment>>;

export function assertUnpaidOfflineOrder(order: OfflineOrderPaymentContext['order']) {
  if (order.paid !== 0 || order.payType !== '' || order.tradeNo !== '' || order.payTime !== 0 || order.isDel !== 0) {
    throw new ValidateException('线下消费订单不处于可支付状态');
  }
}
