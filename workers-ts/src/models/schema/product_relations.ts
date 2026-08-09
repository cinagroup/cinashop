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
  index,
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
    /** 一级分类ID (type=1 时冗余) */
    relationPid: integer("relation_pid").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("type").on(t.type),
    index("relation_id").on(t.relationId),
    index("product_id").on(t.productId),
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
  },
  (t) => [
    index("unique_suk").on(t.unique, t.suk),
    index("store_id_value").on(t.productId, t.suk),
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
import { smallint as _sm } from "drizzle-orm/pg-core";
export const userLabel = pgTable(
  "user_label",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 64 }).default("").notNull(),
    color: varchar("color", { length: 32 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
);
