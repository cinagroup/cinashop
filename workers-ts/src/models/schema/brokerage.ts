/**
 * 分销/佣金 schema
 *
 * 对应 eb_user_brokerage (佣金明细) + eb_user_extract (提现记录)
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  index,
} from "drizzle-orm/pg-core";

/** 佣金明细 (分销收益) */
export const userBrokerage = pgTable(
  "user_brokerage",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    /** 关联订单号 */
    linkId: varchar("link_id", { length: 32 }).default("0").notNull(),
    /** 0=支出 1=获得 */
    pm: smallint("pm").default(0).notNull(),
    title: varchar("title", { length: 64 }).default("").notNull(),
    /** 明细类型: one_brokerage/two_brokerage/extract 等 */
    category: varchar("category", { length: 64 }).default("").notNull(),
    type: varchar("type", { length: 64 }).default("").notNull(),
    number: decimal("number", { precision: 12, scale: 2 }).default("0.00").notNull(),
    balance: decimal("balance", { precision: 12, scale: 2 }).default("0.00").notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    /** 0=冻结 1=有效 -1=无效 */
    status: smallint("status").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("ub_uid").on(t.uid),
    index("ub_link").on(t.linkId),
    index("ub_cat_type").on(t.category, t.type),
  ],
);

/** 提现记录 */
export const userExtract = pgTable(
  "user_extract",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    /** 提现方式: bank/alipay/weixin */
    extractType: varchar("extract_type", { length: 32 }).default("").notNull(),
    /** 银行名称/支付宝/微信 */
    bankName: varchar("bank_name", { length: 64 }).default("").notNull(),
    bankCode: varchar("bank_code", { length: 64 }).default("").notNull(),
    bankAddress: varchar("bank_address", { length: 255 }).default("").notNull(),
    realName: varchar("real_name", { length: 32 }).default("").notNull(),
    /** 卡号/账号 */
    extractNumber: varchar("extract_number", { length: 64 }).default("").notNull(),
    extractPrice: decimal("extract_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 0=待审核 1=已通过 2=已拒绝 */
    status: smallint("status").default(0).notNull(),
    failMsg: varchar("fail_msg", { length: 255 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("ue_uid").on(t.uid)],
);
