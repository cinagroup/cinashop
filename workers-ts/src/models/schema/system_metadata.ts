/** Legacy configuration navigation and dynamic form metadata. */
import { index, integer, pgTable, serial, smallint, text, varchar } from "drizzle-orm/pg-core";

export const systemConfigTab = pgTable(
  "system_config_tab",
  {
    id: serial("id").primaryKey(),
    isStore: smallint("is_store").default(0).notNull(),
    pid: integer("pid").default(0).notNull(),
    title: varchar("title", { length: 255 }).default("").notNull(),
    engTitle: varchar("eng_title", { length: 255 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    info: smallint("info").default(0).notNull(),
    icon: varchar("icon", { length: 30 }).default("").notNull(),
    type: integer("type").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
  },
  (table) => [
    index("system_config_tab_pid").on(table.pid),
    index("system_config_tab_is_store").on(table.isStore),
    index("system_config_tab_eng_title").on(table.engTitle),
    index("system_config_tab_scope_active").on(
      table.isStore,
      table.status,
      table.pid,
      table.sort,
      table.id,
    ),
  ],
);

export const systemForm = pgTable(
  "system_form",
  {
    id: serial("id").primaryKey(),
    version: varchar("version", { length: 255 }).default("").notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    coverImage: varchar("cover_image", { length: 255 }).default("").notNull(),
    value: text("value"),
    defaultValue: text("default_value"),
    status: smallint("status").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("system_form_active").on(table.isDel, table.status, table.id),
    index("system_form_name").on(table.name),
  ],
);

export const systemFormData = pgTable(
  "system_form_data",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    // The source declaration is VARCHAR even though most rows contain numeric IDs.
    systemFormId: varchar("system_form_id", { length: 255 }).default("").notNull(),
    type: smallint("type").default(1).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    value: text("value"),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("system_form_data_form").on(table.systemFormId, table.isDel, table.id),
    index("system_form_data_user").on(table.uid, table.type, table.relationId, table.id),
  ],
);
