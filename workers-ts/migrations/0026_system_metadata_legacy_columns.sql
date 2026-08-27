-- Preserve the remaining PHP metadata on admin logs, per-user system
-- messages, and user labels. Widening-only changes avoid truncating legacy
-- titles and label names.
ALTER TABLE "system_log"
  ADD COLUMN IF NOT EXISTS "store_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "path" VARCHAR(128) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "page" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "method" VARCHAR(12) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "type" VARCHAR(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "merchant_id" INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE "system_message"
  ADD COLUMN IF NOT EXISTS "mark" VARCHAR(50) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "look" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ALTER COLUMN "title" TYPE VARCHAR(256);

ALTER TABLE "user_label"
  ADD COLUMN IF NOT EXISTS "type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "label_cate" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "tag_id" VARCHAR(64) DEFAULT '' NOT NULL,
  ALTER COLUMN "name" TYPE VARCHAR(255);

CREATE INDEX IF NOT EXISTS "syslog_admin_time"
  ON "system_log" ("admin_id", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "syslog_type_time"
  ON "system_log" ("type", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "smsg_visible_user"
  ON "system_message" ("user_id", "status", "is_del", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "ulabel_scope_cate"
  ON "user_label" ("type", "relation_id", "label_cate", "id");
