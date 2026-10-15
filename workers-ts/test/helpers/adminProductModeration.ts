import { eq, getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeCart, storeProduct, storeProductAttrValue, storeProductRelation, systemAdmin, systemLog, systemMenus, systemRole } from '@/models/schema';
import { AdminProductModerationService } from '@/services/admin/AdminProductModerationService';
import { financePostgres } from './financePostgres';
import { resetStockSequences, seedStocks, stockActor, stockSchema } from './adminProductStocks';

export const moderationSchema = { ...stockSchema, storeCart, storeProductRelation };
export const moderationActor = stockActor;
export const moderationBody = (is_verify: -2 | -1 | 1 = 1, is_show: 0 | 1 | 2 = 1) => ({ id: 20, is_verify, is_show, refusal: is_verify === 1 ? '' : '审核原因', auto_on_time: '' });

export async function seedModeration(db: DbClient) {
  await seedStocks(db);
  await db.update(storeProduct).set({ isVerify: 0, isShow: 0, refusal: '此前原因', autoOffTime: 1700000123 }).where(eq(storeProduct.id, 10));
  await db.insert(storeProduct).values({ id: 100, pid: 10, type: 1, relationId: 30, storeName: '原商品副本不随审核变动', isVerify: 0, isShow: 1, stock: 40 });
  await db.update(storeProductAttrValue).set({ settlePrice: '12.01' }).where(eq(storeProductAttrValue.id, 11));
  await db.update(storeProductAttrValue).set({ price: '4.00', settlePrice: '4.00' }).where(eq(storeProductAttrValue.id, 13));
  await db.update(storeProductAttrValue).set({ price: '0.00', settlePrice: '1000.00' }).where(eq(storeProductAttrValue.id, 14));
  await db.update(storeProductAttrValue).set({ price: '2.00', settlePrice: '3.00' }).where(eq(storeProductAttrValue.id, 91));
  await db.insert(storeCart).values([
    { id: 201, uid: 1, productId: 10, productAttrUnique: 'stock001', status: 1 },
    { id: 202, uid: 2, productId: 10, productAttrUnique: 'stock002', status: 0 },
    { id: 203, uid: 3, productId: 10, productAttrUnique: 'old00001', status: 2 },
    { id: 204, uid: 1, productId: 20, productAttrUnique: 'supply01', status: 1 },
    { id: 205, uid: 4, productId: 10, type: 1, productAttrUnique: 'seckill1', status: 1, isPay: 1, isDel: 1, isNew: 1 },
  ]);
  await db.insert(storeProductRelation).values([{ id: 201, productId: 10, type: 1, relationId: 8, relationPid: 7, status: 1 },
    { id: 202, productId: 20, type: 2, relationId: 9, status: 1 }]);
  await db.insert(systemLog).values({ id: 1, adminId: 100, path: 'product/product/set_verify/10', method: 'POST', type: 'legacy_review', action: 'historical immutable review', addTime: 100 });
  const claims = [
    { id: 1001, apiUrl: 'product/product/verify/<id>', methods: 'GET', menuPath: '', uniqueAuth: '' },
    { id: 1002, apiUrl: 'product/product/remove/<id>', methods: 'GET', menuPath: '', uniqueAuth: 'product.manage' },
    { id: 1003, apiUrl: 'product/product/get_verify/<id>', methods: 'GET', menuPath: '', uniqueAuth: '' },
    { id: 1004, apiUrl: 'product/product/set_verify/<id>', methods: 'POST', menuPath: '', uniqueAuth: '' },
    { id: 1005, apiUrl: 'home/header', methods: 'GET', menuPath: '/adminproduct/product/set_verify/<id>', uniqueAuth: 'product.manage' },
  ];
  await db.insert(systemMenus).values(claims.map(row => ({ ...row, type: 1, authType: 2 })));
  await db.insert(systemRole).values(claims.map((row, index) => ({ id: 9 + index, rules: String(row.id) })));
  await db.insert(systemAdmin).values(claims.map((_, index) => ({ id: 110 + index, account: `moderation-${110 + index}`, pwd: 'stock-fixture-password', level: 1, roles: String(9 + index) })));
}

