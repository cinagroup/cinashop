import { createContainerFromDb } from '@/lib/di';
import { legacyCategory, storeProductLabel, storeProductLabelAuxiliary, storeProductRelation, storeProduct,
  systemAdmin, systemSupplier, systemRole, systemMenus, systemLog } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { createSupplierProductLabelCapabilityFixture } from './supplierProductLabelCapabilityFixture';

export const supplierLabelTables = [legacyCategory, storeProductLabel, storeProductLabelAuxiliary, storeProductRelation,
  storeProduct, systemAdmin, systemSupplier, systemRole, systemMenus, systemLog];
export const supplierLabelSchema = { legacyCategory, storeProductLabel, storeProductLabelAuxiliary, storeProductRelation,
  storeProduct, systemAdmin, systemSupplier, systemRole, systemMenus, systemLog };
export const supplierLabelActor = (id = 21) => ({ id, authVersion: md5('supplier-label-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const supplierLabelBody = (changes: Record<string, unknown> = {}) => ({ label_cate: 10, label_name: '供应商新增标签', ...changes });

export async function seedSupplierLabels(db: ReturnType<typeof createContainerFromDb>['db']) {
  await db.insert(systemSupplier).values([{ id: 20, adminId: 29, supplierName: 'current-labels' }, { id: 30, adminId: 39, supplierName: 'other-labels' }]);
  await db.insert(systemRole).values([
    { id: 21, type: 4, relationId: 20, rules: 'supplier.product.manage' },
    { id: 22, type: 4, relationId: 20, rules: 'supplier.product.view' },
    { id: 23, type: 4, relationId: 20, rules: '900' },
    { id: 31, type: 4, relationId: 30, rules: 'supplier.product.manage' },
  ]);
  await db.insert(systemMenus).values({ id: 900, type: 4, authType: 2, access: 1, apiUrl: 'product/label/form', methods: 'GET', menuName: '商品标签表单' });
  await db.insert(systemAdmin).values([21, 22, 23, 29, 31, 39].map(id => ({ id, account: `supplier-label-${id}`, pwd: 'supplier-label-password',
    adminType: 4, relationId: id >= 30 ? 30 : 20, roles: [29, 39].includes(id) ? '' : String(id), level: [29, 39].includes(id) ? 0 : 1 })));
  await db.insert(legacyCategory).values([
    { id: 10, type: 0, relationId: 0, ownerId: 0, group: 2, name: '平台商品标签组', sort: 10 },
    { id: 11, type: 0, relationId: 0, ownerId: 0, group: 2, name: '隐藏平台组', isShow: 0 },
    { id: 12, type: 0, relationId: 0, ownerId: 8, group: 2, name: '私有owner标签组' },
    { id: 20, type: 2, relationId: 20, ownerId: 0, group: 2, name: '当前供应商历史组' },
    { id: 30, type: 2, relationId: 30, ownerId: 0, group: 2, name: '其他供应商组' },
    { id: 40, type: 0, relationId: 0, group: 3, name: '商品参数组' },
    { id: 50, type: 0, relationId: 20, group: 2, name: '错误平台关系' },
    { id: 70, type: 0, relationId: 0, group: 0, name: '用户标签组' },
  ]);
  await db.insert(storeProductLabel).values([
    { id: 101, type: 0, relationId: 0, labelCate: 10, labelName: '平台标签' },
    { id: 201, type: 2, relationId: 20, labelCate: 10, labelName: '旧平台组下的供应商标签', sort: 10, addTime: 1 },
    { id: 202, type: 2, relationId: 20, labelCate: 20, labelName: '原有展示事实', styleType: 2, color: '#112233', bgColor: '#abcdef',
      borderColor: '#123456', icon: '/api/assets/77', status: 0, isShow: 0, sort: 8, addTime: 100 },
    { id: 203, type: 2, relationId: 20, labelCate: 0, labelName: '未分类旧标签' },
    { id: 204, type: 2, relationId: 20, labelCate: 30, labelName: '挂到外域的坏关联' },
    { id: 205, type: 2, relationId: 20, labelCate: 12, labelName: '挂私有owner的坏关联' },
    { id: 301, type: 2, relationId: 30, labelCate: 10, labelName: '其他供应商合法平台组标签' },
    { id: 302, type: 2, relationId: 30, labelCate: 30, labelName: '其他供应商自有标签' },
  ]);
  await db.insert(storeProduct).values([{ id: 80, type: 2, relationId: 20, storeName: 'current-product', price: '19.99', isShow: 1, isVerify: 1 },
    { id: 90, type: 2, relationId: 30, storeName: 'foreign-product', price: '29.99', isShow: 1, isVerify: 1 }]);
}

export async function supplierProductLabelFixture() {
  const f = await createSupplierProductLabelCapabilityFixture(supplierLabelTables);
  try {
    await seedSupplierLabels(f.db); await f.exec("SELECT setval(pg_get_serial_sequence('store_product_label','id'),400,false)");
    return f;
  } catch (error) {
    try { await f.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Supplier label seed and cleanup failed'); }
    throw error;
  }
}
