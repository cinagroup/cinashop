/** Actual assisted checkout, default RSA/AES Routine callback, App paid consumer,
 * Admin assignment author and exported production Manager router on five independent
 * LOGINs. Maintenance configures catalogs/identities/carriers/account approval;
 * it never manufactures a paid order, cart source, grant, delivery or receipt. */
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { managerAssignedFulfillmentRoutes } from '@/routes/manager-assigned-fulfillment';
import { createToken, md5 } from '@/utils/jwt';
import { expressCompany, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeProduct, storeProductAttrValue,
  systemConfig, systemStore, systemStoreStaff, user, wechatUser } from '@/models/schema';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { upgradeFulfillmentCityConflictReaders } from '@/migrations/upgradeFulfillmentCityConflictReaders';
import { upgradeStoreOrderFulfillmentAssignments } from '@/migrations/upgradeStoreOrderFulfillmentAssignments';
import { upgradeManagerAssignedWholeExpress } from '@/migrations/upgradeManagerAssignedWholeExpress';
import { AdminOrderFulfillmentAssignmentService } from '@/services/admin/AdminOrderFulfillmentAssignmentService';
import type { AssignmentRequest } from '@/services/admin/AdminOrderFulfillmentAssignmentInput';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { appendRoutineShippingAccountPolicy, routineShippingAccountId, routineShippingCredentialCommitment } from '@/services/payment/RoutineShippingAccount';
import { amountToCents } from '@/services/payment/RefundGateway';
import { customerCashierRuntimeHttpFixture } from './customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './paymentQueryFixture';

export const ASSIGNED_APP = 'wx_assigned_shipping_original';
export const ASSIGNED_MERCHANT = '1900000401';
export const ASSIGNED_AES = 'm'.repeat(32);
export const ASSIGNED_PLATFORM = 'PUB_ASSIGNED_SHIPPING_ORIGINAL';
export const ASSIGNED_PAYER = 'assigned_original_verified_payer';
export const ASSIGNED_BUYER_BINDING = 'assigned_unrelated_latest_buyer';
export const ASSIGNED_SHIPPING_SECRET = 'synthetic-assigned-original-shipping-secret';
export const ASSIGNED_CARRIER = { name: '本机分配单承运商', code: 'OWN' };
const SHIPPING_REF = 'assigned_original_appsecret';
const ADMIN_PASSWORD = 'offline-native-admin-password';
const USER_PASSWORD = 'owned-financial-password';

