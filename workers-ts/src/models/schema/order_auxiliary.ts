/**
 * 订单解释与对账辅助表。
 *
 * 这些表保存优惠来源、开票快照和逐次核销记录，不能折叠到订单主表的汇总字段。
 */
import {
  decimal,
  index,
  integer,
  pgTable,
  serial,
  smallint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const storeOrderEconomize = pgTable(
  "store_order_economize",
  {
    id: serial("id").primaryKey(),
    orderId: varchar("order_id", { length: 32 }).default("").notNull(),
    uid: integer("uid").default(0).notNull(),
    orderType: smallint("order_type").default(1).notNull(),
    payPrice: decimal("pay_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    postagePrice: decimal("postage_price", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    memberPrice: decimal("member_price", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    offlinePrice: decimal("offline_price", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    couponPrice: decimal("coupon_price", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    addTime: integer("add_time").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("soe_order_uid_uq").on(t.orderId, t.uid),
    index("soe_uid_time").on(t.uid, t.addTime),
    index("soe_status_time").on(t.status, t.addTime),
  ],
);

export const storeOrderInvoice = pgTable(
  "store_order_invoice",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    category: varchar("category", { length: 10 }).default("order").notNull(),
    /** store_order.id, not the public order number. */
    orderId: integer("order_id").default(0).notNull(),
    invoiceId: integer("invoice_id").default(0).notNull(),
    headerType: smallint("header_type").default(1).notNull(),
    type: smallint("type").default(1).notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    dutyNumber: varchar("duty_number", { length: 50 }).default("").notNull(),
    drawerPhone: varchar("drawer_phone", { length: 30 }).default("").notNull(),
    email: varchar("email", { length: 100 }).default("").notNull(),
    tell: varchar("tell", { length: 30 }).default("").notNull(),
    address: varchar("address", { length: 255 }).default("").notNull(),
    bank: varchar("bank", { length: 50 }).default("").notNull(),
    cardNumber: varchar("card_number", { length: 50 }).default("").notNull(),
    isPay: smallint("is_pay").default(0).notNull(),
    isRefund: smallint("is_refund").default(0).notNull(),
    /** -1 rejected, 0 pending, 1 issued. */
    isInvoice: smallint("is_invoice").default(0).notNull(),
    invoiceNumber: varchar("invoice_number", { length: 50 }).default("").notNull(),
    invoiceAmount: decimal("invoice_amount", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    remark: varchar("remark", { length: 255 }).default("").notNull(),
    invoiceTime: integer("invoice_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("soi_order").on(t.orderId),
    index("soi_uid_state_time").on(t.uid, t.isDel, t.isRefund, t.addTime),
    index("soi_issue_state_time").on(t.isPay, t.isDel, t.isInvoice, t.addTime),
  ],
);

export const storeOrderPromotions = pgTable(
  "store_order_promotions",
  {
    id: serial("id").primaryKey(),
    oid: integer("oid").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    promotionsId: integer("promotions_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    promotionsPrice: decimal("promotions_price", { precision: 12, scale: 2 })
      .default("0.00")
      .notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sop_order_promotion").on(t.oid, t.promotionsId),
    index("sop_order_product").on(t.oid, t.productId),
    index("sop_uid_time").on(t.uid, t.addTime),
  ],
);

export const storeOrderWriteoff = pgTable(
  "store_order_writeoff",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    oid: integer("oid").default(0).notNull(),
    orderCartId: integer("order_cart_id").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    staffId: integer("staff_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    writeoffNum: integer("writeoff_num").default(1).notNull(),
    writeoffPrice: decimal("writeoff_price", { precision: 10, scale: 2 })
      .default("0.00")
      .notNull(),
    writeoffCode: varchar("writeoff_code", { length: 30 }).default("").notNull(),
    isAdmin: smallint("is_admin").default(0).notNull(),
    adminId: integer("admin_id").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sow_order_time").on(t.oid, t.addTime),
    index("sow_cart_time").on(t.orderCartId, t.addTime),
    index("sow_uid_time").on(t.uid, t.addTime),
    index("sow_code").on(t.writeoffCode),
    index("sow_operator_time").on(t.type, t.relationId, t.staffId, t.addTime),
  ],
);
