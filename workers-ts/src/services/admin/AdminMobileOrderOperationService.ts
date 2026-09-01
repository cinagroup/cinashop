import { and, asc, desc, eq, sql } from "drizzle-orm";
import { withTx, type Container } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderStatus,
  storeOrderWriteoff,
} from "@/models/schema";
import { lockOrderSettlement } from "@/services/order/OrderBrokerageService";
import {
  parseAdminOrderNumber,
  parseAdminOrderPrimaryId,
} from "@/services/admin/AdminMobileOrderReadService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_MONEY_CENTS = 999_999_999_999;
const MAX_CHANGE_PRICE_CENTS = 99_999_999;
const MAX_REMARK_LENGTH = 512;
const MAX_CART_SNAPSHOT_BYTES = 256 * 1024;

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseSnapshot(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return nestedRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function parseMoneyCents(value: unknown): number {
  let normalized = "";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new ValidateException("实际支付金额格式错误");
    const cents = Math.round(value * 100);
    if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-7) {
      throw new ValidateException("实际支付金额最多保留两位小数");
    }
    normalized = value.toFixed(2);
  } else if (typeof value === "string") {
    normalized = value.trim();
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new ValidateException("实际支付金额格式错误");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_MONEY_CENTS) {
    throw new ValidateException("实际支付金额超出允许范围");
  }
  return cents;
}

function parseSignedMoneyCents(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new ValidateException("历史改价数据异常，请先人工核对");
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  const signed = match[1] ? -cents : cents;
  if (!Number.isSafeInteger(signed) || Math.abs(signed) > MAX_CHANGE_PRICE_CENTS) {
    throw new ValidateException("历史改价数据异常，请先人工核对");
  }
  return signed;
}

function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new ValidateException("金额分值错误");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function signedCentsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CHANGE_PRICE_CENTS) {
    throw new ValidateException("改价差额超出允许范围");
  }
  return cents < 0 ? `-${centsToDecimal(-cents)}` : centsToDecimal(cents);
}

export interface AdminOrderPriceInput {
  orderId: string;
  priceCents: number;
}

export function parseAdminOrderPriceInput(input: Record<string, unknown>): AdminOrderPriceInput {
  if (input.price === undefined) throw new ValidateException("请填写实际支付金额");
  return {
    orderId: parseAdminOrderNumber(input.order_id),
    priceCents: parseMoneyCents(input.price),
  };
}

export function computeAdminOrderPrice(
  currentPayPrice: string,
  currentChangePrice: string,
  nextPriceCents: number,
) {
  const currentPayCents = parseMoneyCents(currentPayPrice);
  const originalPriceCents = currentPayCents + parseSignedMoneyCents(currentChangePrice);
  if (!Number.isSafeInteger(originalPriceCents) || originalPriceCents < 0) {
    throw new ValidateException("历史改价数据异常，请先人工核对");
  }
  const payPrice = centsToDecimal(nextPriceCents);
  const changePrice = signedCentsToDecimal(originalPriceCents - nextPriceCents);
  return {
    payPrice,
    changePrice,
    changed: payPrice !== currentPayPrice || changePrice !== currentChangePrice,
  };
}

export interface AdminOrderRemarkInput {
  orderId: string;
  remark: string;
}

export function parseAdminOrderRemarkInput(input: Record<string, unknown>): AdminOrderRemarkInput {
  const remark = typeof input.remark === "string" ? input.remark.trim() : "";
  if (!remark) throw new ValidateException("请填写备注内容");
  if (remark.length > MAX_REMARK_LENGTH) {
    throw new ValidateException(`备注不能超过${MAX_REMARK_LENGTH}个字符`);
  }
  return { orderId: parseAdminOrderNumber(input.order_id), remark };
}

export interface AdminWriteoffRecordsInput {
  productType: 0 | 4;
  page: number;
  limit: number;
}

