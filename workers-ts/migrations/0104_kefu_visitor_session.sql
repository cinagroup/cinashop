-- Worker-owned anonymous customer-service sessions. Raw bearer tokens and IP
-- addresses are deliberately never persisted.
CREATE SEQUENCE IF NOT EXISTS "kefu_visitor_uid_seq"
  AS INTEGER START WITH 1000000000 MAXVALUE 2147483647 NO CYCLE;

CREATE TABLE IF NOT EXISTS "kefu_visitor_session" (
  "session_id" VARCHAR(36) PRIMARY KEY,
  "visitor_uid" INTEGER DEFAULT nextval('"kefu_visitor_uid_seq"') NOT NULL UNIQUE,
  "service_id" INTEGER NOT NULL,
  "kefu_uid" INTEGER NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL UNIQUE,
  "nickname" VARCHAR(50) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "created_at" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "last_seen_at" INTEGER NOT NULL,
  "revoked_at" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "kvs_positive_ids_ck" CHECK (
    "visitor_uid" >= 1000000000 AND "service_id" > 0 AND "kefu_uid" > 0
  ),
  CONSTRAINT "kvs_token_hash_ck" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "kvs_time_ck" CHECK (
    "created_at" > 0 AND "expires_at" > "created_at"
    AND "last_seen_at" >= "created_at" AND "last_seen_at" <= "expires_at"
    AND ("revoked_at" = 0 OR "revoked_at" >= "created_at")
  )
);

ALTER SEQUENCE "kefu_visitor_uid_seq" OWNED BY "kefu_visitor_session"."visitor_uid";

CREATE INDEX IF NOT EXISTS "kvs_active_expiry"
  ON "kefu_visitor_session" ("expires_at", "visitor_uid")
  WHERE "revoked_at" = 0;
CREATE INDEX IF NOT EXISTS "kvs_kefu_active"
  ON "kefu_visitor_session" ("kefu_uid", "expires_at", "visitor_uid")
  WHERE "revoked_at" = 0;

-- Transfer idempotency must bind the customer namespace as well as the numeric
-- UID because visitor and registered-user conversations are separate scopes.
ALTER TABLE "store_service_transfer"
  ADD COLUMN IF NOT EXISTS "is_tourist" SMALLINT DEFAULT 0 NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sst_is_tourist_ck'
      AND conrelid = 'store_service_transfer'::regclass
  ) THEN
    ALTER TABLE "store_service_transfer"
      ADD CONSTRAINT "sst_is_tourist_ck" CHECK ("is_tourist" IN (0, 1));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "sst_customer_scope_time"
  ON "store_service_transfer" ("customer_uid", "is_tourist", "created_at", "request_key");
