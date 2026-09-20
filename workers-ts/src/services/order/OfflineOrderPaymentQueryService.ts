import { eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container } from '@/lib/di';
import { storeOrder, userRecharge } from '@/models/schema';
import { offlineOrderPaymentSelection } from '@/models/candidates/offline_order_payment_selection';
import { AlipayTradeQueryService } from '@/services/payment/AlipayTradeQueryService';
import type { PaymentProviderQueryRequest } from '@/services/payment/PaymentProviderQuery';
import { validatePaymentQueryIdentity, type PaymentQueryOriginalIdentity } from '@/services/payment/PaymentQueryIdentity';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { ValidateException } from '@/utils/errors';
import { lockOfflinePaymentQuery, prepareOfflinePaymentTransaction } from './OfflineOrderPaymentContext';
import { readOfflinePaymentSelectionTx } from './OfflineOrderPaymentSelectionService';
import { offlineAmountCents } from './OfflineOrderQuoteService';

/** Internal read-only query adapter; no public route or financial writes here.
 * Recovery persists distinct query provenance before the shared settler can use
 * it. A result must never be passed off as a verified notification.
 */
export async function queryOfflineOrderPayment(container: Container, env: Env, input: PaymentProviderQueryRequest) {
  const request = { ...input };
  if (request.orderDomain !== 'offline_order' || typeof request.orderNo !== 'string' || !/^xx[0-9a-f]{30}$/.test(request.orderNo)
    || !Number.isSafeInteger(request.expectedAmountCents) || request.expectedAmountCents <= 0
    || request.expectedAmountCents > 2_147_483_647 || request.currency !== 'CNY') {
    throw new ValidateException('线下消费查单标识无效');
  }
  const snapshot = await withTx(container, async tx => {
    await prepareOfflinePaymentTransaction(tx);
    const [hint] = await tx.select().from(offlineOrderPaymentSelection).where(eq(offlineOrderPaymentSelection.orderNo, request.orderNo));
    if (!hint) throw new ValidateException('线下消费原支付路径不存在');
    const context = await lockOfflinePaymentQuery(tx, { orderNo: request.orderNo, uid: hint.uid });
    const selection = await readOfflinePaymentSelectionTx(tx, context);
    if (!selection || selection.selectionKey !== hint.selectionKey || selection.rail !== request.provider
      || selection.profile !== request.profile || offlineAmountCents(selection.payPrice) !== BigInt(request.expectedAmountCents)
      || selection.currency !== request.currency || !['h5', 'jsapi', 'wap'].includes(selection.transactionType)) {
      throw new ValidateException('线下消费查单与原支付路径不一致');
    }
    const [ambiguity] = await tx.execute<{ present: boolean }>(sql`SELECT
      (EXISTS(SELECT 1 FROM ${storeOrder} WHERE order_id=${request.orderNo})
        OR EXISTS(SELECT 1 FROM ${userRecharge} WHERE order_id=${request.orderNo})) AS present`);
    if (ambiguity.present) throw new ValidateException('线下消费查单订单号存在跨域歧义');
    const transactionType = selection.transactionType;
    if (transactionType !== 'h5' && transactionType !== 'jsapi' && transactionType !== 'wap') throw new ValidateException('查单渠道无效');
    const identity: PaymentQueryOriginalIdentity = { appId: selection.appId, merchantId: selection.merchantId,
      payerId: selection.payerId, transactionType };
    validatePaymentQueryIdentity(request, identity);
    return { identity, selectionKey: selection.selectionKey };
  });
  // All locks/transactions have ended, including before config KV reads. Query
  // uses the frozen payer, never today's user binding or caller-supplied identity.
  const result = request.provider === 'alipay'
    ? await new AlipayTradeQueryService(env).query(request, snapshot.identity)
    : await new WechatPayService(container, env).queryOrder(request, snapshot.identity);
  return { selectionKey: snapshot.selectionKey, result };
}
