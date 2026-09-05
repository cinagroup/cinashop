/**
 * 订单退款 + 状态日志 schema (M4)
 *
 * 对应:
 *   - eb_store_order_refund  退款记录 (含 refund_type 状态机)
 *   - eb_store_order_status  订单状态变更日志
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  text,
  index,
} from "drizzle-orm/pg-core";

// ─── 退款记录 ────────────────────────────────────────────────
export const storeOrderRefund = pgTable(
  "store_order_refund",
  {
    id: serial("id").primaryKey(),
    /** 关联 store_order.id (拆单后会被 repoint 到新订单) */
    storeOrderId: integer("store_order_id").default(0).notNull(),
    storeId: integer("store_id").default(0).notNull(),
    /** 退款单号 (新生成) */
    orderId: varchar("order_id", { length: 50 }).default("").notNull(),
    uid: integer("uid").default(0).notNull(),
    supplierId: integer("supplier_id").default(0).notNull(),
    /** 1=仅退款 2=退货退款(快递) 3=退货退款(到店) 4=平台退款 */
    applyType: smallint("apply_type").default(0).notNull(),
    applyPrice: decimal("apply_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 0未处理 3拒绝 4同意退货 5已退货 6已退款 */
    refundType: smallint("refund_type").default(0).notNull(),
    refundNum: integer("refund_num").default(0).notNull(),
    /** 可退金额 */
    refundPrice: decimal("refund_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 已退金额 (部分退款用) */
    refundedPrice: decimal("refunded_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    refundReason: varchar("refund_reason", { length: 255 }).default("").notNull(),
    /** 1=快递退回 2=到店退货；保留旧库原始选择。 */
    refundGoodsType: smallint("refund_goods_type").default(1).notNull(),
    refundPhone: varchar("refund_phone", { length: 32 }).default("").notNull(),
    refundExpress: varchar("refund_express", { length: 100 }).default("").notNull(),
    refundExpressName: varchar("refund_express_name", { length: 255 }).default("").notNull(),
    refundExplain: varchar("refund_explain", { length: 255 }).default("").notNull(),
    refundImg: text("refund_img"),
    refundGoodsExplain: varchar("refund_goods_explain", { length: 255 }).default("").notNull(),
    refundGoodsImg: text("refund_goods_img"),
    refuseReason: varchar("refuse_reason", { length: 255 }).default("").notNull(),
    remark: varchar("remark", { length: 255 }).default("").notNull(),
    refundedTime: integer("refunded_time").default(0).notNull(),
    /** JSON 快照: 退款的 cart 行 */
    cartInfo: text("cart_info"),
    /** 用户取消 */
    isCancel: smallint("is_cancel").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sor_store_order_id").on(t.storeOrderId),
    index("sor_uid").on(t.uid),
    index("sor_kefu_customer_refunds").on(t.uid, t.addTime.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.isCancel} = 0 AND ${t.isDel} = 0`),
    index("sor_order_id").on(t.orderId),
    index("sor_cancel_oid").on(t.isCancel, t.storeOrderId),
  ],
);

// ─── 订单状态日志 (对应 eb_store_order_status) ──────────────
export const storeOrderStatus = pgTable(
  "store_order_status",
  {
    id: serial("id").primaryKey(),
    oid: integer("oid").default(0).notNull(),
    /** 变更类型: create/pay/delivery_goods/take_delivery/refund_price/apply_refund 等 */
    changeType: varchar("change_type", { length: 32 }).default("").notNull(),
    changeMessage: varchar("change_message", { length: 256 }).default("").notNull(),
    changeTime: integer("change_time").default(0).notNull(),
  },
  (t) => [
    index("sos_oid").on(t.oid),
    index("sos_oid_change_time").on(t.oid, t.changeTime),
    index("sos_change_type").on(t.changeType),
    index("sos_change_time").on(t.changeTime),
  ],
);
