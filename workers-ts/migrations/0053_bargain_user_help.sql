-- Preserve every historical bargain-help event. The source has no composite
-- uniqueness constraint, so duplicate evidence remains importable; runtime
-- writes serialize on the participation row instead.
CREATE TABLE IF NOT EXISTS "store_bargain_user_help" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "bargain_id" INTEGER DEFAULT 0 NOT NULL,
  "bargain_user_id" INTEGER DEFAULT 0 NOT NULL,
  "price" DECIMAL(12,2) DEFAULT 0.00 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sbuh_participation"
  ON "store_bargain_user_help" ("bargain_user_id", "id");
CREATE INDEX IF NOT EXISTS "sbuh_helper_activity"
  ON "store_bargain_user_help" ("uid", "bargain_id", "type");
