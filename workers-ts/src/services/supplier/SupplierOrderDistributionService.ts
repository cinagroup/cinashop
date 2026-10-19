import { and, asc, eq, getTableColumns, inArray, or, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { expressCompany, storeOrder, storeOrderRefund, storeOrderStatus } from '@/models/schema';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { assertSupplierVideoAuthority, type SupplierVideoActor } from './SupplierVideoAuthority';
import { assertDistributionRevision, distributionCanonical, distributionConflict, distributionId, distributionInput,
  distributionMac, distributionText, type SupplierDistributionInput } from './SupplierOrderDistributionInput';
import { NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

type Order = typeof storeOrder.$inferSelect;
type VersionedOrder = Order & { version: string };
type Parent = Pick<Order, 'id' | 'pid' | 'uid' | 'storeId' | 'supplierId' | 'supplierAllocationStatus' | 'paid' | 'status' | 'refundStatus' | 'isDel' | 'isSystemDel'> & { version: string; checksum: string };
type Company = { id: number; name: string; code: string; version: string };
type Guard = { tables: Array<{ name: string; oid: number }>; versions: Record<string, unknown[]>; managed: boolean };
type State = { order: VersionedOrder; parent: Parent | null; leaf: boolean; refund: unknown[]; providers: Guard; companies: Company[]; authority: string };
export interface SupplierOrderDistribution {
  id: number; order_id: string; delivery_type: 'express' | 'send' | 'fictitious'; delivery_name: string; delivery_code: string;
  delivery_id: string; fictitious_content: string; revision: string; express_companies: Array<{ id: number; name: string; code: string }>;
  editable: boolean; reason: string;
}
const unavailable = () => new ServiceUnavailableException('配送信息运行权限或表结构尚未就绪');
const orderColumns = { ...getTableColumns(storeOrder), version: sql<string>`xmin::text` };
const optional = ['order_waybill_job', 'store_delivery_order', 'customer_city_delivery_job', 'customer_city_delivery_attempt', 'customer_city_delivery_binding'];
function fail(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(distributionConflict(), { cause: error });
    if (['42501', '42P01', '42703', '57014'].includes(code)) throw Object.assign(unavailable(), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}
async function authorityVersion(db: DbClient, actor: SupplierVideoActor): Promise<string> {
  const [row] = await db.execute<{ version: string }>(sql`SELECT md5(jsonb_build_array(a.xmin::text,s.xmin::text,
    (SELECT jsonb_agg(v ORDER BY v->>0) FROM (SELECT jsonb_build_array(r.id,r.xmin::text) AS v FROM system_role r
      WHERE r.type=4 AND r.relation_id=s.id AND r.id::text=ANY(regexp_split_to_array(btrim(a.roles),'[[:space:]]*,[[:space:]]*')) ORDER BY r.id LIMIT 513) roles),
    (SELECT jsonb_agg(v ORDER BY v->>0) FROM (SELECT jsonb_build_array(m.id,m.xmin::text) AS v FROM system_menus m
      WHERE m.type=4 AND m.id::text IN(SELECT unnest(regexp_split_to_array(btrim(r.rules),'[[:space:]]*,[[:space:]]*')) FROM system_role r
      WHERE r.type=4 AND r.relation_id=s.id AND r.id::text=ANY(regexp_split_to_array(btrim(a.roles),'[[:space:]]*,[[:space:]]*'))) ORDER BY m.id LIMIT 513) menus))::text) AS version
    FROM system_admin a JOIN system_supplier s ON s.id=a.relation_id WHERE a.id=${actor.id} AND s.id=${actor.supplierId}`);
  if (!row || !/^[a-f0-9]{32}$/.test(row.version)) throw unavailable(); return row.version;
}
async function catalog(db: DbClient, lock = false): Promise<Company[]> {
  if (lock) await db.execute(sql`LOCK TABLE ONLY public.express_company IN SHARE MODE NOWAIT`);
  const rows = await db.select({ id: expressCompany.id, name: expressCompany.name, code: expressCompany.code,
    version: sql<string>`xmin::text` }).from(expressCompany).where(and(eq(expressCompany.isShow, 1), eq(expressCompany.status, 1)))
    .orderBy(asc(expressCompany.id)).limit(1001);
  if (rows.length > 1000 || new Set(rows.map(row => row.name)).size !== rows.length) throw unavailable();
  for (const row of rows) if (!distributionText(row.name, 64).trim() || !distributionText(row.code, 50).trim()
    || row.name !== row.name.trim() || row.code !== row.code.trim()) throw unavailable();
  return rows;
}
async function providers(db: DbClient, order: Order, lock = false): Promise<Guard> {
  const tables = await db.execute<{ name: string; oid: number; readable: boolean; kind: string }>(sql`SELECT relname AS name,oid::int AS oid,
    has_table_privilege(current_user,oid,'SELECT') AS readable,relkind AS kind FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relname IN('order_waybill_job','store_delivery_order','customer_city_delivery_job','customer_city_delivery_attempt','customer_city_delivery_binding') ORDER BY relname`);
  if (tables.some(row => !row.readable || row.kind !== 'r')) throw unavailable();
  const names = new Set(tables.map(row => row.name)), city = ['customer_city_delivery_job', 'customer_city_delivery_attempt', 'customer_city_delivery_binding'].filter(name => names.has(name));
  if (city.length && (city.length !== 3 || !names.has('store_delivery_order'))) throw unavailable();
  // Legacy callbacks lock delivery-table resources before order rows. Never
  // wait in the reverse graph; the established fence uses this NOWAIT barrier.
  if (lock && names.has('store_delivery_order')) await db.execute(sql`LOCK TABLE ONLY public.store_delivery_order IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  const rootId = order.pid > 0 ? order.pid : order.id, versions: Record<string, unknown[]> = {};
  for (const table of optional.filter(name => names.has(name))) {
    // Fixed identifiers only, never request-derived SQL. No provider secrets or
    // payload JSON are selected; actual row versions bind every matching job.
    const predicate = table === 'order_waybill_job' ? sql`root_order_id=${rootId} OR order_id=${order.id} OR fulfilled_order_id=${order.id}`
      : table === 'store_delivery_order' ? sql`oid IN(${rootId},${order.id})`
      : table === 'customer_city_delivery_attempt' ? sql`job_id IN(SELECT id FROM public.customer_city_delivery_job WHERE root_order_id=${rootId} OR order_id=${order.id})`
      : sql`root_order_id=${rootId} OR order_id=${order.id}`;
    const key = sql.raw(table === 'customer_city_delivery_binding' ? 'job_id' : 'id');
    const rows = await db.execute<{ id: number | string; version: string }>(sql`SELECT ${key} AS id,xmin::text AS version FROM ${sql.raw('public.' + table)} WHERE ${predicate} ORDER BY ${key} LIMIT 1001`);
    if (rows.length > 1000) throw unavailable(); versions[table] = Array.from(rows);
  }
  return { tables: tables.map(row => ({ name: row.name, oid: row.oid })), versions,
    managed: !!order.deliveryUid || !!order.expressDump?.trim() || !!order.kuaidiLabel.trim() || !!order.kuaidiTaskId.trim()
      || order.kuaidiOrderId !== 0 || order.isStockUp !== 0 || Object.values(versions).some(rows => rows.length > 0) };
}
const referenceColumns = { id: storeOrder.id, pid: storeOrder.pid, uid: storeOrder.uid, storeId: storeOrder.storeId, supplierId: storeOrder.supplierId };
async function readTarget(db: DbClient, id: number, supplierId: number, lock = false) {
  const query = db.select(orderColumns).from(storeOrder).where(and(eq(storeOrder.id, id), eq(storeOrder.supplierId, supplierId),
    eq(storeOrder.isSystemDel, 0), sql`octet_length(to_jsonb(${storeOrder})::text)<=262144`)).limit(1);
  const [row] = await (lock ? query.for('update', { noWait: true }) : query); return row;
}
async function readParent(db: DbClient, rootId: number, reference: Pick<Order, 'uid' | 'storeId' | 'supplierId'>, lock: boolean) {
  // Parent roots may be platform allocation records. Read only coherent
  // authority scalars; private parent TEXT stays inside the database checksum.
  const query = db.select({ ...referenceColumns, supplierAllocationStatus: storeOrder.supplierAllocationStatus,
    paid: storeOrder.paid, status: storeOrder.status, refundStatus: storeOrder.refundStatus,
    isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel, version: sql<string>`xmin::text`,
    checksum: sql<string>`md5(to_jsonb(${storeOrder})::text)` }).from(storeOrder).where(and(
    eq(storeOrder.id, rootId), eq(storeOrder.uid, reference.uid), inArray(storeOrder.pid, [0, -1]), eq(storeOrder.isSystemDel, 0),
    sql`octet_length(to_jsonb(${storeOrder})::text)<=262144`,
    or(and(eq(storeOrder.supplierId, reference.supplierId), eq(storeOrder.storeId, reference.storeId)),
      and(eq(storeOrder.supplierId, 0), eq(storeOrder.pid, -1), eq(storeOrder.supplierAllocationStatus, 2))))).limit(1);
  const [row] = await (lock ? query.for('update', { noWait: true }) : query); return row;
}
async function readState(db: DbClient, id: number, actor: SupplierVideoActor, lock = false): Promise<State> {
  const [reference] = await db.select(referenceColumns).from(storeOrder).where(and(eq(storeOrder.id, id),
    eq(storeOrder.supplierId, actor.supplierId), eq(storeOrder.isSystemDel, 0))).limit(1);
  if (!reference) throw new NotFoundException('订单不存在或不属于当前供应商');
  const rootId = reference.pid > 0 ? reference.pid : reference.id;
  if (lock) await lockOrderSettlement(db, rootId);
  let parent: Parent | null = null;
  if (rootId !== id) {
    parent = await readParent(db, rootId, reference, lock) ?? null;
    if (!parent) throw new NotFoundException('主订单归属不一致');
  }
  const order = await readTarget(db, id, actor.supplierId, lock);
  if (!order || order.pid !== reference.pid || order.uid !== reference.uid || order.storeId !== reference.storeId) throw new NotFoundException('订单归属已变化');
  if (!['express', 'send', 'fictitious'].includes(order.deliveryType)) throw new ValidateException('请选择已发货的具体包裹');
  for (const [value, max, multiline] of [[order.orderId, 32, false], [order.deliveryName, 64, false], [order.deliveryCode, 50, false],
    [order.deliveryId, 64, false], [order.fictitiousContent, 500, true]] as const) distributionText(value, max, multiline);
  const children = await db.select({ id: storeOrder.id, version: sql<string>`xmin::text` }).from(storeOrder).where(eq(storeOrder.pid, order.id)).limit(1);
  const refund = await db.select({ id: storeOrderRefund.id, version: sql<string>`xmin::text` }).from(storeOrderRefund).where(and(
    inArray(storeOrderRefund.storeOrderId, [rootId, order.id]), eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0),
    inArray(storeOrderRefund.refundType, [0, 1, 2, 4, 5]))).orderBy(asc(storeOrderRefund.id)).limit(1001);
  if (refund.length > 1000) throw unavailable();
  return { order, parent, leaf: children.length === 0, refund,
    providers: await providers(db, order, lock), companies: await catalog(db, lock), authority: await authorityVersion(db, actor) };
}
function reason(state: State) {
  const { order, providers, leaf } = state;
  if (order.pid < 0 || !leaf) return '请选择具体发货子单修改配送信息';
  if (state.parent && (state.parent.isDel || state.parent.isSystemDel || state.parent.paid !== 1 || state.parent.refundStatus !== 0))
    return '主订单已删除、未支付或售后状态不允许修改配送信息';
  if (order.paid !== 1 || order.status !== 1 || order.refundStatus !== 0 || ![1, 3].includes(order.shippingType)
    || order.isDel || order.isSystemDel || state.refund.length) return '仅未删除、无进行中售后的待收货包裹可修改';
  if (providers.managed) return '配送信息由配送员、面单或第三方任务管理，请到对应履约记录核对';
  if (!(order.productType === 0 && ['express', 'send'].includes(order.deliveryType) || order.productType === 3 && order.deliveryType === 'fictitious'))
    return '当前商品履约类型不支持手工修改配送信息';
  return '';
}
function version(state: State, actor: SupplierVideoActor, key: string) {
  return distributionMac(key, { actor: { id: actor.id, supplierId: actor.supplierId, authVersion: actor.authVersion, expiresAt: actor.expiresAt }, state });
}
function dto(state: State, actor: SupplierVideoActor, key: string): SupplierOrderDistribution {
  const order = state.order, why = reason(state);
  return { id: order.id, order_id: order.orderId, delivery_type: order.deliveryType as SupplierOrderDistribution['delivery_type'],
    delivery_name: order.deliveryName, delivery_code: order.deliveryCode, delivery_id: order.deliveryId, fictitious_content: order.fictitiousContent,
    revision: version(state, actor, key), express_companies: state.companies.map(({ id, name, code }) => ({ id, name, code })), editable: !why, reason: why };
}
function changes(state: State, input: SupplierDistributionInput): Partial<Order> {
  const type = state.order.deliveryType;
  if (type === 'fictitious') {
    if (input.delivery_name || input.delivery_id) throw new ValidateException('虚拟交付不可提交配送名称或号码');
    return { fictitiousContent: input.fictitious_content };
  }
  const name = input.delivery_name.trim(), number = input.delivery_id.trim();
  if (input.fictitious_content || !name || !number) throw new ValidateException('请填写配送名称和号码，勿提交虚拟内容');
  if (type === 'send') {
    if (!/^1[3-9]\d{9}$/.test(number)) throw new ValidateException('请填写有效的配送联系电话');
    return { deliveryName: name, deliveryId: number };
  }
  const companies = state.companies.filter(row => row.name === name);
  if (companies.length !== 1) throw new ValidateException('快递公司未启用或名称不唯一，请重新选择');
  return { deliveryName: companies[0].name, deliveryCode: companies[0].code, deliveryId: number };
}
export class SupplierOrderDistributionService {
  constructor(private readonly container: Container, private readonly appKey: string) {}
  private async transaction<T>(actor: SupplierVideoActor, write: boolean, work: (db: DbClient) => Promise<T>): Promise<T> {
    if (this.container.db instanceof PgTransaction) throw new ValidateException('配送信息须由独立事务读取或保存');
    try { return await withTx(this.container, async db => {
      await db.execute(sql.raw(write ? 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
      await db.execute(sql`SELECT set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
      if (write) await db.execute(sql`LOCK TABLE ONLY public.system_admin,ONLY public.system_supplier,ONLY public.system_role,ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      await assertSupplierVideoAuthority(db, actor, write ? 'supplier.order.manage' : 'supplier.order.view');
      const result = await work(db); await assertSupplierVideoAuthority(db, actor, write ? 'supplier.order.manage' : 'supplier.order.view'); return result;
    }); } catch (error) { return fail(error); }
  }
  async read(actor: SupplierVideoActor, id: number): Promise<SupplierOrderDistribution> {
    distributionId(id); return this.transaction(actor, false, async db => dto(await readState(db, id, actor), actor, this.appKey));
  }
  async save(actor: SupplierVideoActor, id: number, body: unknown): Promise<SupplierOrderDistribution> {
    distributionId(id); const input = distributionInput(body);
    return this.transaction(actor, true, async db => {
      const before = await readState(db, id, actor, true);
      assertDistributionRevision(input.expected_revision, version(before, actor, this.appKey));
      const why = reason(before); if (why) throw new ValidateException(why);
      const patch = changes(before, input), { version: _version, ...oldOrder } = before.order;
      if (Object.entries(patch).every(([key, value]) => oldOrder[key as keyof Order] === value)) return dto(before, actor, this.appKey);
      const expected = { ...oldOrder, ...patch };
      const updated = await db.update(storeOrder).set(patch).where(and(eq(storeOrder.id, id), eq(storeOrder.supplierId, actor.supplierId),
        eq(storeOrder.status, 1), eq(storeOrder.paid, 1), eq(storeOrder.refundStatus, 0), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0)))
        .returning({ id: storeOrder.id });
      if (updated.length !== 1) throw distributionConflict('配送信息未能完整保存');
      const after = await readState(db, id, actor), { version: _afterVersion, ...actual } = after.order;
      if (distributionCanonical(actual) !== distributionCanonical(expected)) throw distributionConflict('配送信息完整回读不一致');
      const [clock] = await db.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
      const log = { oid: id, changeType: 'distribution', changeMessage: JSON.stringify({ actor_id: actor.id, supplier_id: actor.supplierId, delivery_type: before.order.deliveryType }), changeTime: clock.now };
      const [savedLog] = await db.insert(storeOrderStatus).values(log).returning();
      if (!savedLog || Object.entries(log).some(([key, value]) => savedLog[key as keyof typeof savedLog] !== value)) throw distributionConflict('配送信息审计未完整保存');
      await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const final = await readState(db, id, actor), { version: _finalVersion, ...finalOrder } = final.order;
      if (distributionCanonical(finalOrder) !== distributionCanonical(expected)
        || distributionCanonical({ ...after, order: null }) !== distributionCanonical({ ...before, order: null })
        || distributionCanonical({ ...final, order: null }) !== distributionCanonical({ ...before, order: null })) throw distributionConflict('配送信息或履约权威在保存时变化');
      const [finalLog] = await db.select().from(storeOrderStatus).where(eq(storeOrderStatus.id, savedLog.id)).limit(1);
      if (distributionCanonical(finalLog) !== distributionCanonical(savedLog)) throw distributionConflict('配送信息审计回读不一致');
      return dto(final, actor, this.appKey);
    });
  }
}
