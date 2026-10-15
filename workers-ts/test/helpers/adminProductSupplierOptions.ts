import { getTableName } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole, systemSupplier, systemLog } from '@/models/schema';
import { AdminProductCatalogReadService } from '@/services/admin/AdminProductCatalogReadService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './financePostgres';

export const supplierOptionsSchema = { systemAdmin, systemMenus, systemRole, systemSupplier, systemLog };
export const supplierOptionsPassword = 'supplier-selector-fixture-password';
export const supplierOptionsActor = (id = 101) => ({ id, authVersion: md5(supplierOptionsPassword),
  expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const supplierOptionsExpected = [{ id: 30, supplier_name: '停用供应商仍可筛选' },
  { id: 20, supplier_name: '在营供应商' }];

export async function seedSupplierOptions(db: DbClient) {
  await db.insert(systemMenus).values([
    { id: 2, type: 1, authType: 1, menuPath: '/admin/product/product_list', uniqueAuth: 'admin-store-storeProuduct-index' },
    { id: 108, type: 1, authType: 2, apiUrl: 'product/product', methods: 'GET', menuPath: '/admin/product/product', uniqueAuth: 'product-product-index' },
    { id: 9998, type: 1, authType: 2, apiUrl: 'supplier/list', methods: 'GET' },
    { id: 9999, type: 1, authType: 2, apiUrl: 'supplier/list', methods: 'GET', uniqueAuth: 'product.manage', menuPath: '/product' },
  ]);
  const rules = ['product.view', 'product.view,product.manage', '2', 'supplier_directory.view', 'reply.view',
    'product.view', 'product.view', 'product.manage', '108', '9998', '9999'];
  await db.insert(systemRole).values(rules.map((rule, index) => ({ id: index + 1, rules: rule })));
  await db.insert(systemAdmin).values([
    { id: 100, account: 'selector-root', pwd: supplierOptionsPassword, level: 0 },
    ...rules.map((_rule, index) => ({ id: 101 + index, account: `selector-${index}`, pwd: supplierOptionsPassword,
      level: 1, roles: String(index + 1), adminType: index === 5 ? 4 : index === 6 ? 2 : 1,
      relationId: index === 5 ? 20 : index === 6 ? 40 : 0 })),
  ]);
  await db.insert(systemSupplier).values([
    { id: 20, adminId: 920, supplierName: '在营供应商', isShow: 1, sort: 999,
      phone: '13800138000', email: 'private@example.invalid', mark: '不应出现在选择器' },
    { id: 30, adminId: 930, supplierName: '停用供应商仍可筛选', isShow: 0, sort: -100 },
    { id: 40, adminId: 940, supplierName: '已删除不得筛选', isShow: 1, isDel: 1 },
  ]);
}
export async function supplierOptionsFixture() {
  const f = await financePostgres(Object.values(supplierOptionsSchema), { namespace: 'public' });
  await seedSupplierOptions(f.db); const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminProductCatalogReadService(container) };
}
export async function supplierOptionsSnapshot(db: DbClient) {
  const result: Record<string, unknown[]> = {};
  for (const [name, table] of Object.entries(supplierOptionsSchema))
    result[name] = [...await db.select().from(table)].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return result;
}

/** Timing only: the selected rows and all authorization still execute in the
 * actual database. Pause once after the selected table's query has completed. */
export function pauseSupplierOptionsRead(db: DbClient, table: 'system_admin' | 'system_supplier', paused: () => Promise<void>): DbClient {
  let seen = false;
  const wrap = (builder: object): object => new Proxy(builder, { get(target, property) {
    if (property === 'then') return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(target).then(async value => { if (!seen) { seen = true; await paused(); } return value; }).then(resolve, reject);
    const value: unknown = Reflect.get(target, property);
    return typeof value !== 'function' ? value : (...args: unknown[]) => {
      const next: unknown = Reflect.apply(value, target, args); return next && typeof next === 'object' ? wrap(next) : next;
    };
  } });
  const transaction = (tx: DbClient): DbClient => new Proxy(tx, { get(target, property) {
    const value: unknown = Reflect.get(target, property);
    if (property === 'select') return (...args: unknown[]) => new Proxy(Reflect.apply(value as (...args: unknown[]) => object, target, args), {
      get(builder, method) {
        const call: unknown = Reflect.get(builder, method);
        if (method === 'from') return (selected: Parameters<typeof getTableName>[0]) => {
          const query = Reflect.apply(call as (selected: unknown) => object, builder, [selected]);
          return getTableName(selected) === table ? wrap(query) : query;
        };
        return typeof call === 'function' ? call.bind(builder) : call;
      },
    });
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(db, { get(target, property) {
    const value: unknown = Reflect.get(target, property);
    if (property === 'transaction') return (work: (tx: DbClient) => Promise<unknown>, ...options: unknown[]) =>
      Reflect.apply(value as (...args: unknown[]) => unknown, target, [(tx: DbClient) => work(transaction(tx)), ...options]);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