export function parseAdminWriteoffRecordsInput(
  input: Record<string, unknown>,
): AdminWriteoffRecordsInput {
  const parsePositive = (value: unknown, fallback: number, label: string, max: number) => {
    const normalized = value === undefined || value === null || value === ""
      ? String(fallback)
      : String(value).trim();
    if (!/^\d+$/.test(normalized)) throw new ValidateException(`${label}错误`);
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
      throw new ValidateException(`${label}错误`);
    }
    return parsed;
  };
  const rawType = input.product_type === undefined ? 0 : input.product_type;
  if (rawType !== 0 && rawType !== "0" && rawType !== 4 && rawType !== "4") {
    throw new ValidateException("商品类型错误");
  }
  return {
    productType: Number(rawType) as 0 | 4,
    page: parsePositive(input.page, 1, "页码", 10_000),
    limit: parsePositive(input.limit, 10, "每页数量", 100),
  };
}

interface AdminWriteoffProjectionRow {
  id: number;
  orderCartId: number;
  productId: number;
  productType: number;
  writeoffNum: number;
  writeoffPrice: string;
  formattedTime: string;
  cartInfo: string | null;
}

export function projectAdminWriteoffRecord(
  row: AdminWriteoffProjectionRow,
  includeCart: boolean,
) {
  const base = {
    id: row.id,
    order_cart_id: row.orderCartId,
    product_id: row.productId,
    product_type: row.productType,
    writeoff_num: row.writeoffNum,
    writeoff_price: row.writeoffPrice,
    add_time: row.formattedTime,
    time: row.formattedTime,
    time_key: row.formattedTime,
  };
  if (!includeCart) return base;
  const snapshot = parseSnapshot(row.cartInfo);
  const product = nestedRecord(snapshot?.productInfo) ?? nestedRecord(snapshot?.product);
  const attr = nestedRecord(product?.attrInfo) ?? nestedRecord(snapshot?.sku);
  const name = Array.from(String(product?.store_name ?? product?.storeName ?? "")).slice(0, 10).join("");
  return {
    ...base,
    cartInfo: {
      productInfo: {
        store_name: name,
        image: String(product?.image ?? ""),
        price: String(product?.price ?? snapshot?.truePrice ?? "0.00"),
        ...(attr ? { attrInfo: { image: String(attr.image ?? product?.image ?? "") } } : {}),
      },
    },
  };
}

/** Local PostgreSQL-only compatibility actions for the embedded order manager. */
export class AdminMobileOrderOperationService {
  constructor(private readonly container: Container) {}

