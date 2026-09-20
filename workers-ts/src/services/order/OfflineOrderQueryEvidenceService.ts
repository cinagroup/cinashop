import { and, asc, eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { paymentCallbackEvent, paymentReconciliationCase } from '@/models/schema';
import { offlineOrderQueryEvidence } from '@/models/candidates/offline_order_query_evidence';
import { registerPaymentReconciliationTx } from '@/services/payment/PaymentReconciliationRegistry';
import type { PaymentProviderQueryRequest, PaymentProviderQueryResult } from '@/services/payment/PaymentProviderQuery';
import { ValidateException } from '@/utils/errors';
import { prepareOfflinePaymentTransaction } from './OfflineOrderPaymentContext';
import { lockOfflineCollectionContext, lockOfflineCollectionRecovery, selectionForOfflineCollection, matchesOfflineCollection,
  type OfflineCollectionSelection } from './OfflineOrderCollectionContext';

type Evidence = typeof offlineOrderQueryEvidence.$inferSelect;
export interface OfflineQueryReference { queryId: string; replayKey: string }
export interface OfflineQueryCaseReference { caseId: number; replayKey: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function digest(value: unknown) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function canonical(e: Pick<Evidence, 'selectionKey' | 'identitySource' | 'provider' | 'profile' | 'orderNo' | 'transactionId' | 'tradeState' | 'amountCents' | 'currency' | 'providerEventTime'>) {
  return { version: 'offline-query-v1', selectionKey: e.selectionKey, identitySource: e.identitySource, provider: e.provider,
    profile: e.profile, orderNo: e.orderNo, transactionId: e.transactionId, tradeState: e.tradeState,
    amountCents: e.amountCents, currency: e.currency, providerEventTime: e.providerEventTime };
}
const identityHash = (e: Pick<Evidence, 'evidenceHash' | 'identitySource'>, p: OfflineCollectionSelection) => digest({
  version: 'offline-query-identity-v1', evidenceHash: e.evidenceHash, identitySource: e.identitySource,
  selectionKey: p.selectionKey, provider: p.rail, profile: p.profile, transactionType: p.transactionType,
  appId: p.appId, merchantId: p.merchantId, payerId: p.payerId });

export async function validateOfflineQueryEvidence(e: Evidence, selection: OfflineCollectionSelection) {
  matchesOfflineCollection(selection, e);
  if (e.version !== 'offline-query-v1' || !UUID.test(e.id) || !UUID.test(e.replayKey) || e.selectionKey !== selection.selectionKey
    || e.currency !== 'CNY' || !Number.isSafeInteger(e.amountCents) || e.amountCents <= 0
    || !Number.isSafeInteger(e.providerEventTime) || e.providerEventTime <= 0 || e.createdAt < selection.createdAt
    || !/^[A-Za-z0-9_-]{1,50}$/.test(e.transactionId)
    || (e.provider === 'wechat' ? e.identitySource !== 'wechat-signed-query' || e.tradeState !== 'SUCCESS'
      : e.identitySource !== 'alipay-direct-request-scope' || !['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(e.tradeState))
    || e.evidenceHash !== await digest(canonical(e)) || e.identityHash !== await identityHash(e, selection)) {
    throw new ValidateException('线下消费查单证据摘要或原身份不一致');
  }
}

/** TRUSTED QUERY ADAPTER ONLY. This is an immutable attestation of verification,
 * not a signature verifier, MAC, callback, or customer DTO. No raw body or extra
 * app/merchant/payer plaintext is retained. Commit before attempting settlement.
 */
export async function persistOfflineQueryEvidence(container: Container, input: {
  reference: OfflineQueryCaseReference; request: PaymentProviderQueryRequest;
  queried: { selectionKey: string; result: PaymentProviderQueryResult };
}) {
  const { reference, request, queried } = structuredClone(input), result = queried.result, identity = result.identityEvidence;
  if (!Number.isSafeInteger(reference.caseId) || reference.caseId <= 0 || !UUID.test(reference.replayKey)
    || request.orderDomain !== 'offline_order' || !UUID.test(queried.selectionKey) || !/^xx[0-9a-f]{30}$/.test(request.orderNo)
    || result.status !== 'SUCCESS' || result.errorCode !== '' || !identity || result.orderNo !== request.orderNo
    || result.currency !== 'CNY' || request.currency !== 'CNY' || result.amountCents !== request.expectedAmountCents
    || !Number.isSafeInteger(result.amountCents) || result.amountCents <= 0 || result.amountCents > 2_147_483_647
    || !Number.isSafeInteger(result.providerEventTime) || result.providerEventTime <= 0 || result.providerEventTime > 2_147_483_647
    || typeof result.transactionId !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(result.transactionId)
    || (request.provider === 'wechat'
      ? !['wechat', 'routine'].includes(request.profile) || identity.source !== 'wechat-signed-query' || result.providerTradeState !== 'SUCCESS'
      : request.provider !== 'alipay' || request.profile !== 'alipay' || identity.source !== 'alipay-direct-request-scope'
        || !['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(result.providerTradeState))) {
    throw new ValidateException('线下消费查单不是可信成功证据');
  }
  if (request.profile === 'app') throw new ValidateException('线下查单渠道不支持');
  const evidence = { ...canonical({ selectionKey: queried.selectionKey, identitySource: identity.source,
    provider: request.provider, profile: request.profile, orderNo: request.orderNo, transactionId: result.transactionId,
    tradeState: result.providerTradeState, amountCents: result.amountCents, currency: 'CNY', providerEventTime: result.providerEventTime }) };
  return withTx(container, async tx => {
    await prepareOfflinePaymentTransaction(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${request.provider}:${result.transactionId}`},0))`);
    // Validate the opaque case before the registration can create any new case.
    const [hint] = await tx.select().from(paymentReconciliationCase).where(eq(paymentReconciliationCase.id, reference.caseId));
    if (!hint || hint.replayKey !== reference.replayKey || hint.provider !== request.provider || hint.orderNo !== request.orderNo) {
      throw new ValidateException('线下查单恢复引用不一致');
    }
    const [conflict] = await tx.execute<{ present: boolean }>(sql`SELECT EXISTS(SELECT 1 FROM ${paymentCallbackEvent}
      WHERE provider=${request.provider} AND transaction_id=${result.transactionId}
        AND (order_no<>${request.orderNo} OR amount_cents<>${result.amountCents} OR currency<>'CNY')) AS present`);
    const recovery = await registerPaymentReconciliationTx(tx, { provider: request.provider, profile: request.profile,
      orderDomain: 'offline_order', orderNo: request.orderNo, expectedAmountCents: result.amountCents,
      transactionId: result.transactionId, providerEventTime: result.providerEventTime, providerStatus: 'SUCCESS', terminalConflict: conflict.present });
    if (recovery.id !== reference.caseId || recovery.replayKey !== reference.replayKey) throw new ValidateException('线下查单恢复引用已变化');
    const selection = await selectionForOfflineCollection(tx, evidence);
    if (selection.selectionKey !== queried.selectionKey || identity.appId !== selection.appId || identity.merchantId !== selection.merchantId
      || (selection.payerId !== '' && (identity.source !== 'wechat-signed-query' || identity.payerId !== selection.payerId))) {
      throw new ValidateException('线下消费查单原支付身份不一致');
    }
    await lockOfflineCollectionContext(tx, evidence, selection);
    const [clock] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM statement_timestamp()))::integer AS now`);
    const evidenceHash = await digest(evidence), checkedIdentityHash = await identityHash({ evidenceHash, identitySource: identity.source }, selection);
    await tx.insert(offlineOrderQueryEvidence).values({ ...evidence, id: crypto.randomUUID(), replayKey: crypto.randomUUID(),
      caseId: reference.caseId, evidenceHash, identityHash: checkedIdentityHash, createdAt: clock.now })
      .onConflictDoNothing({ target: offlineOrderQueryEvidence.evidenceHash });
    const [stored] = await tx.select().from(offlineOrderQueryEvidence).where(eq(offlineOrderQueryEvidence.evidenceHash, evidenceHash));
    if (!stored || stored.caseId !== reference.caseId) throw new ValidateException('线下消费查单证据未持久化');
    await validateOfflineQueryEvidence(stored, selection);
    return { queryId: stored.id, replayKey: stored.replayKey, terminalConflict: recovery.status === 'CONFLICT', closed: recovery.status === 'CLOSED' };
  });
}

export async function lockOfflineQueryEvidence(tx: DbClient, input: OfflineQueryReference) {
  if (!UUID.test(input.queryId) || !UUID.test(input.replayKey)) throw new ValidateException('线下消费查单引用无效');
  await prepareOfflinePaymentTransaction(tx);
  const [hint] = await tx.select().from(offlineOrderQueryEvidence).where(eq(offlineOrderQueryEvidence.id, input.queryId));
  if (!hint || hint.replayKey !== input.replayKey) throw new ValidateException('线下消费查单引用不存在');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${hint.provider}:${hint.transactionId}`},0))`);
  const [evidence] = await tx.select().from(offlineOrderQueryEvidence).where(eq(offlineOrderQueryEvidence.id, input.queryId));
  if (!evidence || evidence.replayKey !== input.replayKey) throw new ValidateException('线下消费查单引用已变化');
  const recovery = await lockOfflineCollectionRecovery(tx, evidence);
  if (recovery.id !== evidence.caseId) throw new ValidateException('线下消费查单恢复关联不一致');
  const selection = await selectionForOfflineCollection(tx, evidence);
  await validateOfflineQueryEvidence(evidence, selection);
  return { evidence, selection };
}

/** Read-only hint; settlement independently locks/rechecks the original case and evidence. */
export async function findOfflineQueryEvidence(container: Container, reference: OfflineQueryCaseReference) {
  return withTx(container, async tx => {
    await prepareOfflinePaymentTransaction(tx);
    const [recovery] = await tx.select().from(paymentReconciliationCase).where(and(
      eq(paymentReconciliationCase.id, reference.caseId), eq(paymentReconciliationCase.replayKey, reference.replayKey)));
    if (!recovery) throw new ValidateException('线下查单恢复引用不存在');
    const [evidence] = await tx.select().from(offlineOrderQueryEvidence).where(eq(offlineOrderQueryEvidence.caseId, reference.caseId))
      .orderBy(asc(offlineOrderQueryEvidence.createdAt), asc(offlineOrderQueryEvidence.id)).limit(1);
    return evidence;
  });
}
