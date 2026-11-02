/** Actual PG16 five LOGINs, Admin checkout/delivery, RSA/AES Routine payment,
 * paid/notice outboxes and code2Session-backed UID ownership. Phone continuity
 * is explicit server-verified test input, not an SMS/login-form acceptance.
 * Only HTTP/Redis/KV/Queue transports are controlled. This suite performs no
 * subscription POST and proves no immutable dispatch/result commissioning. */
import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import * as Di from '@/lib/di';
import { notificationTemplate, orderNotificationDelivery, storeOrder, storeOrderOutbox, storeProduct,
  storeProductAttrValue, systemConfig, systemNotification, user, userAddress, userRecharge, wechatUser } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { createToken, md5 } from '@/utils/jwt';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { upgradeFulfillmentCityConflictReaders } from '@/migrations/upgradeFulfillmentCityConflictReaders';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { amountToCents } from '@/services/payment/RefundGateway';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment,
  type RoutineSubscriptionAccountPolicy } from '@/services/wechat/RoutineSubscriptionAccount';
import { getRoutineSubscriptionAccessToken } from '@/services/wechat/RoutineSubscriptionAccessToken';
import { prepareRoutineSubscriptionDeliveryNotice, recheckRoutineSubscriptionDeliveryNotice,
  assertPreparedRoutineSubscriptionDeliveryNotice } from '@/services/wechat/RoutineSubscriptionDeliveryNotice';
