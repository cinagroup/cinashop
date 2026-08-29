/**
 * 拼团/砍价参与 schema
 *
 * 对应 eb_store_pink (拼团团) + eb_store_bargain_user (砍价参与)
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** 拼团团 (已建, 补充字段) — 直接使用现有 */
export const storePinkFull = pgTable(
  "store_pink_full",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    orderId: varchar("order_id", { length: 32 }).default("").notNull(),
    orderIdKey: varchar("order_id_key", { length: 32 }).default("").notNull(),
    combinationId: integer("combination_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    kId: integer("k_id").default(0).notNull(),
    people: integer("people").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    stopTime: timestamp("stop_time", { mode: "date" }),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("spf_combo").on(t.combinationId), index("spf_kid").on(t.kId)],
);

/** 砍价参与记录 */
export const storeBargainUser = pgTable(
  "store_bargain_user",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    bargainId: integer("bargain_id").default(0).notNull(),
    bargainPriceMin: decimal("bargain_price_min", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 开始参与时的原始砍价；当前价 = bargain_price - price。 */
    bargainPrice: decimal("bargain_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 已砍掉金额 */
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 1参与中 2失败 3可购买 4已创建订单 */
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [
    index("sbu_uid").on(t.uid),
    index("sbu_bargain").on(t.bargainId),
    index("sbu_uid_bargain_active")
      .on(t.uid, t.bargainId, t.status, t.id)
      .where(sql`${t.isDel} = 0`),
  ],
);

/** 砍价帮助明细；历史表只以 id 唯一，运行时用事务锁阻止新的重复帮助。 */
export const storeBargainUserHelp = pgTable(
  "store_bargain_user_help",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    bargainId: integer("bargain_id").default(0).notNull(),
    bargainUserId: integer("bargain_user_id").default(0).notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    /** 1=发起者自己砍，0=好友帮砍。 */
    type: smallint("type").default(0).notNull(),
  },
  (t) => [
    index("sbuh_participation").on(t.bargainUserId, t.id),
    index("sbuh_helper_activity").on(t.uid, t.bargainId, t.type),
  ],
);
