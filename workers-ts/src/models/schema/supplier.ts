/**
 * 供应商核心表。
 *
 * 对应 PHP `eb_system_supplier`。供应商登录账号仍存放在 `system_admin`，
 * 通过 `system_admin.relation_id -> system_supplier.id` 关联。
 */
import { index, integer, pgTable, serial, smallint, varchar } from "drizzle-orm/pg-core";

export const systemSupplier = pgTable(
  "system_supplier",
  {
    id: serial("id").primaryKey(),
    adminId: integer("admin_id").default(0).notNull(),
    supplierName: varchar("supplier_name", { length: 50 }).default("").notNull(),
    avatar: varchar("avatar", { length: 255 }).default("").notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    phone: varchar("phone", { length: 15 }).default("").notNull(),
    email: varchar("email", { length: 50 }).default("").notNull(),
    address: varchar("address", { length: 255 }).default("").notNull(),
    province: integer("province").default(0).notNull(),
    city: integer("city").default(0).notNull(),
    area: integer("area").default(0).notNull(),
    street: integer("street").default(0).notNull(),
    detailedAddress: varchar("detailed_address", { length: 255 }).default("").notNull(),
    bankCode: varchar("bank_code", { length: 32 }).default("0").notNull(),
    bankAddress: varchar("bank_address", { length: 256 }).default("").notNull(),
    alipayAccount: varchar("alipay_account", { length: 64 }).default("").notNull(),
    alipayQrcodeUrl: varchar("alipay_qrcode_url", { length: 255 }).default("").notNull(),
    wechat: varchar("wechat", { length: 15 }).default("").notNull(),
    wechatQrcodeUrl: varchar("wechat_qrcode_url", { length: 255 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    mark: varchar("mark", { length: 255 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    business: integer("business").default(0).notNull(),
    cityShopId: varchar("city_shop_id", { length: 255 }).default("").notNull(),
  },
  (t) => [
    index("supplier_admin_id").on(t.adminId),
    index("supplier_status").on(t.isShow, t.isDel),
  ],
);

export type SystemSupplier = typeof systemSupplier.$inferSelect;
export type NewSystemSupplier = typeof systemSupplier.$inferInsert;
