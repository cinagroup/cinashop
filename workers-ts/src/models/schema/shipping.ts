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
    name: varchar("name", { length: 64 }).default("").notNull(),
    type: smallint("type").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("st_status").on(t.status)],
);

/** 运费模板区域费率 */
export const shippingTemplatesRegion = pgTable(
  "shipping_templates_region",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id").default(0).notNull(),
    regionId: integer("region_id").default(0).notNull(),
    regionName: varchar("region_name", { length: 255 }).default("").notNull(),
    /** 首件/首重 */
    first: decimal("first", { precision: 12, scale: 2 }).default("0.00").notNull(),
    firstPrice: decimal("first_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 续件/续重 */
    continue: decimal("continue", { precision: 12, scale: 2 }).default("0.00").notNull(),
    continuePrice: decimal("continue_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("str_template").on(t.templateId)],
);

/** 快递公司 */
export const expressCompany = pgTable(
  "express_company",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 32 }).default("").notNull(),
    name: varchar("name", { length: 64 }).default("").notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("ec_status").on(t.status)],
);
