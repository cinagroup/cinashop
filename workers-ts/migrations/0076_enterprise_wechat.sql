-- Preserve the PHP Enterprise WeChat catalog and delivery history for
-- lossless import. This migration does not enable remote sync or delivery.
CREATE TABLE IF NOT EXISTS "work_channel_code" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "label_id" VARCHAR(1000) DEFAULT '' NOT NULL,
  "reserve_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "userids" VARCHAR(1000) DEFAULT '' NOT NULL,
  "skip_verify" SMALLINT DEFAULT 0 NOT NULL,
  "add_upper_limit" SMALLINT DEFAULT 0 NOT NULL,
  "welcome_type" SMALLINT DEFAULT 0 NOT NULL,
  "welcome_words" VARCHAR(1000) DEFAULT '' NOT NULL,
  "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "config_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "client_num" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" INTEGER
);
CREATE INDEX IF NOT EXISTS "work_channel_code_cate_id" ON "work_channel_code" ("cate_id");
CREATE INDEX IF NOT EXISTS "work_channel_code_status" ON "work_channel_code" ("status");
CREATE INDEX IF NOT EXISTS "work_channel_code_catalog" ON "work_channel_code" ("delete_time", "status", "create_time", "id");

-- The next relation tables have no stable unique source key. Historical
-- duplicate rows are valid source evidence and must not be collapsed.
CREATE TABLE IF NOT EXISTS "work_channel_cycle" (
  "channel_id" INTEGER DEFAULT 0 NOT NULL,
  "userids" VARCHAR(1000) DEFAULT '' NOT NULL,
  "start_time" VARCHAR(5) DEFAULT '' NOT NULL,
  "end_time" VARCHAR(5) DEFAULT '' NOT NULL,
  "wokr_time" VARCHAR(50) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_channel_cycle_channel_id" ON "work_channel_cycle" ("channel_id");

CREATE TABLE IF NOT EXISTS "work_channel_limit" (
  "channel_id" INTEGER DEFAULT 0 NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "max" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_channel_limit_channel_id" ON "work_channel_limit" ("channel_id");

CREATE TABLE IF NOT EXISTS "work_client" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "external_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "gender" SMALLINT DEFAULT 0 NOT NULL,
  "unionid" VARCHAR(64) DEFAULT '' NOT NULL,
  "position" VARCHAR(50) DEFAULT '' NOT NULL,
  "corp_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "corp_full_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "external_profile" VARCHAR(1000) DEFAULT '' NOT NULL,
  "remark" VARCHAR(255) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" INTEGER
);
CREATE INDEX IF NOT EXISTS "work_client_external_userid" ON "work_client" ("external_userid");
CREATE INDEX IF NOT EXISTS "work_client_corp_external" ON "work_client" ("corp_id", "external_userid");
CREATE INDEX IF NOT EXISTS "work_client_uid" ON "work_client" ("uid");
CREATE INDEX IF NOT EXISTS "work_client_unionid" ON "work_client" ("unionid");
CREATE INDEX IF NOT EXISTS "work_client_catalog" ON "work_client" ("delete_time", "update_time", "id");

CREATE TABLE IF NOT EXISTS "work_client_follow" (
  "id" SERIAL PRIMARY KEY,
  "client_id" INTEGER DEFAULT 0 NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "remark" VARCHAR(50) DEFAULT '' NOT NULL,
  "description" VARCHAR(255) DEFAULT '' NOT NULL,
  "createtime" INTEGER DEFAULT 0 NOT NULL,
  "remark_corp_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "remark_mobiles" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_way" INTEGER DEFAULT 0 NOT NULL,
  "oper_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "state" VARCHAR(30) DEFAULT '' NOT NULL,
  "is_del_user" SMALLINT DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_client_follow_state" ON "work_client_follow" ("state");
CREATE INDEX IF NOT EXISTS "work_client_follow_client_id" ON "work_client_follow" ("client_id");
CREATE INDEX IF NOT EXISTS "work_client_follow_user_client" ON "work_client_follow" ("userid", "client_id", "id");

CREATE TABLE IF NOT EXISTS "work_client_follow_tags" (
  "follow_id" INTEGER DEFAULT 0 NOT NULL,
  "group_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "tag_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "tag_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_client_follow_tags_follow_id" ON "work_client_follow_tags" ("follow_id");

CREATE TABLE IF NOT EXISTS "work_department" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "department_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "name_en" VARCHAR(50) DEFAULT '' NOT NULL,
  "department_leader" VARCHAR(1000) DEFAULT '' NOT NULL,
  "parentid" INTEGER DEFAULT 0 NOT NULL,
  "srot" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_department_tree" ON "work_department" ("corp_id", "parentid", "srot", "id");

CREATE TABLE IF NOT EXISTS "work_group_chat" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "chat_id" VARCHAR(40) DEFAULT '' NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "owner" VARCHAR(64) DEFAULT '' NOT NULL,
  "group_create_time" INTEGER DEFAULT 0 NOT NULL,
  "notice" VARCHAR(255) DEFAULT '' NOT NULL,
  "admin_list" VARCHAR(1000) DEFAULT '' NOT NULL,
  "member_num" INTEGER DEFAULT 0 NOT NULL,
  "retreat_group_num" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_chat_corp_chat" ON "work_group_chat" ("corp_id", "chat_id");
CREATE INDEX IF NOT EXISTS "work_group_chat_catalog" ON "work_group_chat" ("status", "update_time", "id");

CREATE TABLE IF NOT EXISTS "work_group_chat_auth" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "auth_group_chat" SMALLINT DEFAULT 0 NOT NULL,
  "chat_id" VARCHAR(1000) DEFAULT '' NOT NULL,
  "group_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "group_num" INTEGER DEFAULT 0 NOT NULL,
  "label" VARCHAR(255) DEFAULT '' NOT NULL,
  "config_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "qr_code" VARCHAR(255) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" INTEGER
);
CREATE INDEX IF NOT EXISTS "work_group_chat_auth_catalog" ON "work_group_chat_auth" ("delete_time", "create_time", "id");

CREATE TABLE IF NOT EXISTS "work_group_chat_member" (
  "id" SERIAL PRIMARY KEY,
  "group_id" INTEGER DEFAULT 0 NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "unionid" VARCHAR(64) DEFAULT '' NOT NULL,
  "join_time" INTEGER DEFAULT 0 NOT NULL,
  "join_scene" SMALLINT DEFAULT 0 NOT NULL,
  "invitor_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "group_nickname" VARCHAR(100) DEFAULT '' NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "chat_sum" INTEGER DEFAULT 0 NOT NULL,
  "retreat_chat_num" INTEGER DEFAULT 0 NOT NULL,
  "state" VARCHAR(100) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_chat_member_group_id" ON "work_group_chat_member" ("group_id");
CREATE INDEX IF NOT EXISTS "work_group_chat_member_group_user" ON "work_group_chat_member" ("group_id", "userid");
CREATE INDEX IF NOT EXISTS "work_group_chat_member_catalog" ON "work_group_chat_member" ("group_id", "status", "join_time", "id");

CREATE TABLE IF NOT EXISTS "work_group_chat_statistic" (
  "id" SERIAL PRIMARY KEY,
  "group_id" INTEGER DEFAULT 0 NOT NULL,
  "today_sum" INTEGER DEFAULT 0 NOT NULL,
  "today_return_sum" INTEGER DEFAULT 0 NOT NULL,
  "chat_sum" INTEGER DEFAULT 0 NOT NULL,
  "chat_return_sum" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_chat_statistic_group_id" ON "work_group_chat_statistic" ("group_id");

CREATE TABLE IF NOT EXISTS "work_group_msg_relation" (
  "template_id" INTEGER DEFAULT 0 NOT NULL,
  "msg_id" VARCHAR(64) DEFAULT '' NOT NULL
);

CREATE TABLE IF NOT EXISTS "work_group_msg_send_result" (
  "id" SERIAL PRIMARY KEY,
  "msg_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "external_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "chat_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_msg_send_result_status" ON "work_group_msg_send_result" ("status");
CREATE INDEX IF NOT EXISTS "work_group_msg_send_result_msg_id" ON "work_group_msg_send_result" ("msg_id");

CREATE TABLE IF NOT EXISTS "work_group_msg_task" (
  "id" SERIAL PRIMARY KEY,
  "msg_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_msg_task_msg_id" ON "work_group_msg_task" ("msg_id");

CREATE TABLE IF NOT EXISTS "work_group_template" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "userids" TEXT,
  "client_type" SMALLINT DEFAULT 0 NOT NULL,
  "where_time" VARCHAR(100) DEFAULT '' NOT NULL,
  "where_label" TEXT,
  "where_not_label" TEXT,
  "template_type" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL,
  "send_type" SMALLINT DEFAULT 0 NOT NULL,
  "welcome_words" TEXT,
  "fail_external_userid" TEXT,
  "fail_message" VARCHAR(255) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_template_type" ON "work_group_template" ("type");
CREATE INDEX IF NOT EXISTS "work_group_template_schedule" ON "work_group_template" ("template_type", "send_time");

CREATE TABLE IF NOT EXISTS "work_label" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "group_id" INTEGER DEFAULT 0 NOT NULL,
  "group_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_label_group_id" ON "work_label" ("group_id");

CREATE TABLE IF NOT EXISTS "work_media" (
  "id" SERIAL PRIMARY KEY,
  "md5_path" VARCHAR(32) DEFAULT '' NOT NULL,
  "type" VARCHAR(16) DEFAULT 'image' NOT NULL,
  "upload_type" SMALLINT DEFAULT 0 NOT NULL,
  "path" VARCHAR(255) DEFAULT '' NOT NULL,
  "media_id" VARCHAR(500) DEFAULT '' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "temporary" SMALLINT DEFAULT 0 NOT NULL,
  "valid_time" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_media_type_md5" ON "work_media" ("type", "md5_path");

CREATE TABLE IF NOT EXISTS "work_member" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(64) DEFAULT '' NOT NULL,
  "position" VARCHAR(50) DEFAULT '' NOT NULL,
  "mobile" VARCHAR(11) DEFAULT '' NOT NULL,
  "gender" SMALLINT DEFAULT 0 NOT NULL,
  "email" VARCHAR(50) DEFAULT '' NOT NULL,
  "biz_mail" VARCHAR(50) DEFAULT '' NOT NULL,
  "direct_leader" VARCHAR(500) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "thumb_avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "telephone" VARCHAR(50) DEFAULT '' NOT NULL,
  "alias" VARCHAR(30) DEFAULT '' NOT NULL,
  "enable" SMALLINT DEFAULT 0 NOT NULL,
  "is_leader" SMALLINT DEFAULT 0 NOT NULL,
  "hide_mobile" SMALLINT DEFAULT 0 NOT NULL,
  "address" VARCHAR(255) DEFAULT '' NOT NULL,
  "open_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "main_department" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "qr_code" VARCHAR(255) DEFAULT '' NOT NULL,
  "external_position" VARCHAR(100) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_member_userid_unique" ON "work_member" ("userid");
CREATE INDEX IF NOT EXISTS "work_member_corp_id" ON "work_member" ("corp_id");
CREATE INDEX IF NOT EXISTS "work_member_corp_userid" ON "work_member" ("corp_id", "userid");
CREATE INDEX IF NOT EXISTS "work_member_mobile" ON "work_member" ("mobile");
CREATE INDEX IF NOT EXISTS "work_member_catalog" ON "work_member" ("corp_id", "status", "name", "id");

CREATE TABLE IF NOT EXISTS "work_member_other" (
  "member_id" INTEGER DEFAULT 0 NOT NULL,
  "extattr" TEXT,
  "external_profile" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_member_other_member_id_unique" ON "work_member_other" ("member_id");

CREATE TABLE IF NOT EXISTS "work_member_relation" (
  "member_id" INTEGER DEFAULT 0 NOT NULL,
  "department" INTEGER DEFAULT 0 NOT NULL,
  "srot" INTEGER DEFAULT 0 NOT NULL,
  "is_leader_in_dept" SMALLINT DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_member_relation_member_id" ON "work_member_relation" ("member_id");
CREATE INDEX IF NOT EXISTS "work_member_relation_department_member" ON "work_member_relation" ("department", "member_id");

CREATE TABLE IF NOT EXISTS "work_moment" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "user_ids" TEXT,
  "client_type" SMALLINT DEFAULT 0 NOT NULL,
  "client_tag_list" TEXT,
  "welcome_words" TEXT,
  "send_type" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL,
  "jobid" VARCHAR(64) DEFAULT '' NOT NULL,
  "invalid_sender_list" TEXT,
  "moment_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "invalid_external_contact_list" TEXT,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_moment_jobid" ON "work_moment" ("jobid");
CREATE INDEX IF NOT EXISTS "work_moment_moment_id" ON "work_moment" ("moment_id");
CREATE INDEX IF NOT EXISTS "work_moment_schedule" ON "work_moment" ("send_time", "send_type", "jobid");

CREATE TABLE IF NOT EXISTS "work_moment_send_result" (
  "id" SERIAL PRIMARY KEY,
  "moment_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "user_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "external_userid" TEXT,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_moment_send_result_moment_id" ON "work_moment_send_result" ("moment_id");

CREATE TABLE IF NOT EXISTS "work_welcome" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "content" TEXT,
  "attachments" TEXT,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" INTEGER
);
CREATE INDEX IF NOT EXISTS "work_welcome_catalog" ON "work_welcome" ("delete_time", "sort", "id");

CREATE TABLE IF NOT EXISTS "work_welcome_relation" (
  "welcome_id" INTEGER DEFAULT 0 NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_welcome_relation_welcome_id" ON "work_welcome_relation" ("welcome_id");
