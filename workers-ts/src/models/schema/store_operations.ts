/**
 * Pickup-store and fulfillment identities preserved from the PHP schema.
 *
 * No foreign or unique constraints are invented here: the source database
 * permits historical orphans and duplicates, which the migration must retain.
 * New Worker writes enforce active-row invariants transactionally.
 */
import {
  char,
  index,
  integer,
  pgTable,
  serial,
  smallint,
  text,
  varchar,
} from "drizzle-orm/pg-core";

export const systemStore = pgTable(
  "system_store",
  {
    id: serial("id").primaryKey(),
    erpShopId: integer("erp_shop_id").default(0).notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    introduction: varchar("introduction", { length: 1000 }).default("").notNull(),
    phone: char("phone", { length: 25 }).default("").notNull(),
    address: varchar("address", { length: 255 }).default("").notNull(),
    province: integer("province").default(0).notNull(),
    city: integer("city").default(0).notNull(),
    area: integer("area").default(0).notNull(),
    street: integer("street").default(0),
    detailedAddress: varchar("detailed_address", { length: 255 }).default("").notNull(),
    image: varchar("image", { length: 255 }).default("").notNull(),
    oblongImage: varchar("oblong_image", { length: 255 }).default("").notNull(),
    latitude: char("latitude", { length: 25 }).default("").notNull(),
    longitude: char("longitude", { length: 25 }).default("").notNull(),
    bankCode: varchar("bank_code", { length: 32 }).default("0").notNull(),
    bankAddress: varchar("bank_address", { length: 256 }).default("").notNull(),
    alipayAccount: varchar("alipay_account", { length: 64 }).default("").notNull(),
    alipayQrcodeUrl: varchar("alipay_qrcode_url", { length: 255 }).default("").notNull(),
    wechat: varchar("wechat", { length: 15 }).default("").notNull(),
    wechatQrcodeUrl: varchar("wechat_qrcode_url", { length: 255 }).default("").notNull(),
    validTime: varchar("valid_time", { length: 100 }).default("").notNull(),
    validRange: integer("valid_range").default(0).notNull(),
    dayTime: varchar("day_time", { length: 100 }).default("").notNull(),
    dayStart: varchar("day_start", { length: 20 }).default(""),
    dayEnd: varchar("day_end", { length: 20 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isShow: smallint("is_show").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    isStore: smallint("is_store").default(0).notNull(),
  },
  (t) => [
    index("system_store_phone").on(t.phone),
    index("system_store_active_show").on(t.isDel, t.isShow, t.id),
  ],
);

export const systemStoreStaff = pgTable(
  "system_store_staff",
  {
    id: serial("id").primaryKey(),
    storeId: integer("store_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    account: varchar("account", { length: 50 }).default("").notNull(),
    pwd: varchar("pwd", { length: 100 }).default("").notNull(),
    avatar: varchar("avatar", { length: 255 }).default("").notNull(),
    staffName: varchar("staff_name", { length: 64 }).default("").notNull(),
    phone: char("phone", { length: 15 }).default("").notNull(),
    roles: varchar("roles", { length: 255 }).default(""),
    lastIp: varchar("last_ip", { length: 16 }).default("").notNull(),
    lastTime: integer("last_time").default(0).notNull(),
    loginCount: integer("login_count").default(0).notNull(),
    level: smallint("level").default(1).notNull(),
    verifyStatus: smallint("verify_status").default(0).notNull(),
    orderStatus: smallint("order_status").default(1).notNull(),
    isAdmin: smallint("is_admin").default(0).notNull(),
    isManager: smallint("is_manager").default(0).notNull(),
    isCashier: smallint("is_cashier").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    notify: smallint("notify").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("system_store_staff_uid_status").on(t.uid, t.status, t.isDel, t.verifyStatus),
    index("system_store_staff_store_active").on(t.storeId, t.isDel, t.status, t.id),
    index("system_store_staff_store_uid").on(t.storeId, t.uid, t.isDel, t.id),
  ],
);

export const deliveryService = pgTable(
  "delivery_service",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    type: smallint("type").default(1).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    avatar: varchar("avatar", { length: 250 }).default("").notNull(),
    nickname: varchar("nickname", { length: 50 }).default("").notNull(),
    phone: varchar("phone", { length: 20 }).default("0").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
  },
  (t) => [
    index("delivery_service_uid_status").on(t.uid, t.isDel, t.status),
    index("delivery_service_scope_active").on(t.type, t.relationId, t.isDel, t.status, t.id),
    index("delivery_service_scope_phone").on(t.type, t.relationId, t.phone, t.isDel, t.id),
  ],
);

export const storeUser = pgTable(
  "store_user",
  {
    id: serial("id").primaryKey(),
    storeId: integer("store_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    labelId: text("label_id"),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("store_user_store_id").on(t.storeId),
    index("store_user_uid").on(t.uid),
    index("store_user_store_uid_status").on(t.storeId, t.uid, t.status, t.id),
  ],
);

export type SystemStore = typeof systemStore.$inferSelect;
export type SystemStoreStaff = typeof systemStoreStaff.$inferSelect;
export type DeliveryService = typeof deliveryService.$inferSelect;
export type StoreUser = typeof storeUser.$inferSelect;
