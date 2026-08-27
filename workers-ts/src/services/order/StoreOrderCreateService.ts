/**
 * 订单创建 Service (M3 最高风险模块)
 *
 * 对应 PHP app/services/order/StoreOrderCreateServices.php::createOrder
 *
 * 强一致链路:
 *   ① Hyperdrive/PostgreSQL 事务内原子认领购物车，阻止不同 key 并发重复下单
 *   ② 同一事务内完成:
 *      - INSERT order (unique 约束兜底幂等)
 *      - UPDATE store_product_attr_value SET stock=stock-n WHERE id=? AND stock>=n  ← 修复 PHP 超卖 bug
 *      - UPDATE store_product SET stock=stock-n, sales=sales+n WHERE id=? AND stock>=n
 *      - INSERT store_order_cart_info (商品快照)
 *      - (可选) UPDATE user SET integral=integral-n, INSERT user_bill
 *   ③ 取消未支付订单时，在一个事务中反向补偿库存、积分、优惠券和活动名额
 *
 * 关键修复 (相比 PHP):
 *   - 库存扣减加 WHERE stock>=n 守卫 (PHP decStockIncSales 缺失, 靠事务行锁兜底)
 *   - 不使用 Durable Object 包裹空操作来伪装数据库事务已串行化
 */
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  storeCart,
  storeOrder,
  storeProduct,
  storeProductAttrValue,
  storeOrderCartInfo,
  user as userTable,
  userBill,
  storeSeckill,
  storeCombination,
  storeIntegral,
  storePink,
  storeBargain,
  storeBargainUser,
  storeCouponIssue,
  storeCouponProduct,
  storeCouponUser,
  storeProductCategory,
  storeBrand,
  shippingTemplates,
  shippingTemplatesRegion,
  shippingTemplatesFree,
  shippingTemplatesNoDelivery,
  cityArea,
  storeOrderEconomize,
  storeOrderInvoice,
  storeOrderPromotions,
  storePromotions,
  storeOrderWriteoff,
  storeOrderStatus,
  storeNewcomer,
  storeDiscounts,
  systemStore,
} from "@/models/schema";
import { createContainerFromDb, withTx, type Container, type DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException, NotFoundException } from "@/utils/errors";
import {
  buildOrderBrokerageSnapshot,
  completeOrderReceipt,
  decimalToCents,
} from "@/services/order/OrderBrokerageService";
import {
  calculateProductIntegralSnapshot,
  decimalToWholePoints,
} from "@/services/order/OrderRewardService";
import {
  calculateOrderPostageCents,
  expandShippingRegionIds,
  ShippingConfigurationError,
} from "@/services/order/ShippingCalculator";
import {
  calculateCouponDiscountCents,
  calculateCouponEligibleSubtotalCents,
  parseCouponScopeIds,
  reconcileCouponProductScopeIds,
} from "@/services/activity/ProductCouponService";
import {
  allocateLegacyDiscountCents,
  calculateFirstOrderDiscountCents,
  loadFirstOrderDiscountConfig,
  loadNewcomerEligibilityConfig,
  type FirstOrderDiscountConfig,
  type NewcomerEligibilityConfig,
} from "@/services/activity/StoreNewcomerService";
import type { SystemConfigEnv } from "@/services/system/SystemConfigService";
import {
  collectOrderSystemForm,
  loadOrderSystemFormSubmission,
  readOrderSystemFormSnapshot,
} from "@/services/order/OrderSystemFormService";
import { AttachmentService } from "@/services/system/AttachmentService";
import { reservePinkJoin } from "@/services/activity/PinkLifecycleService";
import { generatePickupVerifyCode } from "@/services/order/StoreOrderWriteoffService";
import { parseVirtualDeliveryInfo } from "@/services/order/VirtualProductDeliveryService";
import {
  resolveDiscountPackageSelection,
  type ResolvedDiscountPackage,
  type ResolvedDiscountPackageItem,
} from "@/services/activity/StoreDiscountService";
import { enqueueAutomaticReceiptPrintJobs } from "@/services/printing/ReceiptPrintJobService";

/** 下单入参 */
export interface CreateOrderParams {
  uid: number;
  /** 确认订单的 key (幂等防重) */
  key: string;
  cartIds: number[];
  realName?: string;
  userPhone?: string;
  province?: string;
  cityId?: number;
  userAddress?: string;
  mark?: string;
  shippingType?: number;
  storeId?: number;
  useIntegral?: number;
  userIp: string;
  /** 活动类型: 0普通 1秒杀 2砍价 3拼团 4积分 5套餐 7新人专享 */
  type?: number;
  /** 拼团: 参团的团 ID (0=开团) */
  pinkId?: number;
  /** 拼团: 活动 ID (开团时必传) */
  combinationId?: number;
  /** 秒杀: 秒杀活动 ID */
  seckillId?: number;
  /** 砍价: 砍价记录 ID (store_bargain_user) */
  bargainUserId?: number;
  /** 优惠券: 用户优惠券 ID (store_coupon_user) */
  couponId?: number;
  /** 系统自定义表单组件和值；表单 ID 始终由商品/活动记录决定。 */
  customForm?: unknown;
}

/** Infrastructure needed by the real order-creation core. */
export interface StoreOrderCreationRuntime extends SystemConfigEnv {
  nextOrderId(): Promise<string>;
}

export interface CancelStoreOrderInput {
  uid: number;
  orderId: string;
}

/**
 * Cancel one unpaid order and restore every reserved resource in the same
 * PostgreSQL transaction, including the immutable cancellation status row.
 */
