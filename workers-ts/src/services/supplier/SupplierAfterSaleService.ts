import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import {
  storeOrder,
  storeOrderRefund,
  storeOrderRefundPayment,
  storeOrderStatus,
} from "@/models/schema";
import { StoreOrderRefundService } from "@/services/order/StoreOrderRefundService";
import { parsePagination } from "@/services/supplier/SupplierService";
import { NotFoundException, ValidateException } from "@/utils/errors";

function parseCartInfo(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export class SupplierAfterSaleService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async list(supplierId: number, query: Record<string, string>) {
    const page = parsePagination(query.page, query.limit);
    const conditions: SQL[] = [
      eq(storeOrderRefund.supplierId, supplierId),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
      eq(storeOrder.supplierId, supplierId),
      eq(storeOrder.isSystemDel, 0),
    ];
    if (["0", "1", "2", "3", "4", "5", "6"].includes(query.refund_type ?? "")) {
      conditions.push(eq(storeOrderRefund.refundType, Number(query.refund_type)));
    }
    if (["1", "2", "3", "4"].includes(query.apply_type ?? "")) {
      conditions.push(eq(storeOrderRefund.applyType, Number(query.apply_type)));
    }
    const keyword = query.order_id?.trim() || query.keyword?.trim();
    if (keyword) {
      const search = or(
        ilike(storeOrderRefund.orderId, `%${keyword}%`),
        ilike(storeOrder.orderId, `%${keyword}%`),
        ilike(storeOrder.realName, `%${keyword}%`),
      );
      if (search) conditions.push(search);
    }
    const where = and(...conditions);
    const selection = {
      id: storeOrderRefund.id,
      refund_order_id: storeOrderRefund.orderId,
      store_order_id: storeOrderRefund.storeOrderId,
      order_id: storeOrder.orderId,
      real_name: storeOrder.realName,
      user_phone: storeOrder.userPhone,
      apply_type: storeOrderRefund.applyType,
      apply_price: storeOrderRefund.applyPrice,
      refund_type: storeOrderRefund.refundType,
      refund_num: storeOrderRefund.refundNum,
      refund_price: storeOrderRefund.refundPrice,
      refunded_price: storeOrderRefund.refundedPrice,
      refund_reason: storeOrderRefund.refundReason,
      refuse_reason: storeOrderRefund.refuseReason,
      remark: storeOrderRefund.remark,
      add_time: storeOrderRefund.addTime,
      refunded_time: storeOrderRefund.refundedTime,
      pay_type: storeOrder.payType,
      pay_price: storeOrder.payPrice,
      refund_provider: storeOrderRefundPayment.provider,
      provider_status: storeOrderRefundPayment.providerStatus,
      provider_refund_id: storeOrderRefundPayment.providerRefundId,
      out_refund_no: storeOrderRefundPayment.outRefundNo,
      provider_error: storeOrderRefundPayment.lastError,
      provider_update_time: storeOrderRefundPayment.updateTime,
    };
    const [list, count] = await Promise.all([
      this.container.db
        .select(selection)
        .from(storeOrderRefund)
        .innerJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
        .leftJoin(
          storeOrderRefundPayment,
          eq(storeOrderRefundPayment.refundId, storeOrderRefund.id),
        )
        .where(where)
        .orderBy(desc(storeOrderRefund.id))
        .limit(page.limit)
        .offset(page.offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeOrderRefund)
        .innerJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
        .where(where),
    ]);
    return { list, count: count[0]?.count ?? 0, page: page.page, limit: page.limit };
  }

  async detail(supplierId: number, refundId: number) {
    const rows = await this.container.db
      .select({ refund: storeOrderRefund, order: storeOrder, payment: storeOrderRefundPayment })
      .from(storeOrderRefund)
      .innerJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
      .leftJoin(
        storeOrderRefundPayment,
        eq(storeOrderRefundPayment.refundId, storeOrderRefund.id),
      )
      .where(
        and(
          eq(storeOrderRefund.id, refundId),
          eq(storeOrderRefund.supplierId, supplierId),
          eq(storeOrderRefund.isDel, 0),
          eq(storeOrder.supplierId, supplierId),
          eq(storeOrder.isSystemDel, 0),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new NotFoundException("售后记录不存在或不属于当前供应商");
    const { refund, order, payment } = rows[0];
    return {
      id: refund.id,
      refund_order_id: refund.orderId,
      store_order_id: refund.storeOrderId,
      order_id: order.orderId,
      real_name: order.realName,
      user_phone: order.userPhone,
      apply_type: refund.applyType,
      apply_price: refund.applyPrice,
      refund_type: refund.refundType,
      refund_num: refund.refundNum,
      refund_price: refund.refundPrice,
      refunded_price: refund.refundedPrice,
      refund_reason: refund.refundReason,
      refuse_reason: refund.refuseReason,
      remark: refund.remark,
      add_time: refund.addTime,
      refunded_time: refund.refundedTime,
      pay_type: order.payType,
      pay_price: order.payPrice,
      refund_provider: payment?.provider ?? null,
      provider_status: payment?.providerStatus ?? null,
      provider_refund_id: payment?.providerRefundId ?? null,
      out_refund_no: payment?.outRefundNo ?? null,
      provider_error: payment?.lastError ?? null,
      provider_update_time: payment?.updateTime ?? 0,
      cartInfo: parseCartInfo(refund.cartInfo),
      orderInfo: order,
    };
  }

  async updateRemark(supplierId: number, refundId: number, remark: string) {
    const normalized = remark.trim();
    if (!normalized) throw new ValidateException("请输入备注");
    if (normalized.length > 255) throw new ValidateException("备注不能超过 255 个字符");
    const rows = await this.container.db
      .update(storeOrderRefund)
      .set({ remark: normalized })
      .where(
        and(
          eq(storeOrderRefund.id, refundId),
          eq(storeOrderRefund.supplierId, supplierId),
          eq(storeOrderRefund.isCancel, 0),
          eq(storeOrderRefund.isDel, 0),
        ),
      )
      .returning({ id: storeOrderRefund.id });
    if (!rows[0]) throw new NotFoundException("售后记录不存在或不属于当前供应商");
  }

  async agreeReturn(supplierId: number, refundId: number) {
    await this.container.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: storeOrderRefund.id,
          storeOrderId: storeOrderRefund.storeOrderId,
          applyType: storeOrderRefund.applyType,
          refundType: storeOrderRefund.refundType,
        })
        .from(storeOrderRefund)
        .innerJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
        .where(
          and(
            eq(storeOrderRefund.id, refundId),
            eq(storeOrderRefund.supplierId, supplierId),
            eq(storeOrderRefund.isCancel, 0),
            eq(storeOrderRefund.isDel, 0),
            eq(storeOrder.supplierId, supplierId),
            eq(storeOrder.isSystemDel, 0),
          ),
        )
        .limit(1);
      const refund = rows[0];
      if (!refund) throw new NotFoundException("售后记录不存在或不属于当前供应商");
      if (![2, 3].includes(refund.applyType)) throw new ValidateException("该售后类型不需要退货");
      if (![0, 1, 2].includes(refund.refundType)) throw new ValidateException("售后状态不允许该操作");

      const updated = await tx
        .update(storeOrderRefund)
        .set({ refundType: 4 })
        .where(
          and(
            eq(storeOrderRefund.id, refundId),
            eq(storeOrderRefund.supplierId, supplierId),
            eq(storeOrderRefund.refundType, refund.refundType),
          ),
        )
        .returning({ id: storeOrderRefund.id });
      if (!updated[0]) throw new ValidateException("售后记录已被处理");
      await tx
        .update(storeOrder)
        .set({ refundStatus: 1, refundType: 4 })
        .where(
          and(
            eq(storeOrder.id, refund.storeOrderId),
            eq(storeOrder.supplierId, supplierId),
          ),
        );
      await tx.insert(storeOrderStatus).values({
        oid: refund.storeOrderId,
        changeType: "agree_refund_return",
        changeMessage: "供应商同意退货，等待用户寄回",
        changeTime: Math.floor(Date.now() / 1000),
      });
    });
  }

  async refuse(supplierId: number, refundId: number, reason: string) {
    const normalized = reason.trim();
    if (!normalized) throw new ValidateException("请输入拒绝原因");
    if (normalized.length > 255) throw new ValidateException("拒绝原因不能超过 255 个字符");
    await new StoreOrderRefundService(this.container, this.env).refuseRefund(
      refundId,
      normalized,
      supplierId,
    );
  }

  async refund(supplierId: number, refundId: number) {
    return new StoreOrderRefundService(this.container, this.env).agreeRefund(refundId, supplierId);
  }
}
