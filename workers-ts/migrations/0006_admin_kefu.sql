-- M7 管理后台 + 客服 schema 迁移
-- 对应 eb_system_admin + eb_system_role + eb_store_service + eb_store_service_log + eb_store_service_record

-- 管理员
CREATE TABLE IF NOT EXISTS "system_admin" (
  "id" SERIAL PRIMARY KEY,
  "account" VARCHAR(32) DEFAULT '' NOT NULL,
  "admin_type" SMALLINT DEFAULT 1 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "head_pic" VARCHAR(255) DEFAULT '' NOT NULL,
  "pwd" VARCHAR(100) DEFAULT '' NOT NULL,
  "real_name" VARCHAR(16) DEFAULT '' NOT NULL,
  "phone" VARCHAR(32) DEFAULT '' NOT NULL,
  "roles" VARCHAR(128) DEFAULT '' NOT NULL,
  "last_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "last_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "login_count" INTEGER DEFAULT 0 NOT NULL,
  "level" SMALLINT DEFAULT 1 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "division_id" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "sa_account_idx" ON "system_admin" ("account");

-- 角色
CREATE TABLE IF NOT EXISTS "system_role" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "role_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "rules" TEXT DEFAULT '' NOT NULL,
  "level" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL
);

-- 客服账号
CREATE TABLE IF NOT EXISTS "store_service" (
  "id" SERIAL PRIMARY KEY,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "online" SMALLINT DEFAULT 0 NOT NULL,
  "account" VARCHAR(64) DEFAULT '' NOT NULL,
  "password" VARCHAR(100) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "nickname" VARCHAR(50) DEFAULT '' NOT NULL,
  "phone" VARCHAR(18) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "account_status" SMALLINT DEFAULT 1 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "notify" SMALLINT DEFAULT 1 NOT NULL,
  "customer" SMALLINT DEFAULT 0 NOT NULL,
  "uniqid" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

-- 聊天消息记录
CREATE TABLE IF NOT EXISTS "store_service_log" (
  "id" SERIAL PRIMARY KEY,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "msn" TEXT DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "to_uid" INTEGER DEFAULT 0 NOT NULL,
  "is_tourist" SMALLINT DEFAULT 0 NOT NULL,
  "time_node" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "remind" SMALLINT DEFAULT 0 NOT NULL,
  "msn_type" SMALLINT DEFAULT 1 NOT NULL
);
CREATE INDEX IF NOT EXISTS "ssl_uid_toUid_idx" ON "store_service_log" ("uid", "to_uid");

-- 会话摘要
CREATE TABLE IF NOT EXISTS "store_service_record" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER DEFAULT 0 NOT NULL,
  "to_uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(50) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_tourist" SMALLINT DEFAULT 0 NOT NULL,
  "online" SMALLINT DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "mssage_num" INTEGER DEFAULT 0 NOT NULL,
  "message" TEXT DEFAULT '' NOT NULL,
  "message_type" SMALLINT DEFAULT 1 NOT NULL
);
CREATE INDEX IF NOT EXISTS "ssr_to_uid_idx" ON "store_service_record" ("to_uid");
