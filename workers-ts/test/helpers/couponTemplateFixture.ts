import { sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { storeCouponTemplate, storeCouponTemplateIssue, storeCouponIssue, storeCouponProduct, storeCouponUser, storeCouponIssueUser,
  storeProduct, storeProductCategory, storeProductCoupon, storeOrder, storeOrderCartInfo, storeOrderProductCouponReward,
  user, userBill, userMoney, systemLog } from '../../src/models/schema';
import { COUPON_PRODUCT_SCOPE_FENCE_SQL } from '../../src/migrations/couponProductScopeFence';
import { AdminCouponTemplateService } from '../../src/services/admin/AdminCouponTemplateService';
import { financePostgres } from './financePostgres';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ownsSequenceRunnerEndpoint, validateSequenceRunnerTestUrl, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export type CouponTemplateRuntimePeer = SequenceRunnerPeer & { role: string; connectionString: string };
/** An additional genuine LOGIN using the already commissioned synthetic role.
 * Only the exact process-owned loopback fixture/endpoint may be reused. */
export async function withCouponTemplatePeer<T>(origin: CouponTemplateRuntimePeer,
  run: (peer: SequenceRunnerPeer & { role: string }) => Promise<T>): Promise<T> {
  const base = validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const [owned] = await origin.db.execute(sql`SELECT current_database() AS database,current_schema() AS schema,current_user AS role,
    session_user AS session,host(inet_server_addr()) AS host,inet_server_port() AS port`);
  const target = new URL(origin.connectionString);
  if (!owned || owned.role !== origin.role || owned.session !== origin.role || !/^cinashop_runtime_[a-f0-9]{32}$/.test(origin.role)
    || !ownsSequenceRunnerEndpoint(String(owned.database), String(owned.schema), base.href, owned.host, owned.port)
    || target.hostname !== base.hostname || target.port !== base.port || target.username !== origin.role
    || target.pathname !== `/${owned.database}` || target.search || target.hash) throw Error('Additional coupon peer requires exact owned runtime LOGIN');
  const client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
    connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=8000' } });
  try {
    const identity = async () => {
      const [row] = await client`SELECT current_database() AS database,current_schema() AS schema,current_user AS role,session_user AS session,
        host(inet_server_addr()) AS host,inet_server_port() AS port,pg_backend_pid() AS pid,current_setting('server_version_num') AS version`;
      if (row.database !== owned.database || row.schema !== 'public' || row.role !== origin.role || row.session !== origin.role
        || row.host !== owned.host || row.port !== owned.port || Math.floor(Number(row.version) / 10000) !== 16 || Number(row.pid) === origin.pid)
        throw Error('Additional coupon peer identity/endpoint drift');
      return Number(row.pid);
    };
    const pid = await identity(), result = await run({ db: drizzle(client) as unknown as DbClient, pid, role: origin.role,
      exec: async statement => Array.from(await client.unsafe(statement)) });
    if (await identity() !== pid) throw Error('Additional coupon peer unexpectedly reconnected');
    return result;
  } finally { await client.end({ timeout: 1 }); }
}

/** Observe actual SQL/results only after the underlying transaction executes.
 * The callback can use a genuine independent peer for snapshot-race witnesses. */
export function observeCouponTemplateDb(db: DbClient, observe: (tx: DbClient, command: string) => Promise<void>): DbClient {
  const builder = (target: object, tx: DbClient): object => new Proxy(target, { get(object, key, receiver) {
    const method: unknown = Reflect.get(object, key, receiver);
    if (typeof method !== 'function') return method;
    if (key === 'then') return (fulfilled: (value: unknown) => unknown, rejected: (error: unknown) => unknown) =>
      Reflect.apply(method, object, [async (rows: unknown) => {
        const statement = Reflect.get(object, 'toSQL') as () => { sql: string };
        await observe(tx, Reflect.apply(statement, object, []).sql);
        return fulfilled ? fulfilled(rows) : rows;
      }, rejected]);
    return (...args: unknown[]) => {
      const result: unknown = Reflect.apply(method, object, args);
      return result && typeof result === 'object' && typeof Reflect.get(result, 'then') === 'function' ? builder(result, tx) : result;
    };
  } });
  return new Proxy(db, { get(target, key, receiver) {
    const method: unknown = Reflect.get(target, key, receiver);
    if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (callback: (tx: DbClient) => unknown, ...options: unknown[]) => Reflect.apply(method, target, [(tx: DbClient) =>
      callback(new Proxy(tx, { get(transaction, property, transactionReceiver) {
        const operation: unknown = Reflect.get(transaction, property, transactionReceiver);
        if (typeof operation !== 'function') return operation;
        if (property === 'select') return (...args: unknown[]) => builder(Reflect.apply(operation, transaction, args), transaction);
        if (property === 'execute') return async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(operation, transaction, args);
          // Raw observation here is for settings, not query text fabrication.
          await observe(transaction, 'execute'); return result;
        };
        return operation.bind(transaction);
      } })), ...options]);
  } });
}

