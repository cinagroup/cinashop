/**
 * 会员等级表 schema
 *
 * 对应 eb_system_user_level 表。
 * 用于计算会员折扣价 (getMinPrice 里的 discount)。
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  text,
} from "drizzle-orm/pg-core";

export const systemUserLevel = pgTable("system_user_level", {
  id: serial("id").primaryKey(),
  merId: integer("mer_id").default(0).notNull(),
  name: varchar("name", { length: 255 }).default("").notNull(),
  money: decimal("money", { precision: 12, scale: 2 }).default("0.00").notNull(),
  validDate: integer("valid_date").default(0).notNull(),
  isForever: smallint("is_forever").default(0).notNull(),
  isPay: smallint("is_pay").default(0).notNull(),
  isShow: smallint("is_show").default(0).notNull(),
  grade: integer("grade").default(0).notNull(),
  /** 享受折扣 (0-100, 90 = 9折) */
  discount: decimal("discount", { precision: 12, scale: 2 }).default("0.00").notNull(),
  image: varchar("image", { length: 255 }).default("").notNull(),
  color: varchar("color", { length: 32 }).default("").notNull(),
  icon: varchar("icon", { length: 255 }).default("").notNull(),
  explain: text("explain"),
  addTime: integer("add_time").default(0).notNull(),
  isDel: smallint("is_del").default(0).notNull(),
  expNum: integer("exp_num").default(0).notNull(),
});

export type SystemUserLevel = typeof systemUserLevel.$inferSelect;
