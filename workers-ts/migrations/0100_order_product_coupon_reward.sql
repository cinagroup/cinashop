-- Durable order attribution and idempotency evidence for coupons granted after payment.
-- PHP cached this response for two hours; PostgreSQL evidence survives retries and restarts.
CREATE TABLE IF NOT EXISTS "store_order_product_coupon_reward" (
  "id" SERIAL PRIMARY KEY,
  "order_id" INTEGER NOT NULL,
  "uid" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "issue_coupon_id" INTEGER NOT NULL,
  "coupon_user_id" INTEGER NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "sopcr_positive_ids_ck" CHECK (
    "order_id" > 0 AND "uid" > 0 AND "product_id" > 0
      AND "issue_coupon_id" > 0 AND "coupon_user_id" > 0 AND "add_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "sopcr_order_issue_uq"
  ON "store_order_product_coupon_reward" ("order_id", "issue_coupon_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sopcr_coupon_user_uq"
  ON "store_order_product_coupon_reward" ("coupon_user_id");
CREATE INDEX IF NOT EXISTS "sopcr_uid_order"
  ON "store_order_product_coupon_reward" ("uid", "order_id", "id");
