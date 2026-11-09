/** Actual PG16 five LOGINs, Admin checkout/delivery, RSA/AES Routine payment,
 * paid/notice outboxes and code2Session-backed UID ownership. Phone continuity
 * is explicit server-verified test input, not an SMS/login-form acceptance.
 * Only HTTP/Redis/KV/Queue transports are controlled. Actual Queue claims,
 * source admission and immutable attempt/result writers remain unmocked. */
import { assertRoutineNotificationContinuation } from './helpers/routineNotificationContinuationAssertions';
import { Buffer } from 'node:buffer';
import { createCipheriv, createHmac, randomBytes, randomUUID, sign } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import * as Di from '@/lib/di';
import type { WechatTemplateNotificationPayload } from '@/models/schema';
import { deliveryService, notificationTemplate, orderNotificationDelivery, storeOrder, storeOrderOutbox, storeProduct,
  storeProductAttrValue, systemConfig, systemMessage, systemNotification, user, userAddress, wechatUser } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { createToken, md5 } from '@/utils/jwt';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { OrderNotificationDeliveryService } from '@/services/order/OrderNotificationDeliveryService';
import { OrderNotificationAdminService } from '@/services/order/OrderNotificationAdminService';
import { consumeRoutineSubscriptionSendAuthority } from '@/services/wechat/RoutineSubscriptionDispatch';
import { postRoutineSubscription } from '@/services/wechat/RoutineSubscriptionProvider';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { upgradeFulfillmentCityConflictReaders } from '@/migrations/upgradeFulfillmentCityConflictReaders';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { amountToCents } from '@/services/payment/RefundGateway';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment,
  type RoutineSubscriptionAccountPolicy } from '@/services/wechat/RoutineSubscriptionAccount';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';
import { collectRoutineNotificationContinuationDraft } from '../scripts/routine-ownership-inventory';
import type postgres from 'postgres';

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
type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Keys = ReturnType<typeof paymentQueryKeys>;
const APP = 'wx_subscription_source_a', OTHER = 'wx_subscription_source_b', MERCHANT = '1900000146', OTHER_MERCHANT = '1900000147';
const ACCOUNT = 'subscription_original_payment', REF = 'subscription_payment_materials', SUBREF = 'subscription_secret_a';
const SECRET = 'synthetic-subscription-secret-not-live', AES = 's'.repeat(32), SERIAL = 'PUB_SUBSCRIPTION_SOURCE';
const TARGET = 'subscription_buyer_a_not_payer', PAYER = 'subscription_real_payer_unrelated', TARGET_B = 'subscription_same_uid_b_latest', PHONE = '13800000011';
const TEMPLATE = 'owned_subscription_delivery_template_a';

