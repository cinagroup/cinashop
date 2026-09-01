import { and, desc, eq } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  storeOrder,
  storeOrderRefund,
} from "@/models/schema";
import { parseAdminOrderPrimaryId, parseAdminOrderNumber } from "@/services/admin/AdminMobileOrderReadService";
import {
  approveStoreOrderReturn,
  applyOrderRefund,
  StoreOrderRefundService,
  type RefundExecutionScope,
} from "@/services/order/StoreOrderRefundService";
import { StoreOrderPayService, PayType } from "@/services/order/StoreOrderPayService";
import { amountToCents } from "@/services/payment/RefundGateway";
import { assertPinkOrderPayable } from "@/services/activity/PinkLifecycleService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const ADMIN_REFUND_REASON = "管理员主动退款";
const MAX_CART_SELECTIONS = 100;

function validateAdminId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidateException("管理员身份不存在");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function actionType(value: unknown): 1 | 2 {
  const normalized = value === undefined || value === null || value === "" ? "1" : String(value).trim();
  if (normalized !== "1" && normalized !== "2") throw new ValidateException("退款修改状态错误");
  return Number(normalized) as 1 | 2;
}

function moneyCents(value: unknown, required: boolean): number | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ValidateException("请输入退款金额");
    return undefined;
  }
  const normalized = typeof value === "number" ? String(value) : String(value).trim();
  const cents = amountToCents(normalized);
  if (cents === null) throw new ValidateException("退款金额格式错误");
  return cents;
}

function refusalReason(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) {
    if (fallback) return fallback;
    throw new ValidateException("请输入拒绝原因");
  }
  const reason = String(value).trim();
  if (!reason) {
    if (fallback) return fallback;
    throw new ValidateException("请输入拒绝原因");
  }
  if (reason.length > 255 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new ValidateException("拒绝原因格式错误");
  }
  return reason;
}

function splitFlag(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  const normalized = String(value).trim();
  if (normalized === "0") return false;
  if (normalized === "1") return true;
  throw new ValidateException("拆分退款参数错误");
}

export function parseAdminRefundCartSelections(
  value: unknown,
): Array<{ cartId: number; cartNum: number }> {
  if (!Array.isArray(value)) throw new ValidateException("请选择商品");
  if (!value.length || value.length > MAX_CART_SELECTIONS) throw new ValidateException("请选择商品");
  const result = value.map((raw) => {
    const item = record(raw);
    const cartId = Number(item.cart_id ?? item.cartId);
    const cartNum = Number(item.cart_num ?? item.cartNum);
    if (
      !Number.isSafeInteger(cartId) || cartId <= 0 ||
      !Number.isSafeInteger(cartNum) || cartNum <= 0
    ) {
      throw new ValidateException("请重新选择商品，或件数");
    }
    return { cartId, cartNum };
  });
  if (new Set(result.map((item) => item.cartId)).size !== result.length) {
    throw new ValidateException("退款商品不能重复选择");
  }
  return result.sort((left, right) => left.cartId - right.cartId);
}

