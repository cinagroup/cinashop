/** Source database-backed JSON cache documents. */
import { index, integer, pgTable, text, varchar } from "drizzle-orm/pg-core";

export const legacyCache = pgTable(
  "cache",
  {
    key: varchar("key", { length: 32 }).primaryKey(),
    result: text("result"),
    expireTime: integer("expire_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("cache_expire_time").on(t.expireTime, t.key)],
);

export type LegacyCache = typeof legacyCache.$inferSelect;
