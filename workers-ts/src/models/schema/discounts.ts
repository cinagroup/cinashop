/** Legacy bundle/discount packages and their product snapshots. */
import { index, integer, pgTable, serial, smallint, text, varchar } from "drizzle-orm/pg-core";

export const storeDiscounts = pgTable(
  "store_discounts",
  {
    id: serial("id").primaryKey(),
    title: varchar("title", { length: 255 }).default("").notNull(),
    image: varchar("image", { length: 500 }).default("").notNull(),
    /** 0=fixed bundle, 1=mix-and-match bundle. */
    type: smallint("type").default(0).notNull(),
    isLimit: smallint("is_limit").default(0).notNull(),
    limitNum: integer("limit_num").default(0).notNull(),
    linkIds: varchar("link_ids", { length: 255 }).default("").notNull(),
    productIds: varchar("product_ids", { length: 255 }).default("").notNull(),
    isTime: smallint("is_time").default(0).notNull(),
    startTime: integer("start_time").default(0).notNull(),
    stopTime: integer("stop_time").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    freeShipping: smallint("free_shipping").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    isSupportRefund: smallint("is_support_refund").default(1).notNull(),
    deliveryType: varchar("delivery_type", { length: 10 }).default("").notNull(),
    freight: smallint("freight").default(2).notNull(),
    customForm: text("custom_form"),
  },
  (t) => [
    index("sd_active_window").on(t.status, t.isDel, t.isLimit, t.startTime, t.stopTime),
    index("sd_sort_id").on(t.sort, t.id),
  ],
);

export const storeDiscountsProducts = pgTable(
  "store_discounts_products",
  {
    id: serial("id").primaryKey(),
    discountId: integer("discount_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    title: varchar("title", { length: 255 }).default("0").notNull(),
    image: varchar("image", { length: 500 }).default("").notNull(),
    /** Required selector for a mix-and-match bundle. */
    type: smallint("type").default(0).notNull(),
    tempId: integer("temp_id").default(0).notNull(),
  },
  (t) => [
    index("sdp_discount_product").on(t.discountId, t.productId),
    index("sdp_product_discount").on(t.productId, t.discountId),
    index("sdp_discount_order").on(t.discountId, t.id),
  ],
);
