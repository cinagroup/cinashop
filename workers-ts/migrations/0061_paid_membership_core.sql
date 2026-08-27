-- Preserve paid-membership plans, activation-card inventory, membership orders,
-- and append-only status evidence. Card passwords remain migration-only secrets
-- and are never returned by storefront APIs.
CREATE TABLE IF NOT EXISTS "member_card_batch" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(100) DEFAULT '0' NOT NULL,
  "total_num" INTEGER DEFAULT 0 NOT NULL,
  "use_start_time" INTEGER DEFAULT 7 NOT NULL,
  "use_end_time" INTEGER DEFAULT 0 NOT NULL,
  "use_day" INTEGER DEFAULT 0 NOT NULL,
  "use_num" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "qrcode" VARCHAR(255) DEFAULT '' NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "member_card_batch_status_sort"
  ON "member_card_batch" ("status", "sort", "id");

CREATE TABLE IF NOT EXISTS "member_card" (
  "id" SERIAL NOT NULL,
  "card_batch_id" INTEGER DEFAULT 0 NOT NULL,
  "card_number" VARCHAR(20) DEFAULT '' NOT NULL,
  "card_password" CHAR(12) DEFAULT '' NOT NULL,
  "use_uid" INTEGER DEFAULT 0 NOT NULL,
  "use_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "member_card_pk" PRIMARY KEY ("id", "card_batch_id")
);

CREATE INDEX IF NOT EXISTS "member_card_number_lookup"
  ON "member_card" ("card_number");
CREATE INDEX IF NOT EXISTS "member_card_batch_status_use"
  ON "member_card" ("card_batch_id", "status", "use_time", "id");
CREATE INDEX IF NOT EXISTS "member_card_user_use"
  ON "member_card" ("use_uid", "use_time", "id");

CREATE TABLE IF NOT EXISTS "member_ship" (
  "id" SERIAL PRIMARY KEY,
  "type" VARCHAR(20) DEFAULT 'month' NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "vip_day" INTEGER DEFAULT 0 NOT NULL,
  "price" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "pre_price" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "is_label" SMALLINT DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "member_ship_active_sort"
  ON "member_ship" ("is_del", "sort", "id");
CREATE INDEX IF NOT EXISTS "member_ship_type"
  ON "member_ship" ("type", "is_del");

CREATE TABLE IF NOT EXISTS "other_order" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "member_type" VARCHAR(10) DEFAULT '' NOT NULL,
  "code" VARCHAR(20) DEFAULT '' NOT NULL,
  "pay_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "paid" SMALLINT DEFAULT 0 NOT NULL,
  "pay_price" NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
  "member_price" NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL,
  "trade_no" VARCHAR(50) DEFAULT '' NOT NULL,
  "channel_type" VARCHAR(10) DEFAULT '' NOT NULL,
  "is_free" SMALLINT DEFAULT 0 NOT NULL,
  "is_permanent" SMALLINT DEFAULT 0 NOT NULL,
  "overdue_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "vip_day" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "money" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "remarks" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "other_order_order_id"
  ON "other_order" ("order_id");
CREATE INDEX IF NOT EXISTS "other_order_uid_time"
  ON "other_order" ("uid", "add_time", "id");
CREATE INDEX IF NOT EXISTS "other_order_paid_time"
  ON "other_order" ("paid", "pay_time", "id");
CREATE INDEX IF NOT EXISTS "other_order_type_paid"
  ON "other_order" ("type", "paid", "id");

CREATE TABLE IF NOT EXISTS "other_order_status" (
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "change_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "change_message" VARCHAR(256) DEFAULT '' NOT NULL,
  "shop_type" SMALLINT DEFAULT 1 NOT NULL,
  "change_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "other_order_status_oid_time"
  ON "other_order_status" ("oid", "change_time");
CREATE INDEX IF NOT EXISTS "other_order_status_type_time"
  ON "other_order_status" ("change_type", "change_time");
