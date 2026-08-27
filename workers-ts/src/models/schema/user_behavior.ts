/**
 * User search and visit evidence preserved from the PHP storefront.
 *
 * These tables intentionally retain epoch-second timestamps and source text
 * JSON so live import can copy malformed historical values without silently
 * rewriting them.
 */
import {
  index,
  integer,
  pgTable,
  serial,
  smallint,
  text,
  varchar,
} from "drizzle-orm/pg-core";

export const userSearch = pgTable(
  "user_search",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    keyword: varchar("keyword", { length: 255 }).default("").notNull(),
    vicword: varchar("vicword", { length: 1000 }).default("").notNull(),
    num: integer("num").default(1).notNull(),
    result: text("result"),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("user_search_uid_active_time").on(t.uid, t.isDel, t.addTime, t.num, t.id),
    index("user_search_uid_keyword_active").on(t.uid, t.keyword, t.isDel, t.addTime, t.id),
    index("user_search_keyword_cache").on(t.keyword, t.addTime, t.id),
  ],
);

export const userVisit = pgTable(
  "user_visit",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    url: varchar("url", { length: 255 }).default("").notNull(),
    ip: varchar("ip", { length: 255 }).default("").notNull(),
    stayTime: integer("stay_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    channelType: varchar("channel_type", { length: 255 }).default("").notNull(),
    province: varchar("province", { length: 255 }).default("").notNull(),
  },
  (t) => [
    index("user_visit_channel_time").on(t.channelType, t.addTime, t.id),
    index("user_visit_uid_time").on(t.uid, t.addTime, t.id),
    index("user_visit_province_time").on(t.province, t.addTime, t.id),
  ],
);

export type UserSearch = typeof userSearch.$inferSelect;
export type UserVisit = typeof userVisit.$inferSelect;
