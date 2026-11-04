/** Real five-LOGIN assisted checkout and Financial quote/create/request/query,
 * RSA/AES verification, immutable materialization, App staging and Queue send.
 * Only HTTP, KV and Queue transports are controlled locally; no live provider,
 * historical evidence adoption, deployment or SQL-authored business positive. */
import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { notificationTemplate, orderNotificationDelivery, storeOrder, storeOrderCartInfo, storeOrderOutbox,
  storeOrderRefund, storeOrderRefundPayment, storeOrderRefundSplit, storeProduct, storeProductAttrValue,
  systemConfig, systemMessage, systemNotification, user, wechatUser,
  type OrderRefundSuccessNoticeOutboxPayload, type WechatTemplateNotificationPayload } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { runRefundSuccessNoticeUpgrade } from '@/migrations/refundSuccessNotice';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { appendRoutineRefundAccountPolicy } from '@/services/payment/RoutineRefundAccountPolicy';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { CustomerWorkFinancialService } from '@/services/customer-work/CustomerWorkFinancialService';
import { authorizeCustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';
import { financialRevisions } from '@/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_QUOTE_VERSION, CUSTOMER_FINANCIAL_VERSION,
  type FinancialContext, type FinancialInput } from '@/services/customer-work/CustomerWorkFinancialProtocol';
import type { CustomerJson } from '@/services/customer-work/CustomerWorkOperationRequest';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment,
  routineSubscriptionScopeTx, type RoutineSubscriptionAccountPolicy } from '@/services/wechat/RoutineSubscriptionAccount';
import { parseRoutineSubscriptionMaterializedRefundSuccessRequest } from '@/services/wechat/RoutineSubscriptionMaterializedRefundSuccessRequest';
import { parseRoutineSubscriptionNoticeIntent } from '@/services/wechat/RoutineSubscriptionNoticeIntent';
import { assertRoutineNotificationContinuation } from './helpers/routineNotificationContinuationAssertions';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

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

