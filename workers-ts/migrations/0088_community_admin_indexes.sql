-- Community moderation screens repeatedly filter non-deleted rows by review,
-- source/content type, thread level and visibility. Partial indexes keep legacy
-- soft-deleted history out of the operator hot path.
CREATE INDEX IF NOT EXISTS "c_admin_moderation"
  ON "community" ("is_verify", "type", "content_type", "add_time" DESC, "id" DESC)
  WHERE "is_del" = 0;

CREATE INDEX IF NOT EXISTS "cc_admin_moderation"
  ON "community_comment" ("is_reply", "is_verify", "is_show", "community_id", "add_time" DESC, "id" DESC)
  WHERE "is_del" = 0;

CREATE INDEX IF NOT EXISTS "ct_admin_catalog"
  ON "community_topic" ("status", "is_recommend", "sort" DESC, "id" DESC)
  WHERE "is_del" = 0;
