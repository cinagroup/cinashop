/** A candidate from a fresh recharge settlement; no current Mini config fallback. */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { orderNotificationDelivery, type WechatTemplateNotificationPayload } from '@/models/schema';
import { inspectRoutineSubscriptionDeliveryCatalog, assertRoutineSubscriptionDeliveryReadyTx } from '@/migrations/routineSubscriptionDelivery';
import { prepareRechargePaidNoticeTx } from '@/migrations/rechargePaidNotice';
import { captureRechargePaidNoticeBusiness, rechargePaidNoticeEventKey, rechargePaidNoticeBusinessFromPayload, type RechargePaidNoticeBusiness } from '@/services/order/RechargePaidNoticeCodec';
import { createRechargePaidDeliveryTx } from '@/services/order/RechargePaidNoticeService';
import type { OrderNotificationOutboxEvent } from '@/services/order/OrderNotificationOutboxService';
import { readRoutineSubscriptionNoticeWriterTx } from './RoutineSubscriptionNoticeRequest';
import { readRechargeSubscriptionSettlementTx, selectRechargeSubscriptionOwnerTx, readRoutineSubscriptionRechargeDeliveryTx } from './RoutineSubscriptionRechargeSource';
import { acquireRoutineSubscriptionNoticeSourceGatesTx, prepareRoutineSubscriptionNoticeAuthorTx, assertRoutineSubscriptionNoticeAuthorTx } from './RoutineSubscriptionDeliveryNotice';
import { freezeSubscription, routineSubscriptionScopeTx } from './RoutineSubscriptionAccount';
import { rechargeSubscriptionInteger, rechargeSubscriptionMac, rechargeSubscriptionSame as same, rechargeSubscriptionUnavailable as unavailable,
  parseRoutineSubscriptionRechargeRequest, parseRoutineSubscriptionRechargeIntent,
  type RoutineSubscriptionRechargeRequest, type RoutineSubscriptionRechargeIntent } from './RoutineSubscriptionRechargeEvidenceCodec';
