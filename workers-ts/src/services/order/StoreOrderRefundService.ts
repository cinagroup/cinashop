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
import { and, asc, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderInvoice,
  storeOrderRefund,
  storeOrderRefundPayment,
  storeOrderStatus,
  storeDiscounts,
  storeSeckill,
  storeBargain,
  storeBargainUser,
  storeCombination,
  storeIntegral,
  storeProduct,
  storeProductAttrValue,
  user as userTable,
  userBill as userBillTable,
} from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException, NotFoundException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
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
import { SystemConfigService } from "@/services/system/SystemConfigService";

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
  expectedRefundedAmountCents?: number;
  requireSystemVisible?: boolean;
  requirePaid?: boolean;
  /** Idempotent privileged actor evidence recorded before provider I/O. */
  executionAudit?: RefundDecisionAudit;
  /**
   * Optional caller authorization that must run before the refund/order locks.
   * Kefu uses this to serialize against conversation transfer and prove that
   * the agent still owns the customer at the exact refund decision boundary.
   */
  authorizeBeforeRefundLock?: (
    tx: DbClient,
    refund: typeof storeOrderRefund.$inferSelect,
  ) => Promise<void>;
}

type RefundExecutionScopeInput = number | RefundExecutionScope;

export interface ApplyOrderRefundInput {
  uid: number;
  orderId: string;
  refundReason: string;
  refundExplain: string;
  refundImg?: string;
  applyType: number;
  privilegedActor?: "admin";
  cartIds?: number[];
  cartSelections?: Array<{ cartId: number; cartNum: number }>;
  /** Privileged callers can require the server-side quote to match exactly. */
  expectedRefundAmountCents?: number;
  /** Stable internal identifier for privileged at-least-once applications. */
  applicationOrderId?: string;
  /** Optional immutable actor audit committed with the application row. */
  audit?: {
    changeType: string;
    changeMessage: string;
  };
}

export interface RefundDecisionAudit {
  changeType: string;
  changeMessage: string;
}

interface RefundCartSelection {
  cartId: number;
  cartNum?: number;
}

interface RefundApplicationOptions {
  reuseExisting: boolean;
  refundTimeDays: number;
}

interface RefundPricingLine {
  cartId: number;
  cartNum: number;
  lineCents: number;
}

export function isRefundWindowOpen(
  receivedAt: number,
  refundTimeDays: number,
  now: number,
): boolean {
  if (!Number.isSafeInteger(refundTimeDays) || refundTimeDays < 0) {
    throw new ValidateException("售后期限配置无效");
  }
  if (refundTimeDays === 0 || receivedAt <= 0) return true;
  if (!Number.isSafeInteger(receivedAt) || !Number.isSafeInteger(now) || now < 0) {
    throw new ValidateException("订单收货时间无效");
  }
  return receivedAt + refundTimeDays * 86_400 >= now;
}

function parseRefundTimeDays(value: string): number {
  const normalized = value.trim() || "0";
  if (!/^\d+$/.test(normalized)) throw new ValidateException("售后期限配置无效");
  const days = Number(normalized);
  if (!Number.isSafeInteger(days) || days > 36_500) {
    throw new ValidateException("售后期限配置无效");
  }
  return days;
}

/**
 * Allocate the authoritative order cash total over immutable cart snapshots,
 * then return only the newly selected quantity. BigInt keeps the proportional
 * allocation exact even near PostgreSQL numeric limits.
 */
export function calculateAuthoritativeRefundCents(
  paidCents: number,
  lines: RefundPricingLine[],
  completedQuantities: ReadonlyMap<number, number>,
  selections: ReadonlyArray<{ cartId: number; cartNum: number }>,
): number {
  if (!Number.isSafeInteger(paidCents) || paidCents < 0 || !lines.length) {
    throw new ValidateException("订单退款金额快照无效");
  }
  const seen = new Set<number>();
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.cartId) || line.cartId <= 0 || seen.has(line.cartId) ||
      !Number.isSafeInteger(line.cartNum) || line.cartNum <= 0 ||
      !Number.isSafeInteger(line.lineCents) || line.lineCents < 0
    ) {
      throw new ValidateException("订单退款商品快照无效");
    }
    seen.add(line.cartId);
  }

  const rawWeights = lines.map((line) => line.lineCents);
  const weights = rawWeights.some((weight) => weight > 0)
    ? rawWeights
    : lines.map((line) => line.cartNum);
  const totalWeight = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (totalWeight <= 0n) throw new ValidateException("订单退款商品金额无效");
  const total = BigInt(paidCents);
  const allocations = weights.map((weight) => Number(total * BigInt(weight) / totalWeight));
  const fractions = weights.map((weight, index) => ({
    index,
    remainder: total * BigInt(weight) % totalWeight,
  }));
  let centsLeft = paidCents - allocations.reduce((sum, value) => sum + value, 0);
  fractions.sort((left, right) =>
    left.remainder === right.remainder
      ? left.index - right.index
      : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; index < centsLeft; index += 1) {
    allocations[fractions[index].index] += 1;
  }

  const lineById = new Map(lines.map((line, index) => [line.cartId, { line, allocation: allocations[index] }]));
  let refundCents = 0;
  for (const selection of selections) {
    const entry = lineById.get(selection.cartId);
    if (!entry) throw new ValidateException("退款商品不属于当前订单");
    const completed = completedQuantities.get(selection.cartId) ?? 0;
    const end = completed + selection.cartNum;
    if (
      !Number.isSafeInteger(completed) || completed < 0 ||
      !Number.isSafeInteger(selection.cartNum) || selection.cartNum <= 0 ||
      end > entry.line.cartNum
    ) {
      throw new ValidateException("退款商品件数超过可退数量");
    }
    const allocation = BigInt(entry.allocation);
    const denominator = BigInt(entry.line.cartNum);
    const before = allocation * BigInt(completed) / denominator;
    const after = allocation * BigInt(end) / denominator;
    refundCents += Number(after - before);
  }
  if (!Number.isSafeInteger(refundCents) || refundCents < 0 || refundCents > paidCents) {
    throw new ValidateException("退款金额计算失败");
  }
  return refundCents;
}

