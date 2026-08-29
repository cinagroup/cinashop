/**
 * Short-video compatibility extension.
 *
 * CRMEB-PRO v3.1.1 ships the runtime model/controller for these records but
 * neither its installer nor the matching public data dictionary defines the
 * tables.  The deliberately conservative types below cover every field read
 * or written by that runtime without pretending that an authoritative source
 * DDL exists.
 */
import { index, integer, pgTable, serial, smallint, text, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const video = pgTable(
  "video",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    image: varchar("image", { length: 2048 }).default("").notNull(),
    desc: text("desc").default("").notNull(),
    videoUrl: varchar("video_url", { length: 2048 }).default("").notNull(),
    /** Legacy runtime stores a comma-delimited product id list. */
    productId: text("product_id").default("").notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    isRecommend: smallint("is_recommend").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    isVerify: smallint("is_verify").default(1).notNull(),
    commentNum: integer("comment_num").default(0).notNull(),
    likeNum: integer("like_num").default(0).notNull(),
    collectNum: integer("collect_num").default(0).notNull(),
    shareNum: integer("share_num").default(0).notNull(),
    playNum: integer("play_num").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (table) => [
    index("video_storefront_latest")
      .on(table.id.desc(), table.sort.desc())
      .where(sql`${table.isShow} = 1 AND ${table.isDel} = 0 AND ${table.isVerify} = 1`),
    index("video_storefront_sort")
      .on(table.sort.desc(), table.id.desc())
      .where(sql`${table.isShow} = 1 AND ${table.isDel} = 0 AND ${table.isVerify} = 1`),
    index("video_storefront_recommended")
      .on(table.isRecommend, table.sort.desc(), table.id.desc())
      .where(sql`${table.isShow} = 1 AND ${table.isDel} = 0 AND ${table.isVerify} = 1`),
  ],
);

export const videoComment = pgTable(
  "video_comment",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    pid: integer("pid").default(0).notNull(),
    videoId: integer("video_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    nickname: varchar("nickname", { length: 64 }).default("").notNull(),
    avatar: varchar("avatar", { length: 2048 }).default("").notNull(),
    content: text("content").default("").notNull(),
    ip: varchar("ip", { length: 45 }).default("").notNull(),
    city: varchar("city", { length: 255 }).default("").notNull(),
    likeNum: integer("like_num").default(0).notNull(),
    collectNum: integer("collect_num").default(0).notNull(),
    shareNum: integer("share_num").default(0).notNull(),
    isReply: smallint("is_reply").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("video_comment_thread")
      .on(table.videoId, table.pid, table.id.desc())
      .where(sql`${table.isDel} = 0`),
    index("video_comment_owner")
      .on(table.uid, table.id.desc())
      .where(sql`${table.isDel} = 0`),
  ],
);

export type Video = typeof video.$inferSelect;
export type VideoComment = typeof videoComment.$inferSelect;
