/** Native PG16 column/index fixture and independent non-owner SELECT-only
 * LOGIN slices. Every SELECT must exist in the actual current app/Admin plan;
 * no production commissioning, grant change or financial provider is claimed. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { storeIntegral, storeProduct, storeProductAttr, storeProductAttrValue, storeProductDescription, storeProductLabel,
  storeProductEnsure, storeBrand, systemAttachment, systemStore, systemSupplier, systemDise, systemConfig, systemForm, user } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { IntegralProductReadService } from '../../src/services/activity/IntegralProductReadService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export const integralReadBindings = { APP_KEY: 'owned-integral-product-read-key' };
export const integralReadTables = [storeIntegral, storeProduct, storeProductAttr, storeProductAttrValue, storeProductDescription, storeProductLabel,
  storeProductEnsure, storeBrand, systemAttachment, systemStore, systemSupplier, systemDise, systemConfig, systemForm, user];
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
const ident = (value: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned integral reader identifier'); return `"${value}"`; };

/** Observe real SQL on its real physical transaction after completion. It does
 * not synthesize result rows, substitute DB methods or alter transactions. */
export function observeIntegralReadDb(db: DbClient, observe: (tx: DbClient, command: string) => Promise<void>): DbClient {
  const dialect = new PgDialect();
  const builder = (target: object, tx: DbClient): object => new Proxy(target, { get(object, key, receiver) {
    const method: unknown = Reflect.get(object, key, receiver); if (typeof method !== 'function') return method;
    if (key === 'then') return (fulfilled: (value: unknown) => unknown, rejected: (error: unknown) => unknown) => Reflect.apply(method, object, [async (rows: unknown) => {
      const statement = Reflect.get(object, 'toSQL') as () => { sql: string }; await observe(tx, Reflect.apply(statement, object, []).sql); return fulfilled ? fulfilled(rows) : rows;
    }, rejected]);
    return (...args: unknown[]) => { const result: unknown = Reflect.apply(method, object, args);
      return result && typeof result === 'object' && typeof Reflect.get(result, 'then') === 'function' ? builder(result, tx) : result; };
  }});
  return new Proxy(db, { get(target, key, receiver) {
    const method: unknown = Reflect.get(target, key, receiver); if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (callback: (tx: DbClient) => unknown, ...options: unknown[]) => Reflect.apply(method, target, [(tx: DbClient) => callback(new Proxy(tx, { get(transaction, property, transactionReceiver) {
      const operation: unknown = Reflect.get(transaction, property, transactionReceiver); if (typeof operation !== 'function') return operation;
      if (property === 'select') return (...args: unknown[]) => builder(Reflect.apply(operation, transaction, args), transaction);
      if (property === 'execute') return async (...args: unknown[]) => {
        if (!(args[0] instanceof SQL)) throw Error('Integral observer requires real SQL');
        const command = dialect.sqlToQuery(args[0]).sql, result: unknown = await Reflect.apply(operation, transaction, args); await observe(transaction, command); return result;
      };
      return operation.bind(transaction);
    }})), ...options]);
  }});
}

