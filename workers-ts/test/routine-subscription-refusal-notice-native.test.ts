/** Actual PG16 five-LOGIN fixture: Admin checkout -> signed RSA/AES A payment
 * -> authenticated buyer refund application -> switch to B -> formal Admin
 * operation/Financial refusal -> request3 -> App intent3 -> Queue A1451 POST.
 * Bootstrap is limited to users/config/templates and real maintenance policy
 * authors. SQL corruption/locking/fault DDL below are explicit negative cases.
 * HTTP, KV/cache and Queue transports are local; no real provider consent,
 * production commissioning, browser, SMS/form-login or Workerd is claimed. */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { notificationTemplate, orderNotificationDelivery, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderRefund,
  systemConfig, systemMessage, systemNotification, user, wechatUser,
  type OrderRefundRefusedNoticeOutboxPayload, type WechatTemplateNotificationPayload } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { adminRefundOperationRoutes } from '@/routes/admin-refund-operations';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { enqueueOrderRefundRefusedNoticeEvent, processOrderNotificationOutboxEvent } from '@/services/order/OrderNotificationOutboxService';
import { CustomerWorkFinancialService } from '@/services/customer-work/CustomerWorkFinancialService';
import { appendRoutineRefundAccountPolicy } from '@/services/payment/RoutineRefundAccountPolicy';
import { routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { CUSTOMER_FINANCIAL_VERSION, type FinancialInput } from '@/services/customer-work/CustomerWorkFinancialProtocol';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment,
  routineSubscriptionScopeTx, subscriptionMac, type RoutineSubscriptionAccountPolicy } from '@/services/wechat/RoutineSubscriptionAccount';