const APP = 'wx_materialized_refund_A', CURRENT_B = 'wx_materialized_refund_B', MERCHANT = '1900000001';
const REF = 'materialized_refund_materials_A', ACCOUNT = 'materialized_refund_account_A', SERIAL = 'A1B2C3D4', PLATFORM = 'PUB_MATERIALIZED_A';
const AES = 'm'.repeat(32), PAYER = 'materialized_payer_A_not_buyer', TARGET = 'materialized_owned_buyer_A', BARE_B = 'materialized_bare_buyer_B';
const TEMPLATE = 'materialized_1451_A', GLOBAL_B = 'materialized_1451_global_B', OFFICIAL = 'materialized_48058_template';
const SUB_REF = 'materialized_subscription_A', SECRET = 'synthetic-materialized-subscription-secret-A', PHONE = '13800000011';
const ORIGIN = 'https://materialized-refund-fixture.example', MARK = 'order_refund';
type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Keys = ReturnType<typeof paymentQueryKeys>;
type Event = typeof storeOrderOutbox.$inferSelect;
type Delivery = typeof orderNotificationDelivery.$inferSelect;
type Order = typeof storeOrder.$inferSelect;
type Prepared = { refundId: number; sourceId: number; root: Order; body: FinancialInput; ctx: FinancialContext; quotePrice: string; actualAmount: string };
type Source = Prepared & { orderId: number; event: Event; split: typeof storeOrderRefundSplit.$inferSelect };
type Staged = Source & { delivery: Delivery };
type Dispatch = { dispatch_id: string; out_refund_no: string; payload: { actor: { kind: string; actorUid: number; requestKey: string };
  request: { outTradeNo: string; transactionId: string; outRefundNo: string; refundAmount: number; totalAmount: number } } };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function envelope(keys: Keys, payload: unknown) {
  const nonce = Buffer.from(randomBytes(6)).toString('hex'), associated = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(AES), Buffer.from(nonce)); cipher.setAAD(Buffer.from(associated));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const body = JSON.stringify({ id: randomUUID(), event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource',
    resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', ciphertext, nonce, associated_data: associated } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { body, headers: { 'content-type': 'application/json', 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
    'wechatpay-serial': PLATFORM, 'wechatpay-signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), keys.privateKey)).toString('base64') } };
}
function signedResponse(keys: Keys, value: unknown) {
  const body = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'materialized-result-' + randomUUID();
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Wechatpay-Timestamp': timestamp,
    'Wechatpay-Nonce': nonce, 'Wechatpay-Serial': PLATFORM,
    'Wechatpay-Signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), keys.privateKey)).toString('base64') } });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual Financial materialized refund-success original-account notification chain', () => {
  let f: Fixture, keys: Keys, service: CustomerWorkFinancialService, refundPosts = 0;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>, policy: RoutineSubscriptionAccountPolicy, revision = 0;
  const app = () => createContainerFromDb(f.appRuntime.db);
  const outbox = () => new OrderOutboxService(app(), f.env);
  const consumer = () => new OrderNotificationDeliveryService(app(), f.env);
  const named = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
  const context = (request_key = randomUUID()): FinancialContext => ({ actor: f.actor(), request_key });
  const order = async (id: number) => (await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, id)))[0]!;
  const refund = async (id: number) => (await f.maintenanceDb.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, id)))[0]!;
  const split = async (id: number) => (await f.maintenanceDb.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, id)))[0]!;
  const approve = async (patch: Partial<RoutineSubscriptionAccountPolicy> = {}) => {
    const result = await appendRoutineSubscriptionAccountPolicy(f.maintenanceDb, f.env, named(),
      { operationId: randomUUID(), expectedRevision: revision, data: { ...policy, ...patch } }); revision = result.revision; return result;
  };
  const input = async (payload: CustomerJson, id: number): Promise<FinancialInput> => {
    const actual = await order(id), scope = await authorizeCustomerWorkActor(f.financialRuntime.db, f.actor()), state = await financialRevisions(f.financialRuntime.db, actual);
    return { version: CUSTOMER_FINANCIAL_VERSION, scope_key: scope.scope_key, order_id: id,
      expected_order_revision: state.order_revision, expected_financial_revision: state.financial_revision, payload };
  };
  async function currentB() {
    const values = { routine_appId: CURRENT_B, routine_appsecret: 'synthetic-current-B', wechat_appid: CURRENT_B,
      pay_weixin_mchid: '1900000002', pay_weixin_serial_no: 'B1B2B3B4', pay_weixin_open: 1, order_shipping_open: 0,
      site_url: 'https://materialized-current-B.example' };
    await f.setConfig(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])));
    await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName, Object.keys(values)));
    await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 20 })));
  }
  async function originalPaid(quantity = 3): Promise<Order> {
    const created = await f.unpaid(11, '5.00', quantity), before = f.messages.length;
    const signed = envelope(keys, { appid: APP, mchid: MERCHANT, out_trade_no: created.order.orderId,
      transaction_id: 'materialized_original_tx_' + randomUUID().replaceAll('-', ''), trade_state: 'SUCCESS', trade_type: 'JSAPI',
      payer: { openid: PAYER }, success_time: new Date().toISOString(), amount: { total: quantity * 500, currency: 'CNY' } });
    const h = new Hono<{ Bindings: Env; Variables: AppVariables }>(), pending: Promise<unknown>[] = [];
    h.use('*', async (c, next) => { c.set('container', app()); await next(); }); h.onError(errorHandler); h.route('/api', v1Routes);
    const response = await h.request('/api/pay/notify/routine-account/' + ACCOUNT, { method: 'POST', headers: signed.headers, body: signed.body }, f.env,
      { waitUntil: (promise: Promise<unknown>) => pending.push(promise), props: {}, passThroughOnException: () => { throw Error('Unexpected callback fallback'); } });
    await Promise.all(pending); expect(response.status).toBe(200);
    const callback = f.messages.slice(before).find(isPaymentCallbackMessage); expect(callback).toBeDefined();
    expect(await new PaymentCallbackEventService(app(), f.env).processMessage(callback!)).toBe('completed');
    const actual = await order(created.order.id); expect(actual).toMatchObject({ paid: 1, payType: 'weixin', payPrice: (quantity * 5).toFixed(2), uid: 11 });
    const rows = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, actual.id), eq(storeOrderOutbox.eventType, 'order.paid')));
    expect(rows).toHaveLength(1); await f.consume({ id: rows[0].id, eventKey: rows[0].eventKey }); return actual;
  }
  async function prepare(sourceId?: number, root?: Order, actualAmount = '3.00', whole = false): Promise<Prepared> {
    root ??= await originalPaid(); sourceId ??= root.id;
    const carts = await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, sourceId)); expect(carts).toHaveLength(1);
    const items = [{ cart_row_id: carts[0].id, cart_num: whole ? carts[0].cartNum : 1 }], base = await input({}, sourceId);
    const quote = (await service.reader.quote(f.actor(), { version: CUSTOMER_FINANCIAL_QUOTE_VERSION, scope_key: base.scope_key,
      order_id: sourceId, expected_order_revision: base.expected_order_revision, expected_financial_revision: base.expected_financial_revision,
      mode: whole ? 'remaining' : 'items', items: whole ? [] : items })).data;
    const created = await service.create(context(), await input({ mode: whole ? 'remaining' : 'items', items: whole ? [] : items,
      quoted_price: quote.quoted_price, refund_price: actualAmount, quote_fingerprint: quote.quote_fingerprint,
      reason: '真实Financial退款：保持原付款与所选实体的独立金额' }, sourceId));
    expect(created.receipt?.outcome).toBe('refund-created');
    const refundId = Number(created.receipt!.evidence.refund_id), row = await refund(refundId);
    expect(row).toMatchObject({ storeOrderId: sourceId, uid: 11, applyType: 4, applyPrice: actualAmount, refundPrice: actualAmount, refundType: 0 });
    expect(JSON.parse(row.cartInfo!).quantityReservation.version).toBe('refund-quantity-customer-row-v3');
    const review = (await service.reader.review(f.actor(), refundId, { refund_no: row.orderId })).data;
    const body = await input({ refund_id: refundId, refund_no: review.refund_no, expected_refund_revision: review.refund_revision,
      review_fingerprint: review.review_fingerprint, decision: { apply_type: review.apply_type, refund_type: review.refund_type, received: false },
      refund_price: review.refund_price }, sourceId);
    return { refundId, sourceId, root, body, ctx: context(), quotePrice: quote.quoted_price, actualAmount };
  }
  function refundProvider(p: Prepared) {
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.mch.weixin.qq.com');
      const auth = new Headers(init?.headers).get('Authorization') ?? '';
      const fields = Object.fromEntries([...auth.matchAll(/(\w+)="([^"]+)"/gu)].map(m => [m[1], m[2]]));
      expect(fields.mchid).toBe(MERCHANT); expect(fields.serial_no).toBe(SERIAL);
      expect(verify('RSA-SHA256', Buffer.from(`${init?.method}\n${url.pathname}${url.search}\n${fields.timestamp}\n${fields.nonce_str}\n${typeof init?.body === 'string' ? init.body : ''}\n`),
        keys.publicKey, Buffer.from(fields.signature, 'base64'))).toBe(true);
      const [dispatch] = await f.maintenanceDb.execute<Dispatch>(sql`SELECT dispatch_id,out_refund_no,payload FROM public.routine_refund_dispatch WHERE refund_id=${p.refundId}`);
      expect(dispatch.payload.actor).toMatchObject({ kind: 'financial', actorUid: 101, requestKey: p.ctx.request_key });
      const facts = dispatch.payload.request;
      expect(facts).toMatchObject({ outTradeNo: p.root.orderId, transactionId: p.root.tradeNo, totalAmount: Number(p.root.payPrice) * 100,
        refundAmount: Number(p.actualAmount) * 100 });
      if (init?.method === 'POST') { refundPosts++; expect(JSON.parse(String(init.body))).toMatchObject({ out_refund_no: 'CNSR' + p.refundId,
        transaction_id: p.root.tradeNo, amount: { refund: facts.refundAmount, total: facts.totalAmount, currency: 'CNY' } }); }
      else { expect(init?.method).toBe('GET'); expect(url.pathname).toContain(dispatch.out_refund_no); }
      const [idle] = await f.maintenanceDb.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE usename IN(${f.financialRuntime.role},${f.appRuntime.role}) AND state='idle in transaction'`); expect(idle.n).toBe(0);
      const status = init?.method === 'POST' ? 'PROCESSING' : 'SUCCESS';
      return signedResponse(keys, { mchid: MERCHANT, out_trade_no: facts.outTradeNo, transaction_id: facts.transactionId,
        out_refund_no: dispatch.out_refund_no, refund_id: 'provider_' + dispatch.out_refund_no, status,
        ...(status === 'SUCCESS' ? { success_time: new Date().toISOString() } : {}),
        amount: { refund: facts.refundAmount, total: facts.totalAmount, currency: 'CNY' } });
    });
  }
  async function admit(p: Prepared) {
    refundProvider(p); const admitted = await service.execute('refund_execute', p.ctx, p.body);
    expect(admitted).toMatchObject({ receipt: { outcome: 'provider-admitted' }, execution: { status: 'PROCESSING', completed: false } });
    expect(await f.maintenanceDb.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, p.refundId))).toHaveLength(0);
    return admitted;
  }
  async function finish(p: Prepared): Promise<Source> {
    const done = await service.execute('refund_execute', p.ctx, p.body);
    expect(done).toMatchObject({ receipt: { outcome: 'provider-admitted' }, execution: { status: 'SUCCESS', completed: true, verified: true } });
    const physical = await split(p.refundId); expect(physical).toBeDefined();
    const rows = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, 'order.refund.success.notice:' + p.refundId));
    expect(rows).toHaveLength(1); const event = rows[0];
    expect(physical).toMatchObject({ sourceOrderId: p.sourceId, paymentOrderId: p.root.id, uid: 11 });
    const selected = await order(physical.selectedOrderId), r = await refund(p.refundId);
    expect(r).toMatchObject({ storeOrderId: p.sourceId, refundedPrice: p.actualAmount, refundType: 6, refundedTime: event.addTime });
    const payload = event.payload as OrderRefundSuccessNoticeOutboxPayload;
    const request = parseRoutineSubscriptionMaterializedRefundSuccessRequest(f.env, payload.routineSubscriptionRequest, await routineSubscriptionScopeTx(f.maintenanceDb));
    expect(request).toMatchObject({ format: 6, actor: { role: f.financialRuntime.role }, aggregateId: selected.id, eventTime: event.addTime,
      body: { orderId: selected.id, orderNo: r.orderId, refundId: r.id, userId: 11, payPrice: selected.payPrice,
        materializedRefund: { sourceOrderId: p.sourceId, paymentOrderId: p.root.id, refundAmount: p.actualAmount } },
      decision: { refundType: 6, refundedTime: event.addTime, refundAmount: p.actualAmount } });
    expect(request.decision.materializationDigest).toMatch(/^[a-f0-9]{64}$/u); expect(request.decision.selectedDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(payload).not.toHaveProperty('routineAppId');
    const stable = clone(event); expect((await service.execute('refund_execute', p.ctx, p.body)).receipt).toEqual(done.receipt);
    expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, event.id)))[0]).toEqual(stable);
    network.mockReset().mockRejectedValue(Error('Unexpected local provider call'));
    return { ...p, orderId: selected.id, event, split: physical };
  }
  async function completed() { const p = await prepare(); await admit(p); return finish(p); }
  const routine = (s: Source) => f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, s.event.eventKey), eq(orderNotificationDelivery.channel, 'wechat_routine')));
  async function effects(s: Source) {
    return { sms: await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, s.event.eventKey), eq(orderNotificationDelivery.channel, 'sms'))),
      inbox: await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey, s.event.eventKey)),
      official: await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, s.event.eventKey), eq(orderNotificationDelivery.channel, 'wechat_official'))) };
  }
  async function retry(s: Source) {
    await f.maintenanceDb.update(storeOrderOutbox).set({ availableTime: 0 }).where(eq(storeOrderOutbox.id, s.event.id));
    return outbox().processMessage({ action: 'processOrderNotificationOutbox', outboxId: s.event.id, eventKey: s.event.eventKey });
  }
  async function staged(s: Source): Promise<Staged> {
    expect(await retry(s)).toBe('completed'); const rows = await routine(s); expect(rows).toHaveLength(1); const delivery = rows[0];
    expect(delivery).toMatchObject({ status: 'PENDING', target: TARGET, templateCode: TEMPLATE, payload: {
      kind: 'wechat_routine', routineAppId: APP, routineSubscriptionIntent: { format: 6, outboxId: s.event.id, deliveryId: delivery.id,
        eventKey: s.event.eventKey, source: { appId: APP, buyerUid: 11, templateMark: '1451' } } } });
    const intent = (delivery.payload as WechatTemplateNotificationPayload).routineSubscriptionIntent;
    expect(parseRoutineSubscriptionNoticeIntent(f.env, intent, await routineSubscriptionScopeTx(f.maintenanceDb))).toEqual(intent);
    return { ...s, delivery };
  }
  async function queued(s: Staged) {
    const before = f.messages.length; expect((await consumer().dispatchPending(50, s.event.eventKey)).enqueued).toBeGreaterThan(0);
    const messages = f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m => m.deliveryId === s.delivery.id);
    expect(messages).toHaveLength(1); return messages[0];
  }
  function provider(s: Source, lost = false) {
    for (const key of transport.values.keys()) if (key.startsWith('routine:subscription:')) transport.values.delete(key);
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.weixin.qq.com'); expect(init?.redirect).toBe('error');
      const [idle] = await f.maintenanceDb.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE usename IN(${f.appRuntime.role},${f.financialRuntime.role}) AND state='idle in transaction'`); expect(idle.n).toBe(0);
      if (url.pathname === '/cgi-bin/token') {
        expect(init?.method).toBe('GET'); expect(url.searchParams.get('appid')).toBe(APP); expect(url.searchParams.get('secret')).toBe(SECRET);
        return Response.json({ access_token: 'synthetic-materialized-A-token', expires_in: 7200 });
      }
      expect(url.pathname).toBe('/cgi-bin/message/subscribe/send'); expect(init?.method).toBe('POST');
      expect(url.searchParams.get('access_token')).toBe('synthetic-materialized-A-token');
      const selected = await order(s.orderId), r = await refund(s.refundId);
      expect(JSON.parse(String(init?.body))).toMatchObject({ touser: TARGET, template_id: TEMPLATE,
        page: '/pages/goods/order_after_details/index?order_id=' + r.orderId + '&isReturen=1',
        data: { thing1: { value: '已成功退款' }, amount3: { value: selected.payPrice }, character_string6: { value: r.orderId } } });
      expect(String(init?.body)).not.toContain(PAYER); expect(String(init?.body)).not.toContain(BARE_B);
      if (lost) throw Error('Controlled lost response after actual local Mini POST'); return Response.json({ errcode: 0 });
    });
  }
  const posts = () => network.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/cgi-bin/message/subscribe/send');
  const attempts = (s: Staged) => f.maintenanceDb.execute<any>(sql`SELECT * FROM public.routine_subscribe_attempt WHERE delivery_id=${s.delivery.id} ORDER BY attempt_no`);
  const results = (s: Staged) => f.maintenanceDb.execute<any>(sql`SELECT r.* FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${s.delivery.id}`);
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected external provider transport'));
    keys = paymentQueryKeys(); f = await customerCashierRuntimeHttpFixture();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineSubscriptionUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineRefundUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    const finance = await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb, f.target,
      { routineRefund: { routineRefund: true }, manualRefund: f.manual, originalPaymentReaders: f.readers }, f.peers, f.appReaders);
    await runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, f.target, finance.peers, f.appReaders);
    await runRefundSuccessNoticeUpgrade(f.maintenanceDb);
    expect(new Set(await Promise.all([f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime].map(r => r.verify()))).size).toBe(5);
    for (const runtime of [f.financialRuntime, f.appRuntime]) {
      const [receiptPrivileges] = await runtime.db.execute(sql`SELECT
        has_table_privilege(current_user,'public.store_order_refund_split','SELECT') AS can_read,
        has_table_privilege(current_user,'public.store_order_refund_split','UPDATE') AS can_update,
        has_table_privilege(current_user,'public.store_order_refund_split','DELETE') AS can_delete,
        has_table_privilege(current_user,'public.store_order_refund_split','TRUNCATE') AS can_truncate`);
      expect(receiptPrivileges).toEqual({ can_read: true, can_update: false, can_delete: false, can_truncate: false });
    }
    f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS = JSON.stringify({ format: 1, credentials: [{ ref: REF, version: 1, appId: APP,
      merchantId: MERCHANT, serialNo: SERIAL, apiV3Key: AES, privateKey: keys.privateKey, platformPublicKey: keys.publicKey, platformPublicKeyId: PLATFORM }] });
    f.env.ROUTINE_REFUND_NOTIFY_ORIGIN = ORIGIN;
    const current = paymentQueryKeys();
    Object.assign(f.env, { WECHAT_MCH_PRIVATE_KEY: current.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: current.publicKey,
      WECHAT_PLATFORM_PUBLIC_KEY_ID: 'PUB_CURRENT_B', WECHAT_API_V3_KEY: 'b'.repeat(32),
      ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: JSON.stringify({ format: 1, credentials: [{ ref: SUB_REF, version: 1, appId: APP, secret: SECRET }] }) });
    const now = Math.floor(Date.now() / 1000), commitment = routinePaymentCredentialCommitment(f.env, REF, 1);
    await appendRoutinePaymentAccountPolicy(f.maintenanceDb, f.env, f.target, { operationId: randomUUID(), expectedRevision: 0, kind: 'account',
      data: { accountId: ACCOUNT, state: 'active', ...commitment, credentialRef: REF, credentialVersion: 1,
        purposes: ['query', 'notify'], validFrom: now - 60, validUntil: now + 3600 } });
    await appendRoutineRefundAccountPolicy(f.maintenanceDb, f.env, f.target, { operationId: randomUUID(), expectedRevision: 0,
      data: { accountId: ACCOUNT, state: 'active', ...commitment, credentialRef: REF, credentialVersion: 1,
        purposes: ['refund_request', 'refund_query', 'refund_notify'], validFrom: now - 60, validUntil: now + 3600 } });
    policy = { accountId: routineSubscriptionAccountId(f.env, APP), state: 'active', appId: APP, credentialRef: SUB_REF, credentialVersion: 1,
      credentialStamp: routineSubscriptionCredentialCommitment(f.env, SUB_REF, 1).credentialStamp, purposes: ['subscription_send'],
      templates: [{ mark: '1451', templateId: TEMPLATE }], validFrom: now - 60, validUntil: now + 3600 }; await approve();
    await f.maintenanceDb.update(storeProduct).set({ productType: 0, stock: 100, isSupportRefund: 1 }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ price: '5.00', vipPrice: '5.00', stock: 100 }).where(eq(storeProductAttrValue.id, 1));
    await f.maintenanceDb.update(user).set({ phone: PHONE }).where(eq(user.uid, 11));
    await f.maintenanceDb.insert(user).values({ uid: 22, account: 'owned-materialized-payer', pwd: 'owned-mat-payer-password', status: 1 }).onConflictDoNothing();
    await f.maintenanceDb.insert(wechatUser).values([{ uid: 22, userType: 'routine', openid: PAYER },
      { uid: 11, userType: 'routine', openid: TARGET }, { uid: 11, userType: 'routine', openid: BARE_B },
      { uid: 11, userType: 'wechat', openid: 'materialized_official_buyer' }]);
    const authConfig = { routine_appId: APP, routine_appsecret: SECRET };
    await f.setConfig(authConfig); await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName, Object.keys(authConfig)));
    await f.maintenanceDb.insert(systemConfig).values(Object.entries(authConfig).map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 20 })));
    network.mockImplementation(async input => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.weixin.qq.com'); expect(url.pathname).toBe('/sns/jscode2session');
      expect(url.searchParams.get('appid')).toBe(APP); return Response.json({ openid: TARGET, session_key: Buffer.from('0123456789abcdef').toString('base64') });
    });
    const auth = new WechatAuthService(app(), f.env), ticket = await auth.beginMiniProgramLogin({ code: randomUUID(), ip: '127.0.0.1' });
    const pending = transport.values.get('routine_login:' + ticket.key) as { identity: VerifiedSocialIdentity };
    expect(pending.identity.routineObservation).toMatchObject({ appId: APP, openid: TARGET });
    // Server-verified phone continuity fixture, not a fabricated ownership row.
    expect(await auth.reconcileVerifiedIdentity({ ...pending.identity, phone: PHONE })).toBe(11);
    await currentB();
    await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, MARK));
    await f.maintenanceDb.insert(systemNotification).values({ mark: MARK, isRoutine: 1, isWechat: 1, isSms: 1, isSystem: 1,
      smsId: 'synthetic_materialized_success_sms', systemTitle: '退款成功 {order_id}', systemText: '{store_name} 退款 {refund_price} 元' });
    await f.maintenanceDb.delete(notificationTemplate).where(inArray(notificationTemplate.mark, ['1451', '48058']));
    await f.maintenanceDb.insert(notificationTemplate).values([{ mark: '1451', legacyType: 0, status: 1, tempid: GLOBAL_B },
      { mark: '48058', legacyType: 1, status: 1, tempid: OFFICIAL }]);
    service = new CustomerWorkFinancialService(f.container, f.env);
    network.mockReset().mockRejectedValue(Error('Unexpected external provider transport'));
  }, 300000);
  afterEach(() => network.mockReset().mockRejectedValue(Error('Unexpected external provider transport')));
  afterAll(async () => { try { await f?.close(); } finally { vi.restoreAllMocks(); } }, 30000);

  it('uses actual Financial quote5/apply3/cash3 and selected5, with separate physical and refund display numbers', async () => {
    const s = await completed(); expect(s.quotePrice).toBe('5.00'); expect(s.actualAmount).toBe('3.00');
    const selected = await order(s.orderId), r = await refund(s.refundId); expect(selected.payPrice).toBe('5.00'); expect(r.applyPrice).toBe('3.00');
    expect(s.orderId).not.toBe(s.sourceId); expect(s.split.disposition).toBe('split'); expect(selected.orderId).not.toBe(r.orderId);
    const stagedSource = await staged(s), effectsBefore = await effects(s);
    expect(effectsBefore.sms).toHaveLength(1); expect(effectsBefore.inbox).toHaveLength(1); expect(effectsBefore.official).toHaveLength(1);
    expect(effectsBefore.sms[0].payload).toMatchObject({ params: { order_id: selected.orderId, refund_price: '3.00' } });
    expect(effectsBefore.inbox[0]).toMatchObject({ title: '退款成功 ' + selected.orderId }); expect(effectsBefore.inbox[0].content).toContain('3.00');
    expect(effectsBefore.official[0]).toMatchObject({ templateCode: OFFICIAL, payload: { data: { amount2: '3.00', character_string5: r.orderId } } });
    expect(stagedSource.delivery.payload).toMatchObject({ data: { amount3: '5.00', character_string6: r.orderId } });
    provider(s); const queuedMessage = await queued(stagedSource); expect(await consumer().processMessage(queuedMessage, network)).toBe('sent');
    expect(posts()).toHaveLength(1); expect(await attempts(stagedSource)).toHaveLength(1); expect(await results(stagedSource)).toHaveLength(1);
    expect(await consumer().processMessage(queuedMessage, network)).toBe('already-sent'); expect(posts()).toHaveLength(1);
    const after = await effects(s); expect(after.inbox).toEqual(effectsBefore.inbox); expect(after.sms).toHaveLength(1); expect(after.official).toHaveLength(1);
  }, 120000);

  it('retains root A through another real partial refund and the last whole physical remainder', async () => {
    const first = await completed(); expect(first.split.remainingOrderId).toBeGreaterThan(0);
    const secondPrepared = await prepare(first.split.remainingOrderId!, first.root, '5.00'); await admit(secondPrepared); const second = await finish(secondPrepared);
    expect(second.split).toMatchObject({ disposition: 'split', sourceOrderId: first.split.remainingOrderId, paymentOrderId: first.root.id,
      remainingOrderId: first.split.remainingOrderId });
    const finalPrepared = await prepare(second.split.remainingOrderId!, first.root, '5.00', true); await admit(finalPrepared); const last = await finish(finalPrepared);
    expect(last.split).toMatchObject({ disposition: 'whole', sourceOrderId: second.split.remainingOrderId, selectedOrderId: second.split.remainingOrderId,
      remainingOrderId: null, paymentOrderId: first.root.id });
    for (const s of [first, second, last]) {
      const sentBefore = posts().length;
      const row = await staged(s); provider(s); expect(await consumer().processMessage(await queued(row), network)).toBe('sent');
      expect((await attempts(row))[0].payload).toMatchObject({ facts: { appId: APP, buyerUid: 11, templateMark: '1451' } });
      expect(posts()).toHaveLength(sentBefore + 1);
    }
    expect(posts()).toHaveLength(3);
    expect(await order(first.root.id)).toMatchObject({ payPrice: '15.00', uid: 11, tradeNo: first.root.tradeNo });
    expect(new Set([first.event.eventKey, second.event.eventKey, last.event.eventKey]).size).toBe(3);
  }, 180000);

  it('defers only Mini without independent1451 approval and recovers without duplicating cash-specific channels', async () => {
    const s = await completed(); await approve({ templates: [{ mark: '1458', templateId: 'unrelated_materialized_template' }] });
    try {
      expect(await retry(s)).toBe('deferred'); expect(await routine(s)).toHaveLength(0);
      const before = await effects(s); expect(before.sms).toHaveLength(1); expect(before.inbox).toHaveLength(1); expect(before.official).toHaveLength(1);
      await approve(); const row = await staged(s); expect(await effects(s)).toEqual(before);
      provider(s); expect(await consumer().processMessage(await queued(row), network)).toBe('sent'); expect(posts()).toHaveLength(1);
    } finally { await approve(); }
  }, 120000);

  it('rechecks selected physical quantity and amount before an immutable Mini attempt', async () => {
    for (const patch of [{ totalNum: 2 }, { payPrice: '6.00' }]) {
      const source = await staged(await completed()), original = await order(source.orderId);
      // Explicit mutable public-row corruption; never a positive author.
      await f.maintenanceDb.update(storeOrder).set(patch).where(eq(storeOrder.id, source.orderId));
      try {
        provider(source); expect(await consumer().processMessage(await queued(source), network)).toBe('dead');
        expect(await attempts(source)).toHaveLength(0); expect(posts()).toHaveLength(0);
      } finally { await f.maintenanceDb.update(storeOrder).set({ totalNum: original.totalNum, payPrice: original.payPrice }).where(eq(storeOrder.id, source.orderId)); }
    }
  }, 180000);

  it('requires the authenticated original refund SUCCESS projection after format6 has been signed', async () => {
    const source = await staged(await completed());
    const [old] = await f.maintenanceDb.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId, source.refundId));
    await f.maintenanceDb.update(storeOrderRefundPayment).set({ providerRefundId: 'negative_changed_materialized_provider_projection' }).where(eq(storeOrderRefundPayment.refundId, source.refundId));
    try {
      provider(source); expect(await consumer().processMessage(await queued(source), network)).toBe('dead');
      expect(await attempts(source)).toHaveLength(0); expect(posts()).toHaveLength(0);
    } finally { await f.maintenanceDb.update(storeOrderRefundPayment).set({ providerRefundId: old.providerRefundId }).where(eq(storeOrderRefundPayment.refundId, source.refundId)); }
  }, 120000);

  it('keeps one immutable attempt and never repeats a Mini POST after UNKNOWN', async () => {
    const source = await staged(await completed()); provider(source, true); const queue = await queued(source);
    expect(await consumer().processMessage(queue, network)).toBe('unknown'); const saved = clone(await attempts(source));
    expect(saved).toHaveLength(1); expect(await results(source)).toHaveLength(0); expect(posts()).toHaveLength(1);
    expect(await consumer().processMessage(queue, network)).toBe('unknown'); expect(await attempts(source)).toEqual(saved); expect(posts()).toHaveLength(1);
  }, 120000);

  it('retains actual immutable materialization protection instead of editing receipt evidence for a positive', async () => {
    const source = await completed();
    const physical = () => f.maintenanceDb.execute<any>(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS xmin FROM public.store_order_refund_split t WHERE refund_id=${source.refundId}`);
    const before = clone(await physical());
    await expect(f.maintenanceDb.execute(sql`UPDATE public.store_order_refund_split SET selected_order_id=${source.root.id} WHERE refund_id=${source.refundId}`)).rejects.toThrow();
    expect(await physical()).toEqual(before); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rolls back Financial completion, materialization and notice on a genuine event INSERT failure then recovers the same request once', async () => {
    const p = await prepare(), postsBefore = refundPosts; const admitted = await admit(p), before = clone(await f.facts()), messages = f.messages.length;
    expect(refundPosts).toBe(postsBefore + 1);
    // Owned negative failure injection only. No business/result/receipt positive
    // is seeded, no existing protection is disabled, and cleanup is unconditional.
    const [sequenceBefore] = await f.maintenanceDb.execute<{value: string; called: boolean; step: string; cache: string}>(sql`SELECT last_value::text AS value,is_called AS called,
      (SELECT seqincrement::text FROM pg_sequence WHERE seqrelid='public.store_order_outbox_id_seq'::regclass) AS step,
      (SELECT seqcache::text FROM pg_sequence WHERE seqrelid='public.store_order_outbox_id_seq'::regclass) AS cache
      FROM public.store_order_outbox_id_seq`);
    expect(sequenceBefore).toMatchObject({ called: true, step: '1', cache: '1' });
    expect(sequenceBefore.value).toMatch(/^[1-9][0-9]*$/u);
    await f.maintenanceDb.execute(sql.raw(`CREATE FUNCTION public.phase62_fail_success_notice() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN PERFORM nextval(pg_get_serial_sequence('public.store_order_outbox','id')); RAISE EXCEPTION 'phase62_actual_success_notice_insert_failure'; END $body$`));
    await f.maintenanceDb.execute(sql.raw(`CREATE TRIGGER phase62_fail_success_notice BEFORE INSERT ON public.store_order_outbox FOR EACH ROW
      WHEN(NEW.event_type='order.refund.success.notice' AND NEW.event_key='order.refund.success.notice:${p.refundId}') EXECUTE FUNCTION public.phase62_fail_success_notice()`));
    try {
      const result = await service.execute('refund_execute', p.ctx, p.body); expect(result.receipt).toEqual(admitted.receipt);
      // The real INSERT consumes one default serial value; this actual BEFORE
      // trigger consumes a second value before raising. Neither nextval rolls
      // back, so +2 proves the event INSERT was reached in this isolated DB.
      const [hit] = await f.maintenanceDb.execute<{value: string}>(sql`SELECT last_value::text AS value FROM public.store_order_outbox_id_seq`);
      expect(hit.value).toBe(String(BigInt(sequenceBefore.value) + 2n));
      const [accepted] = await f.maintenanceDb.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId, p.refundId));
      expect(accepted).toMatchObject({ providerStatus: 'SUCCESS', requestAmount: 300 });
      expect(result.execution?.completed).toBe(false); expect(await f.facts()).toEqual(before); expect(f.messages).toHaveLength(messages);
      expect(await f.maintenanceDb.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, p.refundId))).toHaveLength(0);
      expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, 'order.refund.success.notice:' + p.refundId))).toHaveLength(0);
      expect(await refund(p.refundId)).toMatchObject({ refundType: 0, refundedPrice: '0.00' });
    } finally {
      await f.maintenanceDb.execute(sql`DROP TRIGGER phase62_fail_success_notice ON public.store_order_outbox`);
      await f.maintenanceDb.execute(sql`DROP FUNCTION public.phase62_fail_success_notice()`);
    }
    const source = await finish(p); expect(await f.maintenanceDb.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, p.refundId))).toHaveLength(1);
    expect(refundPosts).toBe(postsBefore + 1);
    const row = await staged(source); provider(source); expect(await consumer().processMessage(await queued(row), network)).toBe('sent'); expect(posts()).toHaveLength(1);
  }, 120000);

  it('classifies genuine format6 history read-only without send or switch authority', async () => {
    await assertRoutineNotificationContinuation(f, 6, () => [network.mock.calls.length, transport.get.mock.calls.length, transport.set.mock.calls.length,
      transport.remove.mock.calls.length, transport.take.mock.calls.length, transport.setIfAbsent.mock.calls.length, f.messages.length],
      [CURRENT_B, TARGET, BARE_B, PAYER, AES, PHONE, SECRET, TEMPLATE], false);
  }, 90000);
});
