/**
 * Legacy Enterprise WeChat catalog and delivery history.
 *
 * The PHP source shape is intentionally preserved for lossless import. Six
 * relation tables do not have a stable source key; do not invent one here.
 * Remote Enterprise WeChat writes are not enabled by these table definitions.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  serial,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const workChannelCode = pgTable(
  "work_channel_code",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    cateId: integer("cate_id").default(0).notNull(),
    labelId: varchar("label_id", { length: 1000 }).default("").notNull(),
    reserveUserid: varchar("reserve_userid", { length: 64 }).default("").notNull(),
    userids: varchar("userids", { length: 1000 }).default("").notNull(),
    skipVerify: smallint("skip_verify").default(0).notNull(),
    addUpperLimit: smallint("add_upper_limit").default(0).notNull(),
    welcomeType: smallint("welcome_type").default(0).notNull(),
    welcomeWords: varchar("welcome_words", { length: 1000 }).default("").notNull(),
    qrcodeUrl: varchar("qrcode_url", { length: 255 }).default("").notNull(),
    configId: varchar("config_id", { length: 64 }).default("").notNull(),
    status: smallint("status").default(0).notNull(),
    clientNum: integer("client_num").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    deleteTime: integer("delete_time"),
  },
  (table) => [
    index("work_channel_code_cate_id").on(table.cateId),
    index("work_channel_code_status").on(table.status),
    index("work_channel_code_catalog").on(table.deleteTime, table.status, table.createTime, table.id),
  ],
);

export const workChannelCycle = pgTable(
  "work_channel_cycle",
  {
    channelId: integer("channel_id").default(0).notNull(),
    userids: varchar("userids", { length: 1000 }).default("").notNull(),
    startTime: varchar("start_time", { length: 5 }).default("").notNull(),
    endTime: varchar("end_time", { length: 5 }).default("").notNull(),
    /** Source spelling retained for import compatibility. */
    wokrTime: varchar("wokr_time", { length: 50 }).default("").notNull(),
  },
  (table) => [index("work_channel_cycle_channel_id").on(table.channelId)],
);

export const workChannelLimit = pgTable(
  "work_channel_limit",
  {
    channelId: integer("channel_id").default(0).notNull(),
    userid: varchar("userid", { length: 64 }).default("").notNull(),
    max: integer("max").default(0).notNull(),
  },
  (table) => [index("work_channel_limit_channel_id").on(table.channelId)],
);

export const workClient = pgTable(
  "work_client",
  {
    id: serial("id").primaryKey(),
    corpId: varchar("corp_id", { length: 18 }).default("").notNull(),
    externalUserid: varchar("external_userid", { length: 64 }).default("").notNull(),
    uid: integer("uid").default(0).notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    avatar: varchar("avatar", { length: 255 }).default("").notNull(),
    type: smallint("type").default(0).notNull(),
    gender: smallint("gender").default(0).notNull(),
    unionid: varchar("unionid", { length: 64 }).default("").notNull(),
    position: varchar("position", { length: 50 }).default("").notNull(),
    corpName: varchar("corp_name", { length: 50 }).default("").notNull(),
    corpFullName: varchar("corp_full_name", { length: 100 }).default("").notNull(),
    externalProfile: varchar("external_profile", { length: 1000 }).default("").notNull(),
    remark: varchar("remark", { length: 255 }).default("").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    deleteTime: integer("delete_time"),
  },
  (table) => [
    uniqueIndex("work_client_active_identity_uq")
      .on(table.corpId, table.externalUserid)
      .where(sql`${table.deleteTime} IS NULL AND ${table.externalUserid} <> ''`),
    index("work_client_external_userid").on(table.externalUserid),
    index("work_client_corp_external").on(table.corpId, table.externalUserid),
    index("work_client_uid").on(table.uid),
    index("work_client_unionid").on(table.unionid),
    index("work_client_catalog").on(table.deleteTime, table.updateTime, table.id),
  ],
);

