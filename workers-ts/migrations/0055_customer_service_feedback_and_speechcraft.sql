-- Preserve the feedback inbox and reusable customer-service replies used by
-- the PHP user, admin and dedicated customer-service call chains.
CREATE TABLE IF NOT EXISTS "store_service_feedback" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "rela_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(30) DEFAULT '' NOT NULL,
  "content" VARCHAR(500) DEFAULT '' NOT NULL,
  "make" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ssf_uid" ON "store_service_feedback" ("uid");
CREATE INDEX IF NOT EXISTS "ssf_status_time"
  ON "store_service_feedback" ("status", "add_time", "id");

-- The source permits duplicate messages and historical duplicates must remain
-- importable. Runtime writes serialize by owner and reject new duplicates.
CREATE TABLE IF NOT EXISTS "store_service_speechcraft" (
  "id" SERIAL PRIMARY KEY,
  "kefu_id" INTEGER DEFAULT 0 NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(100) DEFAULT '' NOT NULL,
  "message" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sss_kefu_id" ON "store_service_speechcraft" ("kefu_id");
CREATE INDEX IF NOT EXISTS "sss_cate_id" ON "store_service_speechcraft" ("cate_id");
CREATE INDEX IF NOT EXISTS "sss_scope_sort"
  ON "store_service_speechcraft" ("kefu_id", "cate_id", "sort", "id");
