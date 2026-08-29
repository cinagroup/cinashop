/**
 * 系统配置表 schema
 *
 * 对应 PHP app/model/system/system/SystemConfig.php + eb_system_config 表。
 * 后台所有"商城设置"项都存在这里, 一行一个 key-value。
 *
 * 读取方式: sys_config('record_No') = SELECT value FROM eb_system_config WHERE menu_name='record_No'
 */
import {
  pgTable,
  serial,
  varchar,
  smallint,
  integer,
  index,
} from "drizzle-orm/pg-core";

export const systemConfig = pgTable(
  "system_config",
  {
    id: serial("id").primaryKey(),
    /** 0=总后台 1=门店 */
    isStore: smallint("is_store").default(0).notNull(),
    /** 字段名 (业务 key, 如 record_No / image_site_url) */
    menuName: varchar("menu_name", { length: 255 }).default("").notNull(),
    /** 表单类型 (文本框/单选...) */
    type: varchar("type", { length: 255 }).default("").notNull(),
    inputType: varchar("input_type", { length: 20 }).default("input").notNull(),
    configTabId: integer("config_tab_id").default(0).notNull(),
    /** 规则参数 (单选/多选的选项) */
    parameter: varchar("parameter", { length: 255 }).default("").notNull(),
    uploadType: smallint("upload_type").default(1).notNull(),
    required: varchar("required", { length: 255 }).default("").notNull(),
    width: integer("width").default(0).notNull(),
    high: integer("high").default(0).notNull(),
    /** 配置值 —— 业务读这个字段 */
    value: varchar("value", { length: 5000 }).default("").notNull(),
    info: varchar("info", { length: 255 }).default("").notNull(),
    desc: varchar("desc", { length: 255 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    /** 0=隐藏 1=显示 */
    status: smallint("status").default(0).notNull(),
  },
  (t) => [
    index("is_store").on(t.isStore),
    index("config_tab_id").on(t.configTabId),
    index("menu_name").on(t.menuName),
    index("system_config_lookup").on(t.isStore, t.menuName, t.sort.desc(), t.id.desc()),
  ],
);

export type SystemConfig = typeof systemConfig.$inferSelect;
export type NewSystemConfig = typeof systemConfig.$inferInsert;