export const workClientFollow = pgTable(
  "work_client_follow",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id").default(0).notNull(),
    userid: varchar("userid", { length: 64 }).default("").notNull(),
    remark: varchar("remark", { length: 50 }).default("").notNull(),
    description: varchar("description", { length: 255 }).default("").notNull(),
    createtime: integer("createtime").default(0).notNull(),
    remarkCorpName: varchar("remark_corp_name", { length: 50 }).default("").notNull(),
    remarkMobiles: varchar("remark_mobiles", { length: 255 }).default("").notNull(),
    addWay: integer("add_way").default(0).notNull(),
    operUserid: varchar("oper_userid", { length: 64 }).default("").notNull(),
    state: varchar("state", { length: 30 }).default("").notNull(),
    isDelUser: smallint("is_del_user").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("work_client_follow_active_identity_uq")
      .on(table.clientId, table.userid)
      .where(sql`${table.isDelUser} = 0 AND ${table.clientId} > 0 AND ${table.userid} <> ''`),
    index("work_client_follow_state").on(table.state),
    index("work_client_follow_client_id").on(table.clientId),
    index("work_client_follow_user_client").on(table.userid, table.clientId, table.id),
  ],
);

export const workClientFollowTags = pgTable(
  "work_client_follow_tags",
  {
    followId: integer("follow_id").default(0).notNull(),
    groupName: varchar("group_name", { length: 255 }).default("").notNull(),
    tagName: varchar("tag_name", { length: 255 }).default("").notNull(),
    type: smallint("type").default(0).notNull(),
    tagId: varchar("tag_id", { length: 32 }).default("").notNull(),
    createTime: integer("create_time").default(0).notNull(),
  },
  (table) => [index("work_client_follow_tags_follow_id").on(table.followId)],
);

export const workDepartment = pgTable(
  "work_department",
  {
    id: serial("id").primaryKey(),
    corpId: varchar("corp_id", { length: 18 }).default("").notNull(),
    departmentId: integer("department_id").default(0).notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    nameEn: varchar("name_en", { length: 50 }).default("").notNull(),
    departmentLeader: varchar("department_leader", { length: 1000 }).default("").notNull(),
    parentid: integer("parentid").default(0).notNull(),
    /** Source spelling retained for import compatibility. */
    srot: integer("srot").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [index("work_department_tree").on(table.corpId, table.parentid, table.srot, table.id)],
);

export const workGroupChat = pgTable(
  "work_group_chat",
  {
    id: serial("id").primaryKey(),
    corpId: varchar("corp_id", { length: 18 }).default("").notNull(),
    chatId: varchar("chat_id", { length: 40 }).default("").notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    owner: varchar("owner", { length: 64 }).default("").notNull(),
    groupCreateTime: integer("group_create_time").default(0).notNull(),
    notice: varchar("notice", { length: 255 }).default("").notNull(),
    adminList: varchar("admin_list", { length: 1000 }).default("").notNull(),
    memberNum: integer("member_num").default(0).notNull(),
    retreatGroupNum: integer("retreat_group_num").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    index("work_group_chat_corp_chat").on(table.corpId, table.chatId),
    index("work_group_chat_catalog").on(table.status, table.updateTime, table.id),
  ],
);

export const workGroupChatAuth = pgTable(
  "work_group_chat_auth",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    authGroupChat: smallint("auth_group_chat").default(0).notNull(),
    chatId: varchar("chat_id", { length: 1000 }).default("").notNull(),
    groupName: varchar("group_name", { length: 100 }).default("").notNull(),
    groupNum: integer("group_num").default(0).notNull(),
    label: varchar("label", { length: 255 }).default("").notNull(),
    configId: varchar("config_id", { length: 64 }).default("").notNull(),
    qrCode: varchar("qr_code", { length: 255 }).default("").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    deleteTime: integer("delete_time"),
  },
  (table) => [index("work_group_chat_auth_catalog").on(table.deleteTime, table.createTime, table.id)],
);

export const workGroupChatMember = pgTable(
  "work_group_chat_member",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id").default(0).notNull(),
    userid: varchar("userid", { length: 64 }).default("").notNull(),
    type: smallint("type").default(0).notNull(),
    unionid: varchar("unionid", { length: 64 }).default("").notNull(),
    joinTime: integer("join_time").default(0).notNull(),
    joinScene: smallint("join_scene").default(0).notNull(),
    invitorUserid: varchar("invitor_userid", { length: 64 }).default("").notNull(),
    groupNickname: varchar("group_nickname", { length: 100 }).default("").notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    chatSum: integer("chat_sum").default(0).notNull(),
    retreatChatNum: integer("retreat_chat_num").default(0).notNull(),
    state: varchar("state", { length: 100 }).default("").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    index("work_group_chat_member_group_id").on(table.groupId),
    index("work_group_chat_member_group_user").on(table.groupId, table.userid),
    index("work_group_chat_member_catalog").on(table.groupId, table.status, table.joinTime, table.id),
  ],
);

