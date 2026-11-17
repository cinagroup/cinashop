import { storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderPromotions, storeOrderRefund } from '../../src/models/schema';
import { kefuOrderMediaFixture } from './kefuOrderMediaFixture';

export const kefuSplitCartMediaIds = {
  order: 7501, foreign: 7502, deleted: 7503, root: 7504, child: 7505,
  otherCustomerChild: 7506, otherSupplierChild: 7507, emptyRoot: 7508,
  ambiguousRoot: 7509, ambiguousA: 7510, ambiguousB: 7511,
  carts: { platform: 8501, supplier: 8502, store: 8503, forged: 8504,
    legacy: 8505, empty: 8506, array: 8507, splitComplete: 8508,
    noSurplus: 8509, negativeSurplus: 8510, foreign: 8511, child: 8512,
    otherCustomerChild: 8513, otherSupplierChild: 8514 },
} as const;

/** Only domain data extends the original real LOGIN/router/PG/R2 fixture.
 * Every preview cart explicitly satisfies (or deliberately fails) the existing
 * fulfillment eligibility predicates. Nothing here replaces authority queries. */
export async function kefuSplitCartMediaFixture() {
  const base = await kefuOrderMediaFixture();
  try {
    const ids = kefuSplitCartMediaIds;
    const order = (id: number, extra: Partial<typeof storeOrder.$inferInsert> = {}): typeof storeOrder.$inferInsert => ({
      id, orderId: `owned-split-preview-${id}`, unique: `owned-split-order-${id}`,
      uid: 201, paid: 1, status: 0, shippingType: 1, refundStatus: 0,
      isDel: 0, isSystemDel: 0, pid: 0, supplierId: 320, totalNum: 7,
      totalPrice: '70.07', payPrice: '61.23', realName: '历史拆单客户',
      userPhone: '13900000201', userAddress: '保留拆单预览地址',
      addTime: 1_700_000_500, ...extra,
    });
    const orders = [
      order(ids.order), order(ids.foreign, { uid: 202 }), order(ids.deleted, { isDel: 1 }),
      order(ids.root, { pid: -1, status: 4 }), order(ids.child, { pid: ids.root }),
      order(ids.otherCustomerChild, { pid: ids.root, uid: 202 }),
      order(ids.otherSupplierChild, { pid: ids.root, supplierId: 310 }),
      order(ids.emptyRoot, { pid: -1, status: 4 }),
      order(ids.ambiguousRoot, { pid: -1, status: 4 }),
      order(ids.ambiguousA, { pid: ids.ambiguousRoot }), order(ids.ambiguousB, { pid: ids.ambiguousRoot }),
    ];
    const snapshot = (image: unknown, extra: Record<string, unknown> = {}) => ({
      product: { id: 501, storeName: '历史拆单商品', image },
      productInfo: { store_name: '保留旧优先级', image: base.refs.user,
        attrInfo: { image: base.refs.platform, suk: '历史拆单规格' } },
      sku: { image: base.refs.platform, suk: '先前购买规格' },
      truePrice: '1.23', coupon_price: '0.07', promotions_true_price: '0.11',
      first_order_price: '0.13', decimal_note: '001.2300',
      unknown: { image: 'unrecognized-image-field', relation_id: 310 }, ...extra,
    });
    const cart = (id: number, data: unknown, extra: Partial<typeof storeOrderCartInfo.$inferInsert> = {}): typeof storeOrderCartInfo.$inferInsert => ({
      id, oid: ids.order, uid: 201, cartId: `owned-split-cart-${id}`,
      productId: 501, skuUnique: `owned-split-sku-${id}`, unique: `owned-split-line-${id}`,
      type: 0, relationId: 0, productType: 0, cartNum: 3, refundNum: 1,
      surplusNum: 2, splitStatus: 0, splitSurplusNum: 2,
      cartInfo: JSON.stringify(data), addTime: 1_700_000_500, ...extra,
    });
    const carts = [
      cart(ids.carts.platform, snapshot(base.refs.platform)),
      cart(ids.carts.supplier, snapshot(base.refs.platform, {
        product: { id: 502, storeName: '历史供应商拆单商品', image: base.refs.platform,
          attrInfo: { image: base.refs.supplier } },
        productInfo: { image: base.refs.foreign, attrInfo: { image: base.refs.user } },
        sku: { image: 'https://legacy.example.test/split-sku.png?x=1&y=2', suk: '原始 SKU' },
      }), { type: 2, relationId: 310, splitStatus: 1, productId: 502 }),
      cart(ids.carts.store, snapshot(base.refs.platform), { type: 1, relationId: 77 }),
      cart(ids.carts.forged, snapshot(base.refs.supplier, { type: 2, relation_id: 310 }), { type: 0, relationId: 0 }),
      cart(ids.carts.legacy, snapshot('https://legacy.example.test/split-main.png?v=1&x=2')),
      cart(ids.carts.empty, snapshot('', { product: { image: '' }, productInfo: { image: base.refs.platform } })),
      cart(ids.carts.array, snapshot([base.refs.platform])),
      cart(ids.carts.splitComplete, snapshot(base.refs.platform), { splitStatus: 2 }),
      cart(ids.carts.noSurplus, snapshot(base.refs.platform), { splitSurplusNum: 0 }),
      cart(ids.carts.negativeSurplus, snapshot(base.refs.platform), { splitSurplusNum: -1 }),
      cart(ids.carts.foreign, snapshot(base.refs.platform), { oid: ids.foreign, uid: 202 }),
      cart(ids.carts.child, snapshot(base.refs.platform), { oid: ids.child }),
      cart(ids.carts.otherCustomerChild, snapshot(base.refs.platform), { oid: ids.otherCustomerChild, uid: 202 }),
      cart(ids.carts.otherSupplierChild, snapshot(base.refs.supplier), { oid: ids.otherSupplierChild, type: 2, relationId: 310 }),
    ];
    const orderRows: (typeof storeOrder.$inferSelect)[] = [];
    const cartRows: (typeof storeOrderCartInfo.$inferSelect)[] = [];
    const reset = async () => {
      await base.reset();
      for (const table of [storeOrderRefund, storeOrderInvoice, storeOrderPromotions]) await base.db.delete(table);
      await base.db.delete(storeOrderCartInfo); await base.db.delete(storeOrder);
      await base.db.insert(storeOrder).values(orders);
      await base.db.insert(storeOrderCartInfo).values(carts);
      orderRows.splice(0, orderRows.length, ...await base.db.select().from(storeOrder).orderBy(storeOrder.id));
      cartRows.splice(0, cartRows.length, ...await base.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id));
      base.resetResources();
    };
    await reset();
    return { ...base, reset, ids, orderRows, cartRows,
      splitSeeds: { orders, carts, snapshot, cart },
      expectedCartIds: [ids.carts.platform, ids.carts.supplier, ids.carts.store,
        ids.carts.forged, ids.carts.legacy, ids.carts.empty, ids.carts.array] };
  } catch (error) { await base.close(); throw error; }
}
