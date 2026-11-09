import { membershipSubscriptionTransientSqlState } from './RoutineSubscriptionMembershipEvidenceCodec';
import { parseRoutineSubscriptionAttemptForActor as parseAttempt, parseRoutineSubscriptionResult as parseReceipt,
  type RoutineSubscriptionAttemptPayload as AttemptPayload, type RoutineSubscriptionAttempt as Attempt,
  type RoutineSubscriptionResult as Receipt } from './RoutineSubscriptionDispatchEvidenceCodec';
export { parseRoutineSubscriptionAttempt, parseRoutineSubscriptionAttemptForActor, parseRoutineSubscriptionResult,
  validateRoutineSubscriptionAttemptChain } from './RoutineSubscriptionDispatchEvidenceCodec';
export type { RoutineSubscriptionAttempt, RoutineSubscriptionAttemptPayload, RoutineSubscriptionResult,
  RoutineSubscriptionHistoricalActor, RoutineSubscriptionAttemptChain, RoutineSubscriptionAttemptChainIdentity } from './RoutineSubscriptionDispatchEvidenceCodec';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { orderNotificationDelivery } from '@/models/schema';
import { assertRoutineSubscriptionDeliveryReadTx, assertRoutineSubscriptionDeliveryReadyTx,
  inspectRoutineSubscriptionDeliveryCatalog } from '@/migrations/routineSubscriptionDelivery';
import { assertRoutineSubscriptionHistoricalAccountTx, captureRoutineSubscriptionEnv, freezeSubscription,
  routineSubscriptionClockTx, routineSubscriptionScopeTx,
  routineSubscriptionUnavailable, subscriptionInteger,
  subscriptionMac, subscriptionObject, subscriptionSame, subscriptionUuid } from './RoutineSubscriptionAccount';
import { prepareRoutineSubscriptionDeliveryNotice, prepareRoutineSubscriptionDeliveryNoticeTx,
  assertRoutineSubscriptionDeliveryNoticeTx } from './RoutineSubscriptionDeliveryNotice';
import { getRoutineSubscriptionAccessToken } from './RoutineSubscriptionAccessToken';
import { postRoutineSubscription, assertRoutineSubscriptionProviderResult } from './RoutineSubscriptionProvider';
import { routineSubscriptionNoticeKey, routineSubscriptionRechargeRefundKey, routineSubscriptionRechargeKey, routineSubscriptionMembershipKey } from './RoutineSubscriptionNoticeKinds';

type Delivery = typeof orderNotificationDelivery.$inferSelect & { subjectDomain?: 'membership'|'recharge'; subjectId?: number };
export interface RoutineSubscriptionClaim { id: number; eventKey: string; leaseToken: string }
const sendSlot = Symbol('routine.subscription.send-authority.v1');
export interface RoutineSubscriptionSendAuthority { readonly [sendSlot]: true }
const authorities = new WeakMap<RoutineSubscriptionSendAuthority, {
  attempt: Attempt; token: string; expiresAt: number; used: boolean;
}>();
class PriorUnknown extends Error {}
const invalidToken = (code: number) => [40001, 40014, 42001].includes(code);
const retryable = (code: number) => invalidToken(code) || [-1, 45009, 45011, 45028].includes(code);
function claim(value: RoutineSubscriptionClaim): Readonly<RoutineSubscriptionClaim> {
  const r = subscriptionObject(value, ['id', 'eventKey', 'leaseToken']);
  if (!subscriptionInteger(r.id) || typeof r.eventKey !== 'string' || r.eventKey.length > 128
    || !routineSubscriptionNoticeKey(r.eventKey) || !subscriptionUuid(r.leaseToken))
    return routineSubscriptionUnavailable();
  return Object.freeze({ id: r.id, eventKey: r.eventKey, leaseToken: r.leaseToken });
}
export function captureRoutineSubscriptionDeliveryEnv(env: Env): Env {
  const captured = captureRoutineSubscriptionEnv(env), connectionString = env.HYPERDRIVE?.connectionString;
  return Object.freeze({ ...captured, HYPERDRIVE: connectionString === undefined ? undefined : Object.freeze({ connectionString }),
    UPSTASH_REDIS_URL: env.UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN: env.UPSTASH_REDIS_TOKEN }) as Env;
}
function root(container: Container) {
  if (!Object.hasOwn(container.db, '$client') || !container.db.$client) return routineSubscriptionUnavailable();
}
/** Whole absence preserves the pre-commissioning path. Any present object must
 * pass the complete actual-App protocol before the ordinary Queue claim. */
