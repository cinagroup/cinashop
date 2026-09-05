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
import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  decimal,
  smallint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─── 优惠券模板 (可领取) ───────────────────────────────────
export const storeCouponIssue = pgTable(
  "store_coupon_issue",
  {
    id: serial("id").primaryKey(),
    cid: integer("cid").default(0).notNull(),
    category: smallint("category").default(0).notNull(),
    /** PHP type: 0=通用 1=品类 2=商品 3=品牌 */
    couponType: smallint("coupon_type").default(1).notNull(),
    couponTitle: varchar("coupon_title", { length: 255 }).default("").notNull(),
    /** PHP coupon_type: 1=满减 2=折扣 */
    type: smallint("type").default(1).notNull(),
    couponPrice: decimal("coupon_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    useMinPrice: decimal("use_min_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 商品/品类/品牌 ID (逗号分隔, coupon_type=2/3/4 时用) */
    productId: varchar("product_id", { length: 500 }).default("0").notNull(),
    category_id: varchar("category_id", { length: 500 }).default("0").notNull(),
    brandId: varchar("brand_id", { length: 500 }).default("0").notNull(),
    legacyProductIds: text("legacy_product_ids"),
    legacyCategoryId: integer("legacy_category_id").default(0).notNull(),
    legacyBrandId: integer("legacy_brand_id").default(0).notNull(),
    /** 总发行量 (0=无限) */
    totalCount: integer("total_count").default(0).notNull(),
    /** 剩余可领 */
    remainCount: integer("remain_count").default(0).notNull(),
    /** 每人限领 */
    receiveLimit: smallint("receive_limit").default(0).notNull(),
    /** PHP receive_type: 1=手动领取 2=新人券 3=赠送券 */
    receiveType: smallint("receive_type").default(0).notNull(),
    startTime: timestamp("start_time", { mode: "date" }),
    endTime: timestamp("end_time", { mode: "date" }),
    /** PHP coupon_time: 领取后有效天数；0 使用固定 use_start/end_time。 */
    day: integer("day").default(0).notNull(),
    isPermanent: smallint("is_permanent").default(0).notNull(),
    isGiveSubscribe: smallint("is_give_subscribe").default(0).notNull(),
    isFullGive: smallint("is_full_give").default(0).notNull(),
    fullReduction: decimal("full_reduction", { precision: 12, scale: 2 }).default("0.00").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    title: varchar("title", { length: 64 }).default("").notNull(),
    integral: integer("integral").default(0).notNull(),
    useStartTime: timestamp("use_start_time", { mode: "date" }),
    useEndTime: timestamp("use_end_time", { mode: "date" }),
    rule: text("rule"),
    /** PHP: -1=失效 0=关闭 1=启用 */
    status: smallint("status").default(1).notNull(),
    /** 0=全部 1=SVIP */
    appType: smallint("app_type").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sci_status").on(t.status),
    index("sci_type").on(t.couponType),
    index("sci_claim_window").on(t.status, t.isDel, t.receiveType, t.startTime, t.endTime),
    index("sci_scope").on(t.couponType, t.legacyCategoryId, t.legacyBrandId),
  ],
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
    /** 0=未使用 1=已使用 2=已过期 3=已被未支付订单占用 */
    status: smallint("status").default(0).notNull(),
    startTime: timestamp("start_time", { mode: "date" }),
    endTime: timestamp("end_time", { mode: "date" }),
    useTime: timestamp("use_time", { mode: "date" }),
    /** 类型快照 */
    type: smallint("type").default(1).notNull(),
    receiveTime: integer("receive_time").default(0).notNull(),
    /** PHP 领取来源，例如 get/send；与数值券类型快照分开保存。 */
    receiveSource: varchar("receive_source", { length: 32 }).default("send").notNull(),
    isFail: smallint("is_fail").default(0).notNull(),
  },
  (t) => [
    index("scu_uid_status").on(t.uid, t.status),
    index("scu_uid_issue").on(t.uid, t.issueCouponId),
  ],
);

