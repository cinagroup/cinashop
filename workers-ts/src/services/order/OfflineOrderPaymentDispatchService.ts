import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { paymentReconciliationCase } from '@/models/schema';
import { offlineOrderPaymentDispatch } from '@/models/candidates/offline_order_payment_dispatch';
import { registerPaymentReconciliationTx } from '@/services/payment/PaymentReconciliationRegistry';
import { prepareOfflinePaymentProvider } from '@/services/payment/OfflinePaymentProvider';
import { readOfflinePaymentConfig } from '@/services/payment/OfflinePaymentConfig';
import type { OfflineReturnClient } from '@/services/payment/OfflinePaymentReturn';
import { assertOfflineProviderRequest, validateOfflinePaymentTicket, type OfflinePaymentTicket,
  type OfflineProviderRequest } from '@/services/payment/OfflinePaymentProviderContract';
import { ApiException, ValidateException } from '@/utils/errors';
import { assertUnpaidOfflineOrder, lockOfflineOrderPayment, lockOfflinePaymentQuery, prepareOfflinePaymentTransaction } from './OfflineOrderPaymentContext';
import { readOfflinePaymentSelectionTx, selectOfflineOrderExternalPaymentTx } from './OfflineOrderPaymentSelectionService';
import { offlineAmountCents, offlinePayableCents } from './OfflineOrderQuoteService';

type Input = { uid: number; orderNo: string; provider: 'wechat' | 'alipay'; clientIp: string; returnClient?: OfflineReturnClient };
export type OfflineDispatchResult = { status: 'READY'; ticket: OfflinePaymentTicket; displayUntil: number; replayed: boolean }
  | { status: 'RECOVERY_REQUIRED' | 'PAID'; replayed: boolean };
const hash = (selectionKey: string, payload: string) => createHash('sha256').update(`${selectionKey}\n${payload}`).digest('hex');

/** Always recovery/order -> order/account -> dispatch, same as collection. */
async function lockState(tx: DbClient, input: Input, completing = false) {
  await prepareOfflinePaymentTransaction(tx);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-reconciliation:${input.provider}:${input.orderNo}`},0))`);
  const [recovery] = await tx.select().from(paymentReconciliationCase).where(and(
    eq(paymentReconciliationCase.provider, input.provider), eq(paymentReconciliationCase.orderNo, input.orderNo))).for('update');
  const context = await (completing ? lockOfflinePaymentQuery : lockOfflineOrderPayment)(tx, input);
  const selection = await readOfflinePaymentSelectionTx(tx, context);
  if (selection && selection.rail !== input.provider) throw new ApiException('线下消费已选定其他支付路径，请先核对原支付结果', 409);
  const [dispatch] = selection ? await tx.select().from(offlineOrderPaymentDispatch)
    .where(eq(offlineOrderPaymentDispatch.selectionKey, selection.selectionKey)).for('update') : [];
  const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  validateOfflineDispatchLink({ selection, recovery, dispatch, now: clock.now });
  return { context, selection, recovery, dispatch, now: clock.now };
}
// SELECT destructuring may be empty at runtime, even without noUncheckedIndexedAccess.
type State = Omit<Awaited<ReturnType<typeof lockState>>, 'recovery'> & {
  recovery: typeof paymentReconciliationCase.$inferSelect | undefined;
};
/** Pure check shared with the read-only cashier snapshot; never initiates I/O. */
export function validateOfflineDispatchLink({ selection, recovery, dispatch, now }: Pick<State, 'selection' | 'recovery' | 'dispatch' | 'now'>) {
  if (dispatch && (!recovery || recovery.id !== dispatch.caseId || !selection || recovery.profile !== selection.profile
    || recovery.orderDomain !== 'offline_order' || recovery.currency !== 'CNY'
    || recovery.expectedAmountCents !== Number(offlineAmountCents(selection.payPrice))
    || recovery.initiatedTime !== dispatch.createdAt || dispatch.createdAt !== selection.createdAt || dispatch.createdAt > now)) {
    throw new ValidateException('线下支付发起凭据不一致');
  }
}
export function readOfflineDispatchState(state: State, replayed: boolean): OfflineDispatchResult {
  const { context, selection, recovery, dispatch, now } = state;
  if (recovery?.status === 'CONFLICT' || recovery?.status === 'CLOSED') return { status: 'RECOVERY_REQUIRED', replayed };
  if (selection && dispatch && recovery && context.order.paid === 1 && ['SETTLED', 'CONFIRMED'].includes(recovery.status)
    && context.order.payType === (selection.rail === 'wechat' ? 'weixin' : selection.rail)
    && context.order.tradeNo !== '' && context.order.tradeNo === recovery.providerTransactionId) return { status: 'PAID', replayed };
  if (!selection || !dispatch || !recovery || context.order.paid !== 0 || context.order.isDel !== 0
    || context.account.status !== 1 || context.account.isDel !== 0 || context.account.deleteTime !== null
    || recovery.providerTransactionId !== '' || recovery.callbackEventId !== null
    || !['OPEN', 'WAITING', 'QUEUED', 'QUERYING'].includes(recovery.status)
    || dispatch.state !== 'READY' || dispatch.displayUntil <= now) return { status: 'RECOVERY_REQUIRED', replayed };
  if (selection.rail === 'yue' || selection.profile === '' || selection.transactionType === '') throw new ValidateException('线下支付路径异常');
  if (dispatch.displayUntil !== dispatch.createdAt + 300 || dispatch.finishedAt < dispatch.createdAt
    || hash(selection.selectionKey, dispatch.ticketPayload) !== dispatch.ticketHash) throw new ValidateException('线下支付入口摘要不一致');
  const ticket: unknown = JSON.parse(dispatch.ticketPayload);
  validateOfflinePaymentTicket(ticket, { provider: selection.rail, profile: selection.profile,
    appId: selection.appId, merchantId: selection.merchantId }, selection.transactionType,
  { orderNo: selection.orderNo, amountCents: Number(offlineAmountCents(selection.payPrice)) });
  return { status: 'READY', ticket, displayUntil: dispatch.displayUntil, replayed };
}