function envelope(keys: Keys, payload: unknown, native = false) {
  const nonce = Buffer.from(randomBytes(6)).toString('hex'), aad = 'transaction', key = native ? 'b'.repeat(32) : AES;
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce)); cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const body = JSON.stringify({ id: randomUUID(), event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource',
    resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', ciphertext, nonce, associated_data: aad } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { body, headers: { 'content-type': 'application/json', 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
    'wechatpay-serial': native ? 'PUB_SUBSCRIPTION_NATIVE' : SERIAL,
    'wechatpay-signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), keys.privateKey)).toString('base64') } };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual Queue original subscription POST and immutable attempt/result', () => {
  let f: Fixture, keys: Keys, nativeKeys: Keys, policy: RoutineSubscriptionAccountPolicy, revision = 0;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const sources: Array<{ order: typeof storeOrder.$inferSelect; delivery: typeof orderNotificationDelivery.$inferSelect; event: typeof storeOrderOutbox.$inferSelect }> = [];
  const container = () => createContainerFromDb(f.appRuntime.db);
  const target = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
  const approve = async (patch: Partial<RoutineSubscriptionAccountPolicy> = {}) => {
    const result = await appendRoutineSubscriptionAccountPolicy(f.maintenanceDb, f.env, target(),
      { operationId: randomUUID(), expectedRevision: revision, data: { ...policy, ...patch } }); revision = result.revision; return result;
  };
  const current = async (appId = OTHER) => {
    const values = { routine_appId: appId, routine_appsecret: appId ? SECRET : '', wechat_appid: OTHER, wechat_app_appid: OTHER,
      pay_weixin_mchid: OTHER_MERCHANT, pay_weixin_serial_no: 'B1B2C3D4', pay_weixin_open: 1, order_shipping_open: 0 };
    await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName, Object.keys(values)));
    await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 20 })));
  };
  const admin = async (path: string, body: unknown) => {
    const token = (await createToken(1, 'admin', md5('offline-native-admin-password'), f.env.APP_KEY)).token;
    const response = await f.raw(path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json() as { status: number; msg: string; data: any };
    expect(response.status).toBe(200); expect(json.status, json.msg).toBe(200); return json.data;
  };
  async function notify(packet: ReturnType<typeof envelope>) {
    const h = new Hono<{ Bindings: Env; Variables: AppVariables }>(), pending: Promise<unknown>[] = [];
    h.use('*', async (c, next) => { c.set('container', container()); await next(); }); h.onError(errorHandler); h.route('/api', v1Routes);
    const response = await h.request('/api/pay/notify/routine-account/' + ACCOUNT,
      { method: 'POST', headers: packet.headers, body: packet.body }, f.env,
      { waitUntil: (p: Promise<unknown>) => pending.push(p), props: {}, passThroughOnException: () => { throw Error('Unexpected payment fallback'); } });
    await Promise.all(pending); expect(response.status).toBe(200);
  }
  async function paidCheckout(uid = 11, contact?: Readonly<{ real_name: string; phone: string }>) {
    const cart = await admin('/admin/order/cart/add/' + uid, { tourist_uid: '', productId: 70, uniqueId: 'qared001', cartNum: 1, new: 1 });
    const selection = { cartId: [cart.cartId], tourist_uid: '', new: 1, shipping_type: 1, store_id: 1, addressId: uid,
      real_name: '', phone: '', payType: 'cash', useIntegral: false, couponId: 0, from: 'pc', ...contact };
    const quote = await admin('/admin/order/confirm/' + uid, selection);
    const created = await admin('/admin/order/create/' + quote.orderKey + '/' + uid, { ...selection, quoteToken: quote.quoteToken });
    const order = await f.container.storeOrderDao.findByOrderId(created.result.order_id); if (!order) throw Error('Actual checkout root absent');
    expect(order).toMatchObject({ paid: 0, uid, status: 0 });
    const total = amountToCents(order.payPrice), transactionId = 'subscription_tx_' + randomUUID().replaceAll('-', ''), before = f.messages.length;
    await notify(envelope(keys, { appid: APP, mchid: MERCHANT, out_trade_no: order.orderId, transaction_id: transactionId,
      trade_state: 'SUCCESS', trade_type: 'JSAPI', payer: { openid: PAYER }, success_time: new Date().toISOString(), amount: { total, currency: 'CNY' } }));
    const message = f.messages.slice(before).find(isPaymentCallbackMessage); expect(message).toBeDefined();
    expect(await new PaymentCallbackEventService(container(), f.env).processMessage(message!)).toBe('completed');
    const [paid] = await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, order.id));
    expect(paid).toMatchObject({ paid: 1, tradeNo: transactionId, payType: 'weixin' });
    const [original] = await f.maintenanceDb.execute(sql`SELECT * FROM public.routine_original_payment_evidence WHERE order_no=${order.orderId}`);
    expect(parseRoutineOriginalEvidence(f.env, original)).toMatchObject({ payload: { binding: { state: 'bound', local: { domain: 'store_order', orderId: order.id, buyerUid: uid } },
      observation: { facts: { appId: APP, payerId: PAYER, tradeState: 'SUCCESS', tradeType: 'JSAPI' } } } });
    const [paidEvent] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, order.id), eq(storeOrderOutbox.eventType, 'order.paid')));
    await f.consume(paidEvent);
    return { order, paid };
  }
  async function stage(uid = 11, mode: 'express' | 'send' = 'express') {
    const { order } = await paidCheckout(uid);
    await admin('/admin/order/delivery/' + order.orderId, { delivery_type: mode, delivery_name: mode === 'send' ? '本机送货人' : '本机通知承运商', delivery_id: mode === 'send' ? '13800000011' : 'NOTICE-' + order.id, ...(mode === 'send' ? { delivery_uid: 30 } : {}) });
    const [event] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, order.id), eq(storeOrderOutbox.eventType, 'order.delivery.notice')));
    expect(await new OrderOutboxService(container(), f.env).processMessage({ action: 'processOrderNotificationOutbox', outboxId: event.id, eventKey: event.eventKey })).toBe('completed');
    const [delivery] = await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, event.eventKey), eq(orderNotificationDelivery.channel, 'wechat_routine')));
    expect(delivery).toMatchObject({ status: 'PENDING', target: uid === 11 ? TARGET : PAYER, templateCode: mode === 'send' ? TEMPLATE + '_send' : TEMPLATE, payload: { routineAppId: APP } });
    return { order: (await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0], event, delivery };
  }
  async function identity(appId: string, openid: string) {
    await current(appId);
    // Existing exact binding/verified phone is explicit identity bootstrap. The
    // prospective mapping/witness still come only from the real service writer.
    await f.maintenanceDb.insert(wechatUser).values({ uid: 11, userType: 'routine', openid });
    network.mockImplementation(async input => {
      const url = new URL(String(input)); expect(url.pathname).toBe('/sns/jscode2session'); expect(url.searchParams.get('appid')).toBe(appId);
      return Response.json({ openid, session_key: Buffer.from('0123456789abcdef').toString('base64') });
    });
    const auth = new WechatAuthService(container(), f.env), ticket = await auth.beginMiniProgramLogin({ code: randomUUID(), ip: '127.0.0.1' });
    const raw = transport.values.get('routine_login:' + ticket.key) as { identity: VerifiedSocialIdentity };
    expect(raw.identity.routineObservation).toMatchObject({ appId, openid });
    expect(await auth.reconcileVerifiedIdentity({ ...raw.identity, phone: PHONE })).toBe(11);
  }
  async function denied(promise: Promise<unknown>) {
    const error: unknown = await promise.then(() => { throw Error('Expected source refusal'); }, cause => cause);
    expect(error).toMatchObject({ code: 503 });
    const message = String((error as Error).message); for (const secret of [SECRET, AES, PAYER, TARGET, f.env.APP_KEY]) expect(message).not.toContain(secret);
  }
  beforeAll(async () => {
    keys = paymentQueryKeys(); nativeKeys = paymentQueryKeys();
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Explicit planned transport required'));
    f = await customerCashierRuntimeHttpFixture();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineSubscriptionUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runAdminWechatAppUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    const cityOwner = await f.createOwnedRole('citysub'), readers = { owner: cityOwner.role, app: true, admin: true, manager: true } as const;
    const cityUpgrade = await upgradeFulfillmentCityConflictReaders(f.maintenanceDb, f.target, { readers }, { ...f.peers, cityConflictReaders: readers }, f.appReaders);
    await f.maintenanceDb.update(storeProduct).set({ productType: 0, stock: 40, freight: 1, isVip: 0 }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ stock: 40, price: '5.00', vipPrice: '5.00' }).where(eq(storeProductAttrValue.id, 1));
    await f.maintenanceDb.update(user).set({ phone: PHONE }).where(eq(user.uid, 11));
    await f.maintenanceDb.insert(user).values({ uid: 30, account: 'subscription_courier', pwd: 'synthetic_courier_password', status: 1, phone: '13800000030' });
    await f.maintenanceDb.insert(deliveryService).values({ uid: 30, type: 0, relationId: 0, nickname: '本机送货人', phone: '13800000030', status: 1 });
    await f.maintenanceDb.insert(user).values({ uid: 22, account: 'owned-unmapped-buyer', pwd: 'owned-unmapped-password',
      status: 1, phone: '13800000022', nowMoney: '23.00' });
    const [address] = await f.maintenanceDb.select().from(userAddress).where(eq(userAddress.id, 11));
    await f.maintenanceDb.insert(userAddress).values({ ...address, id: 22, uid: 22 });
    await f.maintenanceDb.insert(wechatUser).values({ uid: 22, userType: 'routine', openid: PAYER });
    const registry = JSON.stringify({ format: 1, credentials: [{ ref: REF, version: 1, appId: APP, merchantId: MERCHANT, serialNo: 'A1B2C3D4',
      apiV3Key: AES, privateKey: keys.privateKey, platformPublicKey: keys.publicKey, platformPublicKeyId: SERIAL }] });
    Object.assign(f.env, { ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: registry,
      ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: JSON.stringify({ format: 1, credentials: [{ ref: SUBREF, version: 1, appId: APP, secret: SECRET }] }),
      WECHAT_MCH_PRIVATE_KEY: nativeKeys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: nativeKeys.publicKey,
      WECHAT_PLATFORM_PUBLIC_KEY_ID: 'PUB_SUBSCRIPTION_NATIVE', WECHAT_API_V3_KEY: 'b'.repeat(32) });
    await current(APP); const now = Math.floor(Date.now() / 1000), commitment = routinePaymentCredentialCommitment(f.env, REF, 1);
    await appendRoutinePaymentAccountPolicy(f.maintenanceDb, f.env, target(), { operationId: randomUUID(), expectedRevision: 0, kind: 'account', data: {
      accountId: ACCOUNT, state: 'active', ...commitment, credentialRef: REF, credentialVersion: 1, purposes: ['notify', 'query'], validFrom: now - 60, validUntil: now + 3600 } });
    policy = { accountId: routineSubscriptionAccountId(f.env, APP), state: 'active', appId: APP, credentialRef: SUBREF, credentialVersion: 1,
      credentialStamp: routineSubscriptionCredentialCommitment(f.env, SUBREF, 1).credentialStamp, purposes: ['subscription_send'],
      templates: [{ mark: '1128', templateId: TEMPLATE + '_send' }, { mark: '1458', templateId: TEMPLATE }], validFrom: now - 60, validUntil: now + 3600 };
    await approve(); await identity(APP, TARGET);
    await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, 'order_postage_success'));
    await f.maintenanceDb.insert(systemNotification).values({ mark: 'order_postage_success', isRoutine: 1 });
    await f.maintenanceDb.delete(notificationTemplate).where(and(eq(notificationTemplate.mark, '1458'), eq(notificationTemplate.legacyType, 0)));
    await f.maintenanceDb.insert(notificationTemplate).values({ mark: '1458', legacyType: 0, status: 1, tempid: TEMPLATE });
    await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, 'order_deliver_success'));
    await f.maintenanceDb.insert(systemNotification).values({ mark: 'order_deliver_success', isRoutine: 1 });
    await f.maintenanceDb.delete(notificationTemplate).where(and(eq(notificationTemplate.mark, '1128'), eq(notificationTemplate.legacyType, 0)));
    await f.maintenanceDb.insert(notificationTemplate).values({ mark: '1128', legacyType: 0, status: 1, tempid: TEMPLATE + '_send' });
    for (let i = 0; i < 10; i++) sources.push(await stage());
    sources.push(await stage(11, 'send'));
    sources.push(await stage());
    sources.push(await stage());
    await runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, f.target, cityUpgrade.peers, f.appReaders);
    await identity(OTHER, TARGET_B); await current();
    network.mockReset().mockRejectedValue(Error('Unexpected provider request'));
  }, 240000);
  afterEach(() => { network.mockReset().mockRejectedValue(Error('Unexpected provider request')); });
  afterAll(async () => { try { await f?.close(); } finally { vi.restoreAllMocks(); } }, 30000);

  const service = (db = f.appRuntime.db) => new OrderNotificationDeliveryService(createContainerFromDb(db), f.env);
  const read = async (index: number) => (await f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, sources[index].delivery.id)))[0];
  const attempts = (index: number) => f.maintenanceDb.execute<any>(sql`SELECT * FROM public.routine_subscribe_attempt WHERE delivery_id=${sources[index].delivery.id} ORDER BY attempt_no`);
  const results = (index: number) => f.maintenanceDb.execute<any>(sql`SELECT r.* FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${sources[index].delivery.id} ORDER BY a.attempt_no`);
  const clearTokens = () => { for (const key of transport.values.keys()) if (key.startsWith('routine:subscription:')) transport.values.delete(key); };
  async function queued(index: number) {
    const before = f.messages.length, outcome = await service().dispatchPending(20, sources[index].event.eventKey);
    expect(outcome.enqueued).toBeGreaterThan(0);
    const body = f.messages.slice(before).find((r: any) => r.deliveryId === sources[index].delivery.id) as any;
    expect(Object.keys(body).sort()).toEqual(['action', 'channel', 'deliveryId', 'eventKey']);
    expect(body).toEqual({ action: 'processOrderNotificationDelivery', channel: 'wechat_routine', deliveryId: sources[index].delivery.id, eventKey: sources[index].event.eventKey });
    return body;
  }
  function provider(code: number, hooks: { token?: () => Promise<void>; post?: () => Promise<void>; lost?: boolean } = {}) {
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.weixin.qq.com'); expect(init?.redirect).toBe('manual');
      const [idle] = await f.maintenanceDb.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE usename=${f.appRuntime.role} AND state='idle in transaction'`);
      expect(idle.n).toBe(0);
      if (url.pathname === '/cgi-bin/token') {
        expect(init?.method).toBe('GET'); expect(url.searchParams.get('appid')).toBe(APP); expect(url.searchParams.get('secret')).toBe(SECRET);
        await hooks.token?.(); return Response.json({ access_token: 'synthetic-dispatch-token-a', expires_in: 7200 });
      }
      expect(url.pathname).toBe('/cgi-bin/message/subscribe/send'); expect(init?.method).toBe('POST');
      expect(url.searchParams.get('access_token')).toBe('synthetic-dispatch-token-a');
      const body = JSON.parse(String(init?.body)); expect(body.touser).toBe(TARGET); expect(body.touser).not.toBe(PAYER); expect(body.touser).not.toBe(TARGET_B);
      await hooks.post?.(); if (hooks.lost) throw Error('synthetic connection lost after POST');
      return Response.json({ errcode: code, errmsg: code ? 'controlled rejection' : 'ok' });
    });
  }
  const posts = () => network.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/cgi-bin/message/subscribe/send');

  it('sends A to the exact owned buyer through actual Queue, retaining success even when approval is withdrawn during POST', async () => {
    clearTokens(); const message = await queued(0); provider(0, { post: async () => { await approve({ state: 'revoked' }); } });
    try {
      expect(await service().processMessage(message, network)).toBe('sent'); expect(posts()).toHaveLength(1);
      const [a] = await attempts(0), [r] = await results(0);
      expect(a).toMatchObject({ attempt_no: 1, payload: { purpose: 'routine_subscription_send', facts: { appId: APP, buyerUid: 11 }, request: { touser: TARGET } } });
      expect(r).toMatchObject({ attempt_id: a.attempt_id, payload: { attemptSignature: a.signature, result: { code: 0, httpStatus: 200 } } });
      expect(await read(0)).toMatchObject({ status: 'SENT', providerReference: r.result_id, responseCode: '0', attemptCount: 1 });
      const saved = f.env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS; f.env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = undefined;
      try { await current(''); expect(await service().processMessage(message, network)).toBe('already-sent'); }
      finally { f.env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = saved; await current(); }
      expect(posts()).toHaveLength(1); expect(await results(0)).toHaveLength(1);
      await expect(f.appRuntime.db.execute(sql`UPDATE public.routine_subscribe_attempt SET signature=${'f'.repeat(64)} WHERE attempt_id=${a.attempt_id}::uuid`)).rejects.toThrow();
      await expect(f.maintenanceDb.execute(sql`DELETE FROM public.routine_subscribe_result WHERE result_id=${r.result_id}`)).rejects.toThrow();
    } finally { await approve(); }
  }, 90000);
  it('rechecks revocation after token GET and makes no attempt or POST', async () => {
    clearTokens(); const message = await queued(1); provider(0, { token: async () => { await approve({ state: 'revoked' }); } });
    try { expect(await service().processMessage(message, network)).toBe('dead'); expect(posts()).toHaveLength(0); expect(await attempts(1)).toHaveLength(0); }
    finally { await approve(); }
  }, 90000);
  it('keeps a lost POST UNKNOWN through duplicate Queue and real legacy Admin confirmRetry without another UUID or POST', async () => {
    clearTokens(); const message = await queued(2); provider(0, { lost: true });
    expect(await service().processMessage(message, network)).toBe('unknown'); const [first] = await attempts(2);
    expect(first).toBeDefined(); expect(await results(2)).toHaveLength(0); expect(posts()).toHaveLength(1);
    expect(await service().processMessage(message, network)).toBe('unknown');
    await new OrderNotificationAdminService(createContainerFromDb(f.adminRuntime.db), f.env).confirmRetry(sources[2].delivery.id, 1,
      { requestKey: randomUUID(), reason: 'controlled legacy retry does not prove non-delivery' });
    const replay = await queued(2); expect(await service().processMessage(replay, network)).toBe('unknown');
    expect((await attempts(2)).map(a => a.attempt_id)).toEqual([first.attempt_id]); expect(await results(2)).toHaveLength(0); expect(posts()).toHaveLength(1);
  }, 90000);
  it('records an invalid-token rejection before a separate fresh-token Queue attempt with exactly the same request', async () => {
    clearTokens(); provider(40014); expect(await service().processMessage(await queued(3), network)).toBe('retry-scheduled');
    expect(await results(3)).toHaveLength(1); const firstBody = JSON.parse(String(posts()[0][1]?.body));
    await f.maintenanceDb.update(orderNotificationDelivery).set({ availableTime: 0 }).where(eq(orderNotificationDelivery.id, sources[3].delivery.id));
    provider(0); expect(await service().processMessage(await queued(3), network)).toBe('sent');
    expect(posts()).toHaveLength(2); expect(network.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/cgi-bin/token')).toHaveLength(2);
    expect(JSON.parse(String(posts()[1][1]?.body))).toEqual(firstBody);
    const rows = await attempts(3); expect(rows.map(a => a.attempt_no)).toEqual([1, 2]); expect(rows[1].payload.previousAttemptId).toBe(rows[0].attempt_id);
    expect((await results(3)).map(r => r.payload.result.code)).toEqual([40014, 0]);
  }, 90000);
  it('retains explicit permanent rejection and refuses a legacy manual retry without a new POST', async () => {
    clearTokens(); provider(43101); expect(await service().processMessage(await queued(4), network)).toBe('dead');
    await new OrderNotificationAdminService(createContainerFromDb(f.adminRuntime.db), f.env).confirmRetry(sources[4].delivery.id, 1,
      { requestKey: randomUUID(), reason: 'controlled permanent rejection replay' });
    expect(await service().processMessage(await queued(4), network)).toBe('dead'); expect(posts()).toHaveLength(1);
    expect(await attempts(4)).toHaveLength(1); expect(await results(4)).toHaveLength(1);
  }, 90000);
  it('rolls back a real late SENT projection failure together with result, preserving the durable attempt as UNKNOWN', async () => {
    clearTokens(); const message = await queued(5); provider(0);
    await f.maintenanceDb.execute(sql.raw(`CREATE FUNCTION public.subscription_test_late_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='SENT' AND NEW.id=${sources[5].delivery.id} THEN RAISE EXCEPTION 'controlled late projection failure'; END IF; RETURN NEW; END $$`));
    await f.maintenanceDb.execute(sql.raw('CREATE TRIGGER subscription_test_late_projection BEFORE UPDATE ON public.order_notification_delivery FOR EACH ROW EXECUTE FUNCTION public.subscription_test_late_projection()'));
    try {
      expect(await service().processMessage(message, network)).toBe('unknown'); expect(await attempts(5)).toHaveLength(1); expect(await results(5)).toHaveLength(0);
      expect(await read(5)).toMatchObject({ status: 'UNKNOWN' }); expect(await service().processMessage(message, network)).toBe('unknown'); expect(posts()).toHaveLength(1);
    } finally { await f.maintenanceDb.execute(sql.raw('DROP TRIGGER subscription_test_late_projection ON public.order_notification_delivery')); await f.maintenanceDb.execute(sql.raw('DROP FUNCTION public.subscription_test_late_projection()')); }
  }, 90000);
  it('refuses other actual LOGINs before changing the actual enqueued claim and rejects invented send capabilities', async () => {
    const message = await queued(6), before = await read(6);
    for (const db of [f.maintenanceDb, f.adminRuntime.db, f.financialRuntime.db, f.managerRuntime.db, f.cashierRuntime.db]) await denied(service(db).processMessage(message, network));
    expect(await read(6)).toEqual(before); expect(network).not.toHaveBeenCalled();
    expect(() => consumeRoutineSubscriptionSendAuthority({} as any)).toThrow(); await denied(postRoutineSubscription({} as any, network)); expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('refuses a template replaced during token retrieval before durable admission', async () => {
    clearTokens(); provider(0, { token: async () => { await approve({ templates: [{ mark: '1458', templateId: 'replacement_after_token' }] }); } });
    try { expect(await service().processMessage(await queued(7), network)).toBe('dead'); expect(await attempts(7)).toHaveLength(0); expect(posts()).toHaveLength(0); }
    finally { await approve(); }
  }, 90000);
  it('never rewrites a committed B pin to A when the new protocol is commissioned', async () => {
    await f.maintenanceDb.update(orderNotificationDelivery).set({ payload: { ...(sources[8].delivery.payload as WechatTemplateNotificationPayload), routineAppId: OTHER } }).where(eq(orderNotificationDelivery.id, sources[8].delivery.id));
    provider(0); expect(await service().processMessage(await queued(8), network)).toBe('dead'); expect(await attempts(8)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('bounds explicit throttling to five immutable POST/result pairs', async () => {
    clearTokens(); provider(45009);
    for (let i = 1; i <= 5; i++) {
      if (i > 1) await f.maintenanceDb.update(orderNotificationDelivery).set({ availableTime: 0 }).where(eq(orderNotificationDelivery.id, sources[9].delivery.id));
      expect(await service().processMessage(await queued(9), network)).toBe(i === 5 ? 'dead' : 'retry-scheduled');
    }
    expect(posts()).toHaveLength(5); expect((await attempts(9)).map(a => a.attempt_no)).toEqual([1, 2, 3, 4, 5]); expect(await results(9)).toHaveLength(5);
  }, 180000);
  it('sends a real Admin send-type notice with its distinct approved 1128 template and exact original receiver', async () => {
    clearTokens(); provider(0); expect(await service().processMessage(await queued(10), network)).toBe('sent');
    expect(await attempts(10)).toHaveLength(1); expect(await results(10)).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1]?.body))).toMatchObject({ touser: TARGET, template_id: TEMPLATE + '_send', data: { name4: { value: '本机送货人' }, phone_number10: { value: '13800000030' } } });
  }, 90000);
  it('does not reset fresh authority after a delayed acknowledgement of an already committed attempt', async () => {
    clearTokens(); const message = await queued(11); provider(0);
    const actual = Di.withTx;
    const spy = vi.spyOn(Di, 'withTx').mockImplementation((async (c: any, callback: any) => {
      const value: any = await actual(c, callback);
      if (value?.attempt?.attempt_id && typeof value.expiresAt === 'number') await new Promise(resolve => setTimeout(resolve, 2100));
      return value;
    }) as typeof Di.withTx);
    try {
      expect(await service().processMessage(message, network)).toBe('unknown');
      expect(await attempts(11)).toHaveLength(1); expect(await results(11)).toHaveLength(0); expect(posts()).toHaveLength(0);
    } finally { spy.mockRestore(); }
  }, 90000);
  it('cannot evade a previous unknown POST by replacing the mutable delivery ID', async () => {
    clearTokens(); provider(0, { lost: true }); expect(await service().processMessage(await queued(12), network)).toBe('unknown');
    const old = sources[12], [attempt] = await attempts(12), row = await read(12);
    await f.maintenanceDb.delete(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, row.id));
    // Explicit mutable-ledger corruption specimen, never a business positive.
    const { id: _id, ...replacement } = row;
    const [replaced] = await f.maintenanceDb.insert(orderNotificationDelivery).values({ ...replacement, status: 'PENDING', attemptCount: 0, replayCount: 0, availableTime: 0 }).returning();
    sources[12] = { ...old, delivery: replaced };
    expect(await service().processMessage(await queued(12), network)).toBe('unknown'); expect(posts()).toHaveLength(1);
    const rows = await f.maintenanceDb.execute<any>(sql`SELECT * FROM public.routine_subscribe_attempt WHERE source_key=${attempt.source_key}`);
    expect(rows.map(r => r.attempt_id)).toEqual([attempt.attempt_id]); expect(await results(12)).toHaveLength(0);
  }, 90000);

  it('keeps actual paid manual virtual fulfillment on PHP SMS/inbox channels without a Mini subscription', async () => {
    const mark = 'order_fictitious_success', content = '本机真实手工虚拟交付内容';
    const [product] = await f.maintenanceDb.select({ productType: storeProduct.productType }).from(storeProduct).where(eq(storeProduct.id, 70));
    if (!product) throw Error('Owned catalog product absent');
    const configuration = await f.maintenanceDb.select().from(systemNotification).where(eq(systemNotification.mark, mark));
    const ledger = async () => {
      const [counts] = await f.maintenanceDb.execute<{ attempts: number; results: number }>(sql`SELECT
        (SELECT count(*)::integer FROM public.routine_subscribe_attempt) AS attempts,
        (SELECT count(*)::integer FROM public.routine_subscribe_result) AS results`);
      if (!counts) throw Error('Actual immutable subscription ledgers absent');
      return counts;
    };
    const before = await ledger();
    try {
      // Bootstrap only the catalog BEFORE cart/quote/create. The order, product
      // snapshot, approved callback, paid event and fulfillment are real authors.
      await f.maintenanceDb.update(storeProduct).set({ productType: 3 }).where(eq(storeProduct.id, 70));
      await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, mark));
      await f.maintenanceDb.insert(systemNotification).values({ mark, isSystem: 1, isSms: 1, isWechat: 0, isRoutine: 0,
        smsId: 'owned_manual_virtual_sms', systemTitle: '虚拟交付成功', systemText: '订单 {order_id} 已人工交付' });
      const { order, paid } = await paidCheckout(11, { real_name: '手工虚拟买家', phone: PHONE });
      expect(paid).toMatchObject({ productType: 3, paid: 1, status: 0, payType: 'weixin', userPhone: PHONE });
      await admin('/admin/order/delivery/' + order.orderId, { delivery_type: 'fictitious', fictitious_content: content });
      const [delivered] = await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, order.id));
      expect(delivered).toMatchObject({ productType: 3, paid: 1, status: 1, deliveryType: 'fictitious', fictitiousContent: content });
      const [event] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, order.id), eq(storeOrderOutbox.eventType, 'order.delivery.notice')));
      expect(event.payload).toMatchObject({ orderId: order.id, userId: 11, deliveryType: 'fictitious' });
      expect(Object.hasOwn(event.payload, 'routineSubscriptionRequest')).toBe(false);
      expect(await new OrderOutboxService(container(), f.env).processMessage({ action: 'processOrderNotificationOutbox', outboxId: event.id, eventKey: event.eventKey })).toBe('completed');
      const deliveries = await f.maintenanceDb.select({ channel: orderNotificationDelivery.channel, mark: orderNotificationDelivery.noticeMark,
        target: orderNotificationDelivery.target }).from(orderNotificationDelivery).where(eq(orderNotificationDelivery.eventKey, event.eventKey));
      expect(deliveries).toEqual([{ channel: 'sms', mark, target: PHONE }]);
      expect(await f.maintenanceDb.select({ mark: systemMessage.mark, userId: systemMessage.userId }).from(systemMessage)
        .where(eq(systemMessage.eventKey, event.eventKey))).toEqual([{ mark, userId: 11 }]);
      expect(await ledger()).toEqual(before); expect(network).not.toHaveBeenCalled();
      const fingerprintKey = '71'.repeat(32);
      const report = await collectRoutineNotificationContinuationDraft(f.maintenanceDb.$client as unknown as postgres.Sql,
        f.target, fingerprintKey, { APP_KEY: f.env.APP_KEY });
      const outboxDigest = createHmac('sha256', fingerprintKey)
        .update('cinashop.routine-notification-continuation-draft.v1\0outbox-id\0').update(JSON.stringify(event.id)).digest('hex');
      expect(report.notifications.outboxes.find(row => row.outboxDigest === outboxDigest)).toMatchObject({ state: 'outside_subscription_contract', format: null });
      expect(report.notifications).toMatchObject({ activationAllowed: false, permitIssued: false, switchCommissioned: false,
        subscriptionSendAuthorized: false, currentBusinessEligibility: 'not_evaluated' });
      expect(await ledger()).toEqual(before); expect(network).not.toHaveBeenCalled();
    } finally {
      try { await f.maintenanceDb.update(storeProduct).set({ productType: product.productType }).where(eq(storeProduct.id, 70)); }
      finally {
        await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, mark));
        if (configuration.length) await f.maintenanceDb.insert(systemNotification).values(configuration);
      }
    }
  }, 90000);

  it('classifies actual format2 history in the complete maintenance snapshot without sending or rewriting it', async () => {
    // The original thirteen sources intentionally predate Dispatch commissioning.
    // Append a new real Admin checkout, approved A callback and delivery while B
    // remains current; only this post-commission producer can author request2.
    const index = sources.length; expect(index).toBe(13);
    sources.push(await stage());
    expect(sources[index].event).toMatchObject({ payload: { routineSubscriptionRequest: { format: 2 } } });
    expect(sources[index].delivery).toMatchObject({ payload: { routineAppId: APP, routineSubscriptionIntent: { format: 2 } } });
    clearTokens(); provider(0);
    expect(await service().processMessage(await queued(index), network)).toBe('sent');
    expect(posts()).toHaveLength(1); expect(await attempts(index)).toHaveLength(1); expect(await results(index)).toHaveLength(1);
    // The maintenance-only no-I/O baseline is captured after this real Queue POST.
    await assertRoutineNotificationContinuation(f,2,()=>[network.mock.calls.length,transport.get.mock.calls.length,transport.set.mock.calls.length,
      transport.remove.mock.calls.length,transport.take.mock.calls.length,transport.setIfAbsent.mock.calls.length,f.messages.length],[APP,OTHER,TARGET,PAYER,PHONE,SECRET,TEMPLATE],true);
  },90000);
});
