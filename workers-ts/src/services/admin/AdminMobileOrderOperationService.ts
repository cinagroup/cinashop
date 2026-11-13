import { AdminOrderPriceService } from "./AdminOrderPriceService";
export { parseAdminOrderPriceInput, computeAdminOrderPrice, type AdminOrderPriceInput } from "./AdminOrderPriceInput";
import { AdminOrderRemarkService } from './AdminOrderRemarkService';
import type { AdminAuthorityActor } from './AdminAuthorityWriteService';
export { parseAdminOrderRemarkInput, type AdminOrderRemarkInput } from './AdminOrderRemarkInput';
import { and, desc, eq, sql } from "drizzle-orm";
import { type Container } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderWriteoff,
} from "@/models/schema";
import {
  parseAdminOrderPrimaryId,
} from "@/services/admin/AdminMobileOrderReadService";
import { NotFoundException, ValidateException } from "@/utils/errors";

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

  changePrice(actor: AdminAuthorityActor, body: Record<string, unknown>) {
    return new AdminOrderPriceService(this.container).changePrice(actor, body);
  }

  async updateRemark(actor: AdminAuthorityActor, body: Record<string, unknown>) {
    return new AdminOrderRemarkService(this.container).byNumber(actor, body);
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