export async function cancelStoreOrder(
  container: Container,
  params: CancelStoreOrderInput,
): Promise<void> {
  const { uid, orderId } = params;
  await withTx(container, async (tx) => {
    const orderRows = await tx
      .select()
      .from(storeOrder)
      .where(eq(storeOrder.orderId, orderId))
      .limit(1)
      .for("update");
    const order = orderRows[0];
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    if (order.pid === -1 || order.supplierAllocationStatus === 1) {
      throw new ValidateException("拆分审计订单不能取消");
    }
    if (order.paid) throw new ValidateException("已支付订单不能取消");
    if (order.status !== 0 || order.isDel) throw new ValidateException("订单状态不允许取消");

    const cartInfos = await tx
      .select()
      .from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id))
      .orderBy(storeOrderCartInfo.id);
    if (!cartInfos.length) throw new Error(`订单 ${orderId} 缺少商品快照，无法安全取消`);

    const cancelled = await tx
      .update(storeOrder)
      .set({ status: -2, isDel: 1 })
      .where(
        and(
          eq(storeOrder.id, order.id),
          eq(storeOrder.uid, uid),
          eq(storeOrder.paid, 0),
          eq(storeOrder.status, 0),
          eq(storeOrder.isDel, 0),
        ),
      )
      .returning({ id: storeOrder.id });
    if (!cancelled.length) throw new ValidateException("订单已被处理");

    for (const item of cartInfos) {
      let snapshotSkuId = 0;
      let snapshotActivitySkuId = 0;
      try {
        const snapshot = JSON.parse(item.cartInfo ?? "{}") as {
          sku?: { id?: unknown };
          activitySku?: { id?: unknown };
        };
        const parsedId = Number(snapshot.sku?.id ?? 0);
        if (Number.isSafeInteger(parsedId) && parsedId > 0) snapshotSkuId = parsedId;
        const parsedActivitySkuId = Number(snapshot.activitySku?.id ?? 0);
        if (Number.isSafeInteger(parsedActivitySkuId) && parsedActivitySkuId > 0) {
          snapshotActivitySkuId = parsedActivitySkuId;
        }
      } catch {
        snapshotSkuId = 0;
        snapshotActivitySkuId = 0;
      }
      if (!snapshotSkuId) {
        const legacySkus = await tx
          .select({ id: storeProductAttrValue.id })
          .from(storeProductAttrValue)
          .where(
            and(
              eq(storeProductAttrValue.productId, item.productId),
              eq(storeProductAttrValue.unique, item.skuUnique),
              eq(storeProductAttrValue.type, 0),
            ),
          )
          .limit(2);
        if (legacySkus.length !== 1) {
          throw new Error(`订单 ${orderId} 的历史 SKU 无法唯一定位`);
        }
        snapshotSkuId = legacySkus[0].id;
      }
      const skuRestored = await tx
        .update(storeProductAttrValue)
        .set({
          stock: sql`stock + ${item.cartNum}`,
          sales: sql`GREATEST(sales - ${item.cartNum}, 0)`,
        })
        .where(eq(storeProductAttrValue.id, snapshotSkuId))
        .returning({ id: storeProductAttrValue.id });
      const productRestored = await tx
        .update(storeProduct)
        .set({
          stock: sql`stock + ${item.cartNum}`,
          sales: sql`GREATEST(sales - ${item.cartNum}, 0)`,
        })
        .where(eq(storeProduct.id, item.productId))
        .returning({ id: storeProduct.id });
      if (!skuRestored.length || !productRestored.length) {
        throw new Error(`订单 ${orderId} 的商品库存无法完整恢复`);
      }
      if (order.type === 4) {
        if (!snapshotActivitySkuId) {
          throw new Error(`订单 ${orderId} 的积分活动 SKU 快照缺失，无法安全取消`);
        }
        const activitySkuRestored = await tx
          .update(storeProductAttrValue)
          .set({
            stock: sql`stock + ${item.cartNum}`,
            quota: sql`quota + ${item.cartNum}`,
            sales: sql`GREATEST(sales - ${item.cartNum}, 0)`,
          })
          .where(
            and(
              eq(storeProductAttrValue.id, snapshotActivitySkuId),
              eq(storeProductAttrValue.productId, order.activityId),
              eq(storeProductAttrValue.type, 4),
            ),
          )
          .returning({ id: storeProductAttrValue.id });
        if (!activitySkuRestored.length) {
          throw new Error(`订单 ${orderId} 的积分活动 SKU 库存无法恢复`);
        }
      }

      const cartId = Number(item.cartId);
      if (Number.isSafeInteger(cartId) && cartId > 0) {
        await tx
          .update(storeCart)
          .set({ isPay: 0 })
          .where(and(eq(storeCart.id, cartId), eq(storeCart.uid, uid)));
      }
    }

    const usedIntegral = decimalToWholePoints(order.useIntegral);
    if (usedIntegral > 0) {
      const integralRows = await tx
        .update(userTable)
        .set({ integral: sql`integral + ${usedIntegral}` })
        .where(eq(userTable.uid, uid))
        .returning({ integral: userTable.integral });
      if (!integralRows.length) throw new Error(`订单 ${orderId} 的积分无法恢复`);
      await tx.insert(userBill).values({
        uid,
        linkId: String(order.id),
        pm: 1,
        title: "取消订单返还积分",
        category: "integral",
        type: "order_cancel",
        eventKey: "order_cancel_integral_back",
        number: usedIntegral.toFixed(2),
        balance: String(integralRows[0].integral),
        mark: `取消订单返还, 订单号 ${orderId}`,
        status: 1,
        addTime: Math.floor(Date.now() / 1000),
      });
    }

    if (order.couponId) {
      await tx
        .update(storeCouponUser)
        .set({ status: 0, useTime: null })
        .where(
          and(
            eq(storeCouponUser.id, order.couponId),
            eq(storeCouponUser.uid, uid),
            eq(storeCouponUser.status, 3),
          ),
        );
    }

    if (order.type === 1 && order.activityId) {
      const restored = await tx
        .update(storeSeckill)
        .set({
          quota: sql`quota + ${order.totalNum}`,
          stock: sql`stock + ${order.totalNum}`,
          sales: sql`GREATEST(sales - ${order.totalNum}, 0)`,
        })
        .where(eq(storeSeckill.id, order.activityId))
        .returning({ id: storeSeckill.id });
      if (!restored.length) throw new Error(`订单 ${orderId} 的秒杀库存无法恢复`);
    } else if (order.type === 2 && order.activityId) {
      const bargainUsers = await tx
        .select({ id: storeBargainUser.id, bargainId: storeBargainUser.bargainId })
        .from(storeBargainUser)
        .where(
          and(
            eq(storeBargainUser.uid, uid),
            eq(storeBargainUser.status, 4),
            or(
              eq(storeBargainUser.bargainId, order.activityId),
              eq(storeBargainUser.id, order.activityId),
            ),
          ),
        )
        .limit(2);
      if (bargainUsers.length !== 1) {
        throw new Error(`订单 ${orderId} 的砍价参与记录无法唯一定位`);
      }
      const bargainUser = bargainUsers[0];
      const restored = await tx
        .update(storeBargain)
        .set({
          quota: sql`quota + ${order.totalNum}`,
          stock: sql`stock + ${order.totalNum}`,
          sales: sql`GREATEST(sales - ${order.totalNum}, 0)`,
        })
        .where(eq(storeBargain.id, bargainUser.bargainId))
        .returning({ id: storeBargain.id });
      if (!restored.length) throw new Error(`订单 ${orderId} 的砍价库存无法恢复`);
      const bargainUserRestored = await tx
        .update(storeBargainUser)
        .set({ status: 3 })
        .where(
          and(
            eq(storeBargainUser.id, bargainUser.id),
            eq(storeBargainUser.status, 4),
          ),
        )
        .returning({ id: storeBargainUser.id });
      if (!bargainUserRestored.length) {
        throw new Error(`订单 ${orderId} 的砍价参与状态无法恢复`);
      }
    } else if (order.type === 3 && order.activityId) {
      const restored = await tx
        .update(storeCombination)
        .set({
          quota: sql`quota + ${order.totalNum}`,
          stock: sql`stock + ${order.totalNum}`,
          sales: sql`GREATEST(sales - ${order.totalNum}, 0)`,
        })
        .where(eq(storeCombination.id, order.activityId))
        .returning({ id: storeCombination.id });
      if (!restored.length) throw new Error(`订单 ${orderId} 的拼团库存无法恢复`);
    } else if (order.type === 4 && order.activityId) {
      const restored = await tx
        .update(storeIntegral)
        .set({
          quota: sql`quota + ${order.totalNum}`,
          stock: sql`stock + ${order.totalNum}`,
          sales: sql`GREATEST(sales - ${order.totalNum}, 0)`,
        })
        .where(eq(storeIntegral.id, order.activityId))
        .returning({ id: storeIntegral.id });
      if (!restored.length) throw new Error(`订单 ${orderId} 的积分商品库存无法恢复`);
    } else if (order.type === 5 && order.activityId) {
      const restored = await tx
        .update(storeDiscounts)
        .set({ limitNum: sql`limit_num + 1` })
        .where(
          and(
            eq(storeDiscounts.id, order.activityId),
            eq(storeDiscounts.isLimit, 1),
          ),
        )
        .returning({ id: storeDiscounts.id });
      const limitedRows = await tx
        .select({ isLimit: storeDiscounts.isLimit })
        .from(storeDiscounts)
        .where(eq(storeDiscounts.id, order.activityId))
        .limit(1);
      if (!limitedRows[0] || (limitedRows[0].isLimit === 1 && !restored.length)) {
        throw new Error(`订单 ${orderId} 的套餐限额无法恢复`);
      }
    }

    await tx.insert(storeOrderStatus).values({
      oid: order.id,
      changeType: "cancel",
      changeMessage: "用户取消订单并恢复占用资源",
      changeTime: Math.floor(Date.now() / 1000),
    });
  });
}

interface CouponResolution {
  priceCents: number;
  row: { id: number } | null;
}

function firstOrderAccountEligible(
  account: Pick<typeof userTable.$inferSelect, "addTime" | "isFirstOrder">,
  config: FirstOrderDiscountConfig,
  now: number,
): boolean {
  if (!config.enabled || account.isFirstOrder !== 0) return false;
  return !(
    config.limitEnabled &&
    config.limitDays > 0 &&
    account.addTime + config.limitDays * 86_400 < now
  );
}

async function hasPaidNonNewcomerOrder(
  db: DbClient,
  uid: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: storeOrder.id })
    .from(storeOrder)
    .where(and(eq(storeOrder.uid, uid), eq(storeOrder.paid, 1), ne(storeOrder.type, 7)))
    .limit(1);
  return rows.length > 0;
}

async function resolveOrderCoupon(
  container: Container,
  uid: number,
  couponId: number | undefined,
  orderItems: OrderItem[],
): Promise<CouponResolution> {
  if (!couponId) return { priceCents: 0, row: null };
  const couponRows = await container.db
    .select({ coupon: storeCouponUser, issue: storeCouponIssue })
    .from(storeCouponUser)
    .leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
    .where(and(eq(storeCouponUser.id, couponId), eq(storeCouponUser.uid, uid)))
    .limit(1);
  const coupon = couponRows[0]?.coupon;
  const issue = couponRows[0]?.issue;
  if (!coupon) throw new ValidateException("优惠券不存在");
  if (!issue) throw new ValidateException("优惠券模板不存在，无法校验适用范围");
  if (coupon.status !== 0 || coupon.isFail !== 0) {
    throw new ValidateException("优惠券已使用或已失效");
  }
  const nowMs = Date.now();
  if (coupon.startTime && coupon.startTime.getTime() > nowMs) {
    throw new ValidateException("优惠券尚未到可用时间");
  }
  if (coupon.endTime && coupon.endTime.getTime() < nowMs) {
    throw new ValidateException("优惠券已过期");
  }

  const couponProductRows = issue.couponType === 2
    ? await container.db
        .select({ productId: storeCouponProduct.productId })
        .from(storeCouponProduct)
        .where(eq(storeCouponProduct.couponId, issue.id))
        .orderBy(storeCouponProduct.productId)
    : [];
  const couponProductIds = reconcileCouponProductScopeIds(
    [issue.legacyProductIds, issue.productId],
    couponProductRows.map((row) => row.productId),
  );

  const directCategoryIds = issue.couponType === 1
    ? [...new Set(orderItems.flatMap(({ product }) => parseCouponScopeIds(product.cateId)))]
    : [];
  const categoryRows = directCategoryIds.length
    ? await container.db
        .select({ id: storeProductCategory.id, pid: storeProductCategory.pid, path: storeProductCategory.path })
        .from(storeProductCategory)
        .where(inArray(storeProductCategory.id, directCategoryIds))
    : [];
  const categoryById = new Map(categoryRows.map((row) => [row.id, row]));

  const directBrandIds = issue.couponType === 3
    ? [...new Set(orderItems.map(({ product }) => product.brandId).filter((id) => id > 0))]
    : [];
  const brandRows = directBrandIds.length
    ? await container.db
        .select({ id: storeBrand.id, pid: storeBrand.pid, fid: storeBrand.fid })
        .from(storeBrand)
        .where(inArray(storeBrand.id, directBrandIds))
    : [];
  const brandById = new Map(brandRows.map((row) => [row.id, row]));

  const eligibleSubtotalCents = calculateCouponEligibleSubtotalCents({
    scopeType: issue.couponType,
    productIds: couponProductIds,
    categoryIds: parseCouponScopeIds(issue.legacyCategoryId, issue.category_id),
    brandIds: parseCouponScopeIds(issue.legacyBrandId, issue.brandId),
    items: orderItems.map(({ cart, product, unitPriceCents }) => {
      const categoryIds = parseCouponScopeIds(product.cateId);
      const categoryAncestorIds = categoryIds.flatMap((id) => {
        const category = categoryById.get(id);
        return category ? parseCouponScopeIds(category.pid, category.path) : [];
      });
      const brand = brandById.get(product.brandId);
      return {
        productId: product.id,
        parentProductId: product.pid || product.id,
        categoryIds,
        categoryAncestorIds,
        brandId: product.brandId,
        brandAncestorIds: brand ? parseCouponScopeIds(brand.pid, brand.fid) : [],
        subtotalCents: unitPriceCents * cart.cartNum,
      };
    }),
  });
  if (eligibleSubtotalCents <= 0) {
    throw new ValidateException("优惠券不适用于当前商品");
  }
  let useMinPriceCents: number;
  try {
    useMinPriceCents = decimalToCents(coupon.useMinPrice);
  } catch {
    throw new ValidateException("优惠券使用门槛配置无效");
  }
  if (eligibleSubtotalCents < useMinPriceCents) {
    throw new ValidateException(`适用商品满 ¥${coupon.useMinPrice} 才能使用该券`);
  }
  return {
    priceCents: calculateCouponDiscountCents({
      discountType: issue.type,
      couponPrice: coupon.couponPrice,
      eligibleSubtotalCents,
    }),
    row: coupon,
  };
}

