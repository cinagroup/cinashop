import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { orderNotificationDelivery, type WechatTemplateNotificationPayload } from '@/models/schema';
import type { OrderNotificationOutboxEvent } from '@/services/order/OrderNotificationOutboxService';
import { acquireRoutineSubscriptionNoticeSourceGatesTx, prepareRoutineSubscriptionNoticeAuthorTx,
  assertRoutineSubscriptionNoticeAuthorTx } from './RoutineSubscriptionDeliveryNotice';
import { assertRoutineSubscriptionDeliveryReadyTx } from '@/migrations/routineSubscriptionDelivery';
import { parseRoutineSubscriptionNoticeIntent, type RoutineSubscriptionNoticeIntent } from './RoutineSubscriptionNoticeIntent';
import { parseRoutineSubscriptionNoticeRequest } from './RoutineSubscriptionNoticeRequest';
import { routineSubscriptionScopeTx, routineSubscriptionUnavailable, subscriptionMac, subscriptionSame } from './RoutineSubscriptionAccount';

export type RoutineSubscriptionNoticeEnvironment = Partial<Pick<Env, 'APP_KEY' | 'ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS' | 'HYPERDRIVE'>>;
/** Copy only declared primitives; no current Mini SQL credentials or token are
 * involved in prospective staging. Missing material defers only Mini staging. */
export function captureRoutineSubscriptionNoticeEnvironment(env?: RoutineSubscriptionNoticeEnvironment): Readonly<RoutineSubscriptionNoticeEnvironment> {
  const connectionString = env?.HYPERDRIVE?.connectionString;
  return Object.freeze({ APP_KEY: env?.APP_KEY, ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: env?.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS,
    HYPERDRIVE: connectionString === undefined ? undefined : Object.freeze({ connectionString }) as Env['HYPERDRIVE'] });
}
/** Claim identity only, not catalog readiness or send authority. Catalog
 * deparsers can lock physical source relations; keep that full audit inside
 * the optional Mini SAVEPOINT so contention cannot block SMS/inbox progress. */
export async function assertRoutineSubscriptionNoticeClaimTx(tx: DbClient): Promise<void> {
  if (Object.hasOwn(tx, '$client')) return routineSubscriptionUnavailable();
  await tx.execute(sql`SELECT
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [identity] = await tx.execute<{ ready: boolean }>(sql`SELECT current_user=session_user
    AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND r.oid<>p.relowner AND o.rolsuper AND o.rolcanlogin
    AND pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
    AND pg_catalog.current_setting('session_replication_role')='origin' AND pg_catalog.current_schema()='public'
    AND pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
    AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT')
    AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
    AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
      AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
    AND (SELECT pg_catalog.count(*)=3 AND pg_catalog.bool_and(c.relowner=p.relowner AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND pg_catalog.to_regclass(c.relname)=c.oid)
      FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN('routine_original_payment_evidence','routine_identity_ownership','routine_subscription_account_policy'))
    AND (SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(a.grantee=r.oid AND a.grantor=p.relowner
      AND a.privilege_type='SELECT' AND NOT a.is_grantable)
      FROM pg_catalog.aclexplode(COALESCE(p.relacl,pg_catalog.acldefault('r',p.relowner))) a WHERE a.grantee<>p.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=p.oid AND a.attnum>0 AND a.attacl IS NOT NULL) AS ready
    FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class p ON p.oid=pg_catalog.to_regclass('public.routine_subscription_account_policy')
    JOIN pg_catalog.pg_roles o ON o.oid=p.relowner WHERE r.rolname=current_user`);
  if (identity?.ready !== true) return routineSubscriptionUnavailable();
}
/** Must run before the outbox processing transaction takes its first business
 * row lock. A released SAVEPOINT retains successful xact gates until COMMIT. */
export async function prepareRoutineSubscriptionNoticeStagingTx(tx: DbClient) {
  try {
    await withTx(createContainerFromDb(tx), async nested => {
      await acquireRoutineSubscriptionNoticeSourceGatesTx(nested);
      if (!await assertRoutineSubscriptionDeliveryReadyTx(nested)) return routineSubscriptionUnavailable();
      await nested.execute(sql`LOCK TABLE ONLY public.store_order_outbox, ONLY public.order_notification_delivery IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    });
    return true;
  } catch { return false; }
}
function signing(env: Readonly<RoutineSubscriptionNoticeEnvironment>): Env {
  if (typeof env.APP_KEY !== 'string' || !env.APP_KEY || env.APP_KEY.length > 8192) return routineSubscriptionUnavailable();
  return { APP_KEY: env.APP_KEY, ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS,
    HYPERDRIVE: env.HYPERDRIVE } as Env;
}
async function existing(tx: DbClient, event: OrderNotificationOutboxEvent) {
  return (await tx.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, event.eventKey),
    eq(orderNotificationDelivery.channel, 'wechat_routine'))).limit(1))[0];
}
async function skip(tx: DbClient, event: OrderNotificationOutboxEvent, mark: string, now: number) {
  if (await existing(tx, event)) return; // A committed legacy or earlier skip is never upgraded.
  const p = event.payload;
  if (!('orderId' in p) || !('orderNo' in p) || !('userId' in p)) return routineSubscriptionUnavailable();
  await tx.insert(orderNotificationDelivery).values({ outboxId: event.id, eventKey: event.eventKey, orderId: p.orderId,
    userId: p.userId, noticeMark: mark, channel: 'wechat_routine', target: '', templateCode: '',
    payload: { kind: 'wechat_routine', data: {}, url: `/pages/goods/order_details/index?order_id=${p.orderNo}` },
    status: 'SKIPPED', availableTime: now, lastError: 'routine_original_notice_source_unavailable', addTime: now, updateTime: now })
    .onConflictDoNothing({ target: [orderNotificationDelivery.eventKey, orderNotificationDelivery.channel] });
}
/** This author creates a signed staging projection. Only phase47's immutable
 * attempt + fresh source read can later authorize the first provider POST. */
