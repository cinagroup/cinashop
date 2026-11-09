import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container } from '@/lib/di';
import { user, userRecharge, userBill } from '@/models/schema';
import { NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { rechargeRefundCents, rechargeRefundDecimal, rechargeRefundId } from '@/services/payment/RechargeRefundMoney';
import { readRechargeRefundOperationTx, lockRechargeRefundKeyTx, insertRechargeRefundEvidenceTx } from '@/services/payment/RechargeRefundLedger';
import { readRechargeRefundStateTx, assertRechargeRefundHoldBillTx, assertRechargeRefundBusinessResolutionTx } from '@/services/payment/RechargeRefundAccounting';
import { rechargeRefundCancelBeforePost } from '@/services/payment/RechargeRefundStateMachine';
import { lockStoreOrderPaymentBoundary } from '@/services/payment/StoreOrderPaymentBoundary';
import { captureAdminRechargeRefundActor, authorizeAdminRechargeRefundTx, type AdminRechargeRefundActor } from './AdminRechargeRefundActor';

const unavailable = (): never => { throw new ServiceUnavailableException('充值退款预留释放需要人工核对，请保留原操作'); };

/** This action cannot cancel a POST. It only releases a proven unused local
 * reservation under fresh permission, common payment/wallet/state locks and
 * immutable NOT EXISTS request evidence in the same atomic transaction. */
export async function cancelAdminRechargeRefundBeforePost(container: Container, env: Pick<Env, 'APP_KEY'>,
  input: AdminRechargeRefundActor, rechargeId: number, requestKey: unknown) {
  const actor = captureAdminRechargeRefundActor(input), id = rechargeRefundId(rechargeId), key = normalizeOutRequestKey(requestKey);
  return withTx(container, async tx => {
    await authorizeAdminRechargeRefundTx(tx, actor);
    await lockRechargeRefundKeyTx(tx, actor.id, key);
    const operation = await readRechargeRefundOperationTx(tx, env, actor.id, key, 'write');
    if (!operation) throw new NotFoundException('原充值退款操作尚未存在，请先查询原请求');
    if (operation.recharge_id !== id) throw new ValidateException('原操作不属于当前充值订单');
    if (operation.admission !== 'reserved') return { operation, released: false };
    await assertRechargeRefundBusinessResolutionTx(tx);
    const [locked] = await tx.execute<{ id: number }>(sql`SELECT public.recharge_refund_lock_source_v1(${operation.recharge_id}::integer) AS id`);
    if (locked?.id !== operation.recharge_id) return unavailable();
    const orders = await tx.select().from(userRecharge).where(eq(userRecharge.id, Number(operation.recharge_id)))
      .limit(2), order = orders[0];
    if (orders.length !== 1 || order.uid !== operation.buyer_uid || order.orderId !== operation.order_no
      || order.paid !== 1 || order.rechargeType !== 'weixin' || order.tradeNo !== operation.transaction_id
      || rechargeRefundCents(order.price) !== operation.principal_cents || rechargeRefundCents(order.givePrice) !== operation.gift_cents
      || rechargeRefundCents(order.refundPrice) !== 0) return unavailable();
    await lockStoreOrderPaymentBoundary(tx, order.orderId);
    const wallets = await tx.select({ uid: user.uid, nowMoney: user.nowMoney, isDel: user.isDel, deleteTime: user.deleteTime })
      .from(user).where(eq(user.uid, order.uid)).limit(2).for('update', { noWait: true }), wallet = wallets[0];
    if (wallets.length !== 1 || wallet.isDel !== 0 || wallet.deleteTime !== null) return unavailable();
    const state = await readRechargeRefundStateTx(tx, operation), hold = await assertRechargeRefundHoldBillTx(tx, operation);
    const [counts] = await tx.execute<{ attempts: string; results: string }>(sql`SELECT
      (SELECT count(*)::text FROM public.recharge_refund_attempt WHERE operation_id=${operation.operation_id}::uuid) AS attempts,
      (SELECT count(*)::text FROM public.recharge_refund_result WHERE operation_id=${operation.operation_id}::uuid) AS results`);
    // A projection edited back to RESERVED cannot hide any immutable POST,
    // query, callback or earlier release. Later release replay is verified by
    // the read-only execution reader, rather than credited a second time here.
    if (counts?.attempts !== '0' || counts.results !== '0') throw new ValidateException('原操作已有执行证据，请查询原退款结果');
    if (state.version !== 0 || state.last_result_id !== null || state.provider_refund_id !== null
      || state.updated_at !== state.created_at) return unavailable();
    rechargeRefundCancelBeforePost({ status: state.status, walletState: state.wallet_state,
      requestAttempts: state.attempt_count, leaseUntil: state.lease_until ?? 0, nextQueryAt: state.next_query_at ?? 0 });
    const before = rechargeRefundCents(wallet.nowMoney, true), after = before + Number(operation.debit_cents);
    const balance = rechargeRefundDecimal(after); // Overflow rolls back; never truncate a return.
    const [clock] = await tx.execute<{ now: string }>(sql`SELECT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
    const now = Number(clock?.now);
    if (!Number.isSafeInteger(now) || now < state.created_at || now > 2_147_483_647) return unavailable();
    const updated = await tx.update(user).set({ nowMoney: balance })
      .where(and(eq(user.uid, wallet.uid), eq(user.nowMoney, wallet.nowMoney))).returning({ uid: user.uid });
    if (updated.length !== 1) return unavailable();
    const bills = await tx.insert(userBill).values({ uid: wallet.uid, linkId: order.orderId,
      eventKey: `recharge_refund_release:${operation.operation_id}`, pm: 1, category: 'now_money', type: 'recharge_refund_release',
      title: '取消充值退款退回预留', number: rechargeRefundDecimal(Number(operation.debit_cents)), balance,
      status: 1, addTime: now, mark: '渠道请求尚未发出，退回原充值退款预留' }).returning({ id: userBill.id });
    if (bills.length !== 1) return unavailable();
    const cancelId = randomUUID(), releaseId = randomUUID();
    await insertRechargeRefundEvidenceTx(tx, env, 'admin', 'recharge_refund_result', {
      result_id: cancelId, operation_id: operation.operation_id, attempt_id: null, source: 'local_cancel',
      source_id: `cancel:${operation.operation_id}`, status: 'CLOSED', created_at: now, caused_by_result_id: null,
      evidence: { format: 1, adminId: actor.id, requestKey: key, reason: 'admin_cancel_before_post', previousVersion: 0 } });
    await insertRechargeRefundEvidenceTx(tx, env, 'admin', 'recharge_refund_result', {
      result_id: releaseId, operation_id: operation.operation_id, attempt_id: null, source: 'local_release',
      source_id: `release:${operation.operation_id}`, status: 'SUCCESS', created_at: now, caused_by_result_id: cancelId,
      evidence: { format: 1, reason: 'admin_cancel_before_post', holdBillId: hold.billId, releaseBillId: bills[0].id,
        walletBeforeCents: before, walletAfterCents: after, debitCents: operation.debit_cents, previousVersion: 0, nextVersion: 1 } });
    const states = await tx.execute(sql`UPDATE public.recharge_refund_state SET status='FAILED',wallet_state='released',version=1,
      last_result_id=${releaseId}::uuid,updated_at=${now}
      WHERE operation_id=${operation.operation_id}::uuid AND version=0 AND status='RESERVED' AND wallet_state='held' AND attempt_count=0
        AND lease_id IS NULL AND lease_until IS NULL AND next_query_at IS NULL AND last_result_id IS NULL RETURNING operation_id`);
    if (states.length !== 1) return unavailable();
    return { operation, released: true };
  });
}
