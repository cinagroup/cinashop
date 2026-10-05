import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env, OrderMessage } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { refundApply } from '../src/controllers/api/v1/PayController';
import { runRuntimeBusinessCommissioning, type RuntimeCommissionTarget } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { AdminFullGiftService } from '../src/services/admin/AdminFullGiftService';
import { quoteAdminRefundCreation } from '../src/services/admin/AdminRefundCreationQuoteService';
import { createAdminRefundApplication, executeAdminProactiveRefund } from '../src/services/admin/AdminRefundCreationService';
import { executeAdminRefundOperation } from '../src/services/admin/AdminRefundOperationService';
import { AdminRefundReadService } from '../src/services/admin/AdminRefundReadService';
import type { AdminRefundDecisionActor } from '../src/services/admin/AdminRefundDecisionService';
import { CustomerRefundReadService } from '../src/services/order/CustomerRefundReadService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { applyStoreOrderBalancePayment } from '../src/services/order/StoreOrderPayService';
import { OrderOutboxService } from '../src/services/order/OrderOutboxService';
import { applyOrderRefundFromPublicEntry, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { MATERIALIZED_REFUND_VERSION, readRefundQuantityReservation } from '../src/services/order/RefundQuantityReservation';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderRefund, storeOrderRefundSplit,
  storeProduct, storeProductAttrValue, systemAdmin, systemRole, user, userBill } from '../src/models/schema';
import { md5 } from '../src/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import type { SequenceRunnerPeer } from './helpers/checkoutPricingMigrationDatabase';

