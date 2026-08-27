import { index, integer, pgTable, serial, smallint, varchar } from "drizzle-orm/pg-core";

/** Source-compatible hierarchy for the DIY page-link picker. */
export const pageCategory = pgTable(
  "page_category",
  {
    id: serial("id").primaryKey(),
    pid: integer("pid").default(0).notNull(),
    type: varchar("type", { length: 50 }).default("link").notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    sort: smallint("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [index("page_category_tree_lookup").on(table.pid, table.sort, table.id)],
);

/** Static and custom navigation targets associated with a page category. */
export const pageLink = pgTable(
  "page_link",
  {
    id: serial("id").primaryKey(),
    cateId: integer("cate_id").default(0).notNull(),
    type: smallint("type").default(1).notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    url: varchar("url", { length: 255 }).default("").notNull(),
    param: varchar("param", { length: 255 }).default("").notNull(),
    example: varchar("example", { length: 255 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    sort: smallint("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [index("page_link_category_lookup").on(table.cateId, table.sort, table.id)],
);

export type PageCategory = typeof pageCategory.$inferSelect;
export type PageLink = typeof pageLink.$inferSelect;