  async changePrice(adminId: number, body: Record<string, unknown>) {
    if (!Number.isSafeInteger(adminId) || adminId <= 0) throw new ValidateException("管理员身份不存在");
    const input = parseAdminOrderPriceInput(body);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      const preliminary = await tx
        .select({ id: storeOrder.id, pid: storeOrder.pid })
        .from(storeOrder)
        .where(and(
          eq(storeOrder.orderId, input.orderId),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ))
        .orderBy(asc(storeOrder.id))
        .limit(2);
      if (preliminary.length !== 1) throw new NotFoundException("订单不存在或编号不唯一");
      const rootId = preliminary[0].pid > 0 ? preliminary[0].pid : preliminary[0].id;
      await lockOrderSettlement(tx, rootId);
      const rows = await tx
        .select({
          id: storeOrder.id,
          paid: storeOrder.paid,
          payPrice: storeOrder.payPrice,
          changePrice: storeOrder.changePrice,
        })
        .from(storeOrder)
        .where(and(
          eq(storeOrder.id, preliminary[0].id),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ))
        .limit(1)
        .for("update");
      const order = rows[0];
      if (!order) throw new NotFoundException("订单不存在");
      if (order.paid !== 0) throw new ValidateException("订单已支付");
      const next = computeAdminOrderPrice(order.payPrice, order.changePrice, input.priceCents);
      if (!next.changed) return { changed: false };
      const updated = await tx
        .update(storeOrder)
        .set({ payPrice: next.payPrice, changePrice: next.changePrice })
        .where(and(
          eq(storeOrder.id, order.id),
          eq(storeOrder.paid, 0),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ))
        .returning({ id: storeOrder.id });
      if (!updated[0]) throw new ValidateException("订单已被处理，请刷新后重试");
      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: "admin_order_price",
        changeMessage: `管理员 ${adminId} 修改订单价格`,
        changeTime: Math.floor(Date.now() / 1_000),
      });
      return { changed: true };
    });
  }

  async updateRemark(adminId: number, body: Record<string, unknown>) {
    if (!Number.isSafeInteger(adminId) || adminId <= 0) throw new ValidateException("管理员身份不存在");
    const input = parseAdminOrderRemarkInput(body);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      const rows = await tx
        .select({ id: storeOrder.id, remark: storeOrder.remark })
        .from(storeOrder)
        .where(and(
          eq(storeOrder.orderId, input.orderId),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ))
        .orderBy(asc(storeOrder.id))
        .limit(2)
        .for("update");
      if (rows.length !== 1) throw new NotFoundException("订单不存在或编号不唯一");
      if (rows[0].remark === input.remark) return { changed: false };
      const updated = await tx
        .update(storeOrder)
        .set({ remark: input.remark })
        .where(and(
          eq(storeOrder.id, rows[0].id),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ))
        .returning({ id: storeOrder.id });
      if (!updated[0]) throw new ValidateException("订单已被处理，请刷新后重试");
      await tx.insert(storeOrderStatus).values({
        oid: rows[0].id,
        changeType: "admin_order_remark",
        changeMessage: `管理员 ${adminId} 更新订单备注`,
        changeTime: Math.floor(Date.now() / 1_000),
      });
      return { changed: true };
    });
  }

  async writeoffRecords(orderIdValue: unknown, body: Record<string, unknown>) {
    const orderId = parseAdminOrderPrimaryId(orderIdValue);
    const input = parseAdminWriteoffRecordsInput(body);
    const orders = await this.container.db
      .select({ id: storeOrder.id })
      .from(storeOrder)
      .where(and(
        eq(storeOrder.id, orderId),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      ))
      .limit(2);
    if (orders.length !== 1) throw new NotFoundException("订单不存在");

    const where = input.productType === 4
      ? and(eq(storeOrderWriteoff.oid, orderId), eq(storeOrderWriteoff.productType, 4))
      : eq(storeOrderWriteoff.oid, orderId);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select({
          id: storeOrderWriteoff.id,
          orderCartId: storeOrderWriteoff.orderCartId,
          productId: storeOrderWriteoff.productId,
          productType: storeOrderWriteoff.productType,
          writeoffNum: storeOrderWriteoff.writeoffNum,
          writeoffPrice: storeOrderWriteoff.writeoffPrice,
          formattedTime: sql<string>`CASE
            WHEN ${storeOrderWriteoff.addTime} > 0
            THEN to_char(to_timestamp(${storeOrderWriteoff.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI')
            ELSE '' END`,
          cartInfo: sql<string | null>`CASE
            WHEN ${storeOrderCartInfo.cartInfo} IS NOT NULL
              AND octet_length(${storeOrderCartInfo.cartInfo}) <= ${MAX_CART_SNAPSHOT_BYTES}
            THEN ${storeOrderCartInfo.cartInfo}
            ELSE NULL END`,
        })
        .from(storeOrderWriteoff)
        .leftJoin(storeOrderCartInfo, and(
          eq(storeOrderCartInfo.id, storeOrderWriteoff.orderCartId),
          eq(storeOrderCartInfo.oid, orderId),
        ))
        .where(where)
        .orderBy(desc(storeOrderWriteoff.addTime), desc(storeOrderWriteoff.id))
        .limit(input.limit)
        .offset((input.page - 1) * input.limit),
      input.productType === 4
        ? Promise.resolve([{ total: 0 }])
        : this.container.db
            .select({ total: sql<number>`count(*)::int` })
            .from(storeOrderWriteoff)
            .where(where),
    ]);
    const list = rows.map((row) => projectAdminWriteoffRecord(row, input.productType !== 4));
    return {
      count: totals[0]?.total ?? 0,
      list,
      time: input.productType === 4
        ? []
        : [...new Set(list.map((item) => item.time_key))],
    };
  }
}
