import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeOrderStatus,
  storeProduct,
  user,
} from "@/models/schema";
import {
  orderStatus,
  refundProjection,
} from "@/services/kefu/KefuOrderService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { resolveRefundReturnContact } from "@/services/order/RefundReturnContactService";

const MAX_PAGE = 1_000_000;
const MAX_LIMIT = 100;
const MAX_QUERY_TEXT = 100;
const MAX_REFUND_SELECTOR = 50;
const MAX_REMARK = 255;

type CartRow = typeof storeOrderCartInfo.$inferSelect;

export interface AdminRefundListQuery {
  page: number;
  limit: number;
  keyword: string;
  refundTypes: number | null;
  applyType: number | null;
  startTime?: number;
  endTime?: number;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function positiveInteger(
  value: unknown,
  label: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException(`${label}错误`);
  const text = value.trim();
  if (text.length > maximum) throw new ValidateException(`${label}不能超过${maximum}个字符`);
  return text;
}

function datePartEpoch(value: string, endOfDay: boolean): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return text.length === 13 ? Math.floor(numeric / 1000) : numeric;
  }
  const day = text.match(/^(\d{4}-\d{2}-\d{2})$/)?.[1];
  const parsed = Date.parse(day
    ? `${day}T${endOfDay ? "23:59:59" : "00:00:00"}+08:00`
    : text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function dateRange(value: unknown): { startTime?: number; endTime?: number } {
  const source = boundedText(value, "时间范围", MAX_QUERY_TEXT);
  if (!source) return {};
  const parts = source
    .split(/\s+(?:-|~|至)\s+|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 2) throw new ValidateException("时间范围参数错误");
  const startTime = datePartEpoch(parts[0], false);
  const endTime = datePartEpoch(parts[1] ?? parts[0], true);
  if (startTime === undefined || endTime === undefined || startTime > endTime) {
    throw new ValidateException("时间范围参数错误");
  }
  return { startTime, endTime };
}

export function parseAdminRefundListQuery(
  query: Record<string, string | undefined>,
): AdminRefundListQuery {
  return {
    page: positiveInteger(query.page, "页码", 1, MAX_PAGE),
    limit: positiveInteger(query.limit, "每页数量", 20, MAX_LIMIT),
    keyword: boundedText(query.order_id, "搜索词", MAX_QUERY_TEXT),
    refundTypes: optionalInteger(query.refundTypes, "售后状态", 0, 6),
    applyType: optionalInteger(query.apply_type, "售后类型", 0, 4),
    ...dateRange(query.time),
  };
}

export function refundTypesForFilter(value: number | null): readonly number[] | null {
  if (value === null) return null;
  return ({
    0: [0],
    1: [1, 2],
    2: [4, 5],
    3: [5],
    4: [6],
    5: [0, 1, 2, 4, 5],
    6: [3, 6],
  } as Record<number, readonly number[]>)[value] ?? null;
}

export function parseAdminRefundSelector(value: unknown): { value: string; id?: number } {
  const selector = boundedText(value, "退款单号", MAX_REFUND_SELECTOR);
  if (!selector) throw new ValidateException("参数错误");
  if (!/^\d+$/.test(selector)) return { value: selector };
  const id = Number(selector);
  return Number.isSafeInteger(id) && id > 0 ? { value: selector, id } : { value: selector };
}

export function parseAdminRefundRemark(value: unknown): string {
  if (typeof value !== "string") throw new ValidateException("请输入要备注的内容");
  const remark = value.trim();
  if (!remark) throw new ValidateException("请输入要备注的内容");
  if (remark.length > MAX_REMARK) throw new ValidateException(`备注不能超过${MAX_REMARK}个字符`);
  return remark;
}

function formatEpoch(value: number): string {
  if (!value) return "";
  const date = new Date((value + 8 * 60 * 60) * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function parseJson(value: string | null): unknown {
  if (!value || value.length > 256 * 1024) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function imageList(value: string | null): string[] {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim() && !value.trim().startsWith("[")) {
    return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20);
  }
  return [];
}

function refundPriceType(payType: string): string {
  return ({
    weixin: "原微信返还",
    yue: "余额账户返还",
    offline: "线下返还",
    alipay: "原支付宝返还",
    cash: "现金返还",
  } as Record<string, string>)[payType] ?? "其他方式返还";
}

function payTypeName(payType: string): string {
  return ({
    yue: "余额支付",
    weixin: "微信支付",
    alipay: "支付宝支付",
    offline: "线下支付",
    cash: "现金支付",
    integral: "积分支付",
    zero: "零元支付",
    friend: "好友代付",
  } as Record<string, string>)[payType] ?? "其他支付";
}

export class AdminMobileRefundService {
  constructor(private readonly container: Container) {}

  private async cartsByOrder(orderIds: number[]): Promise<Map<number, CartRow[]>> {
    const result = new Map<number, CartRow[]>();
    if (!orderIds.length) return result;
    const rows = await this.container.db.select().from(storeOrderCartInfo)
      .where(inArray(storeOrderCartInfo.oid, orderIds))
      .orderBy(storeOrderCartInfo.oid, storeOrderCartInfo.id);
    for (const row of rows) result.set(row.oid, [...(result.get(row.oid) ?? []), row]);
    return result;
  }

  private refundSearch(keyword: string): SQL | undefined {
    if (!keyword) return undefined;
    const pattern = `%${keyword}%`;
    const matchingUsers = this.container.db.select({ uid: user.uid }).from(user).where(or(
      ilike(user.nickname, pattern),
      ilike(user.phone, pattern),
      sql`${user.uid}::text ILIKE ${pattern}`,
    ));
    const matchingProducts = this.container.db.select({ id: storeProduct.id }).from(storeProduct).where(or(
      ilike(storeProduct.storeName, pattern),
      ilike(storeProduct.keyword, pattern),
    ));
    const matchingOrderCarts = this.container.db.select({ oid: storeOrderCartInfo.oid })
      .from(storeOrderCartInfo)
      .where(inArray(storeOrderCartInfo.productId, matchingProducts));
    const matchingOrders = this.container.db.select({ id: storeOrder.id }).from(storeOrder).where(or(
      ilike(storeOrder.orderId, pattern),
      ilike(storeOrder.userPhone, pattern),
      inArray(storeOrder.id, matchingOrderCarts),
    ));
    return or(
      ilike(storeOrderRefund.orderId, pattern),
      ilike(storeOrderRefund.refundExpress, pattern),
      inArray(storeOrderRefund.uid, matchingUsers),
      inArray(storeOrderRefund.storeOrderId, matchingOrders),
    );
  }

  async list(rawQuery: Record<string, string | undefined>) {
    const query = parseAdminRefundListQuery(rawQuery);
    const filters: SQL[] = [
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
    ];
    const refundTypes = refundTypesForFilter(query.refundTypes);
    if (refundTypes?.length === 1) filters.push(eq(storeOrderRefund.refundType, refundTypes[0]));
    else if (refundTypes) filters.push(inArray(storeOrderRefund.refundType, [...refundTypes]));
    if (query.applyType !== null) filters.push(eq(storeOrderRefund.applyType, query.applyType));
    if (query.startTime !== undefined) filters.push(gte(storeOrderRefund.addTime, query.startTime));
    if (query.endTime !== undefined) filters.push(lte(storeOrderRefund.addTime, query.endTime));
    const search = this.refundSearch(query.keyword);
    if (search) filters.push(search);

    const rows = await this.container.db.select().from(storeOrderRefund)
      .where(and(...filters))
      .orderBy(desc(storeOrderRefund.addTime), desc(storeOrderRefund.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);
    const orderIds = [...new Set(rows.map((row) => row.storeOrderId))];
    const [carts, orders] = await Promise.all([
      this.cartsByOrder(orderIds),
      orderIds.length
        ? this.container.db.select({
          id: storeOrder.id,
          order_id: storeOrder.orderId,
          product_type: storeOrder.productType,
          shipping_type: storeOrder.shippingType,
        }).from(storeOrder).where(inArray(storeOrder.id, orderIds))
        : Promise.resolve([]),
    ]);
    const ordersById = new Map(orders.map((order) => [order.id, order]));
    return rows.map((row) => ({
      ...refundProjection(row, carts.get(row.storeOrderId) ?? [], true),
      store_order_sn: ordersById.get(row.storeOrderId)?.order_id ?? "",
      product_type: ordersById.get(row.storeOrderId)?.product_type ?? 0,
      shipping_type: ordersById.get(row.storeOrderId)?.shipping_type ?? 0,
    }));
  }

  async detail(rawSelector: unknown) {
    const selector = parseAdminRefundSelector(rawSelector);
    const identity = selector.id
      ? or(eq(storeOrderRefund.id, selector.id), eq(storeOrderRefund.orderId, selector.value))
      : eq(storeOrderRefund.orderId, selector.value);
    const refund = (await this.container.db.select().from(storeOrderRefund).where(and(
      identity,
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
    )).limit(1))[0];
    if (!refund) throw new NotFoundException("订单不存在");

    const order = (await this.container.db.select().from(storeOrder).where(and(
      eq(storeOrder.id, refund.storeOrderId),
      eq(storeOrder.uid, refund.uid),
    )).limit(1))[0];
    if (!order) throw new NotFoundException("原订单不存在");
    const [carts, users] = await Promise.all([
      this.container.db.select().from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.oid, order.id))
        .orderBy(storeOrderCartInfo.id),
      this.container.db.select({ nickname: user.nickname }).from(user)
        .where(eq(user.uid, refund.uid)).limit(1),
    ]);
    const projected = refundProjection(refund, carts);
    const returnContact = await resolveRefundReturnContact(this.container, refund);
    return {
      ...projected,
      refund_img: imageList(refund.refundImg),
      refund_goods_explain: refund.refundGoodsExplain,
      refund_goods_img: imageList(refund.refundGoodsImg),
      store_order_sn: order.orderId,
      shipping_type: order.shippingType,
      real_name: order.realName,
      user_phone: order.userPhone,
      user_address: order.userAddress,
      type: order.type,
      product_type: order.productType,
      first_order_price: order.firstOrderPrice,
      custom_form: parseJson(order.customForm),
      mark: order.mark,
      spread_uid: order.spreadUid,
      delivery_type: order.deliveryType,
      delivery_name: order.deliveryName,
      delivery_code: order.deliveryCode,
      delivery_id: order.deliveryId,
      nickname: users[0]?.nickname ?? "",
      _pay_time: formatEpoch(order.payTime),
      _refund_time: formatEpoch(refund.addTime),
      refund_price_type: refundPriceType(order.payType),
      refund_status: [0, 1, 2, 4, 5].includes(refund.refundType) ? 1 : 2,
      orderStatus: orderStatus(order),
      _status: {
        ...projected._status,
        _payType: payTypeName(order.payType),
        refund_name: returnContact.name,
        refund_phone: returnContact.phone,
        refund_address: returnContact.address,
      },
      return_contact: returnContact,
    };
  }

  async updateRemark(adminId: number, body: unknown): Promise<{ changed: boolean }> {
    if (!Number.isSafeInteger(adminId) || adminId <= 0) throw new ValidateException("管理员身份不存在");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidateException("请求数据格式错误");
    }
    const input = body as Record<string, unknown>;
    const selector = parseAdminRefundSelector(input.order_id);
    const remark = parseAdminRefundRemark(input.remark);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      const refund = (await tx.select().from(storeOrderRefund).where(and(
        eq(storeOrderRefund.orderId, selector.value),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).for("update").limit(1))[0];
      if (!refund) throw new NotFoundException("修改的订单不存在!");
      if (refund.remark === remark) return { changed: false };
      await tx.update(storeOrderRefund).set({ remark }).where(eq(storeOrderRefund.id, refund.id));
      await tx.insert(storeOrderStatus).values({
        oid: refund.storeOrderId,
        changeType: "admin_refund_remark",
        changeMessage: `管理员 ${adminId} 更新售后备注`,
        changeTime: Math.floor(Date.now() / 1000),
      });
      return { changed: true };
    });
  }
}