export async function managerAssignedFulfillmentFixture() {
  const f = await customerCashierRuntimeHttpFixture();
  try {
    const keys = paymentQueryKeys();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runRoutineShippingUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    await runAdminWechatAppUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
    const city = { owner: (await f.createOwnedRole('mgrassignedcity')).role, app: true, admin: true, manager: true } as const;
    const first = await upgradeFulfillmentCityConflictReaders(f.maintenanceDb, f.target, { readers: city },
      { ...f.peers, cityConflictReaders: city }, f.appReaders);
    const second = await upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb, f.target, { assignments: true },
      { ...first.peers, fulfillmentAssignments: { assignments: true } }, f.appReaders);
    const commissioned = await upgradeManagerAssignedWholeExpress(f.maintenanceDb, f.target, { receipts: true },
      { ...second.peers, managerAssignedWholeExpress: { receipts: true } }, f.appReaders);
    const peers = commissioned.peers;
    f.env.ADMIN_FULFILLMENT_ASSIGNMENT_RUNTIME = peers;
    f.env.MANAGER_FULFILLMENT_ASSIGNMENT_RUNTIME = peers;
    Object.assign(f.env, { WECHAT_MCH_PRIVATE_KEY: keys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey,
      WECHAT_PLATFORM_PUBLIC_KEY_ID: ASSIGNED_PLATFORM, WECHAT_API_V3_KEY: ASSIGNED_AES,
      ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS: JSON.stringify({ format: 1, credentials: [
        { ref: SHIPPING_REF, version: 1, appId: ASSIGNED_APP, secret: ASSIGNED_SHIPPING_SECRET },
      ] }) });
    // Identity/inventory/carrier configuration only. Existing assisted checkout
    // and both protected business authors create all order and evidence rows.
    await f.maintenanceDb.insert(systemStore).values([77, 78].map(id => ({ id, name: '原生分配履约门店' + id, isStore: 1, isShow: 1, isDel: 0 })));
    await f.maintenanceDb.update(systemStoreStaff).set({ storeId: 77, status: 1, isDel: 0, isManager: 1, isAdmin: 0, orderStatus: 1 }).where(eq(systemStoreStaff.id, 901));
    await f.maintenanceDb.insert(systemStoreStaff).values({ id: 903, uid: 105, storeId: 78, status: 1, isDel: 0, isManager: 1, orderStatus: 1 });
    await f.maintenanceDb.insert(expressCompany).values({ id: 977, code: ASSIGNED_CARRIER.code, name: ASSIGNED_CARRIER.name, isShow: 1, status: 1 });
    await f.maintenanceDb.update(storeProduct).set({ type: 1, relationId: 1, systemFormId: 0, productType: 0, isPresaleProduct: 0,
      stock: 100, sales: 0, freight: 1, isVip: 0, isLimit: 0, deliveryType: '1' }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ stock: 100, sales: 0, price: '5.00', vipPrice: '5.00' }).where(eq(storeProductAttrValue.id, 1));
    await f.maintenanceDb.insert(user).values({ uid: 22, account: 'assigned-original-payer', pwd: USER_PASSWORD, status: 1 }).onConflictDoNothing();
    await f.maintenanceDb.insert(wechatUser).values([{ uid: 22, userType: 'routine', openid: ASSIGNED_PAYER },
      { uid: 11, userType: 'routine', openid: ASSIGNED_BUYER_BINDING }]);
    const now = Math.floor(Date.now() / 1000);
    await appendRoutineShippingAccountPolicy(f.maintenanceDb, f.env, {
      database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin,
    }, { operationId: randomUUID(), expectedRevision: 0,
      data: { accountId: routineShippingAccountId(f.env, ASSIGNED_APP, ASSIGNED_MERCHANT), state: 'active', appId: ASSIGNED_APP,
        merchantId: ASSIGNED_MERCHANT, credentialRef: SHIPPING_REF, credentialVersion: 1,
        credentialStamp: routineShippingCredentialCommitment(f.env, SHIPPING_REF, 1).credentialStamp,
        purposes: ['shipping_upload'], validFrom: now - 60, validUntil: now + 3600 } });
    const configure = async (archived = false) => {
      const config = { routine_appId: archived ? 'wx_assigned_current_B' : ASSIGNED_APP,
        routine_appsecret: archived ? 'synthetic-assigned-current-B' : ASSIGNED_SHIPPING_SECRET,
        wechat_appid: archived ? 'wx_assigned_current_B' : ASSIGNED_APP, wechat_app_appid: 'wx_assigned_native_app',
        pay_weixin_mchid: archived ? '1900000402' : ASSIGNED_MERCHANT, pay_weixin_serial_no: 'A1B2C3D4',
        pay_weixin_open: '1', order_shipping_open: '1' };
      await f.setConfig(config);
      await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName, Object.keys(config)));
      await f.maintenanceDb.insert(systemConfig).values(Object.entries(config).map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 20 })));
    };
    const application = () => createContainerFromDb(f.appRuntime.db);
    const h = () => {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', application()); await next(); });
      app.onError(errorHandler);
      // Match the production app's explicit mount before its /api catchall.
      // The exported router supplies real ordinary-auth and distinct Manager
      // LOGIN middleware. This is a router harness, not createApp coverage.
      app.route('/api/store/manager/assigned-order', managerAssignedFulfillmentRoutes);
      app.route('/api', v1Routes); return app;
    };
    const http = async (path: string, body?: unknown, options: { uid?: number; realm?: 'api' | 'admin'; key?: string; bindings?: Env } = {}) => {
      const uid = options.uid ?? 103, realm = options.realm ?? 'api', pending: Promise<unknown>[] = [];
      const token = (await createToken(uid, realm, md5(realm === 'admin' ? ADMIN_PASSWORD : USER_PASSWORD), f.env.APP_KEY)).token;
      const response = await h().request('/api' + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.key ? { 'Idempotency-Key': options.key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, options.bindings ?? f.env,
      { waitUntil: (p: Promise<unknown>) => pending.push(p), props: {}, passThroughOnException: () => { throw Error('Unexpected assigned route fallback'); } });
      await Promise.all(pending);
      return { response, body: await response.json() as { status: number; msg: string; data: any } };
    };
    const admin = async (path: string, body?: unknown) => {
      const r = await http(path, body, { uid: 1, realm: 'admin' });
      expectHttpSuccess(r); return r.body.data;
    };
    const actual = async (id: number) => (await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id, id)))[0]!;
    const adminActor = () => ({ id: 1, authVersion: md5(ADMIN_PASSWORD), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const managerActor = (uid = 103) => ({ uid, authVersion: md5(USER_PASSWORD), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const author = (db: DbClient = f.adminRuntime.db) => new AdminOrderFulfillmentAssignmentService(createContainerFromDb(db), peers);
    const decide = async (id: number, target = 77, kind: 'grant' | 'revoke' = 'grant') => {
      const reviewed = await author().review(String(id), new URLSearchParams(), adminActor());
      const source = kind === 'grant' ? reviewed.grant : reviewed.revoke;
      if (!source) throw Error('Actual Admin assignment review has no requested source: ' + reviewed.grant_reason);
      const input: AssignmentRequest = { format_version: 1, operation_id: randomUUID(), kind, order_id: id, target_store_id: target,
        expected_head: reviewed.expected_head, expected_order_revision: source.order_revision, expected_source_hash: source.source_hash };
      return { input, ...await author().commit(input, adminActor()) };
    };
    const paid = async (quantity = 1, type: 0 | 1 = 1) => {
      await configure();
      await f.maintenanceDb.update(storeProduct).set({ type, relationId: type === 1 ? 1 : 0 }).where(eq(storeProduct.id, 70));
      const cart = await admin('/admin/order/cart/add/11', { tourist_uid: '', productId: 70, uniqueId: 'qared001', cartNum: quantity, new: 1 });
      const selection = { cartId: [cart.cartId], tourist_uid: '', new: 1, shipping_type: 1, store_id: 1, addressId: 11,
        real_name: '', phone: '', payType: 'cash', useIntegral: false, couponId: 0, from: 'pc' };
      const quote = await admin('/admin/order/confirm/11', selection);
      const created = await admin('/admin/order/create/' + quote.orderKey + '/11', { ...selection, quoteToken: quote.quoteToken });
      const order = await f.container.storeOrderDao.findByOrderId(created.result.order_id);
      if (!order) throw Error('Actual assisted express order absent');
      if (order.paid !== 0 || order.storeId !== 0 || order.pid !== 0 || order.supplierId !== 0 || order.shippingType !== 1)
        throw Error('Actual checkout did not produce the supported unpaid platform root');
      const total = amountToCents(order.payPrice); if (total === null || total <= 0) throw Error('Actual checkout amount absent');
      const transaction = 'assigned_tx_' + randomUUID().replaceAll('-', ''), nonce = Buffer.from(randomBytes(6)).toString('hex'), associated = 'transaction';
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(ASSIGNED_AES), Buffer.from(nonce)); cipher.setAAD(Buffer.from(associated));
      const plaintext = { appid: ASSIGNED_APP, mchid: ASSIGNED_MERCHANT, out_trade_no: order.orderId, transaction_id: transaction,
        trade_state: 'SUCCESS', trade_type: 'JSAPI', payer: { openid: ASSIGNED_PAYER }, success_time: new Date().toISOString(), amount: { total, currency: 'CNY' } };
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext)), cipher.final(), cipher.getAuthTag()]).toString('base64');
      const raw = JSON.stringify({ id: randomUUID(), event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource',
        resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', ciphertext, nonce, associated_data: associated } });
      const timestamp = String(Math.floor(Date.now() / 1000)), before = f.messages.length, pending: Promise<unknown>[] = [];
      const response = await h().request('/api/pay/notify/routine', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
        'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce, 'Wechatpay-Serial': ASSIGNED_PLATFORM,
        'Wechatpay-Signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), keys.privateKey)).toString('base64') } }, f.env,
      { waitUntil: (p: Promise<unknown>) => pending.push(p), props: {}, passThroughOnException: () => { throw Error('Unexpected Routine fallback'); } });
      await Promise.all(pending); if (response.status !== 200) throw Error('Real default callback refused: ' + await response.text());
      const message = f.messages.slice(before).find(isPaymentCallbackMessage); if (!message) throw Error('Actual callback Queue message absent');
      if (await new PaymentCallbackEventService(application(), f.env).processMessage(message) !== 'completed') throw Error('Actual paid callback consumer did not complete');
      const captured = await f.maintenanceDb.execute<{ row: unknown }>(sql`SELECT pg_catalog.to_jsonb(t) AS row FROM public.routine_original_payment_evidence t WHERE order_no=${order.orderId}`);
      if (captured.length !== 1) throw Error('Real default original evidence absent');
      const parsed = parseRoutineOriginalEvidence(f.env, captured[0].row);
      if (parsed.payload.observation.facts.payerId !== ASSIGNED_PAYER || parsed.payload.observation.facts.appId !== ASSIGNED_APP)
        throw Error('Default original did not retain verified A payer and AppID');
      const [event] = await f.maintenanceDb.select({ id: storeOrderOutbox.id, eventKey: storeOrderOutbox.eventKey }).from(storeOrderOutbox)
        .where(and(eq(storeOrderOutbox.aggregateId, order.id), eq(storeOrderOutbox.eventType, 'order.paid')));
      if (!event) throw Error('Real paid outbox absent'); await f.consume(event);
      const result = await actual(order.id);
      if (result.paid !== 1 || result.status !== 0 || result.storeId !== 0 || result.supplierId !== 0 || result.supplierAllocationStatus !== 2)
        throw Error('Actual App paid consumer did not complete a store-zero unsplit source');
      const carts = await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
      if (!carts.length || carts.some(c => c.type !== type || c.relationId !== (type === 1 ? 1 : 0) || c.cartNum !== quantity
        || c.surplusNum !== c.cartNum || c.splitSurplusNum !== c.cartNum)) throw Error('Actual checkout cart facts differ from the supported complete source');
      return result;
    };
    await configure();
    const identities = await Promise.all([f.appRuntime, f.adminRuntime, f.managerRuntime, f.financialRuntime, f.cashierRuntime].map(p => p.verify()));
    if (new Set(identities).size !== 5) throw Error('Actual five LOGIN backends are not independent');
    return { ...f, peers, city, application, http, admin, actual, adminActor, managerActor, author, decide, paid, configure };
  } catch (error) { await f.close(); throw error; }
}
function expectHttpSuccess(result: { response: Response; body: { status: number; msg: string } }) {
  if (result.response.status !== 200 || result.body.status !== 200) throw Error('Actual Admin HTTP route refused: ' + result.body.msg);
}
