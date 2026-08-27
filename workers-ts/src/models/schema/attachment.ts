/**
 * Source-shaped attachment and storage metadata.
 *
 * imageType=8 identifies new Cloudflare R2 objects. Legacy storage rows and
 * imageType values remain importable, but runtime object access uses only the
 * generated ASSETS_BUCKET binding.
 */
import {
  char,
  index,
  integer,
  pgTable,
  serial,
  smallint,
  varchar,
} from "drizzle-orm/pg-core";

export const systemAttachment = pgTable(
  "system_attachment",
  {
    attId: serial("att_id").primaryKey(),
    type: smallint("type").default(1),
    fileType: smallint("file_type").default(1).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    attDir: varchar("att_dir", { length: 200 }).default("").notNull(),
    sattDir: varchar("satt_dir", { length: 200 }).default("").notNull(),
    attSize: char("att_size", { length: 30 }).default("").notNull(),
    attType: char("att_type", { length: 30 }).default("").notNull(),
    pid: integer("pid").default(0).notNull(),
    time: integer("time").default(0).notNull(),
    imageType: smallint("image_type").default(1).notNull(),
    moduleType: smallint("module_type").default(1).notNull(),
    realName: varchar("real_name", { length: 255 }).default("").notNull(),
    scanToken: varchar("scan_token", { length: 32 }).default("").notNull(),
  },
  (t) => [
    index("system_attachment_time_idx").on(t.time),
    index("system_attachment_scope_lookup").on(
      t.type,
      t.relationId,
      t.moduleType,
      t.fileType,
      t.pid,
      t.attId,
    ),
  ],
);

export const systemAttachmentCategory = pgTable(
  "system_attachment_category",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(1),
    fileType: smallint("file_type").default(1).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    pid: integer("pid").default(0).notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    enname: varchar("enname", { length: 50 }).default("").notNull(),
  },
  (t) => [
    index("system_attachment_category_scope_lookup").on(
      t.type,
      t.relationId,
      t.fileType,
      t.pid,
      t.id,
    ),
  ],
);

export const systemFile = pgTable("system_file", {
  id: serial("id").primaryKey(),
  cthash: char("cthash", { length: 32 }).default("").notNull(),
  filename: varchar("filename", { length: 255 }).default("").notNull(),
  atime: char("atime", { length: 12 }).default("").notNull(),
  mtime: char("mtime", { length: 12 }).default("").notNull(),
  ctime: char("ctime", { length: 12 }).default("").notNull(),
});

export const systemStorage = pgTable(
  "system_storage",
  {
    id: serial("id").primaryKey(),
    accessKey: varchar("access_key", { length: 100 }).default("").notNull(),
    type: smallint("type").default(1).notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    region: varchar("region", { length: 100 }).default("").notNull(),
    acl: varchar("acl", { length: 17 }).default("public-read").notNull(),
    domain: varchar("domain", { length: 100 }).default("").notNull(),
    cname: varchar("cname", { length: 255 }).default("").notNull(),
    isSsl: smallint("is_ssl").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    isDelete: smallint("is_delete").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (t) => [index("system_storage_status_lookup").on(t.isDelete, t.status, t.type, t.id)],
);

export type SystemAttachment = typeof systemAttachment.$inferSelect;
export type SystemAttachmentCategory = typeof systemAttachmentCategory.$inferSelect;
export type SystemFile = typeof systemFile.$inferSelect;
export type SystemStorage = typeof systemStorage.$inferSelect;