export const workGroupChatStatistic = pgTable(
  "work_group_chat_statistic",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id").default(0).notNull(),
    todaySum: integer("today_sum").default(0).notNull(),
    todayReturnSum: integer("today_return_sum").default(0).notNull(),
    chatSum: integer("chat_sum").default(0).notNull(),
    chatReturnSum: integer("chat_return_sum").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [index("work_group_chat_statistic_group_id").on(table.groupId)],
);

export const workGroupMsgRelation = pgTable("work_group_msg_relation", {
  templateId: integer("template_id").default(0).notNull(),
  msgId: varchar("msg_id", { length: 64 }).default("").notNull(),
});

export const workGroupMsgSendResult = pgTable(
  "work_group_msg_send_result",
  {
    id: serial("id").primaryKey(),
    msgId: varchar("msg_id", { length: 64 }).default("").notNull(),
    externalUserid: varchar("external_userid", { length: 64 }).default("").notNull(),
    chatId: varchar("chat_id", { length: 64 }).default("").notNull(),
    userid: varchar("userid", { length: 64 }).default("").notNull(),
    status: smallint("status").default(0).notNull(),
    sendTime: integer("send_time").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    index("work_group_msg_send_result_status").on(table.status),
    index("work_group_msg_send_result_msg_id").on(table.msgId),
  ],
);

export const workGroupMsgTask = pgTable(
  "work_group_msg_task",
  {
    id: serial("id").primaryKey(),
    msgId: varchar("msg_id", { length: 64 }).default("").notNull(),
    userid: varchar("userid", { length: 64 }).default("").notNull(),
    status: smallint("status").default(0).notNull(),
    sendTime: integer("send_time").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
  },
  (table) => [index("work_group_msg_task_msg_id").on(table.msgId)],
);

export const workGroupTemplate = pgTable(
  "work_group_template",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    userids: text("userids"),
    clientType: smallint("client_type").default(0).notNull(),
    whereTime: varchar("where_time", { length: 100 }).default("").notNull(),
    whereLabel: text("where_label"),
    whereNotLabel: text("where_not_label"),
    templateType: smallint("template_type").default(0).notNull(),
    sendTime: integer("send_time").default(0).notNull(),
    sendType: smallint("send_type").default(0).notNull(),
    welcomeWords: text("welcome_words"),
    failExternalUserid: text("fail_external_userid"),
    failMessage: varchar("fail_message", { length: 255 }).default("").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    index("work_group_template_type").on(table.type),
    index("work_group_template_schedule").on(table.templateType, table.sendTime),
  ],
);

export const workLabel = pgTable(
  "work_label",
  {
    id: serial("id").primaryKey(),
    corpId: varchar("corp_id", { length: 18 }).default("").notNull(),
    groupId: integer("group_id").default(0).notNull(),
    groupName: varchar("group_name", { length: 50 }).default("").notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    sort: integer("sort").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
  },
  (table) => [index("work_label_group_id").on(table.groupId)],
);

