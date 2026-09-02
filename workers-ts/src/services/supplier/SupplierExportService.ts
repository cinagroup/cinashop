import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  expressCompany,
  queueAuxiliary,
  queueList,
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storePink,
  supplierFlowingWater,
  user,
} from "@/models/schema";
import { SUPPLIER_QUEUE_CACHE_TYPE_BY_QUEUE_TYPE } from "@/services/supplier/SupplierQueueHistoryService";
import { ValidateException } from "@/utils/errors";

const MAX_ORDER_EXPORT_ROWS = 250;
const MAX_BATCH_EXPORT_ROWS = 1_000;
const MAX_FINANCE_EXPORT_ROWS = 1_000;
const MAX_ID_FILTER = 1_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CELL_LENGTH = 16_000;
const QUEUE_TYPES = [7, 8, 9, 10] as const;

type ExportCell = string | number;
type ExportRow = Record<string, ExportCell | undefined>;

export interface LegacyExportManifest {
  header: string[];
  filekey: string[];
  export: ExportRow[];
  filename: string;
  page?: number;
  limit?: number;
  has_more?: boolean;
  bounded: true;
}

function positiveInteger(value: unknown, label: string, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

export function parseSupplierExportIds(value: unknown, required = false): number[] {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ValidateException("导出记录ID不能为空");
    return [];
  }
  if (typeof value !== "string" || value.length > 12_000) {
    throw new ValidateException("导出记录ID无效");
  }
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > MAX_ID_FILTER || parts.some((part) => !/^[1-9]\d*$/.test(part))) {
    throw new ValidateException(`导出记录ID必须为不超过 ${MAX_ID_FILTER} 个正整数`);
  }
  const ids = [...new Set(parts.map(Number))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id > 2_147_483_647)) {
    throw new ValidateException("导出记录ID无效");
  }
  return ids;
}

