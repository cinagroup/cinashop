import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import type { AppVariables, Env, OrderMessage } from '../src/env';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { refundApply, refundCancel, refundVerify } from '../src/controllers/api/v1/PayController';
import { AdminFullGiftService } from '../src/services/admin/AdminFullGiftService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { finalizeStoreOrderRefund, StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { enqueueOrderPaidEvent, OrderOutboxService } from '../src/services/order/OrderOutboxService';
import { adminAuthMiddleware } from '../src/middleware/admin-auth';
import { adminRefundCreationQuote } from '../src/controllers/api/v1/AdminRefundCreationQuoteController';
import { create as adminCreate, execute as adminExecute, receipt as adminReceipt }
  from '../src/controllers/api/v1/AdminRefundCreationController';
import { privateRefundOperationResponse } from '../src/controllers/api/v1/AdminRefundOperationController';
import { ApiException, HttpApiException } from '../src/utils/errors';
import { createToken, md5 } from '../src/utils/jwt';
import { ADMIN_REFUND_CREATION_SQL } from '../src/migrations/adminRefundCreation';
import { ADMIN_REFUND_OPERATION_SQL } from '../src/migrations/adminRefundOperation';
import { MATERIALIZED_REFUND_VERSION, readRefundQuantityReservation, reserveRefundQuantities }
  from '../src/services/order/RefundQuantityReservation';
import { runOrderPromotionGiftReceipt } from '../src/migrations/runOrderPromotionGiftReceipt';
import { REFUND_ORDER_SPLIT_SQL } from '../src/migrations/refundOrderSplit';
import { storeOrderRefundSplit, storeOrderFulfillmentBranch } from '../src/models/schema/order_refund_split';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { withFinancePeers } from './helpers/financePeers';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../src/services/payment/AlipayRefundService';
import { adminRefundCreation, adminRefundOperation, agentLevel, luckLottery, orderWaybillJob, printDocument, storeCart, storeCouponIssue,
  storeCouponIssueUser, storeCouponUser, storeOrder, storeOrderCartInfo, storeOrderEconomize,
  storeOrderInvoice, storeOrderOutbox, storeOrderProductCouponReward, storeProductCoupon,
  storeOrderPromotionGiftCouponReward, storeOrderRefund, storeOrderRefundPayment,
  storeOrderStatus, storeProduct, storeProductAttrValue, storeProductCategory,
  storePromotions, storePromotionsAuxiliary, supplierFlowingWater, supplierTransactions,
  systemAdmin, systemLog, systemMenus, systemRole, userBill, userBrokerage, userLabel, userLabelRelation } from '../src/models/schema';

const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const date = (hours: number) => new Date(Date.now() + (hours + 8) * 3_600_000)
  .toISOString().replace('T', ' ').slice(0, 19);
const selection = { cartIds: [1], addressId: 11, shippingType: 1, useIntegral: false };
type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
type Envelope = { status: number; msg: string; data: { refundId?: number } | null };

/** Actual public controllers and native SQL, with a finite test-owned UID
 * middleware. This does not certify JWT/Redis, deployed Hyperdrive or providers.
 * Orders, zero-price gifts and paid reward receipts come from actual services;
 * no HTTP body selects the v2 materialization protocol. */
