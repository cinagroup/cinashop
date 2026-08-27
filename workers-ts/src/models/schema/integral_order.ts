/**
 * Historical integral-order schema.
 *
 * CRMEB now writes integral purchases to store_order(type=4). These two tables
 * remain migration/read models so old orders and their append-only status trail
 * are not discarded or confused with the active unified order state machine.
 */
import {
  char,
  decimal,
  index,
  integer,
  pgTable,
  serial,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const storeIntegralOrder = pgTable(
  "store_integral_order",
  {
    id: serial("id").primaryKey(),
    orderId: varchar("order_id", { length: 32 }).default("0").notNull(),
    tradeNo: varchar("trade_no", { length: 100 }).default("").notNull(),
    uid: integer("uid").default(0).notNull(),
    realName: varchar("real_name", { length: 32 }).default("").notNull(),
    userPhone: varchar("user_phone", { length: 18 }).default("").notNull(),
    userAddress: varchar("user_address", { length: 100 }).default("").notNull(),
    productId: integer("product_id").default(0).notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    storeName: varchar("store_name", { length: 128 }).default("").notNull(),
    suk: varchar("suk", { length: 128 }).default("").notNull(),
    unique: char("unique", { length: 8 }).default("").notNull(),
    cartInfo: text("cart_info"),
    totalNum: integer("total_num").default(0).notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    totalPrice: decimal("total_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    integral: integer("integral").default(0).notNull(),
    totalIntegral: integer("total_integral").default(0).notNull(),
    paid: smallint("paid").default(0).notNull(),
    payTime: integer("pay_time").default(0).notNull(),
    payType: varchar("pay_type", { length: 32 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    deliveryName: varchar("delivery_name", { length: 64 }).default("").notNull(),
    deliveryCode: varchar("delivery_code", { length: 50 }).default("").notNull(),
    deliveryType: varchar("delivery_type", { length: 32 }).default("").notNull(),
    deliveryId: varchar("delivery_id", { length: 64 }).default("").notNull(),
    fictitiousContent: varchar("fictitious_content", { length: 500 }).default("").notNull(),
    deliveryUid: integer("delivery_uid").default(0).notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    remark: varchar("remark", { length: 512 }).default("").notNull(),
    merId: integer("mer_id").default(0).notNull(),
    isMerCheck: smallint("is_mer_check").default(0).notNull(),
    isRemind: smallint("is_remind").default(0).notNull(),
    isSystemDel: smallint("is_system_del").default(0).notNull(),
    channelType: varchar("channel_type", { length: 255 }).default("").notNull(),
    province: varchar("province", { length: 255 }).default("").notNull(),
    expressDump: text("express_dump"),
    kuaidiLabel: varchar("kuaidi_label", { length: 255 }).default("").notNull(),
    verifyCode: varchar("verify_code", { length: 125 }).default("").notNull(),
    productType: smallint("product_type").default(0).notNull(),
    virtualInfo: varchar("virtual_info", { length: 255 }).default("").notNull(),
    customForm: text("custom_form"),
  },
  (table) => [
    uniqueIndex("sio_order_uid_uq").on(table.orderId, table.uid),
    index("sio_uid").on(table.uid),
    index("sio_add_time").on(table.addTime),
    index("sio_status").on(table.status),
    index("sio_is_del").on(table.isDel),
    index("sio_user_list").on(
      table.uid,
      table.paid,
      table.isDel,
      table.isSystemDel,
      table.addTime,
      table.id,
    ),
  ],
);

export const storeIntegralOrderStatus = pgTable(
  "store_integral_order_status",
  {
    oid: integer("oid").default(0).notNull(),
    changeType: varchar("change_type", { length: 32 }).default("").notNull(),
    changeMessage: varchar("change_message", { length: 256 }).default("").notNull(),
    changeTime: integer("change_time").default(0).notNull(),
  },
  (table) => [
    index("sios_oid").on(table.oid),
    index("sios_change_type").on(table.changeType),
    index("sios_oid_time").on(table.oid, table.changeTime),
  ],
);
