import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  deliveryService,
  storeOrder,
  storeOrderCartInfo,
  systemStore,
  systemStoreStaff,
  user,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const SHANGHAI_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 10_000;
const MAX_RANGE_DAYS = 366;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

export interface DeliveryTimeRange {
  start: number;
  endExclusive: number;
}

function shanghaiMidnight(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month, day) / 1_000) - SHANGHAI_OFFSET_SECONDS;
}

function shiftedDate(seconds: number): Date {
  return new Date((seconds + SHANGHAI_OFFSET_SECONDS) * 1_000);
}

function currentShanghaiDay(nowSeconds: number): number {
  const date = shiftedDate(nowSeconds);
  return shanghaiMidnight(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function calendarBoundary(nowSeconds: number, kind: "month" | "year" | "quarter") {
  const date = shiftedDate(nowSeconds);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (kind === "year") {
    return { start: shanghaiMidnight(year, 0, 1), endExclusive: shanghaiMidnight(year + 1, 0, 1) };
  }
  const firstMonth = kind === "quarter" ? Math.floor(month / 3) * 3 : month;
  const span = kind === "quarter" ? 3 : 1;
  return {
    start: shanghaiMidnight(year, firstMonth, 1),
    endExclusive: shanghaiMidnight(year, firstMonth + span, 1),
  };
}

function parseShanghaiDate(match: RegExpMatchArray): number {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = shanghaiMidnight(year, month - 1, day);
  const roundTrip = shiftedDate(value);
  if (
    year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31
    || roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
  ) {
    throw new ValidateException("统计日期格式错误");
  }
  return value;
}

/** ThinkPHP ModelTrait time tokens, interpreted explicitly in Asia/Shanghai. */
export function parseLegacyDeliveryTimeRange(
  rawValue: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1_000),
): DeliveryTimeRange | undefined {
  const value = rawValue?.trim().toLowerCase() ?? "";
  if (!value) return undefined;
  const today = currentShanghaiDay(nowSeconds);
  if (value === "today") return { start: today, endExclusive: today + DAY_SECONDS };
  if (value === "yesterday") return { start: today - DAY_SECONDS, endExclusive: today };
  if (value === "lately7" || value === "lately30") {
    const days = value === "lately7" ? 7 : 30;
    return { start: nowSeconds - days * DAY_SECONDS, endExclusive: nowSeconds + 1 };
  }
  if (["week", "last week"].includes(value)) {
    const weekday = shiftedDate(today).getUTCDay();
    const thisWeek = today - ((weekday + 6) % 7) * DAY_SECONDS;
    return value === "week"
      ? { start: thisWeek, endExclusive: thisWeek + 7 * DAY_SECONDS }
      : { start: thisWeek - 7 * DAY_SECONDS, endExclusive: thisWeek };
  }
  if (["month", "last month"].includes(value)) {
    const current = calendarBoundary(nowSeconds, "month");
    if (value === "month") return current;
    const date = shiftedDate(current.start - 1);
    return {
      start: shanghaiMidnight(date.getUTCFullYear(), date.getUTCMonth(), 1),
      endExclusive: current.start,
    };
  }
  if (["year", "last year"].includes(value)) {
    const current = calendarBoundary(nowSeconds, "year");
    return value === "year"
      ? current
      : { start: shanghaiMidnight(shiftedDate(current.start - 1).getUTCFullYear(), 0, 1), endExclusive: current.start };
  }
  if (value === "quarter") return calendarBoundary(nowSeconds, "quarter");

  const dates = [...value.matchAll(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/g)];
  if (dates.length !== 2) throw new ValidateException("统计时间范围错误");
  const start = parseShanghaiDate(dates[0]);
  const endDay = parseShanghaiDate(dates[1]);
  if (endDay < start) throw new ValidateException("统计结束日期不能早于开始日期");
  const days = Math.floor((endDay - start) / DAY_SECONDS) + 1;
  if (days > MAX_RANGE_DAYS) throw new ValidateException(`统计跨度不能超过${MAX_RANGE_DAYS}天`);
  return { start, endExclusive: endDay + DAY_SECONDS };
}

export function normalizeMobileDeliveryPage(pageValue?: string, limitValue?: string) {
  const page = pageValue === undefined || pageValue === "" ? 1 : Number(pageValue);
  const limit = limitValue === undefined || limitValue === "" ? 15 : Number(limitValue);
  if (!Number.isSafeInteger(page) || page <= 0) throw new ValidateException("页码错误");
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
    throw new ValidateException(`每页数量必须在1到${MAX_PAGE_SIZE}之间`);
  }
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset > MAX_OFFSET) throw new ValidateException("分页范围过大");
  return { page, limit, offset };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function snapshot(value: string | null): Record<string, unknown> | undefined {
  if (!value || value.length > MAX_SNAPSHOT_BYTES) return undefined;
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function cartProjection(row: typeof storeOrderCartInfo.$inferSelect) {
  const source = snapshot(row.cartInfo);
  const product = record(source?.product);
  const productInfo = record(source?.productInfo) ?? product;
  const sku = record(source?.sku);
  const attrInfo = record(productInfo?.attrInfo) ?? sku;
  const image = stringValue(attrInfo?.image ?? productInfo?.image ?? product?.image);
  const price = stringValue(attrInfo?.price ?? source?.truePrice ?? source?.true_price, "0.00");
  return {
    id: row.id,
    cart_id: row.cartId,
    product_id: row.productId,
    cart_num: row.cartNum,
    is_gift: row.isGift,
    productInfo: {
      id: Number(productInfo?.id ?? row.productId),
      store_name: stringValue(productInfo?.store_name ?? productInfo?.storeName ?? product?.store_name ?? product?.storeName, "商品快照"),
      image,
      attrInfo: {
        suk: stringValue(attrInfo?.suk ?? sku?.suk ?? row.skuUnique),
        image,
        price,
      },
    },
  };
}

function rangeConditions(range: DeliveryTimeRange | undefined): SQL[] {
  if (!range) return [];
  return [gte(storeOrder.addTime, range.start), lt(storeOrder.addTime, range.endExclusive)];
}

export class StoreMobileDeliveryService {
  constructor(private readonly container: Container) {}

  private validateUid(uid: number) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户身份无效");
  }

  private async requireDeliveryScope(uid: number, storeId = 0) {
    this.validateUid(uid);
    if (!Number.isSafeInteger(storeId) || storeId < 0) throw new ValidateException("门店ID错误");
    const rows = await this.container.db
      .select({ id: deliveryService.id })
      .from(deliveryService)
      .innerJoin(user, eq(user.uid, deliveryService.uid))
      .leftJoin(systemStore, eq(systemStore.id, deliveryService.relationId))
      .where(and(
        eq(deliveryService.uid, uid),
        eq(deliveryService.status, 1),
        eq(deliveryService.isDel, 0),
        eq(user.status, 1),
        eq(user.isDel, 0),
        storeId > 0 ? eq(deliveryService.type, 1) : undefined,
        storeId > 0 ? eq(deliveryService.relationId, storeId) : undefined,
        storeId > 0 ? eq(systemStore.isShow, 1) : undefined,
        storeId > 0 ? eq(systemStore.isDel, 0) : undefined,
      ))
      .orderBy(asc(deliveryService.id))
      .limit(storeId > 0 ? 2 : 1);
    if (!rows.length) throw new NotFoundException("配送员不存在或无权访问该门店");
    if (storeId > 0 && rows.length !== 1) throw new ValidateException("配送员门店身份存在重复，请先清理历史数据");
  }

  async info(uid: number) {
    this.validateUid(uid);
    const rows = await this.container.db
      .select({
        id: deliveryService.id,
        uid: deliveryService.uid,
        type: deliveryService.type,
        relation_id: deliveryService.relationId,
        avatar: deliveryService.avatar,
        nickname: deliveryService.nickname,
        phone: deliveryService.phone,
        add_time: deliveryService.addTime,
        status: deliveryService.status,
        user_nickname: user.nickname,
      })
      .from(deliveryService)
      .innerJoin(user, eq(user.uid, deliveryService.uid))
      .where(and(
        eq(deliveryService.uid, uid),
        eq(deliveryService.status, 1),
        eq(deliveryService.isDel, 0),
        eq(user.status, 1),
        eq(user.isDel, 0),
      ))
      .orderBy(asc(deliveryService.id))
      .limit(101);
    if (!rows.length) throw new NotFoundException("配送员不存在");
    if (rows.length > 100) throw new ValidateException("配送员身份数量异常，请先清理历史数据");
    const platform = rows.filter((row) => row.type === 0 && row.relation_id === 0);
    if (platform.length > 1) throw new ValidateException("平台配送员身份存在重复，请先清理历史数据");
    const selected = platform[0] ?? rows[0];
    const storeIds = [...new Set(rows
      .filter((row) => row.type === 1 && row.relation_id > 0)
      .map((row) => row.relation_id))];
    const stores = storeIds.length
      ? await this.container.db.select({ id: systemStore.id, name: systemStore.name })
          .from(systemStore)
          .where(and(
            inArray(systemStore.id, storeIds),
            eq(systemStore.isShow, 1),
            eq(systemStore.isDel, 0),
          ))
          .orderBy(asc(systemStore.id))
      : [];
    return { ...selected, store_info: stores };
  }

  async deliveryList(uid: number, query: Record<string, string>) {
    this.validateUid(uid);
    const staff = await this.container.db
      .select({ id: systemStoreStaff.id, storeId: systemStoreStaff.storeId })
      .from(systemStoreStaff)
      .innerJoin(systemStore, eq(systemStore.id, systemStoreStaff.storeId))
      .innerJoin(user, eq(user.uid, systemStoreStaff.uid))
      .where(and(
        eq(systemStoreStaff.uid, uid),
        eq(systemStoreStaff.status, 1),
        eq(systemStoreStaff.isDel, 0),
        eq(systemStore.isShow, 1),
        eq(systemStore.isDel, 0),
        eq(user.status, 1),
        eq(user.isDel, 0),
      ))
      .orderBy(asc(systemStoreStaff.id))
      .limit(2);
    if (!staff.length) throw new NotFoundException("店员不存在或所属门店已停用");
    if (staff.length !== 1) throw new ValidateException("店员身份存在重复，请先选择明确门店");
    const { limit, offset } = normalizeMobileDeliveryPage(query.page, query.limit);
    const rows = await this.container.db
      .select({
        id: deliveryService.id,
        uid: deliveryService.uid,
        avatar: deliveryService.avatar,
        wx_name: deliveryService.nickname,
        phone: deliveryService.phone,
        status: deliveryService.status,
        add_time: deliveryService.addTime,
        user_nickname: user.nickname,
      })
      .from(deliveryService)
      .innerJoin(user, eq(user.uid, deliveryService.uid))
      .where(and(
        eq(deliveryService.type, 1),
        eq(deliveryService.relationId, staff[0].storeId),
        eq(deliveryService.status, 1),
        eq(deliveryService.isDel, 0),
        eq(user.status, 1),
        eq(user.isDel, 0),
      ))
      .orderBy(desc(deliveryService.id))
      .limit(limit)
      .offset(offset);
    return rows.map(({ user_nickname, ...row }) => ({
      ...row,
      nickname: user_nickname || row.wx_name,
    }));
  }

  private baseOrderConditions(uid: number, storeId: number, range?: DeliveryTimeRange): SQL[] {
    return [
      eq(storeOrder.deliveryUid, uid),
      eq(storeOrder.paid, 1),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
      inArray(storeOrder.refundStatus, [0, 3]),
      ...(storeId > 0 ? [eq(storeOrder.storeId, storeId)] : []),
      ...rangeConditions(range),
    ];
  }

  async statistics(uid: number, query: Record<string, string>) {
    const storeId = query.store_id ? Number(query.store_id) : 0;
    await this.requireDeliveryScope(uid, storeId);
    const range = parseLegacyDeliveryTimeRange(query.data ?? query.time);
    const rows = await this.container.db.select({
      unsend: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.status} = 2)::int`,
      send: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.status} = 9)::int`,
      send_price: sql<string>`CAST(COALESCE(SUM(${storeOrder.payPrice}) FILTER (WHERE ${storeOrder.status} = 9), 0) AS numeric(20,2))::text`,
    }).from(storeOrder).where(and(...this.baseOrderConditions(uid, storeId, range)));
    return rows[0] ?? { unsend: 0, send: 0, send_price: "0.00" };
  }

  async data(uid: number, query: Record<string, string>) {
    const storeId = query.store_id ? Number(query.store_id) : 0;
    await this.requireDeliveryScope(uid, storeId);
    const range = parseLegacyDeliveryTimeRange(query.data ?? query.time);
    const { limit, offset } = normalizeMobileDeliveryPage(query.page, query.limit);
    const bucket = sql<string>`to_char(to_timestamp(${storeOrder.addTime}) AT TIME ZONE 'Asia/Shanghai', 'MM-DD')`;
    return this.container.db.select({
      price: sql<string>`CAST(COALESCE(SUM(${storeOrder.payPrice}), 0) AS numeric(20,2))::text`,
      count: sql<number>`COUNT(*)::int`,
      time: bucket,
    }).from(storeOrder)
      .where(and(...this.baseOrderConditions(uid, storeId, range)))
      .groupBy(bucket)
      .orderBy(desc(sql`MAX(${storeOrder.addTime})`))
      .limit(limit)
      .offset(offset);
  }

  async orders(uid: number, query: Record<string, string>) {
    await this.requireDeliveryScope(uid);
    const type = query.type === undefined || query.type === "" ? 1 : Number(query.type);
    if (type !== 1 && type !== 2) throw new ValidateException("配送订单类型错误");
    const { limit, offset } = normalizeMobileDeliveryPage(query.page, query.limit);
    const base = this.baseOrderConditions(uid, 0);
    const status = type === 1 ? 2 : 9;
    const [orders, counters] = await Promise.all([
      this.container.db.select().from(storeOrder)
        .where(and(...base, eq(storeOrder.status, status)))
        .orderBy(desc(storeOrder.id))
        .limit(limit)
        .offset(offset),
      this.container.db.select({
        unsend: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.status} = 2)::int`,
        send: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.status} = 9)::int`,
      }).from(storeOrder).where(and(...base)),
    ]);
    const cartRows = orders.length
      ? await this.container.db.select().from(storeOrderCartInfo)
          .where(inArray(storeOrderCartInfo.oid, orders.map((order) => order.id)))
          .orderBy(asc(storeOrderCartInfo.oid), asc(storeOrderCartInfo.id))
      : [];
    const byOrder = new Map<number, Array<typeof storeOrderCartInfo.$inferSelect>>();
    for (const cart of cartRows) byOrder.set(cart.oid, [...(byOrder.get(cart.oid) ?? []), cart]);
    return {
      data: counters[0] ?? { unsend: 0, send: 0 },
      list: orders.map((order) => {
        const carts = byOrder.get(order.id) ?? [];
        const projected = carts.map(cartProjection);
        return {
          id: order.id,
          pid: order.pid,
          order_id: order.orderId,
          real_name: order.realName,
          user_phone: order.userPhone,
          user_address: order.userAddress,
          total_num: order.totalNum,
          total_price: order.totalPrice,
          pay_price: order.payPrice,
          paid: order.paid,
          status: order.status,
          shipping_type: order.shippingType,
          delivery_type: order.deliveryType,
          delivery_name: order.deliveryName,
          delivery_id: order.deliveryId,
          store_id: order.storeId,
          add_time: order.addTime,
          cart_id: carts.map((cart) => cart.cartId),
          cartInfo: projected,
          _info: projected.map((cart) => ({ cart_info: cart })),
        };
      }),
    };
  }
}
