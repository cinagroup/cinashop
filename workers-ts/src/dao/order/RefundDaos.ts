/**
 * 退款 + 状态日志 Dao (M4)
 */
import { eq, and, sql } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { storeOrderRefund, storeOrderStatus } from "@/models/schema";

// ─── 退款记录 ────────────────────────────────────────────────
export class StoreOrderRefundDao extends BaseDao<typeof storeOrderRefund> {
  constructor(db: DB) {
    super(db, storeOrderRefund, {
      storeOrderId: (v) => eq(storeOrderRefund.storeOrderId, Number(v)),
      uid: (v) => eq(storeOrderRefund.uid, Number(v)),
      orderId: (v) => eq(storeOrderRefund.orderId, String(v)),
      isCancel: (v) => eq(storeOrderRefund.isCancel, Number(v)),
      isDel: (v) => eq(storeOrderRefund.isDel, Number(v)),
      refundType: (v) => eq(storeOrderRefund.refundType, Number(v)),
    });
  }

  /** 是否有进行中的退款 (对应 PHP applyRefund 第 275 行检查) */
  async hasOpenRefund(orderId: number): Promise<boolean> {
    // refund_type ∈ [0,1,2,4,5] 且 is_cancel=0 且 is_del=0
    const rows = await this.db
      .select({ id: storeOrderRefund.id })
      .from(storeOrderRefund)
      .where(
        and(
          eq(storeOrderRefund.storeOrderId, orderId),
          eq(storeOrderRefund.isCancel, 0),
          eq(storeOrderRefund.isDel, 0),
          sql`${storeOrderRefund.refundType} IN (0,1,2,4,5)`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** 按订单 ID 取退款记录 */
  async getByOrderId(orderId: number) {
    return this.db
      .select()
      .from(storeOrderRefund)
      .where(eq(storeOrderRefund.storeOrderId, orderId))
      .orderBy(sql`${storeOrderRefund.addTime} DESC`);
  }
}

// ─── 订单状态日志 ───────────────────────────────────────────
export class StoreOrderStatusDao extends BaseDao<typeof storeOrderStatus> {
  constructor(db: DB) {
    super(db, storeOrderStatus, {
      oid: (v) => eq(storeOrderStatus.oid, Number(v)),
      changeType: (v) => eq(storeOrderStatus.changeType, String(v)),
    });
  }

  /** 记录状态变更 (对应 PHP StoreOrderStatusServices::status) */
  async log(oid: number, changeType: string, changeMessage: string): Promise<void> {
    await this.db.insert(storeOrderStatus).values({
      oid,
      changeType,
      changeMessage,
      changeTime: Math.floor(Date.now() / 1000),
    });
  }

  /** 取订单最近一次某类型的状态 (定时任务用: 找发货/收货时间) */
  async getLastChange(oid: number, types: string[]) {
    const rows = await this.db
      .select()
      .from(storeOrderStatus)
      .where(
        and(
          eq(storeOrderStatus.oid, oid),
          sql`${storeOrderStatus.changeType} IN (${sql.join(
            types.map((t) => sql`${t}`),
            sql`,`,
          )})`,
        ),
      )
      .orderBy(sql`${storeOrderStatus.changeTime} DESC`)
      .limit(1);
    return rows[0] ?? null;
  }
}