async function requestFingerprint(value: unknown): Promise<string> {
  const material = JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Exact privileged write contracts used by the embedded PHP admin client. */
export class AdminMobileRefundOperationService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private async orderByNumber(value: unknown) {
    const orderNo = parseAdminOrderNumber(value);
    const rows = await this.container.db
      .select()
      .from(storeOrder)
      .where(and(
        eq(storeOrder.orderId, orderNo),
        eq(storeOrder.isSystemDel, 0),
        eq(storeOrder.isDel, 0),
      ))
      .limit(2);
    if (!rows.length) throw new NotFoundException("订单不存在");
    if (rows.length > 1) throw new ValidateException("订单号存在重复记录，请先完成数据核对");
    return rows[0];
  }

  private async orderById(value: unknown) {
    const id = parseAdminOrderPrimaryId(value);
    const rows = await this.container.db
      .select()
      .from(storeOrder)
      .where(and(
        eq(storeOrder.id, id),
        eq(storeOrder.isSystemDel, 0),
        eq(storeOrder.isDel, 0),
      ))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("订单不存在");
    return rows[0];
  }

  private async refundByPublicNumber(value: unknown) {
    const refundNo = String(value ?? "").trim();
    if (!refundNo || refundNo.length > 50) throw new ValidateException("参数错误");
    const rows = await this.container.db
      .select({ refund: storeOrderRefund, order: storeOrder })
      .from(storeOrderRefund)
      .innerJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
      .where(and(
        eq(storeOrderRefund.orderId, refundNo),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        eq(storeOrder.isDel, 0),
      ))
      .orderBy(desc(storeOrderRefund.id))
      .limit(2);
    if (rows.length > 1) throw new ValidateException("售后单号存在重复记录，请先完成数据核对");
    return rows[0] ?? null;
  }

  private scope(
    refund: typeof storeOrderRefund.$inferSelect,
    order: typeof storeOrder.$inferSelect,
    expectedAmountCents?: number,
    executionAudit?: { changeType: string; changeMessage: string },
  ): RefundExecutionScope {
    return {
      expectedSupplierId: refund.supplierId,
      expectedUid: refund.uid,
      expectedRefundOrderId: refund.orderId,
      expectedStoreOrderId: order.id,
      expectedRefundAmountCents: expectedAmountCents,
      requireSystemVisible: true,
      requirePaid: true,
      executionAudit,
    };
  }

  private async activeRefund(order: typeof storeOrder.$inferSelect) {
    const rows = await this.container.db
      .select()
      .from(storeOrderRefund)
      .where(and(
        eq(storeOrderRefund.storeOrderId, order.id),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      ))
      .orderBy(desc(storeOrderRefund.id));
    const active = rows.filter((item) => [0, 1, 2, 4, 5].includes(item.refundType));
    if (active.length > 1) throw new ValidateException("订单存在多条进行中售后，请先完成数据核对");
    return active[0] ?? null;
  }

  async offline(adminIdValue: number, bodyValue: unknown) {
    const adminId = validateAdminId(adminIdValue);
    const body = record(bodyValue);
    const order = await this.orderByNumber(body.order_id);
    const result = await new StoreOrderPayService(this.container, this.env).applyPayment({
      orderId: order.id,
      payType: PayType.OFFLINE,
      allowAlreadyPaid: (locked) => locked.payType === PayType.OFFLINE,
      authorizeBeforePayment: async (tx, locked) => {
        if (
          locked.orderId !== order.orderId || locked.isSystemDel !== 0 || locked.isDel !== 0
        ) {
          throw new NotFoundException("订单不存在");
        }
        if (locked.pid !== 0 || locked.supplierAllocationStatus === 1) {
          throw new ValidateException("拆分或分配中的订单不能确认线下收款");
        }
        if (locked.paid === 0) await assertPinkOrderPayable(tx, locked);
      },
      audit: {
        changeType: "admin_order_offline",
        changeMessage: `管理员 ${adminId} 确认订单线下收款`,
      },
    });
    if (result.outcome === "missing") throw new NotFoundException("订单不存在");
    if (result.outcome === "not-payable") throw new ValidateException("订单状态不允许确认收款");
    return { paid: true, idempotent: result.outcome === "already-paid" };
  }

  async refund(adminIdValue: number, bodyValue: unknown) {
    const adminId = validateAdminId(adminIdValue);
    const body = record(bodyValue);
    const selector = String(body.order_id ?? "").trim();
    if (!selector || selector.length > 50) throw new ValidateException("参数错误");
    const type = actionType(body.type);
    const existing = await this.refundByPublicNumber(selector);
    if (!existing) {
      const order = await this.orderByNumber(selector);
      if (type === 2) return this.refuseActiveOrderRefund(adminId, order, body.refuse_reason);
      return this.proactiveRefund(adminId, order, body, []);
    }
    if (type === 2) {
      const reason = refusalReason(body.refuse_reason);
      await new StoreOrderRefundService(this.container, this.env).refuseRefund(
        existing.refund.id,
        reason,
        this.scope(existing.refund, existing.order),
        {
          changeType: "admin_refund_refuse",
          changeMessage: `管理员 ${adminId} 拒绝售后申请`,
        },
      );
      return { completed: true, status: "REFUSED" as const };
    }
    const authoritativeCents = amountToCents(existing.refund.refundPrice);
    if (authoritativeCents === null) throw new ValidateException("售后单退款金额无效");
    if (
      existing.refund.refundType !== 6 &&
      ![0, 1, 2, 5].includes(existing.refund.refundType) &&
      !(existing.refund.refundType === 4 && existing.refund.applyType === 3)
    ) {
      throw new ValidateException("售后订单状态不支持该操作");
    }
    const requestedCents = moneyCents(body.price, authoritativeCents > 0) ?? 0;
    if (requestedCents !== authoritativeCents) {
      throw new ValidateException("退款金额必须等于本售后单可退金额；部分退款请拆分为独立售后单");
    }
    const result = await new StoreOrderRefundService(this.container, this.env).agreeRefund(
      existing.refund.id,
      this.scope(existing.refund, existing.order, authoritativeCents, {
        changeType: "admin_refund_execute",
        changeMessage: `管理员 ${adminId} 提交资金退款，售后 ${existing.refund.id}`,
      }),
    );
    return result;
  }

  async agreeReturn(adminIdValue: number, refundIdValue: unknown) {
    const adminId = validateAdminId(adminIdValue);
    const refundId = parseAdminOrderPrimaryId(refundIdValue);
    return approveStoreOrderReturn(
      this.container,
      refundId,
      { requireSystemVisible: true },
      {
        changeType: "admin_refund_return",
        changeMessage: `管理员 ${adminId} 同意退货，等待用户寄回`,
      },
    );
  }

  async openRefund(adminIdValue: number, orderIdValue: unknown, bodyValue: unknown) {
    const adminId = validateAdminId(adminIdValue);
    const order = await this.orderById(orderIdValue);
    const body = record(bodyValue);
    if (actionType(body.type) === 2) {
      return this.refuseActiveOrderRefund(adminId, order, body.refuse_reason);
    }
    const selections = splitFlag(body.is_split_order)
      ? parseAdminRefundCartSelections(body.cart_ids)
      : [];
    return this.proactiveRefund(adminId, order, body, selections);
  }

  private async refuseActiveOrderRefund(
    adminId: number,
    order: typeof storeOrder.$inferSelect,
    reasonValue: unknown,
  ) {
    const active = await this.activeRefund(order);
    if (!active) throw new ValidateException("不存在待拒绝的售后申请");
    const reason = refusalReason(reasonValue, "管理员拒绝退款");
    await new StoreOrderRefundService(this.container, this.env).refuseRefund(
      active.id,
      reason,
      this.scope(active, order),
      {
        changeType: "admin_refund_refuse",
        changeMessage: `管理员 ${adminId} 拒绝售后申请`,
      },
    );
    return { completed: true, status: "REFUSED" as const };
  }

  private async proactiveRefund(
    adminId: number,
    order: typeof storeOrder.$inferSelect,
    body: Record<string, unknown>,
    selections: Array<{ cartId: number; cartNum: number }>,
  ) {
    const requestedCents = moneyCents(body.refund_price ?? body.price, true) ?? 0;
    const fingerprint = await requestFingerprint({
      v: 1,
      actor: adminId,
      route: "admin_order_proactive_refund",
      order: order.id,
      amount: requestedCents,
      carts: selections,
    });
    const applicationOrderId = `A${order.id}-${fingerprint.slice(0, 32)}`;
    const application = await applyOrderRefund(this.container, {
      uid: order.uid,
      orderId: order.orderId,
      refundReason: ADMIN_REFUND_REASON,
      refundExplain: ADMIN_REFUND_REASON,
      refundImg: "",
      applyType: 4,
      privilegedActor: "admin",
      expectedRefundAmountCents: requestedCents,
      applicationOrderId,
      ...(selections.length ? { cartSelections: selections } : {}),
      audit: {
        changeType: "admin_refund_apply",
        changeMessage: `管理员 ${adminId} 创建主动退款 ${fingerprint.slice(0, 32)}`,
      },
    });
    const rows = await this.container.db
      .select({ refund: storeOrderRefund, order: storeOrder })
      .from(storeOrderRefund)
      .innerJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
      .where(and(
        eq(storeOrderRefund.id, application.refundId),
        eq(storeOrderRefund.orderId, applicationOrderId),
        eq(storeOrder.id, order.id),
        eq(storeOrder.isSystemDel, 0),
        eq(storeOrder.isDel, 0),
      ))
      .limit(1);
    const created = rows[0];
    if (!created) throw new ValidateException("主动退款申请状态已变化，请刷新后重试");
    const result = await new StoreOrderRefundService(this.container, this.env).agreeRefund(
      created.refund.id,
      this.scope(created.refund, created.order, requestedCents, {
        changeType: "admin_refund_execute",
        changeMessage: `管理员 ${adminId} 提交主动资金退款 ${fingerprint.slice(0, 32)}`,
      }),
    );
    return {
      order_id: selections.length ? order.orderId : "",
      refund_order_id: created.refund.orderId,
      ...result,
    };
  }
}