export const couponTemplateTables = [storeCouponTemplate, storeCouponTemplateIssue, storeCouponIssue, storeCouponProduct, storeCouponUser,
  storeCouponIssueUser, storeProduct, storeProductCategory, storeProductCoupon, storeOrder, storeOrderCartInfo,
  storeOrderProductCouponReward, user, userBill, userMoney, systemLog];
export const templateBody = (overrides: Record<string, unknown> = {}) => ({ request_id: crypto.randomUUID(), title: '新模板', scope_type: 2,
  category_id: 0, product_ids: [4101, 4100], coupon_price: '5.1', use_min_price: '10', valid_days: 7, sort: 3, status: 1, ...overrides });
export const publicationBody = (id: number, revision: string, overrides: Record<string, unknown> = {}) => ({
  request_id: crypto.randomUUID(), template_id: id, revision, receive_type: 1, status: 1, is_permanent: 0, count: 5,
  start_time: null, end_time: null, full_reduction: '0', ...overrides });
export async function seedCouponTemplates(db: DbClient) {
  await db.insert(storeProductCategory).values([{ id: 4001, cateName: '真实商品分类', pid: 0 },
    { id: 4002, cateName: '隐藏分类', isShow: 0 }]);
  await db.insert(storeProduct).values([{ id: 4100, storeName: '选择商品%_', stock: 10, cateId: '4001' },
    { id: 4101, storeName: '另一商品', stock: 10 }, { id: 4102, storeName: '已删除商品', isDel: 1 }]);
  await db.insert(user).values({ uid: 4110, account: 'coupon-template-synthetic-user', nickname: '合成领取用户' });
  const fields = { couponPrice: '5.00', useMinPrice: '10.00', validDays: 7, addTime: 100, status: 1 };
  await db.insert(storeCouponTemplate).values([
    { ...fields, id: 45001, title: '模板%_', scopeType: 2, productIds: '4100,4101', sort: 3 },
    { ...fields, id: 45002, title: '分类模板', scopeType: 1, categoryId: 4001, sort: 2 },
    { ...fields, id: 45003, title: '失效通用模板', scopeType: 0, status: 0 },
    { ...fields, id: 45004, title: '删除模板', scopeType: 0, isDel: 1 },
    { ...fields, id: 45005, title: '旧选择商品已删', scopeType: 2, productIds: '4102' },
  ]);
  // Positive cid collides with a future source identity; it is NOT proof.
  await db.insert(storeCouponIssue).values({ id: 46001, cid: 1, couponType: 0, couponTitle: '历史孤儿cid', title: '历史孤儿cid',
    couponPrice: '3.00', useMinPrice: '0.00', category: 0, appType: 0, receiveType: 1, day: 7, totalCount: 3, remainCount: 3 });
}
export async function couponTemplateSnapshot(db: DbClient) {
  const result: Record<string, unknown> = {};
  for (const table of ['store_coupon_template', 'store_coupon_template_issue', 'store_coupon_issue', 'store_coupon_product',
    'store_coupon_user', 'store_coupon_issue_user', 'store_product_coupon', 'store_order_product_coupon_reward', 'system_log'])
    result[table] = Array.from(await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)));
  return result;
}
export async function couponTemplateFixture() {
  const f = await financePostgres(couponTemplateTables, { namespace: 'public' });
  try {
    await f.exec(COUPON_PRODUCT_SCOPE_FENCE_SQL);
    await seedCouponTemplates(f.db);
    return { ...f, container: createContainerFromDb(f.db), service: new AdminCouponTemplateService(createContainerFromDb(f.db), 'synthetic-unused-key'),
      snapshot: () => couponTemplateSnapshot(f.db) };
  } catch (error) { await f.close(); throw error; }
}
