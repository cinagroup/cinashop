import {
  and,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderInvoice,
  storeOrderPromotions,
  storeOrderRefund,
  storeProduct,
  storeServiceRecord,
  user,
} from "@/models/schema";
import { assertKefuConversation, parseKefuPageLimit } from "@/services/kefu/KefuCoreService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_PAGE = 1_000_000;
const MAX_QUERY_TEXT = 100;
const MAX_JSON_SNAPSHOT_BYTES = 256 * 1024;
const ACTIVE_REFUND_TYPES = [0, 1, 2, 4, 5] as const;
const CUSTOMER_ORDER_REFUND_TYPES = [0, 1, 3, 6] as const;
const ORDER_STATUS_FILTERS = new Set([-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

type OrderRow = typeof storeOrder.$inferSelect;
type CartRow = typeof storeOrderCartInfo.$inferSelect;
type RefundRow = typeof storeOrderRefund.$inferSelect;

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

export function parseKefuOrderPage(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const parsed = positiveInteger(value, "页码");
  if (parsed > MAX_PAGE) throw new ValidateException("页码错误");
  return parsed;
}

export function parseKefuOrderStatus(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || !ORDER_STATUS_FILTERS.has(parsed)) {
    throw new ValidateException("订单状态错误");
  }
  return parsed;
}

function queryText(value: unknown, label: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException(`${label}错误`);
  const text = value.trim();
  if (text.length > MAX_QUERY_TEXT) throw new ValidateException(`${label}不能超过${MAX_QUERY_TEXT}个字符`);
  return text;
}

function optionalRefundType(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 6) {
    throw new ValidateException("退款状态错误");
  }
  return parsed;
}

