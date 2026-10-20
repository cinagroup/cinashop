/** Real final gift capture/cancellation/materialized refund on owned PG16.
 * These column-fixture owner writes do not certify production grants or full
 * history coverage. The separate payment-family suite uses restricted LOGIN. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { outcome } from './helpers/financePeers';
import { productPurchaseGiftFixture } from './helpers/productPurchaseAuthorsFixture';
import { cancelStoreOrder } from '@/services/order/StoreOrderCreateService';
import { readPurchaseQuotaHistory } from '@/services/order/PurchaseQuotaHistory';
import { readPurchaseQuotaPaymentLedger } from '@/services/order/PurchaseQuotaPaymentLedger';
import { readPurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';
import { readPurchasePhysicalOriginEvidence, recordPurchasePhysicalOriginEvidence } from '@/services/order/PurchasePhysicalOriginEvidence';
import { applyOrderRefundWithMaterialization, finalizeStoreOrderRefund } from '@/services/order/StoreOrderRefundService';
import { storeCart, storeOrder, storeOrderCartInfo, storePromotionsAuxiliary, storeProduct, storeProductAttrValue } from '@/models/schema';

type Fixture = Awaited<ReturnType<typeof productPurchaseGiftFixture>>;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('final physical purchase origin on PostgreSQL16', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider in physical origin verification'));
    f = await productPurchaseGiftFixture();
  }, 45000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const history = () => f.db.transaction(tx => readPurchaseQuotaHistory(tx, 11),
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
  const ledger = (orderId: number) => f.db.transaction(tx => readPurchaseQuotaPaymentLedger(tx,
    { paymentOrderId: orderId, buyerId: 11 }), { isolationLevel: 'repeatable read', accessMode: 'read only' });
  async function create() {
    const made = await f.create();
    return (await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, made.orderId)))[0];
  }
  async function receipt(orderId: number) {
    return f.db.transaction(async tx => {
      const charged = await readPurchaseOriginEvidence(tx, { orderId, buyerId: 11 });
      if (!charged) throw Error('Actual checkout omitted charged receipt');
      const physical = await readPurchasePhysicalOriginEvidence(tx, charged);
      if (!physical) throw Error('Actual checkout omitted final physical receipt');
      return { charged, physical };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  it('captures final real gift row identities while retaining the original charged/points contract', async () => {
    const order = await create(), saved = await receipt(order.id);
    expect(saved.charged).toMatchObject({ version: 'purchase-origin-v1', totalNum: 2, usedPoints: 0 });
    expect(saved.charged.lines).toHaveLength(1);
    expect(saved.physical).toMatchObject({ version: 'purchase-physical-origin-v1', totalNum: 4 });
    const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(saved.physical.lines.map(line => [line.rowId, line.cartId, line.productId, line.quantity, line.kind]))
      .toEqual(lines.map(line => [line.id, line.cartId, line.productId, line.cartNum, line.isGift ? 'gift' : 'charged']));
    const before = await f.state();
    expect(await history()).toMatchObject({ status: 'verified_retained_roots', incomplete: true,
      reason: 'preactivation_history_unproven', products: [
        { productId: 70, activeUnpaid: 2 }, { productId: 71, activeUnpaid: 2 },
      ] });
    expect(await f.state()).toEqual(before);
    expect(await f.db.transaction(tx => recordPurchasePhysicalOriginEvidence(tx, saved.charged))).toEqual(saved.physical);
    expect(await f.state()).toEqual(before);
  }, 30000);
  it('counts gift quantities across two actual campaigns and retains all charged line identities', async () => {
    const second = await f.secondCampaign(), created = await f.create([1, second.cartId]);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    const { charged, physical } = await receipt(order.id);
    expect(charged.totalNum).toBe(4); expect(physical.totalNum).toBe(8);
    expect(physical.lines.filter(line => line.kind === 'gift')).toHaveLength(2);
    expect((await history()).products).toMatchObject([
      { productId: 70, activeUnpaid: 2 }, { productId: 71, activeUnpaid: 4 }, { productId: 72, activeUnpaid: 2 },
    ]);
  }, 30000);
  it('aggregates a purchased and a gifted SKU of the same base product in the actual history', async () => {
    // A distinct ordinary-sale SKU and a gift SKU share the same base product.
    await f.db.update(storeProduct).set({ price: '5.00', freight: 1 }).where(eq(storeProduct.id, 71));
    await f.db.insert(storeProductAttrValue).values({ id: 73, productId: 71, type: 0,
      unique: 'paid0071', suk: '普通出售', stock: 12, price: '5.00' });
    const [cart] = await f.db.insert(storeCart).values({ uid: 11, productId: 71,
      productAttrUnique: 'paid0071', cartNum: 1, isNew: 1, status: 1 }).returning();
    const made = await f.create([1, cart.id]);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, made.orderId));
    expect((await receipt(order.id)).physical.totalNum).toBe(5);
    expect((await history()).products).toMatchObject([
      { productId: 70, activeUnpaid: 2 }, { productId: 71, activeUnpaid: 3 },
    ]);
  }, 30000);
  it('cancels the whole unpaid physical purchase once while preserving charged point compensation', async () => {
    const order = await create(), original = await receipt(order.id);
    await cancelStoreOrder(f.container, { uid: 11, orderId: order.orderId });
    expect((await history()).products).toMatchObject([
      { productId: 70, activeUnpaid: 0, cancelledUnpaid: 2 }, { productId: 71, activeUnpaid: 0, cancelledUnpaid: 2 },
    ]);
    expect(await receipt(order.id)).toEqual(original);
    const [cancelled] = await f.db.execute(sql`SELECT total_num,restored_points FROM store_order_purchase_cancellation WHERE order_id=${order.id}`);
    expect(cancelled.total_num).toBe(2); expect(Number(cancelled.restored_points)).toBe(0);
    const before = await f.state();
    await expect(cancelStoreOrder(f.container, { uid: 11, orderId: order.orderId })).rejects.toThrow();
    expect(await f.state()).toEqual(before);
  }, 30000);
  it('keeps pending gift refunds occupied and releases every physical unit only on protected completion and replay', async () => {
    const order = await f.paid(), original = await receipt(order.id), before = await f.state();
    expect((await ledger(order.id)).products).toEqual([
      { productId: 70, purchased: 2, refunded: 0, pending: 0, remaining: 2 },
      { productId: 71, purchased: 2, refunded: 0, pending: 0, remaining: 2 },
    ]);
    expect(await f.state()).toEqual(before);
    const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    const applied = await applyOrderRefundWithMaterialization(f.container, { uid: 11, orderId: order.orderId,
      applyType: 1, applicationOrderId: 'physical_origin_refund_1', refundReason: 'Owned physical origin regression',
      refundExplain: '', cartSelections: lines.map(line => ({ cartId: Number(line.cartId), cartNum: line.cartNum })) });
    expect((await ledger(order.id)).products.map(line => [line.purchased, line.refunded, line.pending, line.remaining]))
      .toEqual([[2, 0, 2, 2], [2, 0, 2, 2]]);
    expect((await history()).products).toMatchObject([
      { productId: 70, paidPurchased: 2, completedRefund: 0, pendingRefund: 2 },
      { productId: 71, paidPurchased: 2, completedRefund: 0, pendingRefund: 2 },
    ]);
    expect(await finalizeStoreOrderRefund(f.container, applied.refundId)).toBe('completed');
    expect((await ledger(order.id)).products.map(line => [line.purchased, line.refunded, line.pending, line.remaining]))
      .toEqual([[2, 2, 0, 0], [2, 2, 0, 0]]);
    expect((await history()).products).toMatchObject([
      { productId: 70, paidPurchased: 2, completedRefund: 2, pendingRefund: 0 },
      { productId: 71, paidPurchased: 2, completedRefund: 2, pendingRefund: 0 },
    ]);
    const completed = await f.state();
    expect(await finalizeStoreOrderRefund(f.container, applied.refundId)).toBe('already-completed');
    expect(await f.state()).toEqual(completed); expect(await receipt(order.id)).toEqual(original);
  }, 30000);
  it('rejects coherent live gift quantity/SKU/kind/marker rewrites against the protected anchor', async () => {
    const order = await create(), before = await f.state();
    for (const edit of [
      sql`UPDATE store_order_cart_info SET cart_num=3,cart_info=jsonb_set(cart_info::jsonb,'{cart_num}','3')::text WHERE oid=${order.id} AND is_gift=1`,
      sql`UPDATE store_order_cart_info SET sku_unique='newgift' WHERE oid=${order.id} AND is_gift=1`,
      sql`UPDATE store_order_cart_info SET is_gift=0 WHERE oid=${order.id} AND is_gift=1`,
      sql`UPDATE store_order_cart_info SET cart_info=jsonb_set(cart_info::jsonb,'{promotion_gift,aux_id}','999')::text WHERE oid=${order.id} AND is_gift=1`,
    ]) {
      await expect(f.db.transaction(async tx => { await tx.execute(edit); await readPurchaseQuotaHistory(tx, 11); },
        { isolationLevel: 'repeatable read' })).rejects.toThrow();
      expect(await f.state()).toEqual(before);
    }
  }, 30000);
  it('rejects a coherent cancellation rewrite even when the live gift intent, quantities and pool all agree', async () => {
    const order = await create(), before = await f.state();
    const result = await outcome(f.db.transaction(async tx => {
      const [gift] = (await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)))
        .filter(line => line.isGift === 1);
      const info = JSON.parse(gift.cartInfo!), intent = JSON.parse(order.promotionsGive!);
      const product = intent.promotions.flatMap((campaign: any) => campaign.products)
        .find((product: any) => product.cart_id === gift.cartId);
      product.quantity = 3; info.cart_num = 3;
      await tx.update(storeOrder).set({ totalNum: 5, promotionsGive: JSON.stringify(intent) }).where(eq(storeOrder.id, order.id));
      await tx.update(storeOrderCartInfo).set({ cartNum: 3, surplusNum: 3, splitSurplusNum: 3,
        writeTimes: 3, writeSurplusTimes: 3, cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, gift.id));
      // An explicit malicious-fixture consistency edit prevents the old pool
      // ceiling from masking whether the NEW immutable quantity guard fires.
      await tx.update(storePromotionsAuxiliary).set({ surplusNum: 7 }).where(eq(storePromotionsAuxiliary.id, product.aux_id));
      await cancelStoreOrder(createContainerFromDb(tx as unknown as DbClient), { uid: 11, orderId: order.orderId });
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const messages: string[] = []; let error: any = result.error;
      for (let i = 0; error && i < 5; i++, error = error.cause) messages.push(String(error.message));
      expect(messages.join(' / ')).toContain('Cancellation differs from protected physical origin');
    }
    expect(await f.state()).toEqual(before);
  }, 30000);
  it('rejects modifying, deleting or truncating the append-only physical receipt', async () => {
    const order = await create(), before = await f.state();
    for (const edit of [sql`UPDATE store_order_purchase_physical_origin SET total_num=total_num+1 WHERE order_id=${order.id}`,
      sql`DELETE FROM store_order_purchase_physical_origin WHERE order_id=${order.id}`,
      sql`TRUNCATE public.store_order_purchase_physical_origin`]) {
      await expect(f.db.transaction(tx => tx.execute(edit))).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await f.state()).toEqual(before);
    }
  }, 30000);
});
