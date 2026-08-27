import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/** CRMEB lottery activity definition. Historical rows intentionally have no FK/check constraints. */
export const luckLottery = pgTable(
  "luck_lottery",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(1).notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    desc: varchar("desc", { length: 255 }).default("").notNull(),
    image: varchar("image", { length: 255 }).default("").notNull(),
    factor: smallint("factor").default(1).notNull(),
    factorNum: smallint("factor_num").default(10).notNull(),
    attendsUser: smallint("attends_user").default(1).notNull(),
    userLevel: text("user_level"),
    userLabel: text("user_label"),
    isSvip: smallint("is_svip").default(1).notNull(),
    prizeNum: smallint("prize_num").default(0).notNull(),
    startTime: integer("start_time").default(0).notNull(),
    endTime: integer("end_time").default(0).notNull(),
    lotteryNumTerm: smallint("lottery_num_term").default(1).notNull(),
    lotteryNum: smallint("lottery_num").default(1).notNull(),
    totalLotteryNum: smallint("total_lottery_num").default(1).notNull(),
    spreadNum: smallint("spread_num").default(1).notNull(),
    isAllRecord: smallint("is_all_record").default(1).notNull(),
    isPersonalRecord: smallint("is_personal_record").default(1).notNull(),
    isContent: smallint("is_content").default(1).notNull(),
    content: text("content"),
    status: smallint("status").default(1).notNull(),
    sort: smallint("sort").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("luck_lottery_type").on(table.type),
    index("luck_lottery_factor_active").on(
      table.factor,
      table.status,
      table.isDel,
      table.startTime,
      table.endTime,
      table.id,
    ),
  ],
);

export const luckPrize = pgTable(
  "luck_prize",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(1).notNull(),
    lotteryId: integer("lottery_id").default(0).notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    prompt: varchar("prompt", { length: 255 }).default("").notNull(),
    image: varchar("image", { length: 255 }).default("").notNull(),
    chance: smallint("chance").default(10).notNull(),
    total: smallint("total").default(1).notNull(),
    couponId: integer("coupon_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    unique: varchar("unique", { length: 20 }).default("").notNull(),
    num: numeric("num", { precision: 12, scale: 2 }).default("0.00").notNull(),
    sort: smallint("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("luck_prize_lottery").on(table.lotteryId),
    index("luck_prize_draw").on(
      table.lotteryId,
      table.status,
      table.isDel,
      table.sort,
      table.id,
    ),
  ],
);

export const luckLotteryRecord = pgTable(
  "luck_lottery_record",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    oid: integer("oid").default(0),
    lotteryId: integer("lottery_id").default(0).notNull(),
    prizeId: integer("prize_id").default(0).notNull(),
    type: smallint("type").default(1).notNull(),
    prizeInfo: text("prize_info"),
    isReceive: smallint("is_receive").default(0).notNull(),
    receiveTime: integer("receive_time").default(0).notNull(),
    receiveInfo: text("receive_info"),
    isDeliver: smallint("is_deliver").default(0).notNull(),
    deliverTime: integer("deliver_time").default(0).notNull(),
    deliverInfo: text("deliver_info"),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("luck_lottery_record_uid").on(table.uid),
    index("luck_lottery_record_prize").on(table.prizeId),
    index("luck_lottery_record_lottery").on(table.lotteryId),
    index("luck_lottery_record_user_activity_time").on(
      table.uid,
      table.lotteryId,
      table.addTime,
      table.id,
    ),
  ],
);

/** Durable, idempotent replacement for PHP's ephemeral order/review ticket cache. */
export const luckLotteryEntitlement = pgTable(
  "luck_lottery_entitlement",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").notNull(),
    factor: smallint("factor").notNull(),
    sourceType: varchar("source_type", { length: 16 }).notNull(),
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    sourceKey: varchar("source_key", { length: 128 }).notNull(),
    amount: integer("amount").notNull(),
    remaining: integer("remaining").notNull(),
    expiresAt: integer("expires_at").notNull(),
    addTime: integer("add_time").notNull(),
    updateTime: integer("update_time").notNull(),
  },
  (table) => [
    uniqueIndex("luck_lottery_entitlement_source_uq").on(table.sourceKey),
    index("luck_lottery_entitlement_available")
      .on(table.uid, table.factor, table.expiresAt, table.id)
      .where(sql`${table.remaining} > 0`),
    check("luck_lottery_entitlement_factor_ck", sql`${table.factor} IN (3, 4)`),
    check("luck_lottery_entitlement_amount_ck", sql`${table.amount} > 0`),
    check(
      "luck_lottery_entitlement_remaining_ck",
      sql`${table.remaining} >= 0 AND ${table.remaining} <= ${table.amount}`,
    ),
  ],
);

export type LuckLottery = typeof luckLottery.$inferSelect;
export type LuckPrize = typeof luckPrize.$inferSelect;
export type LuckLotteryRecord = typeof luckLotteryRecord.$inferSelect;
