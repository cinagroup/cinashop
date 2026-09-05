/**
 * Legacy reusable product metadata and composite system configuration.
 *
 * category is intentionally not merged with store_product_category: it is a
 * polymorphic taxonomy for labels, parameter templates, speechcraft, and
 * channel-code metadata. Product rules/templates are also distinct from the
 * per-product store_product_attr* snapshots.
 */
import {
  index,
  integer,
  pgTable,
  serial,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const legacyCategory = pgTable(
  "category",
  {
    id: serial("id").primaryKey(),
    pid: integer("pid").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    ownerId: integer("owner_id").default(0).notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    group: smallint("group").default(0).notNull(),
    other: text("other"),
    isShow: smallint("is_show").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    integralMin: integer("integral_min").default(0).notNull(),
    integralMax: integer("integral_max").default(0).notNull(),
  },
  (table) => [
    index("legacy_category_pid").on(table.pid),
    index("legacy_category_name").on(table.name),
    index("legacy_category_owner_type_id").on(table.ownerId, table.type, table.id),
    index("category_kefu_speechcraft").on(table.ownerId, table.type, table.group, table.sort.desc().nullsFirst(), table.id),
    index("legacy_category_group").on(table.group),
    index("legacy_category_scope_group").on(
      table.type,
      table.relationId,
      table.group,
      table.isShow,
      table.sort,
      table.id,
    ),
  ],
);

export const storeProductUnit = pgTable(
  "store_product_unit",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    sort: smallint("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("spu_scope_active").on(
      table.type,
      table.relationId,
      table.isDel,
      table.status,
      table.sort,
      table.id,
    ),
    index("spu_name").on(table.name),
  ],
);

export const storeProductRule = pgTable(
  "store_product_rule",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    ruleName: varchar("rule_name", { length: 32 }).default("").notNull(),
    ruleValue: text("rule_value"),
  },
  (table) => [
    index("spr_scope_id").on(table.type, table.relationId, table.id),
    index("spr_scope_name").on(table.type, table.relationId, table.ruleName),
  ],
);

export const storeProductSpecs = pgTable(
  "store_product_specs",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    tempId: integer("temp_id").default(0).notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    value: varchar("value", { length: 255 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("sps_type").on(table.type),
    index("sps_template_active").on(table.tempId, table.status, table.sort, table.id),
    index("sps_scope_template").on(table.type, table.relationId, table.tempId, table.id),
  ],
);

export const storeProductVirtual = pgTable(
  "store_product_virtual",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    storeId: integer("store_id").default(0).notNull(),
    attrUnique: varchar("attr_unique", { length: 20 }).default("").notNull(),
    cardNo: varchar("card_no", { length: 255 }).default("").notNull(),
    cardPwd: varchar("card_pwd", { length: 255 }).default("").notNull(),
    cardUnique: varchar("card_unique", { length: 32 }).default("").notNull(),
    orderId: varchar("order_id", { length: 255 }).default("").notNull(),
    orderType: smallint("order_type").default(1).notNull(),
    uid: integer("uid").default(0).notNull(),
  },
  (table) => [
    index("spv_product_attr_available").on(table.productId, table.attrUnique, table.uid, table.id),
    index("spv_store_product").on(table.storeId, table.productId, table.id),
    index("spv_order").on(table.orderId),
    index("spv_uid").on(table.uid),
    index("spv_card_unique").on(table.cardUnique),
  ],
);

export const systemGroup = pgTable(
  "system_group",
  {
    id: serial("id").primaryKey(),
    cateId: integer("cate_id").default(0).notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    info: varchar("info", { length: 256 }).default("").notNull(),
    configName: varchar("config_name", { length: 50 }).default("").notNull(),
    fields: text("fields"),
  },
  (table) => [
    uniqueIndex("system_group_config_name_uq").on(table.configName),
    index("system_group_cate").on(table.cateId),
  ],
);

export const systemGroupData = pgTable(
  "system_group_data",
  {
    id: serial("id").primaryKey(),
    gid: integer("gid").default(0).notNull(),
    value: text("value"),
    addTime: integer("add_time").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
  },
  (table) => [
    index("system_group_data_gid").on(table.gid, table.status, table.sort, table.id),
  ],
);