/** Unreleased payment core. Trusted authenticated UID and edge-derived client IP;
 * no client amount, merchant, payer, callback URL or expiration override.
 * ISSUING/UNKNOWN are never reclaimed or redispatched automatically.
 */
export async function dispatchOfflineOrderPayment(container: Container, env: Env, input: Input): Promise<OfflineDispatchResult> {
  input = { ...input };
  if (!['wechat', 'alipay'].includes(input.provider) || !Number.isSafeInteger(input.uid) || input.uid <= 0
    || !/^xx[0-9a-f]{30}$/.test(input.orderNo) || (input.returnClient !== undefined && !['pc','h5'].includes(input.returnClient))) throw new ValidateException('线下支付请求无效');
  const first = await withTx(container, async tx => {
    const state = await lockState(tx, input);
    if (state.selection || state.recovery) return { existing: readOfflineDispatchState(state, true) };
    assertUnpaidOfflineOrder(state.context.order);
    offlinePayableCents(state.context.admission.payPrice);
    return { profile: input.provider === 'alipay' ? 'alipay' as const
      : state.context.admission.channel === 'routine' ? 'routine' as const : 'wechat' as const };
  });
  if (first.existing) return first.existing;
  if (!first.profile) throw Error('Offline dispatch preflight missing');
  // Current global config (not a stale KV switch) and crypto are read once,
  // outside the reservation transaction; discovery is not an authorization.
  const provider = await prepareOfflinePaymentProvider(container, env, input.provider, first.profile,
    await readOfflinePaymentConfig(container.db),input.returnClient);
  const reserved = await withTx(container, async tx => {
    const state = await lockState(tx, input);
    if (state.selection || state.recovery) return { existing: readOfflineDispatchState(state, true) };
    const { selection } = await selectOfflineOrderExternalPaymentTx(tx, { ...input, identity: provider.identity });
    const transactionType = selection.transactionType;
    if (transactionType !== 'h5' && transactionType !== 'jsapi' && transactionType !== 'wap') throw new ValidateException('线下支付交易类型无效');
    const request: OfflineProviderRequest = { orderNo: selection.orderNo, amountCents: Number(offlineAmountCents(selection.payPrice)),
      transactionType, payerId: selection.payerId, clientIp: input.clientIp };
    assertOfflineProviderRequest(request);
    const recovery = await registerPaymentReconciliationTx(tx, { provider: input.provider, profile: first.profile,
      orderDomain: 'offline_order', orderNo: selection.orderNo, expectedAmountCents: request.amountCents,
      initiated: true, now: selection.createdAt });
    const [attempt] = await tx.insert(offlineOrderPaymentDispatch).values({ selectionKey: selection.selectionKey,
      attemptKey: crypto.randomUUID(), caseId: recovery.id, state: 'ISSUING', createdAt: selection.createdAt }).returning();
    if (!attempt) throw Error('Offline dispatch insert failed');
    return { request, attempt };
  });
  if (reserved.existing) return reserved.existing;
  if (!reserved.request || !reserved.attempt) throw Error('Offline dispatch reservation missing');
  let ticketPayload = '';
  try {
    const ticket = await provider.initiate(reserved.request);
    validateOfflinePaymentTicket(ticket, provider.identity, reserved.request.transactionType, reserved.request);
    ticketPayload = JSON.stringify(ticket);
  } catch {
    // Never persist raw upstream error bodies, URLs, credentials or payer data.
    // Network, provider rejection and unverifiable responses all need recovery.
  }
  return withTx(container, async tx => {
    const state = await lockState(tx, input, true);
    if (!state.dispatch || state.dispatch.attemptKey !== reserved.attempt.attemptKey || state.dispatch.state !== 'ISSUING') {
      throw new ValidateException('线下支付发起完成标识失效');
    }
    await tx.update(offlineOrderPaymentDispatch).set({ state: ticketPayload ? 'READY' : 'UNKNOWN', ticketPayload,
      ticketHash: ticketPayload ? hash(state.dispatch.selectionKey, ticketPayload) : '', finishedAt: state.now,
      displayUntil: ticketPayload ? state.dispatch.createdAt + 300 : 0 })
      .where(eq(offlineOrderPaymentDispatch.selectionKey, state.dispatch.selectionKey));
    return readOfflineDispatchState(await lockState(tx, input, true), false);
  });
}
