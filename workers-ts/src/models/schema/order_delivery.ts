/** Legacy same-city third-party delivery order state and fee snapshots. */
import { decimal, index, integer, pgTable, real, serial, smallint, varchar } from "drizzle-orm/pg-core";

export const storeDeliveryOrder = pgTable(
  "store_delivery_order",
  {
    id: serial("id").primaryKey(),
    /** Goods owner: 0=platform, 1=store, 2=supplier. */
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    oid: integer("oid").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    /** Provider: 1=Dada, 2=UU in the PHP implementation. */
    stationType: integer("station_type").default(0).notNull(),
    orderId: varchar("order_id", { length: 32 }).default("").notNull(),
    deliveryNo: varchar("delivery_no", { length: 255 }).default("").notNull(),
    cityCode: varchar("city_code", { length: 20 }).default("").notNull(),
    cargoPrice: decimal("cargo_price", { precision: 8, scale: 2 }).default("0.00").notNull(),
    finishCode: varchar("finish_code", { length: 255 }).default("").notNull(),
    userName: varchar("user_name", { length: 20 }).default("").notNull(),
    receiverPhone: varchar("receiver_phone", { length: 11 }).default("").notNull(),
    fromAddress: varchar("from_address", { length: 255 }).default("").notNull(),
    toAddress: varchar("to_address", { length: 255 }).default("").notNull(),
    fromLat: varchar("from_lat", { length: 255 }).default("").notNull(),
    fromLng: varchar("from_lng", { length: 255 }).default("").notNull(),
    toLat: varchar("to_lat", { length: 255 }).default("").notNull(),
    toLng: varchar("to_lng", { length: 255 }).default("").notNull(),
    distance: real("distance").default(0).notNull(),
    fee: decimal("fee", { precision: 8, scale: 2 }).default("0.00").notNull(),
    deductFee: decimal("deduct_fee", { precision: 8, scale: 2 }).default("0.00").notNull(),
    merId: integer("mer_id").default(0).notNull(),
    mark: varchar("mark", { length: 255 }).default("").notNull(),
    status: integer("status").default(0).notNull(),
    reason: varchar("reason", { length: 255 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sdo_oid_id").on(t.oid, t.id),
    index("sdo_uid_id").on(t.uid, t.id),
    index("sdo_order_id").on(t.orderId),
    index("sdo_delivery_no").on(t.deliveryNo),
    index("sdo_owner_status").on(t.type, t.relationId, t.status, t.id),
    index("sdo_status_time").on(t.status, t.addTime, t.id),
    index("sdo_dada_reconcile_scan").on(t.stationType, t.status, t.id),
  ],
);
