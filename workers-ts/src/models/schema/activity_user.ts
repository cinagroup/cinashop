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
    /** 当前砍后价 */
    bargainPrice: decimal("bargain_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 已砍掉金额 */
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 1参与中 2失败 3成功 */
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [index("sbu_uid").on(t.uid), index("sbu_bargain").on(t.bargainId)],
);
