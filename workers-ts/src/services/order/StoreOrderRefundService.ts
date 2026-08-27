/**
 * 售后退款 Service (M4)
 *
 * 对应 PHP app/services/order/StoreOrderRefundServices.php
 *
 * 三个核心方法 (经探针验证):
 *   - applyRefund:  用户申请 (创建 refund 记录, 不改 order.refund_status)
 *   - agreeRefund:  管理员同意 → 已接通渠道实际退款 + 库存回退 + 积分回退
 *   - refuseRefund: 管理员拒绝
 *
 * 关键一致性:
 *   - 第三方渠道未接通时拒绝操作，绝不提前把订单标记为已退款
 *   - 库存回退 (regressionStock): 只在 order.status==0 且首次退款时执行 (防双退)
 *   - 积分回退: 按累计退款比例回退赠送积分并返还抵扣积分，避免多次部分退款舍入漂移
 *   - 余额退 (yueRefund): user.now_money += refundPrice, 带 user_bill 流水
 */
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderInvoice,
  storeOrderRefund,
  storeOrderRefundPayment,
  storeOrderStatus,
  storeDiscounts,
  storeIntegral,
  storeProduct,
  storeProductAttrValue,
  user as userTable,
  userBill as userBillTable,
} from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException, NotFoundException } from "@/utils/errors";
import { recordSupplierRefund } from "@/services/supplier/SupplierFinanceService";
import {
  centsToDecimal,
  lockOrderSettlement,
  lockOrderSettlementUsers,
  reverseOrderBrokerage,
} from "@/services/order/OrderBrokerageService";
import { reverseOrderRewards } from "@/services/order/OrderRewardService";
import { AlipayRefundService } from "@/services/payment/AlipayRefundService";
import {
  amountToCents,
  type RefundProvider,
  type RefundProviderRequest,
  type RefundProviderResult,
  type RefundProviderStatus,
} from "@/services/payment/RefundGateway";
import { WechatApiError, WechatPayService } from "@/services/wechat/WechatPayService";
import { reconcileRefundedPink } from "@/services/activity/PinkLifecycleService";
import { enqueueOrderRefundRefusedNoticeEvent } from "@/services/order/OrderNotificationOutboxService";

const REFUND_LOCK_NAMESPACE = 63841;
const REQUEST_LEASE_SECONDS = 120;

export type RefundFinalizationOutcome = "completed" | "already-completed";

export interface RefundExecutionResult {
  completed: boolean;
  status: RefundProviderStatus | "BALANCE_SUCCESS";
}

/**
 * Optional caller boundary for privileged refund execution.
 *
 * Supplier and Out API callers must bind the refund they authorized to the
 * exact business identity and amount that the core later executes.  The
 * checks are repeated inside the short database phase immediately before a
 * balance finalization or third-party payment intent is created.
 */
export interface RefundExecutionScope {
  expectedStoreId?: number;
  expectedSupplierId?: number;
  expectedUid?: number;
  expectedRefundOrderId?: string;
  expectedStoreOrderId?: number;
  expectedRefundAmountCents?: number;
  requireSystemVisible?: boolean;
  requirePaid?: boolean;
}

type RefundExecutionScopeInput = number | RefundExecutionScope;

export interface ApplyOrderRefundInput {
  uid: number;
  orderId: string;
  refundReason: string;
  refundExplain: string;
  refundImg?: string;
  applyType: number;
  cartIds?: number[];
}

interface RefundApplicationOptions {
  reuseExisting: boolean;
}

function normalizeRefundExecutionScope(
  input?: RefundExecutionScopeInput,
): RefundExecutionScope | undefined {
  if (input === undefined) return undefined;
  return typeof input === "number" ? { expectedSupplierId: input } : input;
}

function assertRefundExecutionScope(
  refund: typeof storeOrderRefund.$inferSelect,
  order: typeof storeOrder.$inferSelect,
  scope?: RefundExecutionScope,
): void {
  if (!scope) return;
  if (
    (scope.expectedStoreId !== undefined &&
      (refund.storeId !== scope.expectedStoreId || order.storeId !== scope.expectedStoreId)) ||
    (scope.expectedSupplierId !== undefined &&
      (refund.supplierId !== scope.expectedSupplierId ||
        order.supplierId !== scope.expectedSupplierId)) ||
    (scope.expectedUid !== undefined &&
      (refund.uid !== scope.expectedUid || order.uid !== scope.expectedUid)) ||
    (scope.expectedRefundOrderId !== undefined &&
      refund.orderId !== scope.expectedRefundOrderId) ||
    (scope.expectedStoreOrderId !== undefined &&
      (refund.storeOrderId !== scope.expectedStoreOrderId ||
        order.id !== scope.expectedStoreOrderId)) ||
    (scope.requireSystemVisible && (order.isSystemDel !== 0 || order.isDel !== 0))
  ) {
    throw new NotFoundException("退款记录不存在或不属于当前操作范围");
  }
  if (refund.supplierId !== order.supplierId || refund.uid !== order.uid) {
    throw new ValidateException("售后记录与订单归属不一致，请先完成数据核对");
  }
  if (scope.requirePaid && order.paid !== 1) {
    throw new ValidateException("原订单未支付，不能执行退款");
  }
  if (scope.expectedRefundAmountCents !== undefined) {
    const refundCents = amountToCents(refund.refundPrice);
    if (refundCents !== scope.expectedRefundAmountCents) {
      throw new ValidateException("退款金额与售后单可退金额不一致");
    }
    if (
      refund.refundType === 6 &&
      amountToCents(refund.refundedPrice) !== scope.expectedRefundAmountCents
    ) {
      throw new ValidateException("历史已退款金额与售后单金额不一致，请先人工核对");
    }
  }
}

function assertPaymentOrderScope(
  paymentOrder: typeof storeOrder.$inferSelect,
  scope?: RefundExecutionScope,
): void {
  if (!scope) return;
  if (
    (scope.expectedStoreId !== undefined && paymentOrder.storeId !== scope.expectedStoreId) ||
    (scope.expectedUid !== undefined && paymentOrder.uid !== scope.expectedUid) ||
    (scope.requireSystemVisible &&
      (paymentOrder.isSystemDel !== 0 || paymentOrder.isDel !== 0))
  ) {
    throw new ValidateException("原支付订单与售后操作范围不一致，请先完成数据核对");
  }
}

