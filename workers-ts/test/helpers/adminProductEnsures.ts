import { createContainerFromDb } from '@/lib/di';
import { storeProductEnsure, systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { AdminProductEnsureService } from '@/services/admin/AdminProductEnsureService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './financePostgres';
import { specsSchema } from './adminProductSpecs';

/** Shared complete product-editor schema; these fixtures seed independent authority and ensure rows. */
export const ensureSchema = specsSchema;
export const ensureActor = (id = 101) => ({ id, authVersion: md5('ensure-fixture-password'),
  expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const ensureBody = (overrides: Record<string, unknown> = {}) => ({ name: '新增保障',
  image: 'https://shop.example/ensure.png', desc: '承诺保障', sort: 2, ...overrides });

export async function seedEnsures(db: ReturnType<typeof createContainerFromDb>['db']) {
  await db.insert(systemRole).values([{ id: 1, rules: 'product.manage' }, { id: 2, rules: 'product.view' },
    { id: 3, rules: 'user.manage' }, { id: 4, rules: '1601,1602,1603,1604' },
    { id: 5, rules: '1382' }, { id: 6, rules: '1383' }]);
  // PHP 1382 is the actual ensure page. PHP 1383's misleading Chinese title
  // does not supply a recognized API writer grant. 1601..1604 are synthetic.
  await db.insert(systemMenus).values([
    { id: 1601, type: 1, authType: 2, apiUrl: 'product/ensure', methods: 'POST' },
    { id: 1602, type: 1, authType: 2, apiUrl: 'product/ensure/<id>', methods: 'PUT' },
    { id: 1603, type: 1, authType: 2, apiUrl: 'product/ensure/<id>', methods: 'DELETE' },
    { id: 1604, type: 1, authType: 2, apiUrl: 'product/ensure/set_show/<id>/<is_show>', methods: 'PUT' },
    { id: 1382, type: 1, authType: 1, menuPath: '/admin/product/ensure',
      uniqueAuth: 'admin-storeProduct-ensure', apiUrl: '', methods: '' },
    { id: 1383, type: 1, authType: 1, menuPath: '/admin/product/ensure/create',
      uniqueAuth: 'admin-storeProduct-ensure-create', apiUrl: '', methods: '' },
  ]);
  await db.insert(systemAdmin).values([100, 101, 102, 103, 104, 105, 106].map(id => ({ id,
    account: `ensure-${id}`, pwd: 'ensure-fixture-password', level: id === 100 ? 0 : 1,
    roles: id === 100 ? '' : String(id - 100) })));
  await db.insert(storeProductEnsure).values([
    { id: 10, name: '无忧退', image: 'https://shop.example/ten.png', desc: '已启用条款', sort: 9, addTime: 1 },
    { id: 11, name: '隐藏保障', image: 'https://shop.example/eleven.png', desc: '已停用条款',
      sort: 9, addTime: 0, status: 0 },
    { id: 12, name: '破损保障', image: 'https://shop.example/twelve.png', desc: '退款保障',
      sort: 1, addTime: 1700000000 },
    { id: 20, name: '供应商保障', image: 'https://shop.example/private.png', desc: '供应商条款', type: 2, relationId: 20 },
    { id: 21, name: '异常平台保障', image: 'https://shop.example/malformed.png', type: 0, relationId: 99 },
    { id: 22, name: '门店保障', image: 'https://shop.example/store.png', type: 1, relationId: 20 },
    { id: 30, name: '另一供应商保障', image: 'https://shop.example/other.png', type: 2, relationId: 30 },
  ]);
}

export async function productEnsureFixture() {
  const f = await financePostgres(Object.values(ensureSchema), { namespace: 'public' });
  await seedEnsures(f.db);
  await f.exec("SELECT setval(pg_get_serial_sequence('store_product_ensure','id'),1000,false)");
  await f.exec('ALTER TABLE store_product_description ADD UNIQUE(product_id,type)');
  const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminProductEnsureService(container) };
}
