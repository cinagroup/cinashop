/**
 * 管理后台 + 客服 schema (M7)
 *
 * 对应:
 *   - eb_system_admin       管理员账号
 *   - eb_system_role        角色权限
 *   - eb_store_service      客服账号
 *   - eb_store_service_log  聊天消息记录
 *   - eb_store_service_record 会话摘要 (最后消息 + 未读数)
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

// ─── 管理员 ──────────────────────────────────────────────────
export const systemAdmin = pgTable(
  "system_admin",
  {
    id: serial("id").primaryKey(),
    account: varchar("account", { length: 32 }).default("").notNull(),
    /** 1=平台 2=门店 4=供应商 */
    adminType: smallint("admin_type").default(1).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    headPic: varchar("head_pic", { length: 255 }).default("").notNull(),
    /** bcrypt hash (PHP $2y$ 格式) */
    pwd: varchar("pwd", { length: 100 }).default("").notNull(),
    realName: varchar("real_name", { length: 16 }).default("").notNull(),
    phone: varchar("phone", { length: 32 }).default("").notNull(),
    /** 角色ID逗号串 */
    roles: varchar("roles", { length: 128 }).default("").notNull(),
    lastIp: varchar("last_ip", { length: 16 }).default("").notNull(),
    lastTime: integer("last_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    loginCount: integer("login_count").default(0).notNull(),
    /** 0=超级管理员 (跳过权限检查) */
    level: smallint("level").default(1).notNull(),
    status: smallint("status").default(1).notNull(),
    divisionId: integer("division_id").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [index("sa_account").on(t.account), index("sa_status").on(t.status)],
);

// ─── 角色 ────────────────────────────────────────────────────
export const systemRole = pgTable("system_role", {
  id: serial("id").primaryKey(),
  type: smallint("type").default(0).notNull(),
  relationId: integer("relation_id").default(0).notNull(),
  roleName: varchar("role_name", { length: 32 }).default("").notNull(),
  /** 菜单ID逗号串 */
  rules: text("rules").default("").notNull(),
  level: smallint("level").default(0).notNull(),
  status: smallint("status").default(1).notNull(),
});

// ─── 客服账号 ────────────────────────────────────────────────
export const storeService = pgTable(
  "store_service",
  {
    id: serial("id").primaryKey(),
    merId: integer("mer_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    online: smallint("online").default(0).notNull(),
    account: varchar("account", { length: 64 }).default("").notNull(),
    password: varchar("password", { length: 100 }).default("").notNull(),
    avatar: varchar("avatar", { length: 255 }).default("").notNull(),
    nickname: varchar("nickname", { length: 50 }).default("").notNull(),
    phone: varchar("phone", { length: 18 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    accountStatus: smallint("account_status").default(1).notNull(),
    status: smallint("status").default(1).notNull(),
    notify: smallint("notify").default(1).notNull(),
    customer: smallint("customer").default(0).notNull(),
    uniqid: varchar("uniqid", { length: 50 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [index("ss_account").on(t.account)],
);

// ─── 聊天消息记录 ───────────────────────────────────────────
export const storeServiceLog = pgTable(
  "store_service_log",
  {
    id: serial("id").primaryKey(),
    merId: integer("mer_id").default(0).notNull(),
    /** 消息内容 (文字/图片URL/商品ID/订单ID) */
    msn: text("msn").default("").notNull(),
    /** 发送者 uid */
    uid: integer("uid").default(0).notNull(),
    /** 接收者 uid */
    toUid: integer("to_uid").default(0).notNull(),
    isTourist: smallint("is_tourist").default(0).notNull(),
    timeNode: smallint("time_node").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    /** 已读标记: 0=未读 1=已读 */
    type: smallint("type").default(0).notNull(),
    remind: smallint("remind").default(0).notNull(),
    /** 消息类型: 1文字 2表情 3图片 4语音 5商品 6订单 7退款 */
    msnType: smallint("msn_type").default(1).notNull(),
  },
  (t) => [
    index("ssl_uid_toUid").on(t.uid, t.toUid),
    index("ssl_add_time").on(t.addTime),
  ],
);

// ─── 会话摘要 ───────────────────────────────────────────────
export const storeServiceRecord = pgTable(
  "store_service_record",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").default(0).notNull(),
    toUid: integer("to_uid").default(0).notNull(),
    nickname: varchar("nickname", { length: 50 }).default("").notNull(),
    avatar: varchar("avatar", { length: 255 }).default("").notNull(),
    isTourist: smallint("is_tourist").default(0).notNull(),
    online: smallint("online").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    /** 未读数 (注意 PHP 的拼写错误 "mssage", 这里纠正为 message) */
    messageNum: integer("mssage_num").default(0).notNull(),
    /** 最后消息预览 */
    message: text("message").default("").notNull(),
    messageType: smallint("message_type").default(1).notNull(),
  },
  (t) => [index("ssr_to_uid").on(t.toUid)],
);