import { parseRoutineSubscriptionRefusalRequest } from '@/services/wechat/RoutineSubscriptionRefusalRequest';
import { parseRoutineSubscriptionNoticeIntent } from '@/services/wechat/RoutineSubscriptionNoticeIntent';
import { createToken, md5 } from '@/utils/jwt';
import { managerAssignedFulfillmentFixture, ASSIGNED_APP, ASSIGNED_PAYER, ASSIGNED_MERCHANT,
  ASSIGNED_AES, ASSIGNED_PLATFORM } from './helpers/managerAssignedFulfillmentFixture';

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
type Source = { orderId: number; refundId: number; event: Event };
type Staged = Source & { delivery: Delivery };
type Query = Pick<DbClient, 'execute'>;
const CURRENT_B = 'wx_assigned_current_B', TARGET = 'refusal_owned_buyer_a_not_payer', BARE_B = 'refusal_latest_bare_b_same_uid';
const TEMPLATE = 'refusal_original_template_a', GLOBAL_B = 'refusal_global_template_b', REF = 'refusal_original_secret_a';
const SECRET = 'synthetic-refusal-original-secret-a', PHONE = '13800000011', MARK = 'send_order_refund_no_status';
const REASON = '已核对原申请并拒绝退款', ADMIN_PROTOCOL = 'admin-refund-operation-v1';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const message = (event: Event) => ({ action: 'processOrderNotificationOutbox' as const, outboxId: event.id, eventKey: event.eventKey });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual original-account refund-refusal notification producers', () => {
  let f: Fixture, network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>, policy: RoutineSubscriptionAccountPolicy, revision = 0;
  let legacyB: Staged, legacyEmpty: Staged, missingOwner: Source, missingOwnerEffects: Awaited<ReturnType<typeof effects>>;
  const app = () => createContainerFromDb(f.appRuntime.db);
  const outbox = () => new OrderOutboxService(app(), f.env);
  const consumer = () => new OrderNotificationDeliveryService(app(), f.env);
  const named = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
  const approve = async (patch: Partial<RoutineSubscriptionAccountPolicy> = {}) => {
    const result = await appendRoutineSubscriptionAccountPolicy(f.maintenanceDb, f.env, named(),
      { operationId: randomUUID(), expectedRevision: revision, data: { ...policy, ...patch } }); revision = result.revision; return result;
  };
  const refund = async (id: number) => (await f.maintenanceDb.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, id)))[0]!;
  async function eventFor(id: number) {
    const rows = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, 'order.refund.refused.notice:' + id));
    expect(rows).toHaveLength(1); return rows[0];
  }
  const routine = (source: Source) => f.maintenanceDb.select().from(orderNotificationDelivery).where(and(
    eq(orderNotificationDelivery.eventKey, source.event.eventKey), eq(orderNotificationDelivery.channel, 'wechat_routine')));
  async function effects(source: Source) {
    return { sms: await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(
      eq(orderNotificationDelivery.eventKey, source.event.eventKey), eq(orderNotificationDelivery.channel, 'sms'))),
    inbox: await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey, source.event.eventKey)) };
  }
  async function currentB(empty = false) {
    await f.configure(true);
    await f.maintenanceDb.update(systemConfig).set({ value: JSON.stringify(0) }).where(eq(systemConfig.menuName, 'order_shipping_open'));
    if (empty) await f.maintenanceDb.update(systemConfig).set({ value: JSON.stringify('') }).where(eq(systemConfig.menuName, 'routine_appId'));
    await f.maintenanceDb.delete(wechatUser).where(eq(wechatUser.openid, BARE_B));
    await f.maintenanceDb.insert(wechatUser).values({ uid: 11, userType: 'routine', openid: BARE_B });
  }
  async function application() {
    const order = await f.paid(1, 0);
    const response = await f.http('/order/refund/apply/' + order.orderId,
      { refundReason: '真实买家申请', refundExplain: '真实A付款后的原申请', applyType: 1 }, { uid: 11 });
    expect(response.body.status, response.body.msg).toBe(200);
    const id = response.body.data.refundId as number, row = await refund(id);
    expect(row).toMatchObject({ id, storeOrderId: order.id, uid: 11, storeId: 0, supplierId: 0, applyType: 1, refundType: 0, refundNum: 1 });
    const carts = await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(carts).toHaveLength(1); expect(carts[0].refundNum).toBe(1);
    return { order, row };
  }
  function adminApp() {
    const h = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    h.use('*', async (c, next) => { c.set('container', app()); await next(); }); h.onError(errorHandler);
    h.route('/adminapi/refund/operations', adminRefundOperationRoutes); return h;
  }
  async function adminRequest(path: string, key: string, body: unknown) {
    const token = (await createToken(1, 'admin', md5('offline-native-admin-password'), f.env.APP_KEY)).token;
    const response = await adminApp().request('/adminapi/refund/operations/' + path, { method: 'POST', headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Refund-Operation-Scope': 'v1:admin:1',
    }, body: JSON.stringify(body) }, f.env);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    return { response, body: await response.json() as { status: number; msg: string; data: any } };
  }
  async function adminRefusal(empty = false): Promise<Source> {
    const { order, row } = await application(); await currentB(empty);
    const key = randomUUID(), body = { version: ADMIN_PROTOCOL, action: 'refuse', review: {
      uid: row.uid, storeOrderId: order.id, storeId: row.storeId, supplierId: row.supplierId, orderId: row.orderId, refundPrice: row.refundPrice,
    }, decision: { applyType: row.applyType, refundType: row.refundType, received: false }, reason: REASON };
    const first = await adminRequest('execute/' + row.id, key, body);
    expect(first.response.status).toBe(200); expect(first.body.status, first.body.msg).toBe(200);
    expect(first.body.data).toMatchObject({ replayed: false, receipt: { adminId: 1, requestKey: key, refundId: row.id, action: 'refuse', outcome: 'refused' } });
    const receipt = first.body.data.receipt, lookup = await adminRequest('receipt', key, { version: ADMIN_PROTOCOL });
    expect(lookup.body).toMatchObject({ status: 200, data: { receipt } });
    const event = await eventFor(row.id), duplicate = await adminRequest('execute/' + row.id, key, body);
    expect(duplicate.body).toMatchObject({ status: 200, data: { replayed: true, receipt } });
    expect(await eventFor(row.id)).toEqual(event);
    const [stored] = await f.maintenanceDb.execute<any>(sql`SELECT * FROM public.admin_refund_operation WHERE admin_id=1 AND request_key=${key}::uuid`);
    expect(stored).toMatchObject({ refund_id: row.id, action: 'refuse', outcome: 'refused' });
    expect(await refund(row.id)).toMatchObject({ refundType: 3, refuseReason: REASON, refundedTime: event.addTime });
    return { orderId: order.id, refundId: row.id, event };
  }
  async function retry(source: Source) {
    // Scheduler projection only. Source/request/intent and attempt counters stay intact.
    await f.maintenanceDb.update(storeOrderOutbox).set({ availableTime: 0 }).where(eq(storeOrderOutbox.id, source.event.id));
    return outbox().processMessage(message(source.event));
  }
  async function signed(source: Source, role = f.adminRuntime.role) {
    const payload = source.event.payload as OrderRefundRefusedNoticeOutboxPayload;
    expect(payload).not.toHaveProperty('routineAppId');
    const request = parseRoutineSubscriptionRefusalRequest(f.env, payload.routineSubscriptionRequest, await routineSubscriptionScopeTx(f.maintenanceDb));
    expect(request).toMatchObject({ format: 3, actor: { role }, aggregateId: source.orderId, eventKey: source.event.eventKey,
      eventTime: source.event.addTime, body: { orderId: source.orderId, refundId: source.refundId, userId: 11, payPrice: '5.00' },
      decision: { refuseReason: REASON, refundedTime: source.event.addTime } });
    const [identity] = await f.maintenanceDb.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${role}`);
    expect(request.actor.roleOid).toBe(identity.oid); return request;
  }
  async function staged(source: Source): Promise<Staged> {
    expect(await retry(source)).toBe('completed'); const rows = await routine(source); expect(rows).toHaveLength(1); const delivery = rows[0];
    expect(delivery).toMatchObject({ status: 'PENDING', target: TARGET, templateCode: TEMPLATE, payload: {
      kind: 'wechat_routine', routineAppId: ASSIGNED_APP, routineSubscriptionIntent: { format: 3, outboxId: source.event.id,
        deliveryId: delivery.id, eventKey: source.event.eventKey, source: { appId: ASSIGNED_APP, buyerUid: 11, templateMark: '1451' } },
    } });
    const intent = (delivery.payload as WechatTemplateNotificationPayload).routineSubscriptionIntent;
    expect(parseRoutineSubscriptionNoticeIntent(f.env, intent, await routineSubscriptionScopeTx(f.maintenanceDb))).toEqual(intent);
    return { ...source, delivery };
  }
  async function queued(source: Staged) {
    const before = f.messages.length; expect((await consumer().dispatchPending(30, source.event.eventKey)).enqueued).toBeGreaterThan(0);
    const messages = f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m => m.deliveryId === source.delivery.id);
    expect(messages).toHaveLength(1); return messages[0];
  }
  function provider(lost = false) {
    for (const key of transport.values.keys()) if (key.startsWith('routine:subscription:')) transport.values.delete(key);
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.weixin.qq.com'); expect(init?.redirect).toBe('error');
      const [idle] = await f.maintenanceDb.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
        WHERE usename IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role}) AND state='idle in transaction'`);
      expect(idle.n).toBe(0);
      if (url.pathname === '/cgi-bin/token') {
        expect(init?.method).toBe('GET'); expect(url.searchParams.get('appid')).toBe(ASSIGNED_APP); expect(url.searchParams.get('secret')).toBe(SECRET);
        return Response.json({ access_token: 'synthetic-refusal-token-a', expires_in: 7200 });
      }
      expect(url.pathname).toBe('/cgi-bin/message/subscribe/send'); expect(init?.method).toBe('POST');
      expect(url.searchParams.get('access_token')).toBe('synthetic-refusal-token-a');
      expect(JSON.parse(String(init?.body))).toMatchObject({ touser: TARGET, template_id: TEMPLATE, data: {
        thing1: { value: '退款失败' }, amount3: { value: '5.00' },
      } });
      expect(String(init?.body)).not.toContain(ASSIGNED_PAYER); expect(String(init?.body)).not.toContain(BARE_B);
      if (lost) throw Error('Controlled lost response after actual local POST'); return Response.json({ errcode: 0 });
    });
  }
  const posts = () => network.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/cgi-bin/message/subscribe/send');
  const attempts = (source: Staged) => f.maintenanceDb.execute<any>(sql`SELECT * FROM public.routine_subscribe_attempt WHERE delivery_id=${source.delivery.id} ORDER BY attempt_no`);
  const results = (source: Staged) => f.maintenanceDb.execute<any>(sql`SELECT r.* FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${source.delivery.id}`);
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
    // Explicit server-verified phone continuity input, not a real SMS login.
    expect(await auth.reconcileVerifiedIdentity({ ...pending.identity, phone: PHONE })).toBe(11);
    await currentB(); network.mockReset().mockRejectedValue(Error('Unexpected provider transport'));
  }
  async function hold(lock: (tx: Query) => Promise<unknown>, work: () => Promise<void>) {
    await f.withMaintenancePeer(async peer => {
      let ready!: () => void, release!: () => void;
      const acquired = new Promise<void>(r => { ready = r; }), released = new Promise<void>(r => { release = r; });
      const held = peer.transaction(async tx => { await lock(tx); ready(); await released; });
      try { await Promise.race([acquired, held.then(() => { throw Error('Source lock holder ended early'); })]); await work(); }
      finally { release(); await held; }
    });
  }
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected provider transport'));
    f = await managerAssignedFulfillmentFixture();
    // Identity/config bootstrap only; every source below uses real paid() and
    // the authenticated buyer refund HTTP entry, never a seeded paid/refusal.
    await f.maintenanceDb.update(user).set({ pwd: 'owned-financial-password' }).where(eq(user.uid, 11));
    await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineSubscriptionUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    Object.assign(f.env, { ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: JSON.stringify({ format: 1,
      credentials: [{ ref: REF, version: 1, appId: ASSIGNED_APP, secret: SECRET }] }) });
    const now = Math.floor(Date.now() / 1000);
    policy = { accountId: routineSubscriptionAccountId(f.env, ASSIGNED_APP), state: 'active', appId: ASSIGNED_APP,
      credentialRef: REF, credentialVersion: 1, credentialStamp: routineSubscriptionCredentialCommitment(f.env, REF, 1).credentialStamp,
      purposes: ['subscription_send'], templates: [{ mark: '1451', templateId: TEMPLATE }], validFrom: now - 60, validUntil: now + 3600 };
    await approve();
    await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, MARK));
    await f.maintenanceDb.insert(systemNotification).values({ mark: MARK, isRoutine: 1, isSms: 1, isSystem: 1,
      smsId: 'synthetic_refusal_sms', systemTitle: '退款拒绝 {order_id}', systemText: '{store_name} 退款拒绝' });
    await f.maintenanceDb.delete(notificationTemplate).where(and(eq(notificationTemplate.mark, '1451'), eq(notificationTemplate.legacyType, 0)));
    await f.maintenanceDb.insert(notificationTemplate).values({ mark: '1451', legacyType: 0, status: 1, tempid: GLOBAL_B });
    const oldB = await adminRefusal(); expect(await outbox().processMessage(message(oldB.event))).toBe('completed');
    legacyB = { ...oldB, delivery: (await routine(oldB))[0] };
    const empty = await adminRefusal(true); expect(await outbox().processMessage(message(empty.event))).toBe('completed');
    legacyEmpty = { ...empty, delivery: (await routine(empty))[0] };
    await runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    missingOwner = await adminRefusal(); await signed(missingOwner);
    expect(await outbox().processMessage(message(missingOwner.event))).toBe('deferred'); expect(await routine(missingOwner)).toHaveLength(0);
    missingOwnerEffects = await effects(missingOwner); await ownerA();
  }, 300000);
  afterEach(() => { network.mockReset().mockRejectedValue(Error('Unexpected provider transport')); });
  afterAll(async () => { try { await f?.close(); } finally { vi.restoreAllMocks(); } }, 30000);

  it('preserves genuine pre-commission B/empty pins and rejects an explicitly damaged missing-pin specimen', async () => {
    expect(legacyB.event.payload).toHaveProperty('routineAppId', CURRENT_B); expect(legacyB.event.payload).not.toHaveProperty('routineSubscriptionRequest');
    expect(legacyEmpty.event.payload).toHaveProperty('routineAppId', ''); expect(legacyEmpty.delivery.status).toBe('SKIPPED');
    for (const old of [legacyB, legacyEmpty]) {
      const before = clone(await eventFor(old.refundId)), rows = clone(await routine(old));
      expect(await outbox().processMessage(message(old.event))).toBe('already-completed');
      expect(await eventFor(old.refundId)).toEqual(before); expect(await routine(old)).toEqual(rows);
      expect(rows[0].payload).not.toHaveProperty('routineSubscriptionIntent');
    }
    provider(); expect(await consumer().processMessage(await queued(legacyB), network)).toBe('dead');
    expect(await attempts(legacyB)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
    // Explicit historical missing-field SQL negative, never a producer positive.
    const p = clone(legacyEmpty.event.payload as OrderRefundRefusedNoticeOutboxPayload), d = clone(legacyEmpty.delivery.payload as WechatTemplateNotificationPayload);
    delete p.routineAppId; delete d.routineAppId;
    await f.maintenanceDb.update(storeOrderOutbox).set({ payload: p }).where(eq(storeOrderOutbox.id, legacyEmpty.event.id));
    await f.maintenanceDb.update(orderNotificationDelivery).set({ payload: d }).where(eq(orderNotificationDelivery.id, legacyEmpty.delivery.id));
    await withTx(app(), tx => processOrderNotificationOutboxEvent(tx, { ...legacyEmpty.event, payload: p }, legacyEmpty.event.addTime));
    expect((await eventFor(legacyEmpty.refundId)).payload).toEqual(p);
    expect((await routine(legacyEmpty))[0].payload).not.toHaveProperty('routineSubscriptionIntent'); expect(posts()).toHaveLength(0);
  }, 90000);

  it('defers missing A ownership despite current/bare B and recovers through the real code2session ownership writer', async () => {
    expect(missingOwnerEffects.sms).toHaveLength(1); expect(missingOwnerEffects.inbox).toHaveLength(1);
    const source = await staged(missingOwner); expect(await effects(source)).toEqual(missingOwnerEffects); expect(source.delivery.target).toBe(TARGET);
    expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('posts actual Admin request3 to original A1451 and retains a stable immutable Admin operation receipt', async () => {
    const source = await staged(await adminRefusal()); await signed(source);
    expect((await f.maintenanceDb.select().from(systemConfig).where(eq(systemConfig.menuName, 'routine_appId')))[0].value).toBe(JSON.stringify(CURRENT_B));
    expect((await f.maintenanceDb.select().from(notificationTemplate).where(eq(notificationTemplate.mark, '1451')))[0].tempid).toBe(GLOBAL_B);
    provider(); const queue = await queued(source); expect(await consumer().processMessage(queue, network)).toBe('sent');
    expect(posts()).toHaveLength(1); const [attempt] = await attempts(source), [result] = await results(source);
    expect(attempt).toMatchObject({ attempt_no: 1, payload: { facts: { appId: ASSIGNED_APP, buyerUid: 11, templateMark: '1451' }, request: { touser: TARGET, template_id: TEMPLATE } } });
    expect(result).toMatchObject({ attempt_id: attempt.attempt_id, payload: { result: { code: 0 } } });
    expect(await consumer().processMessage(queue, network)).toBe('already-sent'); expect(posts()).toHaveLength(1);
  }, 90000);

  it('uses real Financial review/LOGIN/refusal and verifies its complete signed outbox payload before committing the immutable receipt', async () => {
    const { order, row } = await application(); await currentB();
    const service = new CustomerWorkFinancialService(createContainerFromDb(f.financialRuntime.db), f.env);
    const actor = { uid: 101, auth_version: md5('owned-financial-password'), expires_at: Math.floor(Date.now() / 1000) + 3600 };
    const reviewed = await service.reader.review(actor, row.id, { refund_no: row.orderId }), d = reviewed.data;
    expect(d.actions.refund_refuse.available).toBe(true);
    const body: FinancialInput = { version: CUSTOMER_FINANCIAL_VERSION, scope_key: reviewed.scope_key, order_id: order.id,
      expected_order_revision: d.order_revision, expected_financial_revision: d.financial_revision, payload: {
        refund_id: row.id, refund_no: row.orderId, expected_refund_revision: d.refund_revision, review_fingerprint: d.review_fingerprint,
        decision: { apply_type: d.apply_type, refund_type: d.refund_type, received: false }, reason: REASON,
      } };
    const ctx = { actor, request_key: randomUUID() }, first = await service.execute('refund_refuse', ctx, body);
    expect(first.receipt).toMatchObject({ actor_uid: 101, request_key: ctx.request_key, kind: 'refund_refuse', outcome: 'refused', evidence: { refund_id: row.id, verified: true } });
    const source = { orderId: order.id, refundId: row.id, event: await eventFor(row.id) }; await signed(source, f.financialRuntime.role);
    expect((await service.execute('refund_refuse', ctx, body)).receipt).toEqual(first.receipt);
    expect(await eventFor(row.id)).toEqual(source.event);
    const [stored] = await f.maintenanceDb.execute<any>(sql`SELECT * FROM public.customer_financial_operation_request WHERE actor_uid=101 AND request_key=${ctx.request_key}::uuid`);
    expect(stored).toBeTruthy();
    for (const role of [f.adminRuntime.role, f.financialRuntime.role]) {
      const access = await f.maintenanceDb.execute<{ readable: boolean }>(sql`SELECT pg_catalog.has_table_privilege(${role},c.oid,'SELECT') AS readable FROM pg_catalog.pg_class c
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN('routine_original_payment_evidence','routine_identity_ownership','routine_subscription_account_policy')`);
      expect(access).toHaveLength(3); expect(access.every(x => x.readable === false)).toBe(true);
    }
    provider(); expect(await consumer().processMessage(await queued(await staged(source)), network)).toBe('sent'); expect(posts()).toHaveLength(1);
  }, 90000);

  it('preserves an old rejected application through an actual new buyer reapplication and its new quantity hold', async () => {
    const source = await adminRefusal(), original = clone(source.event.payload), previous = clone(await refund(source.refundId));
    const response = await f.http('/order/refund/again/' + source.refundId, {}, { uid: 11 });
    expect(response.body.status, response.body.msg).toBe(200); const nextId = response.body.data.refundId as number;
    expect(nextId).not.toBe(source.refundId); expect(await refund(source.refundId)).toEqual(previous);
    expect(await refund(nextId)).toMatchObject({ storeOrderId: source.orderId, refundType: 0, uid: 11 });
    const carts = await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, source.orderId));
    // Current cart holds belong to the new application. The mature buyer
    // author need not reset the order's legacy refundType projection.
    expect(carts[0].refundNum).toBe(1);
    const prepared = await staged(source); expect((await eventFor(source.refundId)).payload).toEqual(original);
    provider(); expect(await consumer().processMessage(await queued(prepared), network)).toBe('sent'); expect(posts()).toHaveLength(1);
  }, 90000);

  it('does not substitute shipping-only approval or global B when original A1451 is unapproved', async () => {
    await approve({ templates: [{ mark: '1458', templateId: 'approved_shipping_notification_only' }] });
    try {
      const source = await adminRefusal(); await signed(source);
      expect((await f.maintenanceDb.execute(sql`SELECT account_id FROM public.routine_shipping_account_policy`)).length).toBeGreaterThan(0);
      expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await routine(source)).toHaveLength(0);
      expect((await effects(source)).sms).toHaveLength(1); expect(network).not.toHaveBeenCalled();
      await approve(); expect((await staged(source)).delivery.templateCode).toBe(TEMPLATE);
    } finally { await approve(); }
  }, 90000);

  it('keeps request and staged intent signatures unchanged on the original business key and App replay', async () => {
    const source = await staged(await adminRefusal()), before = clone(await eventFor(source.refundId)), rows = clone(await routine(source));
    const p = source.event.payload as OrderRefundRefusedNoticeOutboxPayload;
    await withTx(createContainerFromDb(f.adminRuntime.db), tx => enqueueOrderRefundRefusedNoticeEvent(tx, {
      orderId: p.orderId, orderNo: p.orderNo, refundId: p.refundId, userId: p.userId, payPrice: p.payPrice,
    }, source.event.addTime + 1, f.env));
    expect(await eventFor(source.refundId)).toEqual(before);
    await withTx(app(), tx => processOrderNotificationOutboxEvent(tx, before, source.event.addTime + 1));
    expect(await routine(source)).toEqual(rows); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('isolates partial Dispatch catalog into immutable unavailable3 and never upgrades it after repair', async () => {
    let source!: Source, saved!: Awaited<ReturnType<typeof effects>>, payload!: Event['payload'];
    // Fault DDL only; never a business approval or sending positive.
    await f.maintenanceDb.execute(sql`CREATE INDEX rsnd_refusal_test_partial ON public.routine_subscribe_result(attempt_id)`);
    try {
      source = await adminRefusal(); payload = clone(source.event.payload);
      expect(payload).toHaveProperty('routineSubscriptionRequest', { format: 3, unavailable: true }); expect(payload).not.toHaveProperty('routineAppId');
      expect(await outbox().processMessage(message(source.event))).toBe('completed');
      expect(await routine(source)).toMatchObject([{ status: 'SKIPPED', target: '', templateCode: '' }]);
      saved = await effects(source); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1);
    } finally { await f.maintenanceDb.execute(sql`DROP INDEX public.rsnd_refusal_test_partial`); }
    const p = source.event.payload as OrderRefundRefusedNoticeOutboxPayload;
    await withTx(createContainerFromDb(f.adminRuntime.db), tx => enqueueOrderRefundRefusedNoticeEvent(tx, {
      orderId: p.orderId, orderNo: p.orderNo, refundId: p.refundId, userId: p.userId, payPrice: p.payPrice,
    }, source.event.addTime + 1, f.env));
    expect((await eventFor(source.refundId)).payload).toEqual(payload); expect(await outbox().processMessage(message(source.event))).toBe('already-completed');
    expect(await effects(source)).toEqual(saved); expect((await routine(source))[0].payload).not.toHaveProperty('routineSubscriptionIntent'); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('retains committed SMS/inbox through private source lock refusal and changed render inputs, then recovers once', async () => {
    const source = await adminRefusal(); let saved!: Awaited<ReturnType<typeof effects>>;
    const [profile] = await f.maintenanceDb.select({ phone: storeOrder.userPhone }).from(storeOrder).where(eq(storeOrder.id, source.orderId));
    const [template] = await f.maintenanceDb.select().from(systemNotification).where(eq(systemNotification.mark, MARK));
    try {
      await hold(tx => tx.execute(sql`LOCK TABLE ONLY public.routine_original_payment_evidence IN ACCESS EXCLUSIVE MODE NOWAIT`), async () => {
        expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await routine(source)).toHaveLength(0);
        saved = await effects(source); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1);
        const event = await eventFor(source.refundId), now = Math.floor(Date.now() / 1000);
        expect(event).toMatchObject({ status: 'FAILED', leaseToken: '', leaseUntil: 0, attemptCount: 1 });
        expect(event.availableTime).toBeGreaterThan(now); expect(event.availableTime).toBeLessThanOrEqual(now + 300);
        // Explicit maintenance mutation of the actual SMS target input between
        // partial staging and replay. It is not a new business source author.
        await f.maintenanceDb.update(storeOrder).set({ userPhone: '13800000099' }).where(eq(storeOrder.id, source.orderId));
        await f.maintenanceDb.update(systemNotification).set({ systemTitle: 'later refusal render', systemText: 'later text', smsId: 'later_sms' }).where(eq(systemNotification.id, template.id));
        expect(await retry(source)).toBe('deferred'); expect(await effects(source)).toEqual(saved);
      });
    } finally {
      await f.maintenanceDb.update(storeOrder).set({ userPhone: profile.phone }).where(eq(storeOrder.id, source.orderId));
      await f.maintenanceDb.update(systemNotification).set({ systemTitle: template.systemTitle, systemText: template.systemText, smsId: template.smsId }).where(eq(systemNotification.id, template.id));
    }
    expect((await staged(source)).delivery.payload).toHaveProperty('routineSubscriptionIntent'); expect(await effects(source)).toEqual(saved);
    expect(saved.sms[0].addTime).toBe(source.event.addTime); expect(saved.inbox[0].addTime).toBe(source.event.addTime); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rolls late intent SQL failure back to no Routine row while retaining other channels, then creates one intent', async () => {
    const source = await adminRefusal(); let saved!: Awaited<ReturnType<typeof effects>>;
    await f.maintenanceDb.execute(sql.raw(`CREATE FUNCTION public.refusal_test_intent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_key='${source.event.eventKey}' AND NEW.payload ? 'routineSubscriptionIntent' THEN RAISE EXCEPTION 'controlled refusal intent failure'; END IF; RETURN NEW; END $$`));
    await f.maintenanceDb.execute(sql.raw('CREATE TRIGGER refusal_test_intent_failure BEFORE UPDATE ON public.order_notification_delivery FOR EACH ROW EXECUTE FUNCTION public.refusal_test_intent_failure()'));
    try {
      expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await routine(source)).toHaveLength(0);
      saved = await effects(source); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1);
    } finally {
      await f.maintenanceDb.execute(sql.raw('DROP TRIGGER refusal_test_intent_failure ON public.order_notification_delivery'));
      await f.maintenanceDb.execute(sql.raw('DROP FUNCTION public.refusal_test_intent_failure()'));
    }
    const repaired = await staged(source); expect(await routine(source)).toHaveLength(1); expect(await effects(source)).toEqual(saved);
    expect(repaired.delivery.payload).toHaveProperty('routineSubscriptionIntent.format', 3); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('defers missing consumer signing material and resumes the same request without rewriting other channels', async () => {
    const source = await adminRefusal(), original = clone(source.event.payload), key = f.env.APP_KEY; let saved!: Awaited<ReturnType<typeof effects>>;
    try {
      f.env.APP_KEY = ''; expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await routine(source)).toHaveLength(0);
      saved = await effects(source); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1);
    } finally { f.env.APP_KEY = key; }
    await staged(source); expect((await eventFor(source.refundId)).payload).toEqual(original); expect(await effects(source)).toEqual(saved); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rejects request MAC/key/database and actual decision/UID/refund/time tampering without borrowing A', async () => {
    for (const kind of ['mac', 'key', 'database', 'decision', 'uid', 'refund', 'time'] as const) {
      const source = await adminRefusal(), payload = clone(source.event.payload as OrderRefundRefusedNoticeOutboxPayload), original = payload.routineSubscriptionRequest!;
      if ('unavailable' in original) throw Error('Actual refusal author unavailable');
      const { signature: _signature, ...unsigned } = original;
      // Explicit corrupted/MAC-valid structural specimens, never positives.
      if (kind === 'mac') payload.routineSubscriptionRequest = { ...original, signature: '0'.repeat(64) };
      else if (kind === 'key') payload.routineSubscriptionRequest = { ...unsigned, signature: subscriptionMac({ APP_KEY: 'wrong-refusal-key' }, 'refusal-notice-request', unsigned) };
      else {
        const damaged = { ...unsigned, scope: { ...unsigned.scope }, body: { ...unsigned.body }, decision: { ...unsigned.decision } };
        if (kind === 'database') damaged.scope.databaseOid = '4294967294';
        if (kind === 'decision') damaged.decision.refuseReason = 'changed decision';
        if (kind === 'uid') damaged.body.userId = 22;
        if (kind === 'refund') { damaged.body.refundId++; damaged.eventKey = 'order.refund.refused.notice:' + damaged.body.refundId; }
        if (kind === 'time') { damaged.eventTime++; damaged.decision.refundedTime++; }
        payload.routineSubscriptionRequest = { ...damaged, signature: subscriptionMac(f.env, 'refusal-notice-request', damaged) };
      }
      await f.maintenanceDb.update(storeOrderOutbox).set({ payload }).where(eq(storeOrderOutbox.id, source.event.id));
      const outcome = await outbox().processMessage(message(source.event));
      if (kind === 'mac' || kind === 'key' || kind === 'database') {
        expect(outcome).toBe('completed'); expect(await routine(source)).toMatchObject([{ status: 'SKIPPED', target: '', templateCode: '' }]);
      } else { expect(outcome).toBe('deferred'); expect(await routine(source)).toHaveLength(0); }
      expect((await effects(source)).sms).toHaveLength(1); expect(network).not.toHaveBeenCalled();
    }
  }, 150000);

  it('rechecks the actual public refusal decision rather than trusting a previously valid signed request', async () => {
    const source = await adminRefusal(), row = await refund(source.refundId);
    // Isolated mutable public-row negative, not a refusal author.
    await f.maintenanceDb.update(storeOrderRefund).set({ refuseReason: 'changed public decision' }).where(eq(storeOrderRefund.id, row.id));
    try { expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await routine(source)).toHaveLength(0); }
    finally { await f.maintenanceDb.update(storeOrderRefund).set({ refuseReason: row.refuseReason }).where(eq(storeOrderRefund.id, row.id)); }
    expect((await staged(source)).delivery.target).toBe(TARGET); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rejects revoked A policy and modified staged intent before token/admission/POST', async () => {
    const source = await staged(await adminRefusal()); await approve({ state: 'revoked' });
    try { provider(); expect(await consumer().processMessage(await queued(source), network)).toBe('dead'); expect(await attempts(source)).toHaveLength(0); expect(network).not.toHaveBeenCalled(); }
    finally { await approve(); }
    const other = await staged(await adminRefusal()), payload = clone(other.delivery.payload as WechatTemplateNotificationPayload);
    payload.routineSubscriptionIntent = { ...payload.routineSubscriptionIntent!, signature: '0'.repeat(64) };
    await f.maintenanceDb.update(orderNotificationDelivery).set({ payload }).where(eq(orderNotificationDelivery.id, other.delivery.id));
    provider(); expect(await consumer().processMessage(await queued(other), network)).toBe('dead'); expect(await attempts(other)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('keeps an actual lost A1451 POST UNKNOWN with the original one attempt on Queue replay', async () => {
    const source = await staged(await adminRefusal()); provider(true); const queue = await queued(source);
    expect(await consumer().processMessage(queue, network)).toBe('unknown'); const before = clone(await attempts(source));
    expect(before).toHaveLength(1); expect(await results(source)).toHaveLength(0); expect(posts()).toHaveLength(1);
    expect(await consumer().processMessage(queue, network)).toBe('unknown'); expect(await attempts(source)).toEqual(before);
    expect(await results(source)).toHaveLength(0); expect(posts()).toHaveLength(1);
  }, 90000);

  it('does not borrow a separately commissioned actual refund_request/query/notify approval for subscription_send', async () => {
    // A one-time formal late commissioning, retaining every source peer/reader
    // declaration. No raw DDL/grant/policy INSERT is used as an approval positive.
    expect(await runRoutineRefundUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders)).toMatchObject({ applied: true });
    const ref = 'refusal_refund_only_materials', accountId = 'refusal_refund_only_account';
    f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = JSON.stringify({ format: 1, credentials: [{ ref, version: 1,
      appId: ASSIGNED_APP, merchantId: ASSIGNED_MERCHANT, serialNo: 'A1B2C3D4', apiV3Key: ASSIGNED_AES,
      privateKey: f.env.WECHAT_MCH_PRIVATE_KEY, platformPublicKey: f.env.WECHAT_PLATFORM_PUBLIC_KEY, platformPublicKeyId: ASSIGNED_PLATFORM }] });
    const commitment = routinePaymentCredentialCommitment(f.env, ref, 1), now = Math.floor(Date.now() / 1000);
    const approved = await appendRoutineRefundAccountPolicy(f.maintenanceDb, f.env, named(), { operationId: randomUUID(), expectedRevision: 0,
      data: { accountId, state: 'active', appId: ASSIGNED_APP, merchantId: ASSIGNED_MERCHANT,
        credentialRef: ref, credentialVersion: 1, credentialStamp: commitment.credentialStamp,
        purposes: ['refund_request', 'refund_query', 'refund_notify'], validFrom: now - 60, validUntil: now + 3600 } });
    expect(approved).toMatchObject({ revision: 1, replayed: false });
    await approve({ templates: [{ mark: '1458', templateId: 'unrelated_subscription_template' }] });
    try {
      const source = await adminRefusal(); await signed(source);
      expect(await outbox().processMessage(message(source.event))).toBe('deferred'); expect(await routine(source)).toHaveLength(0);
      const saved = await effects(source); expect(saved.sms).toHaveLength(1); expect(saved.inbox).toHaveLength(1);
      expect(network).not.toHaveBeenCalled();
      await approve(); const repaired = await staged(source); expect(await effects(source)).toEqual(saved);
      provider(); expect(await consumer().processMessage(await queued(repaired), network)).toBe('sent'); expect(posts()).toHaveLength(1);
    } finally { await approve(); }
  }, 120000);
});
