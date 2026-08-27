/**
 * Supplier onboarding and SMS audit records preserved from the PHP schema.
 * Runtime application mutations must scope by authenticated uid and type=2.
 * SMS content is an audit description only and must never contain a code.
 */
import {
  char,
  index,
  integer,
  pgTable,
  serial,
  smallint,
  text,
  varchar,
} from "drizzle-orm/pg-core";

export const systemUserApply = pgTable(
  "system_user_apply",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    phone: varchar("phone", { length: 20 }).default("").notNull(),
    systemName: varchar("system_name", { length: 30 }).default("").notNull(),
    name: varchar("name", { length: 30 }).default("").notNull(),
    images: varchar("images", { length: 2000 }).default("").notNull(),
    mark: varchar("mark", { length: 255 }).default("").notNull(),
    status: smallint("status").default(0).notNull(),
    failMsg: varchar("fail_msg", { length: 255 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    statusTime: integer("status_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("system_user_apply_owner_lookup").on(t.uid, t.type, t.isDel, t.id),
    index("system_user_apply_review_lookup").on(t.type, t.isDel, t.status, t.id),
    index("system_user_apply_relation_lookup").on(t.relationId, t.type, t.isDel),
  ],
);

export const smsRecord = pgTable(
  "sms_record",
  {
    id: serial("id").primaryKey(),
    uid: varchar("uid", { length: 255 }).default("").notNull(),
    phone: char("phone", { length: 11 }).default("").notNull(),
    content: text("content"),
    addTime: integer("add_time").default(0).notNull(),
    addIp: varchar("add_ip", { length: 16 }).default("").notNull(),
    template: varchar("template", { length: 255 }).default("").notNull(),
    resultcode: integer("resultcode").default(0).notNull(),
    recordId: integer("record_id").default(0).notNull(),
  },
  (t) => [
    index("sms_record_phone_time").on(t.phone, t.addTime, t.id),
    index("sms_record_ip_time").on(t.addIp, t.addTime, t.id),
    index("sms_record_result_time").on(t.resultcode, t.addTime, t.id),
  ],
);

export type SystemUserApply = typeof systemUserApply.$inferSelect;
export type SmsRecord = typeof smsRecord.$inferSelect;
