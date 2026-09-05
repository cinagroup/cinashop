/**
 * 商品关联表 schemas
 *
 * 对应:
 *   - eb_store_product_category  分类树 (pid + path + level)
 *   - eb_store_product_relation  商品↔分类/品牌/标签 多态关联 (type 区分)
 *   - eb_store_brand             品牌 (自引用树)
 *   - eb_store_product_attr      属性组 (颜色/版本等)
 *   - eb_store_product_attr_result 属性快照 (JSON)
 *   - eb_store_product_attr_value  SKU 行 (库存/价格/销量权威来源)
 *   - eb_store_product_label     商品标签
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  text,
  char,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─── 商品分类 ────────────────────────────────────────────────
export const storeProductCategory = pgTable(
  "store_product_category",
  {
    id: serial("id").primaryKey(),
    pid: integer("pid").default(0).notNull(),
    /** 0=平台 1=门店 2=供应商 */
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    cateName: varchar("cate_name", { length: 100 }).default("").notNull(),
    /** 逗号分隔祖先ID ("1,2" 表示父链 id=1→id=2→本节点) */
    path: varchar("path", { length: 255 }).default("").notNull(),
    /** 0=一级 1=二级 2=三级 */
    level: smallint("level").default(0).notNull(),
    pic: varchar("pic", { length: 512 }).default("").notNull(),
    bigPic: varchar("big_pic", { length: 255 }).default("").notNull(),
    advPic: varchar("adv_pic", { length: 255 }).default("").notNull(),
    advLink: varchar("adv_link", { length: 255 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("pid").on(t.pid),
    index("spc_supplier_tree").on(t.type, t.relationId, t.pid, t.isShow, t.sort.desc().nullsFirst()),
    index("is_show").on(t.isShow),
    index("sort").on(t.sort),
    index("add_time").on(t.addTime),
  ],
);

// ─── 商品多态关联表 ──────────────────────────────────────────
export const storeProductRelation = pgTable(
  "store_product_relation",
  {
    id: serial("id").primaryKey(),
    /** 1=分类 2=品牌 3=商品标签 4=用户标签 5=保障服务 6=商品参数 */
    type: integer("type").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    /** 关联的分类/品牌/标签ID (取决于 type) */
    relationId: integer("relation_id").default(0).notNull(),
    /** 所选分类的即时父分类 ID（type=1 时冗余，保持 PHP 运行时语义） */
    relationPid: integer("relation_pid").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("type").on(t.type),
    index("relation_id").on(t.relationId),
    index("product_id").on(t.productId),
    index("spr_product_type_relation").on(t.productId, t.type, t.relationId),
    index("spr_kefu_product_category").on(t.type, t.productId, t.relationId),
    index("spr_kefu_category_product").on(t.type, t.relationId, t.productId),
  ],
);

// ─── 品牌 ────────────────────────────────────────────────────
export const storeBrand = pgTable(
  "store_brand",
  {
    id: serial("id").primaryKey(),
    brandName: varchar("brand_name", { length: 100 }).default("").notNull(),
    pid: integer("pid").default(0).notNull(),
    fid: varchar("fid", { length: 64 }).default("").notNull(),
    storeId: integer("store_id").default(0).notNull(),
    sort: integer("sort").default(0).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
);

// ─── 属性组 ──────────────────────────────────────────────────
export const storeProductAttr = pgTable(
  "store_product_attr",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    attrName: varchar("attr_name", { length: 32 }).default("").notNull(),
    /** 逗号分隔属性值 "陶瓷黑,影青灰" */
    attrValues: text("attr_values").default("").notNull(),
    /** 0=商品 1=秒杀 2=砍价 3=拼团 */
    type: smallint("type").default(0).notNull(),
  },
  (t) => [index("store_id_attr").on(t.productId)],
);

// ─── 属性快照 (JSON 缓存) ───────────────────────────────────
export const storeProductAttrResult = pgTable(
  "store_product_attr_result",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    /** JSON: {attr:[...], value:[...]} */
    result: text("result").default("").notNull(),
    changeTime: integer("change_time").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
  },
  (t) => [index("store_id_result").on(t.productId)],
);

