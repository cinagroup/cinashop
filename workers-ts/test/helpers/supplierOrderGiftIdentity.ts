import { eq, inArray } from 'drizzle-orm';
import { storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue } from '@/models/schema';
import { supplierOrderPromotionReviewFixture } from './supplierOrderPromotionReview';

export const supplierGiftIdentitySnapshot = (quantity = 1, modern = true) => modern
  ? { financial_version: 'checkout-line-finance-v1', cart_num: quantity,
    product: { id: 81, storeName: '冻结赠品礼盒' },
    sku: { suk: '赠品规格', price: '0.00', code: 'GIFT-CODE', barCode: 'GIFT-BAR' } }
  : { is_gift: 0, productInfo: { id: 81, store_name: '旧赠品礼盒', attrInfo: { suk: '旧赠品规格', price: '0.00' } } };

/** Synthetic owned display records only. Real Admin type4 author, checkout and
 * physical allocation/splitting are separately exercised by the native test. */
export async function supplierOrderGiftIdentityFixture() {
  const f = await supplierOrderPromotionReviewFixture();
  try {
    await f.db.insert(storeProduct).values({ id: 81, type: 2, relationId: 7, storeName: '当前赠品目录',
      isShow: 1, isVerify: 1, stock: 10, price: '99.00', deliveryType: '1' });
    await f.db.insert(storeProductAttrValue).values({ id: 81, productId: 81, type: 0, unique: 'gift0081',
      suk: '当前赠品规格', stock: 10, price: '99.00', settlePrice: '88.00' });
    await f.db.update(storeOrderCartInfo).set({ isGift: 0, splitStatus: 0, splitSurplusNum: 2, surplusNum: 2, cartId: '1001' })
      .where(eq(storeOrderCartInfo.id, 1001));
    await f.db.update(storeOrderCartInfo).set({ isGift: 0, splitStatus: 0, splitSurplusNum: 1, surplusNum: 1 })
      .where(inArray(storeOrderCartInfo.oid, [201, 202, 301]));
    await f.db.insert(storeOrderCartInfo).values([
      { id: 1002, oid: 100, quantity: 1, modern: true }, { id: 2005, oid: 200, quantity: 2, modern: true },
      { id: 2011, oid: 201, quantity: 1, modern: true }, { id: 2021, oid: 202, quantity: 1, modern: true },
      { id: 3011, oid: 301, quantity: 1, modern: false },
    ].map(({ id, oid, quantity, modern }) => ({ id, oid, uid: 11, type: 2, relationId: 7,
      productId: 81, skuUnique: 'gift0081', cartId: String(id), isGift: 1, cartNum: quantity,
      surplusNum: quantity, splitSurplusNum: quantity, settlePrice: '0.00',
      cartInfo: JSON.stringify(supplierGiftIdentitySnapshot(quantity, modern)) })));
    await f.db.update(storeOrder).set({ totalNum: 3, status: 0, deliveryType: '', deliveryName: '', deliveryCode: '', deliveryId: '' })
      .where(eq(storeOrder.id, 100));
    await f.db.update(storeOrder).set({ totalNum: 4 }).where(eq(storeOrder.id, 200));
    await f.db.update(storeOrder).set({ totalNum: 2 }).where(inArray(storeOrder.id, [201, 202, 301]));
    await f.db.update(storeOrder).set({ status: 0, deliveryType: '', deliveryName: '', deliveryCode: '', deliveryId: '' })
      .where(eq(storeOrder.id, 202));
    const grantGiftReader = async (role: string) => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unowned gift identity reader');
      await f.grantReviewReader(role);
      await f.exec(`GRANT SELECT ON public.store_order_refund,public.express_company TO "${role}"`);
    };
    type Peer = Parameters<Parameters<typeof f.withReader>[0]>[0];
    const withReader = <T>(work: (peer: Peer) => Promise<T>) => f.withReader(async peer => {
      await grantGiftReader(peer.role); return work(peer);
    });
    return { ...f, withReader, grantGiftReader, expectedReview: { ...f.expectedReview, quantity: 3 },
      giftIds: { purchased: 1001, gift: 1002, product: 81, firstGift: 2011, pendingGift: 2021, legacyGift: 3011 },
      expectedGiftItems: [{ id: 1001, is_gift: 0, quantity: 2 }, { id: 1002, is_gift: 1, quantity: 1 }] };
  } catch (error) { await f.close(); throw error; }
}
