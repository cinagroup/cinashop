import { getTableName } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductDescription,
  storeProductVirtual, storeProductStockRecord, storeCart, storeProductRelation, storeProductCoupon,
  storeDiscountsProducts, storeSeckill, storeCombination, storeBargain, storeIntegral, systemConfig,
  systemSupplier, shippingTemplates, systemForm, userLabel, storeProductCategory, storeBrand, storeProductLabel,
  storeProductEnsure, legacyCategory, storeProductSpecs, storeCouponIssue, systemAttachment, systemAdmin,
  systemRole, systemMenus, systemLog, storeOrderOutbox } from '@/models/schema';
import { AdminLegacyProductSaveService } from '@/services/admin/AdminLegacyProductSaveService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './financePostgres';

export const legacySaveSchema = { storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductDescription,
  storeProductVirtual, storeProductStockRecord, storeCart, storeProductRelation, storeProductCoupon,
  storeDiscountsProducts, storeSeckill, storeCombination, storeBargain, storeIntegral, systemConfig,
  systemSupplier, shippingTemplates, systemForm, userLabel, storeProductCategory, storeBrand, storeProductLabel,
  storeProductEnsure, legacyCategory, storeProductSpecs, storeCouponIssue, systemAttachment, systemAdmin,
  systemRole, systemMenus, systemLog, storeOrderOutbox };
export const legacySaveActor = () => ({ id: 1, authVersion: md5('legacy-save-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const legacySaveSku = (overrides: Record<string, unknown> = {}) => ({ pic: '/uploads/sku.png', price: 12.5,
  cost: 3, ot_price: 20, vip_price: 8, settle_price: 0, stock: 7, ...overrides });
export const legacySaveBody = (overrides: Record<string, unknown> = {}) => ({ store_name: '完整商品', cate_id: [1],
  slider_image: ['/uploads/main.png'], delivery_type: ['1'], freight: 1, attrs: [legacySaveSku()],
  description: '<p>完整描述</p>', ...overrides });
export async function legacySaveFixture() {
  const f = await financePostgres(Object.values(legacySaveSchema), { namespace: 'public' });
  const container = createContainerFromDb(f.db), service = new AdminLegacyProductSaveService(container);
  const seed = async () => {
    await f.reset();
    await f.db.insert(systemRole).values({ id: 1, rules: 'product.manage' });
    await f.db.insert(systemAdmin).values({ id: 1, account: 'legacy-save', pwd: 'legacy-save-password', roles: '1', level: 1 });
    await f.db.insert(systemMenus).values([
      { id: 105, authType: 2, apiUrl: 'product/product/<id>', methods: 'POST', menuPath: '/admin/product/save', uniqueAuth: 'product-save' },
      { id: 620, authType: 2, apiUrl: 'product/product/<id>', methods: 'GET', menuPath: '', uniqueAuth: '' },
    ]);
    await f.db.insert(storeProductCategory).values({ id: 1, cateName: '平台分类' });
    await f.db.insert(systemConfig).values({ menuName: 'store_stock', value: '2' });
  };
  const snapshot = async () => {
    const state: Record<string, unknown[]> = {};
    for (const table of Object.values(legacySaveSchema)) state[getTableName(table)] = (await f.db.select().from(table))
      .map(row => JSON.stringify(row)).sort();
    return state;
  };
  return { ...f, container, service, seed, snapshot };
}
