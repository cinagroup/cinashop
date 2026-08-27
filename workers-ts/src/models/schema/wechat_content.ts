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

/** Source-shaped keyword links. Historical duplicate keys remain importable. */
export const wechatKey = pgTable(
  "wechat_key",
  {
    id: serial("id").primaryKey(),
    replyId: integer("reply_id").default(0).notNull(),
    keys: varchar("keys", { length: 64 }).default("").notNull(),
  },
  (table) => [
    index("wechat_key_keys").on(table.keys),
    index("wechat_key_reply_id").on(table.replyId),
  ],
);

/** Official-account media identifiers already uploaded by the legacy application. */
export const wechatMedia = pgTable(
  "wechat_media",
  {
    id: serial("id").primaryKey(),
    type: varchar("type", { length: 16 }).default("").notNull(),
    path: varchar("path", { length: 128 }).default("").notNull(),
    mediaId: varchar("media_id", { length: 64 }).default("").notNull(),
    url: varchar("url", { length: 256 }).default("").notNull(),
    temporary: smallint("temporary").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [uniqueIndex("wechat_media_type_media_id_uq").on(table.type, table.mediaId)],
);

/** Inbound official-account behavior history. New callback writes remain disabled in 0071. */
export const wechatMessage = pgTable(
  "wechat_message",
  {
    id: serial("id").primaryKey(),
    openid: varchar("openid", { length: 100 }).default("").notNull(),
    type: varchar("type", { length: 100 }).default("").notNull(),
    result: varchar("result", { length: 512 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("wechat_message_openid").on(table.openid),
    index("wechat_message_type").on(table.type),
    index("wechat_message_add_time").on(table.addTime),
  ],
);

/** Legacy WeChat news bundles; new_id intentionally remains a comma-separated source value. */
export const wechatNewsCategory = pgTable(
  "wechat_news_category",
  {
    id: serial("id").primaryKey(),
    cateName: varchar("cate_name", { length: 255 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    newId: varchar("new_id", { length: 255 }).default("").notNull(),
    /** The PHP install schema declares this epoch value as varchar(255). */
    addTime: varchar("add_time", { length: 255 }).default("").notNull(),
  },
  (table) => [index("wechat_news_category_status_sort").on(table.status, table.sort, table.id)],
);

/** Text, image, news, or voice reply snapshots. Data stays nullable text for lossless import. */
export const wechatReply = pgTable(
  "wechat_reply",
  {
    id: serial("id").primaryKey(),
    type: varchar("type", { length: 32 }).default("").notNull(),
    data: text("data"),
    status: smallint("status").default(1).notNull(),
    hide: smallint("hide").default(0).notNull(),
  },
  (table) => [
    index("wechat_reply_type").on(table.type),
    index("wechat_reply_status").on(table.status),
    index("wechat_reply_hide").on(table.hide),
  ],
);
