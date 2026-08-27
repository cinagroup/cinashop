-- Preserve the remaining legacy columns on seckill time slots and community
-- records. Widening the time labels avoids truncating the old VARCHAR(16)
-- values; all operations are additive or widening-only.
ALTER TABLE "store_seckill_time"
  ADD COLUMN IF NOT EXISTS "title" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "pic" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "describe" VARCHAR(255) DEFAULT '' NOT NULL,
  ALTER COLUMN "start_time" TYPE VARCHAR(16),
  ALTER COLUMN "end_time" TYPE VARCHAR(16);

ALTER TABLE "community"
  ADD COLUMN IF NOT EXISTS "refusal" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "sort" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "verify_time" INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE "community_comment"
  ADD COLUMN IF NOT EXISTS "is_verify" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_show" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_reply" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "update_time" INTEGER DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "c_public_feed"
  ON "community" ("status", "is_verify", "is_del", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "cc_public_thread"
  ON "community_comment" (
    "community_id", "is_del", "is_show", "is_verify", "add_time" DESC
  );
