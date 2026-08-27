/**
 * 运费模板 + 快递公司 schema (M19)
 *
 * 对应 eb_shipping_templates / eb_shipping_templates_region / eb_express
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  index,
} from "drizzle-orm/pg-core";

/** 运费模板 (1=按件 2=按重) */
export const shippingTemplates = pgTable(
  "shipping_templates",
  {
    id: serial("id").primaryKey(),
    /** 0=平台 1=门店 2=供应商 */
    ownerType: smallint("owner_type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    /** PHP group: 1=按件 2=按重量 3=按体积 */
    type: smallint("type").default(1).notNull(),
    appoint: smallint("appoint").default(0).notNull(),
    noDelivery: smallint("no_delivery").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("st_status").on(t.status),
    index("st_owner_active").on(t.ownerType, t.relationId, t.isDel, t.sort),
  ],
);

/** 运费模板区域费率 */
export const shippingTemplatesRegion = pgTable(
  "shipping_templates_region",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id").default(0).notNull(),
    provinceId: integer("province_id").default(0).notNull(),
    regionId: integer("region_id").default(0).notNull(),
    regionName: varchar("region_name", { length: 255 }).default("").notNull(),
    /** 首件/首重 */
    first: decimal("first", { precision: 12, scale: 2 }).default("0.00").notNull(),
    firstPrice: decimal("first_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 续件/续重 */
    continue: decimal("continue", { precision: 12, scale: 2 }).default("0.00").notNull(),
    continuePrice: decimal("continue_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** Legacy row-level copy of shipping_templates.group. */
    billingGroup: smallint("billing_group").default(1).notNull(),
    value: varchar("value", { length: 200 }).default("").notNull(),
    uniqid: varchar("uniqid", { length: 32 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("str_template").on(t.templateId),
    index("str_template_region").on(t.templateId, t.regionId),
    index("str_template_uniqid").on(t.templateId, t.uniqid),
  ],
);

/** 运费模板指定包邮规则。number 与模板计费方式同单位，price 为该模板商品小计门槛。 */
export const shippingTemplatesFree = pgTable(
  "shipping_templates_free",
  {
    id: serial("id").primaryKey(),
    provinceId: integer("province_id").default(0).notNull(),
    tempId: integer("temp_id").default(0).notNull(),
    cityId: integer("city_id").default(0).notNull(),
    number: decimal("number", { precision: 10, scale: 2 }).default("0.00").notNull(),
    price: decimal("price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    billingGroup: smallint("group").default(1).notNull(),
    value: varchar("value", { length: 200 }).default("").notNull(),
    uniqid: varchar("uniqid", { length: 32 }).default("").notNull(),
  },
  (t) => [
    index("stf_temp_city").on(t.tempId, t.cityId),
    index("stf_temp_uniqid").on(t.tempId, t.uniqid),
  ],
);

/** 运费模板禁配区域。匹配后下单必须失败，不能退化为零运费。 */
export const shippingTemplatesNoDelivery = pgTable(
  "shipping_templates_no_delivery",
  {
    id: serial("id").primaryKey(),
    provinceId: integer("province_id").default(0).notNull(),
    tempId: integer("temp_id").default(0).notNull(),
    cityId: integer("city_id").default(0).notNull(),
    value: varchar("value", { length: 200 }).default("").notNull(),
    uniqid: varchar("uniqid", { length: 32 }).default("").notNull(),
  },
  (t) => [
    index("stnd_temp_city").on(t.tempId, t.cityId),
    index("stnd_temp_uniqid").on(t.tempId, t.uniqid),
  ],
);

/** 快递公司 */
export const expressCompany = pgTable(
  "express_company",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 50 }).default("").notNull(),
    name: varchar("name", { length: 64 }).default("").notNull(),
    partnerId: smallint("partner_id").default(0).notNull(),
    partnerKey: smallint("partner_key").default(0).notNull(),
    net: smallint("net").default(0).notNull(),
    checkMan: smallint("check_man").default(0).notNull(),
    partnerName: smallint("partner_name").default(0).notNull(),
    isCode: smallint("is_code").default(0).notNull(),
    courierName: varchar("courier_name", { length: 100 }).default("").notNull(),
    customerName: varchar("customer_name", { length: 100 }).default("").notNull(),
    codeName: varchar("code_name", { length: 100 }).default("").notNull(),
    account: varchar("account", { length: 100 }).default("").notNull(),
    key: varchar("key", { length: 100 }).default("").notNull(),
    netName: varchar("net_name", { length: 100 }).default("").notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("ec_status").on(t.status),
    index("ec_visible_sort").on(t.isShow, t.status, t.sort),
  ],
);
