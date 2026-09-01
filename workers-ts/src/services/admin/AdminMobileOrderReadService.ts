import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  expressCompany,
  storeOrder,
  storeOrderCartInfo,
  user,
} from "@/models/schema";
import { StoreOperationsService } from "@/services/store/StoreOperationsService";
import { normalizeConfigScalar, parseConfigInteger } from "@/utils/config";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_POSTGRES_ID = 2_147_483_647;

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseSnapshot(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return nestedRecord(parsed);
  } catch {
    return null;
  }
}

export function parseAdminOrderPrimaryId(value: unknown): number {
  const normalized = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) throw new ValidateException("订单ID错误");
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_POSTGRES_ID) {
    throw new ValidateException("订单ID错误");
  }
  return parsed;
}

export function parseAdminOrderNumber(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 32 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new ValidateException("订单号错误");
  }
  return normalized;
}

export function parseAdminDeliveryQuery(query: Record<string, string>) {
  const parse = (value: string | undefined, fallback: number, name: string, maximum: number) => {
    const normalized = value?.trim() || String(fallback);
    if (!/^\d+$/.test(normalized)) throw new ValidateException(`${name}错误`);
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
      throw new ValidateException(`${name}错误`);
    }
    return parsed;
  };
  return {
    page: parse(query.page, 1, "页码", 10_000),
    limit: parse(query.limit, 20, "每页数量", 100),
  };
}

export function projectAdminSplitCart(row: typeof storeOrderCartInfo.$inferSelect) {
  const snapshot = parseSnapshot(row.cartInfo);
  const product = nestedRecord(snapshot?.product);
  const productInfo = nestedRecord(snapshot?.productInfo);
  const sku = nestedRecord(snapshot?.sku);
  const attrInfo = nestedRecord(productInfo?.attrInfo);
  const snapshotCartNum = Number(snapshot?.cart_num ?? 0);
  const cartNum = row.cartNum > 0
    ? row.cartNum
    : Number.isSafeInteger(snapshotCartNum) && snapshotCartNum > 0 ? snapshotCartNum : 0;
  return {
    id: row.id,
    cart_id: row.cartId,
    product_id: row.productId,
    sku_unique: row.skuUnique,
    cart_num: cartNum,
    refund_num: row.refundNum,
    surplus_num: row.splitSurplusNum,
    product_name: String(product?.storeName ?? productInfo?.store_name ?? "商品快照"),
    image: String(product?.image ?? productInfo?.image ?? ""),
    sku: String(sku?.suk ?? attrInfo?.suk ?? row.skuUnique),
    cart_info: snapshot,
  };
}

/** Read-only compatibility surface for the embedded admin fulfillment screen. */
export class AdminMobileOrderReadService {
  constructor(private readonly container: Container) {}

  async deliveryGain(orderNumberValue: unknown) {
    const orderNumber = parseAdminOrderNumber(orderNumberValue);
    const rows = await this.container.db
      .select({
        id: storeOrder.id,
        order_id: storeOrder.orderId,
        real_name: storeOrder.realName,
        user_phone: storeOrder.userPhone,
        user_address: storeOrder.userAddress,
        paid: storeOrder.paid,
        nickname: user.nickname,
      })
      .from(storeOrder)
      .leftJoin(user, eq(user.uid, storeOrder.uid))
      .where(and(
        eq(storeOrder.orderId, orderNumber),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      ))
      .limit(2);
    if (rows.length > 1) throw new ValidateException("订单号存在重复，请先完成数据核对");
    const row = rows[0];
    if (!row) throw new NotFoundException("订单不存在");
    if (row.paid !== 1) throw new ValidateException("订单状态错误");
    const config = await this.container.systemConfigDao.getValues(["config_export_open"]);
    return {
      id: row.id,
      order_id: row.order_id,
      real_name: row.real_name,
      user_phone: row.user_phone,
      user_address: row.user_address,
      nickname: row.nickname ?? "",
      config_export_open: parseConfigInteger(config.config_export_open, 0) === 1 ? 1 : 0,
    };
  }

  async deliveryAgents(query: Record<string, string>) {
    const parsed = parseAdminDeliveryQuery(query);
    const result = await new StoreOperationsService(this.container).deliveryList({
      page: String(parsed.page),
      limit: String(parsed.limit),
    }, true);
    return result.list;
  }

  async deliveryConfig() {
    const values = await this.container.systemConfigDao.getValues([
      "config_export_temp_id",
      "config_export_to_name",
      "config_export_id",
      "config_export_to_tel",
      "config_export_to_address",
    ]);
    return {
      express_temp_id: normalizeConfigScalar(values.config_export_temp_id),
      to_name: normalizeConfigScalar(values.config_export_to_name),
      id: normalizeConfigScalar(values.config_export_id),
      to_tel: normalizeConfigScalar(values.config_export_to_tel),
      to_add: normalizeConfigScalar(values.config_export_to_address),
    };
  }

  async expressList() {
    // The PHP projection exposed carrier account/key fields. The mobile client
    // only needs this allowlisted catalog and must never receive credentials.
    return this.container.db
      .select({ id: expressCompany.id, name: expressCompany.name, code: expressCompany.code })
      .from(expressCompany)
      .where(and(eq(expressCompany.isShow, 1), eq(expressCompany.status, 1)))
      .orderBy(desc(expressCompany.sort), desc(expressCompany.id));
  }

  async splitCartInfo(orderIdValue: unknown) {
    const orderId = parseAdminOrderPrimaryId(orderIdValue);
    const rows = await this.container.db
      .select()
      .from(storeOrder)
      .where(and(
        eq(storeOrder.id, orderId),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      ))
      .limit(1);
    const order = rows[0];
    if (!order) throw new NotFoundException("订单不存在");

    let activeOrderId = order.id;
    if (order.pid === -1) {
      const pending = await this.container.db
        .select({ id: storeOrder.id })
        .from(storeOrder)
        .where(and(
          eq(storeOrder.pid, order.id),
          eq(storeOrder.status, 0),
          eq(storeOrder.storeId, 0),
          eq(storeOrder.supplierId, 0),
          inArray(storeOrder.refundType, [0, 3]),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ))
        .orderBy(asc(storeOrder.id))
        .limit(2);
      if (pending.length > 1) throw new ValidateException("订单存在多个待发货子单，请先完成数据核对");
      if (!pending[0]) return [];
      activeOrderId = pending[0].id;
    }

    const carts = await this.container.db
      .select()
      .from(storeOrderCartInfo)
      .where(and(
        eq(storeOrderCartInfo.oid, activeOrderId),
        inArray(storeOrderCartInfo.splitStatus, [0, 1]),
        sql`${storeOrderCartInfo.splitSurplusNum} > 0`,
      ))
      .orderBy(asc(storeOrderCartInfo.id));
    return carts.map(projectAdminSplitCart);
  }
}
