-- Preserve product-to-coupon links used to grant coupons after order payment.
CREATE TABLE IF NOT EXISTS "store_product_coupon" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "issue_coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "spc_product"
  ON "store_product_coupon" ("product_id", "id");
CREATE INDEX IF NOT EXISTS "spc_issue"
  ON "store_product_coupon" ("issue_coupon_id", "product_id");
