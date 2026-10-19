import { and, eq, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { withTx, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder } from '@/models/schema';
import { ExpressService, type ExpressQueryResult, type ScopedTrackingOrder } from '@/services/order/ExpressService';
import { assertSupplierVideoAuthority, type SupplierVideoActor } from './SupplierVideoAuthority';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

export type SupplierOrderTracking = ExpressQueryResult & {
  delivery_name: string; delivery_id: string; result: Array<{ time: string; status: string }>;
};
const unavailable = () => new ServiceUnavailableException('订单物流读取权限或运行环境尚未就绪');
export function supplierTrackingId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw new ValidateException('订单物流ID无效');
  return Number(value);
}
export function assertSupplierTrackingQuery(value: Record<string, string[] | undefined>) {
  if (Object.keys(value).length) throw new ValidateException('订单物流不接受查询参数');
}
const transportColumns = {
  id: storeOrder.id, pid: storeOrder.pid, uid: storeOrder.uid, storeId: storeOrder.storeId, supplierId: storeOrder.supplierId,
  orderId: storeOrder.orderId, status: storeOrder.status, deliveryType: storeOrder.deliveryType,
  deliveryName: storeOrder.deliveryName, deliveryCode: storeOrder.deliveryCode, deliveryId: storeOrder.deliveryId,
  userPhone: storeOrder.userPhone, isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel,
};
const parentColumns = { id: storeOrder.id, pid: storeOrder.pid, uid: storeOrder.uid, storeId: storeOrder.storeId,
  supplierId: storeOrder.supplierId, supplierAllocationStatus: storeOrder.supplierAllocationStatus,
  isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel };
function boundedText(value: unknown, max: number) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw unavailable();
  return value;
}
function transportIdentity(row: ScopedTrackingOrder & { uid: number; storeId: number; supplierId: number }) {
  for (const value of [row.id, row.uid, row.supplierId]) if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw unavailable();
  if (!Number.isSafeInteger(row.pid) || row.pid < -1 || row.pid > 2147483647 || !Number.isSafeInteger(row.storeId) || row.storeId < 0
    || row.storeId > 2147483647 || ![0, 1].includes(row.isDel) || ![0, 1].includes(row.isSystemDel)) throw unavailable();
  if (!boundedText(row.orderId, 32).trim()) throw unavailable();
  boundedText(row.deliveryType, 32); boundedText(row.deliveryName, 64); boundedText(row.deliveryCode, 50);
  boundedText(row.deliveryId, 64); boundedText(row.userPhone, 18);
}
async function ready(db: DbClient) {
  // Existing application containers may use broader deployment roles. The read
  // boundary is the short READ ONLY transaction; least privilege is verified
  // separately with an independent SELECT-only LOGIN in native acceptance.
  const [row] = await db.execute(sql`SELECT current_setting('transaction_read_only')::boolean
    AND current_setting('transaction_isolation')='repeatable read'
    AND (SELECT count(*)=6 AND bool_and(c.relkind='r' AND has_table_privilege(current_user,c.oid,'SELECT')) FROM pg_class c
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN('system_admin','system_supplier','system_role','system_menus','store_order','system_config')) AS ready`);
  if (row?.ready !== true) throw unavailable();
}
/** Bind real row versions as well as current capability, so same-value authority
 * edits during transport do not revive an older authorized read. */
