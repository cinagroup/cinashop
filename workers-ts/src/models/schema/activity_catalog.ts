/** Parent activity schedules and their many-to-many product membership. */
import { index, integer, pgTable, serial, smallint, text, varchar } from "drizzle-orm/pg-core";

export const storeActivity = pgTable(
  "store_activity",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(1).notNull(),
    name: varchar("name", { length: 128 }).default("").notNull(),
    image: varchar("image", { length: 128 }).default(""),
    startDay: integer("start_day").default(0).notNull(),
    endDay: integer("end_day").default(0).notNull(),
    startTime: integer("start_time").default(0).notNull(),
    endTime: integer("end_time").default(0).notNull(),
    timeId: text("time_id"),
    onceNum: integer("once_num").default(0),
    num: integer("num").default(0),
    discount: varchar("discount", { length: 128 }).default("").notNull(),
    status: smallint("status").default(0),
    isRecommend: smallint("is_recommend").default(0),
    linkId: integer("link_id").default(0),
    applicableType: smallint("applicable_type").default(1).notNull(),
    applicableStoreId: text("applicable_store_id"),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sa_day_window").on(t.startDay, t.endDay),
    index("sa_time_window").on(t.startTime, t.endTime),
    index("sa_type").on(t.type),
    index("sa_active_window").on(t.type, t.status, t.isDel, t.startDay, t.endDay),
  ],
);

export const storeActivityRelation = pgTable(
  "store_activity_relation",
  {
    id: serial("id").primaryKey(),
    activityId: integer("activity_id").notNull(),
    productId: integer("product_id").notNull(),
  },
  (t) => [
    index("sar_activity_product").on(t.activityId, t.productId),
    index("sar_product_activity").on(t.productId, t.activityId),
  ],
);
