-- Preserve the five official-account content tables without foreign keys or
-- semantic uniqueness that could reject historical CRMEB rows. Ordinary
-- indexes added to wechat_key/news_category only accelerate active Worker reads.
CREATE TABLE IF NOT EXISTS "wechat_key" (
  "id" SERIAL PRIMARY KEY,
  "reply_id" INTEGER DEFAULT 0 NOT NULL,
  "keys" VARCHAR(64) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_key_keys"
  ON "wechat_key" ("keys");
CREATE INDEX IF NOT EXISTS "wechat_key_reply_id"
  ON "wechat_key" ("reply_id");

CREATE TABLE IF NOT EXISTS "wechat_media" (
  "id" SERIAL PRIMARY KEY,
  "type" VARCHAR(16) DEFAULT '' NOT NULL,
  "path" VARCHAR(128) DEFAULT '' NOT NULL,
  "media_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "url" VARCHAR(256) DEFAULT '' NOT NULL,
  "temporary" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "wechat_media_type_media_id_uq"
  ON "wechat_media" ("type", "media_id");

CREATE TABLE IF NOT EXISTS "wechat_message" (
  "id" SERIAL PRIMARY KEY,
  "openid" VARCHAR(100) DEFAULT '' NOT NULL,
  "type" VARCHAR(100) DEFAULT '' NOT NULL,
  "result" VARCHAR(512) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_message_openid"
  ON "wechat_message" ("openid");
CREATE INDEX IF NOT EXISTS "wechat_message_type"
  ON "wechat_message" ("type");
CREATE INDEX IF NOT EXISTS "wechat_message_add_time"
  ON "wechat_message" ("add_time");

CREATE TABLE IF NOT EXISTS "wechat_news_category" (
  "id" SERIAL PRIMARY KEY,
  "cate_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "new_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_news_category_status_sort"
  ON "wechat_news_category" ("status", "sort", "id");

CREATE TABLE IF NOT EXISTS "wechat_reply" (
  "id" SERIAL PRIMARY KEY,
  "type" VARCHAR(32) DEFAULT '' NOT NULL,
  "data" TEXT,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "hide" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_reply_type"
  ON "wechat_reply" ("type");
CREATE INDEX IF NOT EXISTS "wechat_reply_status"
  ON "wechat_reply" ("status");
CREATE INDEX IF NOT EXISTS "wechat_reply_hide"
  ON "wechat_reply" ("hide");