async function lockRefundExecutionSnapshot(
  tx: DbClient,
  refundId: number,
  scope?: RefundExecutionScope,
) {
  await lockRefundExecution(tx, refundId);
  const refunds = await tx
    .select()
    .from(storeOrderRefund)
    .where(eq(storeOrderRefund.id, refundId))
    .limit(1)
    .for("update");
  const refund = refunds[0];
  if (!refund) throw new NotFoundException("退款记录不存在");
  await lockOrderSettlement(tx, refund.storeOrderId);
  const orders = await tx
    .select()
    .from(storeOrder)
    .where(eq(storeOrder.id, refund.storeOrderId))
    .limit(1)
    .for("update");
  const order = orders[0];
  if (!order) throw new NotFoundException("订单不存在");
  assertRefundExecutionScope(refund, order, scope);
  return { refund, order };
}

/**
 * Commit the business side effects of a provider-confirmed or balance refund.
 *
 * This is exported so the exact production transaction can be exercised against
 * PostgreSQL/Hyperdrive. The refund and order advisory locks serialize duplicate
 * callbacks and distinct partial refunds for the same order.
 */
export async function finalizeStoreOrderRefund(
  container: Container,
  refundId: number,
  now = Math.floor(Date.now() / 1000),
  scopeInput?: RefundExecutionScopeInput,
): Promise<RefundFinalizationOutcome> {
  const scope = normalizeRefundExecutionScope(scopeInput);
  return withTx(container, async (tx) => {
    await lockRefundExecution(tx, refundId);
    const refunds = await tx
      .select()
      .from(storeOrderRefund)
      .where(eq(storeOrderRefund.id, refundId))
      .limit(1)
      .for("update");
    const refund = refunds[0];
    if (!refund) throw new NotFoundException("退款记录不存在");

    // Distinct refund rows can complete concurrently. The order lock makes the
    // cumulative amount check and all proportional compensation deterministic.
    await lockOrderSettlement(tx, refund.storeOrderId);
    if (refund.isCancel || refund.isDel) throw new ValidateException("退款申请已取消或删除");

    const orders = await tx
      .select()
      .from(storeOrder)
      .where(eq(storeOrder.id, refund.storeOrderId))
      .limit(1)
      .for("update");
    const order = orders[0];
    if (!order) throw new NotFoundException("订单不存在");
    assertRefundExecutionScope(refund, order, scope);
    if (refund.refundType === 6) return "already-completed";
    if (![0, 1, 2, 4, 5].includes(refund.refundType)) {
      throw new ValidateException("售后状态不允许完成退款");
    }

    const refundCents = amountToCents(refund.refundPrice);
    const paidCents = amountToCents(order.payPrice);
    if (refundCents === null || refundCents < 0) throw new ValidateException("退款金额无效");
    if (paidCents === null || paidCents < 0) throw new ValidateException("订单实付金额无效");

    if (refundCents > 0 && order.payType !== "yue") {
      const payment = await getRefundPaymentRow(tx, refundId);
      if (!payment || payment.providerStatus !== "SUCCESS") {
        throw new ValidateException("支付渠道尚未确认退款成功");
      }
      if (payment.requestAmount !== refundCents) {
        throw new ValidateException("退款金额与支付渠道确认金额不一致");
      }
    }

    const totals = await tx
      .select({
        amount: sql<string>`COALESCE(SUM(${storeOrderRefund.refundedPrice}), 0)`,
        num: sql<number>`COALESCE(SUM(${storeOrderRefund.refundNum}), 0)::int`,
      })
      .from(storeOrderRefund)
      .where(
        and(
          eq(storeOrderRefund.storeOrderId, order.id),
          eq(storeOrderRefund.refundType, 6),
          eq(storeOrderRefund.isCancel, 0),
          eq(storeOrderRefund.isDel, 0),
        ),
      );
    const previousCents = amountToCents(totals[0]?.amount ?? "0.00");
    if (previousCents === null || previousCents < 0) {
      throw new ValidateException("历史累计退款金额无效");
    }
    const cumulativeCents = previousCents + refundCents;
    if (!Number.isSafeInteger(cumulativeCents) || cumulativeCents > paidCents) {
      throw new ValidateException("累计退款金额超过订单实付金额");
    }
    const previousNum = totals[0]?.num ?? 0;
    const cumulativeNum = previousNum + refund.refundNum;
    if (!Number.isSafeInteger(cumulativeNum) || cumulativeNum > order.totalNum) {
      throw new ValidateException("累计退款数量超过订单商品数量");
    }
    const pureIntegralOrder = paidCents === 0 && order.type === 4 && order.payIntegral > 0;

    const refundAmount = centsToDecimal(refundCents);
    const cumulativeAmount = centsToDecimal(cumulativeCents);
    const updated = await tx
      .update(storeOrderRefund)
      .set({ refundType: 6, refundedTime: now, refundedPrice: refundAmount })
      .where(
        and(
          eq(storeOrderRefund.id, refundId),
          ne(storeOrderRefund.refundType, 6),
          eq(storeOrderRefund.isCancel, 0),
          eq(storeOrderRefund.isDel, 0),
        ),
      )
      .returning({ id: storeOrderRefund.id });
    if (!updated[0]) return "already-completed";

    await lockOrderSettlementUsers(tx, order);
    const fullyRefunded = pureIntegralOrder
      ? cumulativeNum >= order.totalNum
      : cumulativeCents >= paidCents;
    await tx
      .update(storeOrder)
      .set({
        refundStatus: fullyRefunded ? 2 : 3,
        refundType: 6,
        refundPrice: cumulativeAmount,
      })
      .where(eq(storeOrder.id, order.id));
    await reconcileRefundedPink(
      tx,
      { ...order, refundStatus: fullyRefunded ? 2 : 3 },
      now,
    );
    await tx
      .update(storeOrderInvoice)
      .set({ isRefund: 1 })
      .where(eq(storeOrderInvoice.orderId, order.id));
    await reverseOrderRewards(tx, order, cumulativeCents, now, cumulativeNum);
    await reverseOrderBrokerage(tx, order, cumulativeCents, now);

    if (order.status === 0) {
      await restoreRefundStock(tx, order.id, refund.refundNum, refund.cartInfo);
      if (fullyRefunded && order.type === 5 && order.activityId > 0) {
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
        const packages = await tx
          .select({ isLimit: storeDiscounts.isLimit })
          .from(storeDiscounts)
          .where(eq(storeDiscounts.id, order.activityId))
          .limit(1);
        if (!packages[0] || (packages[0].isLimit === 1 && !restored.length)) {
          throw new ValidateException("套餐限额无法完整回退");
        }
      }
    }
    if (order.payType === "yue" && refundCents > 0) {
      const balanceRows = await tx
        .update(userTable)
        .set({ nowMoney: sql`now_money + ${refundAmount}` })
        .where(eq(userTable.uid, order.uid))
        .returning({ nowMoney: userTable.nowMoney });
      if (!balanceRows[0]) throw new NotFoundException("退款用户不存在");
      await tx.insert(userBillTable).values({
        uid: order.uid,
        linkId: refund.orderId,
        pm: 1,
        title: "订单退款",
        category: "now_money",
        type: "pay_product_refund",
        number: refundAmount,
        balance: balanceRows[0].nowMoney,
        mark: `退款到余额, 订单 ${order.orderId}`,
        status: 1,
        addTime: now,
      });
    }
    await tx.insert(storeOrderStatus).values({
      oid: order.id,
      changeType: "refund_price",
      changeMessage: `退款给用户：${refundAmount}元`,
      changeTime: now,
    });
    await recordSupplierRefund(tx, order, refundId, refundAmount, cumulativeCents, now);
    return "completed";
  });
}

