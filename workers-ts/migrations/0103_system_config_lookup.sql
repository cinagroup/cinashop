-- Deterministic global/store configuration reads filter by scope + key and
-- choose the greatest business sort, then newest id.
CREATE INDEX IF NOT EXISTS "system_config_lookup"
  ON "system_config" ("is_store", "menu_name", "sort" DESC, "id" DESC);