function refundSnapshotLineCents(cart: typeof storeOrderCartInfo.$inferSelect): number {
  let snapshot: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(cart.cartInfo ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      snapshot = parsed as Record<string, unknown>;
    }
  } catch {
    snapshot = {};
  }
  const summed = amountToCents(String(snapshot.sum_true_price ?? snapshot.sumTruePrice ?? ""));
  if (summed !== null && summed >= 0) return summed;
  const product = snapshot.productInfo && typeof snapshot.productInfo === "object"
    ? snapshot.productInfo as Record<string, unknown>
    : {};
  const sku = snapshot.sku && typeof snapshot.sku === "object"
    ? snapshot.sku as Record<string, unknown>
    : {};
  const unit = amountToCents(String(
    snapshot.truePrice ?? snapshot.true_price ?? product.truePrice ?? product.price ?? sku.price ?? "",
  ));
  if (unit === null || unit < 0 || !Number.isSafeInteger(unit * cart.cartNum)) return 0;
  return unit * cart.cartNum;
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
  if (
    scope.expectedRefundedAmountCents !== undefined &&
    amountToCents(refund.refundedPrice) !== scope.expectedRefundedAmountCents
  ) {
    throw new ValidateException("历史已退款金额已变化，请刷新后重试");
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

async function recordRefundExecutionAuditOnce(
  tx: DbClient,
  orderId: number,
  auditInput?: RefundDecisionAudit,
): Promise<void> {
  if (!auditInput) return;
  const audit = normalizeRefundDecisionAudit(auditInput, auditInput);
  const existing = await tx
    .select({ id: storeOrderStatus.id })
    .from(storeOrderStatus)
    .where(and(
      eq(storeOrderStatus.oid, orderId),
      eq(storeOrderStatus.changeType, audit.changeType),
      eq(storeOrderStatus.changeMessage, audit.changeMessage),
    ))
    .limit(1);
  if (existing[0]) return;
  await tx.insert(storeOrderStatus).values({
    oid: orderId,
    changeType: audit.changeType,
    changeMessage: audit.changeMessage,
    changeTime: Math.floor(Date.now() / 1_000),
  });
}

async function lockRefundExecutionSnapshot(
  tx: DbClient,
  refundId: number,
  scope?: RefundExecutionScope,
) {
  const preliminary = (await tx
    .select()
    .from(storeOrderRefund)
    .where(eq(storeOrderRefund.id, refundId))
    .limit(1))[0];
  if (!preliminary) throw new NotFoundException("退款记录不存在");
  await scope?.authorizeBeforeRefundLock?.(tx, preliminary);
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
    const preliminary = (await tx
      .select()
      .from(storeOrderRefund)
      .where(eq(storeOrderRefund.id, refundId))
      .limit(1))[0];
    if (!preliminary) throw new NotFoundException("退款记录不存在");
    await scope?.authorizeBeforeRefundLock?.(tx, preliminary);
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

    const finalizedSelections = parseRefundCartSelections(refund.cartInfo);
    if (finalizedSelections.length) {
      let remaining = refund.refundNum;
      for (const selection of finalizedSelections) {
        const cartRows = await tx
          .select()
          .from(storeOrderCartInfo)
          .where(and(
            eq(storeOrderCartInfo.oid, order.id),
            or(
              eq(storeOrderCartInfo.id, selection.cartId),
              eq(storeOrderCartInfo.cartId, String(selection.cartId)),
            ),
          ))
          .limit(2);
        if (cartRows.length !== 1) throw new ValidateException("退款商品快照无法唯一定位");
        const quantity = selection.cartNum ?? Math.min(cartRows[0].cartNum, remaining);
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > remaining) {
          throw new ValidateException("退款商品数量与退款单不一致");
        }
        const updatedCart = await tx
          .update(storeOrderCartInfo)
          .set({ refundNum: sql`${storeOrderCartInfo.refundNum} + ${quantity}` })
          .where(and(
            eq(storeOrderCartInfo.id, cartRows[0].id),
            sql`${storeOrderCartInfo.refundNum} + ${quantity} <= ${storeOrderCartInfo.cartNum}`,
          ))
          .returning({ id: storeOrderCartInfo.id });
        if (!updatedCart[0]) throw new ValidateException("退款商品数量超过可退数量");
        remaining -= quantity;
      }
      if (remaining !== 0) throw new ValidateException("退款商品数量与退款单不一致");
    }

    if (order.status === 0) {
      await restoreRefundStock(tx, order, refund.refundNum, refund.cartInfo);
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
  if (
    ![1, 2].includes(params.applyType) &&
    !(params.applyType === 4 && params.privilegedActor === "admin")
  ) {
    throw new ValidateException("退款申请类型无效");
  }
  const refundReason = params.refundReason.trim();
  const refundExplain = params.refundExplain.trim();
  const refundImg = (params.refundImg ?? "").trim();
  const applicationOrderId = params.applicationOrderId?.trim() ?? "";
  if (!refundReason || refundReason.length > 255) throw new ValidateException("请填写有效的退款原因");
  if (refundExplain.length > 255 || refundImg.length > 8_192) {
    throw new ValidateException("退款说明或凭证信息过长");
  }
  if (applicationOrderId && (
    applicationOrderId.length > 50 ||
    !/^[A-Za-z0-9_-]+$/.test(applicationOrderId)
  )) {
    throw new ValidateException("退款申请幂等标识无效");
  }
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
    if (order.isDel !== 0 || order.isSystemDel !== 0) throw new NotFoundException("订单不存在");
    if (!order.paid) throw new ValidateException("订单未支付");
    if (order.supplierAllocationStatus === 1) {
      throw new ValidateException("订单正在按供应商分配，请稍后刷新");
    }
    if (order.pid === -1) throw new ValidateException("请从拆分后的履约子单申请售后");
    if (options.refundTimeDays > 0) {
      const receiptRows = await tx
        .select({ changeTime: storeOrderStatus.changeTime })
        .from(storeOrderStatus)
        .where(and(
          eq(storeOrderStatus.oid, order.id),
          inArray(storeOrderStatus.changeType, ["user_take_delivery", "take_delivery"]),
        ))
        .orderBy(desc(storeOrderStatus.changeTime), desc(storeOrderStatus.id))
        .limit(1);
      if (
        receiptRows[0] &&
        !isRefundWindowOpen(
          receiptRows[0].changeTime,
          options.refundTimeDays,
          Math.floor(Date.now() / 1000),
        )
      ) {
        throw new ValidateException("订单已超过售后期限");
      }
    }

    const previousRefunds = await tx
      .select()
      .from(storeOrderRefund)
      .where(eq(storeOrderRefund.storeOrderId, order.id))
      .orderBy(asc(storeOrderRefund.id));
    if (applicationOrderId) {
      const replayRows = previousRefunds.filter((item) => item.orderId === applicationOrderId);
      if (replayRows.length > 1) {
        throw new ValidateException("退款申请幂等记录重复，请先完成数据核对");
      }
      const replay = replayRows[0];
      if (replay) {
        if (
          replay.uid !== uid || replay.applyType !== params.applyType ||
          replay.refundReason !== refundReason || replay.refundExplain !== refundExplain ||
          (params.expectedRefundAmountCents !== undefined &&
            amountToCents(replay.refundPrice) !== params.expectedRefundAmountCents)
        ) {
          throw new ValidateException("退款申请幂等参数与首次请求不一致");
        }
        return { refundId: replay.id };
      }
    }
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

    let refundNum = Math.max(
      0,
      order.totalNum - completedRefunds.reduce((sum, item) => sum + item.refundNum, 0),
    );
    let refundCents = remainingCents;
    let refundCartIds: number[] = [];
    let refundCartSnapshot: Array<number | { cartId: number; cartNum: number }> = [];
    const cartInfos = await tx
      .select()
      .from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id))
      .orderBy(asc(storeOrderCartInfo.id));
    if (!cartInfos.length) throw new Error("订单缺少商品快照，不能安全申请退款");
    const cartByIdentifier = new Map<number, typeof cartInfos[number]>();
    for (const cart of cartInfos) {
      const legacyId = Number(cart.cartId);
      for (const identifier of [cart.id, legacyId]) {
        if (!Number.isSafeInteger(identifier) || identifier <= 0) continue;
        const existing = cartByIdentifier.get(identifier);
        if (existing && existing.id !== cart.id) {
          throw new ValidateException("订单退款商品标识存在歧义，请先完成数据核对");
        }
        cartByIdentifier.set(identifier, cart);
      }
    }
    const completedQuantities = new Map<number, number>();
    let completedWithoutCartSnapshot = false;
    for (const item of completedRefunds) {
      const selections = parseRefundCartSelections(item.cartInfo);
      if (!selections.length) {
        completedWithoutCartSnapshot = true;
        continue;
      }
      let remaining = item.refundNum;
      for (const selection of selections) {
        const cart = cartByIdentifier.get(selection.cartId);
        if (!cart) throw new ValidateException("历史退款商品快照无法定位");
        const canonicalId = Number(cart.cartId);
        if (!Number.isSafeInteger(canonicalId) || canonicalId <= 0) {
          throw new ValidateException("历史退款商品标识无效");
        }
        const quantity = selection.cartNum ?? Math.min(cart.cartNum, remaining);
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > remaining) {
          throw new ValidateException("历史退款商品数量无效");
        }
        completedQuantities.set(canonicalId, (completedQuantities.get(canonicalId) ?? 0) + quantity);
        remaining -= quantity;
      }
      if (remaining !== 0) throw new ValidateException("历史退款商品数量与退款单不一致");
    }
    if (completedWithoutCartSnapshot) {
      throw new ValidateException("历史整单退款已完成，不能再次申请退款");
    }
    const pricingLines = cartInfos.map((cart) => {
      const cartId = Number(cart.cartId);
      if (!Number.isSafeInteger(cartId) || cartId <= 0) {
        throw new ValidateException("订单退款商品标识无效");
      }
      return {
        cartId,
        cartNum: cart.cartNum,
        lineCents: refundSnapshotLineCents(cart),
      };
    });
    const remainingQuantity = pricingLines.reduce(
      (sum, line) => sum + line.cartNum - (completedQuantities.get(line.cartId) ?? 0),
      0,
    );
    if (!Number.isSafeInteger(remainingQuantity) || remainingQuantity <= 0) {
      throw new ValidateException("订单商品已全部退款");
    }

    const requested = params.cartSelections?.length
      ? params.cartSelections.map((item) => ({ cartId: Number(item.cartId), cartNum: Number(item.cartNum) }))
      : params.cartIds?.length
        ? params.cartIds.map((cartId) => ({ cartId: Number(cartId), cartNum: undefined }))
        : [];
    if (requested.length) {
      const selected = requested.map((selection) => {
        if (!Number.isSafeInteger(selection.cartId) || selection.cartId <= 0) {
          throw new ValidateException("退款商品无效或已经退款");
        }
        const cart = cartByIdentifier.get(selection.cartId);
        if (!cart) throw new ValidateException("退款商品不属于当前订单");
        const canonicalId = Number(cart.cartId);
        if (!Number.isSafeInteger(canonicalId) || canonicalId <= 0) {
          throw new ValidateException("退款商品标识无效");
        }
        return { selection, cart, canonicalId };
      });
      if (new Set(selected.map((item) => item.canonicalId)).size !== selected.length) {
        throw new ValidateException("退款商品不能重复选择");
      }
      if (selected.some(({ cart }) => cart.isSupportRefund !== 1)) {
        throw new ValidateException("所选商品不支持退款");
      }
      if (selected.some(({ cart }) => cart.writeTimes > cart.writeSurplusTimes)) {
        throw new ValidateException("所选商品已有核销记录，不能申请退款");
      }
      refundCartSnapshot = selected.map(({ selection, cart, canonicalId }) => {
        const available = cart.cartNum - (completedQuantities.get(canonicalId) ?? 0);
        const quantity = selection.cartNum ?? available;
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > available) {
          throw new ValidateException("退款商品件数超过可退数量");
        }
        return params.cartSelections?.length
          ? { cartId: canonicalId, cartNum: quantity }
          : canonicalId;
      });
      refundCartIds = selected.map((item) => item.canonicalId);
      refundNum = refundCartSnapshot.reduce<number>(
        (sum, item, index) => sum + (typeof item === "number"
          ? selected[index].cart.cartNum - (completedQuantities.get(item) ?? 0)
          : item.cartNum),
        0,
      );
      if (refundNum > order.totalNum) throw new ValidateException("退款数量超过订单商品总数");
      refundCents = pureIntegralOrder
        ? 0
        : refundNum === remainingQuantity
          ? remainingCents
          : Math.min(
              remainingCents,
              calculateAuthoritativeRefundCents(
                paidCents,
                pricingLines,
                completedQuantities,
                selected.map(({ canonicalId, selection, cart }) => ({
                  cartId: canonicalId,
                  cartNum: selection.cartNum
                    ?? cart.cartNum - (completedQuantities.get(canonicalId) ?? 0),
                })),
              ),
            );
    } else if (completedQuantities.size > 0) {
      const remainingCartInfos = cartInfos.filter(
        (item) => (completedQuantities.get(Number(item.cartId)) ?? 0) < item.cartNum,
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
      refundCartSnapshot = remainingCartInfos.map((item) => ({
        cartId: Number(item.cartId),
        cartNum: item.cartNum - (completedQuantities.get(Number(item.cartId)) ?? 0),
      }));
      refundNum = refundCartSnapshot.reduce<number>(
        (sum, item) => sum + (typeof item === "number" ? 0 : item.cartNum),
        0,
      );
      refundCents = pureIntegralOrder ? 0 : remainingCents;
    } else {
      if (cartInfos.some((item) => item.isSupportRefund !== 1)) {
        throw new ValidateException("订单包含不支持退款的商品");
      }
      if (cartInfos.some((item) => item.writeTimes > item.writeSurplusTimes)) {
        throw new ValidateException("订单已有核销记录，请仅选择未核销商品申请售后");
      }
      refundCartSnapshot = cartInfos.map((item) => {
        const cartId = Number(item.cartId);
        if (!Number.isSafeInteger(cartId) || cartId <= 0) {
          throw new ValidateException("订单退款商品标识无效");
        }
        return { cartId, cartNum: item.cartNum };
      });
      refundCartIds = refundCartSnapshot.map((item) => typeof item === "number" ? item : item.cartId);
    }
    if (refundNum <= 0 || (!pureIntegralOrder && refundCents <= 0)) {
      throw new ValidateException("没有可退款的商品或金额");
    }
    if (
      params.expectedRefundAmountCents !== undefined &&
      refundCents !== params.expectedRefundAmountCents
    ) {
      throw new ValidateException("退款金额与服务端可退金额不一致");
    }
    const refundPrice = centsToDecimal(refundCents);

    const now = Math.floor(Date.now() / 1000);
    const inserted = await tx
      .insert(storeOrderRefund)
      .values({
        storeOrderId: order.id,
        uid,
        supplierId: order.supplierId,
        orderId: applicationOrderId || `r${order.id}${now}`,
        applyType: params.applyType,
        applyPrice: refundPrice,
        refundType: 0,
        refundNum,
        refundPrice,
        refundReason,
        refundExplain,
        refundImg,
        cartInfo: JSON.stringify({ cartIds: refundCartSnapshot.length ? refundCartSnapshot : refundCartIds }),
        addTime: now,
      })
      .returning({ id: storeOrderRefund.id });
    if (!inserted[0]) throw new Error("退款申请写入失败");
    await tx.insert(storeOrderStatus).values({
      oid: order.id,
      changeType: "apply_refund",
      changeMessage: `用户申请退款，原因：${refundReason}`,
      changeTime: now,
    });
    if (params.audit) {
      if (
        !params.audit.changeType.trim() || params.audit.changeType.length > 32 ||
        !params.audit.changeMessage.trim() || params.audit.changeMessage.length > 256
      ) {
        throw new ValidateException("退款审计信息无效");
      }
      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: params.audit.changeType,
        changeMessage: params.audit.changeMessage,
        changeTime: now,
      });
    }
    return { refundId: inserted[0].id };
  });
}

