/**
 * 供应商财务域。
 *
 * 对应 PHP `eb_supplier_flowing_water`、`eb_supplier_transactions`
 * 与 `eb_supplier_extract`。金额精度统一提升到 12,2，交易单号增加唯一约束，
 * 用于保证支付回调、退款重试不会重复记账。
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

export const supplierFlowingWater = pgTable(
  "supplier_flowing_water",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    orderId: varchar("order_id", { length: 50 }).default("").notNull(),
    linkId: varchar("link_id", { length: 50 }).default("").notNull(),
    /** 0 支出，1 收入。 */
    pm: smallint("pm").default(0).notNull(),
    number: decimal("number", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 1 支付订单，2 退款订单。 */
    type: smallint("type").default(0).notNull(),
    payType: varchar("pay_type", { length: 20 }).default("").notNull(),
    payPrice: decimal("pay_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    totalPrice: decimal("total_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    payPostage: decimal("pay_postage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    remark: varchar("remark", { length: 512 }).default("").notNull(),
    finishTime: integer("finish_time").default(0).notNull(),
    /** 0 待结算，1 已结算，-1 无效。 */
    status: smallint("status").default(0).notNull(),
    mark: varchar("mark", { length: 255 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    tradeTime: integer("trade_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("sfw_order_id_uq").on(t.orderId),
    index("sfw_supplier_time").on(t.supplierId, t.addTime),
    index("sfw_supplier_status").on(t.supplierId, t.status, t.isDel),
  ],
);

export const supplierTransactions = pgTable(
  "supplier_transactions",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    orderId: varchar("order_id", { length: 50 }).default("").notNull(),
    linkId: varchar("link_id", { length: 50 }).default("").notNull(),
    pm: smallint("pm").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    payType: varchar("pay_type", { length: 20 }).default("").notNull(),
    payPrice: decimal("pay_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    totalPrice: decimal("total_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    payPostage: decimal("pay_postage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    remark: varchar("remark", { length: 512 }).default("").notNull(),
    mark: varchar("mark", { length: 255 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    tradeTime: integer("trade_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("stx_order_id_uq").on(t.orderId),
    index("stx_supplier_time").on(t.supplierId, t.addTime),
  ],
);

export const supplierExtract = pgTable(
  "supplier_extract",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id").default(0).notNull(),
    extractType: varchar("extract_type", { length: 32 }).default("bank").notNull(),
    bankCode: varchar("bank_code", { length: 32 }).default("").notNull(),
    bankAddress: varchar("bank_address", { length: 256 }).default("").notNull(),
    alipayAccount: varchar("alipay_account", { length: 64 }).default("").notNull(),
    wechat: varchar("wechat", { length: 32 }).default("").notNull(),
    qrcodeUrl: varchar("qrcode_url", { length: 255 }).default("").notNull(),
    extractPrice: decimal("extract_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    balance: decimal("balance", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** -1 拒绝，0 审核中，1 已通过。 */
    status: smallint("status").default(0).notNull(),
    /** 0 未转账，1 已转账。 */
    payStatus: smallint("pay_status").default(0).notNull(),
    supplierMark: varchar("supplier_mark", { length: 255 }).default("").notNull(),
    adminId: integer("admin_id").default(0).notNull(),
    failMsg: varchar("fail_msg", { length: 128 }).default("").notNull(),
    failTime: integer("fail_time").default(0).notNull(),
    voucherImage: varchar("voucher_image", { length: 256 }).default("").notNull(),
    voucherTitle: varchar("voucher_title", { length: 256 }).default("").notNull(),
    /** 管理员确认实际转账的时间。旧表缺少该字段，本次补齐审计证据。 */
    payTime: integer("pay_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("se_supplier_time").on(t.supplierId, t.addTime),
    index("se_supplier_status").on(t.supplierId, t.status, t.payStatus),
  ],
);

export type SupplierFlowingWater = typeof supplierFlowingWater.$inferSelect;
export type SupplierExtract = typeof supplierExtract.$inferSelect;
