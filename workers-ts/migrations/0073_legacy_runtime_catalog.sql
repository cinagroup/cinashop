-- Preserve legacy batch-queue history and the dynamic timer catalog. These
-- rows are diagnostic/migration data only: importing them never dispatches a
-- Cloudflare Queue message or changes the Worker scheduled configuration.
CREATE TABLE IF NOT EXISTS "queue_list" (
  "id" SERIAL NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "source" VARCHAR(5) DEFAULT 'admin' NOT NULL,
  "execute_key" VARCHAR(512) DEFAULT '' NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "queue_in_value" TEXT,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "first_time" INTEGER DEFAULT 0 NOT NULL,
  "again_time" INTEGER DEFAULT 0 NOT NULL,
  "finish_time" INTEGER DEFAULT 0 NOT NULL,
  "surplus_num" INTEGER DEFAULT 0 NOT NULL,
  "total_num" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "queue_list_pk" PRIMARY KEY ("id", "type", "status")
);

CREATE INDEX IF NOT EXISTS "queue_list_status_type_time"
  ON "queue_list" ("status", "type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "queue_list_source_time"
  ON "queue_list" ("source", "add_time", "id");

CREATE TABLE IF NOT EXISTS "queue_auxiliary" (
  "id" SERIAL PRIMARY KEY,
  "binding_id" INTEGER DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "other" VARCHAR(2048) DEFAULT '' NOT NULL,
  "status" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "queue_auxiliary_binding_type_time"
  ON "queue_auxiliary" ("binding_id", "type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "queue_auxiliary_status_type_time"
  ON "queue_auxiliary" ("status", "type", "add_time", "id");

CREATE TABLE IF NOT EXISTS "system_timer" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "mark" VARCHAR(50) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_open" SMALLINT DEFAULT 0 NOT NULL,
  "cycle" VARCHAR(255) DEFAULT '' NOT NULL,
  "last_execution_time" INTEGER DEFAULT 0 NOT NULL,
  "update_execution_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_timer_active_open"
  ON "system_timer" ("is_del", "is_open", "id");
CREATE INDEX IF NOT EXISTS "system_timer_mark"
  ON "system_timer" ("mark", "id");
