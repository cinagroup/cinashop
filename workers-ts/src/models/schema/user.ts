/**
 * 用户表 schema
 *
 * 对应 PHP app/model/user/User.php + MySQL eb_user 表。
 * 字段、类型、索引与原表一一对应, 保证数据兼容 (同一套库)。
 *
 * 关键约定:
 *   - pwd 是 md5(password), 与 PHP md5((string)$password) 兼容
 *   - 时间戳用 int (add_time/last_time), delete_time 用 timestamp (软删除)
 *   - 金额用 numeric(12,2), 积分用 int
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  timestamp,
  numeric,
  smallint,
  text,
  index,
} from "drizzle-orm/pg-core";

export const user = pgTable(
  "user",
  {
    uid: serial("uid").primaryKey(),
    account: varchar("account", { length: 32 }).default("").notNull(),
    /** md5(password) —— 与 PHP 端兼容, 不要改成 bcrypt */
    pwd: varchar("pwd", { length: 32 }).default("").notNull(),
    realName: varchar("real_name", { length: 25 }).default("").notNull(),
    birthday: integer("birthday").default(0).notNull(),
    cardId: varchar("card_id", { length: 20 }).default("").notNull(),
    mark: varchar("mark", { length: 255 }).default("").notNull(),
    partnerId: integer("partner_id").default(0).notNull(),
    groupId: integer("group_id").default(0).notNull(),
    nickname: varchar("nickname", { length: 60 }).default("").notNull(),
    avatar: varchar("avatar", { length: 256 }).default("").notNull(),
    phone: varchar("phone", { length: 15 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    addIp: varchar("add_ip", { length: 45 }).default("").notNull(),
    lastTime: integer("last_time").default(0).notNull(),
    lastIp: varchar("last_ip", { length: 45 }).default("").notNull(),
    /** 余额 */
    nowMoney: numeric("now_money", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 佣金 */
    brokeragePrice: numeric("brokerage_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    integral: integer("integral").default(0).notNull(),
    /** 经验值 */
    exp: numeric("exp", { precision: 12, scale: 2 }).default("0.00").notNull(),
    signNum: integer("sign_num").default(0).notNull(),
    signRemind: smallint("sign_remind").default(0).notNull(),
    /** 1=正常 0=禁止 */
    status: smallint("status").default(1).notNull(),
    level: integer("level").default(0).notNull(),
    agentLevel: integer("agent_level").default(0).notNull(),
    spreadOpen: smallint("spread_open").default(1).notNull(),
    spreadUid: integer("spread_uid").default(0).notNull(),
    spreadTime: integer("spread_time").default(0).notNull(),
    spreadLottery: integer("spread_lottery").default(1).notNull(),
    workUid: integer("work_uid").default(0).notNull(),
    workUserid: varchar("work_userid", { length: 64 }).default("").notNull(),
    userType: varchar("user_type", { length: 32 }).default("").notNull(),
    isPromoter: smallint("is_promoter").default(0).notNull(),
    payCount: integer("pay_count").default(0).notNull(),
    spreadCount: integer("spread_count").default(0).notNull(),
    cleanTime: integer("clean_time").default(0).notNull(),
    addres: varchar("addres", { length: 255 }).default("").notNull(),
    adminid: integer("adminid").default(0).notNull(),
    loginType: varchar("login_type", { length: 36 }).default("").notNull(),
    loginCity: varchar("login_city", { length: 255 }).default("").notNull(),
    recordPhone: varchar("record_phone", { length: 11 }).default("").notNull(),
    isMoneyLevel: smallint("is_money_level").default(0).notNull(),
    isEverLevel: smallint("is_ever_level").default(0).notNull(),
    overdueTime: integer("overdue_time").default(0).notNull(),
    uniqid: varchar("uniqid", { length: 32 }).default("").notNull(),
    barCode: varchar("bar_code", { length: 32 }).default("").notNull(),
    randCode: integer("rand_code").default(0).notNull(),
    /** 0=其他 1=男 2=女 */
    sex: smallint("sex").default(0).notNull(),
    provincials: varchar("provincials", { length: 255 }).default("").notNull(),
    province: integer("province").default(0).notNull(),
    city: integer("city").default(0).notNull(),
    area: integer("area").default(0).notNull(),
    street: integer("street").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    /** 软删除时间戳, 为 NULL 表示未删除 */
    deleteTime: timestamp("delete_time", { mode: "date" }),
    extendInfo: text("extend_info"),
    levelStatus: smallint("level_status").default(0).notNull(),
    levelExtendInfo: text("level_extend_info"),
    isFirstOrder: smallint("is_first_order").default(0).notNull(),
    isNewcomer: smallint("is_newcomer").default(0).notNull(),
  },
  (t) => [
    index("account").on(t.account),
    index("spreaduid").on(t.spreadUid),
    index("level").on(t.level),
    index("status").on(t.status),
    index("work_uid").on(t.workUid),
    index("is_promoter").on(t.isPromoter, t.phone),
    index("phone").on(t.phone),
    index("index_0").on(t.deleteTime),
    index("add_time_delete_sex").on(t.addTime, t.deleteTime, t.sex),
  ],
);

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