describe.runIf(native)('full-gift public refund controllers through native PG16', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let rootId: number;
  let serial = 0;
  let expectedWechatRequests = 0;
  const tokens = new Map<number, string>();
  const bases = ['/adminapi/refund/creation', '/api/admin/refund/creation'];

  const api = (db: DbClient = f.db) => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    const container = createContainerFromDb(db);
    app.use('*', async (c, next) => {
      c.set('container', container);
      c.set('uid', ['11', '22'].includes(c.req.header('x-fixture-user') ?? '')
        ? Number(c.req.header('x-fixture-user')) : 0);
      await next();
    });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 400,
      msg: error.message, data: null }, error instanceof HttpApiException ? error.httpStatus : 200));
    app.post('/api/order/refund/apply/:id', refundApply);
    app.post('/api/order/refund/verify', refundVerify);
    app.post('/api/order/refund/cancel/:uni', refundCancel);
    for (const base of bases) {
      app.post(`${base}/quote`, privateRefundOperationResponse, adminAuthMiddleware(), adminRefundCreationQuote);
      app.post(`${base}/create`, privateRefundOperationResponse, adminAuthMiddleware(), adminCreate);
      app.post(`${base}/execute`, privateRefundOperationResponse, adminAuthMiddleware(), adminExecute);
      app.post(`${base}/receipt`, privateRefundOperationResponse, adminAuthMiddleware(), adminReceipt);
    }
    return app;
  };

  beforeEach(async () => {
    serial = 0;
    expectedWechatRequests = 0;
    f = await createPcCheckoutQuoteFixture([printDocument, storeOrderStatus, storeCouponIssue,
      storeCouponIssueUser, storeCouponUser, userLabel, userLabelRelation, storeProductCategory,
      systemLog, agentLevel, storeOrderInvoice, storeOrderOutbox, storeOrderRefund,
      storeOrderRefundPayment, orderWaybillJob, userBrokerage, supplierFlowingWater,
      supplierTransactions, storeOrderEconomize, storeOrderProductCouponReward, storeProductCoupon,
      luckLottery, systemAdmin, systemRole, systemMenus]);
    await f.exec(REFUND_ORDER_SPLIT_SQL);
    // financePostgres creates ORM columns only. These are the three fixed
    // MigrationService invoice indexes required by the captured-v2 fingerprint.
    await f.exec('CREATE INDEX soi_order ON store_order_invoice(order_id)');
    await f.exec('CREATE INDEX soi_uid_state_time ON store_order_invoice(uid,is_del,is_refund,add_time)');
    await f.exec('CREATE INDEX soi_issue_state_time ON store_order_invoice(is_pay,is_del,is_invoice,add_time)');
    await f.exec('CREATE UNIQUE INDEX full_gift_http_outbox_event ON store_order_outbox(event_key)');
    await f.exec('CREATE INDEX full_gift_http_status_oid ON store_order_status(oid)');
    await f.exec('CREATE INDEX full_gift_http_bill_category_type_link ON user_bill(category,type,link_id)');
    await runOrderPromotionGiftReceipt(f.db);
    await f.exec(ADMIN_REFUND_CREATION_SQL);
    await f.exec(ADMIN_REFUND_OPERATION_SQL);
    Object.assign(f.env, { APP_KEY: 'local-full-gift-refund-http-not-production',
      UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' });
    await f.db.insert(systemRole).values([
      { id: 1, type: 1, roleName: 'Native full gift refund manager', rules: 'refund.manage' },
      { id: 2, type: 1, roleName: 'Native full gift refund reader', rules: 'refund.view' },
    ]);
    await f.db.insert(systemAdmin).values([
      { id: 100, account: 'local-gift-manager', pwd: 'gift-refund-fixture', adminType: 1, level: 1, roles: '1' },
      { id: 101, account: 'local-gift-reader', pwd: 'gift-refund-fixture', adminType: 1, level: 1, roles: '2' },
    ]);
    for (const id of [100, 101]) tokens.set(id,
      (await createToken(id, 'admin', md5('gift-refund-fixture'), f.env.APP_KEY)).token);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeProduct).set({ deliveryType: '1', price: '10.00', freight: 1, tempId: 0 });
    await f.db.update(storeProductAttrValue).set({ price: '10.00', vipPrice: '9.00' });
    await f.db.update(storeCart).set({ cartNum: 2 });
    await f.db.insert(storeProduct).values({ id: 71, storeName: '退款实物赠品', stock: 20,
      image: '/gift.png', isShow: 1, isVerify: 1, deliveryType: '1' });
    await f.db.insert(storeProductAttrValue).values({ id: 71, productId: 71, type: 0,
      unique: 'gift80', suk: '礼盒', stock: 20 });
    await f.db.insert(userLabel).values({ id: 31, name: '满送成交客户', type: 0, relationId: 0 });
    await f.db.insert(storeCouponIssue).values({ id: 41, couponTitle: '满送优惠券', type: 1,
      couponPrice: '2.00', useMinPrice: '5.00', receiveType: 3, status: 1,
      remainCount: 20, totalCount: 20, day: 7 });
    rootId = (await new AdminFullGiftService(f.container).mutate('create', 0, {
      name: '整单满送退款样本', section_time: [date(-1), date(24)],
      promotions_cate: 2, threshold_type: 1, promotions: [{ threshold: 10, give_integral: 3,
        give_coupon_id: [{ give_coupon_id: 41, give_coupon_num: 10 }],
        give_product_id: [{ give_product_id: 71, unique: 'gift80', give_product_num: 10 }] }],
      is_label: 1, label_id: [31], product_partake_type: 2,
      product_id: [{ product_id: 70, unique: ['qared001'] }], brand_id: [], store_label_id: [],
      status: 1, sort: 0, request_id: crypto.randomUUID(),
    }, { id: 9 })).id;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden in refund fixture'));
    for (const gateway of [WechatPayService, AlipayRefundService]) {
      vi.spyOn(gateway.prototype, 'requestRefund').mockRejectedValue(Error('Provider request forbidden'));
      vi.spyOn(gateway.prototype, 'queryRefund').mockRejectedValue(Error('Provider query forbidden'));
    }
  }, 30_000);

  afterEach(async () => {
    try {
      expect(fetch).not.toHaveBeenCalled();
      for (const gateway of [WechatPayService, AlipayRefundService]) {
        expect(gateway.prototype.requestRefund).toHaveBeenCalledTimes(
          gateway === WechatPayService ? expectedWechatRequests : 0);
        expect(gateway.prototype.queryRefund).not.toHaveBeenCalled();
      }
    } finally { tokens.clear(); vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  const rows = (id: number) => f.db.select().from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, id)).orderBy(asc(storeOrderCartInfo.id));
  const applications = () => f.db.select().from(storeOrderRefund).orderBy(asc(storeOrderRefund.id));
  const finance = async () => ({ ...await f.snapshot(),
    coupons: await f.db.select().from(storeCouponUser).orderBy(asc(storeCouponUser.id)),
    issues: await f.db.select().from(storeCouponIssue).orderBy(asc(storeCouponIssue.id)),
    rewardReceipts: await f.db.select().from(storeOrderPromotionGiftCouponReward)
      .orderBy(asc(storeOrderPromotionGiftCouponReward.id)),
    pools: await f.db.select().from(storePromotionsAuxiliary).orderBy(asc(storePromotionsAuxiliary.id)),
    labels: await f.db.select().from(userLabelRelation).orderBy(asc(userLabelRelation.id)),
    payments: await f.db.select().from(storeOrderRefundPayment).orderBy(asc(storeOrderRefundPayment.id)),
    invoices: await f.db.select().from(storeOrderInvoice).orderBy(asc(storeOrderInvoice.id)),
    splits: await f.db.select().from(storeOrderRefundSplit).orderBy(asc(storeOrderRefundSplit.refundId)),
    branches: await f.db.select().from(storeOrderFulfillmentBranch).orderBy(asc(storeOrderFulfillmentBranch.id)),
    outbox: await f.db.select().from(storeOrderOutbox).orderBy(asc(storeOrderOutbox.id)),
  });
  const state = async () => ({ financial: await finance(), applications: await applications(),
    orderCarts: await f.db.select().from(storeOrderCartInfo).orderBy(asc(storeOrderCartInfo.id)),
    statuses: await f.db.select().from(storeOrderStatus).orderBy(asc(storeOrderStatus.id)),
    creations: await f.db.select().from(adminRefundCreation)
      .orderBy(asc(adminRefundCreation.adminId), asc(adminRefundCreation.requestKey)),
    operations: await f.db.select().from(adminRefundOperation)
      .orderBy(asc(adminRefundOperation.adminId), asc(adminRefundOperation.requestKey)),
  });
  const post = async (path: string, body: unknown, uid = 11, app = api()) => {
    const response = await app.request('/api/order/refund/' + path, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': String(uid),
    }, body: JSON.stringify(body) }, f.env);
    const result = await response.json() as Envelope;
    if (result.status === 503) expect(response.status).toBe(503);
    return result;
  };
  const applyBody = (carts: readonly Cart[]) => ({ applyType: 1, refundReason: '本地整单满送退款',
    refundExplain: '', cartIds: carts.map(cart => cart.id) });
  const verifyBody = (order: Order, carts: readonly Cart[]) => ({ uni: order.orderId,
    refund_type: 1, text: '本地整单满送退款', refund_reason_wap_explain: '',
    cart_ids: carts.map(cart => ({ cart_id: Number(cart.cartId), cart_num: cart.cartNum })) });
  const armLateReceiptFailure = () => f.exec(`
    CREATE FUNCTION fail_full_gift_http_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'local full gift receipt failure'; END $$;
    CREATE FUNCTION arm_full_gift_http_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.refund_type=6 AND OLD.refund_type<>6 THEN
        CREATE TRIGGER fail_full_gift_http_receipt BEFORE INSERT ON store_order_refund_split
          FOR EACH ROW EXECUTE FUNCTION fail_full_gift_http_receipt();
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER arm_full_gift_http_receipt AFTER UPDATE ON store_order
      FOR EACH ROW EXECUTE FUNCTION arm_full_gift_http_receipt()`);
  const removeLateReceiptFailure = () => f.exec(`
    DROP TRIGGER arm_full_gift_http_receipt ON store_order;
    DROP FUNCTION arm_full_gift_http_receipt(); DROP FUNCTION fail_full_gift_http_receipt()`);

  const adminPost = async (suffix: 'quote' | 'create' | 'execute' | 'receipt', body: unknown,
    options: { base?: string; id?: number; key?: string } = {}) => {
    const id = options.id ?? 100;
    const headers = new Headers({ 'Content-Type': 'application/json',
      'Authori-zation': `Bearer ${tokens.get(id) ?? ''}`, 'X-Refund-Operation-Scope': `v1:admin:${id}` });
    if (options.key) headers.set('Idempotency-Key', options.key);
    const response = await api().request(`${options.base ?? bases[0]}/${suffix}`,
      { method: 'POST', headers, body: JSON.stringify(body) }, f.env);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    const result = await response.json() as { status: number; msg: string; data: any };
    if (result.status === 503) expect(response.status).toBe(503);
    return result;
  };

  async function paid(gift = true, processEvent = true, payType: 'yue' | 'weixin' = 'yue') {
    if (!gift) await f.db.update(storePromotions).set({ status: 0 }).where(eq(storePromotions.id, rootId));
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11',
    }, body: JSON.stringify(selection) }, f.env);
    const confirmed = await response.json() as { status: number; msg: string;
      data: { orderKey: string; quoteToken: string } };
    expect(confirmed.status, confirmed.msg).toBe(200);
    const created = await StoreOrderCreateService.createWithRuntime(f.container, {
      CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true,
      nextOrderId: async () => `full_gift_http_${++serial}`,
    }, { ...selection, uid: 11, key: confirmed.data.orderKey,
      quoteToken: confirmed.data.quoteToken, userIp: '127.0.0.1' });
    const now = Math.floor(Date.now() / 1000);
    const event = await withTx(f.container, async tx => {
      const [current] = await tx.update(storeOrder).set({ paid: 1, payType, payTime: now,
        tradeNo: payType === 'weixin' ? 'local-gift-http-payment' : '' })
        .where(eq(storeOrder.orderId, created.orderId)).returning();
      return enqueueOrderPaidEvent(tx, current, now);
    });
    if (processEvent) {
      const queue = { sendBatch: async () => ({ successful: 1 }), send: async () => {} };
      const service = new OrderOutboxService(f.container,
        { ORDER_QUEUE: queue as unknown as Queue<OrderMessage> });
      const message = { action: 'processOrderPaidOutbox' as const,
        outboxId: event.id, eventKey: event.eventKey };
      expect(await service.processMessage(message)).toBe('completed');
      expect(await service.processMessage(message)).toBe('already-completed');
      expect((await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, event.id)))[0])
        .toMatchObject({ eventKey: event.eventKey, status: 'COMPLETED' });
    }
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(order.payPrice).toBe('20.00');
    if (gift) {
      expect(order.totalNum).toBe(4);
      expect(await rows(order.id)).toMatchObject([{ isGift: 0, cartNum: 2 }, { isGift: 1, cartNum: 2 }]);
      if (processEvent && order.giveCoupon) expect(await f.db.select().from(storeOrderPromotionGiftCouponReward)).toHaveLength(1);
    }
    return order;
  }

  it.each(['apply-number', 'apply-id', 'verify'] as const)
    ('creates the complete durable v2 claim through %s without moving money or paid rewards', async route => {
      const order = await paid(), carts = await rows(order.id), before = await finance();
      const result = route === 'verify' ? await post('verify', verifyBody(order, carts))
        : await post(`apply/${route === 'apply-id' ? order.id : order.orderId}`, applyBody(carts));
      expect(result.status, result.msg).toBe(200);
      const [refund] = await applications();
      expect(result.data).toEqual({ refundId: refund.id });
      expect(refund).toMatchObject({ uid: 11, storeOrderId: order.id, applyType: 1,
        refundType: 0, refundNum: 4, refundPrice: '20.00', refundedPrice: '0.00' });
      const claim = readRefundQuantityReservation(refund);
      expect(claim).toMatchObject({ version: MATERIALIZED_REFUND_VERSION, orderId: order.id, uid: 11 });
      expect(claim?.items).toEqual(carts.map(cart => ({ rowId: cart.id, cartId: Number(cart.cartId),
        cartNum: cart.cartNum, beforeRefundNum: 0, totalNum: cart.cartNum })).sort((a, b) => a.cartId - b.cartId));
      expect((await rows(order.id)).every(cart => cart.refundNum === cart.cartNum)).toBe(true);
      expect(await finance()).toEqual(before);
    });

  it('uses middleware ownership for both aliases and never trusts body-provided user or privileged application type', async () => {
    const order = await paid(), carts = await rows(order.id), before = await state();
    for (const uid of [0, 22]) {
      expect((await post(`apply/${order.id}`, { ...applyBody(carts), uid: 11 }, uid)).status).not.toBe(200);
      expect((await post(`apply/${order.orderId}`, { ...applyBody(carts), uid: 11 }, uid)).status).not.toBe(200);
      expect((await post('verify', { ...verifyBody(order, carts), uid: 11 }, uid)).status).not.toBe(200);
    }
    expect((await post(`apply/${order.orderId}`, { ...applyBody(carts), applyType: 4,
      privilegedActor: 'admin', materializeOrders: true })).status).not.toBe(200);
    expect((await post(`apply/${order.orderId}`, { ...applyBody(carts), applyType: 2 })).status).not.toBe(200);
    expect((await post('verify', { ...verifyBody(order, carts), refund_type: 2 })).status).not.toBe(200);
    expect(await state()).toEqual(before);
  });

  it.each(['purchased-only', 'gift-only', 'partial-quantity', 'duplicate', 'foreign-line'] as const)
    ('rejects %s without an application, quantity hold or financial effect', async kind => {
      const order = await paid(), carts = await rows(order.id), before = await state();
      const purchased = carts.find(cart => cart.isGift === 0)!, gift = carts.find(cart => cart.isGift === 1)!;
      const body = verifyBody(order, carts);
      if (kind === 'purchased-only') body.cart_ids = [{ cart_id: Number(purchased.cartId), cart_num: purchased.cartNum }];
      if (kind === 'gift-only') body.cart_ids = [{ cart_id: Number(gift.cartId), cart_num: gift.cartNum }];
      if (kind === 'partial-quantity') body.cart_ids[0].cart_num = 1;
      if (kind === 'duplicate') body.cart_ids.push({ ...body.cart_ids[0] });
      if (kind === 'foreign-line') body.cart_ids[0].cart_id = 123456789;
      expect((await post('verify', body)).status).not.toBe(200);
      expect(await state()).toEqual(before);
    });

  it.each(['split', 'delivered'] as const)('refuses the %s order before any refund write', async kind => {
    const order = await paid(), carts = await rows(order.id);
    await f.db.update(storeOrder).set(kind === 'split' ? { pid: 9 } : { status: 1 })
      .where(eq(storeOrder.id, order.id));
    const before = await state();
    expect((await post(`apply/${order.orderId}`, applyBody(carts))).status).not.toBe(200);
    expect((await post('verify', verifyBody(order, carts))).status).not.toBe(200);
    expect(await state()).toEqual(before);
  });

  it.each(['coupon-receipt', 'point-grant'] as const)
    ('refuses incomplete paid %s evidence instead of assuming an already completed reward', async kind => {
      const order = await paid(), carts = await rows(order.id);
      if (kind === 'coupon-receipt') await f.db.delete(storeOrderPromotionGiftCouponReward);
      else await f.db.delete(userBill).where(eq(userBill.eventKey, 'order_promotions_give_integral'));
      const before = await state();
      expect((await post(`apply/${order.orderId}`, applyBody(carts))).status).not.toBe(200);
      expect(await state()).toEqual(before);
    });

  it.each(['pending', 'aggregate', 'payload'] as const)
    ('refuses a %s paid outbox even when individual coupon and point receipts exist', async kind => {
      const order = await paid(), carts = await rows(order.id);
      await f.db.update(storeOrderOutbox).set(kind === 'pending' ? { status: 'PENDING' }
        : kind === 'aggregate' ? { aggregateId: order.id + 1000 }
          : { payload: { orderId: order.id, orderNo: 'different_order' } })
        .where(eq(storeOrderOutbox.eventKey, `order.paid:${order.id}`));
      const before = await state();
      expect((await post(`apply/${order.orderId}`, applyBody(carts))).status).not.toBe(200);
      expect((await post('verify', verifyBody(order, carts))).status).not.toBe(200);
      expect(await state()).toEqual(before);
    });

  it('waits for the real paid outbox even on a physical-gift-only campaign, then admits the unchanged whole claim', async () => {
    const service = new AdminFullGiftService(f.container), { info } = await service.detail(rootId);
    await service.mutate('update', rootId, {
      name: info.name, section_time: info.section_time, promotions_cate: info.promotions_cate,
      threshold_type: info.threshold_type,
      promotions: info.promotions.map(rule => ({ id: rule.id, threshold: rule.threshold,
        give_integral: 0, give_coupon_id: [], give_product_id: rule.give_product_id })),
      is_label: info.is_label, label_id: info.label_id, product_partake_type: info.product_partake_type,
      product_id: info.product_id, brand_id: info.brand_id, store_label_id: info.store_label_id,
      status: info.status, sort: info.sort, revision: info.revision, request_id: crypto.randomUUID(),
    }, { id: 9 });
    const order = await paid(true, false), carts = await rows(order.id), before = await state();
    expect(order.giveIntegral).toBe(0); expect(order.giveCoupon).toBeNull();
    const rejected = await post(`apply/${order.orderId}`, applyBody(carts));
    expect(rejected.status).not.toBe(200); expect(rejected.msg).toContain('付款后置任务');
    expect(await state()).toEqual(before);
    const [event] = await f.db.select().from(storeOrderOutbox)
      .where(eq(storeOrderOutbox.eventKey, `order.paid:${order.id}`));
    const queue = { sendBatch: async () => ({ successful: 1 }), send: async () => {} };
    expect(await new OrderOutboxService(f.container, { ORDER_QUEUE: queue as unknown as Queue<OrderMessage> })
      .processMessage({ action: 'processOrderPaidOutbox', outboxId: event.id, eventKey: event.eventKey }))
      .toBe('completed');
    expect((await post(`apply/${order.orderId}`, applyBody(carts))).status).toBe(200);
  });

  it('rejects an active duplicate, then releases every v2 hold on owner cancellation without returning paid pools', async () => {
    const order = await paid(), carts = await rows(order.id), financial = await finance();
    const created = await post(`apply/${order.orderId}`, applyBody(carts));
    expect(created.status, created.msg).toBe(200);
    const id = created.data!.refundId!, held = await state();
    expect((await post('verify', verifyBody(order, carts))).status).not.toBe(200);
    expect((await post(`cancel/${id}`, {}, 22)).status).not.toBe(200);
    expect(await state()).toEqual(held);
    expect((await post(`cancel/${id}`, {})).status).toBe(200);
    expect((await rows(order.id)).every(cart => cart.refundNum === 0)).toBe(true);
    expect((await applications())[0].isCancel).toBe(1);
    expect(await finance()).toEqual(financial);
    const cancelled = await state();
    expect((await post(`cancel/${id}`, {})).status).not.toBe(200);
    expect(await state()).toEqual(cancelled);
    const reapplied = await post('verify', verifyBody(order, carts));
    expect(reapplied.status, reapplied.msg).toBe(200);
    expect(reapplied.data!.refundId).not.toBe(id);
    expect(await applications()).toHaveLength(2);
  });

  it('keeps a persisted legacy v1 full-gift claim refused by the financial finalizer', async () => {
    const order = await paid(), carts = await rows(order.id);
    const legacy = await withTx(f.container, async tx => {
      const cartInfo = await reserveRefundQuantities(tx, order,
        carts.map(cart => ({ cartId: Number(cart.cartId), cartNum: cart.cartNum })));
      const [refund] = await tx.insert(storeOrderRefund).values({ uid: 11, storeOrderId: order.id,
        orderId: 'legacy_full_gift_http', applyType: 1, refundNum: 4, refundPrice: '20.00',
        refundReason: '本地旧协议数据', cartInfo }).returning();
      return refund;
    });
    expect(readRefundQuantityReservation(legacy)?.version).toBe('refund-quantity-reservation-v1');
    const before = await state();
    await expect(finalizeStoreOrderRefund(f.container, legacy.id)).rejects.toThrow(/满送/);
    expect(await state()).toEqual(before);
  });

  it('preserves ordinary public refund v1 when checkout has no full-gift snapshot', async () => {
    const order = await paid(false), carts = await rows(order.id), before = await finance();
    expect(carts).toHaveLength(1);
    const result = await post(`apply/${order.orderId}`, { ...applyBody(carts), materializeOrders: true,
      quantityReservation: { version: MATERIALIZED_REFUND_VERSION } });
    expect(result.status, result.msg).toBe(200);
    expect(readRefundQuantityReservation((await applications())[0])?.version).toBe('refund-quantity-reservation-v1');
    expect(await finance()).toEqual(before);
  });

  it('settles a public-created whole claim once, restoring bought and gift stock while retaining paid coupon pools and labels', async () => {
    const order = await paid(), carts = await rows(order.id), before = await finance();
    const created = await post(`apply/${order.orderId}`, applyBody(carts));
    expect(created.status, created.msg).toBe(200);
    const id = created.data!.refundId!;
    expect(await finalizeStoreOrderRefund(f.container, id)).toBe('completed');
    const after = await finance();
    expect(after.users.find(row => row.uid === 11)).toMatchObject({ nowMoney: '20.00', integral: 100 });
    expect(after.products.find(row => row.id === 70)?.stock).toBe(8);
    expect(after.products.find(row => row.id === 71)?.stock).toBe(20);
    expect(after.skus.find(row => row.id === 1)?.stock).toBe(8);
    expect(after.skus.find(row => row.id === 71)?.stock).toBe(20);
    expect(after.orders.find(row => row.id === order.id)).toMatchObject({ pid: 0, refundStatus: 2, refundPrice: '20.00' });
    expect(after.bills.filter(row => row.type === 'pay_product_refund')).toHaveLength(1);
    expect(after.bills.filter(row => row.eventKey === 'order_promotions_integral_refund'))
      .toMatchObject([{ linkId: String(order.id), number: '6.00', pm: 0 }]);
    expect(after.coupons).toEqual(before.coupons);
    expect(after.rewardReceipts).toEqual(before.rewardReceipts);
    expect(after.issues).toEqual(before.issues);
    expect(after.pools).toEqual(before.pools);
    expect(after.labels).toEqual(before.labels);
    expect(after.splits).toMatchObject([{ refundId: id, disposition: 'whole',
      sourceOrderId: order.id, selectedOrderId: order.id, remainingOrderId: null }]);
    const completed = await state();
    expect(await finalizeStoreOrderRefund(f.container, id)).toBe('already-completed');
    expect((await post('verify', verifyBody(order, carts))).status).not.toBe(200);
    expect(await state()).toEqual(completed);
  });

  it('rolls back money, stock and recovered points when the late immutable materialization receipt cannot commit', async () => {
    const order = await paid(), carts = await rows(order.id);
    const created = await post(`apply/${order.orderId}`, applyBody(carts));
    expect(created.status, created.msg).toBe(200);
    const id = created.data!.refundId!, before = await state();
    // Add the failing receipt trigger only after the exact catalog check and
    // order transition. Its creation rolls back with the failed settlement.
    await armLateReceiptFailure();
    await expect(finalizeStoreOrderRefund(f.container, id)).rejects.toThrow();
    expect(await state()).toEqual(before);
    await removeLateReceiptFailure();
    expect(await finalizeStoreOrderRefund(f.container, id)).toBe('completed');
    expect((await finance()).users.find(row => row.uid === 11)?.nowMoney).toBe('20.00');
  });

  it.each([
    { fault: 'disabled immutable receipt trigger',
      ddl: 'ALTER TABLE store_order_refund_split DISABLE TRIGGER sors_no_rewrite' },
    { fault: 'missing canonical invoice index', ddl: 'DROP INDEX soi_order' },
    { fault: 'PUBLIC receipt permission', ddl: 'GRANT SELECT ON store_order_refund_split TO PUBLIC' },
  ])('refuses quote and new claims with a $fault before writing business state', async ({ ddl }) => {
    const order = await paid(), carts = await rows(order.id);
    const request = { version: 'admin-refund-creation-quote-v1', orderId: order.id, mode: 'remaining', items: [] };
    const quoted = await adminPost('quote', request);
    expect(quoted.status, quoted.msg).toBe(200);
    const body = { version: 'admin-refund-creation-v1', review: quoted.data.review,
      mode: 'remaining', items: [], quotedPrice: quoted.data.quotedPrice,
      refundPrice: '20.00', reason: '运行合同故障不得创建', quoteFingerprint: quoted.data.quoteFingerprint };
    const before = await state();
    await f.exec(ddl);
    for (const base of bases) for (const suffix of ['quote', 'create'] as const) {
      const rejected = await adminPost(suffix, suffix === 'quote' ? request : body,
        { base, ...(suffix === 'create' ? { key: crypto.randomUUID() } : {}) });
      expect(rejected).toMatchObject({ status: 503, data: null });
      expect(rejected.msg).toContain('满送退款运行合同');
      expect(await state()).toEqual(before);
    }
    for (const [path, payload] of [[`apply/${order.orderId}`, applyBody(carts)],
      ['verify', verifyBody(order, carts)]] as const) {
      const rejected = await post(path, payload);
      expect(rejected).toMatchObject({ status: 503, data: null });
      expect(rejected.msg).toContain('满送退款运行合同');
      expect(await state()).toEqual(before);
    }
  });

  it('refuses an admin whole-order refund one cent below a valid full-gift quote without writing a claim', async () => {
    const order = await paid(), before = await state();
    const quoted = await adminPost('quote', { version: 'admin-refund-creation-quote-v1',
      orderId: order.id, mode: 'remaining', items: [] });
    expect(quoted.status, quoted.msg).toBe(200);
    expect(quoted.data.quotedPrice).toBe('20.00');
    const body = { version: 'admin-refund-creation-v1', review: quoted.data.review,
      mode: 'remaining', items: [], quotedPrice: quoted.data.quotedPrice,
      refundPrice: '19.99', reason: '满送整单不得少退', quoteFingerprint: quoted.data.quoteFingerprint };
    for (const base of bases) for (const suffix of ['create', 'execute'] as const) {
      const rejected = await adminPost(suffix, body, { base, key: crypto.randomUUID() });
      expect(rejected.status).toBe(400);
      expect(rejected.msg).toContain('满送订单的部分退款');
      expect(await state()).toEqual(before);
    }
  });

  it('refuses both public full-gift refund aliases for a paid offline order without writing state', async () => {
    const order = await paid(), carts = await rows(order.id);
    await f.db.update(storeOrder).set({ payType: 'offline' }).where(eq(storeOrder.id, order.id));
    const before = await state();
    for (const [path, body] of [[`apply/${order.orderId}`, applyBody(carts)],
      ['verify', verifyBody(order, carts)]] as const) {
      const rejected = await post(path, body);
      expect(rejected.status).toBe(400);
      expect(rejected.msg).toContain('支付方式暂不支持');
      expect(await state()).toEqual(before);
    }
  });

  it.each(bases)('quotes, creates and executes the whole claim via %s with owner-scoped immutable replay', async base => {
    const order = await paid(), before = await state(), key = crypto.randomUUID();
    const quoted = await adminPost('quote', { version: 'admin-refund-creation-quote-v1',
      orderId: order.id, mode: 'remaining', items: [] }, { base });
    expect(quoted.status, quoted.msg).toBe(200);
    expect(quoted.data).toMatchObject({ refundNum: 4, quotedPrice: '20.00',
      review: { id: order.id, uid: 11, totalNum: 4 } });
    expect(await state()).toEqual(before);
    const body = { version: 'admin-refund-creation-v1', review: quoted.data.review,
      mode: 'remaining', items: [], quotedPrice: quoted.data.quotedPrice,
      refundPrice: '20.00', reason: '本地管理员整单退款', quoteFingerprint: quoted.data.quoteFingerprint };
    const created = await adminPost('create', body, { base, key });
    expect(created.status, created.msg).toBe(200);
    expect(created.data).toMatchObject({ replayed: false, receipt: { adminId: 100, outcome: 'created' } });
    const id = created.data.receipt.refundId;
    expect(readRefundQuantityReservation((await applications())[0])?.version).toBe(MATERIALIZED_REFUND_VERSION);
    expect(await finance()).toEqual(before.financial);
    const other = bases.find(path => path !== base)!;
    const result = await adminPost('execute', body, { base: other, key });
    expect(result.status, result.msg).toBe(200);
    expect(result.data).toMatchObject({ creation: { replayed: true, receipt: created.data.receipt },
      operation: { execution: { completed: true, status: 'BALANCE_SUCCESS' },
        receipt: { adminId: 100, refundId: id, outcome: 'balance-settled' } } });
    const settled = await state();
    expect(settled.financial.users.find(row => row.uid === 11)?.nowMoney).toBe('20.00');
    expect(settled.creations).toHaveLength(1); expect(settled.operations).toHaveLength(1);
    expect((await adminPost('receipt', { version: body.version }, { base, key })).data.receipt)
      .toEqual(created.data.receipt);
    expect((await adminPost('create', body, { base: other, key })).data.replayed).toBe(true);
    expect((await adminPost('execute', body, { base, key })).data.operation.replayed).toBe(true);
    expect((await adminPost('create', { ...body, refundPrice: '19.00' }, { base, key })).status).not.toBe(200);
    expect(await state()).toEqual(settled);
  });

  it('denies refund.view for quote, creation, execution and receipt before writing the full-gift order', async () => {
    const order = await paid(), before = await state();
    const request = { version: 'admin-refund-creation-quote-v1', orderId: order.id, mode: 'remaining', items: [] };
    const quote = await adminPost('quote', request);
    expect(quote.status, quote.msg).toBe(200);
    const body = { version: 'admin-refund-creation-v1', review: quote.data.review,
      mode: 'remaining', items: [], quotedPrice: quote.data.quotedPrice, refundPrice: '20.00',
      reason: '只读用户禁止提交', quoteFingerprint: quote.data.quoteFingerprint };
    for (const base of bases) for (const suffix of ['quote', 'create', 'execute', 'receipt'] as const) {
      const result = await adminPost(suffix, suffix === 'quote' ? request
        : suffix === 'receipt' ? { version: body.version } : body,
      { base, id: 101, ...(suffix === 'quote' ? {} : { key: crypto.randomUUID() }) });
      expect(result.status).toBe(400011);
    }
    expect(await state()).toEqual(before);
  });

  it('retains known provider SUCCESS through a failed late receipt and recovers without a second request or query', async () => {
    const order = await paid(true, true, 'weixin');
    const carts = await rows(order.id), created = await post(`apply/${order.orderId}`, applyBody(carts));
    expect(created.status, created.msg).toBe(200);
    const id = created.data!.refundId!, before = await state();
    expectedWechatRequests = 1;
    vi.mocked(WechatPayService.prototype.requestRefund).mockResolvedValue({ status: 'SUCCESS',
      providerRefundId: 'local-gift-http-refund' });
    await armLateReceiptFailure();
    const service = new StoreOrderRefundService(f.container, f.env);
    await expect(service.agreeRefund(id)).rejects.toThrow();
    const afterFailure = await state();
    const { payments: _beforePayments, ...beforeFinance } = before.financial;
    const { payments: _afterPayments, ...afterFinance } = afterFailure.financial;
    expect(afterFinance).toEqual(beforeFinance);
    expect(afterFailure.applications).toEqual(before.applications);
    expect(afterFailure.orderCarts).toEqual(before.orderCarts);
    expect(afterFailure.financial.payments).toMatchObject([{ refundId: id,
      providerStatus: 'SUCCESS', requestAmount: 2000, totalAmount: 2000, attemptCount: 1 }]);
    expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(1);
    await removeLateReceiptFailure();
    expect(await service.reconcilePendingRefunds()).toMatchObject({ checked: 1, completed: 1, errors: 0 });
    const completed = await state();
    expect(completed.financial.users.find(row => row.uid === 11)?.nowMoney).toBe('0.00');
    expect(completed.financial.users.find(row => row.uid === 11)?.integral).toBe(100);
    expect(completed.financial.products.find(row => row.id === 70)?.stock).toBe(8);
    expect(completed.financial.products.find(row => row.id === 71)?.stock).toBe(20);
    expect(completed.financial.skus.find(row => row.id === 1)?.stock).toBe(8);
    expect(completed.financial.skus.find(row => row.id === 71)?.stock).toBe(20);
    expect(completed.financial.splits).toHaveLength(1);
    expect(completed.financial.bills.filter(row => row.eventKey === 'order_promotions_integral_refund')).toHaveLength(1);
    expect(completed.financial.pools).toEqual(before.financial.pools);
    expect(completed.financial.coupons).toEqual(before.financial.coupons);
    expect(completed.financial.rewardReceipts).toEqual(before.financial.rewardReceipts);
    expect(completed.financial.issues).toEqual(before.financial.issues);
    expect(completed.financial.labels).toEqual(before.financial.labels);
    const payment = completed.financial.payments[0];
    expect(payment.notifyTime).toBe(0); expect(payment.updateTime).toBeGreaterThan(0);
    // Keep provider success/update timestamps stable so notification recording
    // is the only permitted change across terminal callbacks and local replay.
    vi.spyOn(Date, 'now').mockReturnValue(payment.updateTime * 1000);
    const notice = { outTradeNo: order.orderId, transactionId: order.tradeNo,
      outRefundNo: `CNSR${id}`, providerRefundId: 'local-gift-http-refund', status: 'SUCCESS' as const,
      refundAmount: 2000, totalAmount: 2000, successTime: payment.successTime };
    await service.handleWechatRefundNotification(notice); await service.handleWechatRefundNotification(notice);
    expect(await service.agreeRefund(id)).toMatchObject({ completed: true, status: 'SUCCESS' });
    expect(await state()).toEqual({ ...completed, financial: { ...completed.financial,
      payments: completed.financial.payments.map(row => ({ ...row,
        notifyTime: row.id === payment.id ? payment.updateTime : row.notifyTime })) } });
    expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      outTradeNo: order.orderId, transactionId: order.tradeNo, outRefundNo: `CNSR${id}`,
      refundAmount: 2000, totalAmount: 2000 }));
    expect(WechatPayService.prototype.queryRefund).not.toHaveBeenCalled();
  });

  it('serializes independently connected public aliases into one active application and one whole quantity hold', async () => {
    const order = await paid(), carts = await rows(order.id), before = await finance();
    await withFinancePeers(f.db, async ([first, second]) => {
      expect(first.pid).not.toBe(second.pid);
      const results = await Promise.all([
        post(`apply/${order.orderId}`, applyBody(carts), 11, api(first.db)),
        post('verify', verifyBody(order, carts), 11, api(second.db)),
      ]);
      expect(results.filter(result => result.status === 200)).toHaveLength(1);
      expect(results.find(result => result.status !== 200)?.msg).toContain('进行中');
    });
    expect(await applications()).toHaveLength(1);
    expect((await rows(order.id)).every(cart => cart.refundNum === cart.cartNum)).toBe(true);
    expect(await finance()).toEqual(before);
  });
});
