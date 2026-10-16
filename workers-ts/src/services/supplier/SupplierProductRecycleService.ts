import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, systemLog } from '@/models/schema';
import { boundBargainSourceProductChange, lockBargainSourceProductChange } from '@/services/activity/BargainSourceProductLifecycle';
import { tryLockProductWrite } from '@/services/product/ProductAssociationService';
import { PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE, PRODUCT_SKU_IDENTITY_LOCK_KEY } from '@/services/product/ProductSkuIdentity';
import { assertSupplierVideoAuthority, type SupplierVideoActor } from './SupplierVideoAuthority';
import { assertProductRecycleSkuGuardReady } from '@/migrations/productRecycleSkuGuard';
import { AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

export type SupplierRecycleActor = SupplierVideoActor & { ip?: string };
export interface SupplierRecycleOptions { expectedIsDel?: 0 | 1 }
const MAX_ROWS = 10_000, MAX_BYTES = 4 * 1024 * 1024;
const conflict = () => new HttpApiException('商品、关联数据或供应商权限已变化，请刷新核对原商品', 409, 409);
export function supplierRecycleId(value: unknown): number {
  const n = typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new ValidateException('商品ID错误');
  return n;
}
export function supplierRecycleOptions(value: unknown, thorough = false): SupplierRecycleOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'expected_is_del')) throw new ValidateException('商品回收参数格式错误');
  const expected = (value as Record<string, unknown>).expected_is_del;
  if (expected !== undefined && (thorough ? expected !== 1 : expected !== 0 && expected !== 1)) throw new ValidateException('商品回收原状态错误');
  return expected === undefined ? {} : { expectedIsDel: expected as 0 | 1 };
}
function canonical(value: unknown): string {
  function ordered(item: unknown): unknown { return Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, ordered(val)])) : item; }
  return JSON.stringify(ordered(value));
}
function sameRows(a: unknown[], b: unknown[]) { return canonical(a.map(canonical).sort()) === canonical(b.map(canonical).sort()); }
function rethrow(error: unknown): never {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const code = 'code' in current ? String(current.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(conflict(), { cause: error });
    if (['42501', '57014', '42P01', '42883'].includes(code)) throw Object.assign(new ServiceUnavailableException('供应商商品回收权限或维护协议未就绪，请查询原结果'), { cause: error });
    current = 'cause' in current ? current.cause : undefined;
  }
  throw error;
}
const sets = [
  ['store_product', 'id', null],
  ['store_product_attr', 'product_id', 'type'],
  ['store_product_attr_result', 'product_id', 'type'],
  ['store_product_attr_value', 'product_id', 'type'],
  ['store_product_description', 'product_id', 'type'],
  ['store_product_relation', 'product_id', null],
  ['store_product_coupon', 'product_id', null],
  ['user_relation', 'relation_id', 'category'],
  ['store_product_reply', 'product_id', null],
  ['community_relevance', 'right_id', 'type'],
  ['store_cart', 'product_id', null],
  ['store_product_sku_retirement_log', 'product_id', null],
] as const;
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
function deletionRow(table: string, row: Row) {
  if (['store_product_attr', 'store_product_attr_result', 'store_product_attr_value', 'store_product_description'].includes(table)) return row.type === 0;
  if (table === 'user_relation') return row.category === 'product';
  if (table === 'community_relevance') return row.type === 'community_product';
  return !['store_cart', 'store_product_sku_retirement_log'].includes(table);
}
async function snapshot(tx: DbClient, id: number): Promise<Snapshot> {
  const result: Snapshot = {}; let bytes = 0;
  for (const [table, column] of sets) {
    const [state] = await tx.execute(sql`WITH bounded AS MATERIALIZED (
      SELECT to_jsonb(r) AS value FROM ONLY ${sql.identifier(table)} r WHERE ${sql.identifier(column)}=${id} LIMIT ${MAX_ROWS + 1}
    ) SELECT count(*)::integer AS count,COALESCE(sum(octet_length(value::text)),0)::integer AS bytes,
      CASE WHEN count(*)<=${MAX_ROWS} AND COALESCE(sum(octet_length(value::text)),0)<=${MAX_BYTES}
        THEN COALESCE(jsonb_agg(value),'[]'::jsonb) ELSE '[]'::jsonb END AS rows FROM bounded`);
    if (!state || !Number.isSafeInteger(state.count) || Number(state.count) > MAX_ROWS || !Number.isSafeInteger(state.bytes)
      || !Array.isArray(state.rows) || (bytes += Number(state.bytes)) > MAX_BYTES) throw new ServiceUnavailableException('商品完整关联超过回收容量，请先维护整理');
    result[table] = state.rows as Row[];
  }
  return result;
}
async function verify(tx: DbClient, id: number, expected: Snapshot) {
  const actual = await snapshot(tx, id);
  if (sets.some(([name]) => !sameRows(actual[name], expected[name]))) throw conflict();
}
async function clock(tx: DbClient, actor: SupplierRecycleActor) {
  const [row] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  if (!row || !Number.isSafeInteger(row.now) || Number(row.now) < 0 || Number(row.now) >= actor.expiresAt) throw new AuthException('供应商会话已过期，请重新登录', 410001);
  return Number(row.now);
}
function query(input: URLSearchParams, header = false) {
  const allowed = ['page', 'limit', 'id', 'store_name', 'is_show', 'is_verify', 'is_del', 'type'];
  for (const key of input.keys()) if (!allowed.includes(key) || input.getAll(key).length !== 1) throw new ValidateException('商品回收查询参数未知或重复');
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = input.get(key); if (raw === null || raw === '') return fallback;
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new ValidateException('商品查询整数参数错误');
    return Number(raw);
  };
  const page = integer('page', 1, 1, 100001), limit = integer('limit', 20, 1, 100);
  const type = input.has('type') && input.get('type') !== '' ? integer('type', 1, -2, 7) : undefined;
  const all = input.get('is_del') === 'all';
  const isDel = all ? 'all' as const : input.has('is_del') && input.get('is_del') !== '' ? integer('is_del', 0, 0, 1) : undefined;
  if (all && (header || !input.has('id') || type !== undefined || limit !== 1 || page !== 1
    || [...input.keys()].some(key => !['id', 'is_del', 'limit', 'page'].includes(key)))) throw new ValidateException('全状态核对仅支持单个精确商品ID和第一页一条记录');
  if (!header && type !== undefined && isDel !== undefined && (type === 6 ? isDel !== 1 : ![-2, -1, 7].includes(type) && isDel !== 0)) throw new ValidateException('商品回收筛选冲突');
  const keyword = (input.get('store_name') ?? '').trim(); if (keyword.length > 128 || /[\u0000-\u001f\u007f]/.test(keyword)) throw new ValidateException('商品名称筛选无效');
  const id = input.has('id') ? supplierRecycleId(input.get('id')) : undefined;
  return { page, limit, id, keyword, type, isDel,
    show: input.get('is_show') ? integer('is_show', 0, 0, 1) : undefined,
    verify: input.get('is_verify') ? integer('is_verify', 0, -2, 1) : undefined };
}
function status(type: number): SQL {
  switch (type) {
    case -2: case -1: return eq(storeProduct.isVerify, type);
    case 0: return and(eq(storeProduct.isVerify, 0), eq(storeProduct.isDel, 0))!;
    case 1: return and(eq(storeProduct.isShow, 1), eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0))!;
    case 2: return and(eq(storeProduct.isShow, 0), eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0))!;
    case 3: return and(eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0))!;
    case 4: return and(eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0), or(eq(storeProduct.isSold, 1), eq(storeProduct.stock, 0)))!;
    case 5: return and(eq(storeProduct.isShow, 1), eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isPolices, 1), sql`${storeProduct.stock}>0`)!;
    case 6: return eq(storeProduct.isDel, 1);
    case 7: return or(eq(storeProduct.isDel, 1), eq(storeProduct.isShow, 0))!;
    default: throw new ValidateException('商品状态错误');
  }
}
/** Supplier PHP delete toggles the root only; its event invalidates every cart.
 * The permanent path deletes exactly the ten source sets, retaining immutable
 * orders, virtual-card delivery/stock facts, retirement logs and attachments. */
