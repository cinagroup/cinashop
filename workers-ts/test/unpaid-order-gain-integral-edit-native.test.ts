import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { withTx } from '../src/lib/di';
import { storeOrder, storeOrderCartInfo, user, userBill } from '../src/models/schema';
import { planUnpaidOrderGainIntegralEdit } from '../src/services/order/UnpaidOrderGainIntegralEdit';
import { planOrderFinancialSplit } from '../src/services/order/OrderSplitFinance';
import { applyStoreOrderBalancePayment } from '../src/services/order/StoreOrderPayService';
import { applyOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '../src/services/supplier/SupplierFinanceService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { refundRuntimeFixture, shipping } from './helpers/refundRuntimeFixture';

const native = describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL));
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = ReturnType<Fixture['operationsFor']>;
type Order = typeof storeOrder.$inferSelect;

/** Real PG16 checkout, independently authenticated app LOGIN, balance debit,
 * allocation/fulfillment/refund cores and durable original purchase facts.
 * This helper-level suite is NOT Supplier JWT, edit receipt or provider/Queue
 * acceptance. Paid allocation is called as the actual SQL outbox segment;
 * the external dispatcher is deliberately not substituted with a fake success.
 */
native('effective unpaid gift edits through current checkout and financial cores', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await f.db.update(user).set({ nowMoney: '100.00', integral: 100 }).where(eq(user.uid, 11));
  }, 60_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  async function checkout(runtime: Runtime) {
    const created = await runtime.checkout({ key: 'unpaid-gift-edit', orderId: 'unpaid_gift_edit_checkout' });
    const [order] = await runtime.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(order).toMatchObject({ paid: 0, status: 0, pid: 0, supplierId: 7, gainIntegral: '200.00' });
    return order;
  }

  async function edit(runtime: Runtime, original: Order, target: number, payment = original.payPrice) {
    return withTx(runtime.container, async tx => {
      const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, original.id)).for('update');
      const rows = await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id))
        .orderBy(asc(storeOrderCartInfo.id)).for('update');
      const plan = await planUnpaidOrderGainIntegralEdit(order, rows, { operationId: crypto.randomUUID(), gainIntegral: target });
      for (const line of plan.lines) {
        const [updated] = await tx.update(storeOrderCartInfo).set({ cartInfo: line.afterCartInfo })
          .where(eq(storeOrderCartInfo.id, line.rowId)).returning();
        expect(updated.cartInfo).toBe(line.afterCartInfo);
      }
      const cents = (value: string) => BigInt(value.replace('.', ''));
      const difference = cents(order.payPrice) + cents(order.changePrice) - cents(payment);
      const absolute = difference < 0n ? -difference : difference;
      const changePrice = `${difference < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
      const [updated] = await tx.update(storeOrder).set({ gainIntegral: plan.gainIntegral, payPrice: payment, changePrice })
        .where(eq(storeOrder.id, order.id)).returning();
      return { order: updated, plan, originalRows: rows };
    });
  }

  async function pay(runtime: Runtime, order: Order) {
    const payment = await applyStoreOrderBalancePayment(runtime.container, { uid: 11, orderId: order.orderId });
    expect(payment).toMatchObject({ outcome: 'paid', outbox: { eventKey: `order.paid:${order.id}` } });
    expect(await applyStoreOrderBalancePayment(runtime.container, { uid: 11, orderId: order.orderId }))
      .toEqual({ outcome: 'already-paid', outbox: null });
    const allocated = await withTx(runtime.container, async tx => {
      const allocation = await allocatePaidOrderBySupplier(tx, order.id, order.orderId);
      for (const child of allocation.fulfillmentOrders) await recordSupplierPayment(tx, child);
      return allocation;
    });
    expect(allocated.fulfillmentOrders).toHaveLength(1);
    return allocated.fulfillmentOrders[0];
  }

  async function refundLine(runtime: Runtime, orderId: number, row: typeof storeOrderCartInfo.$inferSelect) {
    const order = await runtime.order(orderId);
    return applyOrderRefund(runtime.container, { uid: 11, orderId: order.orderId, applyType: 1,
      refundReason: 'Local edited gift line', refundExplain: '', applicationOrderId: crypto.randomUUID().replaceAll('-', ''),
      cartSelections: [{ cartId: Number(row.cartId), cartNum: row.cartNum }] });
  }

  it('preserves checkout purchase origin through repeated edits, real balance payment, quantity splits and refunds after receipt', async () => {
    await f.withRuntime(async runtime => {
      const order = await checkout(runtime);
      const [origin] = await f.exec(`SELECT to_jsonb(t) AS row FROM public.store_order_purchase_origin t WHERE order_id=${order.id}`);
      const first = await edit(runtime, order, 10);
      const second = await edit(runtime, first.order, 25, '31.25');
      const expectedPurchase = first.originalRows.map(row => JSON.parse(row.cartInfo!).product);
      const paid = await pay(runtime, second.order);
      const bills = await runtime.db.select().from(userBill).where(eq(userBill.type, 'pay_product'));
      expect(bills).toMatchObject([{ number: '31.25', pm: 0, linkId: order.orderId }]);
      const fulfillment = new SupplierFulfillmentService(runtime.container, f.env);
      const firstCart = (await runtime.carts(paid.id)).find(row => row.productId === 70)!;
      const split = await fulfillment.splitDelivery(7, paid.id, shipping, [{ cartId: firstCart.cartId, cartNum: 1 }]);
      expect(split.remaining_order_id).toBeGreaterThan(0);
      const ids = [split.order_id, split.remaining_order_id!];
      expect((await Promise.all(ids.map(id => runtime.order(id)))).map(row => row.gainIntegral)).toEqual(['12.00', '13.00']);
      await fulfillment.deliver(7, ids[1], shipping);
      for (const id of ids) await fulfillment.confirmTake(7, id);
      const [rewarded] = await runtime.db.select().from(user).where(eq(user.uid, 11));
      expect(rewarded.integral).toBe(25);
      for (const id of ids) {
        const rows = await runtime.carts(id);
        for (const row of rows) {
          const refund = await refundLine(runtime, id, row);
          expect(await runtime.finish(refund.refundId)).toBe('completed');
          const completed = await f.state();
          expect(await runtime.finish(refund.refundId)).toBe('already-completed');
          expect(await f.state()).toEqual(completed);
        }
      }
      const [done] = await runtime.db.select().from(user).where(eq(user.uid, 11));
      expect(done).toMatchObject({ nowMoney: '100.00', integral: 100 });
      const [retainedOrigin] = await f.exec(`SELECT to_jsonb(t) AS row FROM public.store_order_purchase_origin t WHERE order_id=${order.id}`);
      expect(retainedOrigin).toEqual(origin);
      expect((await runtime.carts(order.id)).map(row => JSON.parse(row.cartInfo!).product)).toEqual(expectedPurchase);
    });
  }, 120_000);

  it('handles originally zero grants through actual payment and a full pre-receipt refund without granting or reversing unearned points', async () => {
    await f.exec("UPDATE public.store_product SET give_integral=0 WHERE id=70");
    await f.withRuntime(async runtime => {
      const created = await runtime.checkout({ key: 'unpaid-zero-gift-edit', orderId: 'unpaid_zero_gift_edit_checkout' });
      const [order] = await runtime.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      expect(order.gainIntegral).toBe('0.00');
      const edited = await edit(runtime, order, 7);
      expect(edited.plan.evidence).toMatchObject({ weight_basis: 'quantity', before_total: 0, after_total: 7 });
      expect(edited.plan.lines.map(line => line.afterGainIntegral)).toEqual([4, 3]);
      const paid = await pay(runtime, edited.order);
      for (const row of await runtime.carts(paid.id)) {
        const refund = await refundLine(runtime, paid.id, row);
        expect(await runtime.finish(refund.refundId)).toBe('completed');
      }
      const [done] = await runtime.db.select().from(user).where(eq(user.uid, 11));
      expect(done).toMatchObject({ nowMoney: '100.00', integral: 100 });
      const bills = await runtime.db.select().from(userBill);
      expect(bills.filter(row => row.eventKey === 'integral_refund')).toEqual([]);
      expect(bills.filter(row => row.eventKey === 'pay_product_integral_back')).toMatchObject([
        { type: 'pay_product_integral_back', pm: 1, number: '40.00', linkId: String(paid.id) },
        { type: 'pay_product_integral_back', pm: 1, number: '60.00', linkId: String(paid.id) },
      ]);
    });
  }, 120_000);

  it('rejects a torn modern gift aggregate before any write and leaves every real SQL fact unchanged', async () => {
    await f.withRuntime(async runtime => {
      const order = await checkout(runtime), rows = await runtime.carts(order.id), before = await f.state();
      await expect(planUnpaidOrderGainIntegralEdit({ ...order, gainIntegral: '199.00' }, rows,
        { operationId: crypto.randomUUID(), gainIntegral: 10 })).rejects.toThrow('财务快照');
      expect(await f.state()).toEqual(before);
      const valid = await planUnpaidOrderGainIntegralEdit(order, rows, { operationId: crypto.randomUUID(), gainIntegral: 1 });
      const futureRows = rows.map(row => ({ ...row, cartInfo: valid.lines.find(line => line.rowId === row.id)!.afterCartInfo }));
      expect(planOrderFinancialSplit({ ...order, gainIntegral: valid.gainIntegral }, futureRows,
        new Map(futureRows.map(row => [row.cartId, row.cartNum])))).not.toBeNull();
      expect(await f.state()).toEqual(before);
    });
  }, 120_000);
});