async function authorityVersion(db: DbClient, actor: SupplierVideoActor) {
  const [row] = await db.execute<{ version: string }>(sql`SELECT md5(jsonb_build_array(a.xmin::text,s.xmin::text,
    (SELECT jsonb_agg(v ORDER BY v->>0) FROM (SELECT jsonb_build_array(r.id,r.xmin::text) AS v FROM system_role r
      WHERE r.type=4 AND r.relation_id=s.id AND r.id::text=ANY(regexp_split_to_array(btrim(a.roles),'[[:space:]]*,[[:space:]]*')) ORDER BY r.id LIMIT 513) roles),
    (SELECT jsonb_agg(v ORDER BY v->>0) FROM (SELECT jsonb_build_array(m.id,m.xmin::text) AS v FROM system_menus m
      WHERE m.type=4 AND m.id::text IN (SELECT unnest(regexp_split_to_array(btrim(r.rules),'[[:space:]]*,[[:space:]]*')) FROM system_role r
        WHERE r.type=4 AND r.relation_id=s.id AND r.id::text=ANY(regexp_split_to_array(btrim(a.roles),'[[:space:]]*,[[:space:]]*')))
      ORDER BY m.id LIMIT 513) menus))::text) AS version FROM system_admin a JOIN system_supplier s ON s.id=a.relation_id
    WHERE a.id=${actor.id} AND s.id=${actor.supplierId}`);
  if (!row || !/^[a-f0-9]{32}$/.test(row.version)) throw unavailable();
  return row.version;
}
function readError(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    if ('code' in cause && ['42501', '42P01', '42703', '57014'].includes(String(cause.code))) throw Object.assign(unavailable(), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}
export class SupplierOrderTrackingService {
  constructor(private readonly container: Container, private readonly env: Env) {}
  private snapshot(actor: SupplierVideoActor, id: number) {
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
      await ready(db); await assertSupplierVideoAuthority(db, actor, 'supplier.order.view');
      const [order] = await db.select(transportColumns).from(storeOrder).where(and(eq(storeOrder.id, id),
        eq(storeOrder.supplierId, actor.supplierId), eq(storeOrder.isSystemDel, 0))).limit(1);
      if (!order) throw new NotFoundException('订单不存在或不属于当前供应商');
      transportIdentity(order);
      if (order.pid === -1 || order.deliveryType === 'split') throw new ValidateException('请选择具体发货子单查询物流');
      if (order.deliveryType !== 'express') throw new ValidateException('该订单不是快递发货，无法查询物流信息');
      if (!order.deliveryId.trim()) throw new ValidateException('该订单不存在快递单号');
      let parent: { id: number; pid: number; uid: number; storeId: number; supplierId: number; supplierAllocationStatus: number; isDel: number; isSystemDel: number } | null = null;
      if (order.pid > 0) {
        const [root] = await db.select(parentColumns).from(storeOrder).where(and(eq(storeOrder.id, order.pid), eq(storeOrder.isSystemDel, 0))).limit(1);
        if (!root || root.uid !== order.uid || ![-1, 0].includes(root.pid)
          || !(root.supplierId === actor.supplierId && root.storeId === order.storeId
            || root.supplierId === 0 && root.pid === -1 && root.supplierAllocationStatus === 2)) throw new NotFoundException('主订单不存在或不属于当前供应商');
        parent = root;
      }
      const version = await authorityVersion(db, actor);
      await assertSupplierVideoAuthority(db, actor, 'supplier.order.view');
      return { order, fingerprint: JSON.stringify({ order, parent, authority: version }) };
    });
  }
  async read(actor: SupplierVideoActor, id: number): Promise<SupplierOrderTracking> {
    if (this.container.db instanceof PgTransaction) throw new ValidateException('物流查询必须在独立读取事务之外调用');
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new ValidateException('订单物流ID无效');
    try {
      // Every invocation owns and closes a fresh short snapshot. No SQL
      // transaction or row lock is retained across carrier/cache transport.
      const initial = await this.snapshot(actor, id);
      const authorize = async () => {
        const current = await this.snapshot(actor, id);
        if (current.fingerprint !== initial.fingerprint) throw new HttpApiException('订单物流或管理身份已变化，请重新读取', 409, 409);
      };
      const result = await new ExpressService(this.container, this.env).queryScopedOrders([initial.order], authorize, { allowUserDeleted: true });
      return { ...result, delivery_name: result.expressName, delivery_id: result.expressNo, result: result.express };
    } catch (error) { return readError(error); }
  }
}
