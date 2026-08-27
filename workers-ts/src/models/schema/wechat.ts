/**
 * 微信用户表 schema (M6)
 *
 * 对应 eb_wechat_user — openid → uid 绑定表。
 * user_type 区分来源: wechat(公众号) | routine(小程序) | h5 | app
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  smallint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const wechatUser = pgTable(
  "wechat_user",
  {
    id: serial("id").primaryKey(),
    /** 关联 eb_user.uid */
    uid: integer("uid").default(0).notNull(),
    unionid: varchar("unionid", { length: 30 }).default("").notNull(),
    /** 用户标识 (对当前公众号/小程序唯一) */
    openid: varchar("openid", { length: 100 }).default("").notNull(),
    nickname: varchar("nickname", { length: 64 }).default("").notNull(),
    headimgurl: varchar("headimgurl", { length: 256 }).default("").notNull(),
    /** 1男 2女 0未知 */
    sex: smallint("sex").default(0).notNull(),
    city: varchar("city", { length: 64 }).default("").notNull(),
    language: varchar("language", { length: 64 }).default("").notNull(),
    province: varchar("province", { length: 64 }).default("").notNull(),
    country: varchar("country", { length: 64 }).default("").notNull(),
    remark: varchar("remark", { length: 256 }).default("").notNull(),
    groupid: smallint("groupid").default(0).notNull(),
    tagidList: varchar("tagid_list", { length: 256 }).default("").notNull(),
    subscribe: smallint("subscribe").default(1).notNull(),
    subscribeTime: integer("subscribe_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    /** 二级推荐人 */
    second: integer("second").default(0).notNull(),
    /** wechat|routine|h5|app */
    userType: varchar("user_type", { length: 32 }).default("wechat").notNull(),
    /** 授权信息是否完整 */
    isComplete: smallint("is_complete").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("wu_openid_uq").on(t.openid),
    index("wu_unionid").on(t.unionid),
    index("wu_uid").on(t.uid),
    index("wu_uid_type_latest").on(t.uid, t.userType, t.id),
  ],
);