// ─── SKU 行 (库存/价格权威来源) ────────────────────────────
export const storeProductAttrValue = pgTable(
  "store_product_attr_value",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    productType: smallint("product_type").default(0).notNull(),
    /** 逗号连接属性值, SKU 键 "陶瓷黑,8GB+128GB" */
    suk: varchar("suk", { length: 512 }).default("").notNull(),
    stock: integer("stock").default(0).notNull(),
    sumStock: integer("sum_stock").default(0).notNull(),
    sales: integer("sales").default(0).notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    settlePrice: decimal("settle_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    integral: integer("integral").default(0).notNull(),
    image: varchar("image", { length: 128 }).default("").notNull(),
    /** cart 用此唯一标识 */
    unique: char("unique", { length: 8 }).default("").notNull(),
    cost: decimal("cost", { precision: 12, scale: 2 }).default("0.00").notNull(),
    barCode: varchar("bar_code", { length: 50 }).default("").notNull(),
    otPrice: decimal("ot_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    vipPrice: decimal("vip_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    weight: decimal("weight", { precision: 12, scale: 2 }).default("0.00").notNull(),
    volume: decimal("volume", { precision: 12, scale: 2 }).default("0.00").notNull(),
    brokerage: decimal("brokerage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    brokerageTwo: decimal("brokerage_two", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 0=商品 1秒杀 2砍价 3拼团 4积分 5套餐 7新人 */
    type: smallint("type").default(0).notNull(),
    quota: integer("quota").default(0).notNull(),
    quotaShow: integer("quota_show").default(0).notNull(),
    code: varchar("code", { length: 50 }).default("").notNull(),
    diskInfo: text("disk_info"),
    writeTimes: integer("write_times").default(1).notNull(),
    writeValid: smallint("write_valid").default(1).notNull(),
    writeDays: integer("write_days").default(0).notNull(),
    writeStart: integer("write_start").default(0).notNull(),
    writeEnd: integer("write_end").default(0).notNull(),
    /** 目标库扩展：历史身份永久保留，1 表示停止新交易但允许退款/履约读取。 */
    isRetired: smallint("is_retired").default(0).notNull(),
    retiredAt: integer("retired_at").default(0).notNull(),
    retiredBy: integer("retired_by").default(0).notNull(),
    retireReason: varchar("retire_reason", { length: 255 }).default("").notNull(),
  },
  (t) => [
    index("unique_suk").on(t.unique, t.suk),
    index("store_id_value").on(t.productId, t.suk),
    index("spav_product_active").on(t.productId, t.type, t.isRetired, t.id),
    index("spav_product_type_suk").on(t.productId, t.type, t.suk),
  ],
);

/** 追加式 SKU 退役/恢复证据；不复用 system_log 代替业务迁移历史。 */
export const storeProductSkuRetirementLog = pgTable(
  "store_product_sku_retirement_log",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull(),
    skuId: integer("sku_id").notNull(),
    uniqueSnapshot: char("unique_snapshot", { length: 8 }).default("").notNull(),
    sukSnapshot: varchar("suk_snapshot", { length: 512 }).default("").notNull(),
    action: varchar("action", { length: 16 }).notNull(),
    reason: varchar("reason", { length: 255 }).default("").notNull(),
    actorId: integer("actor_id").default(0).notNull(),
    actorName: varchar("actor_name", { length: 64 }).default("").notNull(),
    actorIp: varchar("actor_ip", { length: 45 }).default("").notNull(),
    dependencySnapshot: text("dependency_snapshot").default("{}").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("spsrl_product_time").on(t.productId, t.addTime, t.id),
    index("spsrl_sku_time").on(t.skuId, t.addTime, t.id),
  ],
);

// ─── 商品详情 ────────────────────────────────────────────────
export const storeProductDescription = pgTable(
  "store_product_description",
  {
    productId: integer("product_id").default(0).notNull(),
    description: text("description"),
    /** 0=普通商品，保留旧表商品类型维度 */
    type: smallint("type").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("spd_product_type_unique").on(t.productId, t.type),
    index("spd_type_product").on(t.type, t.productId),
  ],
);

// ─── 商品库存变更审计 ────────────────────────────────────────
export const storeProductStockRecord = pgTable(
  "store_product_stock_record",
  {
    id: serial("id").primaryKey(),
    storeId: integer("store_id").default(0).notNull(),
    productId: integer("product_id").default(0).notNull(),
    unique: varchar("unique", { length: 32 }).default("").notNull(),
    costPrice: decimal("cost_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    number: integer("number").default(0).notNull(),
    /** 1=入库，0=出库 */
    pm: smallint("pm").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("spsr_product_time").on(t.productId, t.addTime),
    index("spsr_unique_time").on(t.unique, t.addTime),
  ],
);

// ─── 商品标签 ────────────────────────────────────────────────
export const storeProductLabel = pgTable(
  "store_product_label",
  {
    id: serial("id").primaryKey(),
    /** 0=平台 2=供应商 */
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    labelCate: integer("label_cate").default(0).notNull(),
    labelName: varchar("label_name", { length: 255 }).default("").notNull(),
    /** 1=自定义 2=图片 */
    styleType: smallint("style_type").default(1).notNull(),
    color: varchar("color", { length: 32 }).default("").notNull(),
    bgColor: varchar("bg_color", { length: 32 }).default("").notNull(),
    borderColor: varchar("border_color", { length: 32 }).default("").notNull(),
    icon: varchar("icon", { length: 255 }).default("").notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    status: smallint("status").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("label_cate").on(t.labelCate),
    index("type_label").on(t.type),
  ],
);


// ─── 用户标签 ────────────────────────────────────────────────
// Product assurance catalog shown on product detail pages. PHP keeps the
// catalog separate from type=5 rows in store_product_relation.
export const storeProductEnsure = pgTable(
  "store_product_ensure",
  {
    id: serial("id").primaryKey(),
    /** 0=platform, 2=supplier */
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    image: varchar("image", { length: 255 }).default("").notNull(),
    desc: varchar("desc", { length: 255 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("spe_type").on(t.type),
    index("spe_scope_active").on(t.type, t.relationId, t.status, t.sort, t.id),
  ],
);

// Append-only product behaviour evidence used for visit history and product
// conversion statistics. delete_time is a soft-delete timestamp in the PHP API.
export const storeProductLog = pgTable(
  "store_product_log",
  {
    id: serial("id").primaryKey(),
    type: varchar("type", { length: 16 }).default("visit").notNull(),
    productId: integer("product_id").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    visitNum: smallint("visit_num").default(0).notNull(),
    cartNum: integer("cart_num").default(0).notNull(),
    orderNum: integer("order_num").default(0).notNull(),
    payNum: integer("pay_num").default(0).notNull(),
    payPrice: decimal("pay_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    costPrice: decimal("cost_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    payUid: integer("pay_uid").default(0).notNull(),
    refundNum: integer("refund_num").default(0).notNull(),
    refundPrice: decimal("refund_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    collectNum: smallint("collect_num").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    deleteTime: timestamp("delete_time", { mode: "date" }),
  },
  (t) => [
    index("spl_type").on(t.type),
    index("spl_product_id").on(t.productId),
    index("spl_uid").on(t.uid),
    index("spl_add_time").on(t.addTime),
    index("spl_uid_type").on(t.uid, t.type),
    index("spl_user_source_latest").on(t.uid, t.type, t.addTime.desc(), t.productId),
    index("spl_visit_history").on(t.uid, t.type, t.deleteTime, t.addTime, t.id),
  ],
);

// Per-user/product visit aggregate. The legacy table has no uniqueness
// constraint, so historical duplicate rows remain legal; runtime writes lock
// a deterministic scope instead of inventing a migration-time unique key.
export const storeVisit = pgTable(
  "store_visit",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").default(0).notNull(),
    productType: varchar("product_type", { length: 32 }).default("").notNull(),
    cateId: integer("cate_id").default(0).notNull(),
    type: char("type", { length: 50 }).default("").notNull(),
    uid: integer("uid").default(0).notNull(),
    count: integer("count").default(0).notNull(),
    content: varchar("content", { length: 255 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("sv_product_id").on(t.productId),
    index("sv_user_product").on(t.uid, t.productId, t.productType, t.id),
    index("sv_kefu_recent").on(t.uid, t.addTime.desc().nullsFirst(), t.id.desc().nullsFirst(), t.productId),
  ],
);

export const userLabel = pgTable(
  "user_label",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    labelCate: integer("label_cate").default(0).notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    tagId: varchar("tag_id", { length: 64 }).default("").notNull(),
    color: varchar("color", { length: 32 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("ulabel_scope_cate").on(t.type, t.relationId, t.labelCate, t.id)],
);