type Peer = SequenceRunnerPeer & { role: string };
type Order = typeof storeOrder.$inferSelect;
type Refund = typeof storeOrderRefund.$inferSelect;
const native = describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL));
const actor = (id = 1): AdminRefundDecisionActor => ({ id, authVersion: md5('local-gift-refund-hash'),
  expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const shanghai = (hours: number) => {
  const date = new Date(Date.now() + (hours + 8) * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};

/** Complete registered schema, separately authenticated app/Admin LOGINs and
 * real SQL-only payment/outbox work. Trusted HTTP identity, KV and Queue are
 * synthetic; this is not JWT, provider, Hyperdrive or release acceptance. */
native('public whole full-gift refund through commissioned independent LOGINs', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await f.db.insert(systemRole).values({ id: 1, type: 1, roleName: 'Local refund reader', rules: 'refund.view' });
    await f.db.insert(systemAdmin).values([
      { id: 1, account: 'local-gift-refund', pwd: 'local-gift-refund-hash', adminType: 1, level: 0 },
      { id: 2, account: 'local-gift-reader', pwd: 'local-gift-refund-hash', adminType: 1, level: 1, roles: '1' },
    ]);
    await f.db.update(user).set({ nowMoney: '100.00', integral: 100 }).where(eq(user.uid, 11));
    // One ordinary platform line avoids supplier-child and invoice branches;
    // those remain separately gated, rather than invented by this ACL proof.
    await f.db.update(storeProduct).set({ type: 0, relationId: 0, freight: 1, tempId: 0,
      price: '10.00', giveIntegral: '0.00', isSub: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ price: '10.00', vipPrice: '10.00',
      settlePrice: '0.00', cost: '0.00', brokerage: '0.00' }).where(eq(storeProductAttrValue.id, 1));
  }, 60_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  async function profiles(run: (app: Peer, admin: Peer, target: RuntimeCommissionTarget) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [row] = await f.exec('SELECT current_database() AS database');
      const target = { app: app.role, admin: admin.role, maintenance: 'finance_test',
        database: String(row.database), pricingOwner: f.pricingOwner };
      expect(await runRuntimeBusinessCommissioning(f.db, target)).toMatchObject({ grantsApplied: true });
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        expect(await auditRuntimeBusinessPrivileges(peer.db, kind, target)).toMatchObject({ ready: true, failures: [] });
        const [identity] = await peer.exec(`SELECT current_user,session_user,pg_backend_pid() AS pid,
          NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls) AS restricted
          FROM pg_roles WHERE rolname=current_user`);
        expect(identity).toMatchObject({ current_user: peer.role, session_user: peer.role, restricted: true });
      }
      const [appIdentity] = await app.exec('SELECT pg_backend_pid() AS pid');
      const [adminIdentity] = await admin.exec('SELECT pg_backend_pid() AS pid');
      expect(appIdentity.pid).not.toBe(adminIdentity.pid);
      await run(app, admin, target);
    }));
  }

  const catalog = () => f.exec(`SELECT 'relation' AS kind,oid::text AS key,relowner::text AS owner,relacl::text AS acl
    FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,proowner::text,prosrc||coalesce(proacl::text,'')
      FROM pg_proc WHERE pronamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',oid::text,NULL,tgfoid::text||encode(tgargs,'hex')||tgenabled::text
      FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    ORDER BY kind,key`);
  async function state() {
    const extra: Record<string, unknown> = {};
    for (const table of ['admin_refund_creation', 'admin_refund_operation', 'store_order_promotion_gift_coupon_reward',
      'store_promotions', 'store_promotions_auxiliary', 'store_coupon_user', 'store_order_product_coupon_reward',
      'user_label_relation', 'store_order_economize']) {
      extra[table] = await f.exec(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`);
    }
    return { business: await f.state(), extra };
  }

  async function createAndPay(app: Peer, admin: Peer, complete = true) {
    await new AdminFullGiftService(createContainerFromDb(admin.db)).mutate('create', 0, {
      name: 'Local whole-refund point gift', section_time: [shanghai(-1), shanghai(24)],
      promotions_cate: 1, threshold_type: 1,
      promotions: [{ threshold: 1, give_integral: 6, give_coupon_id: [], give_product_id: [] }],
      is_label: 0, label_id: [], product_partake_type: 2,
      product_id: [{ product_id: 70, unique: ['qared001'] }], brand_id: [], store_label_id: [],
      status: 1, sort: 0, request_id: crypto.randomUUID(),
    }, { id: 1 });
    const container = createContainerFromDb(app.db);
    const created = await StoreOrderCreateService.createWithRuntime(container, {
      CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'runtime_full_gift_refund',
    }, { uid: 11, key: 'runtime-full-gift-refund', cartIds: [1], addressId: 11,
      userIp: '127.0.0.1', useIntegral: false });
    const [order] = await app.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(order).toMatchObject({ type: 0, pid: 0, status: 0, paid: 0, payPrice: '20.00', totalNum: 2, giveIntegral: 6 });
    const paid = await applyStoreOrderBalancePayment(container, { uid: 11, orderId: order.orderId });
    expect(paid.outcome).toBe('paid');
    if (!paid.outbox) throw Error('Real balance payment did not create its outbox');
    const queue = { send: async () => {}, sendBatch: async () => ({ successful: 1 }) };
    const outbox = new OrderOutboxService(container, { ORDER_QUEUE: queue as unknown as Queue<OrderMessage> });
    const message = { action: 'processOrderPaidOutbox' as const,
      outboxId: paid.outbox.id, eventKey: paid.outbox.eventKey };
    const completePayment = async () => {
      expect(await outbox.processMessage(message)).toBe('completed');
      expect(await outbox.processMessage(message)).toBe('already-completed');
      const [event] = await app.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, paid.outbox!.id));
      expect(event).toMatchObject({ status: 'COMPLETED', eventKey: `order.paid:${order.id}`,
        aggregateType: 'order', aggregateId: order.id, payload: { orderId: order.id, orderNo: order.orderId } });
      expect((await app.db.select().from(user).where(eq(user.uid, 11)))[0])
        .toMatchObject({ nowMoney: '80.00', integral: 106, payCount: 1 });
    };
    if (complete) await completePayment();
    return { order, completePayment };
  }

  function publicHttp(app: Peer) {
    const http = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    http.use('*', async (c, next) => {
      c.set('container', createContainerFromDb(app.db)); c.set('uid', 11); await next();
    });
    http.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    http.post('/refund/apply/:id', refundApply);
    return async (order: Order) => (await http.request(`/refund/apply/${order.orderId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ applyType: 1, refundReason: 'Local full-gift refund', refundExplain: '' }),
    }, f.env)).json<{ status: number; msg: string; data: { refundId: number } | null }>();
  }
  async function quote(admin: Peer, order: Order, who = actor()) {
    return quoteAdminRefundCreation(createContainerFromDb(admin.db), who, {
      version: 'admin-refund-creation-quote-v1', orderId: order.id, mode: 'remaining', items: [],
    });
  }
  const body = (q: Awaited<ReturnType<typeof quote>>) => ({ version: 'admin-refund-creation-v1',
    review: q.review, mode: q.mode, items: [], quotedPrice: q.quotedPrice, refundPrice: q.quotedPrice,
    reason: 'Local whole full-gift refund', quoteFingerprint: q.quoteFingerprint });
  async function readAndAssert(app: Peer, admin: Peer, refundId: number, order: Order) {
    const [refund] = await app.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
    expect(refund).toMatchObject({ storeOrderId: order.id, uid: 11, refundType: 6,
      refundNum: 2, refundPrice: '20.00', refundedPrice: '20.00' });
    expect(readRefundQuantityReservation(refund)?.version).toBe(MATERIALIZED_REFUND_VERSION);
    const [receipt] = await app.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, refundId));
    expect(receipt).toMatchObject({ disposition: 'whole', sourceOrderId: order.id,
      selectedOrderId: order.id, remainingOrderId: null });
    const customer = await new CustomerRefundReadService(createContainerFromDb(app.db))
      .detail(11, String(refundId), new URLSearchParams('view=customer'));
    const staff = await new AdminRefundReadService(createContainerFromDb(admin.db), f.env).detail(refundId);
    expect(customer).toMatchObject({ physicalOrderId: order.id, itemsError: '',
      items: [{ quantity: 2, name: '完整报价隔离样本' }] });
    expect(staff.refundHistory).toMatchObject({ physicalOrderId: order.id, itemsError: '',
      items: [{ quantity: 2, name: '完整报价隔离样本' }] });
    expect(await app.db.select().from(storeOrder)).toHaveLength(1);
    expect((await app.db.select().from(storeOrderCartInfo)).map(row => row.oid)).toEqual([order.id]);
    expect((await app.db.select().from(user).where(eq(user.uid, 11)))[0])
      .toMatchObject({ nowMoney: '100.00', integral: 100 });
    expect((await app.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].stock).toBe(8);
    expect((await app.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0].stock).toBe(8);
    const bills = await app.db.select().from(userBill).where(eq(userBill.uid, 11));
    expect(bills.filter(row => row.eventKey === 'order_promotions_give_integral')).toHaveLength(1);
    expect(bills.filter(row => row.eventKey === 'order_promotions_integral_refund'))
      .toMatchObject([{ pm: 0, number: '6.00', linkId: String(order.id) }]);
    return refund;
  }
  const review = (refund: Refund) => ({ uid: refund.uid, storeId: refund.storeId, supplierId: refund.supplierId,
    storeOrderId: refund.storeOrderId, orderId: refund.orderId, refundPrice: refund.refundPrice });

  it('creates through the customer HTTP app LOGIN, settles once through the Admin LOGIN, and reads the whole receipt', async () => {
    await profiles(async (app, admin) => {
      const { order } = await createAndPay(app, admin);
      const identities = await catalog();
      const response = await publicHttp(app)(order);
      expect(response.status, response.msg).toBe(200);
      if (!response.data) throw Error('Missing customer application response');
      const refundId = response.data.refundId;
      const [refund] = await app.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
      expect(readRefundQuantityReservation(refund)?.version).toBe(MATERIALIZED_REFUND_VERSION);
      const key = crypto.randomUUID(), decision = { review: review(refund),
        decision: { applyType: 1, refundType: 0, received: false } };
      const execute = () => executeAdminRefundOperation(createContainerFromDb(admin.db), f.env, actor(),
        refundId, key, 'refund', decision);
      expect(await execute()).toMatchObject({ replayed: false, receipt: { outcome: 'balance-settled' },
        execution: { completed: true, status: 'BALANCE_SUCCESS' } });
      await readAndAssert(app, admin, refundId, order);
      const completed = await state();
      expect(await execute()).toMatchObject({ replayed: true, receipt: { outcome: 'balance-settled' } });
      expect(await finalizeStoreOrderRefund(createContainerFromDb(app.db), refundId)).toBe('already-completed');
      expect(await state()).toEqual(completed);
      expect(await catalog()).toEqual(identities);
    });
  }, 90_000);

  it('quotes and creates in the Admin LOGIN, executes its original creation once, and preserves both read projections', async () => {
    await profiles(async (app, admin) => {
      const { order } = await createAndPay(app, admin);
      const identities = await catalog(), before = await state();
      const q = await quote(admin, order);
      expect(q).toMatchObject({ quotedPrice: '20.00', refundNum: 2, items: [{ cartNum: 2 }] });
      expect(await state()).toEqual(before);
      const intent = body(q), key = crypto.randomUUID(), container = createContainerFromDb(admin.db);
      const created = await createAdminRefundApplication(container, actor(), key, intent);
      expect(created).toMatchObject({ replayed: false, receipt: { outcome: 'created' } });
      if (!created.receipt.refundId) throw Error('Missing Admin application receipt');
      const refundId = created.receipt.refundId;
      expect((await app.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe('80.00');
      const execute = () => executeAdminProactiveRefund(container, f.env, actor(), key, intent);
      expect(await execute()).toMatchObject({ creation: { replayed: true },
        operation: { receipt: { outcome: 'balance-settled' }, execution: { completed: true, status: 'BALANCE_SUCCESS' } } });
      await readAndAssert(app, admin, refundId, order);
      const completed = await state();
      expect(await execute()).toMatchObject({ creation: { replayed: true }, operation: { replayed: true } });
      expect(await state()).toEqual(completed);
      expect(await catalog()).toEqual(identities);
    });
  }, 90_000);

  it('refuses an incomplete paid outbox, readonly actor and missing receipt authority without DDL or grant repair', async () => {
    await profiles(async (app, admin, target) => {
      const { order, completePayment } = await createAndPay(app, admin, false);
      const application = () => applyOrderRefundFromPublicEntry(createContainerFromDb(app.db), {
        uid: 11, orderId: order.orderId, applyType: 1,
        refundReason: 'Local full-gift ACL fault', refundExplain: '',
      });
      const pending = await state(), pendingCatalog = await catalog();
      await expect(application()).rejects.toThrow(/付款.*后置任务/);
      await expect(quote(admin, order)).rejects.toThrow(/付款.*后置任务/);
      expect(await state()).toEqual(pending); expect(await catalog()).toEqual(pendingCatalog);
      await completePayment();
      const paid = await state(), installed = await catalog();
      await expect(quote(admin, order, actor(2))).rejects.toThrow('退款操作权限');
      expect(await state()).toEqual(paid); expect(await catalog()).toEqual(installed);
      const [receiptPrivileges] = await admin.exec(`SELECT
        has_table_privilege(current_user,'store_order_promotion_gift_coupon_reward','SELECT') AS read,
        has_table_privilege(current_user,'store_order_promotion_gift_coupon_reward','INSERT') AS append,
        has_table_privilege(current_user,'store_order_promotion_gift_coupon_reward','UPDATE,DELETE') AS mutate`);
      expect(receiptPrivileges).toEqual({ read: true, append: false, mutate: false });
      await expect(admin.exec(`INSERT INTO store_order_promotion_gift_coupon_reward
        (order_id,uid,root_id,tier_id,auxiliary_id,issue_coupon_id,coupon_user_id) VALUES(1,11,61,61,71,21,41)`))
        .rejects.toMatchObject({ code: '42501' });
      expect(await state()).toEqual(paid); expect(await catalog()).toEqual(installed);

      // Fault injection is explicit owner-only setup. Business calls neither
      // repair the grant nor create an evidence table. Restore exactly one
      // reviewed grant only after checking the failed complete transaction.
      await f.exec(`REVOKE SELECT ON public.store_order_promotion_gift_coupon_reward FROM "${admin.role}"`);
      const unreadable = await catalog();
      await expect(quote(admin, order)).rejects.toThrow();
      expect(await state()).toEqual(paid); expect(await catalog()).toEqual(unreadable);
      await f.exec(`GRANT SELECT ON public.store_order_promotion_gift_coupon_reward TO "${admin.role}"`);
      const created = await application();
      await f.exec(`REVOKE INSERT ON public.store_order_refund_split FROM "${app.role}"`);
      const reserved = await state(), noAppend = await catalog();
      await expect(finalizeStoreOrderRefund(createContainerFromDb(app.db), created.refundId))
        .rejects.toThrow('满送退款运行合同尚未就绪');
      expect(await state()).toEqual(reserved); expect(await catalog()).toEqual(noAppend);
      expect((await auditRuntimeBusinessPrivileges(app.db, 'app', target)).ready).toBe(false);
      await f.exec(`GRANT INSERT ON public.store_order_refund_split TO "${app.role}"`);
      expect(await finalizeStoreOrderRefund(createContainerFromDb(app.db), created.refundId)).toBe('completed');
      await readAndAssert(app, admin, created.refundId, order);
      expect(await auditRuntimeBusinessPrivileges(app.db, 'app', target)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', target)).toMatchObject({ ready: true, failures: [] });
      expect(await catalog()).toEqual(installed);
    });
  }, 90_000);
});
