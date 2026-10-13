import { createContainerFromDb } from '@/lib/di';
import { storeProductRule, storeProduct, storeProductAttr, storeProductAttrValue, systemAdmin, systemSupplier, systemRole, systemMenus, systemLog } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './financePostgres';
export const supplierRuleSchema = { storeProductRule, storeProduct, storeProductAttr, storeProductAttrValue, systemAdmin, systemSupplier, systemRole, systemMenus, systemLog };
export const supplierRuleTables = Object.values(supplierRuleSchema);
export const supplierRuleActor = (id = 21) => ({ id, authVersion: md5('supplier-rule-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const supplierRuleBody = (changes: Record<string, unknown> = {}) => ({ rule_name: '供应商新增模板', spec: [{ value: '颜色', detail: ['红', '蓝'] }, { value: '尺码', detail: ['S', 'M'] }], ...changes });
export async function seedSupplierRules(db: ReturnType<typeof createContainerFromDb>['db']) {
  await db.insert(systemSupplier).values([{ id: 20, adminId: 29, supplierName: 'current-rules' }, { id: 30, adminId: 39, supplierName: 'other-rules' }]);
  await db.insert(systemRole).values([{ id: 21, type: 4, relationId: 20, rules: 'supplier.product.manage' },
    { id: 22, type: 4, relationId: 20, rules: 'supplier.product.view' }, { id: 23, type: 4, relationId: 20, rules: '900' },
    { id: 24, type: 4, relationId: 20, rules: '901' }, { id: 31, type: 4, relationId: 30, rules: 'supplier.product.manage' }]);
  await db.insert(systemMenus).values([{ id: 900, type: 4, authType: 2, access: 1, apiUrl: 'product/product/rule', methods: 'GET', menuName: '规格模板只读' },
    { id: 901, type: 4, authType: 2, access: 1, apiUrl: 'product/product/rule/0', methods: 'POST', menuName: '规格模板写入' }]);
  await db.insert(systemAdmin).values([21, 22, 23, 24, 29, 31, 39].map(id => ({ id, account: `supplier-rule-${id}`, pwd: 'supplier-rule-password', adminType: 4,
    relationId: id >= 30 ? 30 : 20, roles: [29, 39].includes(id) ? '' : String(id), level: [29, 39].includes(id) ? 0 : 1 })));
  await db.insert(storeProductRule).values([{ id: 101, type: 0, relationId: 0, ruleName: '平台模板', ruleValue: JSON.stringify([{ value: '平台维度', detail: ['值'] }]) },
    { id: 201, type: 2, relationId: 20, ruleName: '当前服装模板', ruleValue: JSON.stringify(supplierRuleBody().spec) },
    { id: 202, type: 2, relationId: 20, ruleName: '当前旧模板', ruleValue: JSON.stringify([{ value: '包装', detail: ['盒装'] }]) },
    { id: 301, type: 2, relationId: 30, ruleName: '其他供应商模板', ruleValue: JSON.stringify([{ value: '外域', detail: ['值'] }]) }]);
  await db.insert(storeProduct).values({ id: 80, type: 2, relationId: 20, storeName: 'copied-product', specType: 1, price: '19.99', stock: 7, isShow: 1 });
  await db.insert(storeProductAttr).values({ id: 81, productId: 80, attrName: '包装', attrValues: '盒装', type: 0 });
  await db.insert(storeProductAttrValue).values({ id: 82, productId: 80, suk: '盒装', price: '19.99', stock: 7, unique: 'existSKU', type: 0 });
}
export async function supplierProductRuleFixture() {
  const f = await financePostgres(supplierRuleTables, { namespace: 'public' });
  await seedSupplierRules(f.db); await f.exec("SELECT setval(pg_get_serial_sequence('store_product_rule','id'),400,false)");
  return { ...f, container: createContainerFromDb(f.db) };
}
