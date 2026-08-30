/**
 * 订单域 schema
 *
 * 对应:
 *   - eb_store_cart              购物车
 *   - eb_store_order             订单主表 (M3 核心: 含 unique 幂等约束)
 *   - eb_store_order_cart_info   订单商品快照
 *   - eb_user_bill               用户账单 (积分/佣金流水)
 *
 * M3 只覆盖下单链路必需字段, 其余字段 (拆单/核销/ERP/事业部等) M4+ 补。
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  text,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── 购物车 ──────────────────────────────────────────────────
export const storeCart = pgTable(
  "store_cart",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    touristUid: varchar("tourist_uid", { length: 50 }).default("").notNull(),
    /** 0普通 1秒杀 2砍价 3拼团 4积分 5套餐 7新人 */
    type: smallint("type").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    activityId: integer("activity_id").default(0).notNull(),
    storeId: integer("store_id").default(0).notNull(),
    staffId: integer("staff_id").default(0).notNull(),
    /** SKU unique (char 8) */
    productAttrUnique: varchar("product_attr_unique", { length: 16 }).default("").notNull(),
    cartNum: smallint("cart_num").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isPay: smallint("is_pay").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    /** 是否立即购买 (区别于购物车) */
    isNew: smallint("is_new").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
  },
  (t) => [
    index("sc_product_id").on(t.productId),
    index("sc_uid_pay").on(t.uid, t.isPay),
    index("sc_uid_del").on(t.uid, t.isDel),
    index("sc_uid_new").on(t.uid, t.isNew),
    index("sc_type").on(t.type),
  ],
);