// ─── 优惠券领取证据（源表没有主键，保留重复历史） ───────────
export const storeCouponIssueUser = pgTable(
  "store_coupon_issue_user",
  {
    uid: integer("uid").default(0),
    issueCouponId: integer("issue_coupon_id").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("store_coupon_issue_user_issue_time").on(
      table.issueCouponId,
      table.addTime,
      table.uid,
    ),
    index("store_coupon_issue_user_uid_issue_time").on(
      table.uid,
      table.issueCouponId,
      table.addTime,
    ),
  ],
);

// ─── 优惠券模板适用商品（不要与支付后赠券关系混用） ─────────
export const storeCouponProduct = pgTable(
  "store_coupon_product",
  {
    couponId: integer("coupon_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
  },
  (table) => [
    index("store_coupon_product_coupon_product").on(table.couponId, table.productId),
    index("store_coupon_product_product_coupon").on(table.productId, table.couponId),
  ],
);

// ─── 商品支付后赠券关联 ─────────────────────────────────────
export const storeProductCoupon = pgTable(
  "store_product_coupon",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    issueCouponId: integer("issue_coupon_id").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    title: varchar("title", { length: 255 }).default("").notNull(),
  },
  (table) => [
    index("spc_product").on(table.productId, table.id),
    index("spc_issue").on(table.issueCouponId, table.productId),
  ],
);

// ─── 支付后商品赠券的订单归属/幂等证据 ─────────────────────
// PHP 把这份结果短存 Redis；Workers 需要可重放、可审计的 PostgreSQL 证据，
// 否则无法安全回答 /order/prize，也无法独立阻断同一订单重复发券。
export const storeOrderProductCouponReward = pgTable(
  "store_order_product_coupon_reward",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id").notNull(),
    uid: integer("uid").notNull(),
    productId: integer("product_id").notNull(),
    issueCouponId: integer("issue_coupon_id").notNull(),
    couponUserId: integer("coupon_user_id").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("sopcr_order_issue_uq").on(table.orderId, table.issueCouponId),
    uniqueIndex("sopcr_coupon_user_uq").on(table.couponUserId),
    index("sopcr_uid_order").on(table.uid, table.orderId, table.id),
  ],
);

