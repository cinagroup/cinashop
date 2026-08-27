-- Community author feeds and recommendations are read on every social screen.
-- Match the full visibility predicate so deleted or unreviewed legacy rows do
-- not bloat the hot indexes.
CREATE INDEX IF NOT EXISTS "c_author_public_latest"
  ON "community" ("type", "relation_id", "add_time" DESC, "id" DESC)
  WHERE "status" = 1 AND "is_verify" = 1 AND "is_del" = 0;

CREATE INDEX IF NOT EXISTS "cu_recommend_rank"
  ON "community_user" ("fans_num" DESC, "id" DESC)
  WHERE "status" = 1 AND "is_del" = 0 AND "community_num" > 0;
