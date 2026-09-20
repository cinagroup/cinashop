/** Native PG16 only. Synthetic payment state, no provider or production binding. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { withTx } from '../src/lib/di';
import { storeOrder, storeProduct, storeProductAttrValue, systemConfig, systemSupplier } from '../src/models/schema';
import { allocatePaidOrderBySupplier } from '../src/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '../src/services/supplier/SupplierFinanceService';
import { SupplierExportService } from '../src/services/supplier/SupplierExportService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { SupplierPickingSheetReadService } from '../src/services/supplier/SupplierPickingSheetReadService';
import { refundRuntimeFixture, shipping } from './helpers/refundRuntimeFixture';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = Parameters<Parameters<Fixture['withRuntime']>[0]>[0];
function cents(value: unknown) {
  if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) throw Error('Expected stored decimal');
  const [whole, fraction] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}
function snapshot(value: string | null): Record<string, unknown> {
  if (typeof value !== 'string') throw Error('Missing membership snapshot');
  return JSON.parse(value) as Record<string, unknown>;
}

describe('persisted membership benefit across real native-PG order generations', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    f = await refundRuntimeFixture();
    await f.db.update(systemConfig).set({ value: '1' }).where(and(eq(systemConfig.isStore, 0),
      inArray(systemConfig.menuName, ['member_card_status', 'svip_price_status'])));
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  });
  const savings = async (r: Runtime, id: number) => (await r.carts(id)).reduce((total, row) => {
    const info = snapshot(row.cartInfo);
    expect(info.cart_num).toBe(row.cartNum);
    expect(info.price_type).toBe(row.productId === 70 ? 'member' : '');
    expect(info.vip_truePrice).toBe(row.productId === 70 ? '1.00' : '0.00');
    expect(info.sum_price).toBe(row.productId === 70 ? '9.00' : '30.00');
    return total + cents(info.vip_truePrice) * BigInt(row.cartNum);
  }, 0n);
  const verifyReaders = async (r: Runtime, id: number, expected: string, supplierId = 7) => {
    const before = await f.state();
    expect((await new SupplierExportService(r.container).storeOrder(supplierId, { selection: 'exact', ids: String(id) }))
      .export[0].vip_sum_price).toBe(expected);
    expect((await new SupplierPickingSheetReadService(r.container).read(supplierId, [id])).list[0].vip_true_price).toBe(expected);
    expect(await f.state()).toEqual(before);
  };

  it('retains per-unit savings through two completed partial refunds without subtracting the benefit twice', async () => {
    await f.withRuntime(async r => {
      const root = await r.createPaid(), originalCash = cents(root.payPrice);
      // 2 * 9 + 30 merchandise, 3 member-discounted freight, 1 points deduction.
      expect(root).toMatchObject({ totalPrice: '48.00', payPostage: '3.00', deductionPrice: '1.00', payPrice: '50.00' });
      expect(await savings(r, root.id)).toBe(200n); await verifyReaders(r, root.id, '2.00');
      const first = await r.apply(root.id); await r.finish(first.refundId);
      const one = await r.receipt(first.refundId), firstRemaining = one.remainingOrderId!;
      expect(await savings(r, one.selectedOrderId)).toBe(100n);
      expect(await savings(r, firstRemaining)).toBe(100n);
      await verifyReaders(r, one.selectedOrderId, '1.00'); await verifyReaders(r, firstRemaining, '1.00');
      const second = await r.apply(firstRemaining); await r.finish(second.refundId);
      const two = await r.receipt(second.refundId), leaves = [one.selectedOrderId, two.selectedOrderId, two.remainingOrderId!];
      const leafBenefits = await Promise.all(leaves.map(id => savings(r, id)));
      expect(leafBenefits).toEqual([100n, 100n, 0n]);
      expect(leafBenefits.reduce((a, b) => a + b, 0n)).toBe(200n);
      const leafOrders = await Promise.all(leaves.map(id => r.order(id)));
      expect(leafOrders.reduce((total, row) => total + cents(row.payPrice), 0n)).toBe(originalCash);
      await verifyReaders(r, two.selectedOrderId, '1.00'); await verifyReaders(r, two.remainingOrderId!, '0.00');
    });
  }, 60_000);

  it('rolls back failed shipping then conserves both savings and paid amounts on an actual partial shipment', async () => {
    await f.withRuntime(async r => {
      const root = await r.createPaid(), cart = (await r.carts(root.id)).find(row => row.productId === 70)!;
      const service = new SupplierFulfillmentService(r.container, f.env);
      const ship = () => service.splitDelivery(7, root.id, shipping, [{ cartId: cart.cartId, cartNum: 1 }]);
      await f.exec(`CREATE FUNCTION reject_member_shipping() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'member shipping rollback'; END $$;
        CREATE TRIGGER reject_member_shipping BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION reject_member_shipping()`);
      const before = await f.state(); let failure: unknown;
      try { await ship(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).cause ?? failure)).toContain('member shipping rollback');
      expect(await f.state()).toEqual(before);
      await f.exec('DROP TRIGGER reject_member_shipping ON store_order_status; DROP FUNCTION reject_member_shipping()');
      const result = await ship(); expect(result.split).toBe(true);
      const leaves = [result.order_id, result.remaining_order_id!];
      expect(await Promise.all(leaves.map(id => savings(r, id)))).toEqual([100n, 100n]);
      const orders = await Promise.all(leaves.map(id => r.order(id)));
      expect(orders.reduce((total, row) => total + cents(row.payPrice), 0n)).toBe(cents(root.payPrice));
      await verifyReaders(r, leaves[0], '1.00'); await verifyReaders(r, leaves[1], '1.00');
    });
  }, 60_000);

  it('keeps supplier allocation and its replay bound to stored membership evidence, not current SKU or rights', async () => {
    await f.db.insert(systemSupplier).values({ id: 8, adminId: 8, supplierName: 'Local second supplier' });
    await f.db.update(storeProduct).set({ relationId: 8 }).where(eq(storeProduct.id, 71));
    await f.withRuntime(async r => {
      const created = await r.checkout();
      const [root] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'LOCAL-ONLY' })
        .where(eq(storeOrder.orderId, created.orderId)).returning();
      const allocate = () => withTx(r.container, async tx => {
        const result = await allocatePaidOrderBySupplier(tx, root.id, root.orderId, 100);
        for (const child of result.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
        return result;
      });
      const result = await allocate(); expect(result.fulfillmentOrders).toHaveLength(2);
      const first = result.fulfillmentOrders.find(row => row.supplierId === 7)!;
      const second = result.fulfillmentOrders.find(row => row.supplierId === 8)!;
      expect(await savings(r, first.id)).toBe(200n); expect(await savings(r, second.id)).toBe(0n);
      expect(cents(first.payPrice) + cents(second.payPrice)).toBe(cents(root.payPrice));
      await f.db.update(storeProductAttrValue).set({ price: '99.00', vipPrice: '0.01' }).where(eq(storeProductAttrValue.id, 1));
      await f.db.update(systemConfig).set({ value: '0' }).where(and(eq(systemConfig.isStore, 0),
        inArray(systemConfig.menuName, ['member_card_status', 'svip_price_status'])));
      const before = await f.state();
      const replay = await allocate();
      expect(replay.fulfillmentOrders.map(row => row.id).sort()).toEqual(result.fulfillmentOrders.map(row => row.id).sort());
      expect(await f.state()).toEqual(before);
      await verifyReaders(r, first.id, '2.00'); await verifyReaders(r, second.id, '0.00', 8);
    });
  }, 60_000);
});
