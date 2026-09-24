import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeOrder, storeSeckill } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

export interface SeckillStatisticsQuery {
  page: number;
  limit: number;
  realName: string;
  status?: 0 | 1 | 2 | 3 | 4;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/u.test(raw)) throw new ValidateException(`${label}无效`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException(`${label}无效`);
  return value;
}

export function parseSeckillStatisticsId(raw: string | undefined): number {
  if (!raw) throw new ValidateException("秒杀商品ID无效");
  return boundedInteger(raw, 0, 1, 2_147_483_647, "秒杀商品ID");
}

export function parseSeckillStatisticsQuery(raw: Record<string, string>): SeckillStatisticsQuery {
  const status = raw.status?.trim();
  if (status && !["0", "1", "2", "3", "4"].includes(status)) throw new ValidateException("订单状态无效");
  const realName = (raw.real_name ?? "").trim();
  if (realName.length > 100 || /[\u0000-\u001f\u007f]/u.test(realName)) throw new ValidateException("搜索词无效");
  const page = boundedInteger(raw.page, 1, 1, 10_000, "页码");
  const limit = boundedInteger(raw.limit, 15, 1, 100, "每页数量");
  if ((page - 1) * limit > 100_000) throw new ValidateException("分页范围过大");
  return { page, limit, realName, status: status === undefined || status === "" ? undefined : Number(status) as 0 | 1 | 2 | 3 | 4 };
}

