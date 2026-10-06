import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../../src/lib/di';
import { shippingTemplates, storeCombination, storePink, storeProduct, storeProductAttr, storeProductAttrResult,
  storeProductAttrValue, storeProductCategory, storeProductDescription, storeProductLabel, storeProductRelation,
  storeProductSkuRetirementLog, storeProductUnit, systemAttachment, systemLog, systemSupplier } from '../../src/models/schema';
import { AdminCombinationService } from '../../src/services/admin/AdminCombinationService';
import { financePostgres } from './financePostgres';

export function combinationInput(extra: Record<string, unknown> = {}) {
  return { request_id: crypto.randomUUID(), product_id: 101, title: '完整拼团', info: '拼团简介', unit_name: '件',
    images: ['/images/first.png', '/images/second.png'], description: '<p>商品详情</p>',
    start_time: new Date(Date.now() - 3600000).toISOString(), end_time: new Date(Date.now() + 86400000).toISOString(),
    effective_time: 24, people: 3, num: 10, once_num: 2, virtual: 100, sort: 3, status: 1, is_host: 1, is_support_refund: 1,
    shipping: { delivery_type: [1], freight: 1, postage: '0.00', temp_id: 0 },
    skus: [{ id: null, base_unique: 'base0001', enabled: true, price: '5.00', quota_total: 20, image: '/images/red.png' },
      { id: null, base_unique: 'base0002', enabled: true, price: '6.00', quota_total: 10, image: '/images/blue.png' }], ...extra };
}
export function combinationEdit(row: Awaited<ReturnType<AdminCombinationService['detail']>>, extra: Record<string, unknown> = {}) {
  return { request_id: crypto.randomUUID(), revision: row.revision, product_id: row.product_id, title: row.title, info: row.info,
    unit_name: row.unit_name, images: row.images, description: row.description, start_time: row.start_time!, end_time: row.end_time!,
    effective_time: row.effective_time, people: row.people, num: row.num, once_num: row.once_num, virtual: row.virtual,
    sort: row.sort, status: row.status, is_host: row.is_host, is_support_refund: row.is_support_refund, shipping: row.shipping,
    skus: row.skus.map(sku => ({ id: sku.id, base_unique: sku.base_unique, enabled: sku.enabled, price: sku.price,
      quota_total: sku.quota_total, image: sku.image })), ...extra };
}
export async function combinationAdminFixture() {
  const f = await financePostgres([storeCombination, storePink, storeProduct, storeProductAttr, storeProductAttrResult,
    storeProductAttrValue, storeProductDescription, storeProductSkuRetirementLog, systemAttachment, systemLog,
    systemSupplier, shippingTemplates, storeProductCategory, storeProductLabel, storeProductRelation, storeProductUnit], { namespace: 'public' });
  try {
    // financePostgres intentionally models columns; this real schema conflict
    // target must be present for the description's production UPSERT.
    await f.exec('ALTER TABLE store_product_description ADD PRIMARY KEY(product_id,type)');
    await f.db.insert(storeProduct).values([101, 102].map(id => ({ id, storeName: `基础${id}`, storeInfo: '服务端简介', stock: 100,
      image: '/images/product.png', sliderImage: '["/images/product.png"]', type: 0, relationId: 0, productType: 0,
      isShow: 1, isDel: 0, isVerify: 1, unitName: '件', freight: 1, deliveryType: '1', price: '10.00', otPrice: '20.00' })));
    await f.db.insert(storeProductAttrValue).values([
      { id: 11, productId: 101, type: 0, unique: 'base0001', suk: '红', stock: 60, price: '10.00', otPrice: '20.00', cost: '2.00', image: '/images/red.png' },
      { id: 12, productId: 101, type: 0, unique: 'base0002', suk: '蓝', stock: 40, price: '12.00', otPrice: '22.00', cost: '3.00', image: '/images/blue.png' },
      { id: 13, productId: 102, type: 0, unique: 'base0003', suk: '默认', stock: 100, price: '10.00', otPrice: '20.00', cost: '2.00' }]);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),13,true)");
    await f.db.insert(storeProductAttr).values([{ productId: 101, type: 0, attrName: '颜色', attrValues: '红,蓝' },
      { productId: 102, type: 0, attrName: '规格', attrValues: '默认' }]);
    await f.db.insert(storeProductDescription).values({ productId: 101, type: 0, description: '<p>来源详情</p>' });
    await f.db.insert(storeProductUnit).values({ id: 1, name: '件', status: 1 });
    const appKey = 'combination-admin-local-media-key', service = new AdminCombinationService(createContainerFromDb(f.db), appKey);
    const snapshot = async () => ({ combinations: await f.db.select().from(storeCombination).orderBy(storeCombination.id), pinks: await f.db.select().from(storePink).orderBy(storePink.id),
      skus: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id), attrs: await f.db.select().from(storeProductAttr).orderBy(storeProductAttr.id),
      results: await f.db.select().from(storeProductAttrResult).orderBy(storeProductAttrResult.id), descriptions: await f.db.select().from(storeProductDescription).orderBy(storeProductDescription.productId, storeProductDescription.type),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id), retirements: await f.db.select().from(storeProductSkuRetirementLog).orderBy(storeProductSkuRetirementLog.id), sources: await f.db.select().from(storeProduct).orderBy(storeProduct.id) });
    const consume = async (id: number, quantity = 2) => {
      const [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.type, 3));
      const [row] = await f.db.select().from(storeCombination).where(eq(storeCombination.id, id));
      await f.db.update(storeProductAttrValue).set({ quota: sku.quota - quantity, stock: sku.stock - quantity, sales: sku.sales + quantity }).where(eq(storeProductAttrValue.id, sku.id));
      await f.db.update(storeCombination).set({ quota: row.quota - quantity, stock: row.stock - quantity, sales: row.sales + quantity }).where(eq(storeCombination.id, id));
    };
    return { ...f, appKey, service, snapshot, consume };
  } catch (error) { await f.close(); throw error; }
}
