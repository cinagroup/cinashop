-- API-006 legacy activity compatibility queries.
-- These partial indexes cover only live storefront rows and avoid enlarging
-- the hot write path with deleted/imported history that the API never reads.
CREATE INDEX IF NOT EXISTS "sbu_uid_bargain_active"
  ON "store_bargain_user" ("uid", "bargain_id", "status", "id")
  WHERE "is_del" = 0;

CREATE INDEX IF NOT EXISTS "so_activity_type_visible"
  ON "store_order" ("activity_id", "type")
  WHERE "type" IN (1, 2, 3) AND "is_del" = 0 AND "is_system_del" = 0;
