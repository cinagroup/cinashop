import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { storeOrder, storeOrderCartInfo } from "@/models/schema";
import { StoreOrderCreateService } from "@/services/order/StoreOrderCreateService";
import { NotFoundException } from "@/utils/errors";

export const INTEGRAL_ORDER_TYPE = 4;

type OrderState = { paid: number; status: number };

/** Unified store_order status labels used by the legacy integral-order routes. */
export function integralOrderStatusName(order: OrderState): string {
  if (order.paid !== 1) return "待付款";
  switch (order.status) {
    case 0:
      return "待发货";
    case 1:
    case 4:
      return "待收货";
    case 2:
      return "待评价";
    case 3:
      return "已完成";
    case -2:
      return "已取消";
    default:
      return "处理中";
  }
}

export function formatIntegralOrder<T extends OrderState>(order: T) {
  const statusName = integralOrderStatusName(order);
  return { ...order, statusName, status_name: statusName };
}

function parseSnapshot(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export interface AdminIntegralOrderQuery {
  page?: number;
  limit?: number;
  status?: number;
  paid?: number;
  uid?: number;
  orderId?: string;
}

/**
 * Compatibility reads for the active PHP integral-order contract.
 * New orders live in store_order(type=4); the historical store_integral_order
 * table is intentionally not mixed into this live state machine.
 */
export class StoreIntegralOrderService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async userList(uid: number, page = 1, limit = 10) {
    const service = new StoreOrderCreateService(this.container, this.env);
    const rows = await service.list(uid, {
      type: INTEGRAL_ORDER_TYPE,
      paid: 1,
      page,
      limit,
    });
    return rows.map(formatIntegralOrder);
  }

  async userDetail(uid: number, orderId: string) {
    const service = new StoreOrderCreateService(this.container, this.env);
    const order = await service.detail(uid, orderId);
    if (order.type !== INTEGRAL_ORDER_TYPE || order.paid !== 1) {
      throw new NotFoundException("积分订单不存在");
    }
    return formatIntegralOrder(order);
  }

  async userDelete(uid: number, orderId: string): Promise<void> {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid || order.type !== INTEGRAL_ORDER_TYPE) {
      throw new NotFoundException("积分订单不存在");
    }
    const service = new StoreOrderCreateService(this.container, this.env);
    await service.del(uid, orderId);
  }

  async adminList(query: AdminIntegralOrderQuery) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.max(1, Math.min(Math.trunc(query.limit ?? 10), 100));
    const conditions = [
      eq(storeOrder.type, INTEGRAL_ORDER_TYPE),
      eq(storeOrder.isSystemDel, 0),
    ];
    if (query.status !== undefined) conditions.push(eq(storeOrder.status, query.status));
    if (query.paid !== undefined) conditions.push(eq(storeOrder.paid, query.paid));
    if (query.uid) conditions.push(eq(storeOrder.uid, query.uid));
    if (query.orderId) conditions.push(eq(storeOrder.orderId, query.orderId));
    const where = and(...conditions);

    const [orders, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(storeOrder)
        .where(where)
        .orderBy(desc(storeOrder.addTime), desc(storeOrder.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeOrder)
        .where(where),
    ]);
    const cartRows = orders.length
      ? await this.container.db
          .select()
          .from(storeOrderCartInfo)
          .where(inArray(storeOrderCartInfo.oid, orders.map((order) => order.id)))
          .orderBy(storeOrderCartInfo.id)
      : [];
    const cartsByOrder = new Map<number, Array<Record<string, unknown>>>();
    for (const cart of cartRows) {
      const rows = cartsByOrder.get(cart.oid) ?? [];
      rows.push({ ...cart, cartInfo: parseSnapshot(cart.cartInfo) });
      cartsByOrder.set(cart.oid, rows);
    }
    const list = orders.map((order) =>
      formatIntegralOrder({ ...order, cartInfo: cartsByOrder.get(order.id) ?? [] }),
    );
    return { list, count: countRows[0]?.count ?? 0, page, limit };
  }

  async adminChart() {
    const rows = await this.container.db
      .select({
        statusAll: sql<number>`COUNT(*)::int`,
        unpaid: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.paid} = 0)::int`,
        unshipped: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.paid} = 1 AND ${storeOrder.status} = 0)::int`,
        partshipped: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.paid} = 1 AND ${storeOrder.status} = 4)::int`,
        untake: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.paid} = 1 AND ${storeOrder.status} = 1)::int`,
        unevaluate: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.paid} = 1 AND ${storeOrder.status} = 2)::int`,
        complete: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.paid} = 1 AND ${storeOrder.status} = 3)::int`,
      })
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.type, INTEGRAL_ORDER_TYPE),
          eq(storeOrder.isSystemDel, 0),
        ),
      );
    const row = rows[0] ?? {
      statusAll: 0,
      unpaid: 0,
      unshipped: 0,
      partshipped: 0,
      untake: 0,
      unevaluate: 0,
      complete: 0,
    };
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value)]));
  }
}
