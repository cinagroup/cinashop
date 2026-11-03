/** Complete actual five-LOGIN fixture. Only catalog/users/config and signed
 * maintenance policy authors bootstrap; all carts/orders/paid/group/outbox
 * facts come from production Admin, JWT v1 and RSA/AES approved callbacks. */
import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { notificationTemplate, storeOrder, storeOrderOutbox, storePink, storeProduct, storeProductAttrValue,
  systemConfig, systemNotification, user, userAddress } from '@/models/schema';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { upgradeFulfillmentCityConflictReaders } from '@/migrations/upgradeFulfillmentCityConflictReaders';
import { AdminCombinationService } from '@/services/admin/AdminCombinationService';
import { CombinationSkuCatalogService } from '@/services/activity/CombinationSkuCatalogService';
import { PinkTimeoutService } from '@/services/activity/PinkTimeoutService';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { amountToCents } from '@/services/payment/RefundGateway';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment,
  type RoutineSubscriptionAccountPolicy } from '@/services/wechat/RoutineSubscriptionAccount';
import { createToken, md5 } from '@/utils/jwt';
import { customerCashierRuntimeHttpFixture } from './customerCashierRuntimeHttpFixture';
import { combinationInput } from './combinationAdminFixture';
import { paymentQueryKeys } from './paymentQueryFixture';

