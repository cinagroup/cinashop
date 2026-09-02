/**
 * 搜索热词 schema
 *
 * 对应 eb_store_product_words
 */
import {
  index,
  pgTable,
  serial,
  varchar,
  integer,
  smallint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const storeProductWords = pgTable("store_product_words", {
  id: serial("id").primaryKey(),
  /** 0平台 2供应商 */
  type: smallint("type").default(0).notNull(),
  relationId: integer("relation_id").default(0).notNull(),
  name: varchar("name", { length: 128 }).default("").notNull(),
  color: varchar("color", { length: 32 }).default("").notNull(),
  bgColor: varchar("bg_color", { length: 32 }).default("").notNull(),
  borderColor: varchar("border_color", { length: 32 }).default("").notNull(),
  icon: varchar("icon", { length: 128 }).default("").notNull(),
  isShow: smallint("is_show").default(0).notNull(),
  sort: smallint("sort").default(0).notNull(),
  isSearch: smallint("is_search").default(0).notNull(),
  isHot: smallint("is_hot").default(0).notNull(),
  isDel: smallint("is_del").default(0).notNull(),
  addTime: integer("add_time").default(0).notNull(),
}, (t) => [
  index("spw_owner_active_sort")
    .on(t.type, t.relationId, t.isDel, t.sort.desc(), t.id.desc()),
  index("spw_public_visible_sort")
    .on(t.sort.desc(), t.id.desc())
    .where(sql`${t.type} = 0 AND ${t.relationId} = 0 AND ${t.isDel} = 0 AND ${t.isShow} = 1`),
]);
