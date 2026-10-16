import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductDescription,
  storeProductRelation, storeProductCoupon, userRelation, storeProductReply, communityRelevance, storeCart,
  systemAdmin, systemSupplier, systemRole, systemMenus, systemLog, storeOrder, storeOrderCartInfo,
  storeProductVirtual, storeProductSkuRetirementLog, storeProductStockRecord, systemAttachment,
  storeBargain, storeSeckill, storeCombination, storeIntegral, storeDiscountsProducts, userBill,
  storeOrderRefund, storeOrderStatus, storeOrderOutbox } from '@/models/schema';
import { PRODUCT_SKU_RETIREMENT_SQL } from '@/migrations/productSkuRetirement';
import { installProductRecycleSkuGuard } from '@/migrations/productRecycleSkuGuard';
import { SupplierProductRecycleService } from '@/services/supplier/SupplierProductRecycleService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './financePostgres';

export const supplierRecycleSchema = { storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue,
  storeProductDescription, storeProductRelation, storeProductCoupon, userRelation, storeProductReply,
  communityRelevance, storeCart, systemAdmin, systemSupplier, systemRole, systemMenus, systemLog,
  storeOrder, storeOrderCartInfo, storeProductVirtual, storeProductSkuRetirementLog, storeProductStockRecord,
  systemAttachment, storeBargain, storeSeckill, storeCombination, storeIntegral, storeDiscountsProducts, userBill,
  storeOrderRefund, storeOrderStatus, storeOrderOutbox };
export const supplierRecyclePassword = 'supplier-recycle-owned-password';
export const supplierRecycleActor = (id = 21) => ({ id, supplierId: id >= 30 ? 30 : 20,
  authVersion: md5(supplierRecyclePassword), expiresAt: Math.floor(Date.now() / 1000) + 3600, ip: '127.0.0.1' });
