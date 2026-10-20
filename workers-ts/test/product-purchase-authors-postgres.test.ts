/** Real specialized authors on owned native PostgreSQL16. This complements the
 * normal type0 suite; it does not certify complete lifetime history, production
 * authentication/grants, a payment provider or all-author deadlock freedom. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { storeIntegral, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeProduct, storeProductAttrValue, user, userBill } from '../src/models/schema';
import { ApiException } from '../src/utils/errors';
import { applyOrderRefundWithMaterialization, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { integralPurchaseLimitsFixture } from './helpers/integralPurchaseLimitsFixture';
import { productPurchaseGiftFixture, productPurchasePackageFixture,
  type AuthorsReceipt } from './helpers/productPurchaseAuthorsFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const perOrder = (limitNum: number) => ({ isLimit: 1, limitType: 1, limitNum });
async function businessRejection(work: Promise<unknown>, message?: RegExp) {
  const result = await outcome(work);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(ApiException);
    if (message) expect((result.error as Error).message).toMatch(message);
  }
}
async function successfulReceipt(work: Promise<{ status: number; msg: string; data: AuthorsReceipt | null }>) {
  const result = await work;
  expect(result.status, result.msg).toBe(200);
  if (!result.data) throw Error('Actual specialized-author confirmation did not return a receipt');
  return result.data;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('base-product limits on direct integral, package and physical gift authors', () => {
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Specialized purchase tests forbid external I/O')); });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  describe('independent ActivityService.exchange with real Admin-cloned integral activity', () => {
    let f: Awaited<ReturnType<typeof integralPurchaseLimitsFixture>>;
    beforeEach(async () => { f = await integralPurchaseLimitsFixture(); }, 45_000);
    afterEach(async () => { await f?.close(); }, 30_000);

    it('checks the base finite cap even when the cloned activity is explicitly unlimited, allowing the exact boundary', async () => {
      expect(f.originalBatchCaps).toEqual({ onceNum: 0, num: 0 });
      expect((await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, f.integralId)))[0])
        .toMatchObject({ onceNum: -1, num: -1 });
      await f.db.update(storeProduct).set(perOrder(2)).where(eq(storeProduct.id, 70));
      const before = await f.state();
      await businessRejection(f.run(await f.prepare('direct', 3)), /限购|单次/);
      expect(await f.state()).toEqual(before);
      const created = await f.run(await f.prepare('direct', 2));
      expect(await f.db.select().from(storeOrder)).toMatchObject([
        { orderId: created.orderId, paid: 1, type: 4, totalNum: 2 },
      ]);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].stock).toBe(18);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 81)))[0].stock).toBe(10);
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(80);
      expect(await f.db.execute(sql`SELECT total_num FROM public.store_order_purchase_origin`))
        .toMatchObject([{ total_num: 2 }]);
    }, 30_000);

    it('rejects base cumulative mode without consuming points, activity quota, inventory, origin or a paid order', async () => {
      await f.db.update(storeProduct).set({ isLimit: 1, limitType: 2, limitNum: 100 }).where(eq(storeProduct.id, 70));
      const before = await f.state();
      await businessRejection(f.run(await f.prepare('direct')), /累计限购/);
      expect(await f.state()).toEqual(before);
    }, 30_000);

    it('rejects a changed but still sufficient base cap after the actual shared integral admission wait', async () => {
      await f.db.update(storeProduct).set(perOrder(2)).where(eq(storeProduct.id, 70));
      const intent = await f.prepare('direct');
      await withFinancePeers(f.db, async ([buyer, editor, holder]) => {
        await holder.exec('BEGIN'); let open = true;
        await holder.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cinashop:integral-order:11:${f.integralId}`},0::bigint))`);
        try {
          const buying = outcome(f.run(intent, buyer.db));
          await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
          await editor.db.update(storeProduct).set({ limitNum: 3 }).where(eq(storeProduct.id, 70));
          const afterEdit = await f.state();
          await holder.exec('COMMIT'); open = false;
          const result = await buying;
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toBeInstanceOf(ApiException);
          expect(await f.state()).toEqual(afterEdit);
        } finally { if (open) await holder.exec('ROLLBACK'); }
      });
    }, 30_000);
  });

  describe('real fixed package selection and unified order creation', () => {
    let f: Awaited<ReturnType<typeof productPurchasePackageFixture>>;
    beforeEach(async () => { f = await productPurchasePackageFixture(); }, 45_000);
    afterEach(async () => { await f?.close(); }, 30_000);

    it('admits the legal two-product package at each base cap1, consuming only one unit of each base inventory', async () => {
      await f.limits(70, perOrder(1)); await f.limits(71, perOrder(1));
      const selected = await f.prepare(); expect(selected.cartIds).toHaveLength(2);
      const confirmation = await successfulReceipt(f.confirm(selected.cartIds));
      expect(confirmation.priceGroup.pay_price).toBe('16.00');
      const created = await f.create(selected.cartIds, { receipt: confirmation });
      expect(await f.db.select().from(storeOrder)).toMatchObject([
        { orderId: created.orderId, type: 5, totalNum: 2, paid: 0, payPrice: '16.00' },
      ]);
      expect(await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.productId))
        .toMatchObject([{ productId: 70, cartNum: 1 }, { productId: 71, cartNum: 1 }]);
      const products = await f.db.select().from(storeProduct).orderBy(storeProduct.id);
      expect(products.map(product => product.stock)).toEqual([7, 7]);
      const skus = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id);
      expect(skus.map(sku => sku.stock)).toEqual([7, 7, 8, 8]);
      expect(await f.db.execute(sql`SELECT total_num FROM public.store_order_purchase_origin`))
        .toMatchObject([{ total_num: 2 }]);
    }, 30_000);

    it('rejects cumulative base mode before replacing package carts and also rejects already prepared package rows at creation', async () => {
      const selected = await f.prepare();
      await f.limits(70, { isLimit: 1, limitType: 2, limitNum: 100 });
      const before = await f.state();
      await businessRejection(f.prepare(), /累计限购/);
      expect(await f.state()).toEqual(before);
      expect((await f.confirm(selected.cartIds)).status).not.toBe(200);
      await businessRejection(f.create(selected.cartIds), /累计限购/);
      expect(await f.state()).toEqual(before);
    }, 30_000);

    it('rolls back a quoted package when a base cap changes after preparation, even if its single unit still fits', async () => {
      await f.limits(70, perOrder(1));
      const selected = await f.prepare(), confirmation = await successfulReceipt(f.confirm(selected.cartIds));
      let afterEdit: Awaited<ReturnType<typeof f.state>> | undefined;
      await businessRejection(f.create(selected.cartIds, { receipt: confirmation, nextOrderId: async () => {
        await f.limits(70, { limitNum: 2 }); afterEdit = await f.state();
      } }));
      expect(afterEdit).toBeDefined(); expect(await f.state()).toEqual(afterEdit);
    }, 30_000);
  });

  describe('actual Admin-created full-gift promises, physical rows and completion', () => {
    let f: Awaited<ReturnType<typeof productPurchaseGiftFixture>>;
    beforeEach(async () => { f = await productPurchaseGiftFixture(); }, 45_000);
    afterEach(async () => { await f?.close(); }, 30_000);

    it('allows a promised physical gift at its exact cap and keeps charged lines distinct from gift/origin units', async () => {
      await f.limits(70, perOrder(2)); await f.limits(71, perOrder(2));
      const before = await f.state(), confirmation = await successfulReceipt(f.confirm());
      expect(confirmation.cartInfo).toMatchObject([
        { productId: 70, cartNum: 2 }, { productId: 71, cartNum: 2, isGift: 1 },
      ]);
      expect(confirmation.priceGroup.pay_price).toBe('20.00'); expect(await f.state()).toEqual(before);
      await f.create([1], { receipt: confirmation });
      expect(await f.db.select().from(storeOrder)).toMatchObject([{ totalNum: 4, payPrice: '20.00', paid: 0 }]);
      expect(await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id))
        .toMatchObject([{ productId: 70, cartNum: 2, isGift: 0 }, { productId: 71, cartNum: 2, isGift: 1 }]);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 71)))[0].stock).toBe(18);
      expect(await f.db.execute(sql`SELECT total_num,jsonb_array_length(lines) AS lines FROM public.store_order_purchase_origin`))
        .toMatchObject([{ total_num: 2, lines: 1 }]);
    }, 30_000);

    it('rejects a gift above its own finite cap without silently dropping it or claiming any checkout/refund resource', async () => {
      await f.limits(71, perOrder(1)); const before = await f.state();
      await businessRejection(f.quote(), /限购|单次/);
      expect((await f.confirm()).status).not.toBe(200);
      await businessRejection(f.create(), /限购|单次/);
      expect(await f.state()).toEqual(before);
    }, 30_000);

    it('aggregates a shared gift product across two legal campaigns selected by different charged products', async () => {
      const second = await f.secondCampaign(), ids = [1, second.cartId];
      // Each charged line matches one real root. The same line cannot be used
      // to fabricate overlapping first-match campaign entitlements.
      expect(second.rootId).not.toBe(f.rootId);
      await f.limits(71, perOrder(3)); const before = await f.state();
      await businessRejection(f.quote(ids), /限购|单次/);
      expect((await f.confirm(ids)).status).not.toBe(200);
      await businessRejection(f.create(ids), /限购|单次/);
      expect(await f.state()).toEqual(before);
      await f.limits(71, { limitNum: 4 });
      const confirmation = await successfulReceipt(f.confirm(ids));
      const promised = confirmation.cartInfo.filter(row => row.isGift === 1);
      expect(promised).toHaveLength(2);
      expect(promised.reduce((sum, row) => sum + Number(row.cartNum), 0)).toBe(4);
      await f.create(ids, { receipt: confirmation });
      expect(await f.db.select().from(storeOrder)).toMatchObject([{ totalNum: 8, payPrice: '40.00' }]);
      const gifts = (await f.db.select().from(storeOrderCartInfo)).filter(row => row.isGift === 1);
      expect(gifts).toHaveLength(2); expect(gifts.reduce((sum, row) => sum + row.cartNum, 0)).toBe(4);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 71)))[0].stock).toBe(16);
      expect(await f.db.execute(sql`SELECT total_num,jsonb_array_length(lines) AS lines FROM public.store_order_purchase_origin`))
        .toMatchObject([{ total_num: 4, lines: 2 }]);
    }, 30_000);

    it('rejects unproven cumulative gift rules without silently omitting the promised gift or altering refund state', async () => {
      await f.limits(71, { isLimit: 1, limitType: 2, limitNum: 100 });
      const before = await f.state();
      await businessRejection(f.quote(), /累计限购/);
      expect((await f.confirm()).status).not.toBe(200);
      await businessRejection(f.create(), /累计限购/);
      expect(await f.state()).toEqual(before);
      expect(await f.db.select().from(storeOrderRefund)).toEqual([]);
    }, 30_000);

    it('reconfirms gift rule edits after a real gift-product lock wait without retaining purchased or gift reservations', async () => {
      await f.limits(71, perOrder(2)); const confirmation = await successfulReceipt(f.confirm());
      await withFinancePeers(f.db, async ([editor, buyer]) => {
        let open = false;
        const buying = outcome(f.create([1], { db: buyer.db, receipt: confirmation, nextOrderId: async () => {
          await editor.exec('BEGIN'); open = true; await f.limits(71, { limitNum: 3 }, editor.db);
        } }));
        try {
          await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
          const afterEdit = await f.state(editor.db);
          await editor.exec('COMMIT'); open = false;
          const result = await buying;
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toBeInstanceOf(ApiException);
          expect(await f.state()).toEqual(afterEdit);
        } finally { if (open) await editor.exec('ROLLBACK'); }
      });
    }, 30_000);

    it('still completes and replays the real whole-gift quantity refund after purchase rules become cumulative', async () => {
      await f.limits(71, perOrder(2));
      const paid = await f.paid();
      const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, paid.id));
      expect(lines).toHaveLength(2);
      await f.limits(71, { isLimit: 1, limitType: 2, limitNum: 1 });
      const applied = await applyOrderRefundWithMaterialization(f.container, { uid: 11,
        orderId: paid.orderId, applyType: 1, applicationOrderId: 'product_gift_refund_1',
        refundReason: 'Owned gift purchase policy regression', refundExplain: '',
        cartSelections: lines.map(line => ({ cartId: Number(line.cartId), cartNum: line.cartNum })) });
      expect(await finalizeStoreOrderRefund(f.container, applied.refundId)).toBe('completed');
      expect((await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, applied.refundId)))[0].refundType).toBe(6);
      expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, paid.id)))[0].refundStatus).toBe(2);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 71)))[0].stock).toBe(20);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 71)))[0].stock).toBe(20);
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(100);
      expect((await f.db.select().from(userBill)).filter(row => row.eventKey === 'order_promotions_integral_refund'))
        .toMatchObject([{ number: '6.00', pm: 0, linkId: String(paid.id) }]);
      const completed = await f.state();
      expect(await finalizeStoreOrderRefund(f.container, applied.refundId)).toBe('already-completed');
      expect(await f.state()).toEqual(completed);
    }, 30_000);
  });
});
