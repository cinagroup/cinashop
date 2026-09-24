import { and, asc, desc, eq, getTableColumns, gte, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { parseAdminOrderNumber } from './AdminMobileOrderReadService';

const visible = () => and(eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0));
const maximumId = 2_147_483_647;
function integer(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value === '') return fallback;
  if (!/^-?\d{1,10}$/.test(value)) throw new ValidateException('订单查询参数错误');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ValidateException('订单查询参数错误');
  return n;
}

// Bound variable-width order fields before they cross the database wire. Reject
// oversized records rather than displaying a silently truncated financial view.
const orderColumns = getTableColumns(storeOrder);
const orderBytes = sql`COALESCE(octet_length(${storeOrder.cartId})::bigint,0)
  +COALESCE(octet_length(${storeOrder.virtualInfo}),0)+COALESCE(octet_length(${storeOrder.customForm}),0)
  +COALESCE(octet_length(${storeOrder.promotionsGive}),0)+COALESCE(octet_length(${storeOrder.giveCoupon}),0)
  +COALESCE(octet_length(${storeOrder.expressDump}),0)+COALESCE(octet_length(${storeOrder.refundReasonWapImg}),0)`;
const boundedText = (column: SQLWrapper) =>
  sql<string | null>`CASE WHEN ${orderBytes}<=262144 THEN ${column} ELSE NULL END`;
const boundedOrderColumns = {
  ...orderColumns,
  cartId: boundedText(storeOrder.cartId), virtualInfo: boundedText(storeOrder.virtualInfo),
  customForm: boundedText(storeOrder.customForm), promotionsGive: boundedText(storeOrder.promotionsGive),
  giveCoupon: boundedText(storeOrder.giveCoupon), expressDump: boundedText(storeOrder.expressDump),
  refundReasonWapImg: boundedText(storeOrder.refundReasonWapImg),
  oversized: sql<boolean>`${orderBytes}>262144`,
};
function header<T extends { oversized: boolean }>(row: T) {
  if (row.oversized) throw new ValidateException('订单数据过大，请联系管理员核对');
  const { oversized: _oversized, ...rest } = row;
  return rest;
}

/** Modern Admin fulfillment view, not PHP's separate grouped `order/lst` report.
 * The route's real admin middleware owns authorization. No writes, provider I/O,
 * archived-refund reinterpretation or customer mutation service is used here. */
export class AdminOrderReadService {
  constructor(private readonly container: Container) {}

