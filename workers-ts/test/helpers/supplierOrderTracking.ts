import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, systemSupplier, systemRole, systemMenus, systemConfig, storeOrder, storeOrderCartInfo, storeOrderStatus,
  storeProduct, storeProductAttrValue, userBill, systemFormData } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres, ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';
import { SupplierOrderTrackingService } from '@/services/supplier/SupplierOrderTrackingService';

export const supplierTrackingAppKey = 'owned-supplier-tracking-http-key';
export const supplierTrackingPassword = 'owned-supplier-tracking-password';
export const supplierTrackingActor = (id = 22) => ({ id, supplierId: id === 31 ? 8 : 7,
  authVersion: md5(supplierTrackingPassword), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const supplierTrackingIds = { single: 100, root: 200, first: 201, second: 202, platform: 300, allocated: 301, foreign: 900 } as const;
const schema = { systemAdmin, systemSupplier, systemRole, systemMenus, systemConfig, storeOrder, storeOrderCartInfo, storeOrderStatus,
  storeProduct, storeProductAttrValue, userBill, systemFormData };
export type SupplierTrackingSnapshot = Record<string, Array<{ row: Record<string, unknown> }>>;
export async function supplierOrderTrackingFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native owned PG16 required for tracking');
  const f = await financePostgres(Object.values(schema), { namespace: 'public' });
  try {
    await f.db.insert(systemSupplier).values([{ id: 7, adminId: 29, supplierName: '本店物流' }, { id: 8, adminId: 39, supplierName: '外店物流' }]);
    await f.db.insert(systemRole).values([{ id: 21, type: 4, relationId: 7, rules: 'supplier.order.manage' },
      { id: 22, type: 4, relationId: 7, rules: 'supplier.order.view' }, { id: 23, type: 4, relationId: 7, rules: 'supplier.product.view' },
      { id: 31, type: 4, relationId: 8, rules: 'supplier.order.view' }]);
    await f.db.insert(systemAdmin).values([21, 22, 23, 29, 31, 39].map(id => ({ id, account: 'owned-tracking-' + id,
      pwd: supplierTrackingPassword, adminType: 4, relationId: id >= 30 ? 8 : 7, roles: [29, 39].includes(id) ? '' : String(id), level: [29, 39].includes(id) ? 0 : 1 })));
    const order = (id: number, overrides: Partial<typeof storeOrder.$inferInsert> = {}) => ({ id, orderId: 'tracking-own-' + id,
      uid: 11, supplierId: 7, storeId: 1, paid: 1, status: 1, shippingType: 1, deliveryType: 'express',
      deliveryName: '本机真实快递', deliveryCode: 'zhongtong', deliveryId: 'OWN-' + id, userPhone: '13800138000', ...overrides });
    await f.db.insert(storeOrder).values([
      order(100), order(200, { pid: -1, deliveryType: 'split', deliveryId: '' }),
      order(201, { pid: 200, orderId: 'tracking-child-201', deliveryId: 'CHILD-201' }),
      order(202, { pid: 200, orderId: 'tracking-child-202', deliveryId: 'CHILD-202' }),
      order(300, { pid: -1, supplierId: 0, storeId: 0, supplierAllocationStatus: 2, deliveryType: 'split', deliveryId: '' }),
      order(301, { pid: 300, storeId: 2, orderId: 'tracking-allocation-301', deliveryId: 'ALLOC-301' }),
      order(900, { supplierId: 8, deliveryId: 'FOREIGN-900' }),
    ]);
    await f.db.insert(storeOrderStatus).values({ oid: 100, changeType: 'delivery_goods', changeMessage: '既有订单状态，不是承运商节点', changeTime: 100 });
    await f.db.insert(storeOrderCartInfo).values({ id: 1001, oid: 100, uid: 11, type: 2, relationId: 7, productId: 70,
      skuUnique: 'tracksku', cartNum: 1, cartInfo: '{"product":{"id":70,"storeName":"物流历史商品"},"sku":{"suk":"默认"}}' });
    await f.db.insert(storeProduct).values({ id: 70, type: 2, relationId: 7, storeName: '物流历史商品', price: '12.00', stock: 8 });
    await f.db.insert(storeProductAttrValue).values({ id: 70, productId: 70, unique: 'tracksku', suk: '默认', price: '12.00', stock: 8 });
    await f.db.insert(userBill).values({ uid: 11, title: '不可变历史支付', category: 'now_money', type: 'pay_product', number: '12.00' });
    await f.db.insert(systemFormData).values({ uid: 11, systemFormId: '71', relationId: 100, value: 'PRIVATE-UNCHANGED-ANSWER' });
    const cache = new Map<string, string>(), cacheReads: string[] = [], cacheWrites: Array<{ key: string; value: string; ttl: number | undefined }> = [];
    const kv = { get: async (key: string, kind?: string) => { cacheReads.push(key); const value = cache.get(key); return value === undefined ? null : kind === 'json' ? JSON.parse(value) : value; },
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => { cacheWrites.push({ key, value, ttl: options?.expirationTtl }); cache.set(key, value); },
      delete: async (key: string) => { cache.delete(key); } };
    const env = { APP_KEY: supplierTrackingAppKey, NODE_ENV: 'test', CONFIG_KV: kv, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as unknown as Env;
    const tokens = { manager: '', viewer: '', denied: '', foreign: '', admin: '', customer: '', kefu: '' };
    for (const [name, id, type] of [['manager', 21, 'supplier'], ['viewer', 22, 'supplier'], ['denied', 23, 'supplier'], ['foreign', 31, 'supplier'], ['admin', 22, 'admin'], ['customer', 22, 'api'], ['kefu', 22, 'kefu']] as const)
      tokens[name] = (await createToken(id, type, md5(supplierTrackingPassword), supplierTrackingAppKey)).token;
    async function snapshot(): Promise<SupplierTrackingSnapshot> {
      const state: SupplierTrackingSnapshot = {};
      for (const row of await f.exec("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename") as Array<{ tablename: string }>) {
        if (!/^[a-z][a-z0-9_]*$/.test(row.tablename)) throw Error('Unowned tracking table');
        state[row.tablename] = await f.exec(`SELECT to_jsonb(t) AS row FROM public."${row.tablename}" t ORDER BY to_jsonb(t)::text`) as unknown as SupplierTrackingSnapshot[string];
      }
      return state;
    }
    const sequences = async () => Promise.all((await f.exec("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename") as Array<{ sequencename: string }>).map(async row => {
      if (!/^[a-z][a-z0-9_]*$/.test(row.sequencename)) throw Error('Unowned tracking sequence');
      return { name: row.sequencename, ...(await f.exec(`SELECT last_value,is_called FROM public."${row.sequencename}"` ) as Array<{ last_value: string; is_called: boolean }>)[0] };
    }));
    const grantReader = async (role: string) => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unowned tracking LOGIN');
      await f.exec(`GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.system_config,public.store_order,public.store_order_cart_info,public.store_order_status TO "${role}"`);
    };
    const withReader = async <T>(work: (runtime: { db: DbClient; container: ReturnType<typeof createContainerFromDb>; role: string; pid: number; exec: (query: string) => Promise<unknown> }) => Promise<T>): Promise<T> => {
      const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? ''), role = 'cinashop_runtime_' + randomUUID().replaceAll('-', ''), password = randomUUID().replaceAll('-', '');
      const [identity] = await f.db.execute<{ database: string; host: string; port: number }>(sql`SELECT current_database() AS database,host(inet_server_addr()) AS host,inet_server_port() AS port`);
      if (!ownsFinanceFixtureEndpoint(identity.database, 'public', base.href, identity.host, identity.port)) throw Error('Unowned tracking endpoint');
      let client: ReturnType<typeof postgres> | undefined;
      await f.exec(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      try {
        await grantReader(role); const url = new URL(base.href); url.pathname = '/' + identity.database; url.username = role; url.password = password;
        client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
          connection: { options: '-c search_path=public,pg_temp -c statement_timeout=5000' } });
        const db = drizzle(client) as unknown as DbClient;
        const [peer] = await db.execute<{ independent: boolean; database: string; role: string; pid: number }>(sql`SELECT current_user=session_user AS independent,current_database() AS database,current_user AS role,pg_backend_pid() AS pid`);
        if (!peer.independent || peer.database !== identity.database || peer.role !== role) throw Error('Tracking LOGIN identity mismatch');
        return await work({ db, container: createContainerFromDb(db), role, pid: peer.pid, exec: query => client!.unsafe(query) });
      } finally { await client?.end({ timeout: 5 }); await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); }
    };
    const provider = async (enabled = true) => {
      await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'logistics_type'));
      await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'system_express_app_code'));
      await f.db.insert(systemConfig).values([{ menuName: 'logistics_type', value: enabled ? '2' : '0' }, { menuName: 'system_express_app_code', value: 'OWNED-PROVIDER-KEY' }]);
    };
    return { ...f, env, tokens, ids: supplierTrackingIds, actor: supplierTrackingActor, container: createContainerFromDb(f.db),
      snapshot, sequences, grantReader, withReader, provider, cache, cacheReads, cacheWrites,
      service: (db: DbClient) => new SupplierOrderTrackingService(createContainerFromDb(db), env) };
  } catch (error) { await f.close(); throw error; }
}
