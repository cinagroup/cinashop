/** Full UserJWT checkout/payment -> actual allocation -> paid notice -> Queue
 * -> SMS/official/Mini/inbox. Only source users/catalog, maintenance approval and
 * local transports are fixtures; no paid/order/ownership signature is seeded. */
import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { notificationTemplate, orderNotificationDelivery, storeOrder, storeOrderOutbox, storeOrderWriteoff, storeProduct, storeProductAttrValue,
  systemConfig, systemMessage, systemNotification, systemSupplier, user, userAddress, wechatUser,
  type OrderPaidNoticeOutboxPayload } from '@/models/schema';
import { runPaidNoticeUpgrade } from '@/migrations/paidNotice';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { PaymentCallbackEventService, isPaymentCallbackMessage } from '@/services/payment/PaymentCallbackEventService';
import { OrderOutboxService, isOrderPaidOutboxMessage, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { consumeOrderPaidOutboxQueueMessage, consumeOrderNotificationOutboxQueueMessage } from '@/services/order/OrderPaidOutboxQueueConsumer';
import { paidNoticeDate } from '@/services/order/OrderPaidNoticeCodec';
import { CustomerWorkWriteoffService } from '@/services/customer-work/CustomerWorkWriteoffService';
import { CUSTOMER_WRITEOFF_VERSION, type WriteoffInput } from '@/services/customer-work/CustomerWorkWriteoffProtocol';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment } from '@/services/wechat/RoutineSubscriptionAccount';
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
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(), getRedis: () => transport.redis,
  cacheGet: transport.get, cacheSet: transport.set, cacheTake: transport.take, cacheDelete: transport.remove, cacheSetIfAbsent: transport.setIfAbsent,
  setTokenBucket: vi.fn(async () => true), clearToken: vi.fn(async () => true) }));

