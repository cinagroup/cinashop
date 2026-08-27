import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderStatus,
  storeProductAttrValue,
  storeProductVirtual,
} from "@/models/schema";
import { enqueueOrderDeliveryNoticeEvent } from "@/services/order/OrderNotificationOutboxService";

const CARD_PRODUCT_TYPE = 1;
const MAX_VIRTUAL_INFO_BYTES = 1024 * 1024;

export interface VirtualDeliveryOrder {
  id: number;
  uid: number;
  orderId: string;
  paid: number;
  status: number;
  isDel: number;
  isSystemDel: number;
  productType: number;
}

export interface DeliveredVirtualCard {
  card_no: string;
  card_pwd: string;
  product_id?: number;
  sku_unique?: string;
}

export interface DeliveredVirtualDiskInfo {
  disk_info: string;
  product_id: number;
  sku_unique: string;
  quantity: number;
}

export type VirtualDeliveryInfo =
  | Array<DeliveredVirtualCard | DeliveredVirtualDiskInfo>
  | string
  | null;

export interface VirtualDeliveryResult {
  deliveredOrders: number;
  deliveredCards: number;
}

/**
 * PHP stores virtual_info as JSON text, but the storefront contract exposes
 * the decoded array/string only on an authenticated order detail response.
 */
export function parseVirtualDeliveryInfo(value: string | null): VirtualDeliveryInfo {
  if (!value || value.length > MAX_VIRTUAL_INFO_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") return parsed.slice(0, MAX_VIRTUAL_INFO_BYTES);
    if (!Array.isArray(parsed)) return null;
    const items: Array<DeliveredVirtualCard | DeliveredVirtualDiskInfo> = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (typeof row.disk_info === "string") {
        if (
          typeof row.product_id !== "number" ||
          !Number.isSafeInteger(row.product_id) ||
          row.product_id <= 0 ||
          typeof row.sku_unique !== "string" ||
          typeof row.quantity !== "number" ||
          !Number.isSafeInteger(row.quantity) ||
          row.quantity <= 0
        ) return null;
        items.push({
          disk_info: row.disk_info,
          product_id: row.product_id,
          sku_unique: row.sku_unique,
          quantity: row.quantity,
        });
        continue;
      }
      if (typeof row.card_no !== "string" || typeof row.card_pwd !== "string") return null;
      items.push({
        card_no: row.card_no,
        card_pwd: row.card_pwd,
        ...(typeof row.product_id === "number" ? { product_id: row.product_id } : {}),
        ...(typeof row.sku_unique === "string" ? { sku_unique: row.sku_unique } : {}),
      });
    }
    return items;
  } catch {
    return null;
  }
}

/**
 * Claim every card and mark the corresponding paid order delivered inside the
 * caller's payment-outbox transaction. A retry either observes COMPLETED or
 * re-runs from a fully rolled-back state; no card can be partially assigned.
 */
