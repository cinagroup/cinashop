/** Owned local PostgreSQL16, registered schema and independent restricted LOGIN.
 * Synthetic payment marker; real checkout, refund reservation and materialization.
 * This is receipt verification, NOT an enabled purchase-quota enforcement test. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTx } from '@/lib/di';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '@/services/supplier/SupplierFinanceService';
import { readPurchaseQuotaRefundReceipt } from '@/services/order/PurchaseQuotaRefundReceipt';
import { storeCart, storeOrder, storeProduct } from '@/models/schema';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = Parameters<Parameters<Fixture['withRuntime']>[0]>[0];
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('quota refund receipts under independent PostgreSQL LOGIN', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O permitted'));
    f = await refundRuntimeFixture();
  }, 45000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 45000);
  const read = (r: Runtime, refundId: number, paymentOrderId: number, buyerId = 11) =>
    r.db.transaction(tx => readPurchaseQuotaRefundReceipt(tx, { refundId, paymentOrderId, buyerId }), { accessMode: 'read only' });
  async function presale(r: Runtime) {
    await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: 0, presaleEndTime: 2147483647,
      presaleDay: 7, isLimit: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeCart).set({ type: 6, cartNum: 3 }).where(eq(storeCart.id, 1));
    const created = await StoreOrderCreateService.createWithRuntime(r.container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'local_presale_quota' },
      { uid: 11, key: 'local-presale-quota', type: 6, cartIds: [1], addressId: 11, useIntegral: true, userIp: '127.0.0.1' });
    return withTx(r.container, async tx => {
      const [paid] = await tx.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'LOCAL-SYNTHETIC' })
        .where(and(eq(storeOrder.orderId, created.orderId), eq(storeOrder.paid, 0))).returning();
      const allocation = await allocatePaidOrderBySupplier(tx, paid.id, paid.orderId, 100);
      expect(allocation.fulfillmentOrders).toHaveLength(1);
      for (const order of allocation.fulfillmentOrders) await recordSupplierPayment(tx, order, 100);
      return { root: paid.id, order: allocation.fulfillmentOrders[0] };
    });
  }
  it('never treats an application reservation as completed refund quantity', async () => {
    await f.withRuntime(async r => {
      const paid = await presale(r), application = await r.apply(paid.order.id, 70, 1);
      expect((await r.carts(paid.order.id))[0].refundNum).toBe(1);
      const before = await f.state();
      await expect(read(r, application.refundId, paid.root)).rejects.toThrow(/数量凭据/);
      expect(await f.state()).toEqual(before);
    });
  }, 45000);
  it('anchors three completed presale refunds to their frozen generations, not live counters', async () => {
    await f.withRuntime(async r => {
      const paid = await presale(r); let orderId = paid.order.id, previousRefundId = 0;
      const refunds: number[] = [];
      for (const remaining of [2, 1, 0]) {
        const application = await r.apply(orderId, 70, 1);
        expect(await r.finish(application.refundId)).toBe('completed');
        const before = await f.state(), verified = await read(r, application.refundId, paid.root);
        expect(verified).toMatchObject({ sourceOrderId: orderId, previousRefundId,
          lines: [{ productId: 70, selectedNum: 1, remainingNum: remaining }] });
        expect(await r.finish(application.refundId)).toBe('already-completed');
        expect(await f.state()).toEqual(before);
        if (remaining) { expect(verified.disposition).toBe('split'); orderId = verified.remainingOrderId!; }
        else expect(verified.disposition).toBe('whole');
        previousRefundId = application.refundId; refunds.push(application.refundId);
      }
      expect((await r.carts(orderId))[0].refundNum).toBe(0);
      const before = await f.state();
      const history = await Promise.all(refunds.map(id => read(r, id, paid.root)));
      expect(history.map(row => row.lines[0].selectedNum)).toEqual([1, 1, 1]);
      expect(history.map(row => row.lines[0].remainingNum)).toEqual([2, 1, 0]);
      expect(await f.state()).toEqual(before);
    });
  }, 45000);
  it('preserves product scope and zero selected quantity for other ordinary products', async () => {
    await f.withRuntime(async r => {
      const order = await r.createPaid(), application = await r.apply(order.id);
      expect(await r.finish(application.refundId)).toBe('completed');
      const before = await f.state(), result = await read(r, application.refundId, order.pid || order.id);
      expect(result.lines.find(row => row.productId === 70)?.selectedNum).toBe(1);
      expect(result.lines.find(row => row.productId === 71)).toMatchObject({ selectedNum: 0, remainingNum: 1 });
      expect(Object.keys(result)).not.toContain('evidence');
      expect(JSON.stringify(result)).not.toMatch(/cartInfo|refundPrice|tradeNo|realName|phone|address/);
      expect(await f.state()).toEqual(before);
    });
  }, 45000);
  it('rejects cross-buyer/root and absent receipt lookup without writes', async () => {
    await f.withRuntime(async r => {
      const paid = await presale(r), application = await r.apply(paid.order.id, 70, 3);
      expect(await r.finish(application.refundId)).toBe('completed');
      const before = await f.state();
      await expect(read(r, application.refundId, paid.root, 22)).rejects.toThrow(/数量凭据/);
      await expect(read(r, application.refundId, 2147483647)).rejects.toThrow(/数量凭据/);
      await expect(read(r, 2147483647, paid.root)).rejects.toThrow(/数量凭据/);
      await expect(readPurchaseQuotaRefundReceipt(r.db, { refundId: application.refundId, paymentOrderId: paid.root, buyerId: 11 }))
        .rejects.toThrow(/caller-owned transaction/);
      expect(await read(r, application.refundId, paid.root)).toMatchObject({ disposition: 'whole', lines: [{ selectedNum: 3 }] });
      expect(await f.state()).toEqual(before);
    });
  }, 45000);
  it('needs only the existing receipt SELECT grant and never escalates on denied access', async () => {
    await f.withRuntime(async r => {
      const paid = await presale(r), application = await r.apply(paid.order.id, 70, 3);
      expect(await r.finish(application.refundId)).toBe('completed');
      const before = await f.state();
      await f.exec(`REVOKE SELECT ON public.store_order_refund_split FROM "${r.role}"`);
      try {
        let failure: unknown;
        try { await read(r, application.refundId, paid.root); } catch (error) { failure = error; }
        expect(failure).toBeDefined();
        const codes: unknown[] = []; let at = failure;
        for (let depth = 0; depth < 5 && at && typeof at === 'object'; depth++) {
          const error = at as Record<string, unknown>; codes.push(error.code); at = error.cause;
        }
        expect(codes).toContain('42501');
        const [privilege] = await r.db.execute(sql`SELECT has_table_privilege(current_user, 'store_order_refund_split', 'SELECT') AS allowed`);
        expect(privilege.allowed).toBe(false);
      } finally {
        // Restore only the original, declared fixture grant; no authority expansion.
        await f.exec(`GRANT SELECT ON public.store_order_refund_split TO "${r.role}"`);
      }
      expect(await read(r, application.refundId, paid.root)).toMatchObject({ disposition: 'whole' });
      expect(await f.state()).toEqual(before);
    });
  }, 45000);
});
