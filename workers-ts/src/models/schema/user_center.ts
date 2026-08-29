/**
 * 用户中心 schema (M5)
 *
 * 对应:
 *   - eb_user_address   收货地址
 *   - eb_user_relation  收藏/点赞 (type+category 多态, 替代 PHP 的 user_collect)
 *   - eb_user_sign      签到记录 (连续天数在 user.sign_num)
 *   - eb_user_money     余额流水 (钱, 与 user_bill 积分流水分离)
 *   - eb_user_recharge  充值订单
 *   - eb_user_invoice   发票
 *
 * 关键修复 (相比 PHP):
 *   - user_relation 加 UNIQUE(uid, relation_id, type, category) 修复 PHP 并发重复收藏 bug
 *   - user_sign 加 UNIQUE(uid, 上海自然日) 阻断 PHP/Worker 跨运行时重复签到
 *   - 默认地址用应用层保证唯一 (PHP 也是应用层)
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── 收货地址 ────────────────────────────────────────────────
export const userAddress = pgTable(
  "user_address",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    realName: varchar("real_name", { length: 32 }).default("").notNull(),
    phone: varchar("phone", { length: 16 }).default("").notNull(),
    province: varchar("province", { length: 64 }).default("").notNull(),
    city: varchar("city", { length: 64 }).default("").notNull(),
    district: varchar("district", { length: 64 }).default("").notNull(),
    street: varchar("street", { length: 100 }).default("").notNull(),
    cityId: integer("city_id").default(0).notNull(),
    detail: varchar("detail", { length: 256 }).default("").notNull(),
    postCode: integer("post_code").default(0).notNull(),
    longitude: varchar("longitude", { length: 16 }).default("").notNull(),
    latitude: varchar("latitude", { length: 16 }).default("").notNull(),
    isDefault: smallint("is_default").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("ua_uid_idx").on(t.uid)],
);

// ─── 收藏/点赞 (多态关系表) ────────────────────────────────
export const userRelation = pgTable(
  "user_relation",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    /** 关联的商品/文章/视频 ID */
    relationId: integer("relation_id").default(0).notNull(),
    /** 'collect' | 'like' */
    type: varchar("type", { length: 32 }).default("").notNull(),
    /** 'product' | 'seckill' | 'article' | 'video' */
    category: varchar("category", { length: 32 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    // 修复 PHP 缺失的唯一约束: 防并发重复收藏
    uniqueIndex("ur_uid_rel_type_cat_idx").on(t.uid, t.relationId, t.type, t.category),
    index("ur_uid_type_idx").on(t.uid, t.type),
    index("ur_collect_category_relation_idx")
      .on(t.category, t.relationId)
      .where(sql`${t.type} = 'collect'`),
    index("ur_user_product_collect_latest")
      .on(t.uid, t.addTime.desc(), t.id.desc(), t.relationId)
      .where(sql`${t.type} = 'collect' AND ${t.category} = 'product'`),
  ],
);

// ─── 签到记录 ────────────────────────────────────────────────
export const userSign = pgTable(
  "user_sign",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    title: varchar("title", { length: 255 }).default("").notNull(),
    /** 本次签到获得的积分 */
    number: integer("number").default(0).notNull(),
    /** 签到后剩余积分 */
    balance: integer("balance").default(0).notNull(),
    /** 本次获得经验 */
    expNum: integer("exp_num").default(0).notNull(),
    expBalance: integer("exp_balance").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("us_uid_time_idx").on(t.uid, t.addTime),
    uniqueIndex("us_uid_shanghai_day_uq")
      .on(t.uid, sql`(((${t.addTime})::bigint + 28800) / 86400)`),
  ],
);

// ─── 余额流水 (钱) ──────────────────────────────────────────
export const userMoney = pgTable(
  "user_money",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    linkId: varchar("link_id", { length: 32 }).default("0").notNull(),
    type: varchar("type", { length: 64 }).default("").notNull(),
    title: varchar("title", { length: 64 }).default("").notNull(),
    number: decimal("number", { precision: 12, scale: 2 }).default("0.00").notNull(),
    balance: decimal("balance", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 0=支出 1=收入 */
    pm: smallint("pm").default(0).notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("um_uid").on(t.uid),
    index("um_type_link").on(t.type, t.linkId),
    uniqueIndex("um_out_request_uq")
      .on(t.uid, t.linkId, t.type)
      .where(sql`${t.type} IN ('system_add', 'system_sub') AND ${t.linkId} ~ '^[0-9a-f]{32}$'`),
  ],
);

// ─── 充值订单 ────────────────────────────────────────────────
export const userRecharge = pgTable(
  "user_recharge",
  {
    id: serial("id").primaryKey(),
    storeId: integer("store_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    staffId: integer("staff_id").default(0).notNull(),
    /** 订单号 (前缀 cz) */
    orderId: varchar("order_id", { length: 32 }).default("").notNull(),
    tradeNo: varchar("trade_no", { length: 100 }).default("").notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 赠送金额 */
    givePrice: decimal("give_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    rechargeType: varchar("recharge_type", { length: 32 }).default("").notNull(),
    authCode: varchar("auth_code", { length: 50 }).default("").notNull(),
    paid: smallint("paid").default(0).notNull(),
    payTime: integer("pay_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    refundPrice: decimal("refund_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    channelType: varchar("channel_type", { length: 255 }).default("").notNull(),
    remarks: varchar("remarks", { length: 255 }).default("").notNull(),
  },
  (t) => [
    index("ur_order_id_lookup").on(t.orderId),
    index("ur_uid").on(t.uid),
    index("ur_uid_paid_time").on(t.uid, t.paid, t.addTime, t.id),
  ],
);

// ─── 发票 ────────────────────────────────────────────────────
export const userInvoice = pgTable(
  "user_invoice",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    /** 1=个人 2=企业 */
    headerType: smallint("header_type").default(1).notNull(),
    /** 1=普通 2=专用 */
    type: smallint("type").default(1).notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    dutyNumber: varchar("duty_number", { length: 50 }).default("").notNull(),
    drawerPhone: varchar("drawer_phone", { length: 30 }).default("").notNull(),
    email: varchar("email", { length: 100 }).default("").notNull(),
    tell: varchar("tell", { length: 30 }).default("").notNull(),
    address: varchar("address", { length: 255 }).default("").notNull(),
    bank: varchar("bank", { length: 50 }).default("").notNull(),
    cardNumber: varchar("card_number", { length: 50 }).default("").notNull(),
    isDefault: smallint("is_default").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("ui_uid").on(t.uid)],
);