export async function seedSupplierRecycle(db: DbClient) {
  await db.insert(systemSupplier).values([{ id: 20, adminId: 29, supplierName: 'owned-recycle' }, { id: 30, adminId: 39, supplierName: 'foreign-recycle' }]);
  await db.insert(systemRole).values([
    { id: 21, type: 4, relationId: 20, rules: 'supplier.product.manage' },
    { id: 22, type: 4, relationId: 20, rules: 'supplier.product.view' },
    { id: 23, type: 4, relationId: 20, rules: '930080' },
    { id: 31, type: 4, relationId: 30, rules: 'supplier.product.manage' },
  ]);
  await db.insert(systemMenus).values({ id: 930080, type: 4, authType: 2, access: 1, apiUrl: 'product/type_header', methods: 'GET', menuName: 'Owned Supplier read header' });
  await db.insert(systemAdmin).values([21, 22, 23, 29, 31, 39].map(id => ({ id, account: `supplier-recycle-${id}`, pwd: supplierRecyclePassword,
    adminType: 4, relationId: id >= 30 ? 30 : 20, roles: [29, 39].includes(id) ? '' : String(id), level: [29, 39].includes(id) ? 0 : 1 })));
  await db.insert(storeProduct).values([
    { id: 80, type: 2, relationId: 20, storeName: 'active product', isShow: 1, isVerify: 1, price: '19.99', stock: 8 },
    { id: 81, type: 2, relationId: 20, productType: 1, storeName: 'recycled card product', isDel: 1, isShow: 1, isVerify: -1, stock: 9, sales: 15 },
    { id: 82, type: 2, relationId: 20, productType: 3, storeName: 'recycled manual product', isDel: 1, isShow: 0, isVerify: -2 },
    { id: 83, type: 2, relationId: 20, storeName: 'sold out product', isShow: 0, isVerify: 1, stock: 0 },
    { id: 84, type: 2, relationId: 20, storeName: 'warning product', isShow: 1, isVerify: 1, isPolices: 1, stock: 200 },
    { id: 85, type: 2, relationId: 20, storeName: 'pending product', isVerify: 0 },
    { id: 86, type: 2, relationId: 20, storeName: 'refused product', isVerify: -1 },
    { id: 90, type: 2, relationId: 30, storeName: 'foreign product', isDel: 1 },
    { id: 100, type: 0, relationId: 20, storeName: 'platform relation collision', isDel: 1 },
    { id: 101, type: 1, relationId: 20, storeName: 'store relation collision', isDel: 1 },
  ]);
  await db.insert(storeProductAttr).values([{ id: 201, productId: 81, type: 0 }, { id: 202, productId: 81, type: 2 }, { id: 203, productId: 90, type: 0 }]);
  await db.insert(storeProductAttrResult).values([{ id: 201, productId: 81, type: 0, result: 'original private attrs' }, { id: 202, productId: 81, type: 2 }]);
  await db.insert(storeProductAttrValue).values([
    { id: 301, productId: 81, type: 0, unique: 'card0001', diskInfo: 'fixed secret', stock: 6 },
    { id: 302, productId: 81, type: 0, unique: 'card0002', isRetired: 1, retiredAt: 10, retiredBy: 21, retireReason: 'retained history', stock: 3, sales: 4 },
    { id: 303, productId: 81, type: 3, unique: 'pink0001', isRetired: 1, stock: 5 },
    { id: 304, productId: 90, type: 0, unique: 'other001', stock: 7 },
  ]);
  await db.insert(storeProductDescription).values([{ productId: 81, type: 0, description: 'original HTML' }, { productId: 81, type: 2, description: 'activity HTML' }]);
  await db.insert(storeProductRelation).values([{ id: 401, productId: 81, type: 3, relationId: 5, status: 7 }, { id: 402, productId: 80, type: 1, relationId: 8, status: 3 }]);
  await db.insert(storeProductCoupon).values({ id: 401, productId: 81, issueCouponId: 8 });
  await db.insert(userRelation).values([{ id: 401, uid: 11, relationId: 81, type: 'collect', category: 'product' }, { id: 402, uid: 11, relationId: 81, type: 'collect', category: 'article' }]);
  await db.insert(storeProductReply).values({ id: 401, productId: 81, oid: 501, uid: 11, comment: 'PHP removes product comments' });
  await db.insert(communityRelevance).values([{ id: 401, leftId: 7, rightId: 81, type: 'community_product' }, { id: 402, leftId: 7, rightId: 81, type: 'community_topic' }]);
  await db.insert(storeCart).values([{ id: 401, uid: 11, productId: 81, productAttrUnique: 'card0002', status: 7, isPay: 1, isDel: 1, isNew: 1 },
    { id: 402, uid: 11, productId: 80, productAttrUnique: 'active01', status: 3 }, { id: 403, uid: 12, productId: 81, type: 2, status: -2 }]);
  await db.insert(storeOrder).values({ id: 501, orderId: 'owned-card-order', uid: 11, supplierId: 20, paid: 1, status: 0, virtualInfo: 'immutable delivered secret' });
  await db.insert(storeOrderCartInfo).values({ id: 501, oid: 501, cartId: '401', productId: 81, skuUnique: 'card0002', cartInfo: '{"immutable":"SKU/card snapshot"}' });
  await db.insert(storeProductVirtual).values([{ id: 601, productId: 81, attrUnique: 'card0002', cardNo: 'issued', cardPwd: 'issued-secret', uid: 11, orderId: 'owned-card-order' },
    { id: 602, productId: 81, attrUnique: 'card0001', cardNo: 'unissued', cardPwd: 'unissued-secret' }]);
  await db.insert(storeProductSkuRetirementLog).values({ id: 601, productId: 81, skuId: 302, action: 'retire', uniqueSnapshot: 'card0002', actorId: 21 });
  await db.insert(storeProductStockRecord).values({ id: 601, productId: 81, unique: 'card0002', number: 3 });
  await db.insert(systemAttachment).values({ attId: 601, name: 'supplier/20/keep-image.png', attDir: 'supplier/20/keep-image.png', moduleType: 4, relationId: 20 });
  await db.insert(storeBargain).values({ id: 601, productId: 81, title: 'kept bargain' });
  await db.insert(storeSeckill).values({ id: 601, productId: 81, storeName: 'kept seckill' });
  await db.insert(storeCombination).values({ id: 601, productId: 81, storeName: 'kept combination' });
  await db.insert(storeIntegral).values({ id: 601, productId: 81, storeName: 'kept integral' });
  await db.insert(storeDiscountsProducts).values({ id: 601, productId: 81 });
  await db.insert(userBill).values({ id: 601, uid: 11, title: 'payment fact', category: 'now_money', type: 'pay_product', number: '20.00' });
}
export async function supplierRecycleSnapshot(db: DbClient) {
  const result: Record<string, unknown[]> = {};
  for (const table of Object.values(supplierRecycleSchema)) {
    const name = getTableConfig(table).name;
    result[name] = await db.execute(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t ORDER BY to_jsonb(t)::text`);
  }
  return result;
}
export async function supplierProductRecycleFixture(install = true) {
  const f = await financePostgres(Object.values(supplierRecycleSchema), { namespace: 'public' });
  try {
    await f.exec(PRODUCT_SKU_RETIREMENT_SQL);
    await f.exec('CREATE UNIQUE INDEX supplier_recycle_fixture_outbox_event_key ON public.store_order_outbox(event_key)');
    if (install) await f.db.transaction(tx => installProductRecycleSkuGuard(tx));
    await seedSupplierRecycle(f.db);
    const container = createContainerFromDb(f.db);
    return { ...f, reset: async () => {
      // Fixture-owner cleanup only: runtime cannot truncate permanent facts.
      // Restore the exact trigger immediately, including when cleanup fails.
      const [state] = await f.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.store_product_sku_retirement_log'::regclass
        AND tgname='spsrl_permanent_truncate') AS guarded`);
      if (state.guarded) await f.exec('ALTER TABLE public.store_product_sku_retirement_log DISABLE TRIGGER spsrl_permanent_truncate');
      try { await f.reset(); } finally { if (state.guarded) await f.exec('ALTER TABLE public.store_product_sku_retirement_log ENABLE TRIGGER spsrl_permanent_truncate'); }
    }, container, service: new SupplierProductRecycleService(container) };
  } catch (error) { await f.close(); throw error; }
}