/**
 * Apply for after-sale service without requiring payment-provider bindings.
 * Refund applications, writeoff, receipt, and refund execution share one order lock.
 */
async function createOrderRefundApplication(
  container: Container,
  params: ApplyOrderRefundInput,
  options: RefundApplicationOptions,
): Promise<{ refundId: number }> {
  const { uid, orderId } = params;
  if (![1, 2].includes(params.applyType)) throw new ValidateException("退款申请类型无效");
  const candidate = await container.storeOrderDao.findByOrderId(orderId);
  if (!candidate) throw new NotFoundException("订单不存在");

  return withTx(container, async (tx) => {
    await lockOrderSettlement(tx, candidate.id);
    const orderRows = await tx
      .select()
      .from(storeOrder)
      .where(and(eq(storeOrder.id, candidate.id), eq(storeOrder.orderId, orderId)))
      .limit(1)
      .for("update");
    const order = orderRows[0];
    if (!order) throw new NotFoundException("订单不存在");
    if (order.uid !== uid) throw new ValidateException("订单不属于当前用户");
    if (!order.paid) throw new ValidateException("订单未支付");
    if (order.supplierAllocationStatus === 1) {
      throw new ValidateException("订单正在按供应商分配，请稍后刷新");
    }
    if (order.pid === -1) throw new ValidateException("请从拆分后的履约子单申请售后");

    const previousRefunds = await tx
      .select()
      .from(storeOrderRefund)
      .where(eq(storeOrderRefund.storeOrderId, order.id))
      .orderBy(asc(storeOrderRefund.id));
    const openRefund = previousRefunds.find(
      (item) => [0, 1, 2, 4, 5].includes(item.refundType) && !item.isCancel && !item.isDel,
    );
    if (openRefund) {
      if (options.reuseExisting) return { refundId: openRefund.id };
      throw new ValidateException("该订单已有进行中的退款申请");
    }
    const completedRefunds = previousRefunds.filter(
      (item) => item.refundType === 6 && !item.isCancel && !item.isDel,
    );
    const paidCents = amountToCents(order.payPrice);
    if (paidCents === null || paidCents < 0) {
      throw new ValidateException("订单支付金额无效");
    }
    const pureIntegralOrder = paidCents === 0 && order.type === 4 && order.payIntegral > 0;
    const alreadyRefundedCents = completedRefunds.reduce((sum, item) => {
      const itemCents = amountToCents(item.refundedPrice || item.refundPrice);
      if (itemCents === null || itemCents < 0) {
        throw new ValidateException("历史退款金额无效");
      }
      const next = sum + itemCents;
      if (!Number.isSafeInteger(next)) throw new ValidateException("累计退款金额超出安全范围");
      return next;
    }, 0);
    const remainingCents = Math.max(0, paidCents - alreadyRefundedCents);
    if (remainingCents <= 0 && !pureIntegralOrder) {
      throw new ValidateException("订单支付金额已全部退款");
    }

    const completedCartIds = new Set<number>();
    let completedWithoutCartSnapshot = false;
    for (const item of completedRefunds) {
      const ids = parseRefundCartIds(item.cartInfo);
      if (ids.length === 0) completedWithoutCartSnapshot = true;
      for (const id of ids) completedCartIds.add(id);
    }
    if (completedWithoutCartSnapshot) {
      throw new ValidateException("历史整单退款已完成，不能再次申请退款");
    }

    let refundNum = Math.max(
      0,
      order.totalNum - completedRefunds.reduce((sum, item) => sum + item.refundNum, 0),
    );
    let refundCents = remainingCents;
    let refundCartIds: number[] = [];
    const cartInfos = await tx
      .select()
      .from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id))
      .orderBy(asc(storeOrderCartInfo.id));
    if (!cartInfos.length) throw new Error("订单缺少商品快照，不能安全申请退款");
    if (params.cartIds?.length) {
      const requestedCartIds = [...new Set(params.cartIds.map(Number))];
      if (
        requestedCartIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        requestedCartIds.some((id) => completedCartIds.has(id))
      ) {
        throw new ValidateException("退款商品无效或已经退款");
      }
      const selected = cartInfos.filter((item) => requestedCartIds.includes(Number(item.cartId)));
      if (selected.length !== requestedCartIds.length) {
        throw new ValidateException("退款商品不属于当前订单");
      }
      if (selected.some((item) => item.isSupportRefund !== 1)) {
        throw new ValidateException("所选商品不支持退款");
      }
      if (selected.some((item) => item.writeTimes > item.writeSurplusTimes)) {
        throw new ValidateException("所选商品已有核销记录，不能按整行申请退款");
      }
      refundNum = selected.reduce((sum, item) => sum + item.cartNum, 0);
      if (refundNum > order.totalNum) throw new ValidateException("退款数量超过订单商品总数");
      refundCartIds = requestedCartIds;
      refundCents = pureIntegralOrder
        ? 0
        : order.totalNum > 0
        ? Math.min(
            remainingCents,
            Math.floor((paidCents * refundNum) / order.totalNum),
          )
        : 0;
    } else if (completedCartIds.size > 0) {
      const remainingCartInfos = cartInfos.filter(
        (item) => !completedCartIds.has(Number(item.cartId)),
      );
      if (remainingCartInfos.some((item) => item.isSupportRefund !== 1)) {
        throw new ValidateException("剩余商品不支持退款");
      }
      refundCartIds = remainingCartInfos.map((item) => Number(item.cartId));
      if (
        refundCartIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
        || new Set(refundCartIds).size !== refundCartIds.length
      ) {
        throw new ValidateException("历史退款商品快照不完整，不能安全补齐剩余退款");
      }
      refundNum = remainingCartInfos.reduce((sum, item) => sum + item.cartNum, 0);
    } else {
      if (cartInfos.some((item) => item.isSupportRefund !== 1)) {
        throw new ValidateException("订单包含不支持退款的商品");
      }
      if (cartInfos.some((item) => item.writeTimes > item.writeSurplusTimes)) {
        throw new ValidateException("订单已有核销记录，请仅选择未核销商品申请售后");
      }
    }
    if (refundNum <= 0 || (!pureIntegralOrder && refundCents <= 0)) {
      throw new ValidateException("没有可退款的商品或金额");
    }
    const refundPrice = centsToDecimal(refundCents);

    const now = Math.floor(Date.now() / 1000);
    const inserted = await tx
      .insert(storeOrderRefund)
      .values({
        storeOrderId: order.id,
        uid,
        supplierId: order.supplierId,
        orderId: `r${order.id}${now}`,
        applyType: params.applyType,
        applyPrice: refundPrice,
        refundType: 0,
        refundNum,
        refundPrice,
        refundReason: params.refundReason,
        refundExplain: params.refundExplain,
        refundImg: params.refundImg ?? "",
        cartInfo: JSON.stringify({ cartIds: refundCartIds }),
        addTime: now,
      })
      .returning({ id: storeOrderRefund.id });
    if (!inserted[0]) throw new Error("退款申请写入失败");
    await tx.insert(storeOrderStatus).values({
      oid: order.id,
      changeType: "apply_refund",
      changeMessage: `用户申请退款，原因：${params.refundReason}`,
      changeTime: now,
    });
    return { refundId: inserted[0].id };
  });
}

