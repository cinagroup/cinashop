/** Actual PG16 LOGINs, Admin checkout -> RSA/AES A callback -> App paid ->
 * switch SQL/current/bare UID/template to B -> actual Admin or Manager delivery
 * -> signed v2 request -> App A intent -> Queue A GET/POST. No order, payment,
 * grant, source ownership or successful delivery is manufactured by SQL.
 * Identity/inventory/template bootstrap and explicitly labelled corruption/late
 * SQL-fault fixtures are test setup. Only HTTP/cache/Queue transports are local;
 * the exported Manager router, payment, ownership, authors and writers are real.
 * This is not createApp/browser, real SMS/login-form or live WeChat acceptance. */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { deliveryService, notificationTemplate, orderNotificationDelivery, storeOrderOutbox, systemConfig,
  systemMessage, systemNotification, user, wechatUser, type OrderDeliveryNoticeOutboxPayload,
  type WechatTemplateNotificationPayload } from '@/models/schema';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { enqueueOrderDeliveryNoticeEvent, processOrderNotificationOutboxEvent } from '@/services/order/OrderNotificationOutboxService';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment,
  routineSubscriptionScopeTx, subscriptionMac, type RoutineSubscriptionAccountPolicy } from '@/services/wechat/RoutineSubscriptionAccount';
import { parseRoutineSubscriptionNoticeRequest } from '@/services/wechat/RoutineSubscriptionNoticeRequest';
import { parseRoutineSubscriptionNoticeIntent } from '@/services/wechat/RoutineSubscriptionNoticeIntent';
import { prepareRoutineSubscriptionNoticeStagingTx, stageRoutineSubscriptionNoticeTx } from '@/services/wechat/RoutineSubscriptionNoticeAuthor';
import { ASSIGNED_FULFILLMENT_VERSION, type AssignedFulfillmentInput } from '@/services/store/ManagerAssignedFulfillmentInput';
import { managerAssignedFulfillmentFixture, ASSIGNED_APP, ASSIGNED_PAYER, ASSIGNED_CARRIER } from './helpers/managerAssignedFulfillmentFixture';

const transport = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const set = vi.fn(async (key: string, value: unknown) => { values.set(key, value); return true; });
  const remove = vi.fn(async (key: string) => values.delete(key));
  const take = vi.fn(async (key: string) => { const value = values.get(key) ?? null; values.delete(key); return value; });
  const setIfAbsent = vi.fn(async (key: string, value: unknown) => { if (values.has(key)) return false; values.set(key, value); return true; });
  const redis = { eval: vi.fn(async () => 1), get, set: vi.fn(async (key: string, value: unknown) => { await set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => Number(await remove(key))) };
  return { values, get, set, remove, take, setIfAbsent, redis };
});
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(),
  getRedis: () => transport.redis, cacheGet: transport.get, cacheSet: transport.set,
  cacheTake: transport.take, cacheDelete: transport.remove, cacheSetIfAbsent: transport.setIfAbsent,
  setTokenBucket: vi.fn(async () => true), clearToken: vi.fn(async () => true) }));

