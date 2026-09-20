import { and, asc, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { planCompletedRefundLineCompensation } from './OrderSplitFinance';
import { currentGenerationRefunds, loadRefundOrderGeneration } from './RefundOrderGeneration';
import { refundEarnedIncomeCompensation } from './RefundEarnedIncome';

/** Caller holds the order settlement lock/row, before locking users. A
 * finalizer projects its locked current claim as completed; receipt reads
 * previously completed claims. Lock and validate once, then share the plan
 * with reward/brokerage compensation in the same transaction. No provider I/O. */
export async function loadRefundLineCompensation(tx: DbClient, orderId: number, projected?: {
  order: typeof storeOrder.$inferSelect;
  refund: typeof storeOrderRefund.$inferSelect;
}) {
  const order = projected?.order ?? (await tx.select().from(storeOrder).where(eq(storeOrder.id, orderId)).limit(1))[0];
  if (!order) throw new ValidateException('退款补偿订单不存在');
  if (order.id !== orderId || (projected && (projected.refund.storeOrderId !== orderId
    || projected.refund.refundType === 6))) throw new ValidateException('退款补偿申请关联无效');
  const rows = await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, orderId))
    .orderBy(asc(storeOrderCartInfo.id)).limit(201).for('update');
  // Legacy rows can predate cart snapshots entirely. Preserve their existing
  // compensation path; mixed/invalid modern evidence is rejected by the plan.
  if (!rows.length) return null;
  const generation = await loadRefundOrderGeneration(tx, order, rows);
  const history = await tx.select().from(storeOrderRefund).where(and(
    eq(storeOrderRefund.storeOrderId, orderId), eq(storeOrderRefund.refundType, 6),
    eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0),
  )).orderBy(asc(storeOrderRefund.id)).limit(403);
  if (history.length > 402) throw new ValidateException('退款补偿历史过长，请先核对订单');
  const completed = await currentGenerationRefunds(history, generation);
  if (projected) completed.push({ ...projected.refund, refundType: 6, refundedPrice: projected.refund.refundPrice });
  const plan = planCompletedRefundLineCompensation(order, rows, completed);
  return plan && generation ? { ...plan, returnedPointBillIds: generation.returnedPointBillIds,
    ...(generation.earnedIncomeScope ? { earnedIncome: refundEarnedIncomeCompensation(plan, generation.earnedIncomeScope) } : {}),
    materializedRefundIds: [...generation.materialized.keys()] } : plan;
}