export async function applyOrderRefund(
  container: Container,
  params: ApplyOrderRefundInput,
): Promise<{ refundId: number }> {
  return createOrderRefundApplication(container, params, { reuseExisting: false });
}

/**
 * At-least-once system jobs reuse the one active refund application under the
 * order settlement lock. Once that refund completes, a later call creates the
 * exact remaining amount, so a pre-existing partial after-sale cannot suppress
 * a mandatory full refund.
 */
export async function ensureAutomaticOrderRefund(
  container: Container,
  params: ApplyOrderRefundInput,
): Promise<{ refundId: number }> {
  return createOrderRefundApplication(container, params, { reuseExisting: true });
}

export class StoreOrderRefundService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * 用户申请退款 (对应 PHP applyRefund)
   *
   * 注意: 不改 store_order.refund_status (与 PHP 一致, 仅创建 refund 记录)
   */
  async applyRefund(params: ApplyOrderRefundInput): Promise<{ refundId: number }> {
    return applyOrderRefund(this.container, params);
  }

  /**
   * 管理员同意退款 (对应 PHP agreeRefund)
   *
   * 事务内 (ACID):
   *   1. 更新 refund 记录: refundType=6(已退款), refundedTime
   *   2. 更新 order: refundStatus=2(已退款), refundType=6
   *   3. 库存回退 (首次退款守卫)
   *   4. 余额退 (yue) 或记录待微信/支付宝退
   *   5. 积分回退 (use_integral)
   *   6. 状态日志
   */
  async agreeRefund(
    refundId: number,
    scopeInput?: RefundExecutionScopeInput,
  ): Promise<RefundExecutionResult> {
    const c = this.container;
    const scope = normalizeRefundExecutionScope(scopeInput);
    // Hyperdrive can cache transaction-external reads. Refund decisions must
    // start from a fresh, locked transaction snapshot even before a provider
    // request is built or an already-completed replay is returned.
    const { refund, order } = await this.runInTx(c.db, (tx) =>
      lockRefundExecutionSnapshot(tx, refundId, scope));
    if (refund.refundType === 6) return { completed: true, status: "SUCCESS" };
    if (refund.isCancel || refund.isDel) throw new ValidateException("退款申请已取消或删除");
    if (![0, 1, 2, 4, 5].includes(refund.refundType)) {
      throw new ValidateException("售后状态不允许退款");
    }

    const refundCents = amountToCents(refund.refundPrice);
    if (refundCents === null || refundCents < 0) throw new ValidateException("退款金额无效");
    if (refundCents === 0 || order.payType === "yue") {
      await finalizeStoreOrderRefund(
        this.container,
        refundId,
        Math.floor(Date.now() / 1000),
        scope,
      );
      return { completed: true, status: "BALANCE_SUCCESS" };
    }
    if (order.payType !== "weixin" && order.payType !== "alipay") {
      throw new ValidateException(`支付方式 ${order.payType || "未知"} 不支持原路退款`);
    }
    return this.processThirdPartyRefund(
      refundId,
      order.payType === "weixin" ? "wechat" : "alipay",
      scope,
    );
  }

  private async processThirdPartyRefund(
    refundId: number,
    provider: RefundProvider,
    scope?: RefundExecutionScope,
  ): Promise<RefundExecutionResult> {
    const request = await this.buildProviderRequest(refundId, provider, scope);
    let action = await this.prepareProviderAction(refundId, provider, request, scope);
    if (action === "SUCCESS") {
      await this.finalizeRefund(refundId);
      return { completed: true, status: "SUCCESS" };
    }
    if (action === "WAIT") return { completed: false, status: "PROCESSING" };
    if (action === "TERMINAL") {
      throw new ValidateException("该渠道退款已关闭或异常，需人工核对后处理");
    }

    const gateway = this.refundGateway(provider);
    if (action === "QUERY") {
      const queryResult = await this.invokeProvider(
        refundId,
        () => gateway.queryRefund(request),
        "查询",
      );
      if (queryResult.status !== "NOT_FOUND") {
        await this.recordProviderResult(refundId, queryResult, true);
        return this.consumeProviderResult(refundId, queryResult);
      }
      action = await this.claimProviderRequest(refundId);
      if (action === "SUCCESS") {
        await this.finalizeRefund(refundId);
        return { completed: true, status: "SUCCESS" };
      }
      if (action === "WAIT") return { completed: false, status: "PROCESSING" };
    }

    const requestResult = await this.invokeProvider(
      refundId,
      () => gateway.requestRefund(request),
      "申请",
    );
    await this.recordProviderResult(refundId, requestResult, false);
    return this.consumeProviderResult(refundId, requestResult);
  }

  private refundGateway(provider: RefundProvider): {
    requestRefund(request: RefundProviderRequest): Promise<RefundProviderResult>;
    queryRefund(request: RefundProviderRequest): Promise<RefundProviderResult>;
  } {
    return provider === "wechat"
      ? new WechatPayService(this.container, this.env)
      : new AlipayRefundService(this.env);
  }

  private async buildProviderRequest(
    refundId: number,
    provider: RefundProvider,
    scope?: RefundExecutionScope,
  ): Promise<RefundProviderRequest> {
    const refund = await this.container.storeOrderRefundDao.get(refundId);
    if (!refund) throw new NotFoundException("退款记录不存在");
    const order = await this.container.storeOrderDao.get(refund.storeOrderId);
    if (!order) throw new NotFoundException("订单不存在");
    assertRefundExecutionScope(refund, order, scope);
    const paymentOrder = order.pid > 0
      ? await this.container.storeOrderDao.get(order.pid)
      : order;
    if (!paymentOrder || !paymentOrder.paid) throw new ValidateException("原支付订单不存在或未支付");
    assertPaymentOrderScope(paymentOrder, scope);
    const providerPayType = provider === "wechat" ? "weixin" : "alipay";
    if (paymentOrder.payType !== providerPayType) {
      throw new ValidateException("原支付渠道与退款渠道不一致");
    }

    const refundAmount = amountToCents(refund.refundPrice);
    const totalAmount = amountToCents(paymentOrder.payPrice);
    if (
      refundAmount === null ||
      totalAmount === null ||
      refundAmount <= 0 ||
      totalAmount <= 0 ||
      refundAmount > totalAmount
    ) {
      throw new ValidateException("退款金额超过原支付金额或格式无效");
    }
    return {
      outTradeNo: paymentOrder.orderId,
      transactionId:
        paymentOrder.tradeNo && paymentOrder.tradeNo !== paymentOrder.orderId
          ? paymentOrder.tradeNo
          : undefined,
      outRefundNo: `CNSR${refundId}`,
      refundAmount,
      totalAmount,
      reason: refund.refundReason || "订单售后退款",
    };
  }

  private async prepareProviderAction(
    refundId: number,
    provider: RefundProvider,
    request: RefundProviderRequest,
    scope?: RefundExecutionScope,
  ): Promise<"REQUEST" | "QUERY" | "WAIT" | "SUCCESS" | "TERMINAL"> {
    return this.runInTx(this.container.db, async (tx) => {
      const { refund, order } = await lockRefundExecutionSnapshot(tx, refundId, scope);
      if (refund.isCancel || refund.isDel) {
        throw new ValidateException("退款申请已取消或删除");
      }
      if (refund.refundType !== 6 && ![0, 1, 2, 4, 5].includes(refund.refundType)) {
        throw new ValidateException("售后状态不允许退款");
      }
      const paymentOrderRows = order.pid > 0
        ? await tx
            .select()
            .from(storeOrder)
            .where(eq(storeOrder.id, order.pid))
            .limit(1)
        : [order];
      const paymentOrder = paymentOrderRows[0];
      if (!paymentOrder || paymentOrder.paid !== 1) {
        throw new ValidateException("原支付订单不存在或未支付");
      }
      assertPaymentOrderScope(paymentOrder, scope);
      const providerPayType = provider === "wechat" ? "weixin" : "alipay";
      const currentRefundAmount = amountToCents(refund.refundPrice);
      const currentTotalAmount = amountToCents(paymentOrder.payPrice);
      const currentTransactionId =
        paymentOrder.tradeNo && paymentOrder.tradeNo !== paymentOrder.orderId
          ? paymentOrder.tradeNo
          : undefined;
      if (
        paymentOrder.payType !== providerPayType ||
        currentRefundAmount === null ||
        currentTotalAmount === null ||
        request.outTradeNo !== paymentOrder.orderId ||
        request.transactionId !== currentTransactionId ||
        request.outRefundNo !== `CNSR${refundId}` ||
        request.refundAmount !== currentRefundAmount ||
        request.totalAmount !== currentTotalAmount
      ) {
        throw new ValidateException("退款渠道请求与当前订单状态不一致，请重试");
      }
      const now = Math.floor(Date.now() / 1000);
      let payment = await this.getPaymentRow(tx, refundId);
      if (!payment) {
        await tx.insert(storeOrderRefundPayment).values({
          refundId,
          storeOrderId: refund.storeOrderId,
          provider,
          outRefundNo: request.outRefundNo,
          providerStatus: "CREATED",
          requestAmount: request.refundAmount,
          totalAmount: request.totalAmount,
          addTime: now,
          updateTime: now,
        });
        payment = await this.getPaymentRow(tx, refundId);
      }
      if (!payment) throw new Error("退款支付状态创建失败");
      this.assertImmutablePayment(payment, provider, request);

      if (payment.providerStatus === "SUCCESS") return "SUCCESS";
      if (["CLOSED", "ABNORMAL"].includes(payment.providerStatus)) return "TERMINAL";
      if (
        payment.providerStatus === "REQUESTING" &&
        now - payment.requestTime < REQUEST_LEASE_SECONDS
      ) {
        return "WAIT";
      }
      if (["PROCESSING", "UNKNOWN", "REQUESTING"].includes(payment.providerStatus)) {
        await tx
          .update(storeOrderRefundPayment)
          .set({ queryTime: now, updateTime: now })
          .where(eq(storeOrderRefundPayment.refundId, refundId));
        return "QUERY";
      }
      await this.markRequesting(tx, refundId, now);
      return "REQUEST";
    });
  }

  private async claimProviderRequest(
    refundId: number,
  ): Promise<"REQUEST" | "WAIT" | "SUCCESS"> {
    return this.runInTx(this.container.db, async (tx) => {
      await this.lockRefund(tx, refundId);
      const payment = await this.getPaymentRow(tx, refundId);
      if (!payment) throw new NotFoundException("退款支付状态不存在");
      if (payment.providerStatus === "SUCCESS") return "SUCCESS";
      const now = Math.floor(Date.now() / 1000);
      if (
        payment.providerStatus === "REQUESTING" &&
        now - payment.requestTime < REQUEST_LEASE_SECONDS
      ) {
        return "WAIT";
      }
      await this.markRequesting(tx, refundId, now);
      return "REQUEST";
    });
  }

  private async invokeProvider(
    refundId: number,
    invoke: () => Promise<RefundProviderResult>,
    operation: string,
  ): Promise<RefundProviderResult> {
    try {
      return await invoke();
    } catch (error) {
      const message = `${operation}退款失败: ${errorMessage(error)}`;
      const status = isDefinitiveProviderError(error) ? "FAILED" : "UNKNOWN";
      await this.recordProviderResult(refundId, { status, message }, operation === "查询");
      throw new ValidateException(
        status === "UNKNOWN"
          ? `${message}；结果未知，系统已保留原退款单号，重试前会先查询渠道`
          : message,
      );
    }
  }

  private async consumeProviderResult(
    refundId: number,
    result: RefundProviderResult,
  ): Promise<RefundExecutionResult> {
    if (result.status === "SUCCESS") {
      await this.finalizeRefund(refundId);
      return { completed: true, status: "SUCCESS" };
    }
    if (result.status === "PROCESSING") {
      return { completed: false, status: "PROCESSING" };
    }
    if (result.status === "UNKNOWN") {
      throw new ValidateException(result.message || "退款结果未知，请稍后重试查询");
    }
    throw new ValidateException(result.message || `渠道退款失败 (${result.status})`);
  }

  private async recordProviderResult(
    refundId: number,
    result: RefundProviderResult,
    queried: boolean,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const values: Partial<typeof storeOrderRefundPayment.$inferInsert> = {
      providerStatus: result.status === "NOT_FOUND" ? "CREATED" : result.status,
      lastError: (result.message ?? "").slice(0, 512),
      updateTime: now,
      ...(queried ? { queryTime: now } : {}),
    };
    if (result.providerRefundId) values.providerRefundId = result.providerRefundId;
    if (result.status === "SUCCESS") values.successTime = result.successTime ?? now;
    await this.container.db
      .update(storeOrderRefundPayment)
      .set(values)
      .where(
        result.status === "SUCCESS"
          ? eq(storeOrderRefundPayment.refundId, refundId)
          : and(
              eq(storeOrderRefundPayment.refundId, refundId),
              ne(storeOrderRefundPayment.providerStatus, "SUCCESS"),
            ),
      );
  }

  private async finalizeRefund(refundId: number): Promise<void> {
    await finalizeStoreOrderRefund(this.container, refundId);
  }

  async handleWechatRefundNotification(notification: {
    outTradeNo: string;
    transactionId: string;
    outRefundNo: string;
    providerRefundId: string;
    status: RefundProviderStatus;
    refundAmount: number;
    totalAmount: number;
    successTime?: number;
  }): Promise<void> {
    const rows = await this.container.db
      .select()
      .from(storeOrderRefundPayment)
      .where(eq(storeOrderRefundPayment.outRefundNo, notification.outRefundNo))
      .limit(1);
    const payment = rows[0];
    if (!payment || payment.provider !== "wechat") {
      throw new NotFoundException("微信退款单不存在");
    }
    if (
      payment.requestAmount !== notification.refundAmount ||
      payment.totalAmount !== notification.totalAmount
    ) {
      throw new ValidateException("微信退款回调金额不匹配");
    }
    const order = await this.container.storeOrderDao.get(payment.storeOrderId);
    if (!order) throw new NotFoundException("退款订单不存在");
    const paymentOrder = order.pid > 0
      ? await this.container.storeOrderDao.get(order.pid)
      : order;
    if (
      !paymentOrder ||
      paymentOrder.orderId !== notification.outTradeNo ||
      (paymentOrder.tradeNo && paymentOrder.tradeNo !== notification.transactionId)
    ) {
      throw new ValidateException("微信退款回调原支付信息不匹配");
    }

    const now = Math.floor(Date.now() / 1000);
    await this.container.db
      .update(storeOrderRefundPayment)
      .set({
        providerStatus: notification.status,
        providerRefundId: notification.providerRefundId,
        notifyTime: now,
        successTime:
          notification.status === "SUCCESS" ? notification.successTime ?? now : payment.successTime,
        lastError: ["CLOSED", "ABNORMAL"].includes(notification.status)
          ? `微信退款状态 ${notification.status}`
          : "",
        updateTime: now,
      })
      .where(
        notification.status === "SUCCESS"
          ? eq(storeOrderRefundPayment.id, payment.id)
          : and(
              eq(storeOrderRefundPayment.id, payment.id),
              ne(storeOrderRefundPayment.providerStatus, "SUCCESS"),
            ),
      );
    if (notification.status === "SUCCESS") await this.finalizeRefund(payment.refundId);
  }

  /** 定时查询可能丢失回调或网络结果未知的退款，不依赖回调作为唯一真相来源。 */
  async reconcilePendingRefunds(limit = 20, afterId = 0): Promise<{
    checked: number;
    completed: number;
    errors: number;
    nextCursor: number;
    hasMore: boolean;
  }> {
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new ValidateException("退款对账游标无效");
    }
    const now = Math.floor(Date.now() / 1000);
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const candidates = await withTx(this.container, async (tx) => {
      const rows = await tx
        .select()
        .from(storeOrderRefundPayment)
        .where(
          and(
            gt(storeOrderRefundPayment.id, afterId),
            sql`${storeOrderRefundPayment.providerStatus} IN ('REQUESTING', 'PROCESSING', 'UNKNOWN')`,
            sql`${storeOrderRefundPayment.requestTime} <= ${now - REQUEST_LEASE_SECONDS}`,
            sql`(${storeOrderRefundPayment.queryTime} = 0 OR ${storeOrderRefundPayment.queryTime} <= ${now - 60})`,
          ),
        )
        .orderBy(asc(storeOrderRefundPayment.id))
        .limit(boundedLimit)
        .for("update", { skipLocked: true });
      if (rows.length) {
        await tx
          .update(storeOrderRefundPayment)
          .set({ queryTime: now, updateTime: now })
          .where(inArray(storeOrderRefundPayment.id, rows.map((row) => row.id)));
      }
      return rows;
    });

    let completed = 0;
    let errors = 0;
    for (const payment of candidates) {
      try {
        if (payment.provider !== "wechat" && payment.provider !== "alipay") {
          throw new Error(`未知退款渠道 ${payment.provider}`);
        }
        const request = await this.buildProviderRequest(payment.refundId, payment.provider);
        const result = await this.refundGateway(payment.provider).queryRefund(request);
        await this.recordProviderResult(payment.refundId, result, true);
        if (result.status === "SUCCESS") {
          await this.finalizeRefund(payment.refundId);
          completed += 1;
        }
      } catch (error) {
        errors += 1;
        await this.recordProviderResult(
          payment.refundId,
          { status: "UNKNOWN", message: `自动对账失败: ${errorMessage(error)}` },
          true,
        ).catch(() => undefined);
        console.error("[refund-reconcile]", payment.refundId, errorMessage(error));
      }
    }
    return {
      checked: candidates.length,
      completed,
      errors,
      nextCursor: candidates.at(-1)?.id ?? afterId,
      hasMore: candidates.length === boundedLimit,
    };
  }

  private async getPaymentRow(tx: DbClient, refundId: number) {
    return getRefundPaymentRow(tx, refundId);
  }

  private assertImmutablePayment(
    payment: typeof storeOrderRefundPayment.$inferSelect,
    provider: RefundProvider,
    request: RefundProviderRequest,
  ): void {
    if (
      payment.provider !== provider ||
      payment.outRefundNo !== request.outRefundNo ||
      payment.requestAmount !== request.refundAmount ||
      payment.totalAmount !== request.totalAmount
    ) {
      throw new ValidateException("退款幂等参数与首次请求不一致，已拒绝重复扣款风险");
    }
  }

  private async markRequesting(tx: DbClient, refundId: number, now: number): Promise<void> {
    await tx
      .update(storeOrderRefundPayment)
      .set({
        providerStatus: "REQUESTING",
        requestTime: now,
        attemptCount: sql`${storeOrderRefundPayment.attemptCount} + 1`,
        lastError: "",
        updateTime: now,
      })
      .where(eq(storeOrderRefundPayment.refundId, refundId));
  }

  private async lockRefund(tx: DbClient, refundId: number): Promise<void> {
    await lockRefundExecution(tx, refundId);
  }


  /** 管理员拒绝退款 (对应 PHP refuseRefund) */
  async refuseRefund(
    refundId: number,
    refuseReason: string,
    expectedSupplierId?: number,
  ): Promise<void> {
    const c = this.container;
    const refund = await c.storeOrderRefundDao.get(refundId);
    if (!refund) throw new NotFoundException("退款记录不存在");

    const order = await c.storeOrderDao.get(refund.storeOrderId);
    if (!order) throw new NotFoundException("订单不存在");
    if (
      expectedSupplierId !== undefined &&
      (refund.supplierId !== expectedSupplierId || order.supplierId !== expectedSupplierId)
    ) {
      throw new NotFoundException("退款记录不存在或不属于当前供应商");
    }
    if (refund.isCancel || refund.isDel) throw new ValidateException("退款申请已取消或删除");
    if (![0, 1, 2, 4, 5].includes(refund.refundType)) {
      throw new ValidateException("售后状态不允许拒绝");
    }

    await this.runInTx(c.db, async (tx) => {
      const now = Math.floor(Date.now() / 1_000);
      await this.lockRefund(tx, refundId);
      const payment = await this.getPaymentRow(tx, refundId);
      if (
        payment &&
        !["CREATED", "FAILED", "CLOSED"].includes(payment.providerStatus)
      ) {
        throw new ValidateException("渠道退款已发起或结果待确认，不能拒绝售后");
      }
      const updated = await tx
        .update(storeOrderRefund)
        .set({ refundType: 3, refuseReason })
        .where(
          and(
            eq(storeOrderRefund.id, refundId),
            eq(storeOrderRefund.refundType, refund.refundType),
            eq(storeOrderRefund.isCancel, 0),
            eq(storeOrderRefund.isDel, 0),
          ),
        )
        .returning({ id: storeOrderRefund.id });
      if (!updated[0]) throw new ValidateException("退款申请已被处理");
      await tx
        .update(storeOrder)
        .set({ refundStatus: 0, refundType: 3 })
        .where(eq(storeOrder.id, order.id));
      await tx.insert((await import("@/models/schema")).storeOrderStatus).values({
        oid: order.id,
        changeType: "refund_n",
        changeMessage: `管理员拒绝退款：${refuseReason}`,
        changeTime: now,
      });
      await enqueueOrderRefundRefusedNoticeEvent(tx, {
        orderId: order.id,
        orderNo: order.orderId,
        refundId,
        userId: order.uid,
        payPrice: order.payPrice,
      }, now);
    });
  }

  /** 用户取消退款申请 (对应 PHP cancelApplyRefund) */
  async cancelApply(uid: number, refundId: number): Promise<void> {
    const c = this.container;
    const refund = await c.storeOrderRefundDao.get(refundId);
    if (!refund) throw new NotFoundException("退款记录不存在");
    if (refund.uid !== uid) throw new ValidateException("无权操作");
    await this.runInTx(c.db, async (tx) => {
      await this.lockRefund(tx, refundId);
      const payment = await this.getPaymentRow(tx, refundId);
      if (
        payment &&
        !["CREATED", "FAILED", "CLOSED"].includes(payment.providerStatus)
      ) {
        throw new ValidateException("渠道退款已发起或结果待确认，不能取消售后");
      }
      const updated = await tx
        .update(storeOrderRefund)
        .set({ isCancel: 1 })
        .where(
          and(
            eq(storeOrderRefund.id, refundId),
            eq(storeOrderRefund.uid, uid),
            eq(storeOrderRefund.isCancel, 0),
            ne(storeOrderRefund.refundType, 6),
          ),
        )
        .returning({ id: storeOrderRefund.id });
      if (!updated[0]) throw new ValidateException("退款申请已处理，不能取消");
      await tx.insert((await import("@/models/schema")).storeOrderStatus).values({
        oid: refund.storeOrderId,
        changeType: "cancel_apply_refund",
        changeMessage: "用户取消退款申请",
        changeTime: Math.floor(Date.now() / 1000),
      });
    });
  }

  /**
   * 库存回退 (对应 PHP regressionStock)
   * 增加 SKU + 主商品库存, 减少销量
   */
  /** 退款列表 (用户侧) */
  async listByUser(uid: number) {
    return this.container.storeOrderRefundDao.selectList({
      where: { uid, isDel: 0 },
    });
  }

  /** 退款详情 */
  async detail(uid: number, refundId: number) {
    const refund = await this.container.storeOrderRefundDao.get(refundId);
    if (!refund || refund.uid !== uid) throw new NotFoundException("退款记录不存在");
    return {
      ...refund,
      cartInfo: refund.cartInfo ? JSON.parse(refund.cartInfo) : null,
    };
  }

  /** 事务包装器 */
  private async runInTx<T>(db: DbClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => fn(tx as unknown as DbClient));
  }
}

