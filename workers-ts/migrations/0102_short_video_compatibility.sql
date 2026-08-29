-- Worker-owned short-video compatibility extension.
-- CRMEB-PRO v3.1.1 exposes runtime code for these tables but its installer and
-- matching data dictionary contain no authoritative source DDL.
CREATE TABLE IF NOT EXISTS "video" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "image" VARCHAR(2048) DEFAULT '' NOT NULL,
  "desc" TEXT DEFAULT '' NOT NULL,
  "video_url" VARCHAR(2048) DEFAULT '' NOT NULL,
  "product_id" TEXT DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_recommend" SMALLINT DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_verify" SMALLINT DEFAULT 1 NOT NULL,
  "comment_num" INTEGER DEFAULT 0 NOT NULL,
  "like_num" INTEGER DEFAULT 0 NOT NULL,
  "collect_num" INTEGER DEFAULT 0 NOT NULL,
  "share_num" INTEGER DEFAULT 0 NOT NULL,
  "play_num" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "video_comment" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "video_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(64) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(2048) DEFAULT '' NOT NULL,
  "content" TEXT DEFAULT '' NOT NULL,
  "ip" VARCHAR(45) DEFAULT '' NOT NULL,
  "city" VARCHAR(255) DEFAULT '' NOT NULL,
  "like_num" INTEGER DEFAULT 0 NOT NULL,
  "collect_num" INTEGER DEFAULT 0 NOT NULL,
  "share_num" INTEGER DEFAULT 0 NOT NULL,
  "is_reply" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "video_storefront_latest"
  ON "video" ("id" DESC, "sort" DESC)
  WHERE "is_show" = 1 AND "is_del" = 0 AND "is_verify" = 1;
CREATE INDEX IF NOT EXISTS "video_storefront_sort"
  ON "video" ("sort" DESC, "id" DESC)
  WHERE "is_show" = 1 AND "is_del" = 0 AND "is_verify" = 1;
CREATE INDEX IF NOT EXISTS "video_storefront_recommended"
  ON "video" ("is_recommend", "sort" DESC, "id" DESC)
  WHERE "is_show" = 1 AND "is_del" = 0 AND "is_verify" = 1;
CREATE INDEX IF NOT EXISTS "video_comment_thread"
  ON "video_comment" ("video_id", "pid", "id" DESC)
  WHERE "is_del" = 0;
CREATE INDEX IF NOT EXISTS "video_comment_owner"
  ON "video_comment" ("uid", "id" DESC)
  WHERE "is_del" = 0;
