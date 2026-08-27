-- Preserve the superseded merchant application and official-account member
-- card history. This migration never creates/updates a remote WeChat card.
CREATE TABLE IF NOT EXISTS "user_enter" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "province" VARCHAR(32) DEFAULT '' NOT NULL,
  "city" VARCHAR(32) DEFAULT '' NOT NULL,
  "district" VARCHAR(32) DEFAULT '' NOT NULL,
  "address" VARCHAR(256) DEFAULT '' NOT NULL,
  "merchant_name" VARCHAR(256) DEFAULT '' NOT NULL,
  "link_user" VARCHAR(32) DEFAULT '' NOT NULL,
  "link_tel" VARCHAR(16) DEFAULT '' NOT NULL,
  "charter" VARCHAR(512) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "apply_time" INTEGER DEFAULT 0 NOT NULL,
  "success_time" INTEGER DEFAULT 0 NOT NULL,
  "fail_message" VARCHAR(256) DEFAULT '' NOT NULL,
  "fail_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "is_lock" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_enter_uid_unique" ON "user_enter" ("uid");
CREATE INDEX IF NOT EXISTS "user_enter_region" ON "user_enter" ("province", "city", "district");
CREATE INDEX IF NOT EXISTS "user_enter_is_lock" ON "user_enter" ("is_lock");
CREATE INDEX IF NOT EXISTS "user_enter_is_del" ON "user_enter" ("is_del");
CREATE INDEX IF NOT EXISTS "user_enter_status" ON "user_enter" ("status");

CREATE TABLE IF NOT EXISTS "wechat_card" (
  "id" SERIAL PRIMARY KEY,
  "card_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "card_type" VARCHAR(20) DEFAULT 'member_card' NOT NULL,
  "code_type" VARCHAR(20) DEFAULT '' NOT NULL,
  "brand_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "title" VARCHAR(50) DEFAULT '' NOT NULL,
  "color" VARCHAR(15) DEFAULT '' NOT NULL,
  "notice" VARCHAR(20) DEFAULT '' NOT NULL,
  "description" VARCHAR(255) DEFAULT '' NOT NULL,
  "center_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "center_sub_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "center_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "service_phone" VARCHAR(30) DEFAULT '' NOT NULL,
  "logo_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "background_pic_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "prerogative" TEXT,
  "especial" TEXT,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "wechat_card_catalog" ON "wechat_card" ("card_type", "is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "wechat_card_remote_id" ON "wechat_card" ("card_id", "id");

CREATE TABLE IF NOT EXISTS "user_card" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "spread_uid" INTEGER DEFAULT 0 NOT NULL,
  "wechat_card_id" INTEGER DEFAULT 0 NOT NULL,
  "card_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "code" VARCHAR(50) DEFAULT '' NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "openid" VARCHAR(100) DEFAULT '' NOT NULL,
  "is_submit" SMALLINT DEFAULT 0 NOT NULL,
  "submit_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "del_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "user_card_active_remote" ON "user_card" ("openid", "card_id", "is_del", "id");
CREATE INDEX IF NOT EXISTS "user_card_store_staff_submit" ON "user_card" ("store_id", "staff_id", "is_submit", "add_time", "id");
CREATE INDEX IF NOT EXISTS "user_card_uid" ON "user_card" ("uid", "id");
CREATE INDEX IF NOT EXISTS "user_card_wechat_card" ON "user_card" ("wechat_card_id", "id");
