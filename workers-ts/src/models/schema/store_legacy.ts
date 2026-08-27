/**
 * Remaining store auxiliary tables preserved from the PHP install schema.
 *
 * The checked-in PHP runtime has no active model for the branch-product tables
 * or store_extract. They stay source-shaped for lossless migration only.
 * store_config is still used as a scoped override store; new writes enforce
 * scope and duplicate checks in the service layer without rejecting history.
 */
import {
  char,
  decimal,
  index,
  integer,
  pgTable,
  serial,
  smallint,
  varchar,
} from "drizzle-orm/pg-core";

export const storeConfig = pgTable(
  "store_config",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    keyName: varchar("key_name", { length: 100 }).default("").notNull(),
    value: varchar("value", { length: 2000 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("store_config_type_relation").on(t.type, t.relationId),
    index("store_config_scope_key").on(t.type, t.relationId, t.keyName, t.id),
  ],
);

export const storeBranchProduct = pgTable("store_branch_product", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").default(0).notNull(),
  image: varchar("image", { length: 255 }).default("").notNull(),
  storeName: varchar("store_name", { length: 128 }).default("").notNull(),
  storeInfo: varchar("store_info", { length: 255 }).default("").notNull(),
  keyword: varchar("keyword", { length: 255 }).default("").notNull(),
  barCode: varchar("bar_code", { length: 15 }).default("").notNull(),
  cateId: varchar("cate_id", { length: 64 }).default("").notNull(),
  storeId: integer("store_id").default(0).notNull(),
  sales: integer("sales").default(0).notNull(),
  stock: integer("stock").default(0).notNull(),
  sort: integer("sort").default(0).notNull(),
  labelId: varchar("label_id", { length: 50 }).default("").notNull(),
  isShow: smallint("is_show").default(1).notNull(),
  addTime: integer("add_time").default(0).notNull(),
  isDel: smallint("is_del").default(0).notNull(),
});

export const storeBranchProductAttrValue = pgTable(
  "store_branch_product_attr_value",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    storeId: integer("store_id").default(0).notNull(),
    attrUnique: char("unique", { length: 8 }).default("").notNull(),
    sales: integer("sales").default(0).notNull(),
    stock: integer("stock").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    barCode: varchar("bar_code", { length: 50 }).default("").notNull(),
    code: varchar("code", { length: 50 }).default("").notNull(),
  },
  (t) => [index("store_branch_product_attr_value_code").on(t.code)],
);

export const storeExtract = pgTable(
  "store_extract",
  {
    id: serial("id").primaryKey(),
    storeId: integer("store_id").default(0).notNull(),
    storeStaffId: integer("store_staff_id").default(0).notNull(),
    extractType: varchar("extract_type", { length: 32 }).default("bank").notNull(),
    bankCode: varchar("bank_code", { length: 32 }).default("0").notNull(),
    bankAddress: varchar("bank_address", { length: 256 }).default("").notNull(),
    alipayAccount: varchar("alipay_account", { length: 64 }).default("").notNull(),
    wechat: varchar("wechat", { length: 15 }).default("").notNull(),
    qrcodeUrl: varchar("qrcode_url", { length: 255 }).default("").notNull(),
    extractPrice: decimal("extract_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    balance: decimal("balance", { precision: 12, scale: 2 }).default("0.00").notNull(),
    status: smallint("status").default(0).notNull(),
    payStatus: smallint("pay_status").default(0).notNull(),
    storeMark: varchar("store_mark", { length: 255 }).default("").notNull(),
    adminId: integer("admin_id").default(0).notNull(),
    failMsg: varchar("fail_msg", { length: 128 }).default("").notNull(),
    failTime: integer("fail_time").default(0).notNull(),
    voucherImage: varchar("voucher_image", { length: 255 }).default("").notNull(),
    voucherTitle: varchar("voucher_title", { length: 255 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("store_extract_store_id").on(t.storeId),
    index("store_extract_extract_type").on(t.extractType),
    index("store_extract_status").on(t.status),
    index("store_extract_add_time").on(t.addTime),
  ],
);

export type StoreConfig = typeof storeConfig.$inferSelect;
export type StoreBranchProduct = typeof storeBranchProduct.$inferSelect;
export type StoreBranchProductAttrValue = typeof storeBranchProductAttrValue.$inferSelect;
export type StoreExtract = typeof storeExtract.$inferSelect;
