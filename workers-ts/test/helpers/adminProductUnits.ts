import { createContainerFromDb } from '@/lib/di';
import { storeProductUnit, storeProduct, systemAdmin, systemRole, systemMenus, systemLog,
  storeProductRelation, storeProductCategory, storeProductAttr, storeProductAttrValue, storeProductAttrResult,
  storeProductDescription, storeProductStockRecord, storeProductEnsure, storeProductLabel, legacyCategory,
  storeProductSpecs, storeBrand, storeCouponIssue, storeBargain, storeBargainUser, systemForm, userLabel,
  systemSupplier, storeCart } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { AdminProductUnitService } from '@/services/admin/AdminProductUnitService';
import { financePostgres } from './financePostgres';
export const unitTables = [storeProductUnit, storeProduct, systemAdmin, systemRole, systemMenus, systemLog];
export const unitProductTables = [...unitTables, storeProductRelation, storeProductCategory, storeProductAttr, storeProductAttrValue,
  storeProductAttrResult, storeProductDescription, storeProductStockRecord, storeProductEnsure, storeProductLabel, legacyCategory,
  storeProductSpecs, storeBrand, storeCouponIssue, storeBargain, storeBargainUser, systemForm, userLabel, systemSupplier, storeCart];
export const unitActor = (id = 101) => ({ id, authVersion: md5('unit-fixture-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export async function seedUnits(db: ReturnType<typeof createContainerFromDb>['db']) {
  await db.insert(systemRole).values([{ id: 1, rules: 'product.manage' }, { id: 2, rules: 'product.view' }, { id: 3, rules: 'user.manage' }, { id: 4, rules: '1401,1402' }, { id: 5, rules: '1349' }]);
  // 1349 is the exact PHP page seed. 1401/1402 are synthetic current API grants.
  await db.insert(systemMenus).values([{ id: 1401, type: 1, authType: 2, apiUrl: 'product/unit', methods: 'POST' }, { id: 1402, type: 1, authType: 2, apiUrl: 'product/unit/<id>', methods: 'DELETE' },
    { id: 1349, type: 1, authType: 1, menuPath: '/admin/product/unitList', uniqueAuth: 'admin-storeProduct-unit', apiUrl: '', methods: '' }]);
  await db.insert(systemAdmin).values([100, 101, 102, 103, 104, 105].map(id => ({ id, account: `unit-${id}`, pwd: 'unit-fixture-password', level: id === 100 ? 0 : 1, roles: id === 100 ? '' : String(id - 100) })));
  await db.insert(storeProductUnit).values([
    { id: 1, name: '件', sort: 9, addTime: 1 }, { id: 2, name: '箱', sort: 9 }, { id: 3, name: '套餐', sort: 1 },
    { id: 4, name: '隐藏', status: 0 }, { id: 5, name: '旧删除', isDel: 1 },
    { id: 6, name: '供应商私有', type: 2, relationId: 20 }, { id: 7, name: '异常平台', type: 0, relationId: 7 },
  ]);
}
export async function productUnitFixture(products = false) {
  const f = await financePostgres(products ? unitProductTables : unitTables, { namespace: 'public' });
  await seedUnits(f.db);
  await f.exec("SELECT setval(pg_get_serial_sequence('store_product_unit','id'),100,false)");
  if (products) await f.exec('ALTER TABLE store_product_description ADD UNIQUE(product_id,type)');
  const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminProductUnitService(container) };
}
