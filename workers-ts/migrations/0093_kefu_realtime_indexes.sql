-- Per-principal realtime chat: active identity lookup, recipient inbox,
-- directional session updates and unread-message reconciliation.
CREATE INDEX IF NOT EXISTS "ss_active_uid"
  ON "store_service" ("uid", "id")
  WHERE "is_del" = 0 AND "status" = 1 AND "account_status" = 1;

CREATE INDEX IF NOT EXISTS "ssr_kefu_inbox"
  ON "store_service_record" ("user_id", "is_tourist", "update_time" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "ssr_direction"
  ON "store_service_record" ("user_id", "to_uid", "is_tourist", "id" DESC);

CREATE INDEX IF NOT EXISTS "ssl_unread_direction"
  ON "store_service_log" ("uid", "to_uid", "is_tourist", "id")
  WHERE "type" = 0;
