-- Preserve the legacy mini-program live catalog. Remote WeChat status reads
-- may refresh these rows, but importing them never creates rooms, submits
-- goods for audit, uploads media, or attaches goods to a remote room.
CREATE TABLE IF NOT EXISTS "live_anchor" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "cover_img" VARCHAR(255) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(50) DEFAULT '' NOT NULL,
  "phone" VARCHAR(32) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "live_anchor_visible_time"
  ON "live_anchor" ("is_del", "is_show", "add_time", "id");
CREATE INDEX IF NOT EXISTS "live_anchor_wechat"
  ON "live_anchor" ("wechat", "id");

CREATE TABLE IF NOT EXISTS "live_goods" (
  "id" SERIAL PRIMARY KEY,
  "goods_id" INTEGER DEFAULT 0 NOT NULL,
  "audit_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(30) DEFAULT '' NOT NULL,
  "cover_img" VARCHAR(255) DEFAULT '' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "price_type" SMALLINT DEFAULT 1 NOT NULL,
  "cost_price" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "price" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "price2" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "audit_status" SMALLINT DEFAULT 0 NOT NULL,
  "third_part_tag" SMALLINT DEFAULT 1 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "live_goods_visible_sort"
  ON "live_goods" ("is_del", "is_show", "sort", "add_time", "id");
CREATE INDEX IF NOT EXISTS "live_goods_audit_status"
  ON "live_goods" ("audit_status", "goods_id", "id");
CREATE INDEX IF NOT EXISTS "live_goods_product"
  ON "live_goods" ("product_id", "id");

CREATE TABLE IF NOT EXISTS "live_room" (
  "id" SERIAL NOT NULL,
  "room_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(32) DEFAULT '' NOT NULL,
  "cover_img" VARCHAR(255) DEFAULT '' NOT NULL,
  "share_img" VARCHAR(255) DEFAULT '' NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "end_time" INTEGER DEFAULT 0 NOT NULL,
  "anchor_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "anchor_wechat" VARCHAR(50) DEFAULT '' NOT NULL,
  "phone" VARCHAR(32) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "screen_type" SMALLINT DEFAULT 1 NOT NULL,
  "close_like" SMALLINT DEFAULT 0 NOT NULL,
  "close_goods" SMALLINT DEFAULT 0 NOT NULL,
  "close_comment" SMALLINT DEFAULT 0 NOT NULL,
  "error_msg" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "live_status" SMALLINT DEFAULT 102 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "replay_status" SMALLINT DEFAULT 0 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "live_room_pk" PRIMARY KEY ("id", "phone")
);

CREATE INDEX IF NOT EXISTS "live_room_visible_sort"
  ON "live_room" ("is_del", "is_show", "sort", "id");
CREATE INDEX IF NOT EXISTS "live_room_remote_status"
  ON "live_room" ("room_id", "live_status", "id");
CREATE INDEX IF NOT EXISTS "live_room_anchor"
  ON "live_room" ("anchor_wechat", "id");

-- The PHP schema has only a non-unique pair index. Historical duplicate links
-- are therefore valid evidence and must not be collapsed by a unique key.
CREATE TABLE IF NOT EXISTS "live_room_goods" (
  "live_room_id" INTEGER DEFAULT 0 NOT NULL,
  "live_goods_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "live_room_goods_pair"
  ON "live_room_goods" ("live_room_id", "live_goods_id");
CREATE INDEX IF NOT EXISTS "live_room_goods_goods_room"
  ON "live_room_goods" ("live_goods_id", "live_room_id");