export async function integralProductReadFixture(options: { extraTables?: PgTable[] } = {}) {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('Integral read fixture requires native PG16 independent LOGINs'); }
  try {
    const tables = [...new Map([...integralReadTables, ...(options.extraTables ?? [])].map(table => [getTableConfig(table).name, table])).values()];
    const dialect = new PgDialect();
    for (const table of tables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const value = column.default, initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `${ident(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${ident(definition.name)} (${columns.join(',')})`);
      // Keep actual ordinary/unique ORM indexes. Shipping expression indexes
      // belong to their full migration, outside this finite read-only fixture.
      for (const index of definition.indexes) {
        const value = index.config;
        if (value.where || value.columns.some(column => !('name' in column) || typeof column.name !== 'string')) continue;
        const names = value.columns.map(column => ident(String(Reflect.get(column, 'name'))));
        await f.exec(`CREATE ${value.unique ? 'UNIQUE ' : ''}INDEX ${ident(value.name!)} ON public.${ident(definition.name)} (${names.join(',')})`);
      }
    }
    await f.db.insert(storeProduct).values({ id: 70, type: 0, relationId: 0, storeName: '基础商品', productType: 0, stock: 20, isShow: 1, isDel: 0, isVerify: 1,
      image: '/api/assets/41', price: '25.00', otPrice: '35.00', brandId: 3, specType: 1 });
    await f.db.insert(storeIntegral).values({ id: 9, productId: 70, storeName: '积分商品', type: 0, relationId: 0, productType: 0, unitName: '件', image: '/api/assets/41',
      images: JSON.stringify(['/api/assets/41', '/legacy/gallery.png']), integral: 5, price: '1.00', otPrice: '99.00', stock: 20, quota: 15, sales: 2,
      onceNum: 3, num: 8, status: 1, isShow: 1, isDel: 0, systemFormId: 3, deliveryType: '1,2', storeLabelId: '1', ensureId: '2', specs: JSON.stringify([{ name: '材质', value: '纯棉', sort: 2 }]),
      customForm: 'PRIVATE HISTORICAL CUSTOMER FORM' });
    await f.db.insert(storeProductAttr).values({ id: 1, productId: 9, type: 4, attrName: '颜色', attrValues: '红,蓝' });
    await f.db.insert(storeProductAttrValue).values([
      { id: 80, productId: 70, type: 0, unique: 'base0070', suk: '红', stock: 12, price: '25.00', cost: '11.00' },
      { id: 81, productId: 70, type: 0, unique: 'blue0070', suk: '蓝', stock: 12, price: '25.00', cost: '11.00' },
      { id: 90, productId: 9, type: 4, unique: 'red00009', suk: '红', stock: 20, quota: 8, price: '1.00', otPrice: '35.00', integral: 5, image: '/api/assets/41', cost: '11.00', settlePrice: '14.00', diskInfo: 'PRIVATE CARD DATA' },
      { id: 91, productId: 9, type: 4, unique: 'blue0009', suk: '蓝', stock: 10, quota: 6, price: '4.25', otPrice: '35.00', integral: 10, image: '/api/assets/41' },
    ]);
    await f.db.insert(storeProductDescription).values([{ productId: 9, type: 4, description: '<p>积分正文<img src="/api/assets/41"><img src="/api/assets/43" onerror="alert(1)"></p>' },
      { productId: 9, type: 0, description: 'WRONG TYPE BODY' }, { productId: 70, type: 0, description: 'BASE PRIVATE BODY' }]);
    await f.db.insert(storeProductLabel).values({ id: 1, type: 0, relationId: 0, labelName: '棉质', color: '#fff', bgColor: '#000', icon: '/api/assets/41' });
    await f.db.insert(storeProductEnsure).values({ id: 2, type: 0, relationId: 0, name: '正品保障', image: '/api/assets/41', desc: '保障说明', status: 1 });
    await f.db.insert(storeBrand).values({ id: 3, brandName: '真实品牌', isShow: 1, isDel: 0 });
    await f.db.insert(systemDise).values({ id: 5, templateName: 'product_detail', type: 3, value: '{"showService":[2]}' });
    await f.db.insert(systemForm).values({ id: 3, name: '商品表单', status: 1, isDel: 0, value: '[]' });
    await f.db.insert(systemConfig).values([{ id: 1, menuName: 'site_name', value: '"积分商城"', sort: 10 }, { id: 2, menuName: 'site_name', value: '"低优先级"', sort: 0 },
      { id: 3, menuName: 'share_qrcode', value: '1' }, { id: 4, menuName: 'product_poster_title', value: '"兑换分享"' }]);
    await f.db.insert(systemStore).values({ id: 77, name: '实际门店', isShow: 1, isDel: 0, isStore: 1 });
    await f.db.insert(systemSupplier).values([{ id: 88, adminId: 188, supplierName: '实际供应商', isShow: 1, isDel: 0 }, { id: 89, adminId: 189, supplierName: '另一供应商', isShow: 1, isDel: 0 }]);
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/integral.png', attDir: '/api/assets/41', attType: 'image/png' },
      { attId: 42, type: 4, relationId: 88, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/supplier/88/2026/10/integral.png', attDir: '/api/assets/42', attType: 'image/png' },
      { attId: 43, type: 4, relationId: 89, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/supplier/89/2026/10/private.png', attDir: '/api/assets/43', attType: 'image/png' },
      { attId: 44, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/invalid.png', attDir: '/api/assets/44', attType: 'text/html' },
    ]);
    await f.db.insert(user).values({ uid: 11, account: 'integral-reader', pwd: 'owned-integral-password', status: 1, isDel: 0 });
    const installSelectSlice = async (peer: Peer, kind: 'app' | 'admin') => {
      const plan = runtimeBusinessPrivilegePlan(kind);
      for (const table of tables) {
        const name = getTableConfig(table).name;
        if (!plan.tables[name]?.includes('SELECT')) throw Error(`${kind} production profile cannot read ${name}`);
        await f.exec(`GRANT SELECT ON public.${ident(name)} TO ${ident(peer.role)}`);
      }
    };
    const serviceFor = (db: DbClient = f.db) => new IntegralProductReadService(createContainerFromDb(db), integralReadBindings);
    const snapshot = async () => {
      const result: Record<string, unknown[]> = {};
      for (const table of tables) result[getTableConfig(table).name] = await f.db.select().from(table);
      return result;
    };
    return { ...f, tables, env: integralReadBindings, serviceFor, snapshot, installSelectSlice, withRuntimeRole: f.withRuntimeRole, withPeer: f.withPeer };
  } catch (error) { await f.close(); throw error; }
}
