import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { orderConfirm } from '../src/controllers/api/v1/OrderController';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { AdminCombinationService } from '../src/services/admin/AdminCombinationService';
import { CombinationSkuCatalogService } from '../src/services/activity/CombinationSkuCatalogService';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { applyStoreOrderBalancePayment } from '../src/services/order/StoreOrderPayService';
import { StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { storeCombination, storeOrder, storeOrderCartInfo, storeOrderRefund, storePink, storeProduct, user, userBill } from '../src/models/schema';
import { combinationEdit, combinationInput } from './helpers/combinationAdminFixture';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

// Real registered schema, confirmation receipt, order creation, wallet payment
// and user refund admission. No provider, notification dispatch or refund cash
// execution is invoked; no fixture-only runtime grants are added.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Combination purchase-time refund configuration on exact runtime LOGINs', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture(); f.env.APP_KEY = 'local-combination-policy-key';
    await f.db.update(user).set({ nowMoney: '1000.00' }).where(eq(user.uid, 11));
    await f.db.update(storeProduct).set({ isVerify: 1, isVipProduct: 0, isPresaleProduct: 0, sliderImage: '["/images/refund-policy.png"]' }).where(eq(storeProduct.id, 70));
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),(SELECT max(id) FROM store_product_attr_value),true)");
    await f.exec("SELECT setval(pg_get_serial_sequence('store_cart','id'),(SELECT max(id) FROM store_cart),true)");
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  type Role = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (r: infer R) => unknown ? R : never;
  async function profiles(run: (app: Role, admin: Role) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS database'), names = { app: app.role, admin: admin.role, maintenance: 'finance_test' };
      await runRuntimeBusinessCommissioning(f.db, { ...names, database: String(identity.database), pricingOwner: f.pricingOwner });
      expect(await auditRuntimeBusinessPrivileges(app.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      await run(app, admin);
    }));
  }
  async function confirmedPurchase(role: Role, cartId: number, identity: string, combinationId?: number) {
    const container = createContainerFromDb(role.db), http = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    http.use('*', async (c, next) => { c.set('container', container); c.set('uid', 11); await next(); });
    http.onError((error, c) => c.json({ status: 400, msg: error.message, data: null })); http.post('/confirm', orderConfirm);
    const input = { cartIds: [cartId], addressId: 11, shippingType: 1, useIntegral: false,
      type: combinationId === undefined ? 0 : 3, ...(combinationId === undefined ? {} : { combinationId }) };
    const response = await http.request('/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, f.env);
    const quote = await response.json<{ status: number; msg: string; data: { orderKey: string; quoteToken: string } }>();
    expect(quote.status, quote.msg).toBe(200); expect(quote.data.quoteToken).toEqual(expect.any(String));
    const created = await StoreOrderCreateService.createWithRuntime(container,
      { CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true, requirePurchaseOrigin: true, nextOrderId: async () => identity },
      { ...input, uid: 11, key: quote.data.orderKey, quoteToken: quote.data.quoteToken, userIp: '127.0.0.1' });
    const [order] = await role.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(order).toMatchObject({ uid: 11, type: input.type, paid: 0 });
    const [line] = await role.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    const [before] = await role.db.select({ money: user.nowMoney }).from(user).where(eq(user.uid, 11));
    expect(await applyStoreOrderBalancePayment(container, { uid: 11, orderId: order.orderId })).toMatchObject({ outcome: 'paid' });
    const [paid] = await role.db.select().from(storeOrder).where(eq(storeOrder.id, order.id));
    const [after] = await role.db.select({ money: user.nowMoney }).from(user).where(eq(user.uid, 11));
    expect(paid).toMatchObject({ paid: 1, payType: 'yue' }); expect(Number(before.money) - Number(after.money)).toBeCloseTo(Number(paid.payPrice), 2);
    expect(await role.db.select().from(userBill).where(eq(userBill.linkId, paid.orderId))).toHaveLength(1);
    return { container, order: paid, line };
  }
  const apply = (purchase: Awaited<ReturnType<typeof confirmedPurchase>>) => new StoreOrderRefundService(purchase.container, f.env).applyRefund({ uid: 11,
    orderId: purchase.order.orderId, applyType: 1, refundReason: '本地真实退款准入', refundExplain: '',
    cartSelections: [{ cartId: Number(purchase.line.cartId), cartNum: 1 }] });

  it.each([0, 1] as const)('snapshots combination refund=%s instead of the opposite base flag, and keeps that decision after both configurations change', async policy => {
    await profiles(async (app, admin) => {
      await f.db.update(storeProduct).set({ isSupportRefund: policy === 1 ? 0 : 1 }).where(eq(storeProduct.id, 70));
      const manager = new AdminCombinationService(createContainerFromDb(admin.db), f.env.APP_KEY), created = await manager.mutate('create', 0,
        combinationInput({ product_id: 70, is_support_refund: policy, shipping: { delivery_type: [1], freight: 2, postage: '3.00', temp_id: 0 },
          skus: [{ id: null, base_unique: 'qared001', enabled: true, price: '6.25', quota_total: 5, image: '/images/refund-owned-sku.png' }] }), { id: 1 });
      const selection = await new CombinationSkuCatalogService(createContainerFromDb(app.db)).read(11, String(created.id));
      expect(selection.skus).toHaveLength(1);
      const cart = await new StoreCartService(createContainerFromDb(app.db), f.env).add({ uid: 11, productId: 70, activityId: created.id,
        type: 3, unique: selection.skus[0].unique, cartNum: 1, isNew: 1 });
      const purchase = await confirmedPurchase(app, cart.id, `combo_refund_policy_${policy}`, created.id);
      expect(purchase.line.isSupportRefund).toBe(policy);
      expect(purchase.order.activityId).toBe(created.id); expect(purchase.order.pinkId).toBeGreaterThan(0);
      expect((await app.db.select().from(storePink).where(eq(storePink.id, purchase.order.pinkId)))[0]).toMatchObject({ status: 1, combinationId: created.id, uid: 11 });
      // Alter the activity via its actual Admin service and alter the base as
      // fixture setup. Neither mutable value may rewrite the purchased line.
      await manager.mutate('update', created.id, combinationEdit(await manager.detail(created.id), { is_support_refund: policy === 1 ? 0 : 1 }), { id: 1 });
      await f.db.update(storeProduct).set({ isSupportRefund: policy }).where(eq(storeProduct.id, 70));
      expect((await app.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, purchase.line.id)))[0].isSupportRefund).toBe(policy);
      if (policy === 0) {
        const before = await f.state(); await expect(apply(purchase)).rejects.toThrow('不支持退款'); expect(await f.state()).toEqual(before);
      } else {
        const receipt = await apply(purchase); expect(receipt.refundId).toBeGreaterThan(0);
        expect((await app.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, receipt.refundId)))[0]).toMatchObject({ storeOrderId: purchase.order.id, uid: 11, refundNum: 1 });
      }
      expect((await admin.db.select().from(storeCombination).where(eq(storeCombination.id, created.id)))[0].isSupportRefund).not.toBe(policy);
    });
  }, 60000);
  it.each([0, 1] as const)('preserves ordinary type0 purchase-time base refund=%s after the source flag changes', async policy => {
    await profiles(async app => {
      await f.db.update(storeProduct).set({ isSupportRefund: policy }).where(eq(storeProduct.id, 70));
      const cart = await new StoreCartService(createContainerFromDb(app.db), f.env).add({ uid: 11, productId: 70, type: 0, unique: 'qared001', cartNum: 1, isNew: 1 });
      const purchase = await confirmedPurchase(app, cart.id, `ordinary_refund_policy_${policy}`);
      expect(purchase.line.isSupportRefund).toBe(policy); expect(purchase.order.activityId).toBe(0);
      await f.db.update(storeProduct).set({ isSupportRefund: policy === 1 ? 0 : 1 }).where(eq(storeProduct.id, 70));
      if (policy === 0) await expect(apply(purchase)).rejects.toThrow('不支持退款');
      else expect((await apply(purchase)).refundId).toBeGreaterThan(0);
      expect((await app.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, purchase.line.id)))[0].isSupportRefund).toBe(policy);
    });
  }, 60000);
});
