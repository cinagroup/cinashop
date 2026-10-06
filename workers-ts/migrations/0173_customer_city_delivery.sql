-- Explicit owner maintenance only. Not part of MigrationService/runAll/startup.
CREATE TABLE IF NOT EXISTS "customer_city_delivery_job" (
  "id" bigserial NOT NULL PRIMARY KEY,
  "actor_uid" integer NOT NULL,
  "service_id" integer NOT NULL,
  "actor_auth_version" varchar(32) NOT NULL,
  "actor_expires_at" integer NOT NULL,
  "scope_key" varchar(64) NOT NULL,
  "request_key" varchar(36) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "intent_hash" varchar(64) NOT NULL,
  "requested_order_id" integer NOT NULL,
  "root_order_id" integer NOT NULL,
  "order_id" integer NOT NULL,
  "customer_uid" integer NOT NULL,
  "store_id" integer NOT NULL,
  "supplier_id" integer NOT NULL,
  "provider" varchar(8) NOT NULL,
  "provider_order_id" varchar(32) NOT NULL,
  "intent" jsonb NOT NULL,
  "status" varchar(16) DEFAULT 'PENDING' NOT NULL,
  "lease_token" varchar(36) DEFAULT '' NOT NULL,
  "lease_until" integer DEFAULT 0 NOT NULL,
  "last_error_code" varchar(64) DEFAULT '' NOT NULL,
  "add_time" integer NOT NULL,
  "update_time" integer NOT NULL,
  CONSTRAINT "ccdjob_identity_ck" CHECK ("customer_city_delivery_job"."actor_uid">0 AND "customer_city_delivery_job"."service_id">0 AND "customer_city_delivery_job"."requested_order_id">0 AND "customer_city_delivery_job"."root_order_id">0 AND "customer_city_delivery_job"."order_id">0 AND "customer_city_delivery_job"."customer_uid">0 AND "customer_city_delivery_job"."store_id">=0 AND "customer_city_delivery_job"."supplier_id">=0),
  CONSTRAINT "ccdjob_keys_ck" CHECK ("customer_city_delivery_job"."request_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND "customer_city_delivery_job"."request_hash" ~ '^[0-9a-f]{64}$' AND "customer_city_delivery_job"."intent_hash" ~ '^[0-9a-f]{64}$' AND "customer_city_delivery_job"."scope_key" ~ '^[0-9a-f]{64}$' AND "customer_city_delivery_job"."actor_auth_version" ~ '^[0-9a-f]{32}$'),
  CONSTRAINT "ccdjob_provider_ck" CHECK ("customer_city_delivery_job"."provider" IN ('dada','uu') AND "customer_city_delivery_job"."provider_order_id" ~ '^[A-Za-z0-9._:-]{1,32}$'),
  CONSTRAINT "ccdjob_status_ck" CHECK ("customer_city_delivery_job"."status" IN ('PENDING','PROCESSING','ADMITTED','UNKNOWN','REJECTED','REVOKED','CANCELLED','DELIVERED')),
  CONSTRAINT "ccdjob_intent_ck" CHECK (jsonb_typeof("customer_city_delivery_job"."intent")='object' AND octet_length("customer_city_delivery_job"."intent"::text)<=131072),
  CONSTRAINT "ccdjob_time_ck" CHECK ("customer_city_delivery_job"."actor_expires_at">0 AND "customer_city_delivery_job"."add_time">0 AND "customer_city_delivery_job"."update_time">="customer_city_delivery_job"."add_time" AND "customer_city_delivery_job"."lease_until">=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "ccdjob_actor_request_uq" ON "customer_city_delivery_job" ("actor_uid","request_key");
CREATE UNIQUE INDEX IF NOT EXISTS "ccdjob_provider_order_uq" ON "customer_city_delivery_job" ("provider","provider_order_id");
CREATE INDEX IF NOT EXISTS "ccdjob_root_status" ON "customer_city_delivery_job" ("root_order_id","status","id");
CREATE INDEX IF NOT EXISTS "ccdjob_dispatch" ON "customer_city_delivery_job" ("status","lease_until","id");
CREATE TABLE IF NOT EXISTS "customer_city_delivery_attempt" (
  "id" bigserial NOT NULL PRIMARY KEY,
  "job_id" bigint NOT NULL,
  "request_key" varchar(36) NOT NULL,
  "phase" varchar(16) NOT NULL,
  "quote" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error_code" varchar(64) DEFAULT '' NOT NULL,
  "started_time" integer NOT NULL,
  "issued_time" integer DEFAULT 0 NOT NULL,
  "update_time" integer NOT NULL,
  CONSTRAINT "ccdattempt_phase_ck" CHECK ("customer_city_delivery_attempt"."phase" IN ('QUOTING','QUOTED','ISSUING','ACCEPTED','UNKNOWN','REJECTED','REVOKED')),
  CONSTRAINT "ccdattempt_json_ck" CHECK (jsonb_typeof("customer_city_delivery_attempt"."quote")='object' AND jsonb_typeof("customer_city_delivery_attempt"."result")='object' AND octet_length("customer_city_delivery_attempt"."quote"::text)<=32768 AND octet_length("customer_city_delivery_attempt"."result"::text)<=32768),
  CONSTRAINT "ccdattempt_key_ck" CHECK ("customer_city_delivery_attempt"."request_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND "customer_city_delivery_attempt"."started_time">0 AND "customer_city_delivery_attempt"."issued_time">=0 AND "customer_city_delivery_attempt"."update_time">="customer_city_delivery_attempt"."started_time"),
  CONSTRAINT "ccdattempt_job_fk" FOREIGN KEY ("job_id") REFERENCES "customer_city_delivery_job" ("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "ccdattempt_job_uq" ON "customer_city_delivery_attempt" ("job_id");
CREATE TABLE IF NOT EXISTS "customer_city_delivery_binding" (
  "job_id" bigint NOT NULL PRIMARY KEY,
  "attempt_id" bigint NOT NULL,
  "delivery_order_id" integer NOT NULL,
  "order_id" integer NOT NULL,
  "root_order_id" integer NOT NULL,
  "customer_uid" integer NOT NULL,
  "store_id" integer NOT NULL,
  "supplier_id" integer NOT NULL,
  "provider" varchar(8) NOT NULL,
  "provider_order_id" varchar(32) NOT NULL,
  "active" smallint DEFAULT 1 NOT NULL,
  "add_time" integer NOT NULL,
  "update_time" integer NOT NULL,
  CONSTRAINT "ccdbinding_identity_ck" CHECK ("customer_city_delivery_binding"."delivery_order_id">0 AND "customer_city_delivery_binding"."order_id">0 AND "customer_city_delivery_binding"."root_order_id">0 AND "customer_city_delivery_binding"."customer_uid">0 AND "customer_city_delivery_binding"."store_id">=0 AND "customer_city_delivery_binding"."supplier_id">=0 AND "customer_city_delivery_binding"."active" IN (0,1)),
  CONSTRAINT "ccdbinding_provider_ck" CHECK ("customer_city_delivery_binding"."provider" IN ('dada','uu') AND "customer_city_delivery_binding"."provider_order_id" ~ '^[A-Za-z0-9._:-]{1,32}$' AND "customer_city_delivery_binding"."add_time">0 AND "customer_city_delivery_binding"."update_time">="customer_city_delivery_binding"."add_time"),
  CONSTRAINT "ccdbinding_job_fk" FOREIGN KEY ("job_id") REFERENCES "customer_city_delivery_job" ("id") ON DELETE RESTRICT,
  CONSTRAINT "ccdbinding_attempt_fk" FOREIGN KEY ("attempt_id") REFERENCES "customer_city_delivery_attempt" ("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "ccdbinding_delivery_uq" ON "customer_city_delivery_binding" ("delivery_order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ccdbinding_provider_uq" ON "customer_city_delivery_binding" ("provider","provider_order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ccdbinding_active_order_uq" ON "customer_city_delivery_binding" ("order_id") WHERE "customer_city_delivery_binding"."active"=1;

-- Preserve actual legacy store station columns; no station registration/provider call.
ALTER TABLE system_store ADD COLUMN IF NOT EXISTS city_shop_id VARCHAR(255) DEFAULT '' NOT NULL;
ALTER TABLE system_store ADD COLUMN IF NOT EXISTS business INTEGER DEFAULT 0 NOT NULL;