function formatEpoch(value: number, withSeconds = true): string {
  if (!value) return "";
  const date = new Date((value + 8 * 60 * 60) * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  const result = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  return withSeconds ? `${result}:${pad(date.getUTCSeconds())}` : result;
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

function dateRange(value: unknown): { start?: number; end?: number } {
  const source = queryText(value, "时间范围");
  if (!source) return {};
  const parts = source.split(/\s+(?:-|~|至)\s+|,/).map((item) => item.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) throw new ValidateException("时间范围参数错误");
  const start = datePartEpoch(parts[0], false);
  const end = datePartEpoch(parts[1] ?? parts[0], true);
  if (start === undefined || end === undefined || start > end) {
    throw new ValidateException("时间范围参数错误");
  }
  return { start, end };
}

function parseSnapshot(value: string | null): unknown {
  if (!value || value.length > MAX_JSON_SNAPSHOT_BYTES) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function money(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

export function cartProjection(row: CartRow) {
  const snapshot = record(parseSnapshot(row.cartInfo));
  const product = record(snapshot?.product);
  const productInfo = record(snapshot?.productInfo) ?? product;
  const sku = record(snapshot?.sku);
  const attrInfo = record(productInfo?.attrInfo) ?? sku;
  const truePrice = textValue(snapshot?.truePrice ?? snapshot?.true_price ?? attrInfo?.price ?? productInfo?.price, "0.00");
  const vipTruePrice = textValue(snapshot?.vip_truePrice ?? snapshot?.vip_true_price, "0.00");
  const storeName = textValue(productInfo?.store_name ?? productInfo?.storeName ?? product?.store_name ?? product?.storeName, "商品快照");
  const image = textValue(attrInfo?.image ?? productInfo?.image ?? product?.image);
  const suk = textValue(attrInfo?.suk ?? sku?.suk ?? row.skuUnique);
  return {
    unique: row.unique,
    id: row.id,
    cart_id: row.cartId,
    product_id: row.productId,
    product_type: row.productType,
    cart_num: row.cartNum,
    refund_num: row.refundNum,
    surplus_num: row.surplusNum,
    is_gift: row.isGift,
    is_support_refund: row.isSupportRefund,
    truePrice,
    vip_truePrice: vipTruePrice,
    vip_sum_truePrice: money(Number(vipTruePrice) * Math.max(row.cartNum, 1)),
    sum_true_price: money(Number(truePrice) * row.cartNum),
    postage_price: textValue(snapshot?.postage_price ?? snapshot?.postagePrice, "0.00"),
    coupon_price: textValue(snapshot?.coupon_price ?? snapshot?.couponPrice, "0.00"),
    integral_price: textValue(snapshot?.integral_price ?? snapshot?.integralPrice, "0.00"),
    promotions_true_price: textValue(snapshot?.promotions_true_price ?? snapshot?.promotionsTruePrice, "0.00"),
    productInfo: {
      id: Number(productInfo?.id ?? row.productId),
      store_name: storeName,
      image,
      price: textValue(productInfo?.price ?? attrInfo?.price ?? truePrice, truePrice),
      attrInfo: { suk, image, price: textValue(attrInfo?.price ?? truePrice, truePrice) },
    },
  };
}

function payTypeName(value: string): string {
  return ({
    yue: "余额支付",
    weixin: "微信支付",
    alipay: "支付宝支付",
    offline: "线下支付",
    integral: "积分支付",
    zero: "零元支付",
    friend: "好友代付",
  } as Record<string, string>)[value] ?? "其他方式";
}

function deliveryTypeName(value: string): string {
  return ({ express: "快递", send: "配送", split: "拆分发货", fictitious: "虚拟发货" } as Record<string, string>)[value] ?? "其他方式";
}

function orderTypeName(row: OrderRow): string {
  if (row.type === 0) {
    if (row.shippingType === 2) return "核销";
    if (row.shippingType === 3) return "配送";
    if (row.shippingType === 4) return "收银";
    return "普通";
  }
  return ({ 1: "秒杀", 2: "砍价", 3: "拼团", 4: "积分", 5: "套餐", 6: "预售", 7: "新人", 8: "抽奖" } as Record<number, string>)[row.type] ?? "";
}

export function orderStatus(row: OrderRow) {
  let type = 0;
  let title = "待付款";
  let message = "等待客户完成支付";
  let cssClass = "nobuy";
  if (row.paid !== 1) {
    if (row.payType === "offline" && row.status < 2) {
      type = 9;
      title = "线下付款,未支付";
      message = "等待商家处理,请耐心等待";
    }
  } else if (row.refundStatus === 2) {
    type = -2;
    title = "已退款";
    message = "已为客户退款";
    cssClass = "state-sqtk";
  } else if (row.status === 4) {
    type = 2;
    title = "待收货";
    message = "已拆分多个包裹发货";
    cssClass = "state-ysh";
  } else if (row.status === 5) {
    type = row.shippingType === 2 ? 5 : 2;
    title = row.shippingType === 2 ? "部分核销" : "待收货";
    message = row.shippingType === 2 ? "部分核销,请继续进行核销" : "部分核销收货,请继续进行核销";
    cssClass = row.shippingType === 2 ? "state-nfh" : "state-ysh";
  } else if (row.refundStatus === 1 || row.refundStatus === 4) {
    type = -1;
    title = "申请退款中";
    message = row.refundType === 4 ? "商家同意退款,等待客户退货" : row.refundType === 5 ? "等待商家收货" : "商家审核中,请耐心等待";
    cssClass = "state-sqtk";
  } else if (row.refundStatus === 3) {
    type = -1;
    title = "部分退款（子订单）";
    message = "拆分发货，部分退款";
    cssClass = "state-sqtk";
  } else if (row.status === 0) {
    type = row.shippingType === 2 ? 5 : 1;
    title = row.shippingType === 2 ? "待核销" : row.type === 3 && row.pinkId > 0 ? "拼团中" : "未发货";
    message = row.shippingType === 2 ? "待核销,请到核销点进行核销" : "商家未发货,请耐心等待";
    cssClass = "state-nfh";
  } else if (row.status === 1) {
    type = 2;
    title = "待收货";
    message = "订单已发货";
    cssClass = "state-ysh";
  } else if (row.status === 2) {
    type = 3;
    title = "待评价";
    message = "客户已收货";
    cssClass = "state-ypj";
  } else if (row.status === 3) {
    type = 4;
    title = "交易完成";
    message = "交易完成";
    cssClass = "state-ytk";
  }
  return {
    _type: type,
    _title: title,
    _msg: message,
    _class: cssClass,
    _payType: type === 0 ? "" : payTypeName(row.payType),
    _deliveryType: deliveryTypeName(row.deliveryType),
  };
}

function refundStatus(row: RefundRow) {
  if (row.isCancel || row.isDel) return { _type: -1, _title: "已撤销", status_name: "用户已撤销", desc: "客户已撤销售后申请" };
  if ([0, 1, 2].includes(row.refundType)) return { _type: 0, _title: "申请中", status_name: "商家审核中", desc: "等待处理售后申请" };
  if (row.refundType === 3) return { _type: 3, _title: "拒绝退款", status_name: "商家已拒绝", desc: row.refuseReason ? `拒绝原因：${row.refuseReason}` : "商家已拒绝申请" };
  if (row.refundType === 4) return { _type: 4, _title: "待退货", status_name: "商家已同意", desc: "等待客户寄回商品" };
  if (row.refundType === 5) return { _type: 5, _title: "退款中", status_name: "商家收货中", desc: "等待商家确认收货并退款" };
  return { _type: 6, _title: "已退款", status_name: "退款完成", desc: "退款已完成" };
}

function refundSelectedCartIds(value: string | null): Set<string> {
  const parsed = parseSnapshot(value);
  const selected = new Set<string>();
  const collect = (item: unknown) => {
    if (typeof item === "number" || typeof item === "string") selected.add(String(item));
    const entry = record(item);
    const id = entry?.cart_id ?? entry?.cartId ?? entry?.id;
    if (id !== undefined && id !== null && id !== "") selected.add(String(id));
  };
  if (Array.isArray(parsed)) parsed.forEach(collect);
  else {
    const data = record(parsed);
    const cartIds = data?.cartIds ?? data?.cart_ids;
    if (Array.isArray(cartIds)) cartIds.forEach(collect);
  }
  return selected;
}

export function refundProjection(row: RefundRow, carts: CartRow[], listMode = false) {
  const selected = refundSelectedCartIds(row.cartInfo);
  const eligible = selected.size
    ? carts.filter((cart) => selected.has(String(cart.id)) || selected.has(cart.cartId))
    : carts;
  const cartInfo = eligible.map(cartProjection);
  const status = refundStatus(row);
  return {
    id: row.id,
    store_order_id: row.storeOrderId,
    store_id: row.storeId,
    order_id: row.orderId,
    uid: row.uid,
    supplier_id: row.supplierId,
    apply_type: row.applyType,
    apply_price: row.applyPrice,
    refund_type: row.refundType,
    refund_num: row.refundNum,
    refund_price: row.refundPrice,
    refunded_price: row.refundedPrice,
    refund_reason: row.refundReason,
    refund_goods_type: row.refundGoodsType,
    refund_phone: row.refundPhone,
    refund_express: row.refundExpress,
    refund_express_name: row.refundExpressName,
    refund_explain: row.refundExplain,
    refuse_reason: row.refuseReason,
    remark: row.remark,
    refunded_time: row.refundedTime,
    is_cancel: row.isCancel,
    is_del: row.isDel,
    add_time: listMode ? formatEpoch(row.addTime, false) : row.addTime,
    _add_time: formatEpoch(row.addTime),
    total_num: row.refundNum,
    pay_price: row.refundPrice,
    pay_postage: "0.00",
    paid: 1,
    refund_status: ACTIVE_REFUND_TYPES.includes(row.refundType as typeof ACTIVE_REFUND_TYPES[number]) ? 1 : row.refundType === 3 ? 3 : 2,
    status_name: { pic: "", status_name: status.status_name },
    _status: { ...status, pic: "" },
    cartInfo,
    _info: cartInfo.map((cart) => ({ cart_info: cart })),
  };
}

export function orderProjection(row: OrderRow, carts: CartRow[], refunds: RefundRow[]) {
  const cartInfo = carts.map(cartProjection);
  const refund = refunds.map((item) => ({
    id: item.id,
    order_id: item.orderId,
    refund_type: item.refundType,
    refund_num: item.refundNum,
    refund_price: item.refundPrice,
  }));
  const cartNum = cartInfo.reduce((total, item) => total + (item.is_gift ? 0 : item.cart_num), 0);
  const refundedNum = refunds.reduce((total, item) => total + item.refundNum, 0);
  return {
    id: row.id,
    pid: row.pid,
    order_id: row.orderId,
    trade_no: row.tradeNo,
    uid: row.uid,
    real_name: row.realName,
    user_phone: row.userPhone,
    province: row.province,
    user_address: row.userAddress,
    freight_price: row.freightPrice,
    total_num: row.totalNum,
    total_price: row.totalPrice,
    total_postage: row.totalPostage,
    pay_price: row.payPrice,
    pay_postage: row.payPostage,
    pay_integral: row.payIntegral,
    deduction_price: row.deductionPrice,
    coupon_id: row.couponId,
    coupon_price: row.couponPrice,
    promotions_price: row.promotionsPrice,
    first_order_price: row.firstOrderPrice,
    paid: row.paid,
    status: row.status,
    shipping_type: row.shippingType,
    pay_type: row.payType,
    pay_time: row.payTime,
    add_time: row.addTime,
    refund_status: row.refundStatus,
    refund_type: row.refundType,
    refund_price: row.refundPrice,
    delivery_type: row.deliveryType,
    delivery_name: row.deliveryName,
    delivery_code: row.deliveryCode,
    delivery_id: row.deliveryId,
    type: row.type,
    type_name: orderTypeName(row),
    pink_id: row.pinkId,
    product_type: row.productType,
    mark: row.mark,
    remark: row.remark,
    _add_time: formatEpoch(row.addTime),
    _pay_time: formatEpoch(row.payTime),
    _status: orderStatus(row),
    cartInfo,
    refund,
    is_all_refund: refund.length > 0 && refundedNum === cartNum,
  };
}

function statusConditions(status: number | null): SQL[] {
  if (status === null) return [];
  switch (status) {
    case 0: return [eq(storeOrder.paid, 0), eq(storeOrder.status, 0), eq(storeOrder.refundStatus, 0)];
    case 1: return [eq(storeOrder.paid, 1), inArray(storeOrder.status, [0, 4]), inArray(storeOrder.refundStatus, [0, 3]), inArray(storeOrder.shippingType, [1, 3])];
    case 7: return [eq(storeOrder.paid, 1), eq(storeOrder.status, 4), inArray(storeOrder.refundStatus, [0, 3])];
    case 2: return [eq(storeOrder.paid, 1), or(
      and(inArray(storeOrder.status, [1, 5]), eq(storeOrder.shippingType, 1)),
      and(inArray(storeOrder.status, [0, 5]), eq(storeOrder.shippingType, 2)),
    )!, inArray(storeOrder.refundStatus, [0, 3])];
    case 3: return [eq(storeOrder.paid, 1), eq(storeOrder.status, 2), inArray(storeOrder.refundStatus, [0, 3])];
    case 4: return [eq(storeOrder.paid, 1), eq(storeOrder.status, 3), inArray(storeOrder.refundStatus, [0, 3])];
    case 5: return [eq(storeOrder.paid, 1), inArray(storeOrder.status, [0, 1, 5]), inArray(storeOrder.refundStatus, [0, 3]), eq(storeOrder.shippingType, 2)];
    case 6: return [eq(storeOrder.paid, 1), eq(storeOrder.status, 2), inArray(storeOrder.refundStatus, [0, 3]), eq(storeOrder.shippingType, 2)];
    case 8: return [eq(storeOrder.paid, 1), inArray(storeOrder.status, [0, 1, 2, 5]), inArray(storeOrder.refundStatus, [0, 3]), eq(storeOrder.shippingType, 2)];
    case 9: return [eq(storeOrder.paid, 1), inArray(storeOrder.status, [2, 3]), inArray(storeOrder.refundStatus, [0, 3])];
    case -1: return [eq(storeOrder.paid, 1), inArray(storeOrder.refundStatus, [1, 4])];
    case -2: return [eq(storeOrder.paid, 1), eq(storeOrder.refundStatus, 2)];
    case -3: return [eq(storeOrder.paid, 1), inArray(storeOrder.refundStatus, [1, 2, 4])];
    case -4: return [eq(storeOrder.isDel, 1)];
    default: return [];
  }
}

export class KefuOrderService {
  constructor(private readonly container: Container) {}

  private ownedCustomerConversation(kefuUid: number, customerUid: number) {
    return exists(this.container.db
      .select({ id: storeServiceRecord.id })
      .from(storeServiceRecord)
      .where(and(
        eq(storeServiceRecord.userId, kefuUid),
        eq(storeServiceRecord.toUid, customerUid),
        eq(storeServiceRecord.isTourist, 0),
      )));
  }

  private ownedOrderConversation(kefuUid: number) {
    return exists(this.container.db
      .select({ id: storeServiceRecord.id })
      .from(storeServiceRecord)
      .where(and(
        eq(storeServiceRecord.userId, kefuUid),
        eq(storeServiceRecord.toUid, storeOrder.uid),
        eq(storeServiceRecord.isTourist, 0),
      )));
  }

  private ownedRefundConversation(kefuUid: number) {
    return exists(this.container.db
      .select({ id: storeServiceRecord.id })
      .from(storeServiceRecord)
      .where(and(
        eq(storeServiceRecord.userId, kefuUid),
        eq(storeServiceRecord.toUid, storeOrderRefund.uid),
        eq(storeServiceRecord.isTourist, 0),
      )));
  }

  private assignedCustomerIds(kefuUid: number) {
    return this.container.db
      .select({ uid: storeServiceRecord.toUid })
      .from(storeServiceRecord)
      .where(and(eq(storeServiceRecord.userId, kefuUid), eq(storeServiceRecord.isTourist, 0)));
  }

  private async cartsByOrder(orderIds: number[]): Promise<Map<number, CartRow[]>> {
    const result = new Map<number, CartRow[]>();
    if (!orderIds.length) return result;
    const rows = await this.container.db.select().from(storeOrderCartInfo)
      .where(inArray(storeOrderCartInfo.oid, orderIds))
      .orderBy(storeOrderCartInfo.oid, storeOrderCartInfo.id);
    for (const row of rows) result.set(row.oid, [...(result.get(row.oid) ?? []), row]);
    return result;
  }

  private async refundsByOrder(orderIds: number[]): Promise<Map<number, RefundRow[]>> {
    const result = new Map<number, RefundRow[]>();
    if (!orderIds.length) return result;
    const rows = await this.container.db.select().from(storeOrderRefund)
      .where(and(
        inArray(storeOrderRefund.storeOrderId, orderIds),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      ))
      .orderBy(storeOrderRefund.storeOrderId, storeOrderRefund.id);
    for (const row of rows) result.set(row.storeOrderId, [...(result.get(row.storeOrderId) ?? []), row]);
    return result;
  }

  private orderSearch(keyword: string): SQL | undefined {
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
    const matchingOrderCarts = this.container.db.select({ oid: storeOrderCartInfo.oid }).from(storeOrderCartInfo)
      .where(inArray(storeOrderCartInfo.productId, matchingProducts));
    return or(
      ilike(storeOrder.orderId, pattern),
      ilike(storeOrder.realName, pattern),
      ilike(storeOrder.userPhone, pattern),
      inArray(storeOrder.uid, matchingUsers),
      inArray(storeOrder.id, matchingOrderCarts),
    );
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
    const matchingOrderCarts = this.container.db.select({ oid: storeOrderCartInfo.oid }).from(storeOrderCartInfo)
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

  async customerOrders(kefuUid: number, uidValue: unknown, query: Record<string, string>) {
    const uid = positiveInteger(uidValue, "用户ID");
    await assertKefuConversation(this.container, kefuUid, uid, 0);
    const status = parseKefuOrderStatus(query.type);
    if (status === -1) return this.customerRefunds(kefuUid, uid, query);
    const page = parseKefuOrderPage(query.page);
    const limit = parseKefuPageLimit(query.limit);
    const keyword = queryText(query.search, "搜索词");
    const filters: SQL[] = [
      eq(storeOrder.uid, uid),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.pid, 0),
      inArray(storeOrder.refundType, [...CUSTOMER_ORDER_REFUND_TYPES]),
      this.ownedCustomerConversation(kefuUid, uid),
      ...statusConditions(status),
    ];
    const search = this.orderSearch(keyword);
    if (search) filters.push(search);
    const rows = await this.container.db.select().from(storeOrder)
      .where(and(...filters))
      .orderBy(desc(storeOrder.id))
      .limit(limit)
      .offset((page - 1) * limit);
    const orderIds = rows.map((row) => row.id);
    const [carts, refunds] = await Promise.all([
      this.cartsByOrder(orderIds),
      this.refundsByOrder(orderIds),
    ]);
    return rows.map((row) => orderProjection(row, carts.get(row.id) ?? [], refunds.get(row.id) ?? []));
  }

  private async customerRefunds(
    kefuUid: number,
    uid: number,
    query: Record<string, string>,
  ) {
    const page = parseKefuOrderPage(query.page);
    const limit = parseKefuPageLimit(query.limit);
    const keyword = queryText(query.search, "搜索词");
    const filters: SQL[] = [
      eq(storeOrderRefund.uid, uid),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
      inArray(storeOrderRefund.refundType, [...ACTIVE_REFUND_TYPES]),
      this.ownedCustomerConversation(kefuUid, uid),
    ];
    const search = this.refundSearch(keyword);
    if (search) filters.push(search);
    const rows = await this.container.db.select().from(storeOrderRefund)
      .where(and(...filters))
      .orderBy(desc(storeOrderRefund.addTime), desc(storeOrderRefund.id))
      .limit(limit)
      .offset((page - 1) * limit);
    const carts = await this.cartsByOrder(rows.map((row) => row.storeOrderId));
    return rows.map((row) => refundProjection(row, carts.get(row.storeOrderId) ?? [], true));
  }

  async orderInfo(kefuUid: number, idValue: unknown) {
    const id = positiveInteger(idValue, "订单ID");
    const row = (await this.container.db.select().from(storeOrder).where(and(
      eq(storeOrder.id, id),
      eq(storeOrder.isSystemDel, 0),
      this.ownedOrderConversation(kefuUid),
    )).limit(1))[0];
    if (!row) throw new NotFoundException("订单不存在或不属于当前会话");
    const [carts, refunds, users, invoices, promotions] = await Promise.all([
      this.container.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, row.id)).orderBy(storeOrderCartInfo.id),
      this.container.db.select().from(storeOrderRefund).where(and(
        eq(storeOrderRefund.storeOrderId, row.id),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).orderBy(storeOrderRefund.id),
      this.container.db.select({
        uid: user.uid,
        account: user.account,
        real_name: user.realName,
        nickname: user.nickname,
        avatar: user.avatar,
        phone: user.phone,
        group_id: user.groupId,
        now_money: user.nowMoney,
        integral: user.integral,
        spread_uid: user.spreadUid,
        status: user.status,
      }).from(user).where(eq(user.uid, row.uid)).limit(1),
      this.container.db.select({
        invoice_id: storeOrderInvoice.invoiceId,
        header_type: storeOrderInvoice.headerType,
        type: storeOrderInvoice.type,
        name: storeOrderInvoice.name,
        duty_number: storeOrderInvoice.dutyNumber,
        drawer_phone: storeOrderInvoice.drawerPhone,
        email: storeOrderInvoice.email,
        is_pay: storeOrderInvoice.isPay,
        is_refund: storeOrderInvoice.isRefund,
        is_invoice: storeOrderInvoice.isInvoice,
        invoice_number: storeOrderInvoice.invoiceNumber,
        invoice_amount: storeOrderInvoice.invoiceAmount,
        remark: storeOrderInvoice.remark,
        invoice_time: storeOrderInvoice.invoiceTime,
      }).from(storeOrderInvoice).where(and(
        eq(storeOrderInvoice.orderId, row.id),
        eq(storeOrderInvoice.isDel, 0),
      )).orderBy(desc(storeOrderInvoice.id)).limit(1),
      this.container.db.select({
        promotions_id: storeOrderPromotions.promotionsId,
        product_id: storeOrderPromotions.productId,
        promotions_price: storeOrderPromotions.promotionsPrice,
      }).from(storeOrderPromotions).where(eq(storeOrderPromotions.oid, row.id)).orderBy(storeOrderPromotions.id),
    ]);
    if (!users[0]) throw new NotFoundException("用户信息不存在");
    return {
      orderInfo: {
        ...orderProjection(row, carts, refunds),
        invoice: invoices[0] ?? null,
        promotions_detail: promotions,
        vip_true_price: money(carts.reduce((total, item) => {
          const projected = cartProjection(item);
          return total + Number(projected.vip_sum_truePrice);
        }, 0)),
      },
      userInfo: users[0],
    };
  }

  async refundDetail(kefuUid: number, idValue: unknown) {
    const id = positiveInteger(idValue, "退款ID");
    const refund = (await this.container.db.select().from(storeOrderRefund).where(and(
      eq(storeOrderRefund.id, id),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
      this.ownedRefundConversation(kefuUid),
    )).limit(1))[0];
    if (!refund) throw new NotFoundException("退款订单不存在或不属于当前会话");
    const order = (await this.container.db.select().from(storeOrder).where(and(
      eq(storeOrder.id, refund.storeOrderId),
      eq(storeOrder.uid, refund.uid),
      eq(storeOrder.isSystemDel, 0),
    )).limit(1))[0];
    if (!order) throw new NotFoundException("原订单不存在");
    const [carts, users] = await Promise.all([
      this.container.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(storeOrderCartInfo.id),
      this.container.db.select({
        uid: user.uid,
        account: user.account,
        real_name: user.realName,
        nickname: user.nickname,
        avatar: user.avatar,
        phone: user.phone,
        group_id: user.groupId,
        now_money: user.nowMoney,
        integral: user.integral,
        spread_uid: user.spreadUid,
        status: user.status,
      }).from(user).where(eq(user.uid, refund.uid)).limit(1),
    ]);
    if (!users[0]) throw new NotFoundException("用户信息不存在");
    return {
      orderInfo: {
        ...refundProjection(refund, carts),
        store_order_sn: order.orderId,
        shipping_type: order.shippingType,
        real_name: order.realName,
        user_phone: order.userPhone,
        user_address: order.userAddress,
        type: order.type,
        product_type: order.productType,
        orderStatus: orderStatus(order),
      },
      userInfo: users[0],
    };
  }

  async refundList(kefuUid: number, query: Record<string, string>) {
    const page = parseKefuOrderPage(query.page);
    const limit = parseKefuPageLimit(query.limit);
    const keyword = queryText(query.order_id, "搜索词");
    const refundType = optionalRefundType(query.refund_type);
    const range = dateRange(query.time);
    const assigned = this.assignedCustomerIds(kefuUid);
    const base: SQL[] = [
      inArray(storeOrderRefund.uid, assigned),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
    ];
    const filters = [...base];
    if (refundType !== null) filters.push(eq(storeOrderRefund.refundType, refundType));
    if (range.start !== undefined) filters.push(gte(storeOrderRefund.addTime, range.start));
    if (range.end !== undefined) filters.push(lte(storeOrderRefund.addTime, range.end));
    const search = this.refundSearch(keyword);
    if (search) filters.push(search);
    const where = and(...filters);
    const [rows, total, grouped] = await Promise.all([
      this.container.db.select().from(storeOrderRefund).where(where)
        .orderBy(desc(storeOrderRefund.addTime), desc(storeOrderRefund.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(storeOrderRefund).where(where),
      this.container.db.select({ refund_type: storeOrderRefund.refundType, count: count() })
        .from(storeOrderRefund).where(and(...base)).groupBy(storeOrderRefund.refundType),
    ]);
    const carts = await this.cartsByOrder(rows.map((row) => row.storeOrderId));
    const counts = new Map(grouped.map((row) => [row.refund_type, Number(row.count)]));
    const names = ["", "仅退款", "退货退款", "拒绝退款", "商品待退货", "退货待收货", "已退款"];
    return {
      list: rows.map((row) => refundProjection(row, carts.get(row.storeOrderId) ?? [], true)),
      count: Number(total[0]?.count ?? 0),
      num: Object.fromEntries([1, 2, 3, 4, 5, 6].map((type) => [type, {
        name: names[type],
        num: counts.get(type) ?? 0,
      }])),
    };
  }
}
