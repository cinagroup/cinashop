/**
 * 商品主表 schema
 *
 * 对应 PHP app/model/product/product/StoreProduct.php + eb_store_product 表。
 * 字段类型与原 MySQL 表一一对应。
 *
 * 关键: searchers 在 models/searchers/product.ts,
 *       JSON/逗号列的访问器在 services 层做 (对应 PHP model getter)。
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  smallint,
  text,
  index,
} from "drizzle-orm/pg-core";

export const storeProduct = pgTable(
  "store_product",
  {
    id: serial("id").primaryKey(),
    /** 平台商品ID (0=平台原始, >0=门店/供应商副本) */
    pid: integer("pid").default(0).notNull(),
    /** 0=平台, 1=门店, 2=供应商 */
    type: smallint("type").default(0).notNull(),
    /** 0=普通 1=卡密 2=优惠券 3=虚拟 4=次卡 */
    productType: smallint("product_type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    merId: integer("mer_id").default(0).notNull(),
    image: varchar("image", { length: 256 }).default("").notNull(),
    recommendImage: varchar("recommend_image", { length: 256 }).default("").notNull(),
    /** JSON 数组 (carousel images) */
    sliderImage: varchar("slider_image", { length: 5000 }).default("").notNull(),
    storeName: varchar("store_name", { length: 256 }).default("").notNull(),
    storeInfo: varchar("store_info", { length: 256 }).default("").notNull(),
    keyword: varchar("keyword", { length: 256 }).default("").notNull(),
    barCode: varchar("bar_code", { length: 15 }).default("").notNull(),
    /** 逗号分隔的分类ID (legacy, 查询走 store_product_relation) */
    cateId: varchar("cate_id", { length: 64 }).default("").notNull(),
    price: decimal("price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    settlePrice: decimal("settle_price", { precision: 10, scale: 2 }).default("0.00").notNull(),
    vipPrice: decimal("vip_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    otPrice: decimal("ot_price", { precision: 12, scale: 2 }).default("0.00").notNull(),
    /** 逗号分隔: 1=快递 2=自提 3=门店配送 */
    deliveryType: varchar("delivery_type", { length: 255 }).default("").notNull(),
    freight: smallint("freight").default(2).notNull(),
    postage: decimal("postage", { precision: 12, scale: 2 }).default("0.00").notNull(),
    tempId: integer("temp_id").default(0).notNull(),
    unitName: varchar("unit_name", { length: 32 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    star: decimal("star", { precision: 2, scale: 1 }).default("3.0").notNull(),
    collect: integer("collect").default(0).notNull(),
    /** 虚拟销量 (展示用: sales + ficti) */
    ficti: integer("ficti").default(100).notNull(),
    sales: integer("sales").default(0).notNull(),
    stock: integer("stock").default(0).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    isHot: smallint("is_hot").default(0).notNull(),
    isBenefit: smallint("is_benefit").default(0).notNull(),
    isBest: smallint("is_best").default(0).notNull(),
    isNew: smallint("is_new").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    isPostage: smallint("is_postage").default(0).notNull(),
    /** 审核: -2强制下架 -1拒绝 0待审 1通过 */
    isVerify: smallint("is_verify").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    merUse: smallint("mer_use").default(0).notNull(),
    giveIntegral: decimal("give_integral", { precision: 12, scale: 2 }).default("0.00").notNull(),
    cost: decimal("cost", { precision: 12, scale: 2 }).default("0.00").notNull(),
    isSeckill: smallint("is_seckill").default(0).notNull(),
    isBargain: smallint("is_bargain").default(0).notNull(),
    isGood: smallint("is_good").default(0).notNull(),
    isSub: smallint("is_sub").default(0).notNull(),
    isVip: smallint("is_vip").default(0).notNull(),
    browse: integer("browse").default(0).notNull(),
    codePath: varchar("code_path", { length: 64 }).default("").notNull(),
    soureLink: varchar("soure_link", { length: 2000 }).default("").notNull(),
    videoOpen: smallint("video_open").default(0).notNull(),
    videoLink: varchar("video_link", { length: 500 }).default("").notNull(),
    /** 0=单规格 1=多规格 */
    specType: smallint("spec_type").default(0).notNull(),
    /** 活动展示顺序, 逗号分隔 "0,1,2,3" (1秒杀2砍价3拼团) */
    activity: varchar("activity", { length: 255 }).default("").notNull(),
    spu: varchar("spu", { length: 13 }).default("").notNull(),
    /** 逗号分隔用户标签ID */
    labelId: varchar("label_id", { length: 64 }).default("").notNull(),
    commandWord: varchar("command_word", { length: 255 }).default("").notNull(),
    recommendList: varchar("recommend_list", { length: 256 }).default("").notNull(),
    brandId: integer("brand_id").default(0).notNull(),
    brandCom: varchar("brand_com", { length: 64 }).default("").notNull(),
    code: varchar("code", { length: 50 }).default("").notNull(),
    isVipProduct: smallint("is_vip_product").default(0).notNull(),
    isPresaleProduct: smallint("is_presale_product").default(0).notNull(),
    presaleStartTime: integer("presale_start_time").default(0).notNull(),
    presaleEndTime: integer("presale_end_time").default(0).notNull(),
    presaleDay: integer("presale_day").default(0).notNull(),
    autoOnTime: integer("auto_on_time").default(0).notNull(),
    autoOffTime: integer("auto_off_time").default(0).notNull(),
    /** JSON 自定义表单 */
    customForm: text("custom_form"),
    systemFormId: integer("system_form_id").default(0).notNull(),
    isSupportRefund: smallint("is_support_refund").default(1).notNull(),
    /** 逗号分隔门店标签ID */
    storeLabelId: text("store_label_id"),
    ensureId: text("ensure_id"),
    /** JSON 商品参数 */
    specs: text("specs"),
    specsId: integer("specs_id").default(0).notNull(),
    isLimit: smallint("is_limit").default(0).notNull(),
    /** 1=每单 2=终身 */
    limitType: smallint("limit_type").default(0).notNull(),
    limitNum: integer("limit_num").default(0).notNull(),
    refusal: varchar("refusal", { length: 255 }).default("").notNull(),
    isPolices: smallint("is_police").default(0).notNull(),
    isSold: smallint("is_sold").default(0).notNull(),
  },
  (t) => [
    index("cate_id").on(t.cateId),
    index("is_hot").on(t.isHot),
    index("is_benefit").on(t.isBenefit),
    index("is_best").on(t.isBest),
    index("is_new").on(t.isNew),
    index("is_del").on(t.isDel),
    index("price").on(t.price),
    index("sp_is_show_idx").on(t.isShow),
    index("sp_sort_idx").on(t.sort),
    index("sales").on(t.sales),
    index("sp_add_time_idx").on(t.addTime),
    index("is_postage").on(t.isPostage),
    index("sp_platform_article_options").on(t.type, t.relationId, t.isDel, t.id.desc()),
    index("sp_supplier_list").on(t.type, t.relationId, t.isDel, t.isShow, t.id.desc().nullsFirst()),
    index("store_product_system_form_active").on(t.systemFormId, t.isDel)
      .where(sql`${t.systemFormId} > 0`),
  ],
);

export type StoreProduct = typeof storeProduct.$inferSelect;
export type NewStoreProduct = typeof storeProduct.$inferInsert;
