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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** 站内信内容 */
export const systemMessage = pgTable(
  "system_message",
  {
    id: serial("id").primaryKey(),
    /** Worker transactional-outbox idempotency key; legacy imported rows remain NULL. */
    eventKey: varchar("event_key", { length: 128 }),
    mark: varchar("mark", { length: 50 }).default("").notNull(),
    /** 消息标题 */
    title: varchar("title", { length: 256 }).default("").notNull(),
    /** 消息内容 */
    content: text("content"),
    /** 0=全部用户 */
    userId: integer("user_id").default(0).notNull(),
    /** PHP 每用户消息的已读快照；新广播消息仍使用 user_message。 */
    look: smallint("look").default(0).notNull(),
    /** 0=legacy user/broadcast, 1=user notice, 2=staff-only inbox. Never mix read domains. */
    type: smallint("type").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("smsg_event_key_uq").on(t.eventKey),
    index("sm_user").on(t.userId),
    index("sm_add_time").on(t.addTime),
    index("smsg_visible_user").on(t.userId, t.status, t.isDel, t.addTime),
    index("smsg_staff_inbox").on(t.userId, t.id)
      .where(sql`${t.type} = 2 AND ${t.status} = 1 AND ${t.isDel} = 0`),
  ],
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
