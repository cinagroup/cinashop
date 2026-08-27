-- Complete the legacy DIY page behind the TypeScript system_dise name.
ALTER TABLE "system_dise"
  ALTER COLUMN "name" TYPE VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "template_name" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "version" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "cover_image" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "default_value" TEXT,
  ADD COLUMN IF NOT EXISTS "is_diy" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_show" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_bg_color" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_bg_pic" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "color_picker" VARCHAR(50) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "bg_pic" VARCHAR(256) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "bg_tab_val" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "order_status" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "my_banner_status" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "menu_status" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "service_status" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "update_time" INTEGER DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "sd_template_type"
  ON "system_dise" ("template_name", "type");
CREATE INDEX IF NOT EXISTS "sd_status_type"
  ON "system_dise" ("status", "type");

-- Preserve every template_message field while retaining the new textual channel.
ALTER TABLE "notification_template"
  ADD COLUMN IF NOT EXISTS "notification_id" VARCHAR(255) DEFAULT '0' NOT NULL,
  ADD COLUMN IF NOT EXISTS "legacy_type" SMALLINT DEFAULT -1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "kid" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "example" VARCHAR(300) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "tempid" VARCHAR(100) DEFAULT '' NOT NULL;

CREATE INDEX IF NOT EXISTS "nt_status_type"
  ON "notification_template" ("status", "type");
CREATE INDEX IF NOT EXISTS "nt_mark"
  ON "notification_template" ("mark");

CREATE TABLE IF NOT EXISTS "agreement" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "content" TEXT,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agreement_type" ON "agreement" ("type");
CREATE INDEX IF NOT EXISTS "agreement_visible" ON "agreement" ("status", "sort" DESC);

CREATE TABLE IF NOT EXISTS "system_notification" (
  "id" SERIAL PRIMARY KEY,
  "mark" VARCHAR(50) DEFAULT '' NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "title" VARCHAR(100) DEFAULT '' NOT NULL,
  "is_system" SMALLINT DEFAULT 0 NOT NULL,
  "is_app" SMALLINT DEFAULT 0 NOT NULL,
  "is_wechat" SMALLINT DEFAULT 0 NOT NULL,
  "is_routine" SMALLINT DEFAULT 0 NOT NULL,
  "is_sms" SMALLINT DEFAULT 0 NOT NULL,
  "is_ent_wechat" SMALLINT DEFAULT 0 NOT NULL,
  "system_title" VARCHAR(256) DEFAULT '' NOT NULL,
  "system_text" VARCHAR(512) DEFAULT '' NOT NULL,
  "app_id" INTEGER DEFAULT 0 NOT NULL,
  "wechat_id" VARCHAR(50) DEFAULT '0' NOT NULL,
  "routine_id" VARCHAR(50) DEFAULT '0' NOT NULL,
  "sms_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "sms_text" VARCHAR(255) DEFAULT '' NOT NULL,
  "ent_wechat_text" VARCHAR(512) DEFAULT '' NOT NULL,
  "variable" VARCHAR(256) DEFAULT '' NOT NULL,
  "url" VARCHAR(512) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sn_mark" ON "system_notification" ("mark");
CREATE INDEX IF NOT EXISTS "sn_type" ON "system_notification" ("type");

CREATE TABLE IF NOT EXISTS "system_notice" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(64) DEFAULT '' NOT NULL,
  "type" VARCHAR(64) DEFAULT '' NOT NULL,
  "icon" VARCHAR(16) DEFAULT '' NOT NULL,
  "url" VARCHAR(64) DEFAULT '' NOT NULL,
  "table_title" VARCHAR(256) DEFAULT '' NOT NULL,
  "template" VARCHAR(64) DEFAULT '' NOT NULL,
  "push_admin" VARCHAR(128) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "snotice_type" ON "system_notice" ("type");
CREATE INDEX IF NOT EXISTS "snotice_status" ON "system_notice" ("status");

CREATE TABLE IF NOT EXISTS "system_notice_admin" (
  "id" SERIAL PRIMARY KEY,
  "notice_type" VARCHAR(64) DEFAULT '' NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "link_id" INTEGER DEFAULT 0 NOT NULL,
  "table_data" TEXT,
  "is_click" SMALLINT DEFAULT 0 NOT NULL,
  "is_visit" SMALLINT DEFAULT 0 NOT NULL,
  "visit_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sna_admin_type"
  ON "system_notice_admin" ("admin_id", "notice_type");
CREATE INDEX IF NOT EXISTS "sna_add_time" ON "system_notice_admin" ("add_time");
CREATE INDEX IF NOT EXISTS "sna_visit_click"
  ON "system_notice_admin" ("is_visit", "is_click");

CREATE TABLE IF NOT EXISTS "user_notice" (
  "id" SERIAL PRIMARY KEY,
  "uid" TEXT,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "user" VARCHAR(20) DEFAULT '' NOT NULL,
  "title" VARCHAR(20) DEFAULT '' NOT NULL,
  "content" VARCHAR(500) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_send" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "un_send_time" ON "user_notice" ("is_send", "add_time");

CREATE TABLE IF NOT EXISTS "user_notice_see" (
  "id" SERIAL PRIMARY KEY,
  "nid" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "uns_uid_nid" ON "user_notice_see" ("uid", "nid");
CREATE INDEX IF NOT EXISTS "uns_nid" ON "user_notice_see" ("nid");
