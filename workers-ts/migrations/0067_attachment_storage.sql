-- Attachment metadata, scoped category trees, source file-integrity history,
-- and legacy cloud-storage rows from the PHP schema. The legacy storage table
-- is migration evidence only: live object access uses the ASSETS_BUCKET R2
-- binding and never reads provider credentials from PostgreSQL.
CREATE TABLE IF NOT EXISTS "system_attachment" (
  "att_id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1,
  "file_type" SMALLINT DEFAULT 1 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "att_dir" VARCHAR(200) DEFAULT '' NOT NULL,
  "satt_dir" VARCHAR(200) DEFAULT '' NOT NULL,
  "att_size" CHAR(30) DEFAULT '' NOT NULL,
  "att_type" CHAR(30) DEFAULT '' NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "time" INTEGER DEFAULT 0 NOT NULL,
  "image_type" SMALLINT DEFAULT 1 NOT NULL,
  "module_type" SMALLINT DEFAULT 1 NOT NULL,
  "real_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "scan_token" VARCHAR(32) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_attachment_time_idx"
  ON "system_attachment" ("time");
CREATE INDEX IF NOT EXISTS "system_attachment_scope_lookup"
  ON "system_attachment" ("type", "relation_id", "module_type", "file_type", "pid", "att_id");

CREATE TABLE IF NOT EXISTS "system_attachment_category" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1,
  "file_type" SMALLINT DEFAULT 1 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "enname" VARCHAR(50) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_attachment_category_scope_lookup"
  ON "system_attachment_category" ("type", "relation_id", "file_type", "pid", "id");

CREATE TABLE IF NOT EXISTS "system_file" (
  "id" SERIAL PRIMARY KEY,
  "cthash" CHAR(32) DEFAULT '' NOT NULL,
  "filename" VARCHAR(255) DEFAULT '' NOT NULL,
  "atime" CHAR(12) DEFAULT '' NOT NULL,
  "mtime" CHAR(12) DEFAULT '' NOT NULL,
  "ctime" CHAR(12) DEFAULT '' NOT NULL
);

CREATE TABLE IF NOT EXISTS "system_storage" (
  "id" SERIAL PRIMARY KEY,
  "access_key" VARCHAR(100) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "region" VARCHAR(100) DEFAULT '' NOT NULL,
  "acl" VARCHAR(17) DEFAULT 'public-read' NOT NULL,
  "domain" VARCHAR(100) DEFAULT '' NOT NULL,
  "cname" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_ssl" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "is_delete" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_storage_status_lookup"
  ON "system_storage" ("is_delete", "status", "type", "id");
