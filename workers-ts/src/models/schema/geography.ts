import { index, integer, pgTable, serial, smallint, varchar } from "drizzle-orm/pg-core";

/** Legacy three-level city tree used by shipping-template administration. */
export const systemCity = pgTable(
  "system_city",
  {
    id: serial("id").primaryKey(),
    cityId: integer("city_id").default(0).notNull(),
    level: integer("level").default(0).notNull(),
    parentId: integer("parent_id").default(0).notNull(),
    areaCode: varchar("area_code", { length: 30 }).default("").notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    mergerName: varchar("merger_name", { length: 255 }).default("").notNull(),
    lng: varchar("lng", { length: 50 }).default("").notNull(),
    lat: varchar("lat", { length: 50 }).default("").notNull(),
    isShow: smallint("is_show").default(1).notNull(),
  },
  (t) => [
    index("sc_city_id").on(t.cityId),
    index("sc_parent_show").on(t.parentId, t.isShow),
  ],
);

/** Full province/city/area/street hierarchy used to expand shipping region IDs. */
export const cityArea = pgTable(
  "city_area",
  {
    id: serial("id").primaryKey(),
    path: varchar("path", { length: 128 }).default("/").notNull(),
    parentId: integer("parent_id").default(0).notNull(),
    type: varchar("type", { length: 32 }).default("").notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    level: smallint("level").default(0).notNull(),
    code: varchar("code", { length: 100 }).default("").notNull(),
    snum: integer("snum").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
  },
  (t) => [
    index("ca_parent").on(t.parentId),
    index("ca_path").on(t.path),
  ],
);
