/** Complete native schema, synthetic payment, real financial/structural service
 * writes and a separate restricted LOGIN reading a repeatable READ ONLY snapshot. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import { refundRuntimeFixture, shipping } from './helpers/refundRuntimeFixture';
import { readPurchaseQuotaPaymentLedger } from '@/services/order/PurchaseQuotaPaymentLedger';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { finalizeStoreOrderRefund, StoreOrderRefundService } from '@/services/order/StoreOrderRefundService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '@/services/supplier/SupplierFinanceService';
import { SupplierFulfillmentService } from '@/services/supplier/SupplierFulfillmentService';
import { storeCart, storeOrder, storeProduct, storeOrderRefund } from '@/models/schema';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = Parameters<Parameters<Fixture['withRuntime']>[0]>[0];
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('paid purchase quota family lineage on PostgreSQL16', () => {
  let f: Fixture;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden')); f = await refundRuntimeFixture(); }, 45000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 45000);
  const read = (r: Runtime, root: number, buyerId = 11) => r.db.transaction(
    tx => readPurchaseQuotaPaymentLedger(tx, { paymentOrderId: root, buyerId }), { isolationLevel: 'repeatable read', accessMode: 'read only' });
  async function paid(r: Runtime, presale = false) {
    if (presale) {
      await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: 0, presaleEndTime: 2147483647, isLimit: 0 })
        .where(eq(storeProduct.id, 70));
      await f.db.update(storeCart).set({ type: 6, cartNum: 3 }).where(eq(storeCart.id, 1));
    }
    const created = presale ? await StoreOrderCreateService.createWithRuntime(r.container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'local_quota_presale' },
      { uid: 11, key: 'local-quota-presale', type: 6, cartIds: [1], addressId: 11, useIntegral: true, userIp: '127.0.0.1' }) : await r.checkout();
    return withTx(r.container, async tx => {
      const [order] = await tx.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'LOCAL-SYNTHETIC' })
        .where(and(eq(storeOrder.orderId, created.orderId), eq(storeOrder.paid, 0))).returning();
      const allocation = await allocatePaidOrderBySupplier(tx, order.id, order.orderId, 100);
      for (const child of allocation.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
      return { root: order.id, orders: allocation.fulfillmentOrders };
    });
  }
  it('counts the original purchase once without treating a pending application as returned quantity', async () => {
    await f.withRuntime(async r => {
      const purchase = await paid(r), before = await f.state(), baseline = await read(r, purchase.root);
      expect(baseline.products).toEqual([
        { productId: 70, purchased: 2, refunded: 0, pending: 0, remaining: 2 },
        { productId: 71, purchased: 1, refunded: 0, pending: 0, remaining: 1 },
      ]); expect(baseline.refundIds).toEqual([]); expect(await f.state()).toEqual(before);
      const application = await r.apply(purchase.orders[0].id);
      expect((await read(r, purchase.root)).products[0]).toEqual({ productId: 70, purchased: 2, refunded: 0, pending: 1, remaining: 2 });
      await new StoreOrderRefundService(r.container, f.env).cancelApply(11, application.refundId);
      expect((await read(r, purchase.root)).products).toEqual(baseline.products);
    });
  }, 45000);
  it('conserves three successive presale refunds, including hidden orders and hidden business refund rows', async () => {
    await f.withRuntime(async r => {
      const purchase = await paid(r, true); let orderId = purchase.root;
      const ids: number[] = [];
      for (let returned = 1; returned <= 3; returned++) {
        const application = await r.apply(orderId); expect(await r.finish(application.refundId)).toBe('completed'); ids.push(application.refundId);
        const result = await read(r, purchase.root);
        expect(result.products).toEqual([{ productId: 70, purchased: 3, refunded: returned, pending: 0, remaining: 3 - returned }]);
        expect(result.refundIds).toEqual(ids);
        const receipt = await r.receipt(application.refundId); orderId = receipt.remainingOrderId ?? orderId;
      }
      const original = await read(r, purchase.root);
      await f.db.update(storeOrder).set({ isDel: 1, isSystemDel: 1 });
      await f.db.update(storeOrderRefund).set({ isDel: 1 });
      const before = await f.state(); expect(await read(r, purchase.root)).toEqual(original); expect(await f.state()).toEqual(before);
    });
  }, 45000);
  it('follows two post-refund fulfillment forks and refunds on both delivered and retained branches', async () => {
    await f.db.update(storeCart).set({ cartNum: 4 }).where(eq(storeCart.id, 1));
    await f.withRuntime(async r => {
      const purchase = await paid(r), first = await r.apply(purchase.root); await r.finish(first.refundId);
      const remainder = (await r.receipt(first.refundId)).remainingOrderId!, service = new SupplierFulfillmentService(r.container, f.env);
      const sent: number[] = [];
      for (let i = 0; i < 2; i++) {
        const line = (await r.carts(remainder)).find(row => row.productId === 70)!;
        const fork = await service.splitDelivery(7, remainder, shipping, [{ cartId: line.cartId, cartNum: 1 }]);
        sent.push(fork.order_id);
        const result = await read(r, purchase.root);
        expect(result.products[0]).toMatchObject({ purchased: 4, refunded: 1, pending: 0, remaining: 3 });
        expect(result.branchIds).toHaveLength((i + 1) * 2);
      }
      for (const orderId of sent) {
        await service.confirmTake(7, orderId);
        const refund = await r.apply(orderId); expect(await r.finish(refund.refundId)).toBe('completed');
        await read(r, purchase.root);
      }
      const last = await r.apply(remainder); await r.finish(last.refundId);
      const final = await r.apply(remainder, 71); await r.finish(final.refundId);
      const before = await f.state(), result = await read(r, purchase.root);
      expect(result.products).toEqual([{ productId: 70, purchased: 4, refunded: 4, pending: 0, remaining: 0 },
        { productId: 71, purchased: 1, refunded: 1, pending: 0, remaining: 0 }]);
      expect(result.refundIds).toHaveLength(5); expect(new Set(result.refundIds).size).toBe(5);
      expect(result.branchIds).toHaveLength(4); expect(await f.state()).toEqual(before);
    });
  }, 45000);
  it('anchors independent supplier/platform allocations to the retained payment root', async () => {
    await f.db.update(storeProduct).set({ type: 1, relationId: 0 }).where(eq(storeProduct.id, 71));
    await f.withRuntime(async r => {
      const purchase = await paid(r); expect(purchase.orders).toHaveLength(2);
      const initial = await read(r, purchase.root);
      expect(initial.products.map(row => row.purchased)).toEqual([2, 1]);
      const supplier = purchase.orders.find(order => order.supplierId === 7)!, platform = purchase.orders.find(order => order.supplierId === 0)!;
      const refund = await r.apply(supplier.id); await r.finish(refund.refundId);
      const after = await read(r, purchase.root);
      expect(after.products.map(row => [row.purchased, row.refunded, row.remaining])).toEqual([[2, 1, 1], [1, 0, 1]]);
      expect(platform.id).not.toBe(supplier.id);
    });
  }, 45000);
  it('anchors ordinary fulfillment splits before the first refund without inventing refund-branch evidence', async () => {
    await f.withRuntime(async r => {
      const purchase = await paid(r), service = new SupplierFulfillmentService(r.container, f.env);
      const line = (await r.carts(purchase.root)).find(row => row.productId === 70)!;
      const fork = await service.splitDelivery(7, purchase.root, shipping, [{ cartId: line.cartId, cartNum: 1 }]);
      const split = await read(r, purchase.root);
      expect(split.branchIds).toEqual([]); expect(split.products.map(row => row.purchased)).toEqual([2, 1]);
      await service.confirmTake(7, fork.order_id);
      const refund = await r.apply(fork.order_id); await r.finish(refund.refundId);
      expect((await read(r, purchase.root)).products[0]).toEqual({ productId: 70, purchased: 2, refunded: 1, pending: 0, remaining: 1 });
    });
  }, 45000);
  it('rejects live product/quantity/generation drift without retaining injected mutations', async () => {
    await f.withRuntime(async r => {
      const purchase = await paid(r), application = await r.apply(purchase.root); await r.finish(application.refundId);
      const receipt = await r.receipt(application.refundId), before = await f.state();
      for (const statement of [
        sql`UPDATE store_order_cart_info SET product_id=999 WHERE oid=${receipt.remainingOrderId}`,
        sql`UPDATE store_order SET total_num=total_num+1 WHERE id=${purchase.root}`,
        sql`UPDATE store_order_cart_info SET cart_info=(cart_info::jsonb-'refund_order_generation')::text WHERE oid=${receipt.remainingOrderId}`,
        sql`UPDATE store_order_refund SET refund_num=refund_num+1 WHERE id=${application.refundId}`,
      ]) {
        await expect(f.db.transaction(async tx => {
          await tx.execute(statement); await readPurchaseQuotaPaymentLedger(tx, { paymentOrderId: purchase.root, buyerId: 11 });
        }, { isolationLevel: 'repeatable read' })).rejects.toThrow();
        expect(await f.state()).toEqual(before);
      }
      expect((await read(r, purchase.root)).products[0].refunded).toBe(1);
    });
  }, 45000);
  it('requires a caller-owned consistent snapshot and exact buyer/payment root', async () => {
    await f.withRuntime(async r => {
      const purchase = await paid(r), before = await f.state(), scope = { paymentOrderId: purchase.root, buyerId: 11 };
      await expect(readPurchaseQuotaPaymentLedger(r.db, scope)).rejects.toThrow();
      await expect(r.db.transaction(tx => readPurchaseQuotaPaymentLedger(tx, scope))).rejects.toThrow();
      await expect(read(r, purchase.root, 22)).rejects.toThrow();
      await expect(read(r, 2147483647)).rejects.toThrow();
      expect((await read(r, purchase.root)).products).toHaveLength(2); expect(await f.state()).toEqual(before);
    });
  }, 45000);
  it('keeps one snapshot coherent when another connection commits a refund between reads', async () => {
    await f.withRuntime(async r => {
      const purchase = await paid(r), application = await r.apply(purchase.root), scope = { paymentOrderId: purchase.root, buyerId: 11 };
      await r.db.transaction(async tx => {
        const before = await readPurchaseQuotaPaymentLedger(tx, scope);
        expect(before.products[0]).toMatchObject({ refunded: 0, pending: 1 });
        // Separate fixture-owner connection, real finalizer, no fabricated receipt.
        expect(await finalizeStoreOrderRefund(createContainerFromDb(f.db), application.refundId)).toBe('completed');
        expect(await readPurchaseQuotaPaymentLedger(tx, scope)).toEqual(before);
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
      expect((await read(r, purchase.root)).products[0]).toMatchObject({ refunded: 1, pending: 0, remaining: 1 });
    });
  }, 45000);
  it('fails on each missing existing SELECT privilege without acquiring extra authority', async () => {
    await f.withRuntime(async r => {
      const purchase = await paid(r), application = await r.apply(purchase.root); await r.finish(application.refundId);
      const before = await f.state();
      for (const table of ['store_order', 'store_order_cart_info', 'store_order_fulfillment_branch', 'store_order_refund', 'store_order_refund_split']) {
        await f.exec(`REVOKE SELECT ON public.${table} FROM "${r.role}"`);
        try {
          await expect(read(r, purchase.root)).rejects.toMatchObject({ cause: { code: '42501' } });
          const [privilege] = await r.db.execute(sql`SELECT has_table_privilege(current_user, ${table}, 'SELECT') AS allowed`);
          expect(privilege.allowed).toBe(false);
        } finally { await f.exec(`GRANT SELECT ON public.${table} TO "${r.role}"`); }
      }
      expect((await read(r, purchase.root)).products[0].refunded).toBe(1); expect(await f.state()).toEqual(before);
    });
  }, 45000);
});
