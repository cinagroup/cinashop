-- Scoped customer product context: purchases, visit recency and category expansion.
CREATE INDEX IF NOT EXISTS "soci_kefu_order_product"
  ON "store_order_cart_info" ("oid", "product_id");

CREATE INDEX IF NOT EXISTS "sv_kefu_recent"
  ON "store_visit" ("uid", "add_time" DESC, "id" DESC, "product_id");

CREATE INDEX IF NOT EXISTS "spr_kefu_product_category"
  ON "store_product_relation" ("type", "product_id", "relation_id");

CREATE INDEX IF NOT EXISTS "spr_kefu_category_product"
  ON "store_product_relation" ("type", "relation_id", "product_id");
