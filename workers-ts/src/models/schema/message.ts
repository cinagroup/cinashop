/**
 * 站内信 schema
 *
 * 对应 eb_system_message + eb_system_message_push
 * 简化: system_message(内容) + user 消息状态用 user_message 表
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  smallint,
  text,
  index,
} from "drizzle-orm/pg-core";

/** 站内信内容 */
export const systemMessage = pgTable(
  "system_message",
  {
    id: serial("id").primaryKey(),
    /** 消息标题 */
    title: varchar("title", { length: 255 }).default("").notNull(),
    /** 消息内容 */
    content: text("content"),
    /** 0=全部用户 */
    userId: integer("user_id").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("sm_user").on(t.userId), index("sm_add_time").on(t.addTime)],
);

/** 用户消息状态 (已读) */
export const userMessage = pgTable(
  "user_message",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    messageId: integer("message_id").default(0).notNull(),
    /** 0=未读 1=已读 */
    isRead: smallint("is_read").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("um_uid_msg").on(t.uid, t.messageId)],
);