type Fixture = Awaited<ReturnType<typeof managerAssignedFulfillmentFixture>>;
type Event = typeof storeOrderOutbox.$inferSelect;
type Delivery = typeof orderNotificationDelivery.$inferSelect;
type Source = { orderId: number; event: Event };
type Staged = Source & { delivery: Delivery };
type Query = Pick<DbClient, 'execute'>;
const OTHER = 'wx_assigned_current_B', TARGET = 'notice_owned_buyer_a_not_payer', BARE_B = 'notice_latest_bare_b_same_uid';
const TEMPLATE = 'notice_owned_template_a', GLOBAL_B = 'notice_global_template_b', REF = 'notice_original_secret_a';
const SECRET = 'synthetic-notice-author-secret-a', PHONE = '13800000011';
const base = '/store/manager/assigned-order';
const message = (event: Event) => ({ action: 'processOrderNotificationOutbox' as const, outboxId: event.id, eventKey: event.eventKey });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real post-switch subscription notice producers and authenticated A staging', () => {
  let f: Fixture, network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>, policy: RoutineSubscriptionAccountPolicy, revision = 0;
  let legacyB: Staged, legacyUnconfigured: Staged, missingOwner: Source, missingOwnerEffects: Awaited<ReturnType<typeof effects>>;
  let missingOwnerOutcome: string;
  const app = () => createContainerFromDb(f.appRuntime.db);
  const outbox = () => new OrderOutboxService(app(), f.env);
  const consumer = () => new OrderNotificationDeliveryService(app(), f.env);
  const named = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
  const approve = async (patch: Partial<RoutineSubscriptionAccountPolicy> = {}) => {
    const written = await appendRoutineSubscriptionAccountPolicy(f.maintenanceDb, f.env, named(),
      { operationId: randomUUID(), expectedRevision: revision, data: { ...policy, ...patch } }); revision = written.revision; return written;
  };
  async function currentB(missing = false) {
    await f.configure(true);
    // Explicit configuration and latest *bare* binding bootstrap. It is not an
    // A ownership mapping and is never accepted as a notification receiver.
    await f.maintenanceDb.update(systemConfig).set({ value: JSON.stringify(0) }).where(eq(systemConfig.menuName, 'order_shipping_open'));
    if (missing) await f.maintenanceDb.update(systemConfig).set({ value: JSON.stringify('') }).where(eq(systemConfig.menuName, 'routine_appId'));
    await f.maintenanceDb.delete(wechatUser).where(eq(wechatUser.openid, BARE_B));
    await f.maintenanceDb.insert(wechatUser).values({ uid: 11, userType: 'routine', openid: BARE_B });
  }
  async function eventFor(id: number) {
    const rows = await f.maintenanceDb.select().from(storeOrderOutbox)
      .where(and(eq(storeOrderOutbox.aggregateId, id), eq(storeOrderOutbox.eventType, 'order.delivery.notice')));
    expect(rows).toHaveLength(1); return rows[0];
  }
  async function readRoutine(source: Source) {
    return f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, source.event.eventKey),
      eq(orderNotificationDelivery.channel, 'wechat_routine')));
  }
  async function effects(source: Source) {
    return {
      sms: await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, source.event.eventKey), eq(orderNotificationDelivery.channel, 'sms'))),
      inbox: await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey, source.event.eventKey)),
    };
  }
  async function adminDelivery(mode: 'express' | 'send' = 'express', missing = false): Promise<Source> {
    // paid() restores A for its real callback; B is installed only *after* the
    // actual SUCCESS source and App paid effects committed, before delivery.
    const order = await f.paid(1, 0); await currentB(missing);
    await f.admin('/admin/order/delivery/' + order.orderId, { delivery_type: mode,
      delivery_name: mode === 'send' ? '原生通知配送员' : ASSIGNED_CARRIER.name,
      delivery_id: mode === 'send' ? '13800000030' : 'NOTICE-AUTHOR-' + order.id, ...(mode === 'send' ? { delivery_uid: 30 } : {}) });
    expect(await f.actual(order.id)).toMatchObject({ status: 1, paid: 1, storeId: 0, uid: 11, deliveryType: mode });
    return { orderId: order.id, event: await eventFor(order.id) };
  }
  async function retryStage(source: Source) {
    // Scheduler availability projection only, never a source/request/intent.
    await f.maintenanceDb.update(storeOrderOutbox).set({ availableTime: 0 }).where(eq(storeOrderOutbox.id, source.event.id));
    return outbox().processMessage(message(source.event));
  }
  async function staged(source: Source): Promise<Staged> {
    expect(await retryStage(source)).toBe('completed');
    const rows = await readRoutine(source); expect(rows).toHaveLength(1); const delivery = rows[0];
    expect(delivery).toMatchObject({ status: 'PENDING', target: TARGET, templateCode: (source.event.payload as OrderDeliveryNoticeOutboxPayload).deliveryType === 'send' ? TEMPLATE + '_send' : TEMPLATE,
      payload: { kind: 'wechat_routine', routineAppId: ASSIGNED_APP, routineSubscriptionIntent: { format: 2, deliveryId: delivery.id,
        outboxId: source.event.id, eventKey: source.event.eventKey, actor: { role: f.appRuntime.role }, source: { appId: ASSIGNED_APP, buyerUid: 11 } } } });
    const scope = await routineSubscriptionScopeTx(f.maintenanceDb), intent = (delivery.payload as WechatTemplateNotificationPayload).routineSubscriptionIntent;
    expect(parseRoutineSubscriptionNoticeIntent(f.env, intent, scope)).toEqual(intent);
    return { ...source, delivery };
  }
  async function queued(source: Staged) {
    const before = f.messages.length;
    expect((await consumer().dispatchPending(30, source.event.eventKey)).enqueued).toBeGreaterThan(0);
    const queue = f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m => m.deliveryId === source.delivery.id);
    expect(queue).toHaveLength(1); expect(queue[0]).toEqual({ action: 'processOrderNotificationDelivery', channel: 'wechat_routine', deliveryId: source.delivery.id, eventKey: source.event.eventKey });
    return queue[0];
  }
  function provider(lost = false) {
    for (const key of transport.values.keys()) if (key.startsWith('routine:subscription:')) transport.values.delete(key);
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.weixin.qq.com'); expect(init?.redirect).toBe('manual');
      const [idle] = await f.maintenanceDb.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
        WHERE usename IN(${f.appRuntime.role},${f.adminRuntime.role},${f.managerRuntime.role}) AND state='idle in transaction'`);
      expect(idle.n).toBe(0);
      if (url.pathname === '/cgi-bin/token') {
        expect(init?.method).toBe('GET'); expect(url.searchParams.get('appid')).toBe(ASSIGNED_APP); expect(url.searchParams.get('secret')).toBe(SECRET);
        return Response.json({ access_token: 'synthetic-notice-token-a', expires_in: 7200 });
      }
      expect(url.pathname).toBe('/cgi-bin/message/subscribe/send'); expect(init?.method).toBe('POST');
      expect(url.searchParams.get('access_token')).toBe('synthetic-notice-token-a');
      expect(JSON.parse(String(init?.body))).toMatchObject({ touser: TARGET });
      expect(String(init?.body)).not.toContain(ASSIGNED_PAYER); expect(String(init?.body)).not.toContain(BARE_B);
      if (lost) throw Error('controlled response lost after actual local POST');
      return Response.json({ errcode: 0, errmsg: 'ok' });
    });
  }
  const posts = () => network.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/cgi-bin/message/subscribe/send');
  const attempts = (source: Staged) => f.maintenanceDb.execute<any>(sql`SELECT * FROM public.routine_subscribe_attempt WHERE delivery_id=${source.delivery.id} ORDER BY attempt_no`);
  const results = (source: Staged) => f.maintenanceDb.execute<any>(sql`SELECT r.* FROM public.routine_subscribe_result r
    JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${source.delivery.id} ORDER BY a.attempt_no`);
  async function assertSigned(source: Source, role: string) {
    const payload = source.event.payload as OrderDeliveryNoticeOutboxPayload;
    expect(payload).not.toHaveProperty('routineAppId'); expect(payload.routineSubscriptionRequest).toMatchObject({ format: 2, actor: { role },
      eventKey: source.event.eventKey, aggregateId: source.orderId, eventTime: source.event.addTime, body: { orderId: source.orderId, userId: 11 } });
    const [identity] = await f.maintenanceDb.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${role}`);
    const scope = await routineSubscriptionScopeTx(f.maintenanceDb);
    const request = parseRoutineSubscriptionNoticeRequest(f.env, payload.routineSubscriptionRequest, scope);
    expect(request.actor).toEqual({ role, roleOid: identity.oid });
  }
  async function ownerA() {
    await f.configure(); await f.maintenanceDb.update(user).set({ phone: PHONE }).where(eq(user.uid, 11));
    await f.maintenanceDb.insert(wechatUser).values({ uid: 11, userType: 'routine', openid: TARGET });
    network.mockImplementation(async input => {
      const url = new URL(String(input)); expect(url.pathname).toBe('/sns/jscode2session'); expect(url.searchParams.get('appid')).toBe(ASSIGNED_APP);
      return Response.json({ openid: TARGET, session_key: Buffer.from('0123456789abcdef').toString('base64') });
    });
    const auth = new WechatAuthService(app(), f.env), ticket = await auth.beginMiniProgramLogin({ code: randomUUID(), ip: '127.0.0.1' });
    const pending = transport.values.get('routine_login:' + ticket.key) as { identity: VerifiedSocialIdentity };
    expect(pending.identity.routineObservation).toMatchObject({ appId: ASSIGNED_APP, openid: TARGET });
    // Server-verified phone continuity is explicit test input, not SMS/form QA.
    expect(await auth.reconcileVerifiedIdentity({ ...pending.identity, phone: PHONE })).toBe(11);
    await currentB(); network.mockReset().mockRejectedValue(Error('Unexpected provider transport'));
  }
  async function hold(lock: (tx: Query) => Promise<unknown>, work: () => Promise<void>) {
    await f.withMaintenancePeer(async peer => {
      let ready!: () => void, release!: () => void;
      const acquired = new Promise<void>(r => { ready = r; }), released = new Promise<void>(r => { release = r; });
      const held = peer.transaction(async tx => { await lock(tx); ready(); await released; });
      try { await Promise.race([acquired, held.then(() => { throw Error('Owned source lock holder ended early'); })]); await work(); }
      finally { release(); await held; }
    });
  }
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected provider transport'));
    f = await managerAssignedFulfillmentFixture();
    await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineSubscriptionUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    Object.assign(f.env, { ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: JSON.stringify({ format: 1,
      credentials: [{ ref: REF, version: 1, appId: ASSIGNED_APP, secret: SECRET }] }) });
    const now = Math.floor(Date.now() / 1000);
    policy = { accountId: routineSubscriptionAccountId(f.env, ASSIGNED_APP), state: 'active', appId: ASSIGNED_APP, credentialRef: REF,
      credentialVersion: 1, credentialStamp: routineSubscriptionCredentialCommitment(f.env, REF, 1).credentialStamp,
      purposes: ['subscription_send'], templates: [{ mark: '1128', templateId: TEMPLATE + '_send' }, { mark: '1458', templateId: TEMPLATE }],
      validFrom: now - 60, validUntil: now + 3600 };
    await approve();
    await f.maintenanceDb.insert(user).values({ uid: 30, account: 'notice_actual_courier', pwd: 'synthetic_courier_password', status: 1, phone: '13800000030' });
    await f.maintenanceDb.insert(deliveryService).values({ uid: 30, type: 0, relationId: 0, nickname: '原生通知配送员', phone: '13800000030', status: 1 });
    await f.maintenanceDb.delete(systemNotification).where(inArray(systemNotification.mark, ['order_postage_success', 'order_deliver_success']));
    await f.maintenanceDb.insert(systemNotification).values(['order_postage_success', 'order_deliver_success'].map(mark => ({ mark,
      isRoutine: 1, isSms: 1, isSystem: 1, smsId: 'synthetic_notice_sms', systemTitle: '发货 {order_id}', systemText: '{store_name} {delivery_name} {delivery_id}' })));
    await f.maintenanceDb.delete(notificationTemplate).where(and(inArray(notificationTemplate.mark, ['1458', '1128']), eq(notificationTemplate.legacyType, 0)));
    await f.maintenanceDb.insert(notificationTemplate).values(['1458', '1128'].map(mark => ({ mark, legacyType: 0, status: 1, tempid: GLOBAL_B + (mark === '1128' ? '_send' : '') })));
    // Real legacy producers run before the new namespace exists. No SQL pin or
    // payload edit is used to manufacture either old B or an unconfigured pin.
    const oldB = await adminDelivery(); expect(await outbox().processMessage(message(oldB.event))).toBe('completed');
    legacyB = { ...oldB, delivery: (await readRoutine(oldB))[0] };
    const oldMissing = await adminDelivery('express', true); expect(await outbox().processMessage(message(oldMissing.event))).toBe('completed');
    legacyUnconfigured = { ...oldMissing, delivery: (await readRoutine(oldMissing))[0] };
    await runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    // Both payment and emit are actual business writers. Only A ownership is
    // absent here; approval/current B/bare bindings cannot substitute for it.
    missingOwner = await adminDelivery(); await assertSigned(missingOwner, f.adminRuntime.role);
    missingOwnerOutcome = await outbox().processMessage(message(missingOwner.event));
    missingOwnerEffects = await effects(missingOwner);
    expect(await readRoutine(missingOwner)).toHaveLength(0); expect(missingOwnerOutcome).toBe('deferred');
    await ownerA();
  }, 300000);
  afterEach(() => { network.mockReset().mockRejectedValue(Error('Unexpected provider transport')); });
  afterAll(async () => { try { await f?.close(); } finally { vi.restoreAllMocks(); } }, 30000);

  it('preserves truly authored legacy B and unconfigured pins after commissioning without upgrading either version', async () => {
    expect(legacyB.event.payload).toHaveProperty('routineAppId', OTHER); expect(legacyB.event.payload).not.toHaveProperty('routineSubscriptionRequest');
    expect(legacyB.delivery.payload).toHaveProperty('routineAppId', OTHER);
    expect(legacyUnconfigured.event.payload).toHaveProperty('routineAppId', ''); expect(legacyUnconfigured.event.payload).not.toHaveProperty('routineSubscriptionRequest');
    expect(legacyUnconfigured.delivery.payload).toHaveProperty('routineAppId', ''); expect(legacyUnconfigured.delivery.status).toBe('SKIPPED');
    for (const old of [legacyB, legacyUnconfigured]) {
      const before = await eventFor(old.orderId), rows = await readRoutine(old);
      expect(await outbox().processMessage(message(old.event))).toBe('already-completed');
      expect(await eventFor(old.orderId)).toEqual(before); expect(await readRoutine(old)).toEqual(rows);
      expect(rows[0].payload).not.toHaveProperty('routineSubscriptionIntent');
    }
    provider(); expect(await consumer().processMessage(await queued(legacyB), network)).toBe('dead');
    expect(await attempts(legacyB)).toHaveLength(0); expect(posts()).toHaveLength(0); expect(network).not.toHaveBeenCalled();
    // Historical absence cannot be newly authored by today's pinning code.
    // This explicit SQL counterexample removes only that historical field; it
    // is never counted as a real absence-producing delivery business positive.
    const absentEvent = clone(legacyUnconfigured.event.payload as OrderDeliveryNoticeOutboxPayload);
    const absentDelivery = clone(legacyUnconfigured.delivery.payload as WechatTemplateNotificationPayload);
    delete absentEvent.routineAppId; delete absentDelivery.routineAppId;
    await f.maintenanceDb.update(storeOrderOutbox).set({ payload: absentEvent }).where(eq(storeOrderOutbox.id, legacyUnconfigured.event.id));
    await f.maintenanceDb.update(orderNotificationDelivery).set({ payload: absentDelivery }).where(eq(orderNotificationDelivery.id, legacyUnconfigured.delivery.id));
    const historical = await eventFor(legacyUnconfigured.orderId);
    await withTx(app(), tx => processOrderNotificationOutboxEvent(tx, historical, legacyUnconfigured.delivery.addTime));
    const retained = (await readRoutine(legacyUnconfigured))[0];
    expect(retained.payload).not.toHaveProperty('routineAppId'); expect(retained.payload).not.toHaveProperty('routineSubscriptionIntent');
    expect((await eventFor(legacyUnconfigured.orderId)).payload).toEqual(absentEvent); expect(posts()).toHaveLength(0);
  }, 90000);

  it('defers a real missing-A-owner notice without borrowing B/payer and recovers only after the real ownership writer', async () => {
    expect(missingOwnerOutcome).toBe('deferred'); expect(missingOwnerEffects.sms).toHaveLength(1); expect(missingOwnerEffects.inbox).toHaveLength(1);
    const saved = clone(missingOwnerEffects), source = await staged(missingOwner);
    expect(await effects(source)).toEqual(saved); expect(source.delivery.target).toBe(TARGET); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('sends the real Admin express request from original A despite current B, latest bare B and global template B', async () => {
    const source = await staged(await adminDelivery()); await assertSigned(source, f.adminRuntime.role);
    expect((await f.maintenanceDb.select().from(systemConfig).where(eq(systemConfig.menuName, 'routine_appId')))[0].value).toBe(JSON.stringify(OTHER));
    expect((await f.maintenanceDb.select().from(notificationTemplate).where(eq(notificationTemplate.mark, '1458')))[0].tempid).toBe(GLOBAL_B);
    provider(); const queue = await queued(source); expect(await consumer().processMessage(queue, network)).toBe('sent');
    expect(posts()).toHaveLength(1); expect(JSON.parse(String(posts()[0][1]?.body))).toMatchObject({ touser: TARGET, template_id: TEMPLATE });
    const [attempt] = await attempts(source), [result] = await results(source);
    expect(attempt).toMatchObject({ attempt_no: 1, payload: { facts: { appId: ASSIGNED_APP, buyerUid: 11 }, request: { touser: TARGET, template_id: TEMPLATE } } });
    expect(result).toMatchObject({ attempt_id: attempt.attempt_id, payload: { result: { code: 0 } } });
    expect(await consumer().processMessage(queue, network)).toBe('already-sent'); expect(posts()).toHaveLength(1);
  }, 90000);

  it('uses the distinct A 1128 template for a genuine Admin send delivery and real courier', async () => {
    const source = await staged(await adminDelivery('send')); await assertSigned(source, f.adminRuntime.role);
    provider(); expect(await consumer().processMessage(await queued(source), network)).toBe('sent');
    expect(JSON.parse(String(posts()[0][1]?.body))).toMatchObject({ touser: TARGET, template_id: TEMPLATE + '_send',
      data: { name4: { value: '原生通知配送员' }, phone_number10: { value: '13800000030' } } });
    expect(posts()).toHaveLength(1); expect(await attempts(source)).toHaveLength(1);
  }, 90000);

  it('authors from the actual assigned Manager LOGIN with financial store0 and no private ledger SELECT', async () => {
    const order = await f.paid(1, 0); await currentB(); const grant = await f.decide(order.id);
    const reviewed = await f.http(base + '/review/' + order.id + '?store_id=77');
    expect(reviewed.body.status, reviewed.body.msg).toBe(200); const r = reviewed.body.data;
    const input: AssignedFulfillmentInput = { version: ASSIGNED_FULFILLMENT_VERSION, order_id: order.id, store_id: 77, scope_key: r.scope_key,
      assignment_operation_id: r.grant.operation_id, assignment_ordinal: r.grant.ordinal, assignment_payload_hash: r.grant.payload_hash,
      expected_assignment_source_hash: r.grant.source_hash, expected_order_revision: r.order_revision,
      payload: { type: 1, express_record_type: 1, delivery_name: ASSIGNED_CARRIER.name, delivery_code: ASSIGNED_CARRIER.code, delivery_id: 'NOTICE-MANAGER-' + order.id } };
    expect(r).toMatchObject({ financial_store_id: 0, grant: { operation_id: grant.receipt.operation_id } });
    const key = randomUUID(), committed = await f.http(base + '/commit', input, { key }); expect(committed.body.status, committed.body.msg).toBe(200);
    expect(await f.actual(order.id)).toMatchObject({ status: 1, storeId: 0, uid: 11 });
    const source = await staged({ orderId: order.id, event: await eventFor(order.id) }); await assertSigned(source, f.managerRuntime.role);
    expect((await f.http(base + '/commit', input, { key })).body.data).toEqual({ ...committed.body.data, replayed: true });
    for (const role of [f.adminRuntime.role, f.managerRuntime.role]) {
      const rows = await f.maintenanceDb.execute<{ table: string; readable: boolean }>(sql`SELECT c.relname AS table,pg_catalog.has_table_privilege(${role},c.oid,'SELECT') AS readable
        FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN('routine_original_payment_evidence','routine_identity_ownership','routine_subscription_account_policy')`);
      expect(rows).toHaveLength(3); expect(rows.every(row => row.readable === false)).toBe(true);
    }
    provider(); expect(await consumer().processMessage(await queued(source), network)).toBe('sent'); expect(posts()).toHaveLength(1);
  }, 90000);

  it('rejects an actual Admin LOGIN before changing a valid v2 App outbox claim', async () => {
    const source = await adminDelivery(); await assertSigned(source, f.adminRuntime.role);
    const before = clone(await eventFor(source.orderId));
    const denied = new OrderOutboxService(createContainerFromDb(f.adminRuntime.db), f.env);
    await expect(denied.processMessage(message(source.event))).rejects.toMatchObject({ code: 503 });
    expect(await eventFor(source.orderId)).toEqual(before); expect(await readRoutine(source)).toHaveLength(0);
    expect(await effects(source)).toEqual({ sms: [], inbox: [] }); expect(network).not.toHaveBeenCalled();
    // The same immutable event is still available to its actual App consumer.
    expect((await staged(source)).delivery.target).toBe(TARGET);
  }, 90000);

  it('isolates Dispatch catalog drift to an unavailable Mini request and never upgrades its committed skip after repair', async () => {
    let source!: Source, retained!: Awaited<ReturnType<typeof effects>>, request!: Event['payload'];
    // Isolated fault DDL only: an extra strict-namespace index is a negative
    // catalog specimen, never a business source or commissioning positive.
    await f.maintenanceDb.execute(sql`CREATE INDEX rsnd_test_partial ON public.routine_subscribe_result(attempt_id)`);
    try {
      source = await adminDelivery(); request = clone(source.event.payload);
      expect(source.event.payload).toHaveProperty('routineSubscriptionRequest', { format: 2, unavailable: true });
      expect(source.event.payload).not.toHaveProperty('routineAppId');
      expect(await outbox().processMessage(message(source.event))).toBe('completed');
      const rows = await readRoutine(source); expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'SKIPPED', target: '', templateCode: '' });
      expect(rows[0].payload).not.toHaveProperty('routineSubscriptionIntent');
      retained = await effects(source); expect(retained.sms).toHaveLength(1); expect(retained.inbox).toHaveLength(1);
      expect(await f.actual(source.orderId)).toMatchObject({ status: 1, paid: 1, uid: 11, storeId: 0 });
      expect(network).not.toHaveBeenCalled();
    } finally { await f.maintenanceDb.execute(sql`DROP INDEX public.rsnd_test_partial`); }
    const p = source.event.payload as OrderDeliveryNoticeOutboxPayload;
    await withTx(createContainerFromDb(f.adminRuntime.db), tx => enqueueOrderDeliveryNoticeEvent(tx, {
      orderId: p.orderId, orderNo: p.orderNo, userId: p.userId, deliveryType: p.deliveryType, deliveryName: p.deliveryName,
      deliveryId: p.deliveryId, userAddress: p.userAddress }, source.event.addTime + 1, f.env));
    expect((await eventFor(source.orderId)).payload).toEqual(request);
    expect(await outbox().processMessage(message(source.event))).toBe('already-completed');
    expect(await readRoutine(source)).toMatchObject([{ status: 'SKIPPED', target: '', templateCode: '' }]);
    expect((await readRoutine(source))[0].payload).not.toHaveProperty('routineSubscriptionIntent');
    expect(await effects(source)).toEqual(retained); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('does not borrow the existing shipping-only approval or global B template when the A subscription template is absent', async () => {
    await approve({ templates: [{ mark: '1128', templateId: TEMPLATE + '_send' }] });
    try {
      const source = await adminDelivery(); await assertSigned(source, f.adminRuntime.role);
      expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await readRoutine(source)).toHaveLength(0);
      expect((await f.maintenanceDb.execute(sql`SELECT account_id FROM public.routine_shipping_account_policy`)).length).toBeGreaterThan(0);
      expect((await effects(source)).sms).toHaveLength(1); expect(network).not.toHaveBeenCalled();
      await approve(); const repaired = await staged(source); expect(repaired.delivery.templateCode).toBe(TEMPLATE);
    } finally { await approve(); }
  }, 90000);

  it('defers a real signed request while consumer APP_KEY is unavailable and preserves it through repair', async () => {
    const source = await adminDelivery(), originalPayload = clone(source.event.payload), key = f.env.APP_KEY;
    let saved!: Awaited<ReturnType<typeof effects>>;
    try {
      f.env.APP_KEY = '';
      expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await readRoutine(source)).toHaveLength(0);
      saved = await effects(source); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1);
      expect((await eventFor(source.orderId)).payload).toEqual(originalPayload); expect(network).not.toHaveBeenCalled();
    } finally { f.env.APP_KEY = key; }
    const repaired = await staged(source);
    expect((await eventFor(source.orderId)).payload).toEqual(originalPayload); expect(await effects(source)).toEqual(saved);
    expect(repaired.delivery.payload).toHaveProperty('routineSubscriptionIntent'); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rechecks a staged A policy revocation before token/POST and creates no attempt', async () => {
    const source = await staged(await adminDelivery()); await approve({ state: 'revoked' });
    try { provider(); expect(await consumer().processMessage(await queued(source), network)).toBe('dead'); expect(await attempts(source)).toHaveLength(0); expect(posts()).toHaveLength(0); }
    finally { await approve(); }
  }, 90000);

  it('retains the original request and intent signatures on actual duplicate INSERT and App staging replay', async () => {
    const source = await staged(await adminDelivery()), before = clone(await eventFor(source.orderId)), saved = clone(source.delivery);
    const p = source.event.payload as OrderDeliveryNoticeOutboxPayload;
    await withTx(createContainerFromDb(f.adminRuntime.db), tx => enqueueOrderDeliveryNoticeEvent(tx, {
      orderId: p.orderId, orderNo: p.orderNo, userId: p.userId, deliveryType: p.deliveryType, deliveryName: p.deliveryName,
      deliveryId: p.deliveryId, userAddress: p.userAddress, ...(p.cityDeliveryJobId ? { cityDeliveryJobId: p.cityDeliveryJobId } : {}) }, source.event.addTime + 1, f.env));
    expect(await eventFor(source.orderId)).toEqual(before);
    await withTx(app(), async tx => {
      expect(await prepareRoutineSubscriptionNoticeStagingTx(tx)).toBe(true);
      expect(await stageRoutineSubscriptionNoticeTx(tx, f.env, source.event, 'order_postage_success', true, source.event.addTime)).toBe('staged');
    });
    expect(await readRoutine(source)).toEqual([saved]); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('uses a real savepoint after source-table lock refusal, keeps original SMS/inbox through changed inputs, and recovers', async () => {
    const source = await adminDelivery(); let firstEffects!: Awaited<ReturnType<typeof effects>>;
    const [profile] = await f.maintenanceDb.select({ phone: user.phone }).from(user).where(eq(user.uid, 11));
    const [template] = await f.maintenanceDb.select().from(systemNotification).where(eq(systemNotification.mark, 'order_postage_success'));
    try {
      await hold(tx => tx.execute(sql`LOCK TABLE ONLY public.routine_original_payment_evidence IN ACCESS EXCLUSIVE MODE NOWAIT`), async () => {
        expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await readRoutine(source)).toHaveLength(0);
        firstEffects = await effects(source); expect(firstEffects.sms).toHaveLength(1); expect(firstEffects.inbox).toHaveLength(1);
        const event = await eventFor(source.orderId), now = Math.floor(Date.now() / 1000);
        expect(event.status).toBe('FAILED'); expect(event.leaseToken).toBe(''); expect(event.leaseUntil).toBe(0);
        expect(event.availableTime).toBeGreaterThan(now); expect(event.availableTime).toBeLessThanOrEqual(now + 300); expect(event.attemptCount).toBe(1);
        // Explicit configuration/profile changes between partial effects and
        // replay cannot rewrite the already committed SMS or inbox intent.
        await f.maintenanceDb.update(user).set({ phone: '13800000099' }).where(eq(user.uid, 11));
        await f.maintenanceDb.update(systemNotification).set({ systemTitle: 'changed after first partial commit',
          systemText: 'changed later text', smsId: 'changed_later_sms' }).where(eq(systemNotification.id, template.id));
        // Only scheduler availability is reset; actual bounded failure counters
        // and the original request/source/channel facts remain unchanged.
        expect(await retryStage(source)).toBe('deferred'); expect(await effects(source)).toEqual(firstEffects);
      });
    } finally {
      await f.maintenanceDb.update(user).set({ phone: profile.phone }).where(eq(user.uid, 11));
      await f.maintenanceDb.update(systemNotification).set({ systemTitle: template.systemTitle, systemText: template.systemText,
        smsId: template.smsId }).where(eq(systemNotification.id, template.id));
    }
    const repaired = await staged(source); expect(await effects(source)).toEqual(firstEffects);
    expect(repaired.delivery.payload).toHaveProperty('routineSubscriptionIntent');
    expect(firstEffects.inbox[0].addTime).toBe(source.event.addTime); expect(firstEffects.sms[0].addTime).toBe(source.event.addTime);
    expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rolls a genuine late intent UPDATE failure back without an unsigned Routine row and replays into one signed intent', async () => {
    const source = await adminDelivery();
    // Explicit late-fault trigger: negative SQL specimen, never source approval.
    await f.maintenanceDb.execute(sql.raw(`CREATE FUNCTION public.notice_test_intent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_key='${source.event.eventKey}' AND NEW.payload ? 'routineSubscriptionIntent' THEN RAISE EXCEPTION 'controlled intent projection failure'; END IF; RETURN NEW; END $$`));
    await f.maintenanceDb.execute(sql.raw('CREATE TRIGGER notice_test_intent_failure BEFORE UPDATE ON public.order_notification_delivery FOR EACH ROW EXECUTE FUNCTION public.notice_test_intent_failure()'));
    let saved!: Awaited<ReturnType<typeof effects>>;
    try {
      expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await readRoutine(source)).toHaveLength(0);
      saved = await effects(source); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1);
    } finally { await f.maintenanceDb.execute(sql.raw('DROP TRIGGER notice_test_intent_failure ON public.order_notification_delivery')); await f.maintenanceDb.execute(sql.raw('DROP FUNCTION public.notice_test_intent_failure()')); }
    const repaired = await staged(source); expect(await effects(source)).toEqual(saved); expect(await readRoutine(source)).toHaveLength(1);
    const intent = (repaired.delivery.payload as WechatTemplateNotificationPayload).routineSubscriptionIntent;
    expect(intent).toMatchObject({ format: 2, deliveryId: repaired.delivery.id }); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rejects unsigned format2, wrong-key and foreign-database signed request specimens without acquiring A', async () => {
    for (const kind of ['unsigned', 'wrong-key', 'foreign-database']) {
      const source = await adminDelivery(), payload = clone(source.event.payload as OrderDeliveryNoticeOutboxPayload);
      // Explicit damaged/re-signed request specimens. These are never accepted
      // as a positive business producer; every underlying order was real.
      const original = payload.routineSubscriptionRequest!;
      if ('unavailable' in original) throw Error('Real business writer did not sign');
      const { signature: _signature, ...body } = original;
      if (kind === 'unsigned') payload.routineSubscriptionRequest = { ...original, signature: '0'.repeat(64) };
      else if (kind === 'wrong-key') payload.routineSubscriptionRequest = { ...body, signature: subscriptionMac({ APP_KEY: 'synthetic-wrong-key' }, 'notice-request', body) };
      else { const foreign = { ...body, scope: { ...body.scope, databaseOid: '4294967294' } }; payload.routineSubscriptionRequest = { ...foreign, signature: subscriptionMac(f.env, 'notice-request', foreign) }; }
      await f.maintenanceDb.update(storeOrderOutbox).set({ payload }).where(eq(storeOrderOutbox.id, source.event.id));
      expect(await outbox().processMessage(message(source.event))).toBe('completed');
      const rows = await readRoutine(source); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: 'SKIPPED', target: '', templateCode: '' });
      expect(rows[0].payload).not.toHaveProperty('routineSubscriptionIntent'); expect(network).not.toHaveBeenCalled();
    }
  }, 120000);

  it('rejects a validly signed request attached to the wrong actual event and business body', async () => {
    const source = await adminDelivery(), payload = clone(source.event.payload as OrderDeliveryNoticeOutboxPayload), original = payload.routineSubscriptionRequest!;
    if ('unavailable' in original) throw Error('Actual signed writer absent');
    const { signature: _signature, ...body } = original;
    // Explicit MAC-valid foreign-event structural counterexample.
    const foreign = { ...body, aggregateId: source.orderId + 1, eventKey: 'order.delivery.notice:' + (source.orderId + 1), body: { ...body.body, orderId: source.orderId + 1 } };
    payload.routineSubscriptionRequest = { ...foreign, signature: subscriptionMac(f.env, 'notice-request', foreign) };
    await f.maintenanceDb.update(storeOrderOutbox).set({ payload }).where(eq(storeOrderOutbox.id, source.event.id));
    expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await readRoutine(source)).toHaveLength(0);
    expect((await effects(source)).sms).toHaveLength(1); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rejects modified staged intent bytes before token and durable POST admission', async () => {
    const source = await staged(await adminDelivery()), payload = clone(source.delivery.payload as WechatTemplateNotificationPayload);
    payload.routineSubscriptionIntent = { ...payload.routineSubscriptionIntent!, signature: '0'.repeat(64) };
    // Mutable-ledger tamper counterexample, not a business author.
    await f.maintenanceDb.update(orderNotificationDelivery).set({ payload }).where(eq(orderNotificationDelivery.id, source.delivery.id));
    provider(); expect(await consumer().processMessage(await queued(source), network)).toBe('dead'); expect(await attempts(source)).toHaveLength(0); expect(posts()).toHaveLength(0);
  }, 90000);

  it('refuses a MAC-valid staging intent bound to another delivery ID', async () => {
    const source = await staged(await adminDelivery()), payload = clone(source.delivery.payload as WechatTemplateNotificationPayload), original = payload.routineSubscriptionIntent!;
    if (original.format !== 2) throw Error('Actual delivery author did not produce the expected format2 staging intent');
    const { signature: _signature, ...body } = original;
    // Explicit re-signed foreign-delivery specimen; it is not source authority.
    const foreign = { ...body, deliveryId: source.delivery.id + 1, source: { ...body.source, deliveryId: source.delivery.id + 1 } };
    payload.routineSubscriptionIntent = { ...foreign, signature: subscriptionMac(f.env, 'notice-stage', foreign) };
    await f.maintenanceDb.update(orderNotificationDelivery).set({ payload }).where(eq(orderNotificationDelivery.id, source.delivery.id));
    provider(); expect(await consumer().processMessage(await queued(source), network)).toBe('dead'); expect(await attempts(source)).toHaveLength(0); expect(posts()).toHaveLength(0);
  }, 90000);

  it('keeps a lost v2 POST UNKNOWN on Queue replay with one immutable attempt and no second provider call', async () => {
    const source = await staged(await adminDelivery()); provider(true); const queue = await queued(source);
    expect(await consumer().processMessage(queue, network)).toBe('unknown'); const before = await attempts(source);
    expect(before).toHaveLength(1); expect(await results(source)).toHaveLength(0); expect(posts()).toHaveLength(1);
    expect(await consumer().processMessage(queue, network)).toBe('unknown'); expect(await attempts(source)).toEqual(before);
    expect(await results(source)).toHaveLength(0); expect(posts()).toHaveLength(1);
  }, 90000);

  it('records an unavailable request when the real writer has no signing Env and never upgrades it after repair', async () => {
    const order = await f.paid(1, 0); await currentB();
    const bindings = { ...f.env, APP_KEY: '' };
    // Authentication still uses the real APP_KEY. The explicit missing-Env
    // author boundary is exercised on the real Admin LOGIN transaction below.
    const paid = await f.actual(order.id);
    await withTx(createContainerFromDb(f.adminRuntime.db), async tx => {
      await enqueueOrderDeliveryNoticeEvent(tx, { orderId: paid.id, orderNo: paid.orderId, userId: paid.uid,
        deliveryType: 'express', deliveryName: ASSIGNED_CARRIER.name, deliveryId: 'UNAVAILABLE-' + paid.id, userAddress: paid.userAddress }, Math.floor(Date.now() / 1000), bindings);
    });
    const source: Source = { orderId: order.id, event: await eventFor(order.id) };
    expect(source.event.payload).toHaveProperty('routineSubscriptionRequest', { format: 2, unavailable: true });
    expect(await outbox().processMessage(message(source.event))).toBe('completed');
    expect((await readRoutine(source))[0]).toMatchObject({ status: 'SKIPPED', target: '' });
    const retained = clone(source.event.payload);
    await withTx(createContainerFromDb(f.adminRuntime.db), tx => enqueueOrderDeliveryNoticeEvent(tx, {
      orderId: paid.id, orderNo: paid.orderId, userId: paid.uid, deliveryType: 'express', deliveryName: ASSIGNED_CARRIER.name,
      deliveryId: 'UNAVAILABLE-' + paid.id, userAddress: paid.userAddress }, source.event.addTime + 1, f.env));
    expect((await eventFor(order.id)).payload).toEqual(retained);
    expect(await outbox().processMessage(message(source.event))).toBe('already-completed');
    expect((await readRoutine(source))[0].payload).not.toHaveProperty('routineSubscriptionIntent');
    // The order was never actually shipped by this narrow author-boundary case;
    // this is explicitly not a successful delivery/producer-chain positive.
    expect(await f.actual(order.id)).toMatchObject({ status: 0 }); expect(network).not.toHaveBeenCalled();
  }, 90000);
});
