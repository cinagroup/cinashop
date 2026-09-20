import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { paymentCallbackEvent, paymentReconciliationCase, storeOrder, userRecharge } from '@/models/schema';
import { offlineOrderPaymentSelection } from '@/models/candidates/offline_order_payment_selection';
import { offlineOrderQueryEvidence } from '@/models/candidates/offline_order_query_evidence';
import { ValidateException } from '@/utils/errors';
import { offlineAmountCents } from './OfflineOrderQuoteService';
import { lockOfflineCollectedPayment } from './OfflineOrderPaymentContext';
import { readOfflinePaymentSelectionTx } from './OfflineOrderPaymentSelectionService';

export type OfflineCollectionFact = Pick<typeof paymentCallbackEvent.$inferSelect,
  'provider' | 'profile' | 'orderNo' | 'transactionId' | 'tradeState' | 'amountCents' | 'currency' | 'providerEventTime'>;
export type OfflineCollectionSelection = typeof offlineOrderPaymentSelection.$inferSelect;
export function matchesOfflineCollection(selection: OfflineCollectionSelection, fact: OfflineCollectionFact) {
  if (selection.rail === 'yue' || selection.rail !== fact.provider || selection.profile !== fact.profile
    || selection.orderNo !== fact.orderNo || offlineAmountCents(selection.payPrice) !== BigInt(fact.amountCents)) {
    throw new ValidateException('线下消费收款与原支付路径不一致');
  }
}
export async function selectionForOfflineCollection(tx: DbClient, fact: OfflineCollectionFact) {
  const [selection] = await tx.select().from(offlineOrderPaymentSelection).where(eq(offlineOrderPaymentSelection.orderNo, fact.orderNo));
  if (!selection) throw new ValidateException('线下消费支付路径不存在');
  matchesOfflineCollection(selection, fact);
  const [otherDomain] = await tx.execute<{ present: boolean }>(sql`SELECT
    (EXISTS(SELECT 1 FROM ${storeOrder} WHERE order_id=${fact.orderNo})
      OR EXISTS(SELECT 1 FROM ${userRecharge} WHERE order_id=${fact.orderNo})) AS present`);
  if (otherDomain.present) throw new ValidateException('线下消费订单号存在跨域歧义');
  return selection;
}
export async function lockOfflineCollectionContext(tx: DbClient, fact: OfflineCollectionFact, selection: OfflineCollectionSelection) {
  const context = await lockOfflineCollectedPayment(tx, { uid: selection.uid, orderNo: fact.orderNo });
  const frozen = await readOfflinePaymentSelectionTx(tx, context);
  if (!frozen || frozen.selectionKey !== selection.selectionKey) throw new ValidateException('线下消费支付路径不一致');
  matchesOfflineCollection(frozen, fact);
  return context;
}
/** Provider transaction lock is held by the caller before this common order lock. */
export async function lockOfflineCollectionRecovery(tx: DbClient, fact: OfflineCollectionFact) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-reconciliation:${fact.provider}:${fact.orderNo}`},0))`);
  const [recovery] = await tx.select().from(paymentReconciliationCase).where(and(
    eq(paymentReconciliationCase.provider, fact.provider), eq(paymentReconciliationCase.orderNo, fact.orderNo))).for('update');
  if (!recovery || ['CONFLICT', 'CLOSED'].includes(recovery.status) || !['', 'offline_order'].includes(recovery.orderDomain)
    || recovery.profile !== fact.profile || recovery.expectedAmountCents !== fact.amountCents || recovery.currency !== 'CNY'
    || recovery.providerTransactionId !== fact.transactionId) throw new ValidateException('线下消费恢复凭据缺失或冲突');
  const [conflict] = await tx.execute<{ present: boolean }>(sql`SELECT
    (EXISTS(SELECT 1 FROM ${paymentCallbackEvent} WHERE provider=${fact.provider} AND transaction_id=${fact.transactionId}
      AND (order_no<>${fact.orderNo} OR amount_cents<>${fact.amountCents} OR currency<>${fact.currency}))
    OR EXISTS(SELECT 1 FROM ${offlineOrderQueryEvidence} WHERE provider=${fact.provider} AND transaction_id=${fact.transactionId}
      AND (order_no<>${fact.orderNo} OR amount_cents<>${fact.amountCents} OR currency<>${fact.currency}))
    OR EXISTS(SELECT 1 FROM ${paymentReconciliationCase} WHERE provider=${fact.provider} AND provider_transaction_id=${fact.transactionId}
      AND order_no<>${fact.orderNo})) AS present`);
  if (conflict.present) throw new ValidateException('线下消费交易号存在冲突证据');
  return recovery;
}
