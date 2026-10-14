import { createContainerFromDb } from '@/lib/di';
import { storeProductRule, storeProductUnit, systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { AdminProductRuleService } from '@/services/admin/AdminProductRuleService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './financePostgres';
import { specsSchema } from './adminProductSpecs';

export const ruleSchema = specsSchema;
export const ruleActor = (id = 101) => ({ id, authVersion: md5('rule-fixture-password'),
  expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const ruleBody = (overrides: Record<string, unknown> = {}) => ({ rule_name: '新增规格',
  spec: [{ value: '颜色', detail: ['红', '蓝'] }, { value: '尺码', detail: ['S', 'M'] }], ...overrides });

export async function seedRules(db: ReturnType<typeof createContainerFromDb>['db']) {
  await db.insert(systemRole).values([{ id: 1, rules: 'product.manage' }, { id: 2, rules: 'product.view' },
    { id: 3, rules: 'user.manage' }, { id: 4, rules: '195,197' }, { id: 5, rules: '186,194,196' },
    { id: 6, rules: '99' }, { id: 7, rules: '580' }]);
  await db.insert(systemMenus).values([
    { id: 186, type: 1, authType: 2, apiUrl: 'product/product/get_rule', methods: 'GET', menuPath: '/adminproduct/product/get_rule' },
    { id: 194, type: 1, authType: 2, apiUrl: 'product/product/rule', methods: 'GET', menuPath: '/adminproduct/product/rule' },
    { id: 195, type: 1, authType: 2, apiUrl: 'product/product/rule/<id>', methods: 'POST',
      menuPath: '/adminproduct/rule/<id>', uniqueAuth: 'product-rule-save' },
    { id: 196, type: 1, authType: 2, apiUrl: 'product/product/rule/<id>', methods: 'GET', menuPath: '/adminproduct/product/rule/<id>' },
    { id: 197, type: 1, authType: 2, apiUrl: 'product/product/rule/delete', methods: 'DELETE',
      menuPath: '/adminproduct/product/rule/delete', uniqueAuth: 'product-product-rule-delete' },
    // These are the source installation tuples, not guesses from the page title.
    { id: 99, type: 1, authType: 1, apiUrl: '', methods: '', menuPath: '/admin/product/product_attr', uniqueAuth: 'product-product-attr' },
    { id: 580, type: 1, authType: 1, apiUrl: '', methods: '', menuPath: '/admin*', uniqueAuth: '' },
  ]);
  await db.insert(systemAdmin).values([100, 101, 102, 103, 104, 105, 106, 107].map(id => ({ id,
    account: `rule-${id}`, pwd: 'rule-fixture-password', level: id === 100 ? 0 : 1,
    roles: id === 100 ? '' : String(id - 100) })));
  await db.insert(storeProductUnit).values({ id: 1, name: '件' });
  await db.insert(storeProductRule).values([
    { id: 10, ruleName: '服装', ruleValue: JSON.stringify(ruleBody().spec) },
    { id: 11, ruleName: '包装', ruleValue: JSON.stringify([{ value: '包装', detail: ['盒'] }]) },
    { id: 20, type: 2, relationId: 20, ruleName: '供应商规格', ruleValue: JSON.stringify([{ value: '材质', detail: ['钢'] }]) },
    { id: 21, type: 0, relationId: 99, ruleName: '异常平台规格', ruleValue: '[]' },
    { id: 22, type: 1, relationId: 20, ruleName: '门店规格', ruleValue: '[]' },
    { id: 30, type: 2, relationId: 30, ruleName: '另一供应商规格', ruleValue: '[]' },
  ]);
}

export async function productRuleFixture() {
  const f = await financePostgres(Object.values(ruleSchema), { namespace: 'public' });
  await seedRules(f.db);
  await f.exec("SELECT setval(pg_get_serial_sequence('store_product_rule','id'),1000,false)");
  await f.exec('ALTER TABLE store_product_description ADD UNIQUE(product_id,type)');
  const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminProductRuleService(container) };
}