export async function applyOrderRefund(
  container: Container,
  params: ApplyOrderRefundInput,
  refundTimeDays = 0,
): Promise<{ refundId: number }> {
  return createOrderRefundApplication(container, params, { reuseExisting: false, refundTimeDays });
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
  return createOrderRefundApplication(container, params, { reuseExisting: true, refundTimeDays: 0 });
}

function normalizeRefundDecisionAudit(
  audit: RefundDecisionAudit | undefined,
  fallback: RefundDecisionAudit,
): RefundDecisionAudit {
  const value = audit ?? fallback;
  if (
    !value.changeType.trim() || value.changeType.length > 32 ||
    !value.changeMessage.trim() || value.changeMessage.length > 256
  ) {
    throw new ValidateException("退款审计信息无效");
  }
  return value;
}

/** Approve a return shipment without initiating a monetary refund. */
export async function approveStoreOrderReturn(
  container: Container,
  refundId: number,
  scopeInput?: RefundExecutionScopeInput,
  auditInput?: RefundDecisionAudit,
): Promise<{ changed: boolean }> {
  if (!Number.isSafeInteger(refundId) || refundId <= 0) {
    throw new ValidateException("退款记录 ID 无效");
  }
  const scope = normalizeRefundExecutionScope(scopeInput);
  const audit = normalizeRefundDecisionAudit(auditInput, {
    changeType: "agree_refund_return",
    changeMessage: "管理员同意退货，等待用户寄回",
  });
  return withTx(container, async (tx) => {
    const { refund, order } = await lockRefundExecutionSnapshot(tx, refundId, scope);
    if (refund.isCancel || refund.isDel) throw new ValidateException("退款申请已取消或删除");
    if (![2, 3].includes(refund.applyType)) throw new ValidateException("该售后类型不需要退货");
    if (refund.refundType === 4) return { changed: false };
    if (![0, 1, 2].includes(refund.refundType)) {
      throw new ValidateException("售后状态不允许同意退货");
    }
    const payment = await getRefundPaymentRow(tx, refundId);
    if (payment && !["CREATED", "FAILED", "CLOSED"].includes(payment.providerStatus)) {
      throw new ValidateException("渠道退款已发起或结果待确认，不能同意退货");
    }
    const updated = await tx
      .update(storeOrderRefund)
      .set({ refundType: 4 })
      .where(and(
        eq(storeOrderRefund.id, refund.id),
        eq(storeOrderRefund.storeOrderId, order.id),
        eq(storeOrderRefund.refundType, refund.refundType),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      ))
      .returning({ id: storeOrderRefund.id });
    if (!updated[0]) throw new ValidateException("售后记录已被处理");
    const orderUpdated = await tx
      .update(storeOrder)
      .set({ refundStatus: 1, refundType: 4 })
      .where(and(
        eq(storeOrder.id, order.id),
        eq(storeOrder.uid, order.uid),
        eq(storeOrder.isSystemDel, order.isSystemDel),
        eq(storeOrder.isDel, order.isDel),
      ))
      .returning({ id: storeOrder.id });
    if (!orderUpdated[0]) throw new ValidateException("订单已被处理");
    await tx.insert(storeOrderStatus).values({
      oid: order.id,
      changeType: audit.changeType,
      changeMessage: audit.changeMessage,
      changeTime: Math.floor(Date.now() / 1_000),
    });
    return { changed: true };
  });
}

