import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { supplierRecycleSchema, seedSupplierRecycle, supplierRecycleActor } from './helpers/supplierProductRecycle';
import { PRODUCT_SKU_RETIREMENT_SQL } from '@/migrations/productSkuRetirement';
import { installProductRecycleSkuGuard } from '@/migrations/productRecycleSkuGuard';
import { recordSupplierPayment } from '@/services/supplier/SupplierFinanceService';
import { SupplierProductRecycleService } from '@/services/supplier/SupplierProductRecycleService';
import { StoreOrderCreateService, cancelStoreOrder, type CreateOrderParams } from '@/services/order/StoreOrderCreateService';
import { applyOrderRefund, finalizeStoreOrderRefund } from '@/services/order/StoreOrderRefundService';
import { storeOrder, storeOrderCartInfo, storeOrderStatus, storeOrderRefund, storeOrderRefundPayment,
  storeOrderInvoice, storeOrderOutbox, printDocument, userBrokerage, storeProduct, storeProductAttrValue,
  storeCart, systemStore, userBill, supplierFlowingWater, supplierTransactions } from '@/models/schema';

const native = process.env.TEST_FINANCE_POSTGRES_URL ? describe : describe.skip;
native('Supplier permanent deletion with actual checkout refund and cancellation on owned PG16', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  const orderId = 'owned_recycle_compensation';
  beforeEach(async () => {
    f = await createBargainSelectionFixture([...Object.values(supplierRecycleSchema), storeOrderCartInfo, storeOrderStatus,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, storeOrderOutbox, printDocument, userBrokerage,
      supplierFlowingWater, supplierTransactions]);
    await f.exec(PRODUCT_SKU_RETIREMENT_SQL);
    await f.db.transaction(tx => installProductRecycleSkuGuard(tx));
    await seedSupplierRecycle(f.db);
    await f.exec('CREATE UNIQUE INDEX owned_flow_order ON supplier_flowing_water(order_id); CREATE UNIQUE INDEX owned_transaction_order ON supplier_transactions(order_id)');
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.update(storeProduct).set({ type: 2, relationId: 20 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ settlePrice: '5.00' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeProductAttrValue).set({ settlePrice: '1.00' }).where(eq(storeProductAttrValue.id, 3));
    await f.db.insert(storeCart).values({ id: 10, uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 2,
      isNew: 1, status: 1 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  async function create(type: 0 | 2 = 0) {
    if (type === 2) await f.db.update(storeCart).set({ type: 2, activityId: 40 }).where(eq(storeCart.id, 10));
    const params: CreateOrderParams = { uid: 11, key: 'owned_recycle_checkout', cartIds: [10], type,
      ...(type === 2 ? { bargainUserId: 80 } : {}), shippingType: 2, storeId: 1,
      realName: '隔离补偿样本', userPhone: '00000000000', userIp: '127.0.0.1' };
    await StoreOrderCreateService.createWithRuntime(f.container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => orderId }, params);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, orderId));
    expect(order).toMatchObject({ supplierId: 20, paid: 0, status: 0 });
    return order!;
  }
  async function remove() {
    const service = new SupplierProductRecycleService(f.container);
    await service.change(70, supplierRecycleActor(), { expectedIsDel: 0 });
    expect(await service.thorough(70, supplierRecycleActor(), { expectedIsDel: 1 })).toEqual({ id: 70, operation: 'delete' });
  }
  const cancel = () => cancelStoreOrder(f.container, { uid: 11, orderId });
  const snapshot = async () => ({ ...await f.snapshot(), sequences: undefined,
    orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
    details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
    refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
    statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
    bills: await f.db.select().from(userBill).orderBy(userBill.id),
    supplierFlows: await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id),
    supplierTransactions: await f.db.select().from(supplierTransactions).orderBy(supplierTransactions.id) });
  async function paid(type: 0 | 2 = 0) {
    const order = await create(type);
    const [receipt] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue' }).where(eq(storeOrder.id, order.id)).returning();
    await f.db.transaction(tx => recordSupplierPayment(tx, receipt!));
    return receipt!;
  }
  async function apply(num = 2) {
    return applyOrderRefund(f.container, { uid: 11, orderId, applyType: 1, refundReason: 'Owned deletion refund',
      refundExplain: '', cartSelections: [{ cartId: 10, cartNum: num }] });
  }
  async function absent() {
    expect(await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70))).toEqual([]);
    expect((await f.db.select().from(storeProductAttrValue)).filter(s => s.productId === 70 && s.type === 0)).toEqual([]);
  }
  it.each([0, 2] as const)('cancels a genuine unpaid type %i order without recreating removed base inventory', async type => {
    await create(type); await remove(); await absent();
    await cancel(); await absent(); const state = await snapshot();
    expect(state.orders.find(o => o.orderId === orderId)).toMatchObject({ status: -2, isDel: 1 });
    if (type === 2) {
      expect(state.bargains.find(b => b.id === 40)).toMatchObject({ stock: 8, quota: 8, sales: 0 });
      expect(state.skus.find(s => s.id === 3)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
      expect(state.participations.find(p => p.id === 80)?.status).toBe(3);
    }
    await expect(cancel()).rejects.toThrow(); expect(await snapshot()).toEqual(state);
  });
  it.each([0, 2] as const)('refunds distinct real partial type %i quantities and credits balance only once after base deletion', async type => {
    const order = await paid(type); const first = await apply(1); await remove();
    expect(await finalizeStoreOrderRefund(f.container, first.refundId)).toBe('completed');
    const second = await apply(1);
    expect(await finalizeStoreOrderRefund(f.container, second.refundId)).toBe('completed');
    await absent(); const state = await snapshot();
    expect(state.users.find(u => u.uid === 11)?.nowMoney).toBe(order.payPrice);
    expect(state.bills.filter(b => b.type === 'pay_product_refund')).toHaveLength(2);
    expect(state.supplierFlows.filter(flow => flow.type === 2).map(flow => flow.number)).toEqual(type === 2 ? ['1.00', '1.00'] : ['5.00', '5.00']);
    if (type === 2) {
      expect(state.bargains.find(b => b.id === 40)).toMatchObject({ stock: 8, quota: 8, sales: 0 });
      expect(state.skus.find(s => s.id === 3)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
      expect(state.participations.find(p => p.id === 80)?.status).toBe(4);
    }
    expect(await finalizeStoreOrderRefund(f.container, first.refundId)).toBe('already-completed');
    expect(await snapshot()).toEqual(state);
  });
  it('cancels a genuine mixed-Supplier unpaid root after each owner permanently deletes its source', async () => {
    await f.db.update(storeProduct).set({ isDel: 0, isShow: 1, isVerify: 1, stock: 7, price: '3.00' }).where(eq(storeProduct.id, 90));
    await f.db.update(storeProductAttrValue).set({ price: '3.00' }).where(eq(storeProductAttrValue.id, 304));
    await f.db.insert(storeCart).values({ id: 11, uid: 11, productId: 90, productAttrUnique: 'other001', cartNum: 1, isNew: 1, status: 1 });
    await StoreOrderCreateService.createWithRuntime(f.container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => orderId },
      { uid: 11, key: 'owned_mixed_recycle', cartIds: [10, 11], shippingType: 2, storeId: 1,
        realName: '隔离混合样本', userPhone: '00000000000', userIp: '127.0.0.1' });
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, orderId));
    expect(order).toMatchObject({ supplierId: 0, supplierAllocationStatus: 1, totalNum: 3 });
    await remove();
    const service = new SupplierProductRecycleService(f.container);
    await service.change(90, supplierRecycleActor(31), { expectedIsDel: 0 });
    await service.thorough(90, supplierRecycleActor(31), { expectedIsDel: 1 });
    await cancel(); await absent();
    expect(await f.db.select().from(storeProduct).where(eq(storeProduct.id, 90))).toEqual([]);
    expect((await snapshot()).orders.find(o => o.orderId === orderId)).toMatchObject({ status: -2, isDel: 1 });
  });
  it.each(['cancel', 'refund'] as const)('uses the protected unique receipt for an unversioned pre-ID snapshot: %s', async operation => {
    if (operation === 'refund') await paid(); else await create();
    const [line] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.productId, 70));
    // A genuine versionless shape; do not tear a modern financial version and
    // accidentally claim that its anti-downgrade rejection is a regression.
    const value = { product: { id: 70, storeName: 'Original legacy source' }, sku: { unique: 'qared001', suk: '红色,大号', price: '10.00' } };
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(value) }).where(eq(storeOrderCartInfo.id, line!.id));
    if (operation === 'refund') await apply();
    await remove();
    if (operation === 'refund') expect(await finalizeStoreOrderRefund(f.container, 1)).toBe('completed'); else await cancel();
    await absent();
  });
  it.each(['cancel', 'refund'] as const)('refuses a partial recreation despite an earlier deletion receipt: %s', async operation => {
    if (operation === 'refund') { await paid(); await apply(); } else await create();
    await remove();
    await f.db.insert(storeProductAttrValue).values({ id: 1, productId: 70, type: 0, unique: 'qared001', stock: 6 });
    const before = await snapshot();
    await expect(operation === 'refund' ? finalizeStoreOrderRefund(f.container, 1) : cancel()).rejects.toThrow(/库存/);
    expect(await snapshot()).toEqual(before);
  });
  it.each(['cancel', 'refund'] as const)('requires the original snapshot SKU identity: %s', async operation => {
    if (operation === 'refund') { await paid(); await apply(); } else await create();
    const [line] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.productId, 70));
    const value = JSON.parse(line!.cartInfo!); value.sku.id = 2;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(value) }).where(eq(storeOrderCartInfo.id, line!.id));
    await remove(); const before = await snapshot();
    await expect(operation === 'refund' ? finalizeStoreOrderRefund(f.container, 1) : cancel()).rejects.toThrow(/库存/);
    expect(await snapshot()).toEqual(before);
  });
  it.each(['cancel', 'refund'] as const)('retains the original Supplier identity at compensation: %s', async operation => {
    const order = operation === 'refund' ? await paid() : await create();
    if (operation === 'refund') { await apply(); await f.db.update(storeOrderRefund).set({ supplierId: 30 }).where(eq(storeOrderRefund.id, 1)); }
    await f.db.update(storeOrder).set({ supplierId: 30 }).where(eq(storeOrder.id, order.id));
    await remove(); const before = await snapshot();
    await expect(operation === 'refund' ? finalizeStoreOrderRefund(f.container, 1) : cancel()).rejects.toThrow(/库存/);
    expect(await snapshot()).toEqual(before);
  });
  it.each(['cancel', 'refund'] as const)('rolls all money and order changes back if retained activity SKU is corrupt: %s', async operation => {
    if (operation === 'refund') { await paid(2); await apply(); } else await create(2);
    await remove(); await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 3));
    const before = await snapshot();
    await expect(operation === 'refund' ? finalizeStoreOrderRefund(f.container, 1) : cancel()).rejects.toThrow(/库存/);
    expect(await snapshot()).toEqual(before);
  });
  it('requires the immutable line Supplier identity when the unpaid parent has supplierId zero', async () => {
    const order = await create(); await remove();
    await f.db.update(storeOrder).set({ supplierId: 0, supplierAllocationStatus: 1 }).where(eq(storeOrder.id, order.id));
    await f.db.update(storeOrderCartInfo).set({ relationId: 30 }).where(eq(storeOrderCartInfo.oid, order.id));
    const before = await snapshot();
    await expect(cancel()).rejects.toThrow(/库存/);
    expect(await snapshot()).toEqual(before);
  });
  it('does not wait in a reverse inventory lock cycle or commit a cancellation on contention', async () => {
    await create(); await remove();
    let ready!: () => void, release!: () => void;
    const acquired = new Promise<void>(yes => { ready = yes; }), gate = new Promise<void>(yes => { release = yes; });
    const held = f.db.transaction(async tx => { await tx.execute(sql`LOCK TABLE ONLY public.store_product_attr_value IN ROW EXCLUSIVE MODE`); ready(); await gate; });
    try {
      await acquired; const before = await snapshot(), start = Date.now();
      await expect(cancel()).rejects.toMatchObject({ httpStatus: 409 });
      expect(Date.now()-start).toBeLessThan(1500); expect(await snapshot()).toEqual(before);
    } finally { release(); await held; }
    await cancel(); await absent();
  });
  it.each(['cancel', 'refund'] as const)('continues to reject corrupt inventory without a deliberate deletion receipt: %s', async operation => {
    if (operation === 'refund') { await paid(); await apply(); } else await create();
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.productId, 70));
    await f.db.delete(storeProduct).where(eq(storeProduct.id, 70));
    const before = await snapshot();
    await expect(operation === 'refund' ? finalizeStoreOrderRefund(f.container, 1) : cancel()).rejects.toThrow(/库存|SKU|规格/);
    expect(await snapshot()).toEqual(before);
  });
});