export class SupplierProductRecycleService {
  constructor(private readonly container: Container) {}
  private async transaction<T>(actor: SupplierRecycleActor, write: boolean, work: (tx: DbClient) => Promise<T>): Promise<T> {
    try { return await withTx(this.container, async tx => {
      await tx.execute(sql.raw(write ? 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
      await boundBargainSourceProductChange(tx);
      if (write) await tx.execute(sql`LOCK TABLE ONLY public.system_admin, ONLY public.system_supplier, ONLY public.system_role, ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      const capability = write ? 'supplier.product.manage' : 'supplier.product.view';
      await assertSupplierVideoAuthority(tx, actor, capability); await clock(tx, actor);
      const result = await work(tx);
      await assertSupplierVideoAuthority(tx, actor, capability); await clock(tx, actor);
      return result;
    }); } catch (error) { return rethrow(error); }
  }
  private conditions(actor: SupplierRecycleActor, input: ReturnType<typeof query>) {
    const where: SQL[] = [eq(storeProduct.type, 2), eq(storeProduct.relationId, actor.supplierId)];
    if (input.id !== undefined) where.push(eq(storeProduct.id, input.id));
    if (input.keyword) where.push(ilike(storeProduct.storeName, `%${input.keyword}%`));
    if (input.show !== undefined) where.push(eq(storeProduct.isShow, input.show));
    if (input.verify !== undefined) where.push(eq(storeProduct.isVerify, input.verify));
    return where;
  }
  async list(input: URLSearchParams, actor: SupplierRecycleActor) {
    const q = query(input);
    return this.transaction(actor, false, async tx => {
      const conditions = this.conditions(actor, q);
      if (q.type !== undefined) conditions.push(status(q.type));
      if (q.isDel !== 'all' && (q.isDel !== undefined || q.type === undefined)) conditions.push(eq(storeProduct.isDel, q.isDel ?? 0));
      const where = and(...conditions);
      const list = await tx.select({ id: storeProduct.id, product_type: storeProduct.productType, image: storeProduct.image,
        store_name: storeProduct.storeName, price: storeProduct.price, stock: storeProduct.stock, sales: storeProduct.sales,
        is_show: storeProduct.isShow, is_verify: storeProduct.isVerify, is_del: storeProduct.isDel, add_time: storeProduct.addTime })
        .from(storeProduct).where(where).orderBy(desc(storeProduct.sort), desc(storeProduct.id)).limit(q.limit).offset((q.page - 1) * q.limit);
      const [total] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeProduct).where(where);
      return { list, count: total?.count ?? 0, page: q.page, limit: q.limit };
    });
  }
  async header(input: URLSearchParams, actor: SupplierRecycleActor) {
    const q = query(input, true);
    return this.transaction(actor, false, async tx => {
      const list = [];
      for (const [type, name] of [[1, '销售中'], [2, '仓库中'], [4, '已售罄'], [5, '库存预警'], [6, '回收站'], [0, '待审核'], [-1, '审核未通过'], [-2, '强制下架']] as const) {
        const [row] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeProduct).where(and(...this.conditions(actor, q), status(type)));
        list.push({ type, name, count: row?.count ?? 0 });
      }
      return { list };
    });
  }
  async change(id: number, actor: SupplierRecycleActor, options: SupplierRecycleOptions = {}) {
    return this.write(supplierRecycleId(id), actor, options, false);
  }
  async thorough(id: number, actor: SupplierRecycleActor, options: SupplierRecycleOptions = {}) {
    return this.write(supplierRecycleId(id), actor, options, true);
  }
  private async write(id: number, actor: SupplierRecycleActor, options: SupplierRecycleOptions, thorough: boolean) {
    if (options.expectedIsDel !== undefined && ![0, 1].includes(options.expectedIsDel) || thorough && options.expectedIsDel === 0) throw new ValidateException('商品回收原状态错误');
    return this.transaction(actor, true, async tx => {
      const [initial] = await tx.execute(sql`SELECT to_jsonb(p) AS row FROM ONLY public.store_product p WHERE id=${id} AND type=2 AND relation_id=${actor.supplierId} LIMIT 1`);
      if (!initial) throw new NotFoundException('商品不存在或不属于当前供应商');
      await lockBargainSourceProductChange(tx, id);
      // Supplier save takes its per-product reservation first, then the one
      // global SKU-identity allocator lock. Keep that order before any row or
      // table fence, including while existing identities are being removed.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE}, ${id})`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE}, ${PRODUCT_SKU_IDENTITY_LOCK_KEY})`);
      if (!await tryLockProductWrite(tx, id)) throw conflict();
      await tx.execute(sql`LOCK TABLE ONLY public.store_product, ONLY public.store_product_attr, ONLY public.store_product_attr_result,
        ONLY public.store_product_attr_value, ONLY public.store_product_description, ONLY public.store_product_relation,
        ONLY public.store_product_coupon, ONLY public.user_relation, ONLY public.store_product_reply,
        ONLY public.community_relevance, ONLY public.store_cart, ONLY public.store_product_sku_retirement_log IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      if (thorough) await assertProductRecycleSkuGuardReady(tx);
      const before = await snapshot(tx, id), root = before.store_product[0];
      if (before.store_product.length !== 1 || !root || root.type !== 2 || root.relation_id !== actor.supplierId
        || canonical(root) !== canonical(initial.row)) throw conflict();
      if (![0, 1].includes(Number(root.is_del)) || options.expectedIsDel !== undefined && root.is_del !== options.expectedIsDel) throw conflict();
      const expected: Snapshot = Object.fromEntries(Object.entries(before).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]));
      const operation = thorough ? 'delete' as const : root.is_del === 1 ? 'restore' as const : 'recycle' as const;
      if (thorough) {
        if (root.is_del !== 1) throw new ValidateException('只能删除回收站商品');
        // A later refund/cancellation may compensate deleted base stock only
        // from this immutable, tenant/source-validated receipt. Never infer a
        // deliberate deletion merely because current inventory is missing.
        const now = await clock(tx, actor);
        for (const sku of before.store_product_attr_value.filter(row => row.type === 0)) {
          const dependency = JSON.stringify({ version: 1, kind: 'supplier_product_permanent_delete', owner_type: 2,
            supplier_id: actor.supplierId, product_type: Number(root.product_type) });
          const fields = { product_id: id, sku_id: Number(sku.id), unique_snapshot: sku.unique, suk_snapshot: sku.suk,
            action: 'permanent_delete', reason: '', actor_id: actor.id, actor_name: '', actor_ip: (actor.ip ?? '').slice(0, 45),
            dependency_snapshot: dependency, add_time: now };
          const rows = await tx.execute(sql`INSERT INTO public.store_product_sku_retirement_log
            (product_id,sku_id,unique_snapshot,suk_snapshot,action,reason,actor_id,actor_name,actor_ip,dependency_snapshot,add_time)
            VALUES (${id},${Number(sku.id)},${String(sku.unique)},${String(sku.suk)},'permanent_delete','',${actor.id},'',${fields.actor_ip},${dependency},${now})
            RETURNING to_jsonb(store_product_sku_retirement_log) AS row`);
          const fact = rows[0]?.row as Row | undefined;
          if (rows.length !== 1 || !fact || !Number.isSafeInteger(fact.id) || Number(fact.id) <= 0
            || Object.keys(fact).length !== Object.keys(fields).length + 1 || !Object.entries(fields).every(([key, val]) => fact[key] === val)) throw conflict();
          expected.store_product_sku_retirement_log.push(fact);
        }
        await verify(tx, id, expected);
        // The reviewed successor guard admits retired SKU deletion only after
        // this exact, tenant-checked root has been deleted in the same TX.
        const roots = await tx.execute(sql`DELETE FROM public.store_product WHERE id=${id} AND type=2 AND relation_id=${actor.supplierId} AND is_del=1 RETURNING to_jsonb(store_product) AS row`);
        if (roots.length !== 1 || canonical(roots[0]?.row) !== canonical(root)) throw conflict();
        expected.store_product = [];
        for (const [table, column] of sets.slice(1)) {
          if (table === 'store_cart' || table === 'store_product_sku_retirement_log') continue;
          const predicate = ['store_product_attr', 'store_product_attr_result', 'store_product_attr_value', 'store_product_description'].includes(table) ? sql`AND type=0`
            : table === 'user_relation' ? sql`AND category='product'` : table === 'community_relevance' ? sql`AND type='community_product'` : sql``;
          const removed = await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)}=${id} ${predicate} RETURNING to_jsonb(${sql.identifier(table)}) AS row`);
          if (!sameRows(removed.map(row => row.row), before[table].filter(row => deletionRow(table, row)))) throw conflict();
          expected[table] = before[table].filter(row => !deletionRow(table, row));
        }
      } else {
        const isDel = operation === 'restore' ? 0 : 1;
        const fields = operation === 'restore' ? sql`is_del=0` : sql`is_del=1,is_show=0`;
        const roots = await tx.execute(sql`UPDATE public.store_product SET ${fields} WHERE id=${id} AND type=2 AND relation_id=${actor.supplierId} RETURNING to_jsonb(store_product) AS row`);
        expected.store_product = [{ ...root, is_del: isDel, ...(operation === 'recycle' ? { is_show: 0 } : {}) }];
        if (roots.length !== 1 || !sameRows(roots.map(row => row.row), expected.store_product)) throw conflict();
        const carts = await tx.execute(sql`UPDATE public.store_cart SET status=0 WHERE product_id=${id} RETURNING to_jsonb(store_cart) AS row`);
        expected.store_cart = before.store_cart.map(row => ({ ...row, status: 0 }));
        if (!sameRows(carts.map(row => row.row), expected.store_cart)) throw conflict();
      }
      await verify(tx, id, expected);
      const now = await clock(tx, actor), path = `supplier/product/product/${id}`;
      const fields = { adminId: actor.id, merchantId: actor.supplierId, storeId: 0, adminName: '', ip: (actor.ip ?? '').slice(0, 45),
        path, page: '供应商商品回收站', method: 'DELETE', type: 'supplier_product_recycle', action: JSON.stringify({ operation, productId: id }), addTime: now };
      const [audit] = await tx.insert(systemLog).values(fields).returning();
      if (!audit || !Number.isSafeInteger(audit.id) || audit.id <= 0 || !Object.entries(fields).every(([key, val]) => audit[key as keyof typeof fields] === val)) throw conflict();
      const [stored] = await tx.select().from(systemLog).where(eq(systemLog.id, audit.id)).limit(1);
      if (canonical(stored) !== canonical(audit)) throw conflict();
      await verify(tx, id, expected);
      return thorough ? { id, operation } : { id, operation, is_del: operation === 'restore' ? 0 : 1 };
    });
  }
}
