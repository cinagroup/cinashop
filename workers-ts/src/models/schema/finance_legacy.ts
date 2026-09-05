/** Platform cash flow and dormant legacy store cash-flow ledgers. */
import { decimal, index, integer, pgTable, serial, smallint, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/** External cash movement; intentionally separate from user_bill balance/integral entries. */
export const capitalFlow = pgTable(
  "capital_flow",
  {
    id: serial("id").primaryKey(),
    eventKey: varchar("event_key", { length: 128 }),
    flowId: varchar("flow_id", { length: 32 }).default("").notNull(),
    orderId: varchar("order_id", { length: 50 }).default("").notNull(),
    storeId: integer("store_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    nickname: varchar("nickname", { length: 255 }).default("").notNull(),
    phone: varchar("phone", { length: 20 }).default("").notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    tradingType: smallint("trading_type").default(0).notNull(),
    payType: varchar("pay_type", { length: 32 }).default("").notNull(),
    mark: varchar("mark", { length: 500 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("cf_event_key_uq").on(t.eventKey),
    index("cf_flow_id").on(t.flowId),
    index("cf_order_id").on(t.orderId),
    index("cf_uid_type_time").on(t.uid, t.tradingType, t.addTime, t.id),
    index("cf_type_time").on(t.tradingType, t.addTime, t.id),
    index("cf_store_time").on(t.storeId, t.addTime, t.id),
  ],
);

/**
 * Store-specific cash ledger retained for historical import. The current PHP tree has no
 * model/service references, so it must not be folded into active platform or supplier ledgers.
 */
export const storeFinanceFlow = pgTable(
  "store_finance_flow",
  {
    id: serial("id").primaryKey(),
    storeId: integer("store_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    staffId: integer("staff_id").default(0).notNull(),
    orderId: varchar("order_id", { length: 20 }).default("").notNull(),
    linkId: varchar("link_id", { length: 50 }).default("").notNull(),
    pm: smallint("pm").default(0).notNull(),
    number: decimal("number", { precision: 12, scale: 2 }).default("0.00").notNull(),
    type: varchar("type", { length: 50 }).default("").notNull(),
    payType: varchar("pay_type", { length: 20 }).default("").notNull(),
    payPrice: decimal("pay_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    totalPrice: decimal("total_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    rate: smallint("rate").default(0).notNull(),
    tradeType: smallint("trade_type").default(1).notNull(),
    remark: varchar("remark", { length: 512 }).default("").notNull(),
    mark: varchar("mark", { length: 255 }).default("").notNull(),
    tradeTime: integer("trade_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [
    index("sff_store_type_time").on(t.storeId, t.type, t.addTime, t.id),
    index("sff_uid_time").on(t.uid, t.addTime, t.id),
    index("sff_staff_time").on(t.staffId, t.addTime, t.id),
    index("sff_order_id").on(t.orderId),
    index("sff_link_id").on(t.linkId),
  ],
);
