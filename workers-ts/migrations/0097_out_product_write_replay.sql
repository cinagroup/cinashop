-- Transactional replay ledger for third-party product writes. The ledger is
-- deliberately content-free: no product names, barcodes, stock values, request
-- bodies or response bodies are persisted, only a canonical request digest.
CREATE TABLE IF NOT EXISTS "out_product_write_replay" (
  "id" BIGSERIAL PRIMARY KEY,
  "out_account_id" INTEGER NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "result_count" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "opwr_operation_ck" CHECK (
    "operation" IN ('product_create', 'product_update', 'product_show', 'stock_upload')
  ),
  CONSTRAINT "opwr_identity_ck" CHECK (
    "out_account_id" > 0 AND "product_id" >= 0
      AND "result_count" >= 0 AND "add_time" >= 0
  ),
  CONSTRAINT "opwr_request_hash_ck" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "opwr_account_operation_key_uq"
  ON "out_product_write_replay" ("out_account_id", "operation", "request_key");
CREATE INDEX IF NOT EXISTS "opwr_product_history"
  ON "out_product_write_replay" ("product_id", "id");
