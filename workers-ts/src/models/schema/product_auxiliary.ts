/**
 * Source-shaped product auxiliary tables retained for historical import.
 *
 * The PHP runtime replaced these tables with store_product_relation. Worker
 * runtime code must not read or dual-write them as active authorities.
 */
import { index, integer, pgTable, serial, smallint, varchar } from "drizzle-orm/pg-core";

export const storeProductCategoryBrand = pgTable(
  "store_product_category_brand",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    cateId: integer("cate_id").default(0).notNull(),
    brandId: integer("brand_id").default(0).notNull(),
    brandName: varchar("brand_name", { length: 100 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("store_product_category_brand_cate_id").on(t.cateId)],
);

export const storeProductCate = pgTable("store_product_cate", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").default(0).notNull(),
  cateId: integer("cate_id").default(0).notNull(),
  addTime: integer("add_time").default(0).notNull(),
  catePid: integer("cate_pid").default(0).notNull(),
  status: smallint("status").default(0).notNull(),
});

export const storeProductLabelAuxiliary = pgTable(
  "store_product_label_auxiliary",
  {
    id: serial("id").primaryKey(),
    labelId: integer("label_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
  },
  (t) => [
    index("store_product_label_auxiliary_label_product").on(t.labelId, t.productId),
  ],
);

export type StoreProductCategoryBrand = typeof storeProductCategoryBrand.$inferSelect;
export type StoreProductCate = typeof storeProductCate.$inferSelect;
export type StoreProductLabelAuxiliary = typeof storeProductLabelAuxiliary.$inferSelect;