export const PINK_CURRENT_B = 'wx_pink_current_b', PINK_MARK = 'order_user_groups_success', PINK_GLOBAL_B = 'pink_global_current_b';
export const PINK_ACCOUNTS = {
  a: { appId: 'wx_pink_original_a', merchantId: '1900000501', accountId: 'pink_account_original_a', ref: 'pink_payment_a', subRef: 'pink_subscription_a',
    aes: 'a'.repeat(32), serial: 'PUB_PINK_A', secret: 'synthetic-pink-subscription-a', template: 'pink_original_template_a', payer: 'pink_verified_payer_a', target: 'pink_exact_owned_a', uid: 11, phone: '13800000011' },
  c: { appId: 'wx_pink_original_c', merchantId: '1900000503', accountId: 'pink_account_original_c', ref: 'pink_payment_c', subRef: 'pink_subscription_c',
    aes: 'c'.repeat(32), serial: 'PUB_PINK_C', secret: 'synthetic-pink-subscription-c', template: 'pink_original_template_c', payer: 'pink_verified_payer_c', target: 'pink_exact_owned_c', uid: 22, phone: '13800000022' },
} as const;
export type PinkAccount = keyof typeof PINK_ACCOUNTS;
export async function routineSubscriptionPinkFixture() {
  const f = await customerCashierRuntimeHttpFixture();
  try {
    const keys = { a: paymentQueryKeys(), c: paymentQueryKeys() };
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineSubscriptionUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runAdminWechatAppUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    const city = { owner: (await f.createOwnedRole('pinknoticecity')).role, app: true, admin: true, manager: true } as const;
    const commissioned = await upgradeFulfillmentCityConflictReaders(f.maintenanceDb, f.target, { readers: city },
      { ...f.peers, cityConflictReaders: city }, f.appReaders);
    const peers = commissioned.peers;
    const app = () => createContainerFromDb(f.appRuntime.db);
    const named = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
    Object.assign(f.env, {
      ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: JSON.stringify({ format: 1, credentials: (['a', 'c'] as const).map(kind => {
        const a = PINK_ACCOUNTS[kind], k = keys[kind]; return { ref: a.ref, version: 1, appId: a.appId, merchantId: a.merchantId,
          serialNo: 'A1B2C3D4', apiV3Key: a.aes, privateKey: k.privateKey, platformPublicKey: k.publicKey, platformPublicKeyId: a.serial };
      }) }),
      ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS: JSON.stringify({ format: 1, credentials: (['a', 'c'] as const).map(kind => {
        const a = PINK_ACCOUNTS[kind]; return { ref: a.subRef, version: 1, appId: a.appId, secret: a.secret };
      }) }),
    });
    const now = Math.floor(Date.now() / 1000), revisions = { a: 0, c: 0 }, policies = {} as Record<PinkAccount, RoutineSubscriptionAccountPolicy>;
    for (const kind of ['a', 'c'] as const) {
      const a = PINK_ACCOUNTS[kind];
      await appendRoutinePaymentAccountPolicy(f.maintenanceDb, f.env, named(), { operationId: randomUUID(), expectedRevision: 0, kind: 'account', data: {
        accountId: a.accountId, state: 'active', ...routinePaymentCredentialCommitment(f.env, a.ref, 1), credentialRef: a.ref, credentialVersion: 1,
        purposes: ['notify', 'query'], validFrom: now - 60, validUntil: now + 7200,
      } });
      policies[kind] = { accountId: routineSubscriptionAccountId(f.env, a.appId), state: 'active', appId: a.appId, credentialRef: a.subRef,
        credentialVersion: 1, credentialStamp: routineSubscriptionCredentialCommitment(f.env, a.subRef, 1).credentialStamp,
        purposes: ['subscription_send'], templates: [{ mark: '3098', templateId: a.template }], validFrom: now - 60, validUntil: now + 7200 };
    }
    const approve = async (kind: PinkAccount, patch: Partial<RoutineSubscriptionAccountPolicy> = {}) => {
      const row = await appendRoutineSubscriptionAccountPolicy(f.maintenanceDb, f.env, named(), {
        operationId: randomUUID(), expectedRevision: revisions[kind], data: { ...policies[kind], ...patch },
      }); revisions[kind] = row.revision; return row;
    };
    await approve('a'); await approve('c');
    // Explicit source catalog/identity bootstrap. No paid order or group row.
    await f.maintenanceDb.update(storeProduct).set({ type: 0, relationId: 0, systemFormId: 0, productType: 0, isPresaleProduct: 0,
      isVipProduct: 0, isVerify: 1, isVip: 0, isLimit: 0, stock: 500, sales: 0, freight: 1, deliveryType: '1',
      sliderImage: '["/images/pink-notice.png"]' }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ stock: 500, sales: 0, price: '5.00', vipPrice: '5.00' }).where(eq(storeProductAttrValue.id, 1));
    await f.maintenanceDb.update(user).set({ phone: PINK_ACCOUNTS.a.phone, pwd: 'owned-financial-password', nickname: '原生团长123' }).where(eq(user.uid, 11));
    await f.maintenanceDb.insert(user).values({ uid: 22, account: 'pink-native-buyer-c', pwd: 'owned-financial-password', nickname: '原生成员456',
      phone: PINK_ACCOUNTS.c.phone, status: 1, nowMoney: '100.00' }).onConflictDoNothing();
    await f.maintenanceDb.update(user).set({ pwd: 'owned-financial-password', nickname: '原生成员456', phone: PINK_ACCOUNTS.c.phone,
      status: 1, isDel: 0, deleteTime: null, nowMoney: '100.00' }).where(eq(user.uid, 22));
    const [address] = await f.maintenanceDb.select().from(userAddress).where(eq(userAddress.id, 11));
    if (!address) throw Error('Actual source address absent');
    await f.maintenanceDb.insert(userAddress).values({ ...address, id: 22, uid: 22, phone: PINK_ACCOUNTS.c.phone });
    await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark, PINK_MARK));
    await f.maintenanceDb.insert(systemNotification).values({ mark: PINK_MARK, isSystem: 1, isSms: 1, isWechat: 0, isRoutine: 1,
      smsId: 'synthetic_pink_sms', systemTitle: '成团 {order_id}', systemText: '{store_name} 已成团' });
    await f.maintenanceDb.delete(notificationTemplate).where(and(eq(notificationTemplate.mark, '3098'), eq(notificationTemplate.legacyType, 0)));
    await f.maintenanceDb.insert(notificationTemplate).values({ mark: '3098', legacyType: 0, status: 1, tempid: PINK_GLOBAL_B });
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),(SELECT max(id) FROM store_product_attr_value),true)");
    await f.exec("SELECT setval(pg_get_serial_sequence('store_cart','id'),GREATEST(COALESCE((SELECT max(id) FROM store_cart),0),1),true)");
    const current = async (value: string = PINK_CURRENT_B) => {
      const cfg = { routine_appId: value, routine_appsecret: value ? 'synthetic-pink-current-secret' : '', wechat_appid: PINK_CURRENT_B,
        wechat_app_appid: 'wx_pink_native_distinct', pay_weixin_mchid: '1900000502', pay_weixin_serial_no: 'B1B2C3D4', pay_weixin_open: '1', order_shipping_open: '0' };
      await f.setConfig(cfg); await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName, Object.keys(cfg)));
      await f.maintenanceDb.insert(systemConfig).values(Object.entries(cfg).map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 20 })));
    };
    const http = async (path: string, body?: unknown, uid = 11) => {
      const token = (await createToken(uid, 'api', md5('owned-financial-password'), f.env.APP_KEY)).token;
      const response = await f.raw(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json() as { status: number; msg: string; data: any };
      if (response.status !== 200 || result.status !== 200) throw Error('Actual buyer JWT route refused ' + path + ': ' + result.msg);
      return result.data;
    };
    const actual = async (id: number) => (await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, id)))[0]!;
    const combination = async (people = 2, virtual = 100) => {
      const service = new AdminCombinationService(createContainerFromDb(f.adminRuntime.db), f.env.APP_KEY);
      const result = await service.mutate('create', 0, combinationInput({ product_id: 70, title: '原生3098成团商品', people, virtual,
        effective_time: 1, num: 20, once_num: 1, is_support_refund: 1,
        shipping: { delivery_type: [1], freight: 1, postage: '0.00', temp_id: 0 },
        skus: [{ id: null, base_unique: 'qared001', enabled: true, price: '5.00', quota_total: 20, image: '/images/pink-notice.png' }],
      }), { id: 1 }); return result.id;
    };
    const unpaid = async (combinationId: number, uid: number, pinkId = 0) => {
      const catalog = await new CombinationSkuCatalogService(app()).read(uid, String(combinationId));
      if (catalog.skus.length !== 1) throw Error('Actual Admin combination SKU absent');
      const cart = await http('/cart/add', { productId: 70, unique: catalog.skus[0].unique, cartNum: 1, type: 3, activityId: combinationId, isNew: 1 }, uid);
      const input = { cartIds: [cart.id], addressId: uid, shippingType: 1, useIntegral: false, type: 3, combinationId, ...(pinkId ? { pinkId } : {}) };
      const quote = await http('/order/confirm', input, uid);
      const created = await http('/order/create/' + quote.orderKey, { ...input, quoteToken: quote.quoteToken, from: 'routine' }, uid);
      const row = await f.container.storeOrderDao.findByOrderId(created.orderId);
      if (!row || row.paid !== 0 || row.uid !== uid || row.type !== 3 || row.activityId !== combinationId) throw Error('Actual type3 checkout source absent');
      return row;
    };
    const paid = async (order: typeof storeOrder.$inferSelect, kind: PinkAccount) => {
      const a = PINK_ACCOUNTS[kind], k = keys[kind], total = amountToCents(order.payPrice);
      const [currentRow] = await f.maintenanceDb.select().from(systemConfig).where(eq(systemConfig.menuName, 'routine_appId'));
      const selectedCurrent = JSON.parse(currentRow.value);
      if (selectedCurrent !== PINK_CURRENT_B && selectedCurrent !== '') throw Error('Original callback must not restore A/C current configuration');
      if (total === null || total <= 0) throw Error('Actual checkout amount absent');
      const transactionId = 'pink_tx_' + randomUUID().replaceAll('-', ''), nonce = Buffer.from(randomBytes(6)).toString('hex'), aad = 'transaction';
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(a.aes), Buffer.from(nonce)); cipher.setAAD(Buffer.from(aad));
      const plain = { appid: a.appId, mchid: a.merchantId, out_trade_no: order.orderId, transaction_id: transactionId,
        trade_state: 'SUCCESS', trade_type: 'JSAPI', payer: { openid: a.payer }, success_time: new Date().toISOString(), amount: { total, currency: 'CNY' } };
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plain)), cipher.final(), cipher.getAuthTag()]).toString('base64');
      const body = JSON.stringify({ id: randomUUID(), event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource',
        resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', ciphertext, nonce, associated_data: aad } });
      const timestamp = String(Math.floor(Date.now() / 1000)), h = new Hono<{ Bindings: Env; Variables: AppVariables }>(), pending: Promise<unknown>[] = [];
      h.use('*', async (c, next) => { c.set('container', app()); await next(); }); h.onError(errorHandler); h.route('/api', v1Routes);
      const before = f.messages.length, response = await h.request('/api/pay/notify/routine-account/' + a.accountId,
        { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce,
          'Wechatpay-Serial': a.serial, 'Wechatpay-Signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), k.privateKey)).toString('base64') } }, f.env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), props: {}, passThroughOnException: () => { throw Error('Unexpected approved callback fallback'); } });
      await Promise.all(pending);
      if (response.status !== 200) throw Error('Actual approved-original callback refused: ' + await response.text());
      const message = f.messages.slice(before).find(isPaymentCallbackMessage);
      if (!message || await new PaymentCallbackEventService(app(), f.env).processMessage(message) !== 'completed') throw Error('Actual callback consumer did not complete');
      const [evidence] = await f.maintenanceDb.execute(sql`SELECT * FROM public.routine_original_payment_evidence WHERE order_no=${order.orderId}`);
      const parsed = parseRoutineOriginalEvidence(f.env, evidence);
      if (parsed.payload.observation.facts.appId !== a.appId || parsed.payload.observation.facts.payerId !== a.payer
        || parsed.payload.binding.state !== 'bound' || parsed.payload.binding.local?.domain !== 'store_order'
        || parsed.payload.binding.local.orderId !== order.id || parsed.payload.binding.local.buyerUid !== order.uid) throw Error('Actual distinct original payer/App and per-buyer order evidence absent');
      const [afterCurrent] = await f.maintenanceDb.select().from(systemConfig).where(eq(systemConfig.menuName, 'routine_appId'));
      if (JSON.parse(afterCurrent.value) !== selectedCurrent) throw Error('Approved-original callback changed current B configuration');
      const [event] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, order.id), eq(storeOrderOutbox.eventType, 'order.paid')));
      if (!event) throw Error('Actual paid outbox absent'); await f.consume(event);
      const row = await actual(order.id);
      if (row.paid !== 1 || row.payType !== 'weixin' || row.tradeNo !== transactionId || row.pinkId <= 0) throw Error('Actual App paid/group source absent'); return row;
    };
    const group = async (options: { people?: number; virtual?: number; one?: boolean; mixed?: boolean } = {}) => {
      const activityId = await combination(options.people ?? 2, options.virtual ?? 100);
      const first = await paid(await unpaid(activityId, 11), 'a');
      let second: typeof storeOrder.$inferSelect | undefined;
      if (!options.one) {
        const [leader] = await f.maintenanceDb.select().from(storePink).where(eq(storePink.id, first.pinkId));
        // Distinguishable real join timestamps prove per-member date5. This
        // bounded wall-clock wait does not mutate any persisted business fact.
        const wait = Math.max(0, (leader.addTime + 1) * 1000 - Date.now() + 10);
        if (wait > 1200) throw Error('Unexpected future group add time');
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        second = await paid(await unpaid(activityId, 22, first.pinkId), options.mixed === false ? 'a' : 'c');
      }
      const rows = await f.maintenanceDb.select().from(storePink).where(sql`${storePink.id}=${first.pinkId} OR ${storePink.kId}=${first.pinkId}`).orderBy(storePink.id);
      return { activityId, pinkId: first.pinkId, first: await actual(first.id), second: second ? await actual(second.id) : undefined, rows };
    };
    const expire = async (groupId: number) => {
      const [leader] = await f.maintenanceDb.select().from(storePink).where(eq(storePink.id, groupId));
      if (!leader?.stopTime) throw Error('Actual group deadline absent');
      // Existing service's explicit now argument advances its logical deadline
      // beyond this real persisted leader deadline. No one-hour wait and no
      // SQL-created completion/status/member are used as a success positive.
      return new PinkTimeoutService(app(), f.env).expireGroup(groupId, Math.floor(leader.stopTime.getTime() / 1000) + 1);
    };
    const commissionDelivery = () => runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb, f.target, peers, f.appReaders);
    await current();
    return { ...f, peers, app, named, keys, policies, revisions, approve, current, http, actual, combination, unpaid, paid, group, expire, commissionDelivery };
  } catch (error) { await f.close(); throw error; }
}