export async function moderationFixture() {
  const fixture = await financePostgres(Object.values(moderationSchema), { namespace: 'public' });
  await seedModeration(fixture.db); await resetStockSequences(fixture.exec);
  const container = createContainerFromDb(fixture.db);
  return { ...fixture, container, service: new AdminProductModerationService(container) };
}
export async function moderationSnapshot(db: DbClient): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [name, table] of Object.entries(moderationSchema)) result[name] = (await db.select().from(table)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return result;
}
export async function moderationRows(db: DbClient, id = 10) {
  const [product] = await db.select().from(storeProduct).where(eq(storeProduct.id, id));
  const carts = await db.select().from(storeCart).where(eq(storeCart.productId, id));
  return { product, carts: carts.sort((a, b) => a.id - b.id) };
}

/** Pause only AFTER a real production query returned its unchanged rows.
 * This hook never fabricates SQL, results, transactions or lock outcomes. */
export function pauseModerationQuery(db: DbClient, tableName: string, paused: () => Promise<void>): DbClient {
  let seen = false;
  const wrap = (builder: object): object => new Proxy(builder, { get(target, key) {
    if (key === 'then') return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(target).then(async value => { if (!seen) { seen = true; await paused(); } return value; }).then(resolve, reject);
    const method: unknown = Reflect.get(target, key);
    return typeof method !== 'function' ? method : (...args: unknown[]) => {
      const next: unknown = Reflect.apply(method, target, args); return next && typeof next === 'object' ? wrap(next) : next;
    };
  } });
  return wrapTransaction(db, tx => new Proxy(tx, { get(target, key) {
    const method: unknown = Reflect.get(target, key);
    if (key === 'select') return (...args: unknown[]) => {
      const builder = Reflect.apply(method as (...args: unknown[]) => object, target, args);
      return new Proxy(builder, { get(selection, property) {
        const operation: unknown = Reflect.get(selection, property);
        if (property === 'from') return (table: Parameters<typeof getTableName>[0]) => {
          const query = Reflect.apply(operation as (table: unknown) => object, selection, [table]);
          return getTableName(table) === tableName ? wrap(query) : query;
        };
        return typeof operation === 'function' ? operation.bind(selection) : operation;
      } });
    };
    return typeof method === 'function' ? method.bind(target) : method;
  } }));
}
export function pauseModerationExecute(db: DbClient, match: RegExp, paused: () => Promise<void>): DbClient {
  const dialect = new PgDialect(); let seen = false;
  return wrapTransaction(db, tx => new Proxy(tx, { get(target, key) {
    const operation: unknown = Reflect.get(target, key);
    if (key === 'execute') return async (...args: unknown[]) => {
      const result: unknown = await Reflect.apply(operation as (...args: unknown[]) => unknown, target, args);
      if (!seen && match.test(dialect.sqlToQuery(args[0] as Parameters<PgDialect['sqlToQuery']>[0]).sql)) { seen = true; await paused(); }
      return result;
    };
    return typeof operation === 'function' ? operation.bind(target) : operation;
  } }));
}
function wrapTransaction(db: DbClient, wrap: (tx: DbClient) => DbClient): DbClient {
  return new Proxy(db, { get(target, key) {
    const operation: unknown = Reflect.get(target, key);
    if (key === 'transaction') return (work: (tx: DbClient) => unknown, ...options: unknown[]) =>
      Reflect.apply(operation as (...args: unknown[]) => unknown, target, [(tx: DbClient) => work(wrap(tx)), ...options]);
    return typeof operation === 'function' ? operation.bind(target) : operation;
  } });
}
