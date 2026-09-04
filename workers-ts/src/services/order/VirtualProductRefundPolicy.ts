import { eq } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeProductVirtual } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { parseVirtualDeliverySnapshot } from "@/services/order/VirtualProductDeliveryService";

const CARD_PRODUCT_TYPE = 1;

export interface VirtualRefundOrderSnapshot {
  orderId: string;
  status: number;
  deliveryType: string;
  virtualInfo: string | null;
}

export interface VirtualRefundCartSnapshot {
  id: number;
  productId: number;
  productType: number;
  skuUnique: string;
  isSupportRefund: number;
  writeTimes: number;
  writeSurplusTimes: number;
  cartInfo: string | null;
}

export interface CustomerRefundEligibility {
  allowed: boolean;
  reason: string;
}

function cardInventoryCarts(carts: readonly VirtualRefundCartSnapshot[]) {
  const result: VirtualRefundCartSnapshot[] = [];
  for (const cart of carts) {
    if (cart.productType !== CARD_PRODUCT_TYPE) continue;
    const snapshot = parseVirtualDeliverySnapshot(cart.cartInfo);
    if (!snapshot) {
      throw new ValidateException("卡密商品交付快照缺失，不能安全退款");
    }
    if (!snapshot.diskInfo) result.push(cart);
  }
  return result;
}

function snapshotShowsIrreversibleDelivery(order: VirtualRefundOrderSnapshot): boolean {
  return order.status !== 0
    || order.deliveryType === "fictitious"
    || Boolean(order.virtualInfo?.trim());
}

/**
 * Advisory storefront policy. The write path repeats this decision while the
 * order row is locked and also checks the authoritative card-assignment table.
 */
export function customerRefundEligibility(
  order: VirtualRefundOrderSnapshot,
  carts: readonly VirtualRefundCartSnapshot[],
): CustomerRefundEligibility {
  if (!carts.length) return { allowed: false, reason: "订单缺少商品快照" };
  if (carts.some((cart) => cart.isSupportRefund !== 1)) {
    return { allowed: false, reason: "订单包含不支持退款的商品" };
  }
  if (carts.some((cart) => cart.writeTimes > cart.writeSurplusTimes)) {
    return { allowed: false, reason: "订单包含已经核销的商品" };
  }
  let cards: VirtualRefundCartSnapshot[];
  try {
    cards = cardInventoryCarts(carts);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "卡密商品退款状态无法确认",
    };
  }
  if (cards.length && snapshotShowsIrreversibleDelivery(order)) {
    return {
      allowed: false,
      reason: "一次性卡密已发放，密钥不可回收；请联系管理员人工处理",
    };
  }
  return { allowed: true, reason: "" };
}

/**
 * Authoritative type-1 refund boundary. Customer return-logistics requests are
 * meaningless for virtual products. Once a one-time secret is assigned or
 * exposed it is never recycled; only a privileged, audited admin goodwill
 * refund may proceed after that point.
 */
export async function assertVirtualProductRefundPolicy(
  tx: DbClient,
  order: VirtualRefundOrderSnapshot,
  carts: readonly VirtualRefundCartSnapshot[],
  options: {
    applyType: number;
    allowIrreversibleSecretRefund: boolean;
  },
): Promise<void> {
  const virtualCarts = carts.filter((cart) => cart.productType === CARD_PRODUCT_TYPE);
  if (!virtualCarts.length) return;
  if (options.applyType === 2 && !options.allowIrreversibleSecretRefund) {
    throw new ValidateException("虚拟商品仅支持仅退款");
  }
  const cards = cardInventoryCarts(virtualCarts);
  if (!cards.length) return;

  const assigned = await tx
    .select({ id: storeProductVirtual.id })
    .from(storeProductVirtual)
    .where(eq(storeProductVirtual.orderId, order.orderId))
    .limit(1);
  if (
    (snapshotShowsIrreversibleDelivery(order) || Boolean(assigned[0]))
    && !options.allowIrreversibleSecretRefund
  ) {
    throw new ValidateException("一次性卡密已发放，密钥不可回收；请联系管理员人工处理");
  }
}