function literalLike(value: string): string {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

function baseOrders(id: number): SQL {
  // PHP includes historical deleted orders in the unfiltered statistics.
  return and(eq(storeOrder.type, 1), eq(storeOrder.activityId, id), inArray(storeOrder.pid, [0, -1]))!;
}

function searchedPeople(query: SeckillStatisticsQuery): SQL | undefined {
  if (!query.realName) return undefined;
  const pattern = literalLike(query.realName);
  return or(ilike(storeOrder.realName, pattern), ilike(storeOrder.userPhone, pattern),
    sql`${storeOrder.uid}::text ILIKE ${pattern}`);
}

function searchedOrders(query: SeckillStatisticsQuery): SQL | undefined {
  if (!query.realName) return undefined;
  const pattern = literalLike(query.realName);
  return or(searchedPeople(query), ilike(storeOrder.orderId, pattern));
}

function statusPredicate(status: SeckillStatisticsQuery["status"]): SQL | undefined {
  if (status === undefined) return undefined;
  // The legacy list is always paid=1; its unpaid option therefore has no matching rows.
  if (status === 0) return eq(storeOrder.paid, 0);
  const active = and(eq(storeOrder.isDel, 0), inArray(storeOrder.refundStatus, [0, 3]));
  if (status === 1) return and(active, inArray(storeOrder.status, [0, 4]), inArray(storeOrder.shippingType, [1, 3]));
  if (status === 2) return and(active, or(
    and(inArray(storeOrder.status, [1, 5]), eq(storeOrder.shippingType, 1)),
    and(inArray(storeOrder.status, [0, 5]), eq(storeOrder.shippingType, 2)),
  ));
  return and(active, eq(storeOrder.status, status === 3 ? 2 : 3));
}

function orderStatus(row: {
  isDel: number; isSystemDel: number; paid: number; status: number;
  shippingType: number; refundStatus: number;
}): string {
  if (row.isDel || row.isSystemDel) return "已删除";
  if (!row.paid) return "待付款";
  if (row.status === 4 && [1, 3].includes(row.shippingType) && row.refundStatus === 0) return "部分发货";
  if (row.refundStatus === 2) return "已退款";
  if (row.status === 5 && row.refundStatus === 0) return row.shippingType === 2 ? "部分核销" : "部分收货";
  if (row.refundStatus === 1) return "申请退款";
  if (row.refundStatus === 4) return "退款中";
  if (row.status === 0 && [1, 3].includes(row.shippingType) && row.refundStatus === 0) return "未发货";
  if ([0, 1].includes(row.status) && row.shippingType === 2 && row.refundStatus === 0) return "未核销";
  if ([1, 5].includes(row.status) && [1, 3].includes(row.shippingType) && row.refundStatus === 0) return "待收货";
  if (row.status === 2 && row.refundStatus === 0) return "待评价";
  if (row.status === 3 && row.refundStatus === 0) return "已完成";
  if (row.refundStatus === 3) return "部分退款";
  return "未知";
}

/** Three read-only datasets from the legacy seckill product statistics screen. */
export class AdminSeckillStatisticsService {
  constructor(private readonly container: Container) {}

  private async requireSeckill(id: number) {
    const [item] = await this.container.db.select({
      id: storeSeckill.id, storeName: storeSeckill.storeName,
      quota: storeSeckill.quota, quotaShow: storeSeckill.quotaShow,
    }).from(storeSeckill).where(eq(storeSeckill.id, id)).limit(1);
    if (!item) throw new NotFoundException("秒杀商品不存在");
    return item;
  }

  async head(id: number) {
    const item = await this.requireSeckill(id);
    const [totals] = await this.container.db.select({
      orderCount: sql<number>`COUNT(DISTINCT ${storeOrder.uid})::int`,
      payCount: sql<number>`COUNT(DISTINCT ${storeOrder.uid}) FILTER (WHERE ${storeOrder.paid} = 1)::int`,
      allPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}) FILTER (WHERE ${storeOrder.paid} = 1 AND ${storeOrder.refundType} IN (0, 3)), 0)::numeric(14,2)::text`,
    }).from(storeOrder).where(baseOrders(id));
    return {
      id: item.id, store_name: item.storeName,
      order_count: totals?.orderCount ?? 0,
      all_price: totals?.allPrice ?? "0.00",
      pay_count: totals?.payCount ?? 0,
      // Legacy key pay_rate means remaining/total stock, not a payment conversion rate.
      pay_rate: `${item.quota}/${item.quotaShow}`,
    };
  }

  async people(id: number, query: SeckillStatisticsQuery) {
    await this.requireSeckill(id);
    const where = and(baseOrders(id), eq(storeOrder.paid, 1), searchedPeople(query));
    const [rows, totals] = await Promise.all([
      this.container.db.select({
        uid: storeOrder.uid,
        realName: sql<string>`(ARRAY_AGG(${storeOrder.realName} ORDER BY ${storeOrder.addTime} DESC, ${storeOrder.id} DESC))[1]`,
        goodsNum: sql<number>`COALESCE(SUM(${storeOrder.totalNum}), 0)::int`,
        orderNum: sql<number>`COUNT(*)::int`,
        totalPrice: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::numeric(14,2)::text`,
        addTime: sql<number>`MAX(${storeOrder.addTime})::int`,
      }).from(storeOrder).where(where).groupBy(storeOrder.uid)
        .orderBy(desc(sql`MAX(${storeOrder.addTime})`), desc(storeOrder.uid))
        .limit(query.limit).offset((query.page - 1) * query.limit),
      this.container.db.select({ count: sql<number>`COUNT(DISTINCT ${storeOrder.uid})::int` })
        .from(storeOrder).where(where),
    ]);
    return {
      list: rows.map((row) => ({ uid: row.uid, real_name: row.realName,
        goods_num: row.goodsNum, order_num: row.orderNum, total_price: row.totalPrice, add_time: row.addTime })),
      count: totals[0]?.count ?? 0, page: query.page, limit: query.limit,
    };
  }

  async orders(id: number, query: SeckillStatisticsQuery) {
    await this.requireSeckill(id);
    // Deliberate correction: PHP's list uses paid main orders, but its count omits both filters.
    // Applying exactly one predicate to list and count keeps paging honest.
    const where = and(baseOrders(id), eq(storeOrder.paid, 1), searchedOrders(query), statusPredicate(query.status));
    const [rows, totals] = await Promise.all([
      this.container.db.select({
        id: storeOrder.id, orderId: storeOrder.orderId, uid: storeOrder.uid,
        realName: storeOrder.realName, status: storeOrder.status,
        payPrice: storeOrder.payPrice, totalNum: storeOrder.totalNum,
        addTime: storeOrder.addTime, payTime: storeOrder.payTime,
        paid: storeOrder.paid, shippingType: storeOrder.shippingType,
        refundStatus: storeOrder.refundStatus, isDel: storeOrder.isDel,
        isSystemDel: storeOrder.isSystemDel,
      }).from(storeOrder).where(where).orderBy(desc(storeOrder.addTime), desc(storeOrder.id))
        .limit(query.limit).offset((query.page - 1) * query.limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(storeOrder).where(where),
    ]);
    return {
      list: rows.map((row) => ({ id: row.id, order_id: row.orderId, uid: row.uid,
        real_name: row.realName, status: orderStatus(row), pay_price: row.payPrice,
        total_num: row.totalNum, add_time: row.addTime, pay_time: row.payTime })),
      count: totals[0]?.count ?? 0, page: query.page, limit: query.limit,
    };
  }
}
