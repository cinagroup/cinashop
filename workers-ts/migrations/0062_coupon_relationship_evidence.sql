-- Preserve coupon product scope and coupon-claim evidence exactly as the PHP
-- install schema defines them. Neither source table has a primary/unique key,
-- so duplicate historical rows remain valid and live copy stays blocked until
-- a deterministic multiset-preserving cursor is implemented.
CREATE TABLE IF NOT EXISTS "store_coupon_issue_user" (
  "uid" INTEGER DEFAULT 0,
  "issue_coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_coupon_issue_user_issue_time"
  ON "store_coupon_issue_user" ("issue_coupon_id", "add_time", "uid");
CREATE INDEX IF NOT EXISTS "store_coupon_issue_user_uid_issue_time"
  ON "store_coupon_issue_user" ("uid", "issue_coupon_id", "add_time");

CREATE TABLE IF NOT EXISTS "store_coupon_product" (
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_coupon_product_coupon_product"
  ON "store_coupon_product" ("coupon_id", "product_id");
CREATE INDEX IF NOT EXISTS "store_coupon_product_product_coupon"
  ON "store_coupon_product" ("product_id", "coupon_id");
