-- Content-free replay ledger for externally-triggered coupon writes. Coupon
-- titles, values, scopes, dates and request/response bodies are never stored.
CREATE TABLE IF NOT EXISTS "out_coupon_write_replay" (
  "id" BIGSERIAL PRIMARY KEY,
  "out_account_id" INTEGER NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "result_status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "ocwr_operation_ck" CHECK (
    "operation" IN ('coupon_create', 'coupon_status', 'coupon_delete')
  ),
  CONSTRAINT "ocwr_identity_ck" CHECK (
    "out_account_id" > 0 AND "coupon_id" > 0
      AND "result_status" BETWEEN -1 AND 1 AND "add_time" >= 0
  ),
  CONSTRAINT "ocwr_request_hash_ck" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "ocwr_account_operation_key_uq"
  ON "out_coupon_write_replay" ("out_account_id", "operation", "request_key");
CREATE INDEX IF NOT EXISTS "ocwr_coupon_history"
  ON "out_coupon_write_replay" ("coupon_id", "id");
