import { sql } from "drizzle-orm";
import { index, integer, pgTable, serial, smallint, text, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const notificationTemplate = pgTable(
  "notification_template",
  {
    id: serial("id").primaryKey(),
    title: varchar("title", { length: 128 }).default("").notNull(),
    content: text("content").default(""),
    type: varchar("type", { length: 32 }).default("wechat").notNull(),
    mark: varchar("mark", { length: 128 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    notificationId: varchar("notification_id", { length: 255 }).default("0").notNull(),
    legacyType: smallint("legacy_type").default(-1).notNull(),
    kid: varchar("kid", { length: 255 }).default("").notNull(),
    example: varchar("example", { length: 300 }).default("").notNull(),
    tempid: varchar("tempid", { length: 100 }).default("").notNull(),
  },
  (t) => [
    index("nt_status_type").on(t.status, t.type),
    index("nt_mark").on(t.mark),
    index("nt_enabled_provider_lookup")
      .on(t.legacyType, t.mark, t.id)
      .where(sql`${t.status} = 1`),
  ],
);

export const systemNotification = pgTable(
  "system_notification",
  {
    id: serial("id").primaryKey(),
    mark: varchar("mark", { length: 50 }).default("").notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    title: varchar("title", { length: 100 }).default("").notNull(),
    isSystem: smallint("is_system").default(0).notNull(),
    isApp: smallint("is_app").default(0).notNull(),
    isWechat: smallint("is_wechat").default(0).notNull(),
    isRoutine: smallint("is_routine").default(0).notNull(),
    isSms: smallint("is_sms").default(0).notNull(),
    isEntWechat: smallint("is_ent_wechat").default(0).notNull(),
    systemTitle: varchar("system_title", { length: 256 }).default("").notNull(),
    systemText: varchar("system_text", { length: 512 }).default("").notNull(),
    appId: integer("app_id").default(0).notNull(),
    wechatId: varchar("wechat_id", { length: 50 }).default("0").notNull(),
    routineId: varchar("routine_id", { length: 50 }).default("0").notNull(),
    smsId: varchar("sms_id", { length: 50 }).default("").notNull(),
    smsText: varchar("sms_text", { length: 255 }).default("").notNull(),
    entWechatText: varchar("ent_wechat_text", { length: 512 }).default("").notNull(),
    variable: varchar("variable", { length: 256 }).default("").notNull(),
    url: varchar("url", { length: 512 }).default("").notNull(),
    type: smallint("type").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sn_mark").on(t.mark),
    index("sn_type").on(t.type),
  ],
);

export const systemNotice = pgTable(
  "system_notice",
  {
    id: serial("id").primaryKey(),
    title: varchar("title", { length: 64 }).default("").notNull(),
    type: varchar("type", { length: 64 }).default("").notNull(),
    icon: varchar("icon", { length: 16 }).default("").notNull(),
    url: varchar("url", { length: 64 }).default("").notNull(),
    tableTitle: varchar("table_title", { length: 256 }).default("").notNull(),
    template: varchar("template", { length: 64 }).default("").notNull(),
    pushAdmin: varchar("push_admin", { length: 128 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
  },
  (t) => [
    uniqueIndex("snotice_type").on(t.type),
    index("snotice_status").on(t.status),
  ],
);

export const systemNoticeAdmin = pgTable(
  "system_notice_admin",
  {
    id: serial("id").primaryKey(),
    noticeType: varchar("notice_type", { length: 64 }).default("").notNull(),
    adminId: integer("admin_id").default(0).notNull(),
    linkId: integer("link_id").default(0).notNull(),
    tableData: text("table_data"),
    isClick: smallint("is_click").default(0).notNull(),
    isVisit: smallint("is_visit").default(0).notNull(),
    visitTime: integer("visit_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sna_admin_type").on(t.adminId, t.noticeType),
    index("sna_add_time").on(t.addTime),
    index("sna_visit_click").on(t.isVisit, t.isClick),
  ],
);

export const userNotice = pgTable(
  "user_notice",
  {
    id: serial("id").primaryKey(),
    uid: text("uid"),
    type: smallint("type").default(1).notNull(),
    user: varchar("user", { length: 20 }).default("").notNull(),
    title: varchar("title", { length: 20 }).default("").notNull(),
    content: varchar("content", { length: 500 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isSend: smallint("is_send").default(0).notNull(),
    sendTime: integer("send_time").default(0).notNull(),
  },
  (t) => [index("un_send_time").on(t.isSend, t.addTime)],
);

export const userNoticeSee = pgTable(
  "user_notice_see",
  {
    id: serial("id").primaryKey(),
    nid: integer("nid").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("uns_uid_nid").on(t.uid, t.nid),
    index("uns_nid").on(t.nid),
  ],
);
