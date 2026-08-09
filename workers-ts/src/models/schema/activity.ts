/**
 * 营销活动 schema (M5)
 *
 * 对应:
 *   - eb_store_coupon_issue    优惠券模板 (可领取)
 *   - eb_store_coupon_user     用户已领优惠券
 *   - eb_store_seckill         秒杀活动
 *   - eb_store_seckill_time    秒杀时间段
 *   - eb_store_combination     拼团活动
 *   - eb_store_pink            拼团团 (进行中的团)
 *   - eb_store_bargain         砍价活动
 *   - eb_store_integral        积分商品
 *
 * M5 只实现只读 + 领券; 秒杀/拼团/砍价的"参与"写操作留后续。
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// ─── 优惠券模板 (可领取) ───────────────────────────────────
export const storeCouponIssue = pgTable(
  "store_coupon_issue",
  {
    id: serial("id").primaryKey(),
    /** 1=通用券 2=商品券 3=品类券 4=品牌券 */
    couponType: smallint("coupon_type").default(1).notNull(),
    couponTitle: varchar("coupon_title", { length: 64 }).default("").notNull(),
    /** 1=满减 2=折扣 */
    type: smallint("type").default(1).notNull(),
    couponPrice: decimal("coupon_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    useMinPrice: decimal("use_min_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 商品/品类/品牌 ID (逗号分隔, coupon_type=2/3/4 时用) */
    productId: varchar("product_id", { length: 500 }).default("0").notNull(),
    category_id: varchar("category_id", { length: 500 }).default("0").notNull(),
    brandId: varchar("brand_id", { length: 500 }).default("0").notNull(),
    /** 总发行量 (0=无限) */
    totalCount: integer("total_count").default(0).notNull(),
    /** 剩余可领 */
    remainCount: integer("remain_count").default(0).notNull(),
    /** 每人限领 */
    receiveLimit: smallint("receive_limit").default(1).notNull(),
    /** 0=永久 1=固定时段 */
    receiveType: smallint("receive_type").default(0).notNull(),
    startTime: timestamp("start_time", { mode: "date" }),
    endTime: timestamp("end_time", { mode: "date" }),
    /** 有效天数 (receive_type=0 时) */
    day: integer("day").default(0).notNull(),
    /** 0=可用 1=停发 */
    status: smallint("status").default(0).notNull(),
    /** 0=全部 1=SVIP */
    appType: smallint("app_type").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("sci_status").on(t.status), index("sci_type").on(t.couponType)],
);

// ─── 用户已领优惠券 ─────────────────────────────────────────
export const storeCouponUser = pgTable(
  "store_coupon_user",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    issueCouponId: integer("issue_coupon_id").default(0).notNull(),
    couponTitle: varchar("coupon_title", { length: 64 }).default("").notNull(),
    couponPrice: decimal("coupon_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    useMinPrice: decimal("use_min_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 0=未使用 1=已使用 2=已过期 */
    status: smallint("status").default(0).notNull(),
    startTime: timestamp("start_time", { mode: "date" }),
    endTime: timestamp("end_time", { mode: "date" }),
    useTime: timestamp("use_time", { mode: "date" }),
    /** 类型快照 */
    type: smallint("type").default(1).notNull(),
    receiveTime: integer("receive_time").default(0).notNull(),
  },
  (t) => [index("scu_uid_status").on(t.uid, t.status)],
);

// ─── 秒杀活动 ────────────────────────────────────────────────
export const storeSeckill = pgTable(
  "store_seckill",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    /** 时间段 ID 逗号串 (关联 store_seckill_time) */
    timeId: varchar("time_id", { length: 64 }).default("").notNull(),
    storeName: varchar("store_name", { length: 256 }).default("").notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    otPrice: decimal("ot_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 限购 */
    num: integer("num").default(0).notNull(),
    /** 总库存 */
    quota: integer("quota").default(0).notNull(),
    quotaShow: integer("quota_show").default(0).notNull(),
    stock: integer("stock").default(0).notNull(),
    sales: integer("sales").default(0).notNull(),
    startTime: timestamp("start_time", { mode: "date" }),
    stopTime: timestamp("stop_time", { mode: "date" }),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("ss_time").on(t.timeId), index("ss_status").on(t.status)],
);

// ─── 秒杀时间段 ─────────────────────────────────────────────
export const storeSeckillTime = pgTable(
  "store_seckill_time",
  {
    id: serial("id").primaryKey(),
    /** "HH:mm" 开始时间 */
    startTime: varchar("start_time", { length: 8 }).default("").notNull(),
    endTime: varchar("end_time", { length: 8 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
);

// ─── 拼团活动 ────────────────────────────────────────────────
export const storeCombination = pgTable(
  "store_combination",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    storeName: varchar("store_name", { length: 256 }).default("").notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    otPrice: decimal("ot_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 成团人数 */
    people: integer("people").default(2).notNull(),
    /** 限购 */
    num: integer("num").default(0).notNull(),
    quota: integer("quota").default(0).notNull(),
    quotaShow: integer("quota_show").default(0).notNull(),
    stock: integer("stock").default(0).notNull(),
    sales: integer("sales").default(0).notNull(),
    startTime: timestamp("start_time", { mode: "date" }),
    stopTime: timestamp("stop_time", { mode: "date" }),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("scomb_status").on(t.status)],
);

// ─── 拼团团 (进行中) ────────────────────────────────────────
export const storePink = pgTable(
  "store_pink",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    orderId: varchar("order_id", { length: 32 }).default("").notNull(),
    orderIdKey: varchar("order_id_key", { length: 32 }).default("").notNull(),
    combinationId: integer("combination_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    /** 团长 ID (k_id=0 表示自己是团长) */
    kId: integer("k_id").default(0).notNull(),
    /** 总人数 */
    people: integer("people").default(0).notNull(),
    /** 1=进行中 2=成功 3=失败 */
    status: smallint("status").default(1).notNull(),
    stopTime: timestamp("stop_time", { mode: "date" }),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("sp_combination").on(t.combinationId), index("sp_kid").on(t.kId)],
);

// ─── 砍价活动 ────────────────────────────────────────────────
export const storeBargain = pgTable(
  "store_bargain",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    storeName: varchar("store_name", { length: 256 }).default("").notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    /** 最低价 */
    minPrice: decimal("min_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 原价 */
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    quota: integer("quota").default(0).notNull(),
    quotaShow: integer("quota_show").default(0).notNull(),
    stock: integer("stock").default(0).notNull(),
    sales: integer("sales").default(0).notNull(),
    /** 帮砍次数 */
    people: integer("people").default(0).notNull(),
    startTime: timestamp("start_time", { mode: "date" }),
    stopTime: timestamp("stop_time", { mode: "date" }),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("sbarg_status").on(t.status)],
);

// ─── 积分商品 ────────────────────────────────────────────────
export const storeIntegral = pgTable(
  "store_integral",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    storeName: varchar("store_name", { length: 256 }).default("").notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    /** 积分价格 */
    integral: integer("integral").default(0).notNull(),
    /** 可选现金价 (0=纯积分) */
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    otPrice: decimal("ot_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    quota: integer("quota").default(0).notNull(),
    quotaShow: integer("quota_show").default(0).notNull(),
    stock: integer("stock").default(0).notNull(),
    sales: integer("sales").default(0).notNull(),
    num: integer("num").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("sint_status").on(t.status)],
);