// ─── 订单主表 (M3 核心) ─────────────────────────────────────
export const storeOrder = pgTable(
  "store_order",
  {
    id: serial("id").primaryKey(),
    /** 0普通 1秒杀 2砍价 3拼团 4积分 5套餐 6预售 7新人 8抽奖 */
    type: smallint("type").default(0).notNull(),
    pid: integer("pid").default(0).notNull(),
    /** 订单号 (雪花ID, 'wx' + snowflake) */
    orderId: varchar("order_id", { length: 32 }).default("0").notNull(),
    tradeNo: varchar("trade_no", { length: 100 }).default("").notNull(),
    supplierId: integer("supplier_id").default(0).notNull(),
    /** 0 尚未检查，1 支付后等待按 Supplier 分配，2 已完成分配。 */
    supplierAllocationStatus: smallint("supplier_allocation_status").default(0).notNull(),
    storeId: integer("store_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    realName: varchar("real_name", { length: 32 }).default("").notNull(),
    userPhone: varchar("user_phone", { length: 18 }).default("").notNull(),
    province: varchar("province", { length: 255 }).default("").notNull(),
    userAddress: varchar("user_address", { length: 100 }).default("").notNull(),
    userLocation: varchar("user_location", { length: 30 }).default("").notNull(),
    /** 购物车 ids 逗号串 */
    cartId: text("cart_id"),
    pinkId: integer("pink_id").default(0).notNull(),
    activityId: integer("activity_id").default(0).notNull(),
    activityAppend: varchar("activity_append", { length: 255 }).default("").notNull(),
    freightPrice: decimal("freight_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    totalNum: integer("total_num").default(0).notNull(),
    totalPrice: decimal("total_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    totalPostage: decimal("total_postage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    payPrice: decimal("pay_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    payPostage: decimal("pay_postage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    payIntegral: integer("pay_integral").default(0).notNull(),
    deductionPrice: decimal("deduction_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    couponId: integer("coupon_id").default(0).notNull(),
    couponPrice: decimal("coupon_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    promotionsPrice: decimal("promotions_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    firstOrderPrice: decimal("first_order_price", { precision: 8, scale: 2 }).default("0.00").notNull(),
    changePrice: decimal("change_price", { precision: 8, scale: 2 }).default("0.00").notNull(),
    gainIntegral: decimal("gain_integral", { precision: 12, scale: 2 }).default("0.00").notNull(),
    useIntegral: decimal("use_integral", { precision: 12, scale: 2 }).default("0.00").notNull(),
    backIntegral: decimal("back_integral", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 下单时冻结推广关系和返佣金额，避免收货前关系/配置变化影响资金归属。 */
    spreadUid: integer("spread_uid").default(0).notNull(),
    spreadTwoUid: integer("spread_two_uid").default(0).notNull(),
    oneBrokerage: decimal("one_brokerage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    twoBrokerage: decimal("two_brokerage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    divisionId: integer("division_id").default(0).notNull(),
    divisionBrokerage: decimal("division_brokerage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    divisionAgentId: integer("division_agent_id").default(0).notNull(),
    divisionAgentBrokerage: decimal("division_agent_brokerage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    divisionStaffId: integer("division_staff_id").default(0).notNull(),
    divisionStaffBrokerage: decimal("division_staff_brokerage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 1快递 2自提 3门店配送 4收银 */
    shippingType: smallint("shipping_type").default(1).notNull(),
    verifyCode: varchar("verify_code", { length: 12 }).default("").notNull(),
    /** 0未支付 1已支付 */
    paid: smallint("paid").default(0).notNull(),
    /** 0待发货 1待收货 2已收货/待评价 3已完成 4部分发货 5部分核销 */
    status: smallint("status").default(0).notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    remark: varchar("remark", { length: 512 }).default("").notNull(),
    isChannel: smallint("is_channel").default(0).notNull(),
    channelType: varchar("channel_type", { length: 255 }).default("").notNull(),
    isRemind: smallint("is_remind").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    isSystemDel: smallint("is_system_del").default(0).notNull(),
    payType: varchar("pay_type", { length: 32 }).default("").notNull(),
    payTime: integer("pay_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    /** 确认订单的缓存 key (幂等防重) */
    unique: varchar("unique", { length: 50 }).default(""),
    /** 下单时的用户IP */
    userIp: varchar("user_ip", { length: 45 }).default("").notNull(),
    refundStatus: smallint("refund_status").default(0).notNull(),
    /** 退款类型 (镜像 refund 表的 refund_type): 0无 1仅退款 2退货退款 3拒绝 4同意退货 5已退货 6已退款 */
    refundType: smallint("refund_type").default(0).notNull(),
    refundExpress: varchar("refund_express", { length: 255 }).default("").notNull(),
    refundReasonWapImg: text("refund_reason_wap_img"),
    refundReasonWapExplain: varchar("refund_reason_wap_explain", { length: 255 }).default("").notNull(),
    refundReasonTime: integer("refund_reason_time").default(0).notNull(),
    refundReasonWap: varchar("refund_reason_wap", { length: 255 }).default("").notNull(),
    refundReason: varchar("refund_reason", { length: 255 }).default("").notNull(),
    refundPrice: decimal("refund_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    deliveryName: varchar("delivery_name", { length: 64 }).default("").notNull(),
    deliveryCode: varchar("delivery_code", { length: 50 }).default("").notNull(),
    /** express 快递、send 配送、fictitious 虚拟发货。 */
    deliveryType: varchar("delivery_type", { length: 32 }).default("").notNull(),
    deliveryId: varchar("delivery_id", { length: 64 }).default("").notNull(),
    fictitiousContent: varchar("fictitious_content", { length: 500 }).default("").notNull(),
    deliveryUid: integer("delivery_uid").default(0).notNull(),
    expressDump: text("express_dump"),
    kuaidiLabel: varchar("kuaidi_label", { length: 255 }).default("").notNull(),
    merId: integer("mer_id").default(0).notNull(),
    cost: decimal("cost", { precision: 12, scale: 2 }).default("0.00").notNull(),
    staffId: integer("staff_id").default(0).notNull(),
    clerkId: integer("clerk_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    virtualInfo: text("virtual_info"),
    customForm: text("custom_form"),
    promotionsGive: text("promotions_give"),
    giveIntegral: integer("give_integral").default(0).notNull(),
    giveCoupon: text("give_coupon"),
    erpId: integer("erp_id").default(0).notNull(),
    erpOrderId: varchar("erp_order_id", { length: 32 }).default("").notNull(),
    kuaidiTaskId: varchar("kuaidi_task_id", { length: 128 }).default("").notNull(),
    kuaidiOrderId: integer("kuaidi_order_id").default(0).notNull(),
    isStockUp: smallint("is_stock_up").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("so_order_id_uq").on(t.orderId),
    /** unique 幂等: 同 uid + 同 key 只能生成一个订单 */
    uniqueIndex("so_unique_uid_uq").on(t.unique, t.uid),
    index("so_uid").on(t.uid),
    index("so_order_id").on(t.orderId),
    index("so_verify_code").on(t.verifyCode),
    index("so_paid").on(t.paid),
    index("so_status").on(t.status),
    index("so_delivery_mobile_active")
      .on(t.deliveryUid, t.status, t.addTime.desc(), t.id.desc())
      .where(sql`${t.deliveryUid} > 0 AND ${t.paid} = 1 AND ${t.isDel} = 0 AND ${t.isSystemDel} = 0 AND ${t.refundStatus} IN (0, 3)`),
    index("so_split_pending").on(t.pid, t.supplierId, t.status, t.isSystemDel, t.id),
    index("so_supplier_allocation_pending")
      .on(t.paid, t.supplierAllocationStatus, t.id)
      .where(sql`${t.supplierAllocationStatus} = 1`),
    index("so_add_time").on(t.addTime),
    index("so_spread_uid").on(t.spreadUid),
    index("so_spread_two_uid").on(t.spreadTwoUid),
    index("so_division_id").on(t.divisionId),
    index("so_division_agent_id").on(t.divisionAgentId),
    index("so_division_staff_id").on(t.divisionStaffId),
    index("so_erp_order_id").on(t.erpOrderId),
    index("so_activity_type_visible")
      .on(t.activityId, t.type)
      .where(sql`${t.type} IN (1, 2, 3) AND ${t.isDel} = 0 AND ${t.isSystemDel} = 0`),
    check(
      "so_division_brokerage_ck",
      sql`${t.divisionBrokerage} >= 0 AND ${t.divisionAgentBrokerage} >= 0 AND ${t.divisionStaffBrokerage} >= 0`,
    ),
    check(
      "so_supplier_allocation_status_ck",
      sql`${t.supplierAllocationStatus} BETWEEN 0 AND 2`,
    ),
  ],
);

// ─── 订单商品快照 ────────────────────────────────────────────
export const storeOrderCartInfo = pgTable(
  "store_order_cart_info",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    oid: integer("oid").default(0).notNull(),
    cartId: varchar("cart_id", { length: 50 }).default("0").notNull(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    staffId: integer("staff_id").default(0).notNull(),
    deliveryId: integer("delivery_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    skuUnique: varchar("sku_unique", { length: 255 }).default("").notNull(),
    promotionsId: text("promotions_id"),
    isGift: smallint("is_gift").default(0).notNull(),
    isSupportRefund: smallint("is_support_refund").default(1).notNull(),
    cartNum: integer("cart_num").default(0).notNull(),
    refundNum: integer("refund_num").default(0).notNull(),
    surplusNum: integer("surplus_num").default(0).notNull(),
    /** 拆单前的商品快照 cart_id；未拆单行保持空字符串。 */
    oldCartId: varchar("old_cart_id", { length: 50 }).default("").notNull(),
    /** 当前快照仍可拆分发货的数量。 */
    splitSurplusNum: integer("split_surplus_num").default(0).notNull(),
    /** 0 未拆分，1 部分拆分，2 已全部拆分。 */
    splitStatus: smallint("split_status").default(0).notNull(),
    /** 下单时供应商结算单价快照。 */
    settlePrice: decimal("settle_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    writeTimes: integer("write_times").default(0).notNull(),
    writeSurplusTimes: integer("write_surplus_times").default(0).notNull(),
    writeStart: integer("write_start").default(0).notNull(),
    writeEnd: integer("write_end").default(0).notNull(),
    isAdventSms: smallint("is_advent_sms").default(0).notNull(),
    isExpireSms: smallint("is_expire_sms").default(0).notNull(),
    isWriteoff: smallint("is_writeoff").default(0).notNull(),
    writeoffTime: integer("writeoff_time").default(0).notNull(),
    /** 购买时的商品信息快照 (JSON: 价格/库存/属性) */
    cartInfo: text("cart_info"),
    unique: varchar("unique", { length: 32 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("soci_oid").on(t.oid),
    index("soci_uid").on(t.uid),
    index("soci_split_pending").on(t.oid, t.splitStatus, t.id),
    index("soci_old_cart_id").on(t.oldCartId),
    uniqueIndex("soci_oid_unique_uq").on(t.oid, t.unique),
    index("soci_cart_refund").on(t.cartId, t.refundNum),
    index("soci_product").on(t.productId),
    check(
      "soci_split_state_ck",
      sql`${t.splitStatus} BETWEEN 0 AND 2 AND ${t.splitSurplusNum} >= 0`,
    ),
  ],
);

// ─── 用户账单 (积分/佣金流水) ──────────────────────────────
export const userBill = pgTable(
  "user_bill",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    linkId: varchar("link_id", { length: 32 }).default("0").notNull(),
    /** 0支出 1获得 */
    pm: smallint("pm").default(0).notNull(),
    title: varchar("title", { length: 64 }).default("").notNull(),
    category: varchar("category", { length: 64 }).default("").notNull(),
    type: varchar("type", { length: 64 }).default("").notNull(),
    /** 业务事件幂等键；保留 PHP category/type 语义的同时区分同为 gain 的奖励来源。 */
    eventKey: varchar("event_key", { length: 64 }).default("").notNull(),
    number: decimal("number", { precision: 12, scale: 2 }).default("0.00").notNull(),
    balance: decimal("balance", { precision: 12, scale: 2 }).default("0.00").notNull(),
    mark: varchar("mark", { length: 512 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    /** 0待定 1有效 -1无效 */
    status: smallint("status").default(1).notNull(),
    take: smallint("take").default(0).notNull(),
    frozenTime: integer("frozen_time").default(0).notNull(),
  },
  (t) => [
    index("ub_uid").on(t.uid),
    index("ub_status").on(t.status),
    index("ub_add_time").on(t.addTime),
    index("ub_pm").on(t.pm),
    index("ub_cat_type_link").on(t.category, t.type, t.linkId),
    index("ub_event_key").on(t.eventKey),
    uniqueIndex("ub_order_reward_uq")
      .on(t.uid, t.linkId, t.eventKey)
      .where(sql`${t.eventKey} IN ('pay_give_integral', 'order_give_integral', 'order_give_exp')`),
    uniqueIndex("ub_out_request_uq")
      .on(t.uid, t.linkId, t.eventKey)
      .where(sql`${t.eventKey} IN ('out_system_add_integral', 'out_system_sub_integral')
        AND ${t.linkId} ~ '^[0-9a-f]{32}$'`),
  ],
);
