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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    /** 退款流水对应的原佣金类型；解决同一用户同时取得多类佣金时的累计冲正归属。 */
    sourceType: varchar("source_type", { length: 64 }).default("").notNull(),
    number: decimal("number", { precision: 12, scale: 2 }).default("0.00").notNull(),
    balance: decimal("balance", { precision: 12, scale: 2 }).default("0.00").notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    /** 0=冻结 1=有效 -1=无效 */
    status: smallint("status").default(0).notNull(),
    /** 对应 PHP take；订单佣金在确认收货时为 1。 */
    take: smallint("take").default(0).notNull(),
    /** 冻结截止 Unix 秒；余额字段含冻结额，提现时必须扣除未到期金额。 */
    frozenTime: integer("frozen_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("ub_uid").on(t.uid),
    index("ub_link").on(t.linkId),
    index("ub_cat_type").on(t.category, t.type),
    index("ub_refund_source").on(t.linkId, t.pm, t.type, t.sourceType),
    index("ub_frozen_ready").on(t.frozenTime, t.uid).where(
      sql`${t.pm} = 1 AND ${t.status} = 1`,
    ),
    uniqueIndex("ub_order_income_uq")
      .on(t.uid, t.linkId, t.type)
      .where(sql`${t.pm} = 1 AND ${t.type} IN ('self_brokerage', 'one_brokerage', 'two_brokerage')`),
    uniqueIndex("ub_order_division_income_uq")
      .on(t.uid, t.linkId, t.type)
      .where(sql`${t.pm} = 1 AND ${t.type} IN ('staff_brokerage', 'agent_brokerage', 'division_brokerage')`),
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
    bankAddress: varchar("bank_address", { length: 256 }).default("").notNull(),
    realName: varchar("real_name", { length: 64 }).default("").notNull(),
    /** 卡号/账号 */
    extractNumber: varchar("extract_number", { length: 64 }).default("").notNull(),
    alipayCode: varchar("alipay_code", { length: 64 }).default("").notNull(),
    extractPrice: decimal("extract_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    extractFee: decimal("extract_fee", { precision: 12, scale: 2 }).default("0.00").notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    /** PHP snapshot of the user's brokerage balance before the request. */
    balance: decimal("balance", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** -1=已拒绝 0=待审核 1=已通过 */
    status: smallint("status").default(0).notNull(),
    failMsg: varchar("fail_msg", { length: 255 }).default("").notNull(),
    failTime: integer("fail_time").default(0).notNull(),
    wechat: varchar("wechat", { length: 15 }).default("").notNull(),
    qrcodeUrl: varchar("qrcode_url", { length: 255 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("ue_uid").on(t.uid),
    index("ue_uid_time").on(t.uid, t.addTime),
    index("ue_status_time").on(t.status, t.addTime),
  ],
);

/** Distributor application. Historical duplicates remain importable. */
export const promoterApply = pgTable(
  "promoter_apply",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    nickname: varchar("nickname", { length: 255 }).default("").notNull(),
    realName: varchar("real_name", { length: 255 }).default("").notNull(),
    phone: varchar("phone", { length: 32 }).default("0").notNull(),
    /** 0=pending, 1=approved, 2=rejected */
    status: smallint("status").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    statusTime: integer("status_time").default(0).notNull(),
    refusalReason: varchar("refusal_reason", { length: 1000 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [
    index("pa_uid_active").on(t.uid, t.isDel, t.id),
    index("pa_status_time").on(t.status, t.isDel, t.addTime, t.id),
  ],
);

/** Append-only audit history for distributor relationship changes. */
export const userSpread = pgTable(
  "user_spread",
  {
    id: serial("id").primaryKey(),
    storeId: integer("store_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    staffId: integer("staff_id").default(0).notNull(),
    spreadUid: integer("spread_uid").default(0).notNull(),
    spreadTime: integer("spread_time").default(0).notNull(),
    adminId: integer("admin_id").default(0).notNull(),
  },
  (t) => [
    index("us_uid").on(t.uid),
    index("us_spread_uid").on(t.spreadUid),
    index("us_uid_time").on(t.uid, t.spreadTime, t.id),
    index("us_parent_time").on(t.spreadUid, t.spreadTime, t.id),
    index("us_store_staff_time").on(t.storeId, t.staffId, t.spreadTime, t.id),
  ],
);

/** Bidirectional friend evidence created when a distributor relationship binds. */
export const userFriends = pgTable(
  "user_friends",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    friendsUid: integer("friends_uid").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("uf_uid").on(t.uid),
    index("uf_friends_uid").on(t.friendsUid),
    index("uf_pair").on(t.uid, t.friendsUid, t.id),
  ],
);

/**
 * Deprecated PHP freeze ledger retained only as migration evidence.
 * Active commission code uses user_brokerage.frozen_time instead.
 */
export const userBrokerageFrozen = pgTable(
  "user_brokerage_frozen",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0").notNull(),
    /** Preserve the source typo verbatim. */
    uillId: integer("uill_id").default(0).notNull(),
    frozenTime: integer("frozen_time").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    orderId: varchar("order_id", { length: 50 }).default("").notNull(),
  },
  (t) => [
    index("ubf_uid_status").on(t.uid, t.status),
    index("ubf_uid_frozen_time").on(t.uid, t.frozenTime, t.id),
    index("ubf_order_id").on(t.orderId),
  ],
);
