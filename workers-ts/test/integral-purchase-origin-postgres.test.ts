/** Native service transactions on an owned public PG16 column fixture. Real
 * Admin clone -> direct pure-points exchange -> refund. No HTTP/JWT, production
 * runtime grants, provider settlement, delivery, or complete-history claim. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeCart, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderRefundSplit, storeProduct,
  storeProductAttrValue, user, userBill } from '../src/models/schema';
import { applyOrderRefund, applyOrderRefundWithMaterialization, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { integralPurchaseOriginFixture } from './helpers/integralPurchaseOriginFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof integralPurchaseOriginFixture>>;
const messages = (error: unknown): string => {
  const values: string[] = [];
  for (let current = error, n = 0; current && n < 8; n++) {
    values.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return values.join('\n');
};

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('modern direct integral exchange purchase origins on PostgreSQL16', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden in integral origin fixture'));
    f = await integralPurchaseOriginFixture();
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  it.each([1, 2] as const)('captures type-%s at the unpaid boundary, then commits one paid order with distinct redemption/deduction points and replay-safe evidence', async productType => {
    const selected = await f.modern(productType), cartsBefore = await f.db.select().from(storeCart);
    const requestKey = crypto.randomUUID();
    const result = await f.activityFor().exchange(11, selected.integralId, 2, selected.activitySku.unique, requestKey);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.orderId));
    const [line] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    const cartId = String(line.id);
    expect(line.id).toBeGreaterThan(0);
    expect(order).toMatchObject({ uid: 11, pid: 0, type: 4, productType, activityId: selected.integralId,
      cartId, totalNum: 2, paid: 1, status: 0, payType: 'integral', payIntegral: 20, useIntegral: '0.00', payPrice: '0.00' });
    expect(line).toMatchObject({ cartId, productId: 70, skuUnique: selected.baseSku.unique,
      cartNum: 2, surplusNum: 2, splitSurplusNum: 2, refundNum: 0, oldCartId: '' });
    expect(JSON.parse(line.cartInfo!)).toMatchObject({ financial_version: 'checkout-line-finance-v1',
      id: cartId, cart_num: 2, integral: 10, use_integral: '0',
      product: { id: 70, activityId: selected.integralId }, sku: { id: selected.baseSku.id, unique: selected.baseSku.unique },
      activitySku: { id: selected.activitySku.id, unique: selected.activitySku.unique, integral: 10 } });
    expect(await f.origin(order.id)).toEqual({ version: 'purchase-origin-v1', orderId: order.id,
      buyerId: 11, orderType: 4, totalNum: 2, usedPoints: 0, lines: [{ rowId: line.id, cartId,
        productId: 70, skuId: selected.baseSku.id, skuUnique: selected.baseSku.unique, quantity: 2, usedPoints: 0 }] });
    expect(await f.origins()).toHaveLength(1);
    expect(await f.observations()).toEqual([{ order_id: order.id, captured_paid: 0, root_cart_id: cartId,
      detail_id: line.id, detail_cart_id: cartId, snapshot_id: cartId, pay_integral: 20, use_integral: '0.00' }]);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 80, nowMoney: '100.00' });
    expect(await f.db.select().from(userBill)).toMatchObject([{ uid: 11, category: 'integral',
      type: 'storeIntegral_use_integral', pm: 0, number: '20.00', balance: '80.00', linkId: String(order.id) }]);
    expect(await f.db.select().from(storeOrderOutbox)).toMatchObject([{ aggregateId: order.id, eventType: 'order.paid', status: 'PENDING' }]);
    // Direct exchange uses a real detail selector, never a fabricated store_cart
    // claim, even when an unrelated existing cart has that same numeric id.
    expect(await f.db.select().from(storeCart)).toEqual(cartsBefore);
    const committed = await f.state();
    expect(await f.history()).toMatchObject({ status: 'verified_retained_roots', incomplete: true,
      reason: 'preactivation_history_unproven', verifiedRootCount: 1,
      products: [{ productId: 70, paidPurchased: 2, completedRefund: 0, pendingRefund: 0 }] });
    expect(await f.state()).toEqual(committed);
    // Removing protocol availability cannot turn an idempotent replay into a
    // backfill. Restore the owned relation name before reading whole state.
    await f.exec('ALTER TABLE public.store_order_purchase_origin RENAME TO fixture_origin_temporarily_unavailable');
    try {
      expect(await f.activityFor().exchange(11, selected.integralId, 2, selected.activitySku.unique, requestKey)).toEqual(result);
      expect(await f.activityFor().exchange(11, selected.integralId, 2, selected.baseSku.unique, requestKey)).toEqual(result);
    } finally { await f.exec('ALTER TABLE public.fixture_origin_temporarily_unavailable RENAME TO store_order_purchase_origin'); }
    expect(await f.state()).toEqual(committed);
    await expect(f.origin(order.id, 22)).rejects.toThrow('原始购买数量');
    expect(await f.state()).toEqual(committed);
  }, 30_000);

  it.each([1, 2] as const)('rolls back type-%s points, both stock layers, order, origin and outbox after a proven post-capture failure', async productType => {
    const selected = await f.modern(productType), before = await f.state();
    // This failure is later than origin capture, paid transition, status and
    // outbox insertion in the real exchange transaction. Its precise PG error
    // proves those actual writes were visible together before rollback.
    await f.exec(`CREATE FUNCTION public.fixture_integral_origin_late_failure() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        IF NEW.type='storeIntegral_use_integral' THEN
          IF EXISTS(SELECT 1 FROM public.store_order o
            JOIN public.store_order_purchase_origin p ON p.order_id=o.id
            JOIN public.fixture_integral_origin_observation v ON v.order_id=o.id
            JOIN public.store_order_outbox b ON b.aggregate_id=o.id
            JOIN public.store_order_status s ON s.oid=o.id
            WHERE o.id::text=NEW.link_id AND o.paid=1 AND v.captured_paid=0
              AND p.total_num=2 AND p.used_points=0 AND o.pay_integral=20 AND o.use_integral=0)
          THEN RAISE EXCEPTION 'owned integral late failure after origin paid status outbox';
          ELSE RAISE EXCEPTION 'owned integral failure missing expected prior writes'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_integral_origin_late_failure BEFORE INSERT ON public.user_bill
        FOR EACH ROW EXECUTE FUNCTION public.fixture_integral_origin_late_failure()`);
    const attempted = await outcome(f.activityFor().exchange(11, selected.integralId, 2, selected.activitySku.unique, crypto.randomUUID()));
    expect(attempted.ok).toBe(false);
    if (!attempted.ok) expect(messages(attempted.error)).toContain('owned integral late failure after origin paid status outbox');
    // Serial sequence gaps are not transactional and are deliberately not
    // included in this rollback assertion; every business row must roll back.
    expect(await f.state()).toEqual(before);
    await f.exec('DROP TRIGGER fixture_integral_origin_late_failure ON public.user_bill; DROP FUNCTION public.fixture_integral_origin_late_failure()');
    expect(await f.origins()).toEqual([]);
  }, 30_000);

  it('fails a new modern exchange atomically when the origin protocol is unavailable', async () => {
    const selected = await f.modern(1), before = await f.state();
    await f.exec('ALTER TABLE public.store_order_purchase_origin RENAME TO fixture_origin_temporarily_unavailable');
    try {
      const attempted = await outcome(f.activityFor().exchange(11, selected.integralId, 2, selected.activitySku.unique, crypto.randomUUID()));
      expect(attempted.ok).toBe(false);
      if (!attempted.ok) expect(messages(attempted.error)).toContain('store_order_purchase_origin');
    } finally { await f.exec('ALTER TABLE public.fixture_origin_temporarily_unavailable RENAME TO store_order_purchase_origin'); }
    expect(await f.state()).toEqual(before);
  }, 30_000);

  it.each([1, 2] as const)('keeps the type-%s origin immutable through the existing bare points refund while history rejects missing completed provenance', async productType => {
    const selected = await f.modern(productType), before = await f.snapshot();
    const result = await f.activityFor().exchange(11, selected.integralId, 2, selected.activitySku.unique, crypto.randomUUID());
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.orderId));
    const saved = await f.origins(), savedObservation = await f.observations();
    const refund = await applyOrderRefund(f.container, { uid: 11, orderId: order.orderId,
      applyType: 1, refundReason: 'owned integral origin refund', refundExplain: '',
      applicationOrderId: `owned_integral_origin_${productType}` });
    expect(await f.history()).toMatchObject({ incomplete: true, reason: 'preactivation_history_unproven',
      products: [{ productId: 70, paidPurchased: 2, completedRefund: 0, pendingRefund: 2 }] });
    expect(await finalizeStoreOrderRefund(f.container, refund.refundId)).toBe('completed');
    const restored = await f.snapshot();
    expect(restored.products).toEqual(before.products);
    expect(restored.skus).toEqual(before.skus);
    expect(restored.integrals).toEqual(before.integrals);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 100, nowMoney: '100.00' });
    const bills = await f.db.select().from(userBill);
    expect(bills.filter(bill => bill.type === 'order_integral_refund')).toMatchObject([
      { uid: 11, pm: 1, number: '20.00', balance: '100.00', linkId: String(order.id) }]);
    expect(bills.filter(bill => bill.type === 'pay_product_integral_back')).toEqual([]);
    expect(await f.origins()).toEqual(saved);
    expect(await f.observations()).toEqual(savedObservation);
    const refunded = await f.state();
    // The existing bare creator does not select materialization and therefore
    // does not author a completed-refund receipt. Financial success must not
    // make missing provenance count as zero refunds or complete history.
    expect(await f.db.select().from(storeOrderRefundSplit)).toEqual([]);
    await expect(f.history()).rejects.toThrow('累计限购购买与退款归属不一致');
    expect(await finalizeStoreOrderRefund(f.container, refund.refundId)).toBe('already-completed');
    expect(await f.state()).toEqual(refunded);
    // Even the maintenance author cannot rewrite an installed receipt without
    // bypassing its actual guard. No production grant claim is made here.
    for (const command of ['UPDATE public.store_order_purchase_origin SET total_num=3',
      'DELETE FROM public.store_order_purchase_origin', 'TRUNCATE public.store_order_purchase_origin'])
      await expect(f.exec(command)).rejects.toMatchObject({ code: '42501' });
    expect(await f.origins()).toEqual(saved);
  }, 30_000);

  it.each([1, 2] as const)('classifies a type-%s completed refund only after the explicit server-only materialization author saves its real receipt', async productType => {
    const selected = await f.modern(productType);
    const result = await f.activityFor().exchange(11, selected.integralId, 2, selected.activitySku.unique, crypto.randomUUID());
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.orderId));
    const [line] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    const saved = await f.origins();
    // This is the actual internal candidate author, not an HTTP flag and not
    // a claim that ordinary/public v1 applications have been upgraded.
    const refund = await applyOrderRefundWithMaterialization(f.container, { uid: 11, orderId: order.orderId,
      applyType: 1, refundReason: 'owned integral materialized receipt', refundExplain: '',
      applicationOrderId: `owned_integral_materialized_${productType}`,
      cartSelections: [{ cartId: Number(line.cartId), cartNum: 2 }] });
    expect(await f.history()).toMatchObject({ incomplete: true, reason: 'preactivation_history_unproven',
      products: [{ productId: 70, paidPurchased: 2, completedRefund: 0, pendingRefund: 2 }] });
    expect(await finalizeStoreOrderRefund(f.container, refund.refundId)).toBe('completed');
    expect(await f.db.select().from(storeOrderRefundSplit)).toMatchObject([{ refundId: refund.refundId,
      uid: 11, sourceOrderId: order.id, paymentOrderId: order.id, selectedOrderId: order.id,
      remainingOrderId: null, disposition: 'whole' }]);
    const completed = await f.state();
    expect(await f.history()).toMatchObject({ status: 'verified_retained_roots', incomplete: true,
      reason: 'preactivation_history_unproven', verifiedRootCount: 1,
      products: [{ productId: 70, paidPurchased: 2, completedRefund: 2, pendingRefund: 0 }] });
    expect(await f.origins()).toEqual(saved);
    expect(await finalizeStoreOrderRefund(f.container, refund.refundId)).toBe('already-completed');
    expect(await f.state()).toEqual(completed);
  }, 30_000);

  it('preserves legacy paid/no-origin exchange and never certifies it as zero history or backfills a replay', async () => {
    const legacy = await f.legacy(), requestKey = crypto.randomUUID();
    const result = await (async () => {
      await f.exec('ALTER TABLE public.store_order_purchase_origin RENAME TO fixture_origin_temporarily_unavailable');
      try { return await f.activityFor().exchange(11, legacy.integralId, 2, legacy.unique, requestKey); }
      finally { await f.exec('ALTER TABLE public.fixture_origin_temporarily_unavailable RENAME TO store_order_purchase_origin'); }
    })();
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.orderId));
    expect(order).toMatchObject({ type: 4, paid: 1, payIntegral: 14, useIntegral: '0.00', cartId: null });
    expect(await f.origin(order.id)).toBeNull();
    expect(await f.origins()).toEqual([]);
    expect(await f.observations()).toEqual([]);
    expect(await f.history()).toEqual({ version: 'purchase-quota-history-v1', buyerId: 11,
      status: 'incomplete', incomplete: true, reason: 'missing_origin_or_order', products: null });
    const committed = await f.state();
    expect(await f.activityFor().exchange(11, legacy.integralId, 2, legacy.unique, requestKey)).toEqual(result);
    expect(await f.state()).toEqual(committed);
  }, 30_000);

  it('serializes independent same-key exchanges into one debit, order and origin receipt', async () => {
    const selected = await f.modern(2), requestKey = crypto.randomUUID();
    const results = await withFinancePeers(f.db, async ([first, second, blocker]) => {
      expect(first.pid).not.toBe(second.pid);
      await blocker.exec('BEGIN; SELECT uid FROM public.user WHERE uid=11 FOR UPDATE');
      let transactionOpen = true;
      try {
        const one = outcome(f.activityFor(first.db).exchange(11, selected.integralId, 2, selected.activitySku.unique, requestKey));
        await waitForFinanceBlock(f.db, first.pid, blocker.pid);
        const two = outcome(f.activityFor(second.db).exchange(11, selected.integralId, 2, selected.activitySku.unique, requestKey));
        await waitForFinanceBlock(f.db, second.pid, first.pid);
        await blocker.exec('COMMIT');
        transactionOpen = false;
        const attempted = await Promise.all([one, two]);
        return attempted.map(result => { if (!result.ok) throw result.error; return result.value; });
      } finally { if (transactionOpen) await blocker.exec('ROLLBACK'); }
    });
    expect(results[1]).toEqual(results[0]);
    expect(await f.origins()).toHaveLength(1);
    expect(await f.observations()).toHaveLength(1);
    expect(await f.db.select().from(storeOrder)).toHaveLength(1);
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
    expect(await f.db.select().from(userBill)).toMatchObject([{ uid: 11, pm: 0, number: '20.00' }]);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 80 });
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toMatchObject({ stock: 18, sales: 2 });
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, selected.baseSku.id)))[0]).toMatchObject({ stock: 10, sales: 2 });
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, selected.activitySku.id)))[0]).toMatchObject({ stock: 10, quota: 6, sales: 2 });
  }, 30_000);
});
