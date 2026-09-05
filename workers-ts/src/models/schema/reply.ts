/**
 * 商品评价 Schema
 *
 * 对应原版 store_product_reply + store_product_reply_comment
 */
import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  smallint,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** 商品评价 (对应原版 store_product_reply) */
export const storeProductReply = pgTable(
  "store_product_reply",
  {
    id: serial("id").primaryKey(),
    /** 关联商品 ID */
    productId: integer("product_id").default(0).notNull(),
    /** 关联订单 ID（与 PHP store_product_reply.oid 语义一致） */
    oid: integer("oid").default(0).notNull(),
    /** TS 迁移新增的稳定商品快照外键，用于安全幂等和兼容历史错误 oid。 */
    orderCartInfoId: integer("order_cart_info_id"),
    /** 评价的唯一标识 (unique, 用于幂等) */
    unique: varchar("unique", { length: 50 }).default("").notNull(),
    /** 评价用户 UID */
    uid: integer("uid").default(0).notNull(),
    /** 评价用户昵称 (快照) */
    nickname: varchar("nickname", { length: 128 }).default("").notNull(),
    /** 评价用户头像 (快照) */
    avatar: varchar("avatar", { length: 256 }).default("").notNull(),
    /** 评价内容 */
    comment: varchar("comment", { length: 1024 }).default("").notNull(),
    /** 商品规格 (快照, 如 "红色 XL") */
    sku: varchar("sku", { length: 255 }).default("").notNull(),
    skuUnique: varchar("sku_unique", { length: 255 }).default("").notNull(),
    /** 0=平台 1=门店 2=供应商 */
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    replyType: varchar("reply_type", { length: 32 }).default("product").notNull(),
    /** 1=差评 2=中评 3=好评，保留 PHP 数据契约。 */
    replyScore: smallint("reply_score").default(3).notNull(),
    /** 评分 (1-5 星, 商品) */
    productScore: smallint("product_score").default(5).notNull(),
    /** 评分 (服务) */
    serviceScore: smallint("service_score").default(5).notNull(),
    /** 评分 (物流) */
    logisticsScore: smallint("logistics_score").default(5).notNull(),
    /** PHP 原字段名；与 logistics_score 双写，便于旧数据导入。 */
    deliveryScore: smallint("delivery_score").default(5).notNull(),
    /** 评价图片 (JSON 数组) */
    pics: text("pics").default("[]"),
    /** 0=未回复 1=已回复 */
    isReply: smallint("is_reply").default(0).notNull(),
    /** 商家回复内容 */
    merchantReply: varchar("merchant_reply", { length: 500 }).default("").notNull(),
    merchantReplyContent: varchar("merchant_reply_content", { length: 500 }).default("").notNull(),
    /** 管理员回复时间 */
    merchantReplyTime: integer("merchant_reply_time").default(0).notNull(),
    /** 点赞数 */
    praise: integer("praise").default(0).notNull(),
    viewsNum: integer("views_num").default(0).notNull(),
    /** 0=未审核 1=已通过 (审核后展示) */
    status: smallint("status").default(1).notNull(),
    /** 0=普通 1=置顶 */
    top: smallint("top").default(0).notNull(),
    /** 删除标记 */
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("spr_product_active").on(t.productId, t.status, t.isDel, t.addTime),
    index("spr_product_id").on(t.productId),
    index("spr_unique").on(t.unique),
    index("spr_uid").on(t.uid),
    index("spr_order_unique").on(t.oid, t.unique, t.isDel),
    uniqueIndex("spr_active_cart_uq")
      .on(t.orderCartInfoId)
      .where(sql`${t.orderCartInfoId} IS NOT NULL AND ${t.isDel} = 0`),
    check(
      "spr_scores_ck",
      sql`${t.productScore} BETWEEN 1 AND 5 AND ${t.serviceScore} BETWEEN 1 AND 5 AND ${t.logisticsScore} BETWEEN 1 AND 5 AND ${t.deliveryScore} BETWEEN 1 AND 5 AND ${t.replyScore} BETWEEN 1 AND 3`,
    ),
  ],
);

/** 评价的评论/追评 (对应原版 store_product_reply_comment) */
export const storeProductReplyComment = pgTable(
  "store_product_reply_comment",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    /** 关联评价 ID */
    replyId: integer("reply_id").default(0).notNull(),
    /** 上级回复 ID */
    pid: integer("pid").default(0).notNull(),
    /** 评论者 UID */
    uid: integer("uid").default(0).notNull(),
    /** 评论者昵称 */
    nickname: varchar("nickname", { length: 128 }).default("").notNull(),
    /** 评论者头像 */
    avatar: varchar("avatar", { length: 256 }).default("").notNull(),
    /** 评论内容 */
    content: varchar("content", { length: 1000 }).default("").notNull(),
    /** 点赞数 */
    praise: integer("praise").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (t) => [
    index("sprc_reply_parent").on(t.replyId, t.pid, t.addTime),
    index("sprc_reply_id").on(t.replyId),
  ],
);

export type StoreProductReply = typeof storeProductReply.$inferSelect;
export type NewStoreProductReply = typeof storeProductReply.$inferInsert;