type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Event = typeof storeOrderOutbox.$inferSelect;
const A = 'wx_paid_owned_a', B = 'wx_paid_current_b', OFFICIAL = 'wx_paid_official';
const SUBREF = 'paid_subscription_ref', SUBSECRET = 'synthetic-paid-subscription-secret';
const MINI_TEMPLATE = 'owned_paid_1927', OFFICIAL_TEMPLATE = 'owned_paid_43216', SMS_TEMPLATE = 'owned_paid_sms';
const OWNER: Record<number, string> = { 11: 'paid_owned_uid11', 22: 'paid_owned_uid22' };
const OFFICIAL_OWNER: Record<number, string> = { 11: 'paid_official_uid11', 22: 'paid_official_uid22' };
const PHONE: Record<number, string> = { 11: '13800000011', 22: '13800000022' };
const ACCOUNT = 'paid_notice_original_account', REF = 'paid_notice_original_payment', MERCHANT = '1900000641', AES = 'v'.repeat(32), SERIAL = 'PUB_PAID_NOTICE';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual allocated merchandise payment notifications on independent PG16 LOGINs', { timeout: 60000 }, () => {
  let legacyPaid: Event;
  let f: Fixture, keys: ReturnType<typeof paymentQueryKeys>, network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const expected = new Map<string, OrderPaidNoticeOutboxPayload>(), lostMini = new Set<string>();
  const posts: Array<{ channel: string; orderNo: string; body: unknown }> = [];
  const prepayRequests: string[] = [];
  const app = () => createContainerFromDb(f.appRuntime.db), outbox = () => new OrderOutboxService(app(), f.env);
  const delivery = () => new OrderNotificationDeliveryService(app(), f.env);
  const named = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
  async function config(values: Record<string, unknown>) {
    await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName, Object.keys(values)));
    await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 20 })));
  }
  const current = (appId = B) => config({ routine_appId: appId, routine_appsecret: 'synthetic-current-secret', wechat_appid: OFFICIAL,
    wechat_appsecret: 'synthetic-official-secret', order_shipping_open: 0 });
  async function identity(uid: number) {
    await current(A);
    await f.maintenanceDb.insert(wechatUser).values({ uid, userType: 'routine', openid: OWNER[uid], isDel: 0 });
    const auth = new WechatAuthService(app(), f.env), ticket = await auth.beginMiniProgramLogin({ code: randomUUID(), ip: '127.0.0.1' });
    const raw = transport.values.get('routine_login:' + ticket.key) as { identity: VerifiedSocialIdentity };
    expect(raw.identity.routineObservation).toMatchObject({ appId: A, openid: OWNER[uid] });
    expect(await auth.reconcileVerifiedIdentity({ ...raw.identity, phone: PHONE[uid] })).toBe(uid);
    await current();
  }
  let loginUid = 11;
  function provider() {
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/sns/jscode2session') {
        expect(url.searchParams.get('appid')).toBe(A);
        return Response.json({ openid: OWNER[loginUid], session_key: Buffer.from('0123456789abcdef').toString('base64') });
      }
      if (url.pathname === '/cgi-bin/token') {
        const appId = url.searchParams.get('appid'); expect([A, OFFICIAL]).toContain(appId);
        if (appId === A) expect(url.searchParams.get('secret')).toBe(SUBSECRET);
        return Response.json({ access_token: appId === A ? 'owned_paid_mini_token' : 'owned_paid_official_token', expires_in: 7200 });
      }
      expect(init?.method).toBe('POST');
      if (url.hostname === 'api.mch.weixin.qq.com') {
        expect(url.pathname).toBe('/v3/pay/transactions/jsapi'); expect(url.search).toBe('');
        const raw = String(init?.body), body = JSON.parse(raw) as { out_trade_no: string };
        const [order] = await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.orderId, body.out_trade_no));
        expect(order).toMatchObject({ uid: 11, paid: 0 });
        expect(body).toEqual({ appid: A, mchid: MERCHANT, out_trade_no: order.orderId,
          description: `CinaShop 订单 ${order.orderId}`, notify_url: 'https://paid-notice.example/api/pay/notify/routine',
          attach: 'product', amount: { total: Math.round(Number(order.payPrice) * 100), currency: 'CNY' }, payer: { openid: OWNER[11] } });
        const attempts = await f.maintenanceDb.execute<{ event_kind: string; payload: { providerBody: unknown } }>(sql`SELECT event_kind,payload
          FROM public.routine_payment_attempt WHERE order_no=${order.orderId} ORDER BY event_kind`);
        expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ event_kind: 'INITIATION', payload: { providerBody: body } });
        const headers = new Headers(init?.headers), authorization = headers.get('Authorization') ?? '';
        expect(authorization.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true);
        const fields = Object.fromEntries([...authorization.matchAll(/(\w+)="([^"]+)"/gu)].map(match => [match[1], match[2]]));
        expect(fields.mchid).toBe(MERCHANT); expect(fields.serial_no).toBe('A1B2C3D4'); expect(headers.get('Wechatpay-Serial')).toBe(SERIAL);
        expect(verify('RSA-SHA256', Buffer.from(`POST\n/v3/pay/transactions/jsapi\n${fields.timestamp}\n${fields.nonce_str}\n${raw}\n`),
          keys.publicKey, Buffer.from(fields.signature, 'base64'))).toBe(true);
        prepayRequests.push(order.orderId);
        const response = JSON.stringify({ prepay_id: 'owned_paid_notice_prepay' }), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
        return new Response(response, { headers: { 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce, 'Wechatpay-Serial': SERIAL,
          'Wechatpay-Signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${response}\n`), keys.privateKey)).toString('base64') } });
      }
      if (url.hostname === 'dysmsapi.aliyuncs.com') {
        const params = new URLSearchParams(String(init?.body)), data = JSON.parse(params.get('TemplateParam')!) as { order_id: string; pay_price: string };
        const p = expected.get(data.order_id); expect(p).toBeDefined();
        expect(params.get('PhoneNumbers')).toBe(p!.phone); expect(params.get('TemplateCode')).toBe(SMS_TEMPLATE);
        expect(data).toEqual({ order_id: p!.orderNo, pay_price: p!.payPrice }); expect(params.get('Signature')).toBeTruthy();
        posts.push({ channel: 'sms', orderNo: p!.orderNo, body: data });
        return Response.json({ Code: 'OK', BizId: 'owned-paid-biz', RequestId: 'owned-paid-request' });
      }
      const body = JSON.parse(String(init?.body)) as { touser: string; template_id: string; page?: string; url?: string; data: Record<string, { value: string }> };
      if (url.pathname === '/cgi-bin/message/template/send') {
        const p = expected.get(body.data.character_string2.value); expect(p).toBeDefined();
        expect(url.searchParams.get('access_token')).toBe('owned_paid_official_token'); expect(body.touser).toBe(OFFICIAL_OWNER[p!.userId]);
        expect(body.template_id).toBe(OFFICIAL_TEMPLATE); expect(body.url).toBe('/pages/goods/order_details/index?order_id=' + p!.orderNo);
        expect(body.data).toEqual({ character_string2: { value: p!.orderNo }, thing3: { value: p!.storeName }, amount5: { value: p!.payPrice },
          phrase18: { value: p!.sendName }, time4: { value: paidNoticeDate(p!.payTime) } });
        posts.push({ channel: 'official', orderNo: p!.orderNo, body }); return Response.json({ errcode: 0, msgid: 'owned_paid_msg' });
      }
      expect(url.pathname).toBe('/cgi-bin/message/subscribe/send');
      const p = expected.get(body.data.character_string1.value); expect(p).toBeDefined();
      expect(url.searchParams.get('access_token')).toBe('owned_paid_mini_token'); expect(body.touser).toBe(OWNER[p!.userId]);
      expect(body.template_id).toBe(MINI_TEMPLATE); expect(body.page).toBe('/pages/goods/order_details/index?order_id=' + p!.orderNo);
      expect(body.data).toEqual({ character_string1: { value: p!.orderNo }, amount2: { value: p!.payPrice + '元' }, date3: { value: paidNoticeDate(p!.occurredAt) } });
      posts.push({ channel: 'mini', orderNo: p!.orderNo, body });
      const [active] = await f.maintenanceDb.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname=current_database() AND state='idle in transaction' AND usename IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role},${f.cashierRuntime.role},${f.managerRuntime.role})`);
      expect(active.count).toBe(0);
      if (lostMini.has(p!.orderNo)) throw Error('Controlled lost response after actual Mini POST');
      return Response.json({ errcode: 0 });
    });
  }
  async function ok(path: string, body: unknown, uid = 11) {
    const result = await f.request(path, body, undefined, uid); expect(result.body.status, result.body.msg).toBe(200); return result.body.data;
  }
  async function checkout({ uid = 11, payType = 'yue', split = false }: { uid?: number; payType?: 'yue' | 'weixin'; split?: boolean } = {}) {
    const ids: number[] = [];
    for (const [productId, uniqueId] of split ? [[70, 'qared001'], [71, 'qapay002']] as const : [[70, 'qared001']] as const)
      ids.push((await ok('/cart/add', { productId, uniqueId, cartNum: 1, isNew: 1 }, uid)).cartId);
    const selection = split ? { cartIds: ids, shippingType: 1, storeId: 0, addressId: uid, useIntegral: false, couponId: 0 }
      : { cartIds: ids, shippingType: 2, storeId: 1, useIntegral: false, couponId: 0 };
    const quote = await ok('/order/confirm', selection, uid);
    const created = await ok('/order/create/' + quote.orderKey, { ...selection, quoteToken: quote.quoteToken, realName: '原生付款买家',
      userPhone: PHONE[uid], payType, from: payType === 'weixin' ? 'routine' : 'h5' }, uid);
    if (payType === 'weixin') {
      expect(created).toMatchObject({ pay_type: 'weixin', paid: false, pay_mode: 'jsapi',
        jsConfig: { prepay_id: 'owned_paid_notice_prepay', package: 'prepay_id=owned_paid_notice_prepay', signType: 'RSA' } });
      const packet = created.jsConfig;
      expect(verify('RSA-SHA256', Buffer.from(`${A}\n${packet.timeStamp}\n${packet.nonceStr}\n${packet.package}\n`),
        keys.publicKey, Buffer.from(packet.paySign, 'base64'))).toBe(true);
    }
    const [order] = await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(order).toBeDefined(); expect(order.uid).toBe(uid); expect(order.paid).toBe(payType === 'yue' ? 1 : 0);
    return order;
  }
  async function consume(event: Event, dispatchShipping = true) {
    await outbox().dispatchPending(1, event.id);
    const body = f.messages.filter(value => (isOrderPaidOutboxMessage(value) || isOrderNotificationOutboxMessage(value)) && value.outboxId === event.id).at(-1);
    expect(body).toBeDefined(); const ack = vi.fn(), retry = vi.fn();
    if (isOrderPaidOutboxMessage(body)) await consumeOrderPaidOutboxQueueMessage({ body, attempts: 1, ack, retry }, outbox(), dispatchShipping ? delivery() : undefined);
    else if (isOrderNotificationOutboxMessage(body)) await consumeOrderNotificationOutboxQueueMessage({ body, attempts: 1, ack, retry }, outbox());
    else throw Error('Actual Queue body absent');
    expect(retry).not.toHaveBeenCalled(); expect(ack).toHaveBeenCalledTimes(1);
    expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, event.id)))[0].status).toBe('COMPLETED');
  }
  async function notices(order: typeof storeOrder.$inferSelect, dispatchShipping = true) {
    const [paid] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, order.id), eq(storeOrderOutbox.eventType, 'order.paid')));
    expect(paid.payload).toHaveProperty('payNoticeAdmission.format', 1); await consume(paid, dispatchShipping);
    const events = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, 'order.pay.success.notice')).orderBy(asc(storeOrderOutbox.id));
    const chosen = events.filter(e => (e.payload as OrderPaidNoticeOutboxPayload).paymentEventId === paid.id);
    expect(chosen.length).toBeGreaterThan(0);
    for (const event of chosen) expected.set((event.payload as OrderPaidNoticeOutboxPayload).orderNo, event.payload as OrderPaidNoticeOutboxPayload);
    return { paid, events: chosen };
  }
  const rows = (event: Event) => f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.eventKey, event.eventKey)).orderBy(asc(orderNotificationDelivery.id));
  async function paidEffects(paymentOrderId: number) {
    const [row] = await f.maintenanceDb.execute<{ value: unknown }>(sql`SELECT jsonb_build_object(
      'family',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.store_order t WHERE id=${paymentOrderId} OR pid=${paymentOrderId}),
      'carts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.store_order_cart_info t WHERE oid=${paymentOrderId} OR oid IN(SELECT id FROM public.store_order WHERE pid=${paymentOrderId})),
      'supplierFlow',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.supplier_flowing_water t),
      'supplierTransactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.supplier_transactions t),
      'bills',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_bill t),
      'buyer',(SELECT jsonb_build_array(now_money,pay_count,integral,exp) FROM public."user" WHERE uid=11)
    ) AS value`); return row.value;
  }
  async function send(event: Event, mini: 'sent' | 'unknown' | 'skipped' = 'sent') {
    await consume(event); await delivery().dispatchPending(20, event.eventKey);
    const messages = f.messages.filter(isOrderNotificationDeliveryMessage).filter(m => m.eventKey === event.eventKey);
    const unique = [...new Map(messages.map(m => [m.deliveryId, m])).values()];
    expect(new Set(unique.map(m => m.channel))).toEqual(new Set(mini === 'skipped' ? ['sms', 'wechat_official'] : ['sms', 'wechat_official', 'wechat_routine']));
    for (const message of unique) {
      const result = await delivery().processMessage(message, network);
      expect(result).toBe(message.channel === 'wechat_routine' && mini === 'unknown' ? 'unknown' : 'sent');
    }
    const saved = await rows(event), p = event.payload as OrderPaidNoticeOutboxPayload;
    expect(saved.find(r => r.channel === 'wechat_routine')?.status).toBe(mini === 'skipped' ? 'SKIPPED' : mini === 'unknown' ? 'UNKNOWN' : 'SENT');
    expect(saved.filter(r => r.channel !== 'wechat_routine').every(r => r.status === 'SENT')).toBe(true);
    expect(await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey, event.eventKey))).toMatchObject([
      { userId: p.userId, mark: 'order_pay_success', title: '付款 ' + p.orderNo, content: p.payPrice + ' ' + p.totalNum }]);
    return unique;
  }
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected external I/O')); keys = paymentQueryKeys();
    f = await customerCashierRuntimeHttpFixture(); await f.reset();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineSubscriptionUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runAdminWechatAppUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    expect(new Set(await Promise.all([f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime].map(runtime => runtime.verify()))).size).toBe(5);
    Object.assign(f.env, { ALIYUN_SMS_ACCESS_KEY_ID: 'synthetic-paid-key', ALIYUN_SMS_ACCESS_KEY_SECRET: 'synthetic-paid-secret', ALIYUN_SMS_SIGN_NAME: '付款原生验收',
      WECHAT_MCH_PRIVATE_KEY: keys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey, WECHAT_PLATFORM_PUBLIC_KEY_ID: SERIAL, WECHAT_API_V3_KEY: AES,
      ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: JSON.stringify({ format: 1, credentials: [{ ref: SUBREF, version: 1, appId: A, secret: SUBSECRET }] }),
      ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: JSON.stringify({ format: 1, credentials: [{ ref: REF, version: 1, appId: A, merchantId: MERCHANT,
        serialNo: 'A1B2C3D4', apiV3Key: AES, privateKey: keys.privateKey, platformPublicKey: keys.publicKey, platformPublicKeyId: SERIAL }] }) });
    await f.maintenanceDb.update(user).set({ phone: PHONE[11], nowMoney: '1000.00', pwd: 'owned-financial-password' }).where(eq(user.uid, 11));
    await f.maintenanceDb.insert(user).values({ uid: 22, account: 'paid_unknown_owner', pwd: 'owned-financial-password', phone: PHONE[22], status: 1, nowMoney: '1000.00' });
    const [address] = await f.maintenanceDb.select().from(userAddress).where(eq(userAddress.id, 11));
    await f.maintenanceDb.insert(userAddress).values({ ...address, id: 22, uid: 22 });
    await f.maintenanceDb.update(wechatUser).set({ isDel: 1 }).where(and(inArray(wechatUser.uid, [11, 22]), eq(wechatUser.userType, 'routine')));
    for (const uid of [11, 22]) await f.maintenanceDb.insert(wechatUser).values({ uid, userType: 'wechat', openid: OFFICIAL_OWNER[uid], isDel: 0 });
    await f.maintenanceDb.update(storeProduct).set({ productType: 0, type: 0, relationId: 0, storeName: '付款快照原商品名称😀', isVip: 0, freight: 2, stock: 100, sales: 0 }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ stock: 100, sales: 0, price: '7.00', vipPrice: '7.00' }).where(eq(storeProductAttrValue.id, 1));
    const [product] = await f.maintenanceDb.select().from(storeProduct).where(eq(storeProduct.id, 70));
    const [attr] = await f.maintenanceDb.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    await f.maintenanceDb.insert(systemSupplier).values({ id: 201, adminId: 9201, supplierName: '付款原生供应商', name: '原生供应商', phone: '13800000201', isShow: 1, isDel: 0 });
    await f.maintenanceDb.insert(storeProduct).values({ ...product, id: 71, type: 2, relationId: 201, storeName: '真实供应商品快照' });
    await f.maintenanceDb.insert(storeProductAttrValue).values({ ...attr, id: 2, productId: 71, unique: 'qapay002', settlePrice: '2.00' });
    const now = Math.floor(Date.now() / 1000);
    await appendRoutineSubscriptionAccountPolicy(f.maintenanceDb, f.env, named(), { operationId: randomUUID(), expectedRevision: 0, data: {
      accountId: routineSubscriptionAccountId(f.env, A), state: 'active', appId: A, credentialRef: SUBREF, credentialVersion: 1,
      credentialStamp: routineSubscriptionCredentialCommitment(f.env, SUBREF, 1).credentialStamp, purposes: ['subscription_send'],
      templates: [{ mark: '1927', templateId: MINI_TEMPLATE }], validFrom: now - 60, validUntil: now + 7200 } });
    await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, 'order_pay_success'));
    await f.maintenanceDb.insert(systemNotification).values({ mark: 'order_pay_success', isSystem: 1, isSms: 1, isWechat: 1, isRoutine: 1,
      smsId: SMS_TEMPLATE, systemTitle: '付款 {order_id}', systemText: '{pay_price} {total_num}' });
    await f.maintenanceDb.delete(notificationTemplate).where(inArray(notificationTemplate.mark, ['43216', '1927']));
    await f.maintenanceDb.insert(notificationTemplate).values([{ mark: '43216', legacyType: 1, status: 1, tempid: OFFICIAL_TEMPLATE },
      { mark: '1927', legacyType: 0, status: 1, tempid: 'current_b_must_not_supply_original_template' }]);
    provider(); loginUid = 11; await identity(11);
    const legacy = await checkout({ split: true });
    [legacyPaid] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, legacy.id), eq(storeOrderOutbox.eventType, 'order.paid')));
    expect(legacyPaid.payload).not.toHaveProperty('payNoticeAdmission');
    await runPaidNoticeUpgrade(f.maintenanceDb);
  }, 240000);
  afterAll(async () => { try { await f?.close(); } finally { vi.restoreAllMocks(); } }, 30000);

  it('does not backfill a genuine pre-0200 paid pending source after commissioning', async () => {
    expect(legacyPaid.status).not.toBe('COMPLETED'); await consume(legacyPaid);
    const [root] = await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, legacyPaid.aggregateId));
    const children = await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.pid, root.id));
    expect(root).toMatchObject({ pid: -1, type: 0, paid: 1 }); expect(children).toHaveLength(2);
    expect(new Set(children.map(child => child.supplierId))).toEqual(new Set([0, 201]));
    expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, 'order.pay.success.notice'))).toHaveLength(0);
    const [source] = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, legacyPaid.id));
    expect(source.payload).not.toHaveProperty('payNoticeAdmission'); expect(source.status).toBe('COMPLETED');
    const before = await paidEffects(root.id), beforePosts = structuredClone(posts), beforeMessages = f.messages.length;
    await expect(outbox().processMessage({ action: 'processOrderPaidOutbox', outboxId: source.id, eventKey: source.eventKey }))
      .rejects.toThrow('Distributor upgrade requires the actual paid root order');
    expect(await paidEffects(root.id)).toEqual(before); expect(posts).toEqual(beforePosts); expect(f.messages).toHaveLength(beforeMessages);
    expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, source.id))).toEqual([source]);
    expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, 'order.pay.success.notice'))).toHaveLength(0);
  });
  it('sends four actual channels after a real balance checkout, using uniquely owned A after current switches to B', async () => {
    const order = await checkout(), { paid, events } = await notices(order); expect(events).toHaveLength(1);
    const p = events[0].payload as OrderPaidNoticeOutboxPayload;
    expect(p.routineSubscriptionRequest).toMatchObject({ format: 7, actor: { role: f.appRuntime.role }, selection: { mode: 'unique-owner', appId: A, openid: OWNER[11] } });
    expect(p.paymentEventId).toBe(paid.id); await send(events[0]);
    expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.routine_original_payment_evidence`)).toHaveLength(0);
    expect(await f.maintenanceDb.execute(sql`SELECT record_id FROM public.routine_payment_account_policy`)).toHaveLength(0);
    const [row] = await rows(events[0]); expect(row).toBeDefined();
    expect(posts.filter(p => p.orderNo === order.orderId).map(p => p.channel).sort()).toEqual(['mini', 'official', 'sms']);
    const attempts = await f.maintenanceDb.execute(sql`SELECT * FROM public.routine_subscribe_attempt WHERE payload->'claim'->>'eventKey'=${events[0].eventKey}`);
    expect(attempts).toHaveLength(1); expect((attempts[0] as { payload: { facts: { payment: { kind: string } } } }).payload.facts.payment.kind).toBe('unique-identity');
  });
  it('keeps the admitted payment intact through a real all-remaining Customer writeoff on the commissioned Cashier LOGIN', async () => {
    const order = await checkout(), { paid, events } = await notices(order); await send(events[0]);
    const scope = await f.request('/mobile/work/context', undefined, undefined, 101);
    expect(scope.body.status, scope.body.msg).toBe(200);
    const actor = f.actor(), service = new CustomerWorkWriteoffService(createContainerFromDb(f.cashierRuntime.db), f.env);
    const read = await service.reader.order(actor, order.id, { scope_key: scope.body.data.scope_key, order_no: order.orderId }), target = read.data;
    expect(target.actions.writeoff.available, target.actions.writeoff.reason).toBe(true);
    const input: WriteoffInput = { version: CUSTOMER_WRITEOFF_VERSION, scope_key: scope.body.data.scope_key, order_id: order.id,
      expected_order_revision: target.order_revision, expected_writeoff_revision: target.writeoff_revision,
      payload: { order_no: target.order_no, root_order_id: target.root_order_id, root_order_no: target.root_order_no,
        code: target.code, target_fingerprint: target.target_fingerprint,
        items: target.carts.filter(cart => cart.write_surplus_times > 0)
          .map(cart => ({ cart_row_id: cart.cart_row_id, writeoff_num: cart.write_surplus_times })) } };
    expect(input.payload.items.length).toBeGreaterThan(0);
    const context = { actor, request_key: randomUUID() }, result = await service.execute(context, input);
    expect(result.execution).toMatchObject({ state: 'SQL_COMMITTED', committed: true, verified: true, order_completed: true });
    const receipt = result.receipt; if (!receipt) throw Error('Actual Customer writeoff receipt missing');
    expect(receipt.outcome).toBe('written-off');
    expect(receipt.evidence.settlement).toMatchObject({ new_paid_outbox_count: 0, paid_outbox_rows: [{ row_id: paid.id,
      event_key: paid.eventKey, event_type: 'order.paid', payload_hash: await outRequestHash(paid.payload) }] });
    const records = await f.maintenanceDb.select().from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, order.id)).orderBy(asc(storeOrderWriteoff.id));
    expect(records.map(row => ({ cart_row_id: row.orderCartId, writeoff_num: row.writeoffNum }))).toEqual(input.payload.items);
    expect((await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0]).toMatchObject({ paid: 1, status: 2, verifyCode: '' });
    const [source] = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, paid.id));
    expect(source.payload).toEqual(paid.payload); expect(source.status).toBe('COMPLETED');
    expect(source.payload).toHaveProperty('payNoticeAdmission.format', 1);
    expect((await service.execute(context, input)).execution).toMatchObject({ state: 'SQL_COMMITTED', verified: true, order_completed: true });
    expect(await f.maintenanceDb.select().from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid, order.id))).toHaveLength(records.length);
  });
  it('never adopts an old unavailable request after a second live bare identity is repaired', async () => {
    const [bare] = await f.maintenanceDb.insert(wechatUser).values({ uid: 11, userType: 'routine', openid: 'paid_bare_unowned_b', isDel: 0 }).returning();
    const order = await checkout(), { events } = await notices(order);
    expect((events[0].payload as OrderPaidNoticeOutboxPayload).routineSubscriptionRequest).toEqual({ format: 7, unavailable: true });
    await f.maintenanceDb.update(wechatUser).set({ isDel: 1 }).where(eq(wechatUser.id, bare.id)); await send(events[0], 'skipped');
    const fresh = await checkout(), next = await notices(fresh); await send(next.events[0]);
  });
  it('does not adopt an unknown UID after later real phone continuity creates its ownership', async () => {
    const order = await checkout({ uid: 22 }), { events } = await notices(order);
    expect((events[0].payload as OrderPaidNoticeOutboxPayload).routineSubscriptionRequest).toEqual({ format: 7, unavailable: true });
    loginUid = 22; await identity(22); await send(events[0], 'skipped');
    const fresh = await checkout({ uid: 22 }), next = await notices(fresh); await send(next.events[0]);
  });
  it('persists an actual unknown Mini attempt and never repeats its provider POST', async () => {
    const order = await checkout(), { events } = await notices(order); lostMini.add(order.orderId);
    const messages = await send(events[0], 'unknown'), mini = messages.find(m => m.channel === 'wechat_routine')!;
    const before = posts.filter(p => p.orderNo === order.orderId && p.channel === 'mini').length;
    expect(await delivery().processMessage(mini, network)).toBe('unknown');
    expect(posts.filter(p => p.orderNo === order.orderId && p.channel === 'mini')).toHaveLength(before);
    expect(await f.maintenanceDb.execute(sql`SELECT a.attempt_id FROM public.routine_subscribe_attempt a WHERE a.delivery_id=${mini.deliveryId}`)).toHaveLength(1);
    expect(await f.maintenanceDb.execute(sql`SELECT r.result_id FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${mini.deliveryId}`)).toHaveLength(0);
    lostMini.delete(order.orderId);
  });
  it('notifies each actual supplier allocation child once and never the split payment root', async () => {
    const order = await checkout({ split: true }), { paid, events } = await notices(order);
    const [root] = await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, order.id)); expect(root.pid).toBe(-1);
    expect(events).toHaveLength(2); expect(events.every(e => e.aggregateId !== root.id && (e.payload as OrderPaidNoticeOutboxPayload).paymentOrderId === root.id)).toBe(true);
    const children = await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.pid, root.id));
    expect(new Set(children.map(c => c.supplierId))).toEqual(new Set([0, 201]));
    expect(new Set(events.map(e => e.aggregateId))).toEqual(new Set(children.map(c => c.id)));
    for (const event of events) await send(event);
    const before = posts.length; expect(await outbox().processMessage({ action: 'processOrderPaidOutbox', outboxId: paid.id, eventKey: paid.eventKey })).toBe('already-completed');
    expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, `order.pay.success.notice:${root.id}`))).toHaveLength(0);
    expect(posts).toHaveLength(before);
    const message = { action: 'processOrderPaidOutbox' as const, outboxId: paid.id, eventKey: paid.eventKey };
    const rejectCorruption = async () => {
      const effects = await paidEffects(root.id), sent = structuredClone(posts), queued = f.messages.length;
      const stored = await f.maintenanceDb.select().from(storeOrderOutbox).orderBy(asc(storeOrderOutbox.id));
      const deliveries = await f.maintenanceDb.select().from(orderNotificationDelivery).orderBy(asc(orderNotificationDelivery.id));
      const inbox = await f.maintenanceDb.select().from(systemMessage).orderBy(asc(systemMessage.id));
      await expect(outbox().processMessage(message)).rejects.toThrow('Distributor upgrade requires the actual paid root order');
      expect(await paidEffects(root.id)).toEqual(effects); expect(posts).toEqual(sent); expect(f.messages).toHaveLength(queued);
      expect(await f.maintenanceDb.select().from(storeOrderOutbox).orderBy(asc(storeOrderOutbox.id))).toEqual(stored);
      expect(await f.maintenanceDb.select().from(orderNotificationDelivery).orderBy(asc(orderNotificationDelivery.id))).toEqual(deliveries);
      expect(await f.maintenanceDb.select().from(systemMessage).orderBy(asc(systemMessage.id))).toEqual(inbox);
    };
    const original = events[0].payload as OrderPaidNoticeOutboxPayload;
    await f.withMaintenancePeer(async peer => { await peer.update(storeOrderOutbox).set({ payload: { ...original, paymentAdmissionNonce: randomUUID() } }).where(eq(storeOrderOutbox.id, events[0].id)); });
    try { await rejectCorruption(); }
    finally { await f.withMaintenancePeer(async peer => { await peer.update(storeOrderOutbox).set({ payload: original }).where(eq(storeOrderOutbox.id, events[0].id)); }); }
    expect(await outbox().processMessage(message)).toBe('already-completed');
    // Maintenance-only structural drift is a negative proof, not an actual
    // refund author or a replacement for the independent refund acceptance.
    await f.withMaintenancePeer(async peer => { await peer.update(storeOrder).set({ refundType: 6 }).where(eq(storeOrder.id, children[0].id)); });
    try { await rejectCorruption(); }
    finally { await f.withMaintenancePeer(async peer => { await peer.update(storeOrder).set({ refundType: children[0].refundType }).where(eq(storeOrder.id, children[0].id)); }); }
    expect(await outbox().processMessage(message)).toBe('already-completed');
    // This maintenance-only root counterexample deliberately references a
    // different genuine paid event, so a paymentEventId-only batch query misses
    // it. It is never dispatched or represented as a normal notice author.
    expect(legacyPaid.id).not.toBe(paid.id);
    const forgedPayload: OrderPaidNoticeOutboxPayload = { ...original, paymentEventId: legacyPaid.id,
      orderId: root.id, orderNo: root.orderId, payPrice: root.payPrice, totalNum: root.totalNum };
    const [forged] = await f.withMaintenancePeer(async peer => await peer.insert(storeOrderOutbox).values({
      eventKey: `order.pay.success.notice:${root.id}`, aggregateType: 'order', aggregateId: root.id, eventType: 'order.pay.success.notice',
      payload: forgedPayload, status: 'PENDING', availableTime: original.occurredAt, addTime: original.occurredAt, updateTime: original.occurredAt }).returning());
    if (!forged) throw Error('Maintenance root-notice counterexample was not inserted');
    try { await rejectCorruption(); }
    finally { await f.withMaintenancePeer(async peer => { await peer.delete(storeOrderOutbox).where(and(eq(storeOrderOutbox.id, forged.id), eq(storeOrderOutbox.eventKey, forged.eventKey))); }); }
    expect(await outbox().processMessage(message)).toBe('already-completed'); expect(posts).toHaveLength(before);
  });
  it('retries the same admitted paid source after real candidate SELECT lock contention without freezing unavailable', async () => {
    const order = await checkout({ split: true });
    const [paid] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, order.id), eq(storeOrderOutbox.eventType, 'order.paid')));
    const message = { action: 'processOrderPaidOutbox' as const, outboxId: paid.id, eventKey: paid.eventKey }, before = await paidEffects(order.id);
    // The independent, verified maintenance LOGIN owns only this held table
    // lock. The real App's bounded catalog/identity SELECT must fail in SQL;
    // its candidate SAVEPOINT must not reinterpret that as absent ownership.
    await f.withMaintenancePeer(peer => peer.transaction(async held => {
      await held.execute(sql`LOCK TABLE ONLY public.routine_identity_ownership IN ACCESS EXCLUSIVE MODE NOWAIT`);
      const failure: unknown = await outbox().processMessage(message).then(() => null, error => error);
      expect(failure).toBeInstanceOf(Error);
      const states: unknown[] = []; let error = failure;
      while (error && typeof error === 'object' && states.length < 8) {
        const row = error as { code?: unknown; cause?: unknown }; states.push(row.code); error = row.cause;
      }
      expect(states).toContain('55P03');
      expect(await paidEffects(order.id)).toEqual(before);
      const [source] = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, paid.id));
      expect(source.status).toBe('FAILED'); expect(source.payload).toEqual(paid.payload);
      expect((await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0].paid).toBe(1);
      expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, 'order.pay.success.notice')))
        .filter(event => (event.payload as OrderPaidNoticeOutboxPayload).paymentEventId === paid.id)).toHaveLength(0);
    }));
    expect(await outbox().processMessage(message)).toBe('completed');
    const events = (await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, 'order.pay.success.notice')))
      .filter(event => (event.payload as OrderPaidNoticeOutboxPayload).paymentEventId === paid.id);
    expect(events).toHaveLength(2);
    for (const event of events) {
      const payload = event.payload as OrderPaidNoticeOutboxPayload;
      expect(payload.routineSubscriptionRequest).toMatchObject({ format: 7, selection: { mode: 'unique-owner', appId: A, openid: OWNER[11] } });
      expect(payload.routineSubscriptionRequest).not.toHaveProperty('unavailable');
      expected.set(payload.orderNo, payload); await send(event);
    }
    const complete = await paidEffects(order.id); expect(await outbox().processMessage(message)).toBe('already-completed');
    expect(await paidEffects(order.id)).toEqual(complete);
  });
  it('rolls back actual allocation, financial post-effects and every notice on returned INSERT corruption, then retries once', async () => {
    const order = await checkout({ split: true });
    const [paid] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, order.id), eq(storeOrderOutbox.eventType, 'order.paid')));
    const snapshot = () => paidEffects(order.id);
    const before = await snapshot();
    await f.exec(`CREATE FUNCTION public.owned_paid_notice_corruption() RETURNS trigger LANGUAGE plpgsql AS $owned$ BEGIN
      IF NEW.event_type='order.pay.success.notice' THEN NEW.payload=pg_catalog.jsonb_set(NEW.payload,'{payPrice}','"0.00"'::jsonb); END IF;
      RETURN NEW; END $owned$;
      CREATE TRIGGER owned_paid_notice_corruption BEFORE INSERT ON public.store_order_outbox FOR EACH ROW EXECUTE FUNCTION public.owned_paid_notice_corruption()`);
    try {
      await expect(outbox().processMessage({ action: 'processOrderPaidOutbox', outboxId: paid.id, eventKey: paid.eventKey })).rejects.toThrow('付款通知批次不可变字段冲突');
      expect(await snapshot()).toEqual(before);
      const [source] = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, paid.id)); expect(source.status).toBe('FAILED');
      expect((await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0].paid).toBe(1);
      expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, 'order.pay.success.notice'))
        .then(events => events.filter(event => (event.payload as OrderPaidNoticeOutboxPayload).paymentEventId === paid.id))).toHaveLength(0);
    } finally { await f.exec('DROP TRIGGER owned_paid_notice_corruption ON public.store_order_outbox; DROP FUNCTION public.owned_paid_notice_corruption()'); }
    const message = { action: 'processOrderPaidOutbox' as const, outboxId: paid.id, eventKey: paid.eventKey };
    expect(await outbox().processMessage(message)).toBe('completed');
    const events = (await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, 'order.pay.success.notice')))
      .filter(event => (event.payload as OrderPaidNoticeOutboxPayload).paymentEventId === paid.id);
    expect(events).toHaveLength(2);
    for (const event of events) { expected.set((event.payload as OrderPaidNoticeOutboxPayload).orderNo, event.payload as OrderPaidNoticeOutboxPayload); await send(event); }
    const complete = await snapshot(); expect(await outbox().processMessage(message)).toBe('already-completed'); expect(await snapshot()).toEqual(complete);
    for (const event of events) expect(await outbox().processMessage({ action: 'processOrderNotificationOutbox', outboxId: event.id, eventKey: event.eventKey })).toBe('already-completed');
  });
  it('uses a real approved signed JSAPI payment source for Mini1927 without using its payer as recipient', async () => {
    await current(A); const now = Math.floor(Date.now() / 1000);
    await config({ pay_weixin_open: '1', pay_weixin_mchid: MERCHANT, pay_weixin_serial_no: 'A1B2C3D4', site_url: 'https://paid-notice.example' });
    await appendRoutinePaymentAccountPolicy(f.maintenanceDb, f.env, named(), { operationId: randomUUID(), expectedRevision: 0, kind: 'account', data: {
      accountId: ACCOUNT, state: 'active', ...routinePaymentCredentialCommitment(f.env, REF, 1), credentialRef: REF, credentialVersion: 1,
      purposes: ['notify', 'query'], validFrom: now - 60, validUntil: now + 7200 } });
    const order = await checkout({ payType: 'weixin' }), payer = 'paid_unrelated_verified_payer';
    expect(prepayRequests).toEqual([order.orderId]);
    expect(await f.maintenanceDb.execute<{ event_kind: string }>(sql`SELECT event_kind FROM public.routine_payment_attempt
      WHERE order_no=${order.orderId} ORDER BY event_kind`)).toEqual([{ event_kind: 'INITIATION' }, { event_kind: 'PREPAY' }]);
    const nonce = Buffer.from(randomBytes(6)).toString('hex'), aad = 'transaction';
    const plain = { appid: A, mchid: MERCHANT, out_trade_no: order.orderId, transaction_id: 'paid_notice_tx_' + randomUUID().replaceAll('-', ''),
      trade_state: 'SUCCESS', trade_type: 'JSAPI', payer: { openid: payer }, success_time: new Date().toISOString(), amount: { total: Number(order.payPrice) * 100, currency: 'CNY' } };
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(AES), Buffer.from(nonce)); cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plain)), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const body = JSON.stringify({ id: randomUUID(), event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource: {
      algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', ciphertext, nonce, associated_data: aad } });
    const timestamp = String(now), pending: Promise<unknown>[] = [], h = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    h.use('*', async (c, next) => { c.set('container', app()); await next(); }); h.onError(errorHandler); h.route('/api', v1Routes);
    const before = f.messages.length;
    const response = await h.request('/api/pay/notify/routine-account/' + ACCOUNT, { method: 'POST', body, headers: { 'content-type': 'application/json',
      'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': SERIAL,
      'wechatpay-signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), keys.privateKey)).toString('base64') } }, f.env,
      { waitUntil: p => pending.push(p), props: {}, passThroughOnException: () => { throw Error('Unexpected callback fallback'); } });
    await Promise.all(pending); expect(response.status).toBe(200);
    const callback = f.messages.slice(before).find(isPaymentCallbackMessage); expect(callback).toBeDefined();
    expect(await new PaymentCallbackEventService(app(), f.env).processMessage(callback!)).toBe('completed');
    await current(); await config({ order_shipping_open: 1 });
    const { paid, events } = await notices(order, false);
    const pickup = await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey, paid.eventKey), eq(orderNotificationDelivery.channel, 'wechat_shipping')));
    expect(pickup).toHaveLength(1); expect(pickup[0]).toMatchObject({ status: 'PENDING', noticeMark: 'paid_pickup_shipping',
      orderId: order.id, payload: { kind: 'wechat_shipping', transactionId: plain.transaction_id, logisticsType: 4 } });
    expect(paid.payload).toHaveProperty('payNoticeAdmission.format', 1);
    expect((events[0].payload as OrderPaidNoticeOutboxPayload).routineSubscriptionRequest).toMatchObject({ format: 7,
      selection: { mode: 'routine-original', appId: A, openid: OWNER[11] } });
    await send(events[0]); const [mini] = (await rows(events[0])).filter(r => r.channel === 'wechat_routine');
    const [attempt] = await f.maintenanceDb.execute<{ payload: { facts: { payment: { kind: string } } } }>(sql`SELECT payload FROM public.routine_subscribe_attempt WHERE delivery_id=${mini.id}`);
    expect(attempt.payload.facts.payment.kind).toBe('routine-original'); expect(posts.filter(p => p.orderNo === order.orderId && p.channel === 'mini')).toHaveLength(1);
  });
});
