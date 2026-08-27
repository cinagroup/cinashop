/**
 * Paid membership, activation-card inventory, and membership order evidence.
 * Mirrors PHP member_card/member_card_batch/member_ship/other_order tables.
 */
import {
  char,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  varchar,
} from "drizzle-orm/pg-core";

export const memberCardBatch = pgTable(
  "member_card_batch",
  {
    id: serial("id").primaryKey(),
    title: varchar("title", { length: 100 }).default("0").notNull(),
    totalNum: integer("total_num").default(0).notNull(),
    useStartTime: integer("use_start_time").default(7).notNull(),
    useEndTime: integer("use_end_time").default(0).notNull(),
    useDay: integer("use_day").default(0).notNull(),
    useNum: integer("use_num").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    qrcode: varchar("qrcode", { length: 255 }).default("").notNull(),
    remark: varchar("remark", { length: 512 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    index("member_card_batch_status_sort").on(table.status, table.sort, table.id),
  ],
);

export const memberCard = pgTable(
  "member_card",
  {
    id: serial("id").notNull(),
    cardBatchId: integer("card_batch_id").default(0).notNull(),
    cardNumber: varchar("card_number", { length: 20 }).default("").notNull(),
    cardPassword: char("card_password", { length: 12 }).default("").notNull(),
    useUid: integer("use_uid").default(0).notNull(),
    useTime: integer("use_time").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({ name: "member_card_pk", columns: [table.id, table.cardBatchId] }),
    // Source does not declare card_number unique. Runtime rejects ambiguous
    // historical numbers instead of silently choosing one row.
    index("member_card_number_lookup").on(table.cardNumber),
    index("member_card_batch_status_use").on(
      table.cardBatchId,
      table.status,
      table.useTime,
      table.id,
    ),
    index("member_card_user_use").on(table.useUid, table.useTime, table.id),
  ],
);

export const memberShip = pgTable(
  "member_ship",
  {
    id: serial("id").primaryKey(),
    type: varchar("type", { length: 20 }).default("month").notNull(),
    title: varchar("title", { length: 200 }).default("").notNull(),
    vipDay: integer("vip_day").default(0).notNull(),
    price: numeric("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    prePrice: numeric("pre_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    isLabel: smallint("is_label").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("member_ship_active_sort").on(table.isDel, table.sort, table.id),
    index("member_ship_type").on(table.type, table.isDel),
  ],
);

export const otherOrder = pgTable(
  "other_order",
  {
    id: serial("id").primaryKey(),
    storeId: integer("store_id").default(0).notNull(),
    staffId: integer("staff_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    orderId: varchar("order_id", { length: 32 }).default("").notNull(),
    memberType: varchar("member_type", { length: 10 }).default("").notNull(),
    code: varchar("code", { length: 20 }).default("").notNull(),
    payType: varchar("pay_type", { length: 32 }).default("").notNull(),
    paid: smallint("paid").default(0).notNull(),
    payPrice: numeric("pay_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    memberPrice: numeric("member_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    payTime: integer("pay_time").default(0).notNull(),
    tradeNo: varchar("trade_no", { length: 50 }).default("").notNull(),
    channelType: varchar("channel_type", { length: 10 }).default("").notNull(),
    isFree: smallint("is_free").default(0).notNull(),
    isPermanent: smallint("is_permanent").default(0).notNull(),
    overdueTime: integer("overdue_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    vipDay: integer("vip_day").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    money: numeric("money", { precision: 12, scale: 2 }).default("0.00").notNull(),
    remarks: varchar("remarks", { length: 255 }).default("").notNull(),
  },
  (table) => [
    // Historical order_id duplicates remain importable; new SequenceDO values
    // are unique but the migration does not invent a legacy constraint.
    index("other_order_order_id").on(table.orderId),
    index("other_order_uid_time").on(table.uid, table.addTime, table.id),
    index("other_order_paid_time").on(table.paid, table.payTime, table.id),
    index("other_order_type_paid").on(table.type, table.paid, table.id),
  ],
);

export const otherOrderStatus = pgTable(
  "other_order_status",
  {
    oid: integer("oid").default(0).notNull(),
    changeType: varchar("change_type", { length: 32 }).default("").notNull(),
    changeMessage: varchar("change_message", { length: 256 }).default("").notNull(),
    shopType: smallint("shop_type").default(1).notNull(),
    changeTime: integer("change_time").default(0).notNull(),
  },
  (table) => [
    index("other_order_status_oid_time").on(table.oid, table.changeTime),
    index("other_order_status_type_time").on(table.changeType, table.changeTime),
  ],
);

export type MemberCard = typeof memberCard.$inferSelect;
export type MemberCardBatch = typeof memberCardBatch.$inferSelect;
export type MemberShip = typeof memberShip.$inferSelect;
export type OtherOrder = typeof otherOrder.$inferSelect;
export type OtherOrderStatus = typeof otherOrderStatus.$inferSelect;
