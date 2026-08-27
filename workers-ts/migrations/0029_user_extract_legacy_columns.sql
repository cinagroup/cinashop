-- Preserve PHP withdrawal fees, pre-withdrawal balance, payment-account
-- details, rejection time, and receipt QR code without overloading the
-- Worker-only normalized extract_number field.
ALTER TABLE "user_extract"
  ADD COLUMN IF NOT EXISTS "alipay_code" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "extract_fee" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "balance" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "fail_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "wechat" VARCHAR(15) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  ALTER COLUMN "real_name" TYPE VARCHAR(64),
  ALTER COLUMN "bank_address" TYPE VARCHAR(256);

CREATE INDEX IF NOT EXISTS "ue_uid_time"
  ON "user_extract" ("uid", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "ue_status_time"
  ON "user_extract" ("status", "add_time" DESC);