import { readRoutineSubscriptionOriginalTx, assertRoutineSubscriptionOriginalTx } from '@/services/wechat/RoutineSubscriptionOriginal';
import { assertRoutineSubscriptionReadyTx } from '@/migrations/routineSubscription';
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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual subscription delivery provenance and exact original-AppID receiver', () => {
  let f: Fixture, keys: Keys, nativeKeys: Keys, policy: RoutineSubscriptionAccountPolicy, revision = 0;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>, connections: MockInstance<typeof Di.createDbFromConnectionString>;
  const sources: Array<{ order: typeof storeOrder.$inferSelect; delivery: typeof orderNotificationDelivery.$inferSelect; event: typeof storeOrderOutbox.$inferSelect }> = [];
  const container = () => createContainerFromDb(f.appRuntime.db);
  const prepared = (index = 0, db = f.appRuntime.db) => prepareRoutineSubscriptionDeliveryNotice(createContainerFromDb(db), f.env,
    { deliveryId: sources[index].delivery.id, eventKey: sources[index].event.eventKey });
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
  async function stage(uid = 11) {
    const cart = await admin('/admin/order/cart/add/' + uid, { tourist_uid: '', productId: 70, uniqueId: 'qared001', cartNum: 1, new: 1 });
    const selection = { cartId: [cart.cartId], tourist_uid: '', new: 1, shipping_type: 1, store_id: 1, addressId: uid,
      real_name: '', phone: '', payType: 'cash', useIntegral: false, couponId: 0, from: 'pc' };
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
    await admin('/admin/order/delivery/' + order.orderId, { delivery_type: 'express', delivery_name: '本机通知承运商', delivery_id: 'NOTICE-' + order.id });
    const [event] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, order.id), eq(storeOrderOutbox.eventType, 'order.delivery.notice')));
    expect(await new OrderOutboxService(container(), f.env).processMessage({ action: 'processOrderNotificationOutbox', outboxId: event.id, eventKey: event.eventKey })).toBe('completed');
    const [delivery] = await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, event.eventKey), eq(orderNotificationDelivery.channel, 'wechat_routine')));
    expect(delivery).toMatchObject({ status: 'PENDING', target: uid === 11 ? TARGET : PAYER, templateCode: TEMPLATE, payload: { routineAppId: APP } });
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
  const ledger = () => f.maintenanceDb.select().from(orderNotificationDelivery).orderBy(orderNotificationDelivery.id);
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
    await upgradeFulfillmentCityConflictReaders(f.maintenanceDb, f.target, { readers }, { ...f.peers, cityConflictReaders: readers }, f.appReaders);
    await f.maintenanceDb.update(storeProduct).set({ productType: 0, stock: 40, freight: 1, isVip: 0 }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ stock: 40, price: '5.00', vipPrice: '5.00' }).where(eq(storeProductAttrValue.id, 1));
    await f.maintenanceDb.update(user).set({ phone: PHONE }).where(eq(user.uid, 11));
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
      templates: [{ mark: '1458', templateId: TEMPLATE }], validFrom: now - 60, validUntil: now + 3600 };
    await approve(); await identity(APP, TARGET);
    await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, 'order_postage_success'));
    await f.maintenanceDb.insert(systemNotification).values({ mark: 'order_postage_success', isRoutine: 1 });
    await f.maintenanceDb.delete(notificationTemplate).where(and(eq(notificationTemplate.mark, '1458'), eq(notificationTemplate.legacyType, 0)));
    await f.maintenanceDb.insert(notificationTemplate).values({ mark: '1458', legacyType: 0, status: 1, tempid: TEMPLATE });
    for (let i = 0; i < 9; i++) sources.push(await stage());
    sources.push(await stage(22));
    await identity(OTHER, TARGET_B); await current();
    connections = vi.spyOn(Di, 'createDbFromConnectionString'); network.mockReset().mockRejectedValue(Error('Unexpected provider request'));
  }, 180000);
  afterEach(() => { network.mockReset().mockRejectedValue(Error('Unexpected provider request')); });
  afterAll(async () => { try { await f?.close(); } finally { vi.restoreAllMocks(); } }, 30000);

  it('combines a real paid A source, real A ownership and approved template despite current B/latest bare B identity', async () => {
    const before = await f.facts(), bindings = await f.maintenanceDb.select().from(wechatUser), deliveries = await ledger();
    const proof = await prepared(); expect(proof.facts).toMatchObject({ buyerUid: 11, appId: APP, orderId: sources[0].order.id, templateMark: '1458' });
    expect(proof.request).toMatchObject({ touser: TARGET, template_id: TEMPLATE, data: { character_string2: { value: 'NOTICE-' + sources[0].order.id } } });
    expect(proof.request.touser).not.toBe(PAYER); expect(proof.request.touser).not.toBe(TARGET_B);
    expect(connections.mock.calls.some(call => call[2]?.applicationName === 'cinashop_routine_subscription_verify')).toBe(true);
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.pathname).toBe('/cgi-bin/token'); expect(init?.method).toBe('GET');
      expect(url.searchParams.get('appid')).toBe(APP); expect(url.searchParams.get('secret')).toBe(SECRET);
      const [idle] = await f.maintenanceDb.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE usename=${f.appRuntime.role} AND state='idle in transaction'`);
      expect(idle.n).toBe(0); return Response.json({ access_token: 'synthetic-subscription-source-token-a', expires_in: 7200 });
    });
    expect(await getRoutineSubscriptionAccessToken(container(), f.env, proof.account, { fetcher: network })).toBe('synthetic-subscription-source-token-a');
    expect((await recheckRoutineSubscriptionDeliveryNotice(container(), f.env, proof)).facts.sourceDigest).toBe(proof.facts.sourceDigest);
    expect(await f.facts()).toEqual(before); expect(await ledger()).toEqual(deliveries); expect(await f.maintenanceDb.select().from(wechatUser)).toEqual(bindings);
    expect(network).toHaveBeenCalledTimes(1);
  }, 90000);
  it('reads the same original source with empty current Mini configuration and freezes the DTO/deployment snapshot before await', async () => {
    await current(''); const body = { deliveryId: sources[1].delivery.id, eventKey: sources[1].event.eventKey }, saved = f.env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS;
    const pending = prepareRoutineSubscriptionDeliveryNotice(container(), f.env, body); body.deliveryId = sources[0].delivery.id; body.eventKey = 'order.delivery.notice:999';
    f.env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = undefined;
    try { expect((await pending).facts.deliveryId).toBe(sources[1].delivery.id); }
    finally { f.env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS = saved; await current(); }
    expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('refuses other actual LOGINs, transaction-root containers and cloned prospective capabilities before provider I/O', async () => {
    const before = await ledger();
    for (const db of [f.maintenanceDb, f.adminRuntime.db, f.financialRuntime.db, f.managerRuntime.db, f.cashierRuntime.db]) await denied(prepared(2, db));
    const proof = await prepared(2); expect(() => assertPreparedRoutineSubscriptionDeliveryNotice({ ...proof })).toThrow();
    expect(() => assertPreparedRoutineSubscriptionDeliveryNotice(JSON.parse(JSON.stringify(proof)))).toThrow();
    await denied(withTx(container(), tx => prepareRoutineSubscriptionDeliveryNotice(createContainerFromDb(tx), f.env,
      { deliveryId: sources[2].delivery.id, eventKey: sources[2].event.eventKey })));
    expect(await ledger()).toEqual(before); expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('rejects different immutable AppID pins, target, template, rendered data and UNKNOWN rather than reinterpreting old intents', async () => {
    const c = sources[3], before = await ledger();
    const patches = [{ target: TARGET_B }, { target: PAYER }, { templateCode: 'different_template' },
      { payload: { ...c.delivery.payload, routineAppId: OTHER } }, { payload: { ...c.delivery.payload, data: { thing1: 'invented' } } }, { status: 'UNKNOWN' as const }];
    for (const patch of patches) {
      await f.maintenanceDb.update(orderNotificationDelivery).set(patch).where(eq(orderNotificationDelivery.id, c.delivery.id));
      try { await denied(prepared(3)); } finally { await f.maintenanceDb.update(orderNotificationDelivery).set(c.delivery).where(eq(orderNotificationDelivery.id, c.delivery.id)); }
    }
    await f.maintenanceDb.update(storeOrderOutbox).set({ payload: { ...c.event.payload, routineAppId: OTHER } }).where(eq(storeOrderOutbox.id, c.event.id));
    try { await denied(prepared(3)); } finally { await f.maintenanceDb.update(storeOrderOutbox).set({ payload: c.event.payload }).where(eq(storeOrderOutbox.id, c.event.id)); }
    expect(await ledger()).toEqual(before); expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('rechecks exact live target, physical payment root and namespace, without fallback or repair', async () => {
    const c = sources[4], proof = await prepared(4);
    await f.maintenanceDb.update(wechatUser).set({ isDel: 1 }).where(eq(wechatUser.openid, TARGET));
    try { await denied(recheckRoutineSubscriptionDeliveryNotice(container(), f.env, proof)); }
    finally { await f.maintenanceDb.update(wechatUser).set({ isDel: 0 }).where(eq(wechatUser.openid, TARGET)); }
    await f.maintenanceDb.update(storeOrder).set({ payPrice: '99.00' }).where(eq(storeOrder.id, c.order.id));
    try { await denied(prepared(4)); } finally { await f.maintenanceDb.update(storeOrder).set({ payPrice: c.order.payPrice }).where(eq(storeOrder.id, c.order.id)); }
    await f.maintenanceDb.insert(userRecharge).values({ uid: 11, orderId: c.order.orderId, price: c.order.payPrice });
    try { await denied(prepared(4)); } finally { await f.maintenanceDb.delete(userRecharge).where(eq(userRecharge.orderId, c.order.orderId)); }
    expect((await recheckRoutineSubscriptionDeliveryNotice(container(), f.env, proof)).facts.sourceDigest).toBe(proof.facts.sourceDigest);
    expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('latest template replacement and revocation invalidate prospective source proofs without rewriting delivery facts', async () => {
    const proof = await prepared(5), before = await ledger();
    await approve({ templates: [{ mark: '1458', templateId: 'replacement_template' }] });
    await denied(recheckRoutineSubscriptionDeliveryNotice(container(), f.env, proof)); await approve({ state: 'revoked' }); await denied(prepared(5));
    await approve(); expect(await ledger()).toEqual(before); expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('a genuinely signed contradictory Routine transaction stays evidence and blocks all original-source preparation', async () => {
    const c = sources[6]; await notify(envelope(keys, { appid: APP, mchid: MERCHANT, out_trade_no: c.order.orderId,
      transaction_id: 'subscription_conflict_' + randomUUID().replaceAll('-', ''), trade_state: 'SUCCESS', trade_type: 'JSAPI', payer: { openid: PAYER },
      success_time: new Date().toISOString(), amount: { total: amountToCents(c.order.payPrice), currency: 'CNY' } }));
    expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.routine_original_payment_evidence WHERE order_no=${c.order.orderId}`)).toHaveLength(2);
    await denied(prepared(6)); expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('reaches independent NativeApp absence and rejects a genuine APP success for the same original root', async () => {
    const c = sources[7], packet = envelope(nativeKeys, { appid: OTHER, mchid: OTHER_MERCHANT, out_trade_no: c.order.orderId,
      transaction_id: 'subscription_native_' + randomUUID().replaceAll('-', ''), trade_state: 'SUCCESS', trade_type: 'APP',
      success_time: new Date().toISOString(), amount: { total: amountToCents(c.order.payPrice), currency: 'CNY' } }, true);
    const pay = new WechatPayService(container(), f.env);
    await expect(pay.verifyAndParseNotify({ ...packet.headers, 'wechatpay-signature': 'invalid' }, packet.body, 'app')).rejects.toThrow();
    expect(await pay.verifyAndParseNotify(packet.headers, packet.body, 'app')).toMatchObject({ outTradeNo: c.order.orderId, tradeState: 'SUCCESS' });
    expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.native_app_payment_evidence WHERE order_no=${c.order.orderId}`)).toHaveLength(1);
    connections.mockClear(); await denied(prepared(7));
    expect(connections.mock.calls.some(call => call[2]?.applicationName === 'cinashop_routine_subscription_verify')).toBe(true);
    expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('keeps original-reader capabilities bound to the actual SQL transaction and honors real source/gate contention', async () => {
    const c = sources[8]; let previous!: Awaited<ReturnType<typeof readRoutineSubscriptionOriginalTx>>;
    await withTx(container(), async tx => { await assertRoutineSubscriptionReadyTx(tx);
      previous = await readRoutineSubscriptionOriginalTx(tx, f.env, { rootId: c.order.id, buyerUid: 11, orderNo: c.order.orderId,
        transactionId: c.order.tradeNo, totalAmount: amountToCents(c.order.payPrice)! });
      expect(assertRoutineSubscriptionOriginalTx(tx, previous)).toBe(previous);
      expect(() => assertRoutineSubscriptionOriginalTx(tx, { ...previous })).toThrow();
    });
    await withTx(container(), async tx => { expect(() => assertRoutineSubscriptionOriginalTx(tx, previous)).toThrow(); });
    await f.withMaintenancePeer(async db => withTx(createContainerFromDb(db), async tx => {
      await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731725,0)`); await denied(prepared(8));
    }));
    await f.withMaintenancePeer(async db => withTx(createContainerFromDb(db), async tx => {
      await tx.execute(sql`LOCK TABLE ONLY public.store_order IN ROW EXCLUSIVE MODE`); await denied(prepared(8));
    }));
    expect(network).not.toHaveBeenCalled();
  }, 90000);
  it('a real paid buyer with a bare payer-shaped binding but no A+UID ownership cannot borrow another buyer mapping', async () => {
    const before = await ledger();
    expect(await f.maintenanceDb.execute(sql`SELECT ownership_id FROM public.routine_identity_ownership WHERE uid=22 AND app_id=${APP}`)).toHaveLength(0);
    expect(sources[9].delivery).toMatchObject({ userId: 22, target: PAYER, payload: { routineAppId: APP } });
    await denied(prepared(9)); expect(await ledger()).toEqual(before); expect(network).not.toHaveBeenCalled();
  }, 90000);
});