export async function stageRoutineSubscriptionNoticeTx(tx: DbClient, env: Readonly<RoutineSubscriptionNoticeEnvironment>,
  event: OrderNotificationOutboxEvent, mark: string, earlyReady: boolean, now: number): Promise<'staged' | 'deferred'> {
  // Invalid/unsigned requests cannot acquire a later target merely because
  // material is repaired. This terminal skip never upgrades an existing row.
  let captured: Env, scope: Awaited<ReturnType<typeof routineSubscriptionScopeTx>>;
  try {
    captured = signing(env);
    scope = await withTx(createContainerFromDb(tx), nested => routineSubscriptionScopeTx(nested));
  } catch { return 'deferred'; }
  try {
    parseRoutineSubscriptionNoticeRequest(captured, 'routineSubscriptionRequest' in event.payload ? event.payload.routineSubscriptionRequest : undefined, scope);
  } catch { await skip(tx, event, mark, now); return 'staged'; }
  if (!earlyReady) return 'deferred';
  try {
    await withTx(createContainerFromDb(tx), async nested => {
      const captured = signing(env), prior = await existing(nested, event);
      if (prior) {
        // Never overwrite/repin an old A/B/missing row. A signed existing row
        // may be authenticated for replay, including after policy retirement.
        if (prior.payload.kind === 'wechat_routine' && prior.payload.routineSubscriptionIntent) {
          const scope = await routineSubscriptionScopeTx(nested), intent = parseRoutineSubscriptionNoticeIntent(captured, prior.payload.routineSubscriptionIntent, scope);
          const request = parseRoutineSubscriptionNoticeRequest(captured, 'routineSubscriptionRequest' in event.payload ? event.payload.routineSubscriptionRequest : undefined, scope);
          const payload = prior.payload;
          if (prior.outboxId !== event.id || intent.outboxId !== event.id || intent.deliveryId !== prior.id || intent.eventKey !== event.eventKey
            || intent.createdAt !== prior.addTime || intent.requestSignature !== request.signature || prior.noticeMark !== mark
            || prior.target !== intent.request.touser || prior.templateCode !== intent.request.template_id || payload.routineAppId !== intent.source.appId
            || payload.url !== intent.request.page || !subscriptionSame(payload.data, Object.fromEntries(Object.entries(intent.request.data).map(([k, v]) => [k, v.value]))))
            return routineSubscriptionUnavailable();
        }
        return;
      }
      const source = await prepareRoutineSubscriptionNoticeAuthorTx(nested, captured, { outboxId: event.id, eventKey: event.eventKey });
      assertRoutineSubscriptionNoticeAuthorTx(nested, source);
      const payload: WechatTemplateNotificationPayload = { kind: 'wechat_routine', routineAppId: source.facts.appId,
        data: Object.fromEntries(Object.entries(source.request.data).map(([key, value]) => [key, value.value])), url: source.request.page };
      const [inserted] = await nested.insert(orderNotificationDelivery).values({ outboxId: event.id, eventKey: event.eventKey, orderId: source.facts.orderId,
        userId: source.facts.buyerUid, noticeMark: mark, channel: 'wechat_routine', target: source.request.touser, templateCode: source.request.template_id,
        payload, status: 'PENDING', availableTime: source.renderedAt, addTime: source.renderedAt, updateTime: source.renderedAt })
        .onConflictDoNothing({ target: [orderNotificationDelivery.eventKey, orderNotificationDelivery.channel] }).returning({ id: orderNotificationDelivery.id });
      if (!inserted) return routineSubscriptionUnavailable();
      const scope = await routineSubscriptionScopeTx(nested);
      const [actor] = await nested.execute<{ role: string; roleOid: string }>(sql`SELECT current_user AS role,
        (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS "roleOid"`);
      if (!actor) return routineSubscriptionUnavailable();
      const body: Omit<RoutineSubscriptionNoticeIntent, 'signature'> = { format: 2, scope, actor: { role: actor.role, roleOid: actor.roleOid },
        deliveryId: inserted.id, outboxId: event.id, eventKey: event.eventKey, createdAt: source.renderedAt, requestSignature: source.requestSignature,
        source: { ...source.facts, deliveryId: inserted.id }, policy: source.account.account, request: source.request };
      const intent = parseRoutineSubscriptionNoticeIntent(captured, { ...body, signature: subscriptionMac(captured, 'notice-stage', body) }, scope);
      const finalPayload = { ...payload, routineSubscriptionIntent: intent };
      const [updated] = await nested.update(orderNotificationDelivery).set({ payload: finalPayload }).where(and(eq(orderNotificationDelivery.id, inserted.id),
        eq(orderNotificationDelivery.status, 'PENDING'), eq(orderNotificationDelivery.attemptCount, 0), eq(orderNotificationDelivery.dispatchCount, 0),
        sql`${orderNotificationDelivery.payload} = ${JSON.stringify(payload)}::jsonb`)).returning({ id: orderNotificationDelivery.id });
      if (!updated) return routineSubscriptionUnavailable();
      const [tail] = await nested.execute<{ ready: boolean }>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
        AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${source.account.account.payload.data.validUntil}) AS ready`);
      if (tail?.ready !== true) return routineSubscriptionUnavailable();
    });
    return 'staged';
  } catch {
    // Actual rollback to SAVEPOINT restores a usable outer transaction even
    // after a SQL error; SMS/inbox and committed fulfillment keep their scope.
    return 'deferred';
  }
}
