import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { otherOrder, paymentReconciliationCase, user } from '@/models/schema';
import { offlineOrderAdmission } from '@/models/candidates/offline_order_admission';
import { offlineOrderBalance } from '@/models/candidates/offline_order_balance';
import { offlineOrderExternalPayment } from '@/models/candidates/offline_order_external_payment';
import { offlineOrderPaymentDispatch } from '@/models/candidates/offline_order_payment_dispatch';
import { AuthException, NotFoundException, ValidateException } from '@/utils/errors';
import { assertOfflineAdmission } from './OfflineOrderPaymentContext';
import { readOfflinePaymentSelectionTx } from './OfflineOrderPaymentSelectionService';
import { readOfflineDispatchState, validateOfflineDispatchLink } from './OfflineOrderPaymentDispatchService';
import { verifyOfflineBalanceReceipt } from './OfflineOrderBalanceService';
import { verifyOfflineExternalReceipt } from './OfflineOrderExternalPaymentService';

/** Owner-only, repeatable READ ONLY snapshot. No provider I/O, row locks,
 * settlement, new attempt, account mutation or arbitrary raw evidence output.
 */
export async function readOfflineOrder(container: Container, uid: number, orderNo: string) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !/^xx[0-9a-f]{30}$/.test(orderNo)) throw new ValidateException('线下消费订单标识无效');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
    const [account] = await tx.select().from(user).where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime)));
    if (!account) throw new AuthException('用户状态不可用，请重新登录');
    return readOfflineOrderEvidenceTx(tx, uid, orderNo, account);
  });
}

/** Internal evidence projection. Caller must own a REPEATABLE READ / READ ONLY
 * snapshot and authorize its principal. Customer callers require an active
 * account; staff reads may inspect banned/deleted customers without impersonation.
 * A returned provider ticket is customer-only: staff must explicitly omit it. */
export async function readOfflineOrderEvidenceTx(tx: DbClient, uid: number, orderNo: string, account: typeof user.$inferSelect) {
  if (account.uid !== uid) throw new ValidateException('线下消费核验账号不一致');
  const orders = await tx.select().from(otherOrder).where(eq(otherOrder.orderId, orderNo)).limit(2);
  const order = orders[0];
  if (orders.length !== 1 || !order || order.uid !== uid || order.type !== 3) throw new NotFoundException('线下消费订单不存在');
  const [admission] = await tx.select().from(offlineOrderAdmission).where(eq(offlineOrderAdmission.orderId, order.id));
  assertOfflineAdmission(order, admission, uid);
  const context = { order, admission, account }, selection = await readOfflinePaymentSelectionTx(tx, context);
  const [wallet] = await tx.select().from(offlineOrderBalance).where(eq(offlineOrderBalance.orderId, order.id));
  const [external] = await tx.select().from(offlineOrderExternalPayment).where(eq(offlineOrderExternalPayment.orderId, order.id));
  const cases = await tx.select().from(paymentReconciliationCase).where(eq(paymentReconciliationCase.orderNo, orderNo)).limit(3);
  const recovery = cases.find(row => row.provider === selection?.rail);
  const [dispatch] = selection ? await tx.select().from(offlineOrderPaymentDispatch)
    .where(eq(offlineOrderPaymentDispatch.selectionKey, selection.selectionKey)) : [];
  const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  const base = { order_id: orderNo, money: admission.rawPrice, pay_price: admission.payPrice,
    channel: admission.channel, hidden: order.isDel !== 0, pay_type: selection?.rail === 'wechat' ? 'weixin' : selection?.rail ?? '',
    created_at: admission.createdAt };
  if (wallet && external) throw new ValidateException('线下消费存在多重收款凭据');
  if (order.paid === 1) {
    if (!selection) throw new ValidateException('线下消费缺少支付路径');
    if (wallet) {
      if (selection.rail !== 'yue' || wallet.uid !== uid || wallet.orderNo !== orderNo || wallet.payPrice !== order.payPrice
        || selection.createdAt !== wallet.paidAt || order.payTime !== wallet.paidAt || order.payType !== 'yue' || order.tradeNo !== ''
        || cases.length || dispatch) throw new ValidateException('线下消费余额凭据不一致');
      await verifyOfflineBalanceReceipt(tx, wallet);
    } else if (external) {
      if (selection.rail !== external.provider || selection.profile !== external.profile || external.uid !== uid
        || external.orderNo !== orderNo || external.payPrice !== order.payPrice || order.payType !== base.pay_type
        || order.tradeNo !== external.transactionId || order.payTime !== external.paidAt) throw new ValidateException('线下消费外部凭据不一致');
      await verifyOfflineExternalReceipt(tx, external, selection);
    } else throw new ValidateException('线下消费缺少收款凭据');
    return { ...base, paid: true, paid_at: order.payTime,
      state: cases.some(row => ['CONFLICT', 'CLOSED'].includes(row.status)) ? 'REVIEW_REQUIRED' as const : 'PAID' as const };
  }
  if (wallet || external || order.paid !== 0 || order.payType !== '' || order.payTime !== 0 || order.tradeNo !== '') {
    throw new ValidateException('线下消费付款状态与凭据不一致');
  }
  if (order.isDel !== 0 || admission.payPrice === '0.00') return { ...base, paid: false, state: 'UNAVAILABLE' as const };
  if (!selection) return { ...base, paid: false, state: cases.length ? 'RECOVERY_REQUIRED' as const : 'UNSELECTED' as const };
  if (selection.rail === 'yue') throw new ValidateException('线下消费余额路径缺少收款凭据');
  if (cases.length > 1) return { ...base, paid: false, state: 'REVIEW_REQUIRED' as const };
  validateOfflineDispatchLink({ selection, recovery, dispatch, now: clock.now });
  const payment = readOfflineDispatchState({ context, selection, recovery, dispatch, now: clock.now }, true);
  if (payment.status === 'PAID') throw new ValidateException('线下消费付款状态不一致');
  return { ...base, paid: false, state: payment.status,
    ...(payment.status === 'READY' ? { ticket: payment.ticket, display_until: payment.displayUntil } : {}) };
}
