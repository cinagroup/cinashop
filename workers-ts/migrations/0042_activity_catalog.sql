-- Preserve parent activity schedules and product membership referenced by activity goods.
CREATE TABLE IF NOT EXISTS "store_activity" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(128) DEFAULT '' NOT NULL,
  "image" VARCHAR(128) DEFAULT '',
  "start_day" INTEGER DEFAULT 0 NOT NULL,
  "end_day" INTEGER DEFAULT 0 NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "end_time" INTEGER DEFAULT 0 NOT NULL,
  "time_id" TEXT,
  "once_num" INTEGER DEFAULT 0,
  "num" INTEGER DEFAULT 0,
  "discount" VARCHAR(128) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0,
  "is_recommend" SMALLINT DEFAULT 0,
  "link_id" INTEGER DEFAULT 0,
  "applicable_type" SMALLINT DEFAULT 1 NOT NULL,
  "applicable_store_id" TEXT,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sa_day_window" ON "store_activity" ("start_day", "end_day");
CREATE INDEX IF NOT EXISTS "sa_time_window" ON "store_activity" ("start_time", "end_time");
CREATE INDEX IF NOT EXISTS "sa_type" ON "store_activity" ("type");
CREATE INDEX IF NOT EXISTS "sa_active_window"
  ON "store_activity" ("type", "status", "is_del", "start_day", "end_day");

CREATE TABLE IF NOT EXISTS "store_activity_relation" (
  "id" SERIAL PRIMARY KEY,
  "activity_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "sar_activity_product"
  ON "store_activity_relation" ("activity_id", "product_id");
CREATE INDEX IF NOT EXISTS "sar_product_activity"
  ON "store_activity_relation" ("product_id", "activity_id");