export class StoreOrderRefundService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private async resolveUserRefund(uid: number, identifier: string) {
    const value = identifier.trim();
    if (!value || value.length > 50) throw new ValidateException("退款单号无效");
    const numericId = Number(value);
    const predicate = Number.isSafeInteger(numericId) && numericId > 0
      ? or(eq(storeOrderRefund.id, numericId), eq(storeOrderRefund.orderId, value))
      : eq(storeOrderRefund.orderId, value);
    const rows = await this.container.db
      .select()
      .from(storeOrderRefund)
      .where(and(eq(storeOrderRefund.uid, uid), predicate))
      .limit(2);
    if (rows.length !== 1) throw new NotFoundException("退款记录不存在");
    return rows[0];
  }

  /**
   * 用户申请退款 (对应 PHP applyRefund)
   *
   * 注意: 不改 store_order.refund_status (与 PHP 一致, 仅创建 refund 记录)
   */
  async applyRefund(params: ApplyOrderRefundInput): Promise<{ refundId: number }> {
    const configured = await new SystemConfigService(this.container, this.env)
      .get("refund_time_available");
    return applyOrderRefund(this.container, params, parseRefundTimeDays(configured));
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
    const { refund, order } = await this.runInTx(c.db, async (tx) => {
      const snapshot = await lockRefundExecutionSnapshot(tx, refundId, scope);
      if (snapshot.refund.isCancel || snapshot.refund.isDel) {
        throw new ValidateException("退款申请已取消或删除");
      }
      if (
        snapshot.refund.refundType !== 6 &&
        ![0, 1, 2, 4, 5].includes(snapshot.refund.refundType)
      ) {
        throw new ValidateException("售后状态不允许退款");
      }
      await recordRefundExecutionAuditOnce(tx, snapshot.order.id, scope?.executionAudit);
      return snapshot;
    });
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
        emitOperationalEvent("error", {
          event: "refund_reconciliation_failed",
          component: "refund",
          operation: "reconciliation",
          outcome: "failure",
          errorCode: operationalErrorCode(error),
        });
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
    scopeInput?: RefundExecutionScopeInput,
    auditInput?: RefundDecisionAudit,
  ): Promise<void> {
    if (!Number.isSafeInteger(refundId) || refundId <= 0) {
      throw new ValidateException("退款记录 ID 无效");
    }
    const reason = refuseReason.trim();
    if (!reason || reason.length > 255) throw new ValidateException("请输入有效的拒绝原因");
    const scope = normalizeRefundExecutionScope(scopeInput);
    const audit = normalizeRefundDecisionAudit(auditInput, {
      changeType: "refund_n",
      changeMessage: `管理员拒绝退款：${reason}`.slice(0, 256),
    });
    await this.runInTx(this.container.db, async (tx) => {
      const now = Math.floor(Date.now() / 1_000);
      const { refund, order } = await lockRefundExecutionSnapshot(tx, refundId, scope);
      if (refund.isCancel || refund.isDel) throw new ValidateException("退款申请已取消或删除");
      if (refund.refundType === 3) {
        if (refund.refuseReason !== reason) {
          throw new ValidateException("售后已按其他原因拒绝，不能覆盖原决策");
        }
        return;
      }
      if (![0, 1, 2, 4, 5].includes(refund.refundType)) {
        throw new ValidateException("售后状态不允许拒绝");
      }
      const payment = await this.getPaymentRow(tx, refundId);
      if (
        payment &&
        !["CREATED", "FAILED", "CLOSED"].includes(payment.providerStatus)
      ) {
        throw new ValidateException("渠道退款已发起或结果待确认，不能拒绝售后");
      }
      const updated = await tx
        .update(storeOrderRefund)
        .set({ refundType: 3, refuseReason: reason, refundedTime: now })
        .where(
          and(
            eq(storeOrderRefund.id, refundId),
            eq(storeOrderRefund.storeOrderId, order.id),
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
        .where(and(
          eq(storeOrder.id, order.id),
          eq(storeOrder.uid, order.uid),
          eq(storeOrder.isSystemDel, order.isSystemDel),
          eq(storeOrder.isDel, order.isDel),
        ));
      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: audit.changeType,
        changeMessage: audit.changeMessage,
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

  async cancelApplyByIdentifier(uid: number, identifier: string): Promise<void> {
    const refund = await this.resolveUserRefund(uid, identifier);
    await this.cancelApply(uid, refund.id);
  }

  /** 用户提交退货物流；只允许已同意退货的本人售后单从 4 -> 5。 */
  async submitReturnExpress(uid: number, input: {
    id: number;
    refundExpress: string;
    refundPhone?: string;
    refundExpressName?: string;
    refundGoodsImg?: string;
    refundGoodsExplain?: string;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.id) || input.id <= 0) throw new ValidateException("参数错误");
    const express = input.refundExpress.trim();
    if (!express || express.length > 100) throw new ValidateException("请填写有效的退货快递单号");
    const phone = (input.refundPhone ?? "").trim();
    const expressName = (input.refundExpressName ?? "").trim();
    const goodsImg = (input.refundGoodsImg ?? "").trim();
    const goodsExplain = (input.refundGoodsExplain ?? "").trim();
    if (phone.length > 32 || expressName.length > 255 || goodsExplain.length > 255 || goodsImg.length > 8_192) {
      throw new ValidateException("退货物流信息过长");
    }
    await this.runInTx(this.container.db, async (tx) => {
      await this.lockRefund(tx, input.id);
      const rows = await tx
        .select()
        .from(storeOrderRefund)
        .where(and(eq(storeOrderRefund.id, input.id), eq(storeOrderRefund.uid, uid)))
        .limit(1)
        .for("update");
      const refund = rows[0];
      if (!refund || refund.isCancel || refund.isDel) throw new NotFoundException("退款记录不存在");
      if (refund.applyType !== 2 || refund.refundType !== 4) {
        throw new ValidateException("当前售后状态不能提交退货物流");
      }
      const updated = await tx
        .update(storeOrderRefund)
        .set({
          refundType: 5,
          refundExpress: express,
          refundPhone: phone,
          refundExpressName: expressName,
          refundGoodsImg: goodsImg,
          refundGoodsExplain: goodsExplain,
        })
        .where(and(
          eq(storeOrderRefund.id, input.id),
          eq(storeOrderRefund.uid, uid),
          eq(storeOrderRefund.refundType, 4),
          eq(storeOrderRefund.isCancel, 0),
          eq(storeOrderRefund.isDel, 0),
        ))
        .returning({ id: storeOrderRefund.id });
      if (!updated[0]) throw new ValidateException("售后状态已变化，请刷新后重试");
      await tx.insert(storeOrderStatus).values({
        oid: refund.storeOrderId,
        changeType: "refund_express",
        changeMessage: `用户已退货，快递单号：${express}`.slice(0, 256),
        changeTime: Math.floor(Date.now() / 1000),
      });
    });
  }

  /** 被拒售后再次申请；复制原权威商品/原因快照，不接受客户端改价。 */
  async reapply(uid: number, refundId: number): Promise<{ refundId: number }> {
    const previous = await this.resolveUserRefund(uid, String(refundId));
    if (previous.isCancel || previous.isDel || previous.refundType !== 3) {
      throw new ValidateException("当前售后状态不能再次申请");
    }
    const order = await this.container.storeOrderDao.get(previous.storeOrderId);
    if (!order || order.uid !== uid) throw new NotFoundException("订单不存在");
    const selections = parseRefundCartSelections(previous.cartInfo);
    const exact = selections.length && selections.every((item) => item.cartNum !== undefined)
      ? selections.map((item) => ({ cartId: item.cartId, cartNum: item.cartNum! }))
      : undefined;
    return this.applyRefund({
      uid,
      orderId: order.orderId,
      refundReason: previous.refundReason,
      refundExplain: previous.refundExplain,
      refundImg: previous.refundImg ?? "",
      applyType: previous.applyType,
      ...(exact ? { cartSelections: exact } : { cartIds: selections.map((item) => item.cartId) }),
    });
  }

  /** 用户删除已退款/已拒绝售后记录，同时按 PHP 合同隐藏对应订单。 */
  async deleteTerminal(uid: number, identifier: string): Promise<void> {
    const candidate = await this.resolveUserRefund(uid, identifier);
    await this.runInTx(this.container.db, async (tx) => {
      await this.lockRefund(tx, candidate.id);
      const rows = await tx
        .select()
        .from(storeOrderRefund)
        .where(and(eq(storeOrderRefund.id, candidate.id), eq(storeOrderRefund.uid, uid)))
        .limit(1)
        .for("update");
      const refund = rows[0];
      if (!refund || refund.isDel) throw new NotFoundException("退款记录不存在");
      if (![3, 6].includes(refund.refundType)) throw new ValidateException("当前状态不能删除退款单");
      await tx
        .update(storeOrderRefund)
        .set({ isDel: 1 })
        .where(and(eq(storeOrderRefund.id, refund.id), eq(storeOrderRefund.isDel, 0)));
      const orders = await tx
        .select()
        .from(storeOrder)
        .where(and(eq(storeOrder.id, refund.storeOrderId), eq(storeOrder.uid, uid)))
        .limit(1)
        .for("update");
      const order = orders[0];
      if (!order) throw new NotFoundException("订单不存在");
      await tx.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, order.id));
      if (order.pid > 0) {
        const remaining = await tx
          .select({ id: storeOrder.id })
          .from(storeOrder)
          .where(and(eq(storeOrder.pid, order.pid), eq(storeOrder.isDel, 0)))
          .limit(1);
        if (!remaining.length) {
          await tx
            .update(storeOrder)
            .set({ isDel: 1 })
            .where(and(eq(storeOrder.id, order.pid), eq(storeOrder.uid, uid)));
        }
      }
      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: "remove_refund_order",
        changeMessage: "用户删除终态售后记录",
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
  async detail(uid: number, refundId: number | string) {
    const refund = await this.resolveUserRefund(uid, String(refundId));
    return {
      ...refund,
      cartInfo: refund.cartInfo ? JSON.parse(refund.cartInfo) : null,
    };
  }

  /** 事务包装器 */
  private async runInTx<T>(_db: DbClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    // Keep the validated per-client search_path used by production-isolation
    // audits. Calling db.transaction directly would bypass withTx's SET LOCAL
    // and could silently fall through to public through Hyperdrive.
    return withTx(this.container, fn);
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
  order: Pick<typeof storeOrder.$inferSelect, "id" | "uid" | "type" | "activityId">,
  refundNum: number,
  cartInfoSnapshot: string | null,
): Promise<void> {
  const cartInfos = await tx
    .select()
    .from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, order.id));
  const requestedSelections = parseRefundCartSelections(cartInfoSnapshot);
  const selected = requestedSelections.length
    ? requestedSelections.map((selection) => {
        const matches = cartInfos.filter((item) =>
          item.id === selection.cartId || Number(item.cartId) === selection.cartId);
        if (matches.length !== 1) throw new ValidateException("退款商品快照无法唯一定位");
        return { row: matches[0], requestedNum: selection.cartNum };
      })
    : cartInfos.map((row) => ({ row, requestedNum: undefined }));
  let effectiveActivityId = order.activityId;
  let missingLegacyActivityMain = false;
  if (order.type === 1) {
    const rows = order.activityId > 0
      ? await tx.select({ id: storeSeckill.id }).from(storeSeckill)
          .where(eq(storeSeckill.id, order.activityId)).limit(1)
      : [];
    missingLegacyActivityMain = !rows[0];
  } else if (order.type === 2) {
    const directRows = order.activityId > 0
      ? await tx.select({ id: storeBargain.id }).from(storeBargain)
          .where(eq(storeBargain.id, order.activityId)).limit(1)
      : [];
    if (!directRows[0]) {
      const participants = await tx
        .select({ bargainId: storeBargainUser.bargainId })
        .from(storeBargainUser)
        .where(and(
          eq(storeBargainUser.uid, order.uid),
          eq(storeBargainUser.id, order.activityId),
        ))
        .limit(2);
      if (participants.length !== 1) {
        throw new ValidateException("退款砍价活动无法唯一定位");
      }
      effectiveActivityId = participants[0].bargainId;
      const rows = await tx.select({ id: storeBargain.id }).from(storeBargain)
        .where(eq(storeBargain.id, effectiveActivityId)).limit(1);
      missingLegacyActivityMain = !rows[0];
    }
  } else if (order.type === 3) {
    const rows = order.activityId > 0
      ? await tx.select({ id: storeCombination.id }).from(storeCombination)
          .where(eq(storeCombination.id, order.activityId)).limit(1)
      : [];
    missingLegacyActivityMain = !rows[0];
  }
  let remaining = refundNum;
  for (const { row: ci, requestedNum } of selected) {
    const num = requestedNum ?? Math.min(ci.cartNum, remaining);
    if (num <= 0) continue;
    if (!Number.isSafeInteger(num) || num > ci.cartNum || num > remaining) {
      throw new ValidateException("退款商品数量与退款单不一致");
    }
    remaining -= num;

    let baseSkuId = 0;
    let activitySkuId = 0;
    let legacyActivitySnapshot = false;
    try {
      const snapshot = JSON.parse(ci.cartInfo ?? "{}") as {
        sku?: { id?: unknown };
        activitySku?: { id?: unknown };
      };
      baseSkuId = Number(snapshot.sku?.id ?? 0);
      activitySkuId = Number(snapshot.activitySku?.id ?? 0);
      legacyActivitySnapshot = !Object.prototype.hasOwnProperty.call(snapshot, "activitySku")
        && Number.isSafeInteger(baseSkuId) && baseSkuId > 0;
    } catch {
      baseSkuId = 0;
      activitySkuId = 0;
      legacyActivitySnapshot = false;
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
      const baseSkuRows = await tx
        .update(storeProductAttrValue)
        .set({
          stock: sql`stock + ${num}`,
          sales: sql`GREATEST(sales - ${num}, 0)`,
        })
        .where(and(
          eq(storeProductAttrValue.id, baseSkuId),
          eq(storeProductAttrValue.productId, ci.productId),
          eq(storeProductAttrValue.type, 0),
        ))
        .returning({ id: storeProductAttrValue.id });
      if (!baseSkuRows[0]) throw new ValidateException("退款商品规格库存无法回退");
    }
    const productRows = await tx
      .update(storeProduct)
      .set({
        stock: sql`stock + ${num}`,
        sales: sql`GREATEST(sales - ${num}, 0)`,
      })
      .where(eq(storeProduct.id, ci.productId))
      .returning({ id: storeProduct.id });
    if (!productRows[0]) throw new ValidateException("退款商品库存无法回退");
    if ([1, 2, 3, 4].includes(order.type)) {
      const activityId = effectiveActivityId;
      if (!Number.isSafeInteger(activityId) || activityId <= 0) {
        throw new ValidateException("退款活动标识无效");
      }
      if (
        (!Number.isSafeInteger(activitySkuId) || activitySkuId <= 0)
        && !(missingLegacyActivityMain && legacyActivitySnapshot)
      ) {
        throw new ValidateException("退款活动商品规格快照缺失");
      }
      const activitySkuRows = Number.isSafeInteger(activitySkuId) && activitySkuId > 0
        ? await tx
            .update(storeProductAttrValue)
            .set({
              stock: sql`stock + ${num}`,
              quota: sql`quota + ${num}`,
              sales: sql`GREATEST(sales - ${num}, 0)`,
            })
            .where(
              and(
                eq(storeProductAttrValue.id, activitySkuId),
                eq(storeProductAttrValue.productId, activityId),
                eq(storeProductAttrValue.type, order.type),
              ),
            )
            .returning({ id: storeProductAttrValue.id })
        : [];
      const activityRows = order.type === 1
        ? await tx.update(storeSeckill).set({
            stock: sql`stock + ${num}`,
            quota: sql`quota + ${num}`,
            sales: sql`GREATEST(sales - ${num}, 0)`,
          }).where(eq(storeSeckill.id, activityId)).returning({ id: storeSeckill.id })
        : order.type === 2
          ? await tx.update(storeBargain).set({
              stock: sql`stock + ${num}`,
              quota: sql`quota + ${num}`,
              sales: sql`GREATEST(sales - ${num}, 0)`,
            }).where(eq(storeBargain.id, activityId)).returning({ id: storeBargain.id })
          : order.type === 3
            ? await tx.update(storeCombination).set({
                stock: sql`stock + ${num}`,
                quota: sql`quota + ${num}`,
                sales: sql`GREATEST(sales - ${num}, 0)`,
              }).where(eq(storeCombination.id, activityId)).returning({ id: storeCombination.id })
            : await tx.update(storeIntegral).set({
                stock: sql`stock + ${num}`,
                quota: sql`quota + ${num}`,
                sales: sql`GREATEST(sales - ${num}, 0)`,
              }).where(eq(storeIntegral.id, activityId)).returning({ id: storeIntegral.id });
      if (
        (!activitySkuRows[0] && !(missingLegacyActivityMain && legacyActivitySnapshot))
        || (!activityRows[0] && !missingLegacyActivityMain)
      ) {
        throw new ValidateException("活动商品库存无法完整回退");
      }
    }
  }
  if (remaining > 0) throw new ValidateException("退款商品快照与退款数量不一致");
}

function parseRefundCartSelections(value: string | null): RefundCartSelection[] {
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
    const selections = values.map((item) => {
        if (item !== null && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const cartId = Number(record.cartId ?? record.cart_id ?? record.id);
          const rawNum = record.cartNum ?? record.cart_num;
          return {
            cartId,
            ...(rawNum === undefined ? {} : { cartNum: Number(rawNum) }),
          };
        }
        return { cartId: Number(item) };
      })
      .filter((item) =>
        Number.isSafeInteger(item.cartId) && item.cartId > 0 &&
        (item.cartNum === undefined || (Number.isSafeInteger(item.cartNum) && item.cartNum > 0))
      );
    const seen = new Set<number>();
    return selections.filter((item) => {
      if (seen.has(item.cartId)) return false;
      seen.add(item.cartId);
      return true;
    });
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