export { parseRoutineSubscriptionRechargeRequest } from './RoutineSubscriptionRechargeEvidenceCodec';
export type { RoutineSubscriptionRechargeRequest } from './RoutineSubscriptionRechargeEvidenceCodec';
export interface RoutineSubscriptionRechargeUnavailable { readonly format: 9; readonly unavailable: true }
const UNAVAILABLE = Object.freeze({ kind: 'original' as const, request: Object.freeze({ format: 9 as const, unavailable: true as const }) });
export async function createRoutineSubscriptionRechargeRequestTx(tx: DbClient, env: Readonly<{ APP_KEY?: string }> | undefined,
  input: { eventKey: string; aggregateId: number; payload: RechargePaidNoticeBusiness; now: number }): Promise<{
    readonly kind: 'original'; readonly request: Readonly<RoutineSubscriptionRechargeRequest | RoutineSubscriptionRechargeUnavailable> }> {
  const body = captureRechargePaidNoticeBusiness(input.payload), d = env && Object.getOwnPropertyDescriptor(env, 'APP_KEY');
  if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string' || !d.value || d.value.length > 8192
    || input.eventKey !== rechargePaidNoticeEventKey(body.orderId) || input.aggregateId !== body.orderId || input.now !== body.occurredAt || !rechargeSubscriptionInteger(input.now)
    || Object.hasOwn(tx, '$client')) return UNAVAILABLE;
  const key = Object.freeze({ APP_KEY: d.value }) as Pick<Env, 'APP_KEY'>;
  try {
    return await withTx(createContainerFromDb(tx), async nested => {
      const catalog = await inspectRoutineSubscriptionDeliveryCatalog(nested), binding = catalog.binding;
      if (!catalog.ready || !binding?.app || !binding.appOid) return UNAVAILABLE;
      const writer = await readRoutineSubscriptionNoticeWriterTx(nested, binding);
      if (!writer || writer.actor.role !== binding.app || writer.actor.roleOid !== binding.appOid) return UNAVAILABLE;
      const source = await readRechargeSubscriptionSettlementTx(nested, key, body), selection = await selectRechargeSubscriptionOwnerTx(nested, key, source);
      const unsigned = { format: 9 as const, requestId: randomUUID(), ...writer, eventKey: input.eventKey, aggregateId: body.orderId,
        eventTime: body.occurredAt, body, selection, settlementDigest: source.settlementDigest, paymentDigest: source.paymentDigest };
      const request = parseRoutineSubscriptionRechargeRequest(key, { ...unsigned, signature: rechargeSubscriptionMac(key, 'recharge-notice-request', unsigned) }, writer.scope);
      return Object.freeze({ kind: 'original' as const, request: freezeSubscription(request) });
    });
  } catch (error) {
    // Explicitly missing/ambiguous authority is frozen. Unknown SQL or lock
    // errors must abort the actual settlement and allow the same winner retry.
    if (error instanceof ServiceUnavailableException) return UNAVAILABLE;
    throw error;
  }
}
/** Root calls before its first outbox/business row lock, independently of old notices. */
export async function prepareRoutineSubscriptionRechargeNoticeStagingTx(tx: DbClient): Promise<boolean> {
  try {
    return await withTx(createContainerFromDb(tx), async nested => {
      await acquireRoutineSubscriptionNoticeSourceGatesTx(nested);
      if (!await prepareRechargePaidNoticeTx(nested) || !await assertRoutineSubscriptionDeliveryReadyTx(nested)) return false;
      await nested.execute(sql`LOCK TABLE ONLY public.store_order_outbox, ONLY public.order_notification_delivery IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      return true;
    });
  } catch { return false; }
}
type NoticeEnvironment = Partial<Pick<Env, 'APP_KEY' | 'ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS' | 'HYPERDRIVE'>>;
function signing(env: Readonly<NoticeEnvironment>): Env {
  if (typeof env.APP_KEY !== 'string' || !env.APP_KEY || env.APP_KEY.length > 8192) return unavailable();
  return { APP_KEY: env.APP_KEY, ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS, HYPERDRIVE: env.HYPERDRIVE } as Env;
}
/** Recharge delivery identity remains NULL order_id plus explicit subject. */
export async function stageRoutineSubscriptionRechargeNoticeTx(tx: DbClient, env: Readonly<NoticeEnvironment>,
  event: OrderNotificationOutboxEvent & { aggregateType?: string }, mark: string, earlyReady: boolean, now: number): Promise<'staged' | 'deferred'> {
  const body = rechargePaidNoticeBusinessFromPayload(event.payload);
  if (event.eventType !== 'recharge.pay.success.notice' || event.aggregateType !== 'recharge' || event.aggregateId !== body.orderId
    || event.eventKey !== rechargePaidNoticeEventKey(body.orderId) || event.addTime !== body.occurredAt || mark !== 'recharge_success') return unavailable();
  let captured: Env, scope: Awaited<ReturnType<typeof routineSubscriptionScopeTx>>;
  try { captured = signing(env); scope = await withTx(createContainerFromDb(tx), nested => routineSubscriptionScopeTx(nested)); }
  catch { return 'deferred'; }
  try { parseRoutineSubscriptionRechargeRequest(captured, ('routineSubscriptionRequest' in event.payload ? event.payload.routineSubscriptionRequest : undefined), scope); }
  catch {
    await createRechargePaidDeliveryTx(tx, { event, body, channel: 'wechat_routine', target: '', templateCode: '',
      payload: { kind: 'wechat_routine', data: {}, url: '/pages/users/user_bill/index?type=2' }, now,
      status: 'SKIPPED', skipReason: 'routine_recharge_notice_source_unavailable' });
    return 'staged';
  }
  if (!earlyReady) return 'deferred';
  try {
    await withTx(createContainerFromDb(tx), async nested => {
      const prior = (await nested.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, event.eventKey),
        eq(orderNotificationDelivery.channel, 'wechat_routine'))).limit(1))[0];
      if (prior) {
        const retained = await readRoutineSubscriptionRechargeDeliveryTx(nested, prior.id);
        if (!retained || retained.subjectId !== body.orderId || retained.outboxId !== event.id || retained.userId !== body.userId || retained.noticeMark !== mark) return unavailable();
        if (retained.payload.kind === 'wechat_routine' && retained.payload.routineSubscriptionIntent) {
          const request = parseRoutineSubscriptionRechargeRequest(captured, ('routineSubscriptionRequest' in event.payload ? event.payload.routineSubscriptionRequest : undefined), scope);
          const intent = parseRoutineSubscriptionRechargeIntent(captured, retained.payload.routineSubscriptionIntent, scope), p = retained.payload;
          if (intent.outboxId !== event.id || intent.deliveryId !== retained.id || intent.eventKey !== event.eventKey || intent.createdAt !== retained.addTime
            || intent.requestSignature !== request.signature || intent.source.orderId !== body.orderId || intent.source.buyerUid !== body.userId
            || intent.source.settlementNonce !== body.settlementNonce || intent.source.settlementDigest !== request.settlementDigest
            || retained.target !== intent.request.touser || retained.templateCode !== intent.request.template_id || p.routineAppId !== intent.source.appId
            || p.url !== intent.request.page || !same(p.data, Object.fromEntries(Object.entries(intent.request.data).map(([k, v]) => [k, v.value])))) return unavailable();
        }
        return; // Never repin or upgrade a committed unavailable/retired row.
      }
      const source = await prepareRoutineSubscriptionNoticeAuthorTx(nested, captured, { outboxId: event.id, eventKey: event.eventKey });
      assertRoutineSubscriptionNoticeAuthorTx(nested, source);
      if (!('subjectDomain' in source.facts) || source.facts.subjectDomain !== 'recharge' || !('settlementNonce' in source.facts)) return unavailable();
      const payload: WechatTemplateNotificationPayload = { kind: 'wechat_routine', routineAppId: source.facts.appId,
        data: Object.fromEntries(Object.entries(source.request.data).map(([key, value]) => [key, value.value])), url: source.request.page };
      const inserted = await createRechargePaidDeliveryTx(nested, { event, body, channel: 'wechat_routine', target: source.request.touser,
        templateCode: source.request.template_id, payload, now: source.renderedAt });
      const actualScope = await routineSubscriptionScopeTx(nested);
      const [actor] = await nested.execute<{ role: string; roleOid: string }>(sql`SELECT current_user AS role,(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS "roleOid"`);
      if (!actor) return unavailable();
      const unsigned: Omit<RoutineSubscriptionRechargeIntent, 'signature'> = { format: 9, scope: actualScope, actor,
        deliveryId: inserted.id, outboxId: event.id, eventKey: event.eventKey, createdAt: source.renderedAt, requestSignature: source.requestSignature,
        source: { ...source.facts, deliveryId: inserted.id }, policy: source.account.account, request: source.request };
      const intent = parseRoutineSubscriptionRechargeIntent(captured, { ...unsigned, signature: rechargeSubscriptionMac(captured, 'recharge-notice-stage', unsigned) }, actualScope);
      const finalPayload = { ...payload, routineSubscriptionIntent: intent };
      const [updated] = await nested.update(orderNotificationDelivery).set({ payload: finalPayload }).where(and(eq(orderNotificationDelivery.id, inserted.id),
        eq(orderNotificationDelivery.status, 'PENDING'), eq(orderNotificationDelivery.attemptCount, 0), eq(orderNotificationDelivery.dispatchCount, 0),
        sql`${orderNotificationDelivery.payload}=${JSON.stringify(payload)}::jsonb`)).returning({ id: orderNotificationDelivery.id });
      if (!updated) return unavailable();
      const [tail] = await nested.execute<{ ready: boolean }>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
        AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${source.account.account.payload.data.validUntil}) AS ready`);
      if (tail?.ready !== true) return unavailable();
    });
    return 'staged';
  } catch { return 'deferred'; }
}
