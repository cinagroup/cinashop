/**
 * 社区 schema
 *
 * 对应 eb_community + eb_community_comment + eb_community_topic
 * + eb_community_relevance + eb_community_user
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
import { sql } from "drizzle-orm";

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
    refusal: varchar("refusal", { length: 255 }).default("").notNull(),
    sort: smallint("sort").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    verifyTime: integer("verify_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("c_status").on(t.status),
    index("c_type").on(t.type),
    index("c_add_time").on(t.addTime),
    index("c_public_feed").on(t.status, t.isVerify, t.isDel, t.addTime),
    index("c_author_public_latest")
      .on(t.type, t.relationId, t.addTime.desc(), t.id.desc())
      .where(sql`${t.status} = 1 AND ${t.isVerify} = 1 AND ${t.isDel} = 0`),
    index("c_admin_moderation")
      .on(t.isVerify, t.type, t.contentType, t.addTime.desc(), t.id.desc())
      .where(sql`${t.isDel} = 0`),
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
    isVerify: smallint("is_verify").default(1).notNull(),
    isShow: smallint("is_show").default(1).notNull(),
    isReply: smallint("is_reply").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("cc_community").on(t.communityId),
    index("cc_uid").on(t.uid),
    index("cc_add_time").on(t.addTime),
    index("cc_public_thread").on(
      t.communityId,
      t.isDel,
      t.isShow,
      t.isVerify,
      t.addTime,
    ),
    index("cc_admin_moderation")
      .on(t.isReply, t.isVerify, t.isShow, t.communityId, t.addTime.desc(), t.id.desc())
      .where(sql`${t.isDel} = 0`),
    index("cc_public_replies")
      .on(t.replyId, t.addTime, t.id)
      .where(sql`${t.isReply} = 0 AND ${t.isDel} = 0 AND ${t.isShow} = 1 AND ${t.isVerify} = 1`),
  ],
);

/** 社区话题 */
export const communityTopic = pgTable(
  "community_topic",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    icon: varchar("icon", { length: 128 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    isRecommend: smallint("is_recommend").default(0).notNull(),
    useNum: integer("use_num").default(0).notNull(),
    viewNum: integer("view_num").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("ct_visible_sort").on(t.status, t.isDel, t.sort, t.id),
    index("ct_recommend_sort").on(t.status, t.isDel, t.isRecommend, t.sort),
    index("ct_admin_catalog")
      .on(t.status, t.isRecommend, t.sort.desc(), t.id.desc())
      .where(sql`${t.isDel} = 0`),
  ],
);

/**
 * 社区多态关联。
 *
 * 旧库允许同一三元组重复，因此迁移阶段不能静默加唯一约束；新写入通过
 * PostgreSQL 事务级 advisory lock 保证同一 left/right/type 操作串行化。
 */
export const communityRelevance = pgTable(
  "community_relevance",
  {
    id: serial("id").primaryKey(),
    leftId: integer("left_id").default(0).notNull(),
    rightId: integer("right_id").default(0).notNull(),
    type: varchar("type", { length: 32 }).notNull(),
  },
  (t) => [
    index("cr_left_type_right").on(t.leftId, t.type, t.rightId),
    index("cr_right_type_left").on(t.rightId, t.type, t.leftId),
  ],
);

/** 社区作者资料及计数快照 */
export const communityUser = pgTable(
  "community_user",
  {
    id: serial("id").primaryKey(),
    /** 0平台 1门店 2用户 */
    type: smallint("type").default(2).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    nickname: varchar("nickname", { length: 255 }).default("").notNull(),
    avatar: varchar("avatar", { length: 255 }).default("").notNull(),
    description: varchar("desc", { length: 255 }).default("").notNull(),
    communityNum: integer("community_num").default(0).notNull(),
    followNum: integer("follow_num").default(0).notNull(),
    fansNum: integer("fans_num").default(0).notNull(),
    friendNum: integer("friend_num").default(0).notNull(),
    likeNum: integer("like_num").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("cu_relation_type").on(t.relationId, t.type, t.isDel),
    index("cu_public_activity").on(t.status, t.isDel, t.communityNum, t.id),
    index("cu_recommend_rank")
      .on(t.fansNum.desc(), t.id.desc())
      .where(sql`${t.status} = 1 AND ${t.isDel} = 0 AND ${t.communityNum} > 0`),
  ],
);
