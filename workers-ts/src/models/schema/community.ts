/**
 * 社区 schema
 *
 * 对应 eb_community + eb_community_comment
 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  smallint,
  text,
  index,
} from "drizzle-orm/pg-core";

/** 社区帖子 */
export const community = pgTable(
  "community",
  {
    id: serial("id").primaryKey(),
    /** 0平台 1门店 2用户 */
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    /** 1图文 2视频 */
    contentType: smallint("content_type").default(1).notNull(),
    title: varchar("title", { length: 255 }).default("").notNull(),
    image: varchar("image", { length: 255 }).default("").notNull(),
    videoUrl: varchar("video_url", { length: 255 }).default("").notNull(),
    /** 图集 JSON */
    sliderImage: text("slider_image"),
    content: text("content"),
    /** 话题 IDs JSON */
    topicId: text("topic_id"),
    /** 商品 IDs JSON */
    productId: text("product_id"),
    likeNum: integer("like_num").default(0).notNull(),
    collectNum: integer("collect_num").default(0).notNull(),
    playNum: integer("play_num").default(0).notNull(),
    commentNum: integer("comment_num").default(0).notNull(),
    shareNum: integer("share_num").default(0).notNull(),
    star: smallint("star").default(1).notNull(),
    /** 是否显示 */
    status: smallint("status").default(1).notNull(),
    isRecommend: smallint("is_recommend").default(0).notNull(),
    /** -2强制下架 -1未通过 0未审核 1通过 */
    isVerify: smallint("is_verify").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("c_status").on(t.status),
    index("c_type").on(t.type),
    index("c_add_time").on(t.addTime),
  ],
);

/** 社区评论 */
export const communityComment = pgTable(
  "community_comment",
  {
    id: serial("id").primaryKey(),
    /** 0平台 1门店 2用户 3虚拟 */
    type: smallint("type").default(0).notNull(),
    uid: integer("uid").default(0).notNull(),
    replyId: integer("reply_id").default(0).notNull(),
    replyUid: integer("reply_uid").default(0).notNull(),
    commentReplyId: integer("comment_reply_id").default(0).notNull(),
    commentReplyUid: integer("comment_reply_uid").default(0).notNull(),
    communityId: integer("community_id").default(0).notNull(),
    nickname: varchar("nickname", { length: 64 }).default("").notNull(),
    avatar: varchar("avatar", { length: 255 }).default("").notNull(),
    commentNum: integer("comment_num").default(0).notNull(),
    likeNum: integer("like_num").default(0).notNull(),
    content: varchar("content", { length: 1000 }).default("").notNull(),
    ip: varchar("ip", { length: 32 }).default("").notNull(),
    city: varchar("city", { length: 255 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("cc_community").on(t.communityId),
    index("cc_uid").on(t.uid),
    index("cc_add_time").on(t.addTime),
  ],
);
