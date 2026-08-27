/**
 * Legacy official-account member cards, claims, and the superseded merchant
 * application table. Source columns and uniqueness are preserved for import.
 */
import { index, integer, pgTable, serial, smallint, text, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const userEnter = pgTable(
  "user_enter",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    province: varchar("province", { length: 32 }).default("").notNull(),
    city: varchar("city", { length: 32 }).default("").notNull(),
    district: varchar("district", { length: 32 }).default("").notNull(),
    address: varchar("address", { length: 256 }).default("").notNull(),
    merchantName: varchar("merchant_name", { length: 256 }).default("").notNull(),
    linkUser: varchar("link_user", { length: 32 }).default("").notNull(),
    linkTel: varchar("link_tel", { length: 16 }).default("").notNull(),
    charter: varchar("charter", { length: 512 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    applyTime: integer("apply_time").default(0).notNull(),
    successTime: integer("success_time").default(0).notNull(),
    failMessage: varchar("fail_message", { length: 256 }).default("").notNull(),
    failTime: integer("fail_time").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    isLock: smallint("is_lock").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("user_enter_uid_unique").on(table.uid),
    index("user_enter_region").on(table.province, table.city, table.district),
    index("user_enter_is_lock").on(table.isLock),
    index("user_enter_is_del").on(table.isDel),
    index("user_enter_status").on(table.status),
  ],
);

export const wechatCard = pgTable(
  "wechat_card",
  {
    id: serial("id").primaryKey(),
    cardId: varchar("card_id", { length: 50 }).default("").notNull(),
    cardType: varchar("card_type", { length: 20 }).default("member_card").notNull(),
    codeType: varchar("code_type", { length: 20 }).default("").notNull(),
    brandName: varchar("brand_name", { length: 50 }).default("").notNull(),
    title: varchar("title", { length: 50 }).default("").notNull(),
    color: varchar("color", { length: 15 }).default("").notNull(),
    notice: varchar("notice", { length: 20 }).default("").notNull(),
    description: varchar("description", { length: 255 }).default("").notNull(),
    centerTitle: varchar("center_title", { length: 255 }).default("").notNull(),
    centerSubTitle: varchar("center_sub_title", { length: 255 }).default("").notNull(),
    centerUrl: varchar("center_url", { length: 255 }).default("").notNull(),
    servicePhone: varchar("service_phone", { length: 30 }).default("").notNull(),
    logoUrl: varchar("logo_url", { length: 255 }).default("").notNull(),
    backgroundPicUrl: varchar("background_pic_url", { length: 255 }).default("").notNull(),
    prerogative: text("prerogative"),
    especial: text("especial"),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("wechat_card_catalog").on(table.cardType, table.isDel, table.status, table.id),
    index("wechat_card_remote_id").on(table.cardId, table.id),
  ],
);

export const userCard = pgTable(
  "user_card",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    spreadUid: integer("spread_uid").default(0).notNull(),
    wechatCardId: integer("wechat_card_id").default(0).notNull(),
    cardId: varchar("card_id", { length: 50 }).default("").notNull(),
    code: varchar("code", { length: 50 }).default("").notNull(),
    storeId: integer("store_id").default(0).notNull(),
    staffId: integer("staff_id").default(0).notNull(),
    openid: varchar("openid", { length: 100 }).default("").notNull(),
    isSubmit: smallint("is_submit").default(0).notNull(),
    submitTime: integer("submit_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    delTime: integer("del_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("user_card_active_remote").on(table.openid, table.cardId, table.isDel, table.id),
    index("user_card_store_staff_submit").on(table.storeId, table.staffId, table.isSubmit, table.addTime, table.id),
    index("user_card_uid").on(table.uid, table.id),
    index("user_card_wechat_card").on(table.wechatCardId, table.id),
  ],
);

export type UserEnter = typeof userEnter.$inferSelect;
export type WechatCard = typeof wechatCard.$inferSelect;
export type UserCard = typeof userCard.$inferSelect;
