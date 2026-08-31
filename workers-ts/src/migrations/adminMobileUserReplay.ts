export const ADMIN_MOBILE_USER_REPLAY_SQL = `-- Durable, content-free idempotency evidence for embedded mobile Admin user writes.
CREATE TABLE IF NOT EXISTS "admin_user_write_replay" (
  "id" BIGSERIAL PRIMARY KEY,
  "admin_id" INTEGER NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "user_id" INTEGER DEFAULT 0 NOT NULL,
  "target_count" INTEGER DEFAULT 0 NOT NULL,
  "money_ledger_id" INTEGER DEFAULT 0 NOT NULL,
  "integral_ledger_id" INTEGER DEFAULT 0 NOT NULL,
  "other_order_id" INTEGER DEFAULT 0 NOT NULL,
  "coupon_issue_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "auwr_operation_ck" CHECK (
    "operation" IN ('finance', 'membership', 'coupon_grant')
  ),
  CONSTRAINT "auwr_identity_ck" CHECK (
    "admin_id" > 0 AND "user_id" >= 0 AND "target_count" > 0
      AND "money_ledger_id" >= 0 AND "integral_ledger_id" >= 0
      AND "other_order_id" >= 0 AND "coupon_issue_id" >= 0
      AND "add_time" >= 0
  ),
  CONSTRAINT "auwr_request_hash_ck" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "auwr_admin_operation_key_uq"
  ON "admin_user_write_replay" ("admin_id", "operation", "request_key");
CREATE INDEX IF NOT EXISTS "auwr_user_history"
  ON "admin_user_write_replay" ("user_id", "id");
CREATE INDEX IF NOT EXISTS "auwr_coupon_history"
  ON "admin_user_write_replay" ("coupon_issue_id", "id");
`;