export class StoreOrderCreateService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * 创建订单 (对应 PHP StoreOrderCreateServices::createOrder)
   *
   * 购物车认领和库存扣减都在 PostgreSQL 事务内完成。
   */
  async createOrder(params: CreateOrderParams): Promise<{ orderId: string; key: string }> {
    return StoreOrderCreateService.createWithRuntime(
      this.container,
      {
        CONFIG_KV: this.env.CONFIG_KV,
        nextOrderId: async () => {
          const seqId = this.env.SEQUENCE.idFromName("seq");
          const seq = this.env.SEQUENCE.get(seqId);
          const response = await seq.fetch("https://internal/next-order-id?prefix=wx");
          return (await response.text()).trim();
        },
      },
      params,
    );
  }

  /** 真实创建逻辑 (DB 事务内) */
  static async createWithRuntime(
    c: Container,
    runtime: StoreOrderCreationRuntime,
    params: CreateOrderParams,
  ): Promise<{ orderId: string; key: string }> {
    const { uid, key, cartIds } = params;

    // 幂等检查 (对应 PHP StoreOrder::create 第 188 行)
    const existing = await c.storeOrderDao.findByUnique(uid, key);
    if (existing) return { orderId: existing.orderId, key };

    if (!cartIds.length) throw new ValidateException("请选择要购买的商品");
    if (cartIds.length > 200) throw new ValidateException("单次下单商品不能超过200项");
    const shippingType = params.shippingType ?? 1;
    if (!Number.isSafeInteger(shippingType) || ![1, 2].includes(shippingType)) {
      throw new ValidateException("配送方式只能选择快递或门店自提");
    }
    const pickupStoreId = shippingType === 2 ? Number(params.storeId ?? 0) : 0;
    if (shippingType === 2 && (!Number.isSafeInteger(pickupStoreId) || pickupStoreId <= 0)) {
      throw new ValidateException("请选择有效的自提门店");
    }

    // 1. 取购物车 + 校验所有权
    if (new Set(cartIds).size !== cartIds.length) {
      throw new ValidateException("购物车参数包含重复项");
    }
    const carts = await c.storeCartDao.getByIds(cartIds);
    if (carts.length !== cartIds.length) throw new NotFoundException("购物车商品不存在");
    for (const cart of carts) {
      if (cart.uid !== uid) throw new ValidateException("购物车商品不属于当前用户");
      if (cart.isPay || cart.isDel || cart.status !== 1 || cart.cartNum <= 0) {
        throw new ValidateException("购物车商品已失效或已下单");
      }
    }

    // 2. 预加载商品 + SKU + 计算总价 (整数分, 避免浮点误差)
    //    活动单 (秒杀/砍价/拼团) 用活动价替换 SKU 价
    const type = params.type ?? 0;
    if (carts.some((cart) => cart.type !== type)) {
      throw new ValidateException("购物车活动类型与订单类型不匹配");
    }
    if (type > 0 && type !== 5 && carts.length !== 1) {
      throw new ValidateException("活动订单一次只能购买一种商品");
    }
    if (type === 1 && (!Number.isSafeInteger(params.seckillId) || (params.seckillId ?? 0) <= 0)) {
      throw new ValidateException("缺少秒杀活动信息");
    }
    if (type === 2 && (!Number.isSafeInteger(params.bargainUserId) || (params.bargainUserId ?? 0) <= 0)) {
      throw new ValidateException("缺少砍价记录");
    }
    if (
      type === 3 &&
      (!Number.isSafeInteger(params.pinkId ?? 0) || !Number.isSafeInteger(params.combinationId ?? 0))
    ) {
      throw new ValidateException("拼团活动信息错误");
    }
    if (type === 4 && (carts[0]?.activityId ?? 0) <= 0) {
      throw new ValidateException("缺少积分商品信息");
    }
    if (type === 4 && params.couponId) {
      throw new ValidateException("积分商品不能使用优惠券");
    }
    let discountActivityId = 0;
    let discountPackage: ResolvedDiscountPackage | null = null;
    let discountItemByCart = new Map<string, ResolvedDiscountPackageItem>();
    if (type === 5) {
      if (carts.some((cart) => cart.cartNum !== 1 || cart.activityId <= 0)) {
        throw new ValidateException("套餐购物车信息无效");
      }
      const activityIds = new Set(carts.map((cart) => cart.activityId));
      if (activityIds.size !== 1) throw new ValidateException("套餐购物车不能混合不同套餐");
      discountActivityId = carts[0]?.activityId ?? 0;
      discountPackage = await resolveDiscountPackageSelection(c, {
        discountId: discountActivityId,
        selections: carts.map((cart) => ({
          productId: cart.productId,
          unique: cart.productAttrUnique,
        })),
        uniqueKind: "base",
      });
      discountItemByCart = new Map(
        discountPackage.items.map((item) => [
          `${item.product.id}:${item.baseSku.unique}`,
          item,
        ]),
      );
    }
    let newcomerConfig: NewcomerEligibilityConfig | null = null;
    let newcomerActivityId = 0;
    let newcomerActivitySkuId = 0;
    if (type === 7) {
      const cart = carts[0];
      if (cart.type !== 7 || cart.activityId <= 0 || cart.cartNum !== 1) {
        throw new ValidateException("新人专享购物车信息无效");
      }
      newcomerActivityId = cart.activityId;
      newcomerConfig = await loadNewcomerEligibilityConfig(c, runtime);
      if (!newcomerConfig.enabled || !newcomerConfig.priceEnabled) {
        throw new ValidateException("新人专享活动未开启");
      }
    }
    let totalNum = 0;
    let totalCents = 0;
    let bargainActivityId = 0;
    let orderSystemFormId = 0;
    let pinkCombinationId = 0;
    let integralActivityId = 0;
    let requiredIntegral = 0;
    const orderItems: OrderItem[] = [];
    const supplierIds = new Set<number>();
    for (const cart of carts) {
      const product = await c.storeProductDao.getById(cart.productId);
      if (!product) throw new NotFoundException(`商品 ${cart.productId} 不存在`);
      if (!product.isShow || product.isDel) {
        throw new ValidateException(`商品「${product.storeName}」已下架`);
      }
      if (cart.productType !== product.productType) {
        throw new ValidateException(`商品「${product.storeName}」类型已变化，请重新购买`);
      }
      let itemSystemFormId = product.systemFormId;
      const sku = await c.storeProductAttrValueDao.getByUnique(
        cart.productAttrUnique,
        0,
        product.id,
      );
      if (!sku) throw new NotFoundException(`商品规格不存在`);
      if (sku.productId !== product.id) {
        throw new ValidateException("商品规格与商品不匹配");
      }

      // 活动价 (M17: 秒杀/砍价/拼团替换 SKU 价)
      let unitPriceCents = Math.round(Number(sku.price) * 100);
      let integralActivity: typeof storeIntegral.$inferSelect | null = null;
      let activitySku: typeof storeProductAttrValue.$inferSelect | null = null;
      let discountItem: ResolvedDiscountPackageItem | null = null;
      if (type === 1 && params.seckillId) {
        const seckill = await c.db
          .select()
          .from(storeSeckill)
          .where(eq(storeSeckill.id, params.seckillId))
          .limit(1);
        if (!seckill[0] || seckill[0].status !== 1) throw new ValidateException("秒杀活动不存在或已结束");
        if (seckill[0].productId !== product.id) throw new ValidateException("秒杀商品不匹配");
        if (cart.activityId !== seckill[0].id) throw new ValidateException("秒杀购物车与活动不匹配");
        itemSystemFormId = seckill[0].systemFormId;
        if (cart.cartNum > (seckill[0].num || 99)) throw new ValidateException("超过秒杀限购数量");
        unitPriceCents = Math.round(Number(seckill[0].price) * 100);
      } else if (type === 2 && params.bargainUserId) {
        const bu = await c.db
          .select()
          .from(storeBargainUser)
          .where(and(eq(storeBargainUser.id, params.bargainUserId), eq(storeBargainUser.uid, uid)))
          .limit(1);
        if (!bu[0]) throw new ValidateException("砍价记录不存在");
        // 必须砍到最低价才能购买 (对应 PHP: status=3 表示可购买)
        if (bu[0].status !== 3) throw new ValidateException("还未砍到最低价, 请继续砍价");
        const bargain = await c.db
          .select()
          .from(storeBargain)
          .where(eq(storeBargain.id, bu[0].bargainId))
          .limit(1);
        if (!bargain[0] || bargain[0].status !== 1) {
          throw new ValidateException("砍价活动不存在或已结束");
        }
        if (bargain[0].productId !== product.id) {
          throw new ValidateException("砍价商品不匹配");
        }
        if (cart.activityId !== bargain[0].id) throw new ValidateException("砍价购物车与活动不匹配");
        itemSystemFormId = bargain[0].systemFormId;
        bargainActivityId = bargain[0].id;
        const bargainOriginalCents = Math.max(
          decimalToCents(bu[0].bargainPrice),
          decimalToCents(bargain[0].price),
        );
        const bargainMinimumCents = decimalToCents(bu[0].bargainPriceMin);
        unitPriceCents = Math.max(
          bargainMinimumCents,
          bargainOriginalCents - decimalToCents(bu[0].price),
        );
      } else if (type === 3) {
        // 参团从已有团解析活动；开团直接使用 combinationId。
        if (params.pinkId && params.pinkId > 0) {
          const pink = await c.db
            .select({ combinationId: storePink.combinationId })
            .from(storePink)
            .where(eq(storePink.id, params.pinkId))
            .limit(1);
          if (!pink[0]) throw new ValidateException("拼团信息不存在");
          pinkCombinationId = pink[0].combinationId;
        } else {
          pinkCombinationId = params.combinationId ?? 0;
        }
        if (!pinkCombinationId) throw new ValidateException("缺少拼团活动信息");
        const comboRow = await c.db
          .select()
          .from(storeCombination)
          .where(eq(storeCombination.id, pinkCombinationId))
          .limit(1);
        if (!comboRow[0] || comboRow[0].status !== 1) throw new ValidateException("拼团活动不存在或已结束");
        if (comboRow[0].productId !== product.id) throw new ValidateException("拼团商品不匹配");
        if (cart.activityId !== comboRow[0].id) throw new ValidateException("拼团购物车与活动不匹配");
        itemSystemFormId = comboRow[0].systemFormId;
        unitPriceCents = Math.round(Number(comboRow[0].price) * 100);
      } else if (type === 4) {
        integralActivityId = cart.activityId;
        const activityRows = await c.db
          .select()
          .from(storeIntegral)
          .where(eq(storeIntegral.id, integralActivityId))
          .limit(1);
        integralActivity = activityRows[0] ?? null;
        if (
          !integralActivity || integralActivity.status !== 1 ||
          integralActivity.isShow !== 1 || integralActivity.isDel !== 0
        ) {
          throw new ValidateException("积分商品不存在或已下架");
        }
        if (integralActivity.productId !== product.id) {
          throw new ValidateException("积分商品与关联商品不匹配");
        }
        activitySku = await c.storeProductAttrValueDao.getBySuk(
          integralActivity.id,
          sku.suk,
          4,
        );
        if (!activitySku) throw new ValidateException("积分商品规格已失效");
        if (integralActivity.onceNum > 0 && cart.cartNum > integralActivity.onceNum) {
          throw new ValidateException(`每个订单限购 ${integralActivity.onceNum} 件`);
        }
        const available = Math.min(
          integralActivity.stock,
          integralActivity.quota,
          activitySku.stock,
          activitySku.quota,
          sku.stock,
          product.stock,
        );
        if (available < cart.cartNum) throw new ValidateException("积分商品库存不足");
        itemSystemFormId = integralActivity.systemFormId;
        unitPriceCents = Math.round(Number(activitySku.price) * 100);
        requiredIntegral += activitySku.integral * cart.cartNum;
      } else if (type === 5) {
        discountItem = discountItemByCart.get(`${product.id}:${sku.unique}`) ?? null;
        if (
          !discountItem || discountItem.product.id !== product.id ||
          discountItem.baseSku.id !== sku.id
        ) {
          throw new ValidateException("套餐商品与购物车规格不匹配");
        }
        activitySku = discountItem.packageSku;
        unitPriceCents = discountItem.priceCents;
      } else if (type === 7) {
        const newcomerRows = await c.db
          .select()
          .from(storeNewcomer)
          .where(
            and(
              eq(storeNewcomer.id, newcomerActivityId),
              eq(storeNewcomer.productId, product.id),
              eq(storeNewcomer.isDel, 0),
            ),
          )
          .limit(1);
        if (!newcomerRows[0]) throw new ValidateException("新人专享商品已下架或删除");
        const activitySkuRows = await c.db
          .select()
          .from(storeProductAttrValue)
          .where(
            and(
              eq(storeProductAttrValue.productId, newcomerActivityId),
              eq(storeProductAttrValue.type, 7),
              eq(storeProductAttrValue.suk, sku.suk),
            ),
          )
          .limit(1);
        const activitySku = activitySkuRows[0];
        if (!activitySku) throw new ValidateException("新人专享规格已失效");
        newcomerActivitySkuId = activitySku.id;
        unitPriceCents = Math.round(Number(activitySku.price) * 100);
      }

      if (itemSystemFormId > 0) {
        if (orderSystemFormId > 0 && orderSystemFormId !== itemSystemFormId) {
          throw new ValidateException("同一订单不能包含不同的自定义表单");
        }
        orderSystemFormId = itemSystemFormId;
      }

      totalNum += cart.cartNum;
      totalCents += unitPriceCents * cart.cartNum;
      supplierIds.add(product.type === 2 ? product.relationId : 0);
      orderItems.push({
        cart,
        product,
        sku,
        activitySku,
        integralActivity,
        discountItem,
        unitPriceCents,
      });
    }
    const requiresSupplierAllocation = supplierIds.size > 1;
    const supplierId = requiresSupplierAllocation
      ? 0
      : supplierIds.values().next().value ?? 0;
    const gainIntegral = calculateProductIntegralSnapshot(
      orderItems.map(({ cart, product }) => ({
        giveIntegral: product.giveIntegral,
        quantity: cart.cartNum,
      })),
    );
    const totalCostCents = orderItems.reduce(
      (sum, { cart, sku }) => sum + decimalToCents(sku.cost) * cart.cartNum,
      0,
    );
    const productTypes = new Set(orderItems.map(({ cart }) => cart.productType));
    if (productTypes.has(1) && productTypes.size > 1) {
      throw new ValidateException("卡密商品不能与其他类型商品同单购买");
    }
    if (productTypes.has(1) && shippingType === 2) {
      throw new ValidateException("卡密商品无需到店自提");
    }
    const orderProductType = productTypes.size === 1 ? [...productTypes][0] : 0;
    if (
      type === 4 && shippingType === 1 && ![1, 2].includes(orderProductType) &&
      (!params.realName?.trim() || !params.userPhone?.trim() || !params.userAddress?.trim())
    ) {
      throw new ValidateException("请填写完整的收货人、手机号和收货地址");
    }
    const staffIds = new Set(
      orderItems.map(({ cart }) => cart.staffId).filter((staffId) => staffId > 0),
    );
    const orderStaffId = staffIds.size === 1 ? [...staffIds][0] : 0;
    const merIds = new Set(
      orderItems.map(({ product }) => product.merId).filter((merId) => merId > 0),
    );
    const orderMerId = merIds.size === 1 ? [...merIds][0] : 0;

    const user = await c.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户不存在");
    const firstOrderConfig: FirstOrderDiscountConfig = type === 0
      ? await loadFirstOrderDiscountConfig(c, runtime)
      : { enabled: false, limitEnabled: true, limitDays: 0, payPercent: 100, limitCents: 0 };
    const preliminaryNow = Math.floor(Date.now() / 1000);
    const preliminaryFirstOrderEligible = firstOrderAccountEligible(
      user,
      firstOrderConfig,
      preliminaryNow,
    ) && !(await hasPaidNonNewcomerOrder(c.db, uid));
    let firstOrderPriceCents = preliminaryFirstOrderEligible
      ? calculateFirstOrderDiscountCents(totalCents, firstOrderConfig)
      : 0;

    // PHP 的首单优惠优先于且排斥优惠券/营销活动；首单资格成立时不校验客户端券。
    let couponResolution = preliminaryFirstOrderEligible
      ? { priceCents: 0, row: null }
      : await resolveOrderCoupon(c, uid, params.couponId, orderItems);
    let couponPriceCents = couponResolution.priceCents;
    let couponRow = couponResolution.row;

    // 3. 订单号 (生产环境由 SequenceDO 提供；集成场景注入隔离生成器)
    const orderId = (await runtime.nextOrderId()).trim();
    if (!orderId) throw new Error("订单号生成失败");

    // 4. 积分抵扣 (可选, 对应 PHP deductIntegral)
    const useIntegral = params.useIntegral ?? 0;
    if (!Number.isSafeInteger(useIntegral) || useIntegral < 0) {
      throw new ValidateException("抵扣积分必须是非负整数");
    }
    if (type === 4 && useIntegral > 0) {
      throw new ValidateException("积分商品不能叠加普通订单积分抵扣");
    }
    if (type === 4 && user.integral < requiredIntegral) {
      throw new ValidateException(`积分不足, 需要 ${requiredIntegral} 积分`);
    }
    let deductionCents = 0;
    if (useIntegral > 0) {
      if (user.integral < useIntegral) throw new ValidateException("积分不足");
      // 简化: 100 积分 = 1 元 (实际从 system_config 读比例, M4 补)
      deductionCents = Math.min(
        useIntegral * 1,
        Math.max(0, totalCents - couponPriceCents - firstOrderPriceCents),
      );
    }
    let usedIntegralPoints = deductionCents;

    // 4c. 运费计算: 快递按商品 freight 规则和目的地费率计费；自提不收运费。
    let postageCents = 0;
    const postageExempt = orderItems.every(({ product }) => [1, 2].includes(product.productType));
    if (
      shippingType === 1 && !postageExempt &&
      !(type === 5 && discountPackage?.discount.freeShipping === 1)
    ) {
      const templateIds = Array.from(
        new Set(
          orderItems
            .map(({ product, integralActivity }) => {
              const tempId = integralActivity?.tempId ?? product.tempId;
              return tempId > 0 ? tempId : 1;
            }),
        ),
      );
      const templateRows = templateIds.length
        ? await c.db
            .select({
              id: shippingTemplates.id,
              type: shippingTemplates.type,
              appoint: shippingTemplates.appoint,
              noDelivery: shippingTemplates.noDelivery,
            })
            .from(shippingTemplates)
            .where(
              and(
                inArray(shippingTemplates.id, templateIds),
                eq(shippingTemplates.status, 1),
                eq(shippingTemplates.isDel, 0),
              ),
            )
        : [];
      const regionRows = templateIds.length
        ? await c.db
            .select({
              id: shippingTemplatesRegion.id,
              templateId: shippingTemplatesRegion.templateId,
              regionId: shippingTemplatesRegion.regionId,
              regionName: shippingTemplatesRegion.regionName,
              first: shippingTemplatesRegion.first,
              firstPrice: shippingTemplatesRegion.firstPrice,
              continue: shippingTemplatesRegion.continue,
              continuePrice: shippingTemplatesRegion.continuePrice,
            })
            .from(shippingTemplatesRegion)
            .where(inArray(shippingTemplatesRegion.templateId, templateIds))
        : [];
      const freeRows = templateIds.length
        ? await c.db
            .select({
              id: shippingTemplatesFree.id,
              tempId: shippingTemplatesFree.tempId,
              provinceId: shippingTemplatesFree.provinceId,
              cityId: shippingTemplatesFree.cityId,
              number: shippingTemplatesFree.number,
              price: shippingTemplatesFree.price,
              value: shippingTemplatesFree.value,
            })
            .from(shippingTemplatesFree)
            .where(inArray(shippingTemplatesFree.tempId, templateIds))
        : [];
      const noDeliveryRows = templateIds.length
        ? await c.db
            .select({
              id: shippingTemplatesNoDelivery.id,
              tempId: shippingTemplatesNoDelivery.tempId,
              provinceId: shippingTemplatesNoDelivery.provinceId,
              cityId: shippingTemplatesNoDelivery.cityId,
              value: shippingTemplatesNoDelivery.value,
            })
            .from(shippingTemplatesNoDelivery)
            .where(inArray(shippingTemplatesNoDelivery.tempId, templateIds))
        : [];
      const cityRows = params.cityId && params.cityId > 0
        ? await c.db
            .select({ path: cityArea.path })
            .from(cityArea)
            .where(eq(cityArea.id, params.cityId))
            .limit(1)
        : [];
      try {
        const regionIds = expandShippingRegionIds(params.cityId, cityRows[0]?.path);
        postageCents = calculateOrderPostageCents(
          orderItems.map(({ cart, product, sku, integralActivity, unitPriceCents }) => ({
            freight: integralActivity?.freight ?? product.freight,
            postage: integralActivity?.postage ?? product.postage,
            tempId: integralActivity?.tempId ?? product.tempId,
            quantity: cart.cartNum,
            unitPrice: (unitPriceCents / 100).toFixed(2),
            weight: sku.weight,
            volume: sku.volume,
          })),
          templateRows,
          regionRows,
          { cityId: params.cityId, province: params.province, regionIds },
          freeRows,
          noDeliveryRows,
        );
      } catch (error) {
        if (error instanceof ShippingConfigurationError) {
          throw new ValidateException(error.message);
        }
        throw error;
      }
    }
    let payCents = Math.max(
      0,
      totalCents - couponPriceCents - firstOrderPriceCents - deductionCents + postageCents,
    );
    let actualProductCents = Math.max(0, payCents - postageCents);
    let brokerage = await buildOrderBrokerageSnapshot(c, runtime, {
      orderType: type,
      buyer: user,
      actualProductCents,
      items: orderItems.map(({ cart, product, sku, unitPriceCents }) => ({
        grossCents: unitPriceCents * cart.cartNum,
        costCents: decimalToCents(sku.cost) * cart.cartNum,
        quantity: cart.cartNum,
        specified: product.isSub === 1,
        specifiedOneCents: decimalToCents(sku.brokerage),
        specifiedTwoCents: decimalToCents(sku.brokerageTwo),
      })),
    });

    // 4b. 拼团: 开团/参团团信息 (事务内处理人数, 这里预取组合 ID)
    if (type === 3) {
      if (!pinkCombinationId) throw new ValidateException("缺少拼团活动信息");
    }

    // 5. 事务 (ACID): 订单 + 库存 + 快照 + 积分
    const orderRow = await withTx(c, async (tx) => {
      // 同一用户/幂等键必须在事务内串行化并复查。仅依赖唯一索引会把
      // 并发重试暴露为数据库异常，而不是返回第一次创建的订单。
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`cinashop:create-order:${uid}:${key}`}, 0::bigint)
        )
      `);
      const concurrentExistingRows = await tx
        .select()
        .from(storeOrder)
        .where(and(eq(storeOrder.uid, uid), eq(storeOrder.unique, key)))
        .limit(1);
      if (concurrentExistingRows[0]) return concurrentExistingRows[0];

      const now = Math.floor(Date.now() / 1000);
      if (preliminaryFirstOrderEligible) {
        // 不同幂等键也必须按用户串行化首单资格。资格、订单和消费标记同事务提交，
        // 因此库存/快照等后续步骤失败时不会永久吃掉首单优惠。
        const lockedUsers = await tx
          .select()
          .from(userTable)
          .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
          .limit(1)
          .for("update");
        const lockedUser = lockedUsers[0];
        if (!lockedUser) throw new NotFoundException("用户不存在");
        const finalFirstOrderEligible = firstOrderAccountEligible(
          lockedUser,
          firstOrderConfig,
          now,
        ) && !(await hasPaidNonNewcomerOrder(tx, uid));

        if (!finalFirstOrderEligible) {
          couponResolution = await resolveOrderCoupon(
            createContainerFromDb(tx),
            uid,
            params.couponId,
            orderItems,
          );
          couponPriceCents = couponResolution.priceCents;
          couponRow = couponResolution.row;
          firstOrderPriceCents = 0;
          if (useIntegral > 0 && lockedUser.integral < useIntegral) {
            throw new ValidateException("积分不足");
          }
          deductionCents = useIntegral > 0
            ? Math.min(useIntegral, Math.max(0, totalCents - couponPriceCents))
            : 0;
          usedIntegralPoints = deductionCents;
          payCents = Math.max(
            0,
            totalCents - couponPriceCents - deductionCents + postageCents,
          );
          actualProductCents = Math.max(0, payCents - postageCents);
          brokerage = await buildOrderBrokerageSnapshot(createContainerFromDb(tx), runtime, {
            orderType: type,
            buyer: lockedUser,
            actualProductCents,
            items: orderItems.map(({ cart, product, sku, unitPriceCents }) => ({
              grossCents: unitPriceCents * cart.cartNum,
              costCents: decimalToCents(sku.cost) * cart.cartNum,
              quantity: cart.cartNum,
              specified: product.isSub === 1,
              specifiedOneCents: decimalToCents(sku.brokerage),
              specifiedTwoCents: decimalToCents(sku.brokerageTwo),
            })),
          });
        } else if (firstOrderPriceCents > 0) {
          const consumed = await tx
            .update(userTable)
            .set({ isFirstOrder: 1 })
            .where(and(eq(userTable.uid, uid), eq(userTable.isFirstOrder, 0)))
            .returning({ uid: userTable.uid });
          if (!consumed.length) throw new ValidateException("首单优惠资格已被使用");
        }
      }
      let verifyCode = "";
      if (shippingType === 2) {
        const stores = await tx
          .select({ id: systemStore.id })
          .from(systemStore)
          .where(and(
            eq(systemStore.id, pickupStoreId),
            eq(systemStore.isStore, 1),
            eq(systemStore.isShow, 1),
            eq(systemStore.isDel, 0),
          ))
          .limit(1)
          .for("key share");
        if (!stores[0]) throw new ValidateException("自提门店不存在或已暂停营业");
        verifyCode = await generatePickupVerifyCode(tx);
      }
      const preparedSystemForm = await loadOrderSystemFormSubmission(
        tx,
        orderSystemFormId,
        params.customForm,
        uid,
      );

      // PHP 在订单创建事件中立即消耗新人资格（不是支付后）。这里先锁用户，
      // 再复查历史已付订单并原子置为已使用，阻断不同购物车的并发双下单。
      if (type === 7) {
        if (!newcomerConfig?.enabled || !newcomerConfig.priceEnabled) {
          throw new ValidateException("新人专享活动未开启");
        }
        const newcomerUsers = await tx
          .select({
            uid: userTable.uid,
            addTime: userTable.addTime,
            isNewcomer: userTable.isNewcomer,
          })
          .from(userTable)
          .where(eq(userTable.uid, uid))
          .limit(1)
          .for("update");
        const newcomerUser = newcomerUsers[0];
        if (!newcomerUser || newcomerUser.isNewcomer !== 0) {
          throw new ValidateException("您已无法享受新人专享价");
        }
        if (
          newcomerConfig.limitEnabled &&
          newcomerConfig.limitDays > 0 &&
          newcomerUser.addTime + newcomerConfig.limitDays * 86_400 < now
        ) {
          throw new ValidateException("新人专享资格已过期");
        }
        const previousPaid = await tx
          .select({ id: storeOrder.id })
          .from(storeOrder)
          .where(and(eq(storeOrder.uid, uid), eq(storeOrder.type, 7), eq(storeOrder.paid, 1)))
          .limit(1);
        if (previousPaid.length) throw new ValidateException("您已无法享受新人专享价");

        const lockedNewcomer = await tx
          .select({ id: storeNewcomer.id, productId: storeNewcomer.productId })
          .from(storeNewcomer)
          .where(
            and(
              eq(storeNewcomer.id, newcomerActivityId),
              eq(storeNewcomer.isDel, 0),
            ),
          )
          .limit(1)
          .for("update");
        if (!lockedNewcomer[0] || lockedNewcomer[0].productId !== orderItems[0]?.product.id) {
          throw new ValidateException("新人专享商品已下架或删除");
        }
        const lockedActivitySku = await tx
          .select({ id: storeProductAttrValue.id, price: storeProductAttrValue.price })
          .from(storeProductAttrValue)
          .where(
            and(
              eq(storeProductAttrValue.id, newcomerActivitySkuId),
              eq(storeProductAttrValue.productId, newcomerActivityId),
              eq(storeProductAttrValue.type, 7),
              eq(storeProductAttrValue.suk, orderItems[0]?.sku.suk ?? ""),
            ),
          )
          .limit(1)
          .for("update");
        if (
          !lockedActivitySku[0] ||
          Math.round(Number(lockedActivitySku[0].price) * 100) !== orderItems[0]?.unitPriceCents
        ) {
          throw new ValidateException("新人专享价格已变化，请刷新后重试");
        }
        const consumed = await tx
          .update(userTable)
          .set({ isNewcomer: 1 })
          .where(and(eq(userTable.uid, uid), eq(userTable.isNewcomer, 0)))
          .returning({ uid: userTable.uid });
        if (!consumed.length) throw new ValidateException("新人专享资格已被使用");
      }

      if (type === 5) {
        if (!discountPackage || !discountActivityId) {
          throw new ValidateException("套餐信息无效");
        }
        const lockedPackage = await resolveDiscountPackageSelection(createContainerFromDb(tx), {
          discountId: discountActivityId,
          selections: carts.map((cart) => ({
            productId: cart.productId,
            unique: cart.productAttrUnique,
          })),
          uniqueKind: "base",
          lockRows: true,
          now,
        });
        if (
          lockedPackage.discount.type !== discountPackage.discount.type ||
          lockedPackage.discount.freeShipping !== discountPackage.discount.freeShipping ||
          lockedPackage.discount.isSupportRefund !== discountPackage.discount.isSupportRefund
        ) {
          throw new ValidateException("套餐规则已变化，请刷新后重试");
        }
        const lockedByCart = new Map(
          lockedPackage.items.map((item) => [
            `${item.product.id}:${item.baseSku.unique}`,
            item,
          ]),
        );
        for (const item of orderItems) {
          const lockedItem = lockedByCart.get(
            `${item.product.id}:${item.sku.unique}`,
          );
          if (
            !lockedItem || lockedItem.baseSku.id !== item.sku.id ||
            lockedItem.packageSku.id !== item.discountItem?.packageSku.id ||
            lockedItem.priceCents !== item.unitPriceCents
          ) {
            throw new ValidateException("套餐价格或规格已变化，请刷新后重试");
          }
        }
        if (lockedPackage.discount.isLimit === 1) {
          const reserved = await tx
            .update(storeDiscounts)
            .set({ limitNum: sql`limit_num - 1` })
            .where(
              and(
                eq(storeDiscounts.id, discountActivityId),
                eq(storeDiscounts.status, 1),
                eq(storeDiscounts.isDel, 0),
                eq(storeDiscounts.isLimit, 1),
                sql`limit_num > 0`,
              ),
            )
            .returning({ id: storeDiscounts.id });
          if (!reserved.length) throw new ValidateException("套餐已售罄");
        }
      }

      // 同一批购物车只能被一个事务认领，不同 key 的并发请求也无法重复扣库存。
      const claimedCarts = await tx
        .update(storeCart)
        .set({ isPay: 1 })
        .where(
          and(
            inArray(storeCart.id, cartIds),
            eq(storeCart.uid, uid),
            eq(storeCart.isPay, 0),
            eq(storeCart.isDel, 0),
            eq(storeCart.status, 1),
          ),
        )
        .returning({ id: storeCart.id });
      if (claimedCarts.length !== cartIds.length) {
        throw new ValidateException("购物车商品已被其他订单占用");
      }

      // 5a0. 活动库存与拼团团 (M17: 事务内保证一致)
      let finalPinkId = 0;
      if (type === 1 && params.seckillId) {
        // 秒杀: 扣活动 quota (守卫)
        const sk = await tx
          .update(storeSeckill)
          .set({
            quota: sql`quota - ${totalNum}`,
            stock: sql`stock - ${totalNum}`,
            sales: sql`sales + ${totalNum}`,
          })
          .where(
            and(
              eq(storeSeckill.id, params.seckillId),
              eq(storeSeckill.status, 1),
              eq(storeSeckill.isShow, 1),
              eq(storeSeckill.isDel, 0),
              sql`(${storeSeckill.startTime} IS NULL OR ${storeSeckill.startTime} <= NOW())`,
              sql`(${storeSeckill.stopTime} IS NULL OR ${storeSeckill.stopTime} >= NOW())`,
              sql`quota >= ${totalNum}`,
              sql`stock >= ${totalNum}`,
            ),
          )
          .returning({ id: storeSeckill.id });
        if (!sk.length) throw new ValidateException("秒杀库存不足");
      } else if (type === 2 && params.bargainUserId) {
        // 砍价: 扣活动库存 + 标记记录已购买 (status=4)
        const bargain = await tx
          .update(storeBargain)
          .set({ quota: sql`quota - 1`, stock: sql`stock - 1`, sales: sql`sales + 1` })
          .where(
            and(
              eq(storeBargain.id, bargainActivityId),
              eq(storeBargain.status, 1),
              eq(storeBargain.isDel, 0),
              sql`(${storeBargain.startTime} IS NULL OR ${storeBargain.startTime} <= NOW())`,
              sql`(${storeBargain.stopTime} IS NULL OR ${storeBargain.stopTime} >= NOW())`,
              sql`quota >= 1`,
              sql`stock >= 1`,
            ),
          )
          .returning({ id: storeBargain.id });
        if (!bargain.length) throw new ValidateException("砍价活动库存不足");
        const bargainUser = await tx
          .update(storeBargainUser)
          .set({ status: 4 })
          .where(
            and(
              eq(storeBargainUser.id, params.bargainUserId),
              eq(storeBargainUser.uid, uid),
              eq(storeBargainUser.status, 3),
            ),
          )
          .returning({ id: storeBargainUser.id });
        if (!bargainUser.length) throw new ValidateException("砍价记录已被使用");
      } else if (type === 3) {
        // 拼团: 扣活动库存 (守卫)
        const comb = await tx
          .update(storeCombination)
          .set({
            quota: sql`quota - ${totalNum}`,
            stock: sql`stock - ${totalNum}`,
            sales: sql`sales + ${totalNum}`,
          })
          .where(
            and(
              eq(storeCombination.id, pinkCombinationId),
              eq(storeCombination.status, 1),
              eq(storeCombination.isShow, 1),
              eq(storeCombination.isDel, 0),
              sql`(${storeCombination.startTime} IS NULL OR ${storeCombination.startTime} <= NOW())`,
              sql`(${storeCombination.stopTime} IS NULL OR ${storeCombination.stopTime} >= NOW())`,
              sql`quota >= ${totalNum}`,
              sql`stock >= ${totalNum}`,
            ),
          )
          .returning({ id: storeCombination.id });
        if (!comb.length) throw new ValidateException("拼团库存不足");

        const comboRow = await tx
          .select()
          .from(storeCombination)
          .where(eq(storeCombination.id, pinkCombinationId))
          .limit(1);
        if (!comboRow[0]) throw new ValidateException("拼团活动不存在");
        // PHP 在下单时只预占 Redis 名额，store_pink 团员记录在支付后创建。
        // PostgreSQL 以未支付订单本身作为可恢复的预占记录，并在团长行上串行化容量检查。
        finalPinkId = params.pinkId ?? 0;
        if (finalPinkId > 0) {
          await reservePinkJoin(tx, {
            uid,
            leaderId: finalPinkId,
            combinationId: pinkCombinationId,
          });
        }
      } else if (type === 4) {
        const item = orderItems[0];
        if (!item?.integralActivity || !item.activitySku || !integralActivityId) {
          throw new ValidateException("积分商品规格信息无效");
        }
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`cinashop:integral-order:${uid}:${integralActivityId}`}, 0::bigint)
          )
        `);
        const lockedUsers = await tx
          .select({ integral: userTable.integral })
          .from(userTable)
          .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
          .limit(1)
          .for("update");
        if (!lockedUsers[0]) throw new NotFoundException("用户不存在");
        if (lockedUsers[0].integral < requiredIntegral) {
          throw new ValidateException(`积分不足, 需要 ${requiredIntegral} 积分`);
        }
        if (item.integralActivity.num > 0) {
          const purchaseRows = await tx
            .select({ total: sql<number>`COALESCE(SUM(${storeOrder.totalNum}), 0)::int` })
            .from(storeOrder)
            .where(
              and(
                eq(storeOrder.uid, uid),
                eq(storeOrder.type, 4),
                eq(storeOrder.activityId, integralActivityId),
                inArray(storeOrder.pid, [0, -1]),
                or(
                  eq(storeOrder.paid, 1),
                  and(eq(storeOrder.paid, 0), eq(storeOrder.isDel, 0)),
                ),
              ),
            );
          if ((purchaseRows[0]?.total ?? 0) + totalNum > item.integralActivity.num) {
            throw new ValidateException(`每人累计限购 ${item.integralActivity.num} 件`);
          }
        }
        const activityUpdated = await tx
          .update(storeIntegral)
          .set({
            stock: sql`stock - ${totalNum}`,
            quota: sql`quota - ${totalNum}`,
            sales: sql`sales + ${totalNum}`,
          })
          .where(
            and(
              eq(storeIntegral.id, integralActivityId),
              eq(storeIntegral.productId, item.product.id),
              eq(storeIntegral.status, 1),
              eq(storeIntegral.isShow, 1),
              eq(storeIntegral.isDel, 0),
              sql`stock >= ${totalNum}`,
              sql`quota >= ${totalNum}`,
            ),
          )
          .returning({ id: storeIntegral.id });
        if (!activityUpdated.length) throw new ValidateException("积分商品库存不足");

        const activitySkuUpdated = await tx
          .update(storeProductAttrValue)
          .set({
            stock: sql`stock - ${totalNum}`,
            quota: sql`quota - ${totalNum}`,
            sales: sql`sales + ${totalNum}`,
          })
          .where(
            and(
              eq(storeProductAttrValue.id, item.activitySku.id),
              eq(storeProductAttrValue.productId, integralActivityId),
              eq(storeProductAttrValue.type, 4),
              sql`stock >= ${totalNum}`,
              sql`quota >= ${totalNum}`,
            ),
          )
          .returning({ id: storeProductAttrValue.id });
        if (!activitySkuUpdated.length) throw new ValidateException("积分商品规格库存不足");
      }

      // 5a. INSERT 订单 (unique(uid,unique) 约束兜底)
      const orderInsert = await tx
        .insert(storeOrder)
        .values({
          type,
          orderId,
          uid,
          supplierId,
          supplierAllocationStatus: requiresSupplierAllocation ? 1 : 0,
          storeId: pickupStoreId,
          realName: params.realName ?? "",
          userPhone: params.userPhone ?? "",
          province: params.province ?? "",
          userAddress: params.userAddress ?? "",
          cartId: cartIds.join(","),
          totalNum,
          totalPrice: (totalCents / 100).toFixed(2),
          totalPostage: (postageCents / 100).toFixed(2),
          payPrice: (payCents / 100).toFixed(2),
          deductionPrice: (deductionCents / 100).toFixed(2),
          firstOrderPrice: (firstOrderPriceCents / 100).toFixed(2),
          payPostage: (postageCents / 100).toFixed(2),
          payIntegral: requiredIntegral,
          shippingType,
          verifyCode,
          useIntegral: usedIntegralPoints.toFixed(2),
          gainIntegral: String(gainIntegral),
          cost: (totalCostCents / 100).toFixed(2),
          productType: orderProductType,
          staffId: orderStaffId,
          merId: orderMerId,
          spreadUid: brokerage.spreadUid,
          spreadTwoUid: brokerage.spreadTwoUid,
          oneBrokerage: (brokerage.oneBrokerageCents / 100).toFixed(2),
          twoBrokerage: (brokerage.twoBrokerageCents / 100).toFixed(2),
          divisionId: brokerage.divisionId,
          divisionBrokerage: (brokerage.divisionBrokerageCents / 100).toFixed(2),
          divisionAgentId: brokerage.divisionAgentId,
          divisionAgentBrokerage: (brokerage.divisionAgentBrokerageCents / 100).toFixed(2),
          divisionStaffId: brokerage.divisionStaffId,
          divisionStaffBrokerage: (brokerage.divisionStaffBrokerageCents / 100).toFixed(2),
          customForm: preparedSystemForm?.snapshotJson ?? "[]",
          mark: params.mark ?? "",
          paid: 0,
          status: 0,
          unique: key,
          addTime: now,
          userIp: params.userIp,
          // M17: 活动/优惠券字段
          couponId: couponRow?.id ?? 0,
          couponPrice: (couponPriceCents / 100).toFixed(2),
          pinkId: finalPinkId,
          activityId: type === 1
            ? (params.seckillId ?? 0)
            : type === 2
              ? bargainActivityId
              : type === 3
                ? pinkCombinationId
                 : type === 4
                   ? integralActivityId
                  : type === 5
                    ? discountActivityId
                   : type === 7
                     ? newcomerActivityId
                    : 0,
        })
        .returning();
      const order = orderInsert[0];
      if (!order) throw new Error("订单插入失败");
      await collectOrderSystemForm(tx, preparedSystemForm, uid, order.id, now);

      const itemGrossCents = orderItems.map(({ cart, unitPriceCents }) =>
        cart.cartNum * unitPriceCents
      );
      const couponAllocations = allocateLegacyDiscountCents(couponPriceCents, itemGrossCents);
      const firstOrderAllocations = allocateLegacyDiscountCents(firstOrderPriceCents, itemGrossCents);
      const deductionAllocations = allocateLegacyDiscountCents(deductionCents, itemGrossCents);

      // 5b. 库存扣减 (关键: WHERE stock>=n 守卫, 修复 PHP 超卖 bug)
      for (const [itemIndex, item] of orderItems.entries()) {
        const {
          cart,
          product,
          sku,
          activitySku,
          integralActivity,
          discountItem,
          unitPriceCents,
        } = item;
        // SKU 库存 — 守卫失败抛异常, 事务回滚
        const skuUpdated = await tx
          .update(storeProductAttrValue)
          .set({
            stock: sql`stock - ${cart.cartNum}`,
            sales: sql`sales + ${cart.cartNum}`,
          })
          .where(and(eq(storeProductAttrValue.id, sku.id), sql`stock >= ${cart.cartNum}`))
          .returning({ id: storeProductAttrValue.id });
        if (!skuUpdated.length) {
          throw new ValidateException(`商品「${product.storeName}」库存不足`);
        }

        // 主商品库存 (也带守卫)
        const productUpdated = await tx
          .update(storeProduct)
          .set({
            stock: sql`stock - ${cart.cartNum}`,
            sales: sql`sales + ${cart.cartNum}`,
          })
          .where(and(eq(storeProduct.id, product.id), sql`stock >= ${cart.cartNum}`))
          .returning({ id: storeProduct.id });
        if (!productUpdated.length) {
          throw new ValidateException(`商品「${product.storeName}」总库存不足`);
        }

        // 5c. 订单商品快照
        const lineGrossCents = itemGrossCents[itemIndex];
        const lineCouponCents = couponAllocations[itemIndex];
        const lineFirstOrderCents = firstOrderAllocations[itemIndex];
        const lineDeductionCents = deductionAllocations[itemIndex];
        const lineNetCents = Math.max(
          0,
          lineGrossCents - lineCouponCents - lineFirstOrderCents - lineDeductionCents,
        );
        const cartInfoJson = JSON.stringify({
          coupon_price: (lineCouponCents / 100).toFixed(2),
          integral_price: (lineDeductionCents / 100).toFixed(2),
          first_order_price: (lineFirstOrderCents / 100).toFixed(2),
          sum_true_price: (lineNetCents / 100).toFixed(2),
          product: {
            id: product.id,
            activityId: integralActivity?.id ?? 0,
            storeName: discountItem?.entry.title || integralActivity?.storeName || product.storeName,
            image: activitySku?.image || integralActivity?.image || product.image,
            giveIntegral: String(product.giveIntegral),
            integral: activitySku?.integral ?? 0,
          },
          sku: {
            id: sku.id,
            unique: sku.unique,
            suk: sku.suk,
            price: (unitPriceCents / 100).toFixed(2),
          },
          activitySku: activitySku
            ? {
                id: activitySku.id,
                unique: activitySku.unique,
                suk: activitySku.suk,
                price: String(activitySku.price),
                integral: activitySku.integral,
              }
            : null,
          discount: discountItem && discountPackage
            ? {
                id: discountPackage.discount.id,
                entryId: discountItem.entry.id,
                type: discountPackage.discount.type,
                freeShipping: discountPackage.discount.freeShipping,
                isSupportRefund: discountPackage.discount.isSupportRefund,
              }
            : null,
        });
        const writeTimes = Math.max(sku.writeTimes, 1) * cart.cartNum;
        await tx.insert(storeOrderCartInfo).values({
          uid,
          oid: order.id,
          cartId: String(cart.id),
          type: product.type,
          relationId: product.relationId,
          productId: cart.productId,
          productType: cart.productType,
          skuUnique: cart.productAttrUnique,
          cartNum: cart.cartNum,
          surplusNum: cart.cartNum,
          splitSurplusNum: cart.cartNum,
          settlePrice: String(activitySku?.settlePrice || sku.settlePrice || product.settlePrice),
          promotionsId: null,
          writeTimes,
          writeSurplusTimes: writeTimes,
          writeStart: sku.writeStart,
          writeEnd: sku.writeEnd,
          cartInfo: cartInfoJson,
          unique: crypto.randomUUID().replaceAll("-", ""),
          isSupportRefund: type === 5
            ? (discountPackage?.discount.isSupportRefund ?? 0)
            : product.isSupportRefund,
          addTime: now,
        });
      }

      // Persist the PHP "下单后打印" intent atomically with the order and its
      // cart snapshots. No provider or Queue call is made inside this transaction.
      await enqueueAutomaticReceiptPrintJobs(tx, [order], "created", now);

      // 5d. 积分扣减 + 账单
      if (usedIntegralPoints > 0) {
        const integralUpdated = await tx
          .update(userTable)
          .set({ integral: sql`integral - ${usedIntegralPoints}` })
          .where(and(eq(userTable.uid, uid), sql`integral >= ${usedIntegralPoints}`))
          .returning({ integral: userTable.integral });
        if (!integralUpdated.length) {
          throw new ValidateException("积分不足 (并发冲突)");
        }
        await tx.insert(userBill).values({
          uid,
          linkId: String(order.id),
          pm: 0,
          title: "购买商品",
          category: "integral",
          type: "deduction",
          eventKey: "order_integral_deduction",
          number: usedIntegralPoints.toFixed(2),
          balance: String(integralUpdated[0].integral),
          mark: `下单抵扣, 订单号 ${orderId}`,
          status: 1,
          addTime: now,
        });
      }

      // 下单时先占用优惠券，避免多个未支付订单同时享受同一张券。
      if (couponRow) {
        const reserved = await tx
          .update(storeCouponUser)
          .set({ status: 3, useTime: null })
          .where(
            and(
              eq(storeCouponUser.id, couponRow.id),
              eq(storeCouponUser.uid, uid),
              eq(storeCouponUser.status, 0),
            ),
          )
          .returning({ id: storeCouponUser.id });
        if (!reserved.length) throw new ValidateException("优惠券已被其他订单占用");
      }

      return order;
    });

    return { orderId: orderRow.orderId, key };
  }

  /** 事务包装器 (类型安全, tx 与 db 同构但无 $client) */
  private async runInTx<T>(
    db: DbClient,
    fn: (tx: DbClient) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => fn(tx as unknown as DbClient));
  }

  /** 订单列表 */
  async list(
    uid: number,
    opts: { type?: number; status?: number; paid?: number; page?: number; limit?: number },
  ) {
    const page = Math.max(1, Math.trunc(opts.page ?? 1));
    const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 10), 100));
    const conditions = [
      eq(storeOrder.uid, uid),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
      sql`${storeOrder.pid} <> -1`,
    ];
    if (opts.type !== undefined) conditions.push(eq(storeOrder.type, opts.type));
    if (opts.paid !== undefined) conditions.push(eq(storeOrder.paid, opts.paid));
    if (opts.status !== undefined) {
      switch (opts.status) {
        case 0:
          conditions.push(
            eq(storeOrder.paid, 0),
            eq(storeOrder.status, 0),
            eq(storeOrder.refundStatus, 0),
          );
          break;
        case 1:
          conditions.push(
            eq(storeOrder.paid, 1),
            inArray(storeOrder.status, [0, 4]),
            inArray(storeOrder.refundStatus, [0, 3]),
            inArray(storeOrder.shippingType, [1, 3]),
          );
          break;
        case 2:
          conditions.push(
            eq(storeOrder.paid, 1),
            or(
              and(inArray(storeOrder.status, [1, 5]), eq(storeOrder.shippingType, 1)),
              and(inArray(storeOrder.status, [0, 5]), eq(storeOrder.shippingType, 2)),
            )!,
            inArray(storeOrder.refundStatus, [0, 3]),
          );
          break;
        case 3:
          conditions.push(
            eq(storeOrder.paid, 1),
            eq(storeOrder.status, 2),
            inArray(storeOrder.refundStatus, [0, 3]),
          );
          break;
        case 4:
          conditions.push(
            eq(storeOrder.paid, 1),
            eq(storeOrder.status, 3),
            inArray(storeOrder.refundStatus, [0, 3]),
          );
          break;
        default:
          throw new ValidateException("订单状态筛选无效");
      }
    }
    const orders = await this.container.db
      .select()
      .from(storeOrder)
      .where(and(...conditions))
      .orderBy(desc(storeOrder.addTime), desc(storeOrder.id))
      .limit(limit)
      .offset((page - 1) * limit);
    if (!orders.length) return [];
    const cartRows = await this.container.db
      .select()
      .from(storeOrderCartInfo)
      .where(inArray(storeOrderCartInfo.oid, orders.map((order) => order.id)))
      .orderBy(storeOrderCartInfo.id);
    const cartsByOrder = new Map<number, Array<Record<string, unknown>>>();
    for (const cart of cartRows) {
      const list = cartsByOrder.get(cart.oid) ?? [];
      list.push({ ...cart, cartInfo: parseCartSnapshot(cart.cartInfo) });
      cartsByOrder.set(cart.oid, list);
    }
    return orders.map((order) => ({
      ...order,
      // 卡密只在经过订单归属校验的详情接口返回，避免列表接口批量暴露。
      virtualInfo: null,
      cartInfo: cartsByOrder.get(order.id) ?? [],
    }));
  }

  /** 订单详情 */
  async detail(uid: number, orderId: string) {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid || order.isDel !== 0 || order.isSystemDel !== 0) {
      throw new NotFoundException("订单不存在");
    }
    const cartInfos = await this.container.storeOrderCartInfoDao.getByOid(order.id);
    const splitOrders =
      order.pid === -1
        ? await this.container.db
            .select()
            .from(storeOrder)
            .where(
              and(
                eq(storeOrder.pid, order.id),
                eq(storeOrder.uid, uid),
                eq(storeOrder.isDel, 0),
              ),
            )
            .orderBy(storeOrder.id)
        : [];
    const splitCartRows = splitOrders.length
      ? await this.container.db
          .select()
          .from(storeOrderCartInfo)
          .where(inArray(storeOrderCartInfo.oid, splitOrders.map((child) => child.id)))
          .orderBy(storeOrderCartInfo.id)
      : [];
    const splitCartsByOrder = new Map<number, Array<Record<string, unknown>>>();
    for (const cart of splitCartRows) {
      const list = splitCartsByOrder.get(cart.oid) ?? [];
      list.push({ ...cart, cartInfo: parseCartSnapshot(cart.cartInfo) });
      splitCartsByOrder.set(cart.oid, list);
    }
    const [economizeRows, invoiceRows, promotionsDetail, writeoffRecords, pinkRows, pickupStoreRows] = await Promise.all([
      this.container.db
        .select()
        .from(storeOrderEconomize)
        .where(
          and(
            eq(storeOrderEconomize.orderId, order.orderId),
            eq(storeOrderEconomize.uid, uid),
          ),
        )
        .orderBy(desc(storeOrderEconomize.id))
        .limit(1),
      this.container.db
        .select()
        .from(storeOrderInvoice)
        .where(
          and(
            eq(storeOrderInvoice.orderId, order.id),
            eq(storeOrderInvoice.uid, uid),
            eq(storeOrderInvoice.isDel, 0),
          ),
        )
        .orderBy(desc(storeOrderInvoice.id))
        .limit(1),
      this.container.db
        .select({ allocation: storeOrderPromotions, promotion: storePromotions })
        .from(storeOrderPromotions)
        .leftJoin(storePromotions, eq(storePromotions.id, storeOrderPromotions.promotionsId))
        .where(eq(storeOrderPromotions.oid, order.id))
        .orderBy(storeOrderPromotions.id),
      this.container.db
        .select()
        .from(storeOrderWriteoff)
        .where(eq(storeOrderWriteoff.oid, order.id))
        .orderBy(desc(storeOrderWriteoff.addTime), desc(storeOrderWriteoff.id)),
      order.type === 3 && order.pinkId > 0
        ? this.container.db
            .select()
            .from(storePink)
            .where(eq(storePink.id, order.pinkId))
            .limit(1)
        : Promise.resolve([]),
      order.shippingType === 2 && order.storeId > 0
        ? this.container.db
            .select({
              id: systemStore.id,
              name: systemStore.name,
              phone: systemStore.phone,
              address: systemStore.address,
              detailedAddress: systemStore.detailedAddress,
              image: systemStore.image,
              latitude: systemStore.latitude,
              longitude: systemStore.longitude,
              validTime: systemStore.validTime,
              dayTime: systemStore.dayTime,
            })
            .from(systemStore)
            .where(eq(systemStore.id, order.storeId))
            .limit(1)
        : Promise.resolve([]),
    ]);
    const economize = economizeRows[0] ?? null;
    const customForm = await readOrderSystemFormSnapshot(
      this.container.db,
      new AttachmentService(this.container, this.env),
      uid,
      order.customForm,
    );
    return {
      ...order,
      virtualInfo:
        order.paid === 1 && order.deliveryType === "fictitious"
          ? parseVirtualDeliveryInfo(order.virtualInfo)
          : null,
      customForm,
      economize,
      postagePrice: economize?.postagePrice ?? "0.00",
      memberPrice: economize?.memberPrice ?? "0.00",
      invoice: invoiceRows[0] ?? null,
      promotionsDetail: promotionsDetail.map(({ allocation, promotion }) => ({
        ...allocation,
        promotion,
      })),
      writeoffRecords,
      pinkStatus: pinkRows[0]?.status ?? null,
      pinkInfo: pinkRows[0] ?? null,
      pickupStore: pickupStoreRows[0] ?? null,
      cartInfo: cartInfos.map((ci) => ({
        ...ci,
        cartInfo: parseCartSnapshot(ci.cartInfo),
      })),
      splitOrders: splitOrders.map((child) => ({
        ...child,
        virtualInfo:
          child.paid === 1 && child.deliveryType === "fictitious"
            ? parseVirtualDeliveryInfo(child.virtualInfo)
            : null,
        cartInfo: splitCartsByOrder.get(child.id) ?? [],
      })),
    };
  }

  // ═══ 订单操作 (补全) ═════════════════════════════════════

  /** 确认收货 (order/take) */
  async take(uid: number, orderId: string): Promise<void> {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    if (order.pid === -1 || order.supplierAllocationStatus === 1) {
      throw new ValidateException("请从拆分后的履约订单确认收货");
    }
    if (!order.paid) throw new ValidateException("订单未支付");
    if (order.shippingType === 2 || order.deliveryType === "send") {
      throw new ValidateException("该订单必须使用核销码完成履约");
    }
    if (order.status !== 1) throw new ValidateException("订单状态不允许收货");

    const completed = await completeOrderReceipt(this.container, this.env, {
      orderId: order.id,
      actor: "user",
      actorId: uid,
      message: "用户确认收货",
    });
    if (!completed) throw new ValidateException("订单已被处理");
  }

  /** 取消订单 (order/cancel, 未支付可取消) */
  async cancel(uid: number, orderId: string): Promise<void> {
    await cancelStoreOrder(this.container, { uid, orderId });
  }

  /** 删除订单 (order/del, 已收货/已取消可删) */
  async del(uid: number, orderId: string): Promise<void> {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    if (order.status !== -2 && !(order.paid === 1 && order.status >= 2)) {
      throw new ValidateException("订单状态不允许删除");
    }
    const now = Math.floor(Date.now() / 1000);
    await this.runInTx(this.container.db, async (tx) => {
      const updated = await tx
        .update(storeOrder)
        .set({ isDel: 1 })
        .where(and(eq(storeOrder.id, order.id), eq(storeOrder.isDel, 0)))
        .returning({ id: storeOrder.id });
      if (!updated.length) throw new ValidateException("订单已删除");
      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: "remove_order",
        changeMessage: "删除订单",
        changeTime: now,
      });
    });
  }

  /** 再次购买 (order/again, 简化: 返回商品加入购物车) */
  async again(uid: number, orderId: string): Promise<{ cartIds: number[] }> {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    const cartInfos = await this.container.storeOrderCartInfoDao.getByOid(order.id);

    const cartIds: number[] = [];
    for (const ci of cartInfos) {
      const row = await this.container.storeCartDao.save({
        uid,
        productId: ci.productId,
        productAttrUnique: ci.skuUnique,
        cartNum: ci.cartNum,
        addTime: Math.floor(Date.now() / 1000),
        status: 1,
      });
      cartIds.push(row.id);
    }
    return { cartIds };
  }
}

interface OrderItem {
  cart: Awaited<ReturnType<Container["storeCartDao"]["getByIds"]>>[number];
  product: NonNullable<Awaited<ReturnType<Container["storeProductDao"]["getById"]>>>;
  sku: NonNullable<Awaited<ReturnType<Container["storeProductAttrValueDao"]["getByUnique"]>>>;
  activitySku: typeof storeProductAttrValue.$inferSelect | null;
  integralActivity: typeof storeIntegral.$inferSelect | null;
  discountItem: ResolvedDiscountPackageItem | null;
  unitPriceCents: number;
}

function parseCartSnapshot(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