/** Neutralize formulas before the browser hands a value to Excel/WPS. */
export function safeSpreadsheetCell(value: unknown, maximum = MAX_CELL_LENGTH): string {
  const normalized = String(value ?? "")
    .replace(/\0/g, "")
    .slice(0, maximum);
  return /^[\t\r\n ]*[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

function formatShanghaiEpoch(value: number, withSeconds = true): string {
  if (!value) return "暂无";
  const date = new Date((value + 8 * 60 * 60) * 1_000);
  const pad = (part: number) => String(part).padStart(2, "0");
  const base = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getUTCSeconds())}` : base;
}

function filename(prefix: string): string {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1_000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${prefix}_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function checkedManifest(manifest: LegacyExportManifest): LegacyExportManifest {
  if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > MAX_RESPONSE_BYTES) {
    throw new ValidateException("导出内容过大，请缩小筛选范围后重试");
  }
  return manifest;
}

function dateRange(value: unknown): { start?: number; end?: number } {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string" || value.length > 100) throw new ValidateException("导出时间范围无效");
  const parts = value.trim().split(/\s+(?:-|~|至)\s+|,/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) throw new ValidateException("导出时间范围无效");
  const parse = (part: string, end: boolean) => {
    const day = part.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
    const milliseconds = Date.parse(day ? `${day}T${end ? "23:59:59" : "00:00:00"}+08:00` : part);
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : undefined;
  };
  const start = parse(parts[0], false);
  const end = parse(parts[1] ?? parts[0], true);
  if (start === undefined || end === undefined || start > end) throw new ValidateException("导出时间范围无效");
  return { start, end };
}

function payTypeName(paid: number, value: string): string {
  if (paid !== 1) return value === "offline" ? "线下支付" : "待付款";
  return ({
    weixin: "微信支付",
    yue: "余额支付",
    offline: "线下支付",
    alipay: "支付宝支付",
    cash: "现金支付",
    zero: "零元支付",
  } as Record<string, string>)[value] ?? "其他支付";
}

export function supplierExportOrderStatus(row: {
  paid: number;
  status: number;
  shippingType: number;
  refundStatus: number;
}): string {
  if (row.paid === 0 && row.status === 0) return "待付款";
  if (row.paid === 1 && row.status === 4 && [1, 3].includes(row.shippingType) && row.refundStatus === 0) return "部分发货";
  if (row.paid === 1 && row.status === 5 && row.shippingType === 2 && row.refundStatus === 0) return "部分核销";
  if (row.paid === 1 && row.refundStatus === 1) return "申请退款";
  if (row.paid === 1 && row.refundStatus === 2) return "已退款";
  if (row.paid === 1 && row.refundStatus === 4) return "退款中";
  if (row.paid === 1 && row.status === 0 && [1, 3].includes(row.shippingType) && row.refundStatus === 0) return "未发货";
  if (row.paid === 1 && [0, 1].includes(row.status) && row.shippingType === 2 && row.refundStatus === 0) return "未核销";
  if (row.paid === 1 && [1, 5].includes(row.status) && [1, 3].includes(row.shippingType) && row.refundStatus === 0) return "待收货";
  if (row.paid === 1 && row.status === 2 && row.refundStatus === 0) return "待评价";
  if (row.paid === 1 && row.status === 3 && row.refundStatus === 0) return "已完成";
  if (row.paid === 1 && row.refundStatus === 3) return "部分退款";
  return "未知状态";
}

function jsonObject(value: string | null): Record<string, unknown> {
  if (!value || value.length > 256_000) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cartSnapshot(value: string | null) {
  const cart = jsonObject(value);
  const product = objectValue(cart.productInfo ?? cart.product_info);
  const attr = objectValue(product.attrInfo ?? product.attr_info);
  return {
    name: safeSpreadsheetCell(product.store_name ?? product.storeName ?? "", 2_000),
    sku: safeSpreadsheetCell(attr.suk ?? "", 1_000),
    barcode: safeSpreadsheetCell(attr.bar_code ?? attr.barCode ?? "", 500),
    code: safeSpreadsheetCell(attr.code ?? "", 500),
    price: safeSpreadsheetCell(cart.truePrice ?? cart.true_price ?? attr.price ?? product.price ?? "0.00", 100),
    vipPrice: Number(cart.vip_truePrice ?? cart.vipTruePrice ?? cart.truePrice ?? 0),
  };
}

function assertSupplierId(supplierId: number): void {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) throw new ValidateException("供应商身份无效");
}

function addLegacyOrderStatus(conditions: SQL[], value: string | undefined): void {
  const common = [eq(storeOrder.paid, 1), inArray(storeOrder.refundStatus, [0, 3]), eq(storeOrder.isDel, 0)];
  switch (value) {
    case "0":
      conditions.push(eq(storeOrder.paid, 0), eq(storeOrder.status, 0), eq(storeOrder.refundStatus, 0), eq(storeOrder.isDel, 0));
      break;
    case "1":
      conditions.push(...common, inArray(storeOrder.status, [0, 4]), inArray(storeOrder.shippingType, [1, 3]));
      break;
    case "2":
      conditions.push(...common, or(
        and(inArray(storeOrder.status, [1, 5]), eq(storeOrder.shippingType, 1)),
        and(inArray(storeOrder.status, [0, 5]), eq(storeOrder.shippingType, 2)),
      )!);
      break;
    case "3":
      conditions.push(...common, eq(storeOrder.status, 2));
      break;
    case "4":
      conditions.push(...common, eq(storeOrder.status, 3));
      break;
    case "5":
      conditions.push(...common, inArray(storeOrder.status, [0, 1, 5]), eq(storeOrder.shippingType, 2));
      break;
    case "6":
      conditions.push(...common, eq(storeOrder.status, 2), eq(storeOrder.shippingType, 2));
      break;
    case "7":
      conditions.push(...common, eq(storeOrder.status, 4));
      break;
    case "8":
      conditions.push(...common, inArray(storeOrder.status, [0, 1, 2, 5]), eq(storeOrder.shippingType, 2));
      break;
    case "9":
      conditions.push(...common, inArray(storeOrder.status, [2, 3]));
      break;
    case "-1":
      conditions.push(eq(storeOrder.paid, 1), inArray(storeOrder.refundStatus, [1, 4]), eq(storeOrder.isDel, 0));
      break;
    case "-2":
      conditions.push(eq(storeOrder.paid, 1), eq(storeOrder.refundStatus, 2), eq(storeOrder.isDel, 0));
      break;
    case "-3":
      conditions.push(eq(storeOrder.paid, 1), inArray(storeOrder.refundStatus, [1, 2, 4]), eq(storeOrder.isDel, 0));
      break;
    case "-4":
      conditions.push(eq(storeOrder.isDel, 1));
      break;
  }
}

export class SupplierExportService {
  constructor(private readonly container: Container) {}

  async storeOrder(supplierId: number, query: Record<string, string | undefined>): Promise<LegacyExportManifest> {
    assertSupplierId(supplierId);
    const page = positiveInteger(query.page, "页码", 1, 1_000_000);
    const ids = parseSupplierExportIds(query.ids);
    const shipping = query.type !== undefined && query.type !== "" && query.type !== "0";
    const conditions: SQL[] = [
      eq(storeOrder.supplierId, supplierId),
      eq(storeOrder.pid, 0),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.isSystemDel, 0),
    ];
    if (ids.length) conditions.push(inArray(storeOrder.id, ids));
    const keyword = query.real_name?.trim();
    if (keyword) {
      if (keyword.length > 100) throw new ValidateException("订单搜索内容过长");
      const pattern = `%${keyword}%`;
      const matches = or(ilike(storeOrder.orderId, pattern), ilike(storeOrder.realName, pattern), ilike(storeOrder.userPhone, pattern));
      if (matches) conditions.push(matches);
    }
    const range = dateRange(query.data ?? query.time);
    if (range.start !== undefined) conditions.push(gte(storeOrder.addTime, range.start));
    if (range.end !== undefined) conditions.push(lte(storeOrder.addTime, range.end));
    if (shipping) {
      conditions.push(
        eq(storeOrder.status, 1),
        eq(storeOrder.paid, 1),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.shippingType, 1),
        or(
          sql`${storeOrder.type} <> 3`,
          eq(storeOrder.pinkId, 0),
          sql`EXISTS (SELECT 1 FROM ${storePink} WHERE ${storePink.id} = ${storeOrder.pinkId} AND ${storePink.status} = 2)`,
        )!,
        notExists(this.container.db.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(and(
          eq(storeOrderRefund.storeOrderId, storeOrder.id),
          inArray(storeOrderRefund.refundType, [0, 1, 2, 4, 5]),
          eq(storeOrderRefund.isCancel, 0),
          eq(storeOrderRefund.isDel, 0),
        ))),
      );
    } else addLegacyOrderStatus(conditions, query.status);

    const rows = await this.container.db.select({
      id: storeOrder.id,
      orderId: storeOrder.orderId,
      uid: storeOrder.uid,
      sex: user.sex,
      realName: storeOrder.realName,
      userPhone: storeOrder.userPhone,
      userAddress: storeOrder.userAddress,
      totalNum: storeOrder.totalNum,
      totalPrice: storeOrder.totalPrice,
      payPrice: storeOrder.payPrice,
      payPostage: storeOrder.payPostage,
      couponPrice: storeOrder.couponPrice,
      deductionPrice: storeOrder.deductionPrice,
      paid: storeOrder.paid,
      payType: storeOrder.payType,
      payTime: storeOrder.payTime,
      status: storeOrder.status,
      shippingType: storeOrder.shippingType,
      refundStatus: storeOrder.refundStatus,
      addTime: storeOrder.addTime,
      mark: storeOrder.mark,
      remark: storeOrder.remark,
    }).from(storeOrder)
      .leftJoin(user, eq(user.uid, storeOrder.uid))
      .where(and(...conditions))
      .orderBy(desc(storeOrder.id))
      .limit(MAX_ORDER_EXPORT_ROWS + 1)
      .offset((page - 1) * MAX_ORDER_EXPORT_ROWS);
    const hasMore = rows.length > MAX_ORDER_EXPORT_ROWS;
    const orders = rows.slice(0, MAX_ORDER_EXPORT_ROWS);
    const orderIds = orders.map((row) => row.id);
    const cartRows = orderIds.length
      ? await this.container.db.select({
          oid: storeOrderCartInfo.oid,
          productId: storeOrderCartInfo.productId,
          cartNum: storeOrderCartInfo.cartNum,
          cartInfo: storeOrderCartInfo.cartInfo,
        }).from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, orderIds)).orderBy(asc(storeOrderCartInfo.id))
      : [];
    const carts = new Map<number, typeof cartRows>();
    for (const item of cartRows) carts.set(item.oid, [...(carts.get(item.oid) ?? []), item]);

    const exported: ExportRow[] = orders.map((order) => {
      const items = (carts.get(order.id) ?? []).map((item) => ({ ...item, snapshot: cartSnapshot(item.cartInfo) }));
      if (shipping) {
        return {
          id: order.id,
          order_id: safeSpreadsheetCell(order.orderId),
          a: "",
          b: "",
          c: "",
          user_address: safeSpreadsheetCell(order.userAddress, 2_000),
          real_name: safeSpreadsheetCell(order.realName, 500),
          user_phone: safeSpreadsheetCell(order.userPhone, 100),
          pay_price: order.payPrice,
          cart_num: items.map((item) => `${item.cartNum} * ${item.snapshot.price}`).join("\n"),
          product_id: items.map((item) => item.productId).join("\n"),
          goods_name: safeSpreadsheetCell(items.map((item) => `${item.snapshot.name}${item.snapshot.sku ? ` (${item.snapshot.sku}|条码:${item.snapshot.barcode}|编码:${item.snapshot.code})` : ""} [${item.cartNum} * ${item.snapshot.price}]`).join("\n")),
          attr: safeSpreadsheetCell(items.map((item) => item.snapshot.sku).join("\n")),
          remark: safeSpreadsheetCell(order.remark, 2_000),
          pay_time: formatShanghaiEpoch(order.payTime),
        };
      }
      const vipTotal = items.reduce((sum, item) => sum + (Number.isFinite(item.snapshot.vipPrice) ? item.snapshot.vipPrice : 0) * Math.max(item.cartNum, 1), 0);
      return {
        id: order.id,
        order_id: safeSpreadsheetCell(order.orderId),
        sex: order.sex === 1 ? "男" : order.sex === 2 ? "女" : "未知",
        phone: safeSpreadsheetCell(order.userPhone, 100),
        real_name: safeSpreadsheetCell(order.realName, 500),
        user_phone: safeSpreadsheetCell(order.userPhone, 100),
        user_address: safeSpreadsheetCell(order.userAddress, 2_000),
        goods_name: safeSpreadsheetCell(items.map((item) => `${item.snapshot.name}${item.snapshot.sku ? ` (${item.snapshot.sku})` : ""} [${item.cartNum} * ${item.snapshot.price}]`).join("\n")),
        total_num: order.totalNum,
        total_price: order.totalPrice,
        pay_price: order.payPrice,
        pay_postage: order.payPostage,
        vip_sum_price: vipTotal.toFixed(2),
        coupon_price: order.couponPrice,
        deduction_price: order.deductionPrice,
        pay_type_name: payTypeName(order.paid, order.payType),
        pay_time: formatShanghaiEpoch(order.payTime, false),
        status_name: supplierExportOrderStatus(order),
        add_time: formatShanghaiEpoch(order.addTime),
        mark: safeSpreadsheetCell(order.mark, 2_000),
      };
    });
    const header = shipping
      ? ["订单ID", "订单编号", "物流公司", "物流编码", "物流单号", "发货地址", "收货人姓名", "收货人电话", "订单实付金额", "商品数量*售价", "商品ID", "商品名称", "商品规格", "商家备注", "订单成交时间"]
      : ["订单ID", "订单编号", "性别", "电话", "收货人姓名", "收货人电话", "收货地址", "商品信息", "商品总数", "总价格", "实际支付", "邮费", "会员优惠金额", "优惠卷金额", "积分抵扣金额", "支付状态", "支付时间", "订单状态", "下单时间", "用户备注"];
    return checkedManifest({
      header,
      filekey: exported[0] ? Object.keys(exported[0]) : [],
      export: exported,
      filename: filename(shipping ? "发货单导出" : "订单导出"),
      page,
      limit: MAX_ORDER_EXPORT_ROWS,
      has_more: hasMore,
      bounded: true,
    });
  }

  async expressList(supplierId: number): Promise<LegacyExportManifest> {
    assertSupplierId(supplierId);
    const rows = await this.container.db.select({ name: expressCompany.name, code: expressCompany.code })
      .from(expressCompany)
      .where(and(eq(expressCompany.isShow, 1), eq(expressCompany.status, 1)))
      .orderBy(desc(expressCompany.sort), asc(expressCompany.id))
      .limit(MAX_BATCH_EXPORT_ROWS + 1);
    if (rows.length > MAX_BATCH_EXPORT_ROWS) throw new ValidateException("物流公司数量异常，请联系管理员");
    const exported = rows.map((row) => ({ name: safeSpreadsheetCell(row.name), code: safeSpreadsheetCell(row.code) }));
    return checkedManifest({
      header: ["物流公司名称", "物流公司编码"],
      filekey: exported[0] ? ["name", "code"] : [],
      export: exported,
      filename: filename("物流公司对照表"),
      bounded: true,
    });
  }

  async batchOrderDelivery(
    supplierId: number,
    bindingValue: unknown,
    queueTypeValue: unknown,
    cacheTypeValue: unknown,
  ): Promise<LegacyExportManifest> {
    assertSupplierId(supplierId);
    const bindingId = requiredPositiveInteger(bindingValue, "队列 ID");
    const queueType = requiredPositiveInteger(queueTypeValue, "队列类型");
    const cacheType = requiredPositiveInteger(cacheTypeValue, "明细类型");
    if (!QUEUE_TYPES.includes(queueType as 7 | 8 | 9 | 10) || SUPPLIER_QUEUE_CACHE_TYPE_BY_QUEUE_TYPE[queueType] !== cacheType) {
      throw new ValidateException("队列类型与明细类型不匹配");
    }
    const rows = await this.container.db.select({
      orderId: storeOrder.orderId,
      deliveryName: storeOrder.deliveryName,
      deliveryId: storeOrder.deliveryId,
      deliveryType: storeOrder.deliveryType,
      fictitiousContent: storeOrder.fictitiousContent,
      status: queueAuxiliary.status,
    }).from(queueAuxiliary)
      .innerJoin(storeOrder, eq(storeOrder.id, queueAuxiliary.relationId))
      .where(and(
        eq(queueAuxiliary.bindingId, bindingId),
        eq(queueAuxiliary.type, cacheType),
        eq(storeOrder.supplierId, supplierId),
        exists(this.container.db.select({ id: queueList.id }).from(queueList).where(and(
          eq(queueList.id, queueAuxiliary.bindingId),
          eq(queueList.type, queueType),
        ))),
      ))
      .orderBy(desc(queueAuxiliary.addTime), desc(queueAuxiliary.id))
      .limit(MAX_BATCH_EXPORT_ROWS + 1);
    if (rows.length > MAX_BATCH_EXPORT_ROWS) throw new ValidateException("发货记录超过 1000 条，请缩小范围");
    const exported: ExportRow[] = rows.map((row) => {
      const common = {
        order_id: safeSpreadsheetCell(row.orderId),
        status_cn: row.status === 1 ? "成功" : row.status === 2 ? "失败" : row.status === 3 ? "已删除" : "未执行",
        error: row.status === 1 ? "无" : "队列异常",
      };
      return queueType === 10
        ? { order_id: common.order_id, fictitious_content: safeSpreadsheetCell(row.fictitiousContent, 2_000), status_cn: common.status_cn, error: common.error }
        : {
            order_id: common.order_id,
            delivery_name: safeSpreadsheetCell(row.deliveryType === "fictitious" ? "虚拟发货" : row.deliveryName, 500),
            delivery_id: safeSpreadsheetCell(row.deliveryType === "fictitious" ? "无" : row.deliveryId, 500),
            status_cn: common.status_cn,
            error: common.error,
          };
    });
    return checkedManifest({
      header: queueType === 10
        ? ["订单ID", "虚拟发货内容", "处理状态", "异常原因"]
        : queueType === 9
          ? ["订单ID", "配送员姓名", "配送员电话", "处理状态", "异常原因"]
          : ["订单ID", "物流公司", "物流单号", "处理状态", "异常原因"],
      filekey: exported[0] ? Object.keys(exported[0]) : [],
      export: exported,
      filename: filename("批量任务发货记录"),
      limit: MAX_BATCH_EXPORT_ROWS,
      has_more: false,
      bounded: true,
    });
  }

  async financeRecord(supplierId: number, query: Record<string, string | undefined>): Promise<LegacyExportManifest> {
    assertSupplierId(supplierId);
    const ids = parseSupplierExportIds(query.ids, true);
    const rows = await this.container.db.select({
      orderId: supplierFlowingWater.orderId,
      linkId: supplierFlowingWater.linkId,
      tradeTime: supplierFlowingWater.tradeTime,
      number: supplierFlowingWater.number,
      pm: supplierFlowingWater.pm,
      nickname: user.nickname,
      type: supplierFlowingWater.type,
      payType: supplierFlowingWater.payType,
    }).from(supplierFlowingWater)
      .leftJoin(user, eq(user.uid, supplierFlowingWater.uid))
      .where(and(
        eq(supplierFlowingWater.supplierId, supplierId),
        eq(supplierFlowingWater.isDel, 0),
        inArray(supplierFlowingWater.id, ids),
      ))
      .orderBy(desc(supplierFlowingWater.id))
      .limit(MAX_FINANCE_EXPORT_ROWS + 1);
    if (rows.length > MAX_FINANCE_EXPORT_ROWS) throw new ValidateException("账单记录超过 1000 条，请缩小范围");
    const exported = rows.map((row) => ({
      order_id: safeSpreadsheetCell(row.orderId),
      link_id: safeSpreadsheetCell(row.linkId),
      trade_time: formatShanghaiEpoch(row.tradeTime),
      number: row.number,
      pm: row.pm === 1 ? "收入" : "支出",
      user_nickname: safeSpreadsheetCell(row.nickname ?? "", 500),
      type_name: row.type === 1 ? "支付订单" : row.type === 2 ? "退款订单" : "其他",
      pay_type_name: payTypeName(1, row.payType),
    }));
    return checkedManifest({
      header: ["交易单号", "关联订单", "交易时间", "交易金额", "支出收入", "交易人", "交易类型", "支付方式"],
      filekey: exported[0] ? Object.keys(exported[0]) : [],
      export: exported,
      filename: filename("账单导出"),
      limit: MAX_FINANCE_EXPORT_ROWS,
      has_more: false,
      bounded: true,
    });
  }
}