export async function deliverPaidVirtualOrders(
  tx: DbClient,
  fulfillmentOrders: readonly VirtualDeliveryOrder[],
  now: number,
): Promise<VirtualDeliveryResult> {
  let deliveredOrders = 0;
  let deliveredCards = 0;

  for (const order of [...fulfillmentOrders].sort((left, right) => left.id - right.id)) {
    const carts = await tx
      .select({
        id: storeOrderCartInfo.id,
        productId: storeOrderCartInfo.productId,
        productType: storeOrderCartInfo.productType,
        skuUnique: storeOrderCartInfo.skuUnique,
        cartNum: storeOrderCartInfo.cartNum,
      })
      .from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id))
      .orderBy(
        asc(storeOrderCartInfo.productId),
        asc(storeOrderCartInfo.skuUnique),
        asc(storeOrderCartInfo.id),
      )
      .for("update");
    const virtualCarts = carts.filter((cart) => cart.productType === CARD_PRODUCT_TYPE);
    if (!virtualCarts.length) continue;
    if (virtualCarts.length !== carts.length || order.productType !== CARD_PRODUCT_TYPE) {
      throw new Error(`订单 ${order.orderId} 混合了卡密与其他商品，不能自动发货`);
    }

    const currentRows = await tx
      .select({
        id: storeOrder.id,
        uid: storeOrder.uid,
        orderId: storeOrder.orderId,
        userAddress: storeOrder.userAddress,
        paid: storeOrder.paid,
        status: storeOrder.status,
        isDel: storeOrder.isDel,
        isSystemDel: storeOrder.isSystemDel,
        deliveryType: storeOrder.deliveryType,
        virtualInfo: storeOrder.virtualInfo,
      })
      .from(storeOrder)
      .where(eq(storeOrder.id, order.id))
      .limit(1)
      .for("update");
    const current = currentRows[0];
    if (!current || current.paid !== 1 || current.isDel !== 0 || current.isSystemDel !== 0) {
      throw new Error(`卡密订单 ${order.orderId} 不处于可发货状态`);
    }
    if (current.status === 1 && current.deliveryType === "fictitious") {
      if (parseVirtualDeliveryInfo(current.virtualInfo) === null) {
        throw new Error(`卡密订单 ${order.orderId} 的既有交付记录无效`);
      }
      continue;
    }
    if (current.status !== 0) throw new Error(`卡密订单 ${order.orderId} 状态不允许自动发货`);

    const delivery: Array<DeliveredVirtualCard | DeliveredVirtualDiskInfo> = [];
    for (const cart of virtualCarts) {
      if (!Number.isSafeInteger(cart.cartNum) || cart.cartNum <= 0) {
        throw new Error(`卡密订单 ${order.orderId} 的商品数量无效`);
      }
      const skuRows = await tx
        .select({ diskInfo: storeProductAttrValue.diskInfo })
        .from(storeProductAttrValue)
        .where(
          and(
            eq(storeProductAttrValue.productId, cart.productId),
            eq(storeProductAttrValue.type, 0),
            eq(storeProductAttrValue.unique, cart.skuUnique),
          ),
        )
        .limit(1)
        .for("key share");
      const diskInfo = skuRows[0]?.diskInfo?.trim() ?? "";
      if (diskInfo) {
        delivery.push({
          disk_info: diskInfo,
          product_id: cart.productId,
          sku_unique: cart.skuUnique,
          quantity: cart.cartNum,
        });
        continue;
      }

      const cards = await tx
        .select({
          id: storeProductVirtual.id,
          cardNo: storeProductVirtual.cardNo,
          cardPwd: storeProductVirtual.cardPwd,
        })
        .from(storeProductVirtual)
        .where(
          and(
            eq(storeProductVirtual.productId, cart.productId),
            eq(storeProductVirtual.attrUnique, cart.skuUnique),
            eq(storeProductVirtual.uid, 0),
          ),
        )
        .orderBy(asc(storeProductVirtual.id))
        .limit(cart.cartNum)
        .for("update", { skipLocked: true });
      if (cards.length !== cart.cartNum) {
        throw new Error(`卡密订单 ${order.orderId} 库存不足，等待补充后重试`);
      }
      // The PHP editor allowed password-only inventory. A password is always
      // required, while an omitted card number remains an empty value.
      if (cards.some((card) => !card.cardPwd.trim())) {
        throw new Error(`卡密订单 ${order.orderId} 存在空卡密密码`);
      }
      const claimed = await tx
        .update(storeProductVirtual)
        .set({ uid: current.uid, orderId: current.orderId, orderType: 1 })
        .where(
          and(
            inArray(storeProductVirtual.id, cards.map((card) => card.id)),
            eq(storeProductVirtual.uid, 0),
          ),
        )
        .returning({ id: storeProductVirtual.id });
      if (claimed.length !== cards.length) {
        throw new Error(`卡密订单 ${order.orderId} 的卡密被其他订单占用`);
      }
      delivery.push(...cards.map((card) => ({
        card_no: card.cardNo,
        card_pwd: card.cardPwd,
        product_id: cart.productId,
        sku_unique: cart.skuUnique,
      })));
      deliveredCards += cards.length;
    }

    const virtualInfo = JSON.stringify(delivery);
    if (new TextEncoder().encode(virtualInfo).byteLength > MAX_VIRTUAL_INFO_BYTES) {
      throw new Error(`卡密订单 ${order.orderId} 的交付内容超过 1 MiB`);
    }
    const updated = await tx
      .update(storeOrder)
      .set({
        status: 1,
        deliveryType: "fictitious",
        fictitiousContent: "卡密已自动发放，请在订单详情中查看",
        virtualInfo,
      })
      .where(
        and(
          eq(storeOrder.id, current.id),
          eq(storeOrder.paid, 1),
          eq(storeOrder.status, 0),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ),
      )
      .returning({ id: storeOrder.id });
    if (!updated[0]) throw new Error(`卡密订单 ${order.orderId} 自动发货状态写入失败`);
    await tx.insert(storeOrderStatus).values({
      oid: current.id,
      changeType: "delivery_fictitious",
      changeMessage: `卡密自动发货，共 ${delivery.length} 项`,
      changeTime: now,
    });
    await enqueueOrderDeliveryNoticeEvent(tx, {
      orderId: current.id,
      orderNo: current.orderId,
      userId: current.uid,
      userAddress: current.userAddress,
      deliveryType: "fictitious",
      deliveryName: "",
      deliveryId: "",
    }, now);
    deliveredOrders += 1;
  }

  return { deliveredOrders, deliveredCards };
}
