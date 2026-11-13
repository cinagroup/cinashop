import { and, asc, eq, sql } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderStatus } from '@/models/schema';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { supplierOrderEditCanonical } from '@/services/supplier/SupplierUnpaidOrderEditInput';
import { parseAdminOrderNumber } from './AdminMobileOrderReadService';
import { adminAuthorityWriteError, assertAdminAuthoritySession, loadAdminAuthorityReadActor, type AdminAuthorityActor } from './AdminAuthorityWriteService';

const invalid = () => new ValidateException('订单记录查询参数错误');
const stale = () => new HttpApiException('订单记录已变化，请刷新记录后重新查看', 409, 409);
export function adminOrderHistoryId(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value))
    || Number(value) > 2_147_483_647) throw invalid();
  return Number(value);
}
const clock = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export function formatAdminOrderHistoryTime(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < -2_147_483_648 || seconds > 2_147_483_647) throw invalid();
  const p = Object.fromEntries(clock.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
export function parseAdminOrderHistoryQuery(query: Record<string, string>) {
  if (Object.keys(query).some(key => !['order_id', 'page', 'limit', 'revision'].includes(key))) throw invalid();
  const integer = (value: string | undefined, fallback: number, maximum: number) => {
    if (value === undefined) return fallback;
    if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > maximum) throw invalid();
    return Number(value);
  };
  const page = integer(query.page, 1, 10000), limit = integer(query.limit, 20, 100);
  if ((query.revision !== undefined && !/^[a-f0-9]{64}$/.test(query.revision)) || (page > 1 && !query.revision)) throw invalid();
  return { orderNo: parseAdminOrderNumber(query.order_id), page, limit, revision: query.revision };
}

type HistoryRow = typeof storeOrderStatus.$inferSelect;
const legacyRow = (row: HistoryRow) => ({ id: row.id, oid: row.oid, change_type: row.changeType,
  change_message: row.changeMessage, change_time: formatAdminOrderHistoryTime(row.changeTime) });

async function state(tx: DbClient, id: number) {
  // Fingerprint before any record crosses the wire. The cap bounds aggregation
  // memory; excessive history fails explicitly rather than returning a prefix.
  const [row] = await tx.execute(sql`SELECT count(*)::integer AS count,
    COALESCE(sum(octet_length(to_jsonb(s)::text)),0)::text AS bytes,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(string_agg(
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(to_jsonb(s)::text,'UTF8')),'hex'),''
      ORDER BY s.change_time,s.id),''),'UTF8')),'hex') AS hash
    FROM (SELECT * FROM public.store_order_status WHERE oid=${id} LIMIT 10001) s`);
  if (!row || !Number.isInteger(row.count) || Number(row.count) > 10000 || Number(row.bytes) > 8_388_608)
    throw new ValidateException('订单记录过多或过大，请联系管理员核对');
  return { count: Number(row.count), bytes: String(row.bytes), hash: String(row.hash) };
}

/** PHP returns all rows in chronological order and ignores its caller's page
 * query. The separate modern endpoint supports stable, revision-bound pages.
 * Neither endpoint merges a payment header with its fulfillment descendants. */
export class AdminOrderHistoryService {
  constructor(private readonly container: Container, private readonly appKey: string) {}

  private snapshot<T>(actor: AdminAuthorityActor, read: (tx: DbClient) => Promise<T>) {
    assertAdminAuthoritySession(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
      await loadAdminAuthorityReadActor(tx, actor, 'order.view');
      const result = await read(tx);
      await loadAdminAuthorityReadActor(tx, actor, 'order.view');
      return result;
    }).catch(adminAuthorityWriteError);
  }

  legacy(value: unknown, actor: AdminAuthorityActor) {
    const id = adminOrderHistoryId(value);
    return this.snapshot(actor, async tx => {
      const current = await state(tx, id);
      if (current.count > 2000 || Number(current.bytes) > 2_097_152)
        throw new ValidateException('订单记录过多，请使用新版订单详情分页查看');
      // As in PHP, orphan/deleted history remains queryable by its exact oid;
      // a missing oid with no records returns [], without number-ID fallback.
      return (await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id))
        .orderBy(asc(storeOrderStatus.changeTime), asc(storeOrderStatus.id)).limit(2001)).map(legacyRow);
    });
  }

  page(value: unknown, query: Record<string, string>, actor: AdminAuthorityActor) {
    const id = adminOrderHistoryId(value), input = parseAdminOrderHistoryQuery(query);
    return this.snapshot(actor, async tx => {
      const [order] = await tx.select({ id: storeOrder.id, orderId: storeOrder.orderId, uid: storeOrder.uid,
        pid: storeOrder.pid, isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel }).from(storeOrder)
        .where(and(eq(storeOrder.id, id), eq(storeOrder.orderId, input.orderNo))).limit(1);
      if (!order) throw new NotFoundException('订单不存在或编号不匹配');
      const current = await state(tx, id);
      if (!this.appKey) throw new ServiceUnavailableException('订单记录签名尚未就绪');
      const revision = createHmac('sha256', this.appKey).update('cinashop.admin-order-history.v1\0')
        .update(supplierOrderEditCanonical({ actor, order, state: current, limit: input.limit })).digest('hex');
      if (input.revision !== undefined && !timingSafeEqual(new TextEncoder().encode(input.revision), new TextEncoder().encode(revision))) throw stale();
      const rows = await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id))
        .orderBy(asc(storeOrderStatus.changeTime), asc(storeOrderStatus.id)).limit(input.limit).offset((input.page - 1) * input.limit);
      return { id, order_id: order.orderId, list: rows.map(row => ({ ...legacyRow(row), timestamp: row.changeTime })),
        count: current.count, page: input.page, limit: input.limit, revision };
    });
  }
}
