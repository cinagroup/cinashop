-- Client community reads repeatedly scan one public reply thread, one user's
-- product source history, or one user's product collections. Match equality
-- predicates first and keep immutable non-matching relation rows out of the
-- collection index.
CREATE INDEX IF NOT EXISTS "cc_public_replies"
  ON "community_comment" ("reply_id", "add_time", "id")
  WHERE "is_reply" = 0 AND "is_del" = 0 AND "is_show" = 1 AND "is_verify" = 1;

CREATE INDEX IF NOT EXISTS "spl_user_source_latest"
  ON "store_product_log" ("uid", "type", "add_time" DESC, "product_id");

CREATE INDEX IF NOT EXISTS "ur_user_product_collect_latest"
  ON "user_relation" ("uid", "add_time" DESC, "id" DESC, "relation_id")
  WHERE "type" = 'collect' AND "category" = 'product';