// ─── 秒杀活动 ────────────────────────────────────────────────
export const storeSeckill = pgTable(
  "store_seckill",
  {
    id: serial("id").primaryKey(),
    activityId: integer("activity_id").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    /** 时间段 ID 逗号串 (关联 store_seckill_time) */
    timeId: text("time_id").default("").notNull(),
    storeName: varchar("store_name", { length: 256 }).default("").notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    images: varchar("images", { length: 2000 }).default("").notNull(),
    info: varchar("info", { length: 255 }).default("").notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    otPrice: decimal("ot_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    cost: decimal("cost", { precision: 12, scale: 2 }).default("0.00").notNull(),
    giveIntegral: decimal("give_integral", { precision: 10, scale: 2 }).default("0.00").notNull(),
    /** 限购 */
    num: integer("num").default(0).notNull(),
    /** 总库存 */
    quota: integer("quota").default(0).notNull(),
    quotaShow: integer("quota_show").default(0).notNull(),
    stock: integer("stock").default(0).notNull(),
    sales: integer("sales").default(0).notNull(),
    unitName: varchar("unit_name", { length: 16 }).default("").notNull(),
    postage: decimal("postage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    description: text("description"),
    isPostage: smallint("is_postage").default(0).notNull(),
    isHot: smallint("is_hot").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    tempId: integer("temp_id").default(0).notNull(),
    weight: decimal("weight", { precision: 12, scale: 2 }).default("0.00").notNull(),
    volume: decimal("volume", { precision: 12, scale: 2 }).default("0.00").notNull(),
    onceNum: integer("once_num").default(0).notNull(),
    isSupportRefund: smallint("is_support_refund").default(1).notNull(),
    deliveryType: varchar("delivery_type", { length: 10 }).default("").notNull(),
    freight: smallint("freight").default(2).notNull(),
    customForm: text("custom_form"),
    systemFormId: integer("system_form_id").default(0).notNull(),
    storeLabelId: text("store_label_id"),
    ensureId: text("ensure_id"),
    specs: text("specs"),
    startTime: timestamp("start_time", { mode: "date" }),
    stopTime: timestamp("stop_time", { mode: "date" }),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("ss_time").on(t.timeId),
    index("ss_status").on(t.status),
    index("sseckill_visible").on(t.status, t.isShow, t.isDel, t.stopTime, t.sort),
    index("store_seckill_system_form_active").on(t.systemFormId, t.isDel, t.status)
      .where(sql`${t.systemFormId} > 0`),
  ],
);

// ─── 秒杀时间段 ─────────────────────────────────────────────
export const storeSeckillTime = pgTable(
  "store_seckill_time",
  {
    id: serial("id").primaryKey(),
    title: varchar("title", { length: 255 }),
    pic: varchar("pic", { length: 255 }).default("").notNull(),
    describe: varchar("describe", { length: 255 }).default("").notNull(),
    /** "HH:mm" 开始时间 */
    startTime: varchar("start_time", { length: 16 }).default("").notNull(),
    endTime: varchar("end_time", { length: 16 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
);

// ─── 拼团活动 ────────────────────────────────────────────────
export const storeCombination = pgTable(
  "store_combination",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    merId: integer("mer_id").default(0).notNull(),
    storeName: varchar("store_name", { length: 256 }).default("").notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    images: varchar("images", { length: 2000 }).default("").notNull(),
    attr: varchar("attr", { length: 255 }).default("").notNull(),
    info: varchar("info", { length: 255 }).default("").notNull(),
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
    isHost: smallint("is_host").default(0).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    combination: smallint("combination").default(1).notNull(),
    merUse: smallint("mer_use").default(1).notNull(),
    isPostage: smallint("is_postage").default(0).notNull(),
    postage: decimal("postage", { precision: 10, scale: 2 }).default("0.00").notNull(),
    effectiveTime: integer("effective_time").default(0).notNull(),
    cost: integer("cost").default(0).notNull(),
    browse: integer("browse").default(0).notNull(),
    unitName: varchar("unit_name", { length: 32 }).default("").notNull(),
    tempId: integer("temp_id").default(0).notNull(),
    weight: decimal("weight", { precision: 12, scale: 2 }).default("0.00").notNull(),
    volume: decimal("volume", { precision: 12, scale: 2 }).default("0.00").notNull(),
    onceNum: integer("once_num").default(0).notNull(),
    virtual: integer("virtual").default(100).notNull(),
    isSupportRefund: smallint("is_support_refund").default(1).notNull(),
    deliveryType: varchar("delivery_type", { length: 10 }).default("").notNull(),
    freight: smallint("freight").default(2).notNull(),
    customForm: text("custom_form"),
    systemFormId: integer("system_form_id").default(0).notNull(),
    storeLabelId: text("store_label_id"),
    ensureId: text("ensure_id"),
    specs: text("specs"),
    startTime: timestamp("start_time", { mode: "date" }),
    stopTime: timestamp("stop_time", { mode: "date" }),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("scomb_status").on(t.status),
    index("scomb_visible").on(t.status, t.isShow, t.isDel, t.stopTime, t.sort),
    index("store_combination_system_form_active").on(t.systemFormId, t.isDel, t.status)
      .where(sql`${t.systemFormId} > 0`),
  ],
);

// ─── 拼团团 (进行中) ────────────────────────────────────────
export const storePink = pgTable(
  "store_pink",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    nickname: varchar("nickname", { length: 64 }).default("").notNull(),
    avatar: varchar("avatar", { length: 256 }).default("").notNull(),
    orderId: varchar("order_id", { length: 32 }).default("").notNull(),
    orderIdKey: varchar("order_id_key", { length: 32 }).default("").notNull(),
    totalNum: integer("total_num").default(0).notNull(),
    totalPrice: decimal("total_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    combinationId: integer("combination_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    /** 团长 ID (k_id=0 表示自己是团长) */
    kId: integer("k_id").default(0).notNull(),
    /** PHP people: 成团所需总人数。 */
    people: integer("people").default(0).notNull(),
    /** Worker 运行时已加入人数；0 表示旧数据需要从成员行推导。 */
    memberCount: integer("member_count").default(0).notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 1=进行中 2=成功 3=失败 */
    status: smallint("status").default(1).notNull(),
    stopTime: timestamp("stop_time", { mode: "date" }),
    isTpl: smallint("is_tpl").default(0).notNull(),
    /** 0=active; otherwise stores the refunded leader/replacement store_pink.id. */
    isRefund: integer("is_refund").default(0).notNull(),
    isVirtual: smallint("is_virtual").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sp_combination").on(t.combinationId),
    index("sp_kid").on(t.kId),
    index("sp_leader_active").on(t.combinationId, t.kId, t.status, t.addTime),
    index("sp_group_member").on(t.kId, t.isRefund, t.status),
  ],
);

// ─── 砍价活动 ────────────────────────────────────────────────
export const storeBargain = pgTable(
  "store_bargain",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    storeName: varchar("store_name", { length: 256 }).default("").notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    title: varchar("title", { length: 255 }).default("").notNull(),
    unitName: varchar("unit_name", { length: 16 }).default("").notNull(),
    images: varchar("images", { length: 2000 }).default("").notNull(),
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
    num: integer("num").default(1).notNull(),
    bargainMaxPrice: decimal("bargain_max_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    bargainMinPrice: decimal("bargain_min_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    bargainNum: integer("bargain_num").default(1).notNull(),
    giveIntegral: decimal("give_integral", { precision: 10, scale: 2 }).default("0.00").notNull(),
    info: varchar("info", { length: 255 }).default("").notNull(),
    cost: decimal("cost", { precision: 12, scale: 2 }).default("0.00").notNull(),
    isHot: smallint("is_hot").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    isPostage: smallint("is_postage").default(1).notNull(),
    postage: decimal("postage", { precision: 10, scale: 2 }).default("0.00").notNull(),
    rule: text("rule"),
    look: integer("look").default(0).notNull(),
    share: integer("share").default(0).notNull(),
    tempId: integer("temp_id").default(0).notNull(),
    weight: decimal("weight", { precision: 12, scale: 2 }).default("0.00").notNull(),
    volume: decimal("volume", { precision: 12, scale: 2 }).default("0.00").notNull(),
    isSupportRefund: smallint("is_support_refund").default(1).notNull(),
    deliveryType: varchar("delivery_type", { length: 10 }).default("").notNull(),
    freight: smallint("freight").default(2).notNull(),
    customForm: text("custom_form"),
    systemFormId: integer("system_form_id").default(0).notNull(),
    storeLabelId: text("store_label_id"),
    ensureId: text("ensure_id"),
    specs: text("specs"),
    startTime: timestamp("start_time", { mode: "date" }),
    stopTime: timestamp("stop_time", { mode: "date" }),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sbarg_status").on(t.status),
    index("sbarg_visible").on(t.status, t.isDel, t.stopTime, t.sort),
    index("store_bargain_system_form_active").on(t.systemFormId, t.isDel, t.status)
      .where(sql`${t.systemFormId} > 0`),
  ],
);

// ─── 积分商品 ────────────────────────────────────────────────
export const storeIntegral = pgTable(
  "store_integral",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    storeName: varchar("store_name", { length: 256 }).default("").notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    images: varchar("images", { length: 2000 }).default("").notNull(),
    unitName: varchar("unit_name", { length: 16 }).default("").notNull(),
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
    isHost: smallint("is_host").default(0).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    onceNum: integer("once_num").default(0).notNull(),
    deliveryType: varchar("delivery_type", { length: 10 }).default("").notNull(),
    freight: smallint("freight").default(2).notNull(),
    postage: decimal("postage", { precision: 10, scale: 2 }).default("0.00").notNull(),
    tempId: integer("temp_id").default(0).notNull(),
    customForm: text("custom_form"),
    systemFormId: integer("system_form_id").default(0).notNull(),
    storeLabelId: text("store_label_id"),
    ensureId: text("ensure_id"),
    specs: text("specs"),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sint_status").on(t.status),
    index("sint_visible").on(t.status, t.isShow, t.isDel, t.sort),
    index("store_integral_system_form_active").on(t.systemFormId, t.isDel, t.status)
      .where(sql`${t.systemFormId} > 0`),
  ],
);
