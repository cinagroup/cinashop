-- Dedicated customer-service login, active-agent lookup, scoped chat history,
-- recent-session keyset pagination and private speechcraft categories.
CREATE INDEX IF NOT EXISTS "ss_active_online"
  ON "store_service" ("online", "id")
  WHERE "is_del" = 0 AND "status" = 1 AND "account_status" = 1;

CREATE INDEX IF NOT EXISTS "ssl_chat_history"
  ON "store_service_log" ("uid", "to_uid", "is_tourist", "id");

CREATE INDEX IF NOT EXISTS "ssr_kefu_recent"
  ON "store_service_record" ("to_uid", "is_tourist", "update_time" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "category_kefu_speechcraft"
  ON "category" ("owner_id", "type", "group", "sort" DESC, "id");