export const workMedia = pgTable(
  "work_media",
  {
    id: serial("id").primaryKey(),
    md5Path: varchar("md5_path", { length: 32 }).default("").notNull(),
    type: varchar("type", { length: 16 }).default("image").notNull(),
    uploadType: smallint("upload_type").default(0).notNull(),
    path: varchar("path", { length: 255 }).default("").notNull(),
    mediaId: varchar("media_id", { length: 500 }).default("").notNull(),
    url: varchar("url", { length: 255 }).default("").notNull(),
    temporary: smallint("temporary").default(0).notNull(),
    validTime: integer("valid_time").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [index("work_media_type_md5").on(table.type, table.md5Path)],
);

export const workMember = pgTable(
  "work_member",
  {
    id: serial("id").primaryKey(),
    corpId: varchar("corp_id", { length: 18 }).default("").notNull(),
    userid: varchar("userid", { length: 64 }).default("").notNull(),
    uid: integer("uid").default(0).notNull(),
    name: varchar("name", { length: 64 }).default("").notNull(),
    position: varchar("position", { length: 50 }).default("").notNull(),
    mobile: varchar("mobile", { length: 11 }).default("").notNull(),
    gender: smallint("gender").default(0).notNull(),
    email: varchar("email", { length: 50 }).default("").notNull(),
    bizMail: varchar("biz_mail", { length: 50 }).default("").notNull(),
    directLeader: varchar("direct_leader", { length: 500 }).default("").notNull(),
    avatar: varchar("avatar", { length: 255 }).default("").notNull(),
    thumbAvatar: varchar("thumb_avatar", { length: 255 }).default("").notNull(),
    telephone: varchar("telephone", { length: 50 }).default("").notNull(),
    alias: varchar("alias", { length: 30 }).default("").notNull(),
    enable: smallint("enable").default(0).notNull(),
    isLeader: smallint("is_leader").default(0).notNull(),
    hideMobile: smallint("hide_mobile").default(0).notNull(),
    address: varchar("address", { length: 255 }).default("").notNull(),
    openUserid: varchar("open_userid", { length: 64 }).default("").notNull(),
    mainDepartment: smallint("main_department").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    qrCode: varchar("qr_code", { length: 255 }).default("").notNull(),
    externalPosition: varchar("external_position", { length: 100 }).default("").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("work_member_userid_unique").on(table.userid),
    index("work_member_corp_id").on(table.corpId),
    index("work_member_corp_userid").on(table.corpId, table.userid),
    index("work_member_mobile").on(table.mobile),
    index("work_member_catalog").on(table.corpId, table.status, table.name, table.id),
  ],
);

export const workMemberOther = pgTable(
  "work_member_other",
  {
    memberId: integer("member_id").default(0).notNull(),
    extattr: text("extattr"),
    externalProfile: text("external_profile"),
  },
  (table) => [uniqueIndex("work_member_other_member_id_unique").on(table.memberId)],
);

export const workMemberRelation = pgTable(
  "work_member_relation",
  {
    memberId: integer("member_id").default(0).notNull(),
    department: integer("department").default(0).notNull(),
    /** Source spelling retained for import compatibility. */
    srot: integer("srot").default(0).notNull(),
    isLeaderInDept: smallint("is_leader_in_dept").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
  },
  (table) => [
    index("work_member_relation_member_id").on(table.memberId),
    index("work_member_relation_department_member").on(table.department, table.memberId),
  ],
);

export const workMoment = pgTable(
  "work_moment",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 100 }).default("").notNull(),
    type: smallint("type").default(0).notNull(),
    userIds: text("user_ids"),
    clientType: smallint("client_type").default(0).notNull(),
    clientTagList: text("client_tag_list"),
    welcomeWords: text("welcome_words"),
    sendType: smallint("send_type").default(0).notNull(),
    sendTime: integer("send_time").default(0).notNull(),
    jobid: varchar("jobid", { length: 64 }).default("").notNull(),
    invalidSenderList: text("invalid_sender_list"),
    momentId: varchar("moment_id", { length: 64 }).default("").notNull(),
    invalidExternalContactList: text("invalid_external_contact_list"),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    index("work_moment_jobid").on(table.jobid),
    index("work_moment_moment_id").on(table.momentId),
    index("work_moment_schedule").on(table.sendTime, table.sendType, table.jobid),
  ],
);

export const workMomentSendResult = pgTable(
  "work_moment_send_result",
  {
    id: serial("id").primaryKey(),
    momentId: varchar("moment_id", { length: 64 }).default("").notNull(),
    userId: varchar("user_id", { length: 64 }).default("").notNull(),
    externalUserid: text("external_userid"),
    status: smallint("status").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
  },
  (table) => [index("work_moment_send_result_moment_id").on(table.momentId)],
);

export const workWelcome = pgTable(
  "work_welcome",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(0).notNull(),
    content: text("content"),
    attachments: text("attachments"),
    sort: integer("sort").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    deleteTime: integer("delete_time"),
  },
  (table) => [index("work_welcome_catalog").on(table.deleteTime, table.sort, table.id)],
);

export const workWelcomeRelation = pgTable(
  "work_welcome_relation",
  {
    welcomeId: integer("welcome_id").default(0).notNull(),
    userid: varchar("userid", { length: 64 }).default("").notNull(),
  },
  (table) => [index("work_welcome_relation_welcome_id").on(table.welcomeId)],
);

export type WorkChannelCode = typeof workChannelCode.$inferSelect;
export type WorkClient = typeof workClient.$inferSelect;
export type WorkDepartment = typeof workDepartment.$inferSelect;
export type WorkGroupChat = typeof workGroupChat.$inferSelect;
export type WorkGroupTemplate = typeof workGroupTemplate.$inferSelect;
export type WorkMember = typeof workMember.$inferSelect;
export type WorkMoment = typeof workMoment.$inferSelect;
export type WorkWelcome = typeof workWelcome.$inferSelect;
