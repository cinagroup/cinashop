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
import { sql } from "drizzle-orm";

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
    /** 旧后台图片上传方式：0 本地、1 网络、2 扫码。 */
    isWay: smallint("is_way").default(0).notNull(),
    divisionId: integer("division_id").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [
    index("sa_account").on(t.account),
    index("sa_status").on(t.status),
    index("sa_division").on(t.divisionId, t.isDel, t.status),
  ],
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

// ─── 后台菜单/接口权限 ────────────────────────────────────────────────
// 保留 PHP eb_system_menus 的字段，便于已迁移角色中的数字 rules 继续解析。
export const systemMenus = pgTable(
  "system_menus",
  {
    id: serial("id").primaryKey(),
    pid: integer("pid").default(0).notNull(),
    type: smallint("type").default(1).notNull(),
    icon: varchar("icon", { length: 50 }).default("").notNull(),
    menuName: varchar("menu_name", { length: 64 }).default("").notNull(),
    module: varchar("module", { length: 32 }).default("").notNull(),
    controller: varchar("controller", { length: 64 }).default("").notNull(),
    action: varchar("action", { length: 32 }).default("").notNull(),
    apiUrl: varchar("api_url", { length: 255 }).default("").notNull(),
    methods: varchar("methods", { length: 32 }).default("").notNull(),
    params: varchar("params", { length: 512 }).default("[]").notNull(),
    sort: integer("sort").default(1).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    isShowPath: smallint("is_show_path").default(0).notNull(),
    access: smallint("access").default(1).notNull(),
    menuPath: varchar("menu_path", { length: 255 }).default("").notNull(),
    path: varchar("path", { length: 255 }).default("").notNull(),
    authType: smallint("auth_type").default(0).notNull(),
    header: varchar("header", { length: 50 }).default("").notNull(),
    isHeader: smallint("is_header").default(0).notNull(),
    uniqueAuth: varchar("unique_auth", { length: 150 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [
    index("sm_parent_sort").on(t.type, t.pid, t.sort),
    index("sm_unique_auth").on(t.uniqueAuth, t.isDel),
    index("sm_api_method").on(t.type, t.authType, t.methods, t.apiUrl, t.isDel),
  ],
);

// ─── 管理员操作日志 ────────────────────────────────────────────
export const systemLog = pgTable(
  "system_log",
  {
    id: serial("id").primaryKey(),
    storeId: integer("store_id").default(0).notNull(),
    adminId: integer("admin_id").default(0).notNull(),
    adminName: varchar("admin_name", { length: 64 }).default("").notNull(),
    path: varchar("path", { length: 128 }).default("").notNull(),
    page: varchar("page", { length: 64 }).default("").notNull(),
    method: varchar("method", { length: 12 }).default("").notNull(),
    /** Worker-native action summary; legacy rows retain page/method/path separately. */
    action: varchar("action", { length: 255 }).default("").notNull(),
    ip: varchar("ip", { length: 45 }).default("").notNull(),
    type: varchar("type", { length: 32 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    merchantId: integer("merchant_id").default(0).notNull(),
  },
  (t) => [
    index("syslog_admin_time").on(t.adminId, t.addTime),
    index("syslog_type_time").on(t.type, t.addTime),
  ],
);

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
  (t) => [
    index("ss_account").on(t.account),
    index("ss_active_online")
      .on(t.online, t.id)
      .where(sql`${t.isDel} = 0 AND ${t.status} = 1 AND ${t.accountStatus} = 1`),
    index("ss_active_uid")
      .on(t.uid, t.id)
      .where(sql`${t.isDel} = 0 AND ${t.status} = 1 AND ${t.accountStatus} = 1`),
  ],
);

// ─── 用户反馈 ────────────────────────────────────────────────
export const storeServiceFeedback = pgTable(
  "store_service_feedback",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    relaName: varchar("rela_name", { length: 255 }).default("").notNull(),
    phone: varchar("phone", { length: 30 }).default("").notNull(),
    content: varchar("content", { length: 500 }).default("").notNull(),
    make: varchar("make", { length: 255 }).default("").notNull(),
    /** 0=unread/unprocessed, 1=processed */
    status: smallint("status").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("ssf_uid").on(t.uid),
    index("ssf_status_time").on(t.status, t.addTime, t.id),
  ],
);

// ─── 客服快捷话术 ────────────────────────────────────────────
export const storeServiceSpeechcraft = pgTable(
  "store_service_speechcraft",
  {
    id: serial("id").primaryKey(),
    /** 0=platform-global, otherwise the legacy customer-service user id */
    kefuId: integer("kefu_id").default(0).notNull(),
    /** category.id where type=0/group=1 and owner_id matches kefu_id */
    cateId: integer("cate_id").default(0).notNull(),
    title: varchar("title", { length: 100 }).default("").notNull(),
    message: varchar("message", { length: 255 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sss_kefu_id").on(t.kefuId),
    index("sss_cate_id").on(t.cateId),
    index("sss_scope_sort").on(t.kefuId, t.cateId, t.sort, t.id),
  ],
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
    index("ssl_chat_history").on(t.uid, t.toUid, t.isTourist, t.id),
    index("ssl_unread_direction")
      .on(t.uid, t.toUid, t.isTourist, t.id)
      .where(sql`${t.type} = 0`),
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
  (t) => [
    index("ssr_to_uid").on(t.toUid),
    index("ssr_kefu_recent").on(t.toUid, t.isTourist, t.updateTime, t.id),
    index("ssr_kefu_inbox").on(t.userId, t.isTourist, t.updateTime, t.id),
    index("ssr_direction").on(t.userId, t.toUid, t.isTourist, t.id),
  ],
);

// ─── 客服转接审计 ───────────────────────────────────────────
// Message bodies stay in store_service_log. This table records only the
// immutable ownership transition needed for idempotency and operations audit.
export const storeServiceTransfer = pgTable(
  "store_service_transfer",
  {
    requestKey: varchar("request_key", { length: 36 }).primaryKey(),
    customerUid: integer("customer_uid").notNull(),
    fromKefuUid: integer("from_kefu_uid").notNull(),
    toKefuUid: integer("to_kefu_uid").notNull(),
    fromServiceId: integer("from_service_id").notNull(),
    toServiceId: integer("to_service_id").notNull(),
    sourceRecordId: integer("source_record_id").notNull(),
    targetRecordId: integer("target_record_id").notNull(),
    copiedMessageCount: integer("copied_message_count").default(0).notNull(),
    isTourist: smallint("is_tourist").default(0).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("sst_customer_time").on(t.customerUid, t.createdAt, t.requestKey),
    index("sst_customer_scope_time").on(t.customerUid, t.isTourist, t.createdAt, t.requestKey),
    index("sst_target_time").on(t.toKefuUid, t.createdAt, t.requestKey),
  ],
);

// ─── 匿名客服会话 ───────────────────────────────────────────
// The token is stored only as SHA-256. A dedicated high UID range preserves
// the legacy integer chat columns without colliding with registered users.
export const kefuVisitorSession = pgTable(
  "kefu_visitor_session",
  {
    sessionId: varchar("session_id", { length: 36 }).primaryKey(),
    visitorUid: integer("visitor_uid")
      .default(sql`nextval('"kefu_visitor_uid_seq"')`)
      .notNull()
      .unique(),
    serviceId: integer("service_id").notNull(),
    kefuUid: integer("kefu_uid").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    nickname: varchar("nickname", { length: 50 }).default("").notNull(),
    avatar: varchar("avatar", { length: 255 }).default("").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    revokedAt: integer("revoked_at").default(0).notNull(),
  },
  (t) => [
    index("kvs_active_expiry").on(t.expiresAt, t.visitorUid),
    index("kvs_kefu_active").on(t.kefuUid, t.expiresAt, t.visitorUid),
  ],
);
