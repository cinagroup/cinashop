import { eq } from 'drizzle-orm';
import { storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderPromotions, storePromotions } from '@/models/schema';
import { supplierOrderInvoiceReviewFixture } from './supplierOrderInvoiceReview';
import { supplierReviewLine } from './supplierOrderReview';

export const supplierPromotionLine = (quantity = 2) => {
  const allocations = [{ promotionId: 101, rootId: 101, type: 1, savingsCents: quantity * 200,
    discountQuantity: quantity, labelIds: [], name: '下单九折活动' },
  { promotionId: 102, rootId: 102, type: 2, savingsCents: quantity * 100,
    discountQuantity: quantity, labelIds: [], name: '下单满减活动' }];
  return { ...supplierReviewLine(quantity), promotion_quote_version: 'order-promotion-quote-v1',
    promotion_line_price: (quantity * 27).toFixed(2), promotion_line_savings: (quantity * 3).toFixed(2),
    promotion_line_member_savings: '0.00', promotion_discount_quantity: quantity, promotion_allocations: allocations,
    promotion_segments: [{ quantity, rawGrossCents: quantity * 3000, totalPriceCents: quantity * 2700,
      unitPriceCents: 2700, membershipSavingsCents: 0, promotionIds: [101, 102], promotionAllocations: allocations,
      couponEligibleGrossCents: 0 }], coupon_price: '0.00', integral_price: '0.00', first_order_price: '0.00',
    sum_true_price: (quantity * 27).toFixed(2) };
};
/** Owned synthetic presentation records; actual nonzero checkout and physical
 * splits are independently exercised through the registered native writers. */
export async function supplierOrderPromotionReviewFixture() {
  const f = await supplierOrderInvoiceReviewFixture();
  try {
    await f.db.insert(storePromotions).values([
      { id: 101, type: 1, storeId: 0, pid: 0, promotionsType: 1, name: '当前可变九折名称', title: '当前九折活动标题' },
      { id: 102, type: 1, storeId: 0, pid: 0, promotionsType: 2, name: '当前可变满减名称', title: '当前满减活动标题' },
      { id: 103, type: 1, storeId: 0, pid: 0, promotionsType: 3, name: '当前历史活动名称', title: '历史满额优惠标题', status: 0, stopTime: 1 },
      { id: 104, type: 1, storeId: 0, pid: 0, promotionsType: 1, name: 'PRIVATE-PLATFORM-ROOT-PROMOTION', title: 'PRIVATE-PLATFORM-ROOT-TITLE' },
    ]);
    for (const [orderId, quantity] of [[100, 2], [200, 2], [201, 1]] as const) {
      await f.db.update(storeOrder).set({ promotionsPrice: (quantity * 3).toFixed(2), payPrice: orderId === 201 ? '28.50' : '57.00' }).where(eq(storeOrder.id, orderId));
      await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(supplierPromotionLine(quantity)) }).where(eq(storeOrderCartInfo.oid, orderId));
      await f.db.insert(storeOrderPromotions).values([{ oid: orderId, uid: 11, productId: 70, promotionsId: 101, promotionsPrice: (quantity * 2).toFixed(2) },
        { oid: orderId, uid: 11, productId: 70, promotionsId: 102, promotionsPrice: quantity.toFixed(2) }]);
    }
    for (const [id, amount] of [[501, '57.00'], [502, '57.00'], [503, '28.50']] as const)
      await f.db.update(storeOrderInvoice).set({ invoiceAmount: amount }).where(eq(storeOrderInvoice.id, id));
    await f.db.update(storeOrder).set({ promotionsPrice: '3.00', payPrice: '28.50' }).where(eq(storeOrder.id, 301));
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ productInfo: { id: 70, store_name: '旧分摊商品',
      attrInfo: { suk: '旧规格', price: '30.00' } } }) }).where(eq(storeOrderCartInfo.oid, 301));
    await f.db.insert(storeOrderPromotions).values({ oid: 301, uid: 11, productId: 70, promotionsId: 103, promotionsPrice: '3.00' });
    await f.db.update(storeOrder).set({ promotionsPrice: '2.00' }).where(eq(storeOrder.id, 110));
    await f.db.insert(storeOrderPromotions).values({ oid: 110, uid: 12, productId: 70, promotionsId: 104, promotionsPrice: '2.00' });
    await f.db.update(storeOrder).set({ promotionsPrice: '99.00' }).where(eq(storeOrder.id, 300));
    await f.db.insert(storeOrderPromotions).values({ oid: 300, uid: 11, productId: 70, promotionsId: 104, promotionsPrice: '99.00' });
    return { ...f, expectedReview: { ...f.expectedReview, payPrice: '57.00' },
      expectedInvoice: { ...f.expectedInvoice, recorded_amount: '57.00' },
      promotionIds: { first: 101, second: 102, legacy: 103, platform: 104 },
      expectedPromotions: { order_id: 100, state: 'recorded', reason: '', basis: 'modern', total: '6.00', items: [
        { promotion_id: 101, promotion_type: 1, frozen_name: '下单九折活动', current_title: '当前九折活动标题', amount: '4.00' },
        { promotion_id: 102, promotion_type: 2, frozen_name: '下单满减活动', current_title: '当前满减活动标题', amount: '2.00' },
      ] } };
  } catch (error) { await f.close(); throw error; }
}
