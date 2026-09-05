ALTER TABLE "user_extract"
  ADD COLUMN IF NOT EXISTS "request_key" VARCHAR(96) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "request_hash" VARCHAR(64) DEFAULT '' NOT NULL;

ALTER TABLE "user_extract" ALTER COLUMN "wechat" TYPE VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS "ue_request_replay_uq"
  ON "user_extract" ("uid", "request_key") WHERE "request_key" <> '';
