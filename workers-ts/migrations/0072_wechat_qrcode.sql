-- Preserve the four source QR/channel-code tables without foreign keys or
-- invented business uniqueness. The only unique index is the source
-- qrcode(third_type, third_id) key used for idempotent provisioning.
CREATE TABLE IF NOT EXISTS "qrcode" (
  "id" SERIAL PRIMARY KEY,
  "third_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "third_id" INTEGER DEFAULT 0 NOT NULL,
  "ticket" VARCHAR(255) DEFAULT '' NOT NULL,
  "expire_seconds" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" VARCHAR(255) DEFAULT '0' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "scan" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "qrcode_third_type_third_id_uq"
  ON "qrcode" ("third_type", "third_id");
CREATE INDEX IF NOT EXISTS "qrcode_status_type"
  ON "qrcode" ("status", "type", "id");

CREATE TABLE IF NOT EXISTS "wechat_qrcode" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(500) DEFAULT '' NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "label_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "type" VARCHAR(32) DEFAULT '' NOT NULL,
  "content" TEXT,
  "data" TEXT,
  "follow" INTEGER DEFAULT 0 NOT NULL,
  "scan" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "continue_time" INTEGER DEFAULT 0 NOT NULL,
  "end_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_qrcode_cate_active"
  ON "wechat_qrcode" ("cate_id", "is_del", "id");
CREATE INDEX IF NOT EXISTS "wechat_qrcode_status_end_time"
  ON "wechat_qrcode" ("status", "end_time", "id");
CREATE INDEX IF NOT EXISTS "wechat_qrcode_uid"
  ON "wechat_qrcode" ("uid", "id");

CREATE TABLE IF NOT EXISTS "wechat_qrcode_cate" (
  "id" SERIAL PRIMARY KEY,
  "cate_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_qrcode_cate_is_del"
  ON "wechat_qrcode_cate" ("is_del", "id");

CREATE TABLE IF NOT EXISTS "wechat_qrcode_record" (
  "id" SERIAL PRIMARY KEY,
  "qid" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "is_follow" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_qrcode_record_qid_time"
  ON "wechat_qrcode_record" ("qid", "add_time", "id");
CREATE INDEX IF NOT EXISTS "wechat_qrcode_record_qid_uid"
  ON "wechat_qrcode_record" ("qid", "uid", "id");
CREATE INDEX IF NOT EXISTS "wechat_qrcode_record_qid_follow_time"
  ON "wechat_qrcode_record" ("qid", "is_follow", "add_time", "id");
