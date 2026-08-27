-- Preserve configuration navigation and dynamic form definitions separately
-- from system_config values and per-order custom_form snapshots.
CREATE TABLE IF NOT EXISTS "system_config_tab" (
  "id" SERIAL PRIMARY KEY,
  "is_store" SMALLINT DEFAULT 0 NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "eng_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "info" SMALLINT DEFAULT 0 NOT NULL,
  "icon" VARCHAR(30) DEFAULT '' NOT NULL,
  "type" INTEGER DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_config_tab_pid" ON "system_config_tab" ("pid");
CREATE INDEX IF NOT EXISTS "system_config_tab_is_store" ON "system_config_tab" ("is_store");
CREATE INDEX IF NOT EXISTS "system_config_tab_eng_title" ON "system_config_tab" ("eng_title");
CREATE INDEX IF NOT EXISTS "system_config_tab_scope_active"
  ON "system_config_tab" ("is_store", "status", "pid", "sort", "id");

CREATE TABLE IF NOT EXISTS "system_form" (
  "id" SERIAL PRIMARY KEY,
  "version" VARCHAR(255) DEFAULT '' NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "cover_image" VARCHAR(255) DEFAULT '' NOT NULL,
  "value" TEXT,
  "default_value" TEXT,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_form_active"
  ON "system_form" ("is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "system_form_name" ON "system_form" ("name");

CREATE TABLE IF NOT EXISTS "system_form_data" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "system_form_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "value" TEXT,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_form_data_form"
  ON "system_form_data" ("system_form_id", "is_del", "id");
CREATE INDEX IF NOT EXISTS "system_form_data_user"
  ON "system_form_data" ("uid", "type", "relation_id", "id");