export async function routineSubscriptionDeliveryCommissioned(container: Container): Promise<boolean> {
  root(container);
  return withTx(container, async tx => {
    const catalog = await inspectRoutineSubscriptionDeliveryCatalog(tx);
    if (!catalog.present) return false;
    if (!await assertRoutineSubscriptionDeliveryReadTx(tx)) return routineSubscriptionUnavailable();
    return true;
  });
}
function identity(row: Delivery) {
  return { id: row.id, outboxId: row.outboxId, eventKey: row.eventKey, orderId: row.orderId,
    withdrawalId: row.withdrawalId, userId: row.userId, noticeMark: row.noticeMark, channel: row.channel,
    target: row.target, templateCode: row.templateCode, payload: row.payload, addTime: row.addTime,
    ...((routineSubscriptionMembershipKey(row.eventKey)||routineSubscriptionRechargeKey(row.eventKey)||routineSubscriptionRechargeRefundKey(row.eventKey)) ? { subjectDomain: row.subjectDomain, subjectId: row.subjectId } : {}) };
}
const sourceKey = (env: Env, c: Readonly<RoutineSubscriptionClaim>) => subscriptionMac(env, 'delivery-source-key', [c.eventKey, 'wechat_routine']);
const intentDigest = (env: Env, row: Delivery) => subscriptionMac(env, 'delivery-intent', identity(row));
async function claimed(tx: DbClient, c: Readonly<RoutineSubscriptionClaim>) {
  const [r] = await tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, c.id)).limit(1).for('update', { noWait: true });
  const now = await routineSubscriptionClockTx(tx);
  if (!r || r.eventKey !== c.eventKey || r.channel !== 'wechat_routine' || r.status !== 'PROCESSING'
    || r.leaseToken !== c.leaseToken || r.leaseUntil <= now || r.leaseUntil > now + 180 || r.withdrawalId !== null
    || ((routineSubscriptionMembershipKey(r.eventKey)||routineSubscriptionRechargeKey(r.eventKey)||routineSubscriptionRechargeRefundKey(r.eventKey)) ? r.orderId !== null : !subscriptionInteger(r.orderId)))
    return routineSubscriptionUnavailable();
  if (routineSubscriptionMembershipKey(r.eventKey)||routineSubscriptionRechargeKey(r.eventKey)||routineSubscriptionRechargeRefundKey(r.eventKey)) {
    const domain:'recharge'|'membership'=routineSubscriptionRechargeKey(r.eventKey)||routineSubscriptionRechargeRefundKey(r.eventKey)?'recharge':'membership';
    const rows = await tx.execute<{ subjectDomain: string; subjectId: number }>(sql`SELECT subject_domain AS "subjectDomain",subject_id AS "subjectId"
      FROM public.order_notification_delivery WHERE id=${r.id} LIMIT 2`), subject = rows[0];
    if (rows.length !== 1 || subject.subjectDomain !== domain || !subscriptionInteger(subject.subjectId)
      || (!routineSubscriptionRechargeRefundKey(r.eventKey)&&r.eventKey !== `${domain}.pay.success.notice:${subject.subjectId}`)) return routineSubscriptionUnavailable();
    return { ...r, subjectDomain: domain, subjectId: subject.subjectId };
  }
  return r;
}
async function history(tx: DbClient, env: Env, c: Readonly<RoutineSubscriptionClaim>) {
  if (!await assertRoutineSubscriptionDeliveryReadTx(tx)) return routineSubscriptionUnavailable();
  const scope = await routineSubscriptionScopeTx(tx);
  const [who] = await tx.execute<{ role: string; roleOid: string }>(sql`SELECT current_user AS role,
    (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS "roleOid"`);
  if (!who) return routineSubscriptionUnavailable();
  const actor = { role: who.role, roleOid: who.roleOid }, key = sourceKey(env, c);
  const rows = await tx.execute(sql`SELECT * FROM public.routine_subscribe_attempt WHERE delivery_id=${c.id} OR source_key=${key} ORDER BY attempt_no LIMIT 6`);
  if (rows.length > 5 || Buffer.byteLength(JSON.stringify(rows), 'utf8') > 327680) return routineSubscriptionUnavailable();
  const attempts = Array.from(rows, r => parseAttempt(env, r, scope, actor));
  const results: Receipt[] = [];
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    if (a.delivery_id !== c.id || a.source_key !== key || a.attempt_no !== i + 1 || a.payload.claim.eventKey !== c.eventKey
      || a.payload.previousAttemptId !== (attempts[i - 1]?.attempt_id ?? '')
      || i > 0 && (!subscriptionSame(a.payload.request, attempts[0].payload.request) || a.payload.intentDigest !== attempts[0].payload.intentDigest))
      return routineSubscriptionUnavailable();
    await assertRoutineSubscriptionHistoricalAccountTx(tx, env, a.payload.policy, a.created_at);
    const saved = await tx.execute(sql`SELECT * FROM public.routine_subscribe_result WHERE attempt_id=${a.attempt_id}::uuid LIMIT 2`);
    if (saved.length > 1 || Buffer.byteLength(JSON.stringify(saved), 'utf8') > 32768) return routineSubscriptionUnavailable();
    if (!saved.length) throw new PriorUnknown();
    const result = parseReceipt(env, saved[0], a, scope); results.push(result);
    if (i < attempts.length - 1 && (!retryable(result.payload.result.code) || result.payload.result.code === 0)) return routineSubscriptionUnavailable();
  }
  return { scope, actor, attempts, results };
}
/** Consumed synchronously by the fixed provider. No SQL/cache/network await is
 * allowed between durable admission and the single associated POST. */
