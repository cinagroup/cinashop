/**
 * Newcomer-exclusive catalog migrated from the PHP storefront.
 *
 * Activity SKU rows are stored in store_product_attr_value with type=7 and
 * product_id pointing at this table. Their `suk` maps to the base type=0 SKU,
 * which remains the only stock authority.
 */
import {
  decimal,
  index,
  integer,
  pgTable,
  serial,
  smallint,
} from "drizzle-orm/pg-core";

export const storeNewcomer = pgTable(
  "store_newcomer",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    otPrice: decimal("ot_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    sales: integer("sales").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("store_newcomer_product_id").on(t.productId),
    index("store_newcomer_active_id").on(t.isDel, t.id),
    index("store_newcomer_product_active").on(t.productId, t.isDel, t.id),
  ],
);

export type StoreNewcomer = typeof storeNewcomer.$inferSelect;
