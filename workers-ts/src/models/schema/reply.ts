/**
 * 商品评价 Schema
 *
 * 对应原版 store_product_reply + store_product_reply_comment
 */
import { pgTable, serial, integer, varchar, text, smallint } from "drizzle-orm/pg-core";

/** 商品评价 (对应原版 store_product_reply) */
export const storeProductReply = pgTable(
  "store_product_reply",
  {
    id: serial("id").primaryKey(),
    /** 关联商品 ID */
    productId: integer("product_id").default(0).notNull(),
    /** 关联订单详情 ID (store_order_cart_info.id) */
    oid: integer("oid").default(0).notNull(),
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
    /** 评分 (1-5 星, 商品) */
    productScore: smallint("product_score").default(5).notNull(),
    /** 评分 (服务) */
    serviceScore: smallint("service_score").default(5).notNull(),
    /** 评分 (物流) */
    logisticsScore: smallint("logistics_score").default(5).notNull(),
    /** 评价图片 (JSON 数组) */
    pics: text("pics").default("[]"),
    /** 0=未回复 1=已回复 */
    isReply: smallint("is_reply").default(0).notNull(),
    /** 商家回复内容 */
    merchantReply: varchar("merchant_reply", { length: 500 }).default("").notNull(),
    /** 管理员回复时间 */
    merchantReplyTime: integer("merchant_reply_time").default(0).notNull(),
    /** 点赞数 */
    praise: integer("praise").default(0).notNull(),
    /** 0=未审核 1=已通过 (审核后展示) */
    status: smallint("status").default(1).notNull(),
    /** 0=普通 1=置顶 */
    top: smallint("top").default(0).notNull(),
    /** 删除标记 */
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
);

/** 评价的评论/追评 (对应原版 store_product_reply_comment) */
export const storeProductReplyComment = pgTable(
  "store_product_reply_comment",
  {
    id: serial("id").primaryKey(),
    /** 关联评价 ID */
    replyId: integer("reply_id").default(0).notNull(),
    /** 评论者 UID */
    uid: integer("uid").default(0).notNull(),
    /** 评论者昵称 */
    nickname: varchar("nickname", { length: 128 }).default("").notNull(),
    /** 评论者头像 */
    avatar: varchar("avatar", { length: 256 }).default("").notNull(),
    /** 评论内容 */
    content: varchar("content", { length: 500 }).default("").notNull(),
    /** 点赞数 */
    praise: integer("praise").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
);

export type StoreProductReply = typeof storeProductReply.$inferSelect;
export type NewStoreProductReply = typeof storeProductReply.$inferInsert;