  private snapshot<T>(read: (db: DbClient) => Promise<T>) {
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
      return read(db);
    });
  }

  /** One database snapshot for the six live status buckets used by the old
   * order chart. The modern Admin list shows current physical fulfillments:
   * pid >= 0, including split children, across platform/store/supplier and all
   * creation dates. Deleted rows and split payment headers (pid = -1) are not
   * current fulfillments. `all` also contains refunds/cancellations, so it is
   * intentionally not the sum of the five status buckets. */
  async chart() {
    const eligible = sql`${storeOrder.paid}=1 AND ${storeOrder.refundStatus} IN (0,3)`;
    return this.snapshot(async db => {
      const [counts] = await db.select({
        all: sql<number>`COUNT(*)::integer`,
        unpaid: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.paid}=0 AND ${storeOrder.status}=0 AND ${storeOrder.refundStatus}=0)::integer`,
        unshipped: sql<number>`COUNT(*) FILTER (WHERE ${eligible} AND ${storeOrder.status} IN (0,4) AND ${storeOrder.shippingType} IN (1,3))::integer`,
        untake: sql<number>`COUNT(*) FILTER (WHERE ${eligible} AND ((${storeOrder.status} IN (1,5) AND ${storeOrder.shippingType}=1) OR (${storeOrder.status} IN (0,5) AND ${storeOrder.shippingType}=2)))::integer`,
        unevaluate: sql<number>`COUNT(*) FILTER (WHERE ${eligible} AND ${storeOrder.status}=2)::integer`,
        complete: sql<number>`COUNT(*) FILTER (WHERE ${eligible} AND ${storeOrder.status}=3)::integer`,
      }).from(storeOrder).where(and(visible(), gte(storeOrder.pid, 0)));
      return counts;
    });
  }

  async list(query: Record<string, string>) {
    const page = integer(query.page, 1, 1, 10_000), limit = integer(query.limit, 10, 1, 100);
    const conditions: SQL[] = [visible()!, gte(storeOrder.pid, 0)];
    if (query.status !== undefined && query.status !== '') conditions.push(eq(storeOrder.status, integer(query.status, 0, -2, 5)));
    if (query.paid !== undefined && query.paid !== '') conditions.push(eq(storeOrder.paid, integer(query.paid, 0, 0, 1)));
    if (query.uid !== undefined && query.uid !== '') conditions.push(eq(storeOrder.uid, integer(query.uid, 0, 1, maximumId)));
    const number = query.order_id ? parseAdminOrderNumber(query.order_id) : null;
    return this.snapshot(async db => {
      if (number) {
        const [target] = await db.select({ id: storeOrder.id, pid: storeOrder.pid, uid: storeOrder.uid }).from(storeOrder)
          .where(and(eq(storeOrder.orderId, number), visible())).limit(1);
        // Searching the payment number still finds its current fulfillment
        // family. A child number remains exact; never widen to all siblings.
        conditions.push(target?.pid === -1 ? and(eq(storeOrder.pid, target.id), eq(storeOrder.uid, target.uid))! : eq(storeOrder.orderId, number));
      }
      const orders = await db.select({ ...boundedOrderColumns, virtualInfo: sql<null>`NULL` }).from(storeOrder).where(and(...conditions))
        .orderBy(desc(storeOrder.addTime), desc(storeOrder.id)).limit(limit).offset((page - 1) * limit);
      const [count] = await db.select({ total: sql<number>`COUNT(*)::integer` }).from(storeOrder).where(and(...conditions));
      return { list: orders.map(row => ({ ...header(row), virtualInfo: null })), total: count.total, page, limit };
    });
  }

  async detail(value: string) {
    const number = parseAdminOrderNumber(value);
    return this.snapshot(async db => {
      const [row] = await db.select(boundedOrderColumns).from(storeOrder)
        .where(and(eq(storeOrder.orderId, number), visible())).limit(1);
      if (!row) throw new NotFoundException('订单不存在');
      const order = header(row);
      const cartBytes = sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo})::bigint,0)
        +COALESCE(octet_length(${storeOrderCartInfo.promotionsId}),0)`;
      const carts = await db.select({ ...getTableColumns(storeOrderCartInfo),
        cartInfo: sql<string | null>`CASE WHEN ${cartBytes}<=65536 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
        promotionsId: sql<string | null>`CASE WHEN ${cartBytes}<=65536 THEN ${storeOrderCartInfo.promotionsId} ELSE NULL END`,
        oversized: sql<boolean>`${cartBytes}>65536`,
      }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
      if (carts.length > 200 || carts.some(cart => cart.uid !== order.uid || cart.oversized)) {
        throw new ValidateException('订单商品明细不一致或过大，请联系管理员核对');
      }
      const cartInfo = carts.map(cart => {
        const { oversized: _oversized, cartInfo: raw, ...rest } = cart;
        let snapshot: unknown = null;
        if (raw) {
          try { snapshot = JSON.parse(raw); } catch { throw new ValidateException('订单商品快照无法读取'); }
          if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new ValidateException('订单商品快照无法读取');
        }
        return { ...rest, cartInfo: snapshot };
      });
      // Headers only: callers open each child's exact detail rather than loading
      // 200 unbounded cart collections or treating source carts as current stock.
      const splitOrders = order.pid === -1 ? await db.select({ id: storeOrder.id, orderId: storeOrder.orderId,
        pid: storeOrder.pid, uid: storeOrder.uid, supplierId: storeOrder.supplierId, storeId: storeOrder.storeId,
        paid: storeOrder.paid, status: storeOrder.status, refundStatus: storeOrder.refundStatus, refundType: storeOrder.refundType,
        totalNum: storeOrder.totalNum, payPrice: storeOrder.payPrice, shippingType: storeOrder.shippingType,
      }).from(storeOrder).where(and(eq(storeOrder.pid, order.id), eq(storeOrder.uid, order.uid), visible()))
        .orderBy(asc(storeOrder.id)).limit(201) : [];
      if (splitOrders.length > 200) throw new ValidateException('订单子单过多，请按子单号查询');
      return { ...order, cartInfo, splitOrders };
    });
  }
}