export function consumeRoutineSubscriptionSendAuthority(value: RoutineSubscriptionSendAuthority) {
  const r = authorities.get(value);
  if (!r || r.used || performance.now() >= r.expiresAt) return routineSubscriptionUnavailable();
  r.used = true;
  return freezeSubscription({ attemptId: r.attempt.attempt_id, attemptSignature: r.attempt.signature, token: r.token, request: r.attempt.payload.request });
}
async function project(tx: DbClient, c: Readonly<RoutineSubscriptionClaim>, status: 'SENT' | 'RETRYABLE' | 'DEAD' | 'UNKNOWN', now: number, code = '', resultId = '', ordinal = 1) {
  const [updated] = await tx.update(orderNotificationDelivery).set({ status, availableTime: status === 'RETRYABLE' ? now + Math.min(60 * 2 ** (ordinal - 1), 3600) : 0,
    leaseToken: '', leaseUntil: 0, responseCode: code, providerReference: resultId, providerRequestId: '',
    lastError: status === 'UNKNOWN' ? 'routine_subscription_result_unknown' : status === 'DEAD' ? 'routine_subscription_refused' : '',
    sentTime: status === 'SENT' ? now : 0, updateTime: now }).where(and(eq(orderNotificationDelivery.id, c.id),
    eq(orderNotificationDelivery.status, 'PROCESSING'), eq(orderNotificationDelivery.leaseToken, c.leaseToken))).returning({ id: orderNotificationDelivery.id });
  if (!updated) return routineSubscriptionUnavailable();
}
/** Only a failed pre-attempt membership/recharge SQL read can enter here. Re-read the
 * complete semantic attempt history under the still-owned claim before undoing
 * its claim-only counter; no immutable attempt or provider POST is erased. */
