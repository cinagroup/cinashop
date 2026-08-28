-- Content-free replay ledger and database-enforced concurrency guards for
-- externally-triggered user/profile/balance/integral writes.
CREATE TABLE IF NOT EXISTS "out_user_write_replay" (
  "id" BIGSERIAL PRIMARY KEY,
  "out_account_id" INTEGER NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "user_id" INTEGER DEFAULT 0 NOT NULL,
  "money_ledger_id" INTEGER DEFAULT 0 NOT NULL,
  "integral_ledger_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "ouwr_operation_ck" CHECK (
    "operation" IN ('user_create', 'user_update', 'user_give')
  ),
  CONSTRAINT "ouwr_identity_ck" CHECK (
    "out_account_id" > 0 AND "user_id" > 0
      AND "money_ledger_id" >= 0 AND "integral_ledger_id" >= 0
      AND "add_time" >= 0
  ),
  CONSTRAINT "ouwr_request_hash_ck" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "ouwr_account_operation_key_uq"
  ON "out_user_write_replay" ("out_account_id", "operation", "request_key");
CREATE INDEX IF NOT EXISTS "ouwr_user_history"
  ON "out_user_write_replay" ("user_id", "id");

-- Legacy imports may contain empty or deleted duplicates; only live, usable
-- phone numbers participate in the uniqueness contract.
CREATE UNIQUE INDEX IF NOT EXISTS "user_active_phone_uq"
  ON "user" ("phone")
  WHERE "is_del" = 0 AND "delete_time" IS NULL AND "phone" <> '';

-- A replay row is the primary idempotency record. These partial unique indexes
-- independently prevent duplicate immutable financial evidence if application
-- locking is accidentally weakened in a future refactor.
CREATE UNIQUE INDEX IF NOT EXISTS "um_out_request_uq"
  ON "user_money" ("uid", "link_id", "type")
  WHERE "type" IN ('system_add', 'system_sub')
    AND "link_id" ~ '^[0-9a-f]{32}$';
CREATE UNIQUE INDEX IF NOT EXISTS "ub_out_request_uq"
  ON "user_bill" ("uid", "link_id", "event_key")
  WHERE "event_key" IN ('out_system_add_integral', 'out_system_sub_integral')
    AND "link_id" ~ '^[0-9a-f]{32}$';