async function getRefundPaymentRow(tx: DbClient, refundId: number) {
  const rows = await tx
    .select()
    .from(storeOrderRefundPayment)
    .where(eq(storeOrderRefundPayment.refundId, refundId))
    .limit(1);
  return rows[0] ?? null;
}

export async function lockRefundExecution(tx: DbClient, refundId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REFUND_LOCK_NAMESPACE}, ${refundId})`);
}

async function restoreRefundStock(
  tx: DbClient,
  orderId: number,
  refundNum: number,
  cartInfoSnapshot: string | null,
): Promise<void> {
  const cartInfos = await tx
    .select()
    .from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, orderId));
  const selectedCartIds = parseRefundCartIds(cartInfoSnapshot);
  const selected = selectedCartIds.length
    ? cartInfos.filter((item) => selectedCartIds.includes(Number(item.cartId)))
    : cartInfos;
  let remaining = refundNum;
  for (const ci of selected) {
    const num = Math.min(ci.cartNum, remaining);
    if (num <= 0) continue;
    remaining -= num;

    let baseSkuId = 0;
    let activitySkuId = 0;
    let integralActivityId = 0;
    try {
      const snapshot = JSON.parse(ci.cartInfo ?? "{}") as {
        product?: { activityId?: unknown };
        sku?: { id?: unknown };
        activitySku?: { id?: unknown };
      };
      baseSkuId = Number(snapshot.sku?.id ?? 0);
      activitySkuId = Number(snapshot.activitySku?.id ?? 0);
      integralActivityId = Number(snapshot.product?.activityId ?? 0);
    } catch {
      baseSkuId = 0;
      activitySkuId = 0;
      integralActivityId = 0;
    }
    if (!Number.isSafeInteger(baseSkuId) || baseSkuId <= 0) {
      const baseRows = await tx
        .select({ id: storeProductAttrValue.id })
        .from(storeProductAttrValue)
        .where(
          and(
            eq(storeProductAttrValue.productId, ci.productId),
            eq(storeProductAttrValue.unique, ci.skuUnique),
            eq(storeProductAttrValue.type, 0),
          ),
        )
        .limit(2);
      if (baseRows.length !== 1) throw new ValidateException("退款商品规格无法唯一定位");
      baseSkuId = baseRows[0].id;
    }
    if (baseSkuId > 0) {
      await tx
        .update(storeProductAttrValue)
        .set({
          stock: sql`stock + ${num}`,
          sales: sql`GREATEST(sales - ${num}, 0)`,
        })
        .where(eq(storeProductAttrValue.id, baseSkuId));
    }
    await tx
      .update(storeProduct)
      .set({
        stock: sql`stock + ${num}`,
        sales: sql`GREATEST(sales - ${num}, 0)`,
      })
      .where(eq(storeProduct.id, ci.productId));
    if (integralActivityId > 0) {
      if (!Number.isSafeInteger(activitySkuId) || activitySkuId <= 0) {
        throw new ValidateException("退款积分商品规格快照缺失");
      }
      const activitySkuRows = await tx
        .update(storeProductAttrValue)
        .set({
          stock: sql`stock + ${num}`,
          quota: sql`quota + ${num}`,
          sales: sql`GREATEST(sales - ${num}, 0)`,
        })
        .where(
          and(
            eq(storeProductAttrValue.id, activitySkuId),
            eq(storeProductAttrValue.productId, integralActivityId),
            eq(storeProductAttrValue.type, 4),
          ),
        )
        .returning({ id: storeProductAttrValue.id });
      const activityRows = await tx
        .update(storeIntegral)
        .set({
          stock: sql`stock + ${num}`,
          quota: sql`quota + ${num}`,
          sales: sql`GREATEST(sales - ${num}, 0)`,
        })
        .where(eq(storeIntegral.id, integralActivityId))
        .returning({ id: storeIntegral.id });
      if (!activitySkuRows[0] || !activityRows[0]) {
        throw new ValidateException("积分商品库存无法完整回退");
      }
    }
  }
  if (remaining > 0) throw new ValidateException("退款商品快照与退款数量不一致");
}

function parseRefundCartIds(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : parsed !== null
          && typeof parsed === "object"
          && Array.isArray((parsed as { cartIds?: unknown }).cartIds)
        ? (parsed as { cartIds: unknown[] }).cartIds
        : [];
    return [...new Set(values
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const record = item as Record<string, unknown>;
          return Number(record.cartId ?? record.cart_id ?? record.id);
        }
        return Number(item);
      })
      .filter((item) => Number.isSafeInteger(item) && item > 0))];
  } catch {
    return [];
  }
}

function isDefinitiveProviderError(error: unknown): boolean {
  if (error instanceof ValidateException) return true;
  if (error instanceof WechatApiError) {
    return !/SYSTEM|TIMEOUT|UNKNOWN|HTTP_5\d\d/.test(error.code);
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