async function retryMembershipSourceSqlTx(tx: DbClient, env: Env, c: Readonly<RoutineSubscriptionClaim>, baseline: Awaited<ReturnType<typeof history>>) {
  if (!(routineSubscriptionMembershipKey(c.eventKey)||routineSubscriptionRechargeKey(c.eventKey)||routineSubscriptionRechargeRefundKey(c.eventKey)) || !await assertRoutineSubscriptionDeliveryReadTx(tx)) return false;
  const row = await claimed(tx, c), current = await history(tx, env, c), count = baseline.attempts.length;
  if (!subscriptionSame(current, baseline) || count >= 5 || row.attemptCount !== count + 1 || count === 0 && row.replayCount !== 0) return false;
  const code = baseline.results.at(-1)?.payload.result.code;
  if (count > 0 && (code === undefined || code === 0 || !retryable(code))) return false;
  const now = await routineSubscriptionClockTx(tx);
  const [updated] = await tx.update(orderNotificationDelivery).set({ status: 'RETRYABLE', availableTime: now + 60,
    attemptCount: count, leaseToken: '', leaseUntil: 0, responseCode: '', providerReference: '', providerRequestId: '', sentTime: 0,
    lastError: routineSubscriptionRechargeRefundKey(c.eventKey)?'routine_recharge_refund_source_sql_transient':routineSubscriptionRechargeKey(c.eventKey)?'routine_recharge_source_sql_transient':'routine_membership_source_sql_transient', updateTime: now }).where(and(eq(orderNotificationDelivery.id, c.id),
    eq(orderNotificationDelivery.eventKey, c.eventKey), eq(orderNotificationDelivery.channel, 'wechat_routine'),
    eq(orderNotificationDelivery.status, 'PROCESSING'), eq(orderNotificationDelivery.leaseToken, c.leaseToken),
    eq(orderNotificationDelivery.attemptCount, count + 1), eq(orderNotificationDelivery.dispatchCount, row.dispatchCount),
    eq(orderNotificationDelivery.replayCount, row.replayCount), sql`${orderNotificationDelivery.leaseUntil}>${now}`,
    sql`${orderNotificationDelivery.orderId} IS NULL AND ${orderNotificationDelivery.withdrawalId} IS NULL
      AND subject_domain=${routineSubscriptionRechargeKey(c.eventKey)||routineSubscriptionRechargeRefundKey(c.eventKey)?'recharge':'membership'} AND subject_id=${'subjectId' in row ? row.subjectId : 0}`)).returning({ id: orderNotificationDelivery.id });
  return Boolean(updated);
}
export async function processRoutineSubscriptionDelivery(container: Container, env: Env, raw: RoutineSubscriptionClaim, fetcher: typeof fetch = fetch):
Promise<'sent' | 'retry-scheduled' | 'dead' | 'unknown'> {
  root(container); const c = claim(raw), signing = captureRoutineSubscriptionDeliveryEnv(env);
  let uncertain = true, membershipSourceSql = false;
  let retryBaseline: Awaited<ReturnType<typeof history>> | undefined;
  try {
    const prior = await withTx(container, tx => history(tx, signing, c));
    const last = prior.results.at(-1), code = last?.payload.result.code;
    if (code !== undefined && (code === 0 || !retryable(code) || prior.attempts.length >= 5)) {
      return await withTx(container, async tx => {
        if (!await assertRoutineSubscriptionDeliveryReadTx(tx)) return routineSubscriptionUnavailable();
        const r = await claimed(tx, c);
        if (prior.attempts.at(-1)!.payload.intentDigest !== intentDigest(signing, r)) return routineSubscriptionUnavailable();
        await project(tx, c, code === 0 ? 'SENT' : 'DEAD', await routineSubscriptionClockTx(tx), String(code), last!.result_id);
        return code === 0 ? 'sent' as const : 'dead' as const;
      });
    }
    // History is complete and every preceding POST has an explicit rejection.
    uncertain = false;
    retryBaseline = prior;
    membershipSourceSql = routineSubscriptionMembershipKey(c.eventKey)||routineSubscriptionRechargeKey(c.eventKey)||routineSubscriptionRechargeRefundKey(c.eventKey);
    const source = await prepareRoutineSubscriptionDeliveryNotice(container, signing, { deliveryId: c.id, eventKey: c.eventKey });
    membershipSourceSql = false; // Token/network and durable admission are not this SQL-only window.
    const token = await getRoutineSubscriptionAccessToken(container, signing, source.account, { fetcher, forceRefresh: code !== undefined && invalidToken(code) });
    uncertain = true; // A failed commit acknowledgement may have saved the attempt.
    const admission = await withTx(container, async tx => {
      const fresh = await prepareRoutineSubscriptionDeliveryNoticeTx(tx, signing, { deliveryId: c.id, eventKey: c.eventKey });
      assertRoutineSubscriptionDeliveryNoticeTx(tx, fresh);
      if (!await assertRoutineSubscriptionDeliveryReadyTx(tx) || source.facts.sourceDigest !== fresh.facts.sourceDigest
        || !subscriptionSame(source.request, fresh.request)) return routineSubscriptionUnavailable();
      const row = await claimed(tx, c), key = sourceKey(signing, c);
      // Per semantic event/channel, independent of replaceable delivery IDs.
      const [locked] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(
        ('x'||substr(${key},1,8))::bit(32)::integer,('x'||substr(${key},9,8))::bit(32)::integer) AS ready`);
      if (locked?.ready !== true) return routineSubscriptionUnavailable();
      const current = await history(tx, signing, c), ordinal = current.attempts.length + 1, previous = current.attempts.at(-1);
      const previousCode = current.results.at(-1)?.payload.result.code;
      if (ordinal > 5 || row.attemptCount !== ordinal || !previous && row.replayCount !== 0
        || previous && (previousCode === undefined || previousCode === 0 || !retryable(previousCode)
          || previous.payload.intentDigest !== intentDigest(signing, row) || !subscriptionSame(previous.payload.request, fresh.request)))
        return routineSubscriptionUnavailable();
      const now = await routineSubscriptionClockTx(tx);
      const payload: AttemptPayload = { format: 1, purpose: 'routine_subscription_send', scope: current.scope, actor: current.actor,
        previousAttemptId: previous?.attempt_id ?? '', intentDigest: intentDigest(signing, row),
        claim: { eventKey: c.eventKey, leaseToken: c.leaseToken, attemptCount: ordinal, leaseUntil: row.leaseUntil },
        facts: fresh.facts, policy: fresh.account.account, request: fresh.request };
      const body = { attempt_id: randomUUID(), delivery_id: c.id, attempt_no: ordinal, source_key: key, payload, created_at: now };
      const signature = subscriptionMac(signing, 'delivery-attempt', body);
      await tx.execute(sql`INSERT INTO public.routine_subscribe_attempt(attempt_id,delivery_id,attempt_no,source_key,payload,created_at,signature)
        VALUES(${body.attempt_id}::uuid,${c.id},${ordinal},${key},${JSON.stringify(payload)}::jsonb,${now},${signature})`);
      const [saved] = await tx.execute(sql`SELECT * FROM public.routine_subscribe_attempt WHERE attempt_id=${body.attempt_id}::uuid`);
      const attempt = parseAttempt(signing, saved, current.scope, current.actor);
      if (!subscriptionSame(attempt, { ...body, signature })) return routineSubscriptionUnavailable();
      // Recheck the real SQL deadline after all admission work, before COMMIT.
      const anchor = performance.now();
      const [tail] = await tx.execute<{ nowMs: string; ready: boolean }>(sql`SELECT
        (EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::text AS "nowMs",
        pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
        AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${fresh.account.account.payload.data.validUntil}) AS ready`);
      const remaining = fresh.account.account.payload.data.validUntil * 1000 - Number(tail?.nowMs);
      if (tail?.ready !== true || !Number.isFinite(remaining) || remaining <= 0) return routineSubscriptionUnavailable();
      return { attempt, expiresAt: anchor + Math.min(2000, remaining) };
    });
    const admitted = admission.attempt, authority = Object.freeze({ [sendSlot]: true as const });
    authorities.set(authority, { attempt: admitted, token, expiresAt: admission.expiresAt, used: false });
    const response = await postRoutineSubscription(authority, fetcher);
    assertRoutineSubscriptionProviderResult(admitted.attempt_id, admitted.signature, response);
    return await withTx(container, async tx => {
      // Known HTTP outcome is historical: withdrawal during the POST must not
      // invalidate a successful result or make it eligible for a second POST.
      if (!await assertRoutineSubscriptionDeliveryReadTx(tx)) return routineSubscriptionUnavailable();
      const row = await claimed(tx, c), scope = await routineSubscriptionScopeTx(tx);
      if (admitted.payload.intentDigest !== intentDigest(signing, row)) return routineSubscriptionUnavailable();
      await assertRoutineSubscriptionHistoricalAccountTx(tx, signing, admitted.payload.policy, admitted.created_at);
      const [saved] = await tx.execute(sql`SELECT * FROM public.routine_subscribe_attempt WHERE attempt_id=${admitted.attempt_id}::uuid`);
      if (!subscriptionSame(parseAttempt(signing, saved, scope, admitted.payload.actor), admitted)) return routineSubscriptionUnavailable();
      const now = await routineSubscriptionClockTx(tx), resultId = subscriptionMac(signing, 'delivery-result-id', [admitted.attempt_id, admitted.signature]);
      const payload: Receipt['payload'] = { format: 1, purpose: 'routine_subscription_result', scope, attemptSignature: admitted.signature, result: response };
      const body = { result_id: resultId, attempt_id: admitted.attempt_id, payload, created_at: now }, signature = subscriptionMac(signing, 'delivery-result', body);
      const result = parseReceipt(signing, { ...body, signature }, admitted, scope);
      await tx.execute(sql`INSERT INTO public.routine_subscribe_result(result_id,attempt_id,payload,created_at,signature)
        VALUES(${resultId},${admitted.attempt_id}::uuid,${JSON.stringify(payload)}::jsonb,${now},${signature})`);
      const [retained] = await tx.execute(sql`SELECT * FROM public.routine_subscribe_result WHERE result_id=${resultId}`);
      if (!subscriptionSame(parseReceipt(signing, retained, admitted, scope), result)) return routineSubscriptionUnavailable();
      const status = response.code === 0 ? 'SENT' : retryable(response.code) && admitted.attempt_no < 5 ? 'RETRYABLE' : 'DEAD';
      await project(tx, c, status, now, String(response.code), resultId, admitted.attempt_no);
      return status === 'SENT' ? 'sent' as const : status === 'RETRYABLE' ? 'retry-scheduled' as const : 'dead' as const;
    });
  } catch (error) {
    if (!uncertain && membershipSourceSql && retryBaseline && membershipSubscriptionTransientSqlState(error)) {
      // Any failed confirmation remains UNKNOWN. Never turn a possible saved
      // attempt, expired/replaced lease or incomplete history into another POST.
      uncertain = true;
      try {
        if (await withTx(container, tx => retryMembershipSourceSqlTx(tx, signing, c, retryBaseline!))) return 'retry-scheduled';
      } catch { /* The ordinary conservative UNKNOWN projection below remains. */ }
    }
    const status = uncertain ? 'UNKNOWN' : 'DEAD';
    await withTx(container, async tx => {
      if (!await assertRoutineSubscriptionDeliveryReadTx(tx)) return routineSubscriptionUnavailable();
      await project(tx, c, status, await routineSubscriptionClockTx(tx));
    });
    return status === 'UNKNOWN' ? 'unknown' : 'dead';
  }
}
