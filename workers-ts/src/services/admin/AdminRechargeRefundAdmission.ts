/** Admin admission is SQL-only. An admitted hold is committed before dispatch. */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { user, userBill } from '@/models/schema';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { captureAdminRechargeRefundActor, authorizeAdminRechargeRefundTx, type AdminRechargeRefundActor } from './AdminRechargeRefundActor';
import { rechargeRefundIdentity, RECHARGE_REFUND_VERSION, type RechargeRefundIdentity } from '@/services/payment/RechargeRefundRequest';
import { rechargeRefundCents, rechargeRefundDecimal, rechargeRefundId, rechargeRefundIntent } from '@/services/payment/RechargeRefundMoney';
import { readRechargeRefundSourceTx, assertRechargeRefundSourceTx, type RechargeRefundLockedSource } from '@/services/payment/RechargeRefundSource';
import { assertRechargeRefundRequestReplay, insertRechargeRefundOperationTx, lockRechargeRefundKeyTx,
  readRechargeRefundOperationTx, type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { readRechargeRoutineRefundAccountPolicyTx, type RechargeRoutineRefundAccountRuntime } from '@/services/payment/RechargeRoutineRefundAccount';
import type { RechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import { routineEvidenceHmac } from '@/services/payment/RoutineProviderObservation';

type Signing = Pick<Env, 'APP_KEY'>;
const unavailable = (): never => { throw new ServiceUnavailableException('充值退款预留或回执暂不可核对，请保留原请求'); };
const unchanged = (): never => { throw new HttpApiException('充值订单或钱包已变化，请刷新报价重新确认', 409, 409); };
const hexEqual = (a: string, b: string) => a.length === 64 && b.length === 64
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

function quoteFingerprint(env: Signing, adminId: number, source: RechargeRefundLockedSource, approval: RechargeRoutineRefundAccountJournal, recoverGift: boolean) {
  return routineEvidenceHmac(env, 'admin-recharge-refund-quote-v1', {
    version: RECHARGE_REFUND_VERSION, adminId, scope: source.scope, basis: source.basis,
    versions: source.versions, sourceSignature: source.signature, approvalRecordId: approval.record_id,
    approvalSignature: approval.signature, recoverGift,
  });
}

/** Both choices share one fresh locked source. HTTP receives no payment proof,
 * payer, merchant credentials, database OIDs or administrator password hash. */
export async function quoteAdminRechargeRefund(container: Container, env: RechargeRoutineRefundAccountRuntime,
  input: AdminRechargeRefundActor, rechargeId: number) {
  const actor = captureAdminRechargeRefundActor(input), id = rechargeRefundId(rechargeId);
  return withTx(container, async tx => {
    await authorizeAdminRechargeRefundTx(tx, actor);
    const source = await readRechargeRefundSourceTx(tx, env, 'admin', id);
    const approval = await readRechargeRoutineRefundAccountPolicyTx(tx, env, { appId: source.appId, merchantId: source.merchantId }, 'refund_request', 'admin');
    const options = [false, true].map(recoverGift => {
      const intent = rechargeRefundIntent(source.basis, recoverGift);
      return Object.freeze({ recoverGift, sufficient: intent.sufficient,
        principal: source.basis.price, gift: source.basis.givePrice,
        // An insufficient requested debit may exceed wallet column capacity.
        walletDebitCents: intent.walletDebitCents, availableBalance: source.basis.nowMoney,
        postBalance: rechargeRefundDecimal(intent.walletAfterCents),
        quoteFingerprint: quoteFingerprint(env, actor.id, source, approval, recoverGift) });
    });
    return { version: RECHARGE_REFUND_VERSION, rechargeId: id, orderNo: source.basis.orderId,
      buyerUid: source.basis.uid, options };
  });
}

async function clockTx(tx: DbClient) {
  const [row] = await tx.execute<{ now: string }>(sql`SELECT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
  const now = Number(row?.now);
  if (!Number.isSafeInteger(now) || now <= 0 || now > 2_147_483_647) return unavailable();
  return now;
}
function emptyOperation(identity: RechargeRefundIdentity, operationId: string, now: number) {
  return { operation_id: operationId, admin_id: identity.adminId, request_key: identity.requestKey,
    request_hash: identity.requestHash, recharge_id: identity.request.rechargeId,
    buyer_uid: null, order_no: null, provider: null, payment_profile: null, transaction_id: null,
    payment_source: null, payment_signature: null, principal_cents: null, gift_cents: null,
    reclaim_gift: null, debit_cents: null, wallet_before: null, wallet_after: null,
    admission: 'abandoned', out_refund_no: null, created_at: now };
}

async function replayTx(tx: DbClient, env: Signing, identity: RechargeRefundIdentity) {
  await lockRechargeRefundKeyTx(tx, identity.adminId, identity.requestKey);
  const row = await readRechargeRefundOperationTx(tx, env, identity.adminId, identity.requestKey, 'write');
  if (row) assertRechargeRefundRequestReplay(row, identity.adminId, identity.request.rechargeId, identity.requestKey, identity.requestHash);
  return row;
}

/** A lost response can be fenced using the original body/key even when its
 * quote/order is no longer available. An earlier committed admission wins;
 * abandonment never relabels it or releases an existing provider operation. */
export async function abandonAdminRechargeRefund(container: Container, env: Signing,
  input: AdminRechargeRefundActor, requestKey: unknown, body: unknown) {
  const actor = captureAdminRechargeRefundActor(input), identity = await rechargeRefundIdentity(actor.id, requestKey, body);
  return withTx(container, async tx => {
    await authorizeAdminRechargeRefundTx(tx, actor);
    const prior = await replayTx(tx, env, identity);
    return prior ?? insertRechargeRefundOperationTx(tx, env, emptyOperation(identity, randomUUID(), await clockTx(tx)));
  });
}

export interface AdminRechargeRefundAdmission { readonly operation: RechargeRefundRecord; readonly replayed: boolean }

/** No provider is accepted here. Reserve available balance and write the
 * exact hold bill, immutable operation and initial state in ONE transaction.
 * Insufficient funds persist a rejection without wallet/bill/state/POST work.
 * Repeating its key never turns that rejection into a later successful debit. */
export async function admitAdminRechargeRefund(container: Container, env: RechargeRoutineRefundAccountRuntime,
  input: AdminRechargeRefundActor, requestKey: unknown, body: unknown): Promise<AdminRechargeRefundAdmission> {
  if (!Object.hasOwn(container.db, '$client')) throw new ServiceUnavailableException('充值退款受理须使用独立根数据库会话');
  const actor = captureAdminRechargeRefundActor(input), identity = await rechargeRefundIdentity(actor.id, requestKey, body);
  return withTx(container, async tx => {
    await authorizeAdminRechargeRefundTx(tx, actor);
    const prior = await replayTx(tx, env, identity);
    if (prior) return { operation: prior, replayed: true };
    const source = assertRechargeRefundSourceTx(tx, await readRechargeRefundSourceTx(tx, env, 'admin', identity.request.rechargeId));
    const approval = await readRechargeRoutineRefundAccountPolicyTx(tx, env, { appId: source.appId, merchantId: source.merchantId }, 'refund_request', 'admin');
    if (!hexEqual(identity.request.quoteFingerprint, quoteFingerprint(env, actor.id, source, approval, identity.request.recoverGift))) return unchanged();
    const intent = rechargeRefundIntent(source.basis, identity.request.recoverGift), now = await clockTx(tx), operationId = randomUUID();
    const active = await tx.execute(sql`SELECT operation_id FROM public.recharge_refund_state
      WHERE recharge_id=${source.basis.id} AND wallet_state<>'released' ORDER BY operation_id LIMIT 2 FOR UPDATE NOWAIT`);
    if (active.length) throw new ValidateException('该充值已有预留或已成功退款，请查询原操作');
    const record = { ...emptyOperation(identity, operationId, now), buyer_uid: source.basis.uid, order_no: source.basis.orderId,
      principal_cents: intent.principalCents, gift_cents: intent.giftCents, reclaim_gift: intent.recoverGift,
      debit_cents: intent.walletDebitCents, wallet_before: intent.walletBeforeCents, wallet_after: intent.walletAfterCents };
    if (!intent.sufficient) {
      return { operation: await insertRechargeRefundOperationTx(tx, env, { ...record, admission: 'rejected_insufficient' }), replayed: false };
    }
    const walletDebit = rechargeRefundDecimal(intent.walletDebitCents), balance = rechargeRefundDecimal(intent.walletAfterCents);
    const updated = await tx.update(user).set({ nowMoney: balance })
      .where(and(eq(user.uid, source.basis.uid), eq(user.nowMoney, source.basis.nowMoney), eq(user.isDel, 0)))
      .returning({ uid: user.uid, nowMoney: user.nowMoney });
    if (updated.length !== 1 || rechargeRefundCents(updated[0].nowMoney, true) !== intent.walletAfterCents) return unavailable();
    const bills = await tx.insert(userBill).values({ uid: source.basis.uid, linkId: source.basis.orderId,
      eventKey: `recharge_refund_hold:${operationId}`, pm: 0, category: 'now_money', type: 'recharge_refund',
      title: '充值退款余额预留', number: walletDebit, balance, status: 1, addTime: now,
      mark: intent.recoverGift ? '原路退本金，预留本金及原赠送额' : '原路退本金，保留原赠送额' }).returning({ id: userBill.id });
    if (bills.length !== 1 || !Number.isSafeInteger(bills[0].id) || bills[0].id < 1) return unavailable();
    const operation = await insertRechargeRefundOperationTx(tx, env, { ...record,
      provider: source.provider, payment_profile: source.profile, transaction_id: source.transactionId,
      payment_source: { original: source.source, holdBillId: bills[0].id, refundApproval: { recordId: approval.record_id, signature: approval.signature } }, payment_signature: source.signature,
      admission: 'reserved', out_refund_no: 'CNSCR' + operationId.replaceAll('-', '') });
    const states = await tx.execute(sql`INSERT INTO public.recharge_refund_state
      (operation_id,recharge_id,admission,status,wallet_state,version,lease_id,lease_until,provider_refund_id,
       attempt_count,next_query_at,last_result_id,created_at,updated_at)
      VALUES (${operationId}::uuid,${source.basis.id},'reserved','RESERVED','held',0,NULL,NULL,NULL,0,NULL,NULL,${now},${now}) RETURNING operation_id`);
    if (states.length !== 1 || states[0].operation_id !== operationId) return unavailable();
    return { operation, replayed: false };
  });
}
