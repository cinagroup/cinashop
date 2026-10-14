import { createContainerFromDb } from '@/lib/di';
import { legacyCategory, storeProductSpecs, systemAdmin, systemRole, systemMenus, systemLog,
  storeProduct, storeProductRelation, storeProductCategory, storeProductAttr, storeProductAttrValue,
  storeProductAttrResult, storeProductDescription, storeProductStockRecord, storeProductEnsure,
  storeProductLabel, storeProductUnit, storeProductRule, storeBrand, storeCouponIssue, storeBargain,
  storeBargainUser, systemForm, userLabel, systemSupplier, storeCart, shippingTemplates } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { AdminProductSpecsService } from '@/services/admin/AdminProductSpecsService';
import { financePostgres } from './financePostgres';

export const specsSchema = { legacyCategory, storeProductSpecs, systemAdmin, systemRole, systemMenus,
  systemLog, storeProduct, storeProductRelation, storeProductCategory, storeProductAttr,
  storeProductAttrValue, storeProductAttrResult, storeProductDescription, storeProductStockRecord,
  storeProductEnsure, storeProductLabel, storeProductUnit, storeProductRule, storeBrand,
  storeCouponIssue, storeBargain, storeBargainUser, systemForm, userLabel, systemSupplier,
  storeCart, shippingTemplates };
export const specsActor = (id = 101) => ({ id, authVersion: md5('specs-fixture-password'),
  expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const specsBody = (overrides: Record<string, unknown> = {}) => ({ name: '新增参数', sort: 2,
  specs: [{ name: '材质', value: '钢', sort: 3, status: 1 }], ...overrides });

export async function seedProductSpecs(db: ReturnType<typeof createContainerFromDb>['db']) {
  await db.insert(systemRole).values([{ id: 1, rules: 'product.manage' }, { id: 2, rules: 'product.view' },
    { id: 3, rules: 'user.manage' }, { id: 4, rules: '1501,1502' }, { id: 5, rules: '1381' },
    { id: 6, rules: '1383' }]);
  // 1381 and 1383 are exact PHP seed tuples. The latter belongs to ensure/create,
  // despite its misleading Chinese name in the PHP installation SQL.
  await db.insert(systemMenus).values([
    { id: 1501, type: 1, authType: 2, apiUrl: 'product/specs/<id>', methods: 'POST' },
    { id: 1502, type: 1, authType: 2, apiUrl: 'product/specs/<id>', methods: 'DELETE' },
    { id: 1381, type: 1, authType: 1, menuPath: '/admin/product/specs',
      uniqueAuth: 'admin-storeProduct-specs', apiUrl: '', methods: '' },
    { id: 1383, type: 1, authType: 1, menuPath: '/admin/product/ensure/create',
      uniqueAuth: 'admin-storeProduct-ensure-create', apiUrl: '', methods: '' },
  ]);
  await db.insert(systemAdmin).values([100, 101, 102, 103, 104, 105, 106].map(id => ({ id,
    account: `specs-${id}`, pwd: 'specs-fixture-password', level: id === 100 ? 0 : 1,
    roles: id === 100 ? '' : String(id - 100) })));
  await db.insert(legacyCategory).values([
    { id: 10, group: 3, name: '标准参数', sort: 9, addTime: 1 },
    { id: 11, group: 3, name: '易碎参数', sort: 9, addTime: 0 },
    { id: 12, group: 3, name: '隐藏参数', sort: 1, isShow: 0, addTime: 1700000000 },
    { id: 20, group: 3, name: '供应商参数', sort: 99, type: 2, relationId: 20 },
    { id: 21, group: 3, name: '异常平台参数', type: 0, relationId: 99 },
    { id: 22, group: 3, name: '门店参数', type: 1, relationId: 20 },
    { id: 30, group: 3, name: '他人参数', ownerId: 77 },
    { id: 40, group: 1, name: '客服分类' },
  ]);
  await db.insert(storeProductSpecs).values([
    { id: 100, tempId: 10, name: '壳材', value: '塑料', sort: 9, addTime: 1 },
    { id: 101, tempId: 10, name: '暗字段', value: '内部', sort: 1, status: 0, addTime: 2 },
    { id: 102, tempId: 11, name: '性能', value: '稳固', sort: 1, addTime: 3 },
    { id: 110, type: 2, relationId: 20, tempId: 20, name: '私有', value: '供应商' },
    { id: 122, tempId: 30, name: '他人字段', value: '不可泄露' },
    { id: 123, tempId: 40, name: '客服字段', value: '不可泄露' },
  ]);
}

export async function productSpecsFixture() {
  const f = await financePostgres(Object.values(specsSchema), { namespace: 'public' });
  await seedProductSpecs(f.db);
  await f.exec("SELECT setval(pg_get_serial_sequence('category','id'),1000,false), setval(pg_get_serial_sequence('store_product_specs','id'),1000,false)");
  await f.exec('ALTER TABLE store_product_description ADD UNIQUE(product_id,type)');
  const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminProductSpecsService(container) };
}
