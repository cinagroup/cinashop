export const CITY_DELIVERY_CALLBACK_PIPELINE_SQL = `-- Durable, provider-authenticated same-city delivery callbacks and active reconciliation.
CREATE TABLE IF NOT EXISTS "city_delivery_callback_event" (
  "id" BIGSERIAL PRIMARY KEY,
  "provider" VARCHAR(16) DEFAULT 'dada' NOT NULL,
  "source" VARCHAR(12) NOT NULL,
  "event_key" VARCHAR(64) NOT NULL,
  "replay_key" VARCHAR(36) NOT NULL,
  "payload_hash" VARCHAR(64) NOT NULL,
  "subject_key_hash" VARCHAR(64) NOT NULL,
  "client_id" VARCHAR(64) NOT NULL,
  "provider_order_id" VARCHAR(32) NOT NULL,
  "provider_status" VARCHAR(4) NOT NULL,
  "provider_update_time" INTEGER NOT NULL,
  "repeat_reason_type" SMALLINT DEFAULT 0 NOT NULL,
  "cancel_from" SMALLINT DEFAULT 0 NOT NULL,
  "finish_code" VARCHAR(32) DEFAULT '' NOT NULL,
  "rider_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "rider_mobile" VARCHAR(32) DEFAULT '' NOT NULL,
  "reason_text" VARCHAR(255) DEFAULT '' NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(16) DEFAULT 'RECEIVED' NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "last_error_code" VARCHAR(64) DEFAULT '' NOT NULL,
  "received_time" INTEGER DEFAULT 0 NOT NULL,
  "processed_time" INTEGER DEFAULT 0 NOT NULL,
  "retain_until" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "cdcevt_provider_ck" CHECK ("provider" = 'dada'),
  CONSTRAINT "cdcevt_source_ck" CHECK ("source" IN ('callback', 'query')),
  CONSTRAINT "cdcevt_hash_key_ck" CHECK (
    "event_key" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND "subject_key_hash" ~ '^[0-9a-f]{64}$'
    AND "replay_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "cdcevt_identifier_ck" CHECK (
    btrim("client_id") <> '' AND btrim("provider_order_id") <> ''
    AND "provider_order_id" ~ '^[A-Za-z0-9._:-]{1,32}$'
    AND "provider_status" ~ '^[0-9]{1,4}$'
  ),
  CONSTRAINT "cdcevt_provider_values_ck" CHECK (
    "provider_update_time" > 0 AND "repeat_reason_type" BETWEEN 0 AND 2
    AND "cancel_from" BETWEEN 0 AND 3
  ),
  CONSTRAINT "cdcevt_payload_ck" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "cdcevt_status_ck" CHECK (
    "status" IN ('RECEIVED', 'PROCESSING', 'APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'CONFLICT', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "cdcevt_time_count_ck" CHECK (
    "attempt_count" >= 0 AND "lease_until" >= 0 AND "received_time" >= 0
    AND "processed_time" >= 0 AND "retain_until" >= "received_time" AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "cdcevt_provider_event_uq"
  ON "city_delivery_callback_event" ("provider", "event_key");
CREATE UNIQUE INDEX IF NOT EXISTS "cdcevt_replay_key_uq"
  ON "city_delivery_callback_event" ("replay_key");
CREATE INDEX IF NOT EXISTS "cdcevt_subject_order"
  ON "city_delivery_callback_event" ("provider", "subject_key_hash", "provider_update_time", "id");
CREATE INDEX IF NOT EXISTS "cdcevt_actionable_status"
  ON "city_delivery_callback_event" ("status", "update_time", "id")
  WHERE "status" IN ('RECEIVED', 'FAILED', 'DEAD');
CREATE INDEX IF NOT EXISTS "cdcevt_retention_due"
  ON "city_delivery_callback_event" ("retain_until", "id")
  WHERE "status" IN ('APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'CONFLICT', 'DEAD');

CREATE TABLE IF NOT EXISTS "city_delivery_callback_outbox" (
  "id" BIGSERIAL PRIMARY KEY,
  "event_id" BIGINT NOT NULL,
  "replay_key" VARCHAR(36) NOT NULL,
  "status" VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
  "dispatch_count" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "available_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "last_error_code" VARCHAR(64) DEFAULT '' NOT NULL,
  "enqueued_time" INTEGER DEFAULT 0 NOT NULL,
  "processed_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "cdcout_event_fk" FOREIGN KEY ("event_id")
    REFERENCES "city_delivery_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "cdcout_replay_key_ck" CHECK (
    "replay_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "cdcout_status_ck" CHECK (
    "status" IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "cdcout_time_count_ck" CHECK (
    "dispatch_count" >= 0 AND "attempt_count" >= 0 AND "available_time" >= 0
    AND "lease_until" >= 0 AND "enqueued_time" >= 0 AND "processed_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "cdcout_event_uq"
  ON "city_delivery_callback_outbox" ("event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cdcout_replay_key_uq"
  ON "city_delivery_callback_outbox" ("replay_key");
CREATE INDEX IF NOT EXISTS "cdcout_dispatch_ready"
  ON "city_delivery_callback_outbox" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS "cdcout_expired_lease"
  ON "city_delivery_callback_outbox" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING');

CREATE TABLE IF NOT EXISTS "city_delivery_callback_watermark" (
  "provider" VARCHAR(16) DEFAULT 'dada' NOT NULL,
  "subject_key_hash" VARCHAR(64) NOT NULL,
  "last_event_id" BIGINT NOT NULL,
  "last_event_key" VARCHAR(64) NOT NULL,
  "last_state" VARCHAR(32) NOT NULL,
  "last_rank" INTEGER DEFAULT 0 NOT NULL,
  "provider_update_time" INTEGER DEFAULT 0 NOT NULL,
  "terminal" SMALLINT DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "cdcwm_pkey" PRIMARY KEY ("provider", "subject_key_hash"),
  CONSTRAINT "cdcwm_event_fk" FOREIGN KEY ("last_event_id")
    REFERENCES "city_delivery_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "cdcwm_provider_ck" CHECK ("provider" = 'dada'),
  CONSTRAINT "cdcwm_state_ck" CHECK (
    "last_state" IN (
      'WAITING_ACCEPT', 'APPENDED_WAITING', 'WAITING_PICKUP', 'RIDER_AT_STORE',
      'DELIVERING', 'DELIVERED', 'CANCELLED', 'RETURNING', 'RETURNED',
      'AFTERSALE_RETURNED', 'ORDER_FAILED', 'UNKNOWN'
    )
  ),
  CONSTRAINT "cdcwm_hash_rank_ck" CHECK (
    "subject_key_hash" ~ '^[0-9a-f]{64}$' AND "last_event_key" ~ '^[0-9a-f]{64}$'
    AND "last_rank" >= 0 AND "provider_update_time" > 0
    AND "terminal" IN (0, 1) AND "update_time" >= 0
  )
);

CREATE INDEX IF NOT EXISTS "cdcwm_last_event"
  ON "city_delivery_callback_watermark" ("last_event_id");

CREATE TABLE IF NOT EXISTS "city_delivery_reconciliation_case" (
  "id" BIGSERIAL PRIMARY KEY,
  "provider" VARCHAR(16) DEFAULT 'dada' NOT NULL,
  "subject_key_hash" VARCHAR(64) NOT NULL,
  "delivery_order_id" INTEGER NOT NULL,
  "status" VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "next_attempt_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "last_event_id" BIGINT,
  "last_error_code" VARCHAR(64) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "resolved_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "cdcrc_delivery_order_fk" FOREIGN KEY ("delivery_order_id")
    REFERENCES "store_delivery_order" ("id") ON DELETE RESTRICT,
  CONSTRAINT "cdcrc_event_fk" FOREIGN KEY ("last_event_id")
    REFERENCES "city_delivery_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "cdcrc_provider_ck" CHECK ("provider" = 'dada'),
  CONSTRAINT "cdcrc_status_ck" CHECK ("status" IN ('PENDING', 'QUERYING', 'RESOLVED', 'DEAD')),
  CONSTRAINT "cdcrc_hash_time_ck" CHECK (
    "subject_key_hash" ~ '^[0-9a-f]{64}$' AND "attempt_count" >= 0
    AND "next_attempt_time" >= 0 AND "lease_until" >= 0 AND "add_time" >= 0
    AND "update_time" >= 0 AND "resolved_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "cdcrc_provider_subject_uq"
  ON "city_delivery_reconciliation_case" ("provider", "subject_key_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "cdcrc_delivery_order_uq"
  ON "city_delivery_reconciliation_case" ("delivery_order_id");
CREATE INDEX IF NOT EXISTS "cdcrc_due"
  ON "city_delivery_reconciliation_case" ("next_attempt_time", "id")
  WHERE "status" = 'PENDING';
CREATE INDEX IF NOT EXISTS "cdcrc_expired_lease"
  ON "city_delivery_reconciliation_case" ("lease_until", "id")
  WHERE "status" = 'QUERYING';
CREATE INDEX IF NOT EXISTS "cdcrc_last_event"
  ON "city_delivery_reconciliation_case" ("last_event_id");

CREATE INDEX IF NOT EXISTS "sdo_dada_reconcile_scan"
  ON "store_delivery_order" ("station_type", "status", "id");

DO $city_delivery_callback_verify$
DECLARE
  relation_shapes text[];
  constraint_names text[];
  index_names text[];
BEGIN
  SELECT array_agg(c.relname || ':' || c.relkind::text || ':' || c.relpersistence::text ORDER BY c.relname)
  INTO relation_shapes
  FROM pg_class AS c
  WHERE c.oid IN (
    to_regclass('city_delivery_callback_event'),
    to_regclass('city_delivery_callback_outbox'),
    to_regclass('city_delivery_callback_watermark'),
    to_regclass('city_delivery_reconciliation_case')
  );
  IF relation_shapes IS DISTINCT FROM ARRAY[
    'city_delivery_callback_event:r:p', 'city_delivery_callback_outbox:r:p',
    'city_delivery_callback_watermark:r:p', 'city_delivery_reconciliation_case:r:p'
  ]::text[] THEN
    RAISE EXCEPTION '0130 city delivery callback relation verification failed';
  END IF;

  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'city_delivery_callback_event'::regclass AND attnum > 0 AND NOT attisdropped) <> 27
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid = 'city_delivery_callback_outbox'::regclass AND attnum > 0 AND NOT attisdropped) <> 14
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid = 'city_delivery_callback_watermark'::regclass AND attnum > 0 AND NOT attisdropped) <> 9
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid = 'city_delivery_reconciliation_case'::regclass AND attnum > 0 AND NOT attisdropped) <> 14 THEN
    RAISE EXCEPTION '0130 city delivery callback column count verification failed';
  END IF;

  SELECT array_agg(conname::text ORDER BY conname) INTO constraint_names
  FROM pg_constraint
  WHERE conrelid IN (
    'city_delivery_callback_event'::regclass,
    'city_delivery_callback_outbox'::regclass,
    'city_delivery_callback_watermark'::regclass,
    'city_delivery_reconciliation_case'::regclass
  );
  IF constraint_names IS DISTINCT FROM ARRAY[
    'cdcevt_hash_key_ck', 'cdcevt_identifier_ck', 'cdcevt_payload_ck', 'cdcevt_provider_ck',
    'cdcevt_provider_values_ck', 'cdcevt_source_ck', 'cdcevt_status_ck', 'cdcevt_time_count_ck',
    'cdcout_event_fk', 'cdcout_replay_key_ck', 'cdcout_status_ck', 'cdcout_time_count_ck',
    'cdcrc_delivery_order_fk', 'cdcrc_event_fk', 'cdcrc_hash_time_ck', 'cdcrc_provider_ck',
    'cdcrc_status_ck',
    'cdcwm_event_fk', 'cdcwm_hash_rank_ck', 'cdcwm_pkey', 'cdcwm_provider_ck', 'cdcwm_state_ck',
    'city_delivery_callback_event_pkey', 'city_delivery_callback_outbox_pkey',
    'city_delivery_reconciliation_case_pkey'
  ]::text[] THEN
    RAISE EXCEPTION '0130 city delivery callback constraint verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid IN (
      'city_delivery_callback_event'::regclass,
      'city_delivery_callback_outbox'::regclass,
      'city_delivery_callback_watermark'::regclass,
      'city_delivery_reconciliation_case'::regclass
    ) AND NOT convalidated
  ) OR (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid IN (
      'city_delivery_callback_event'::regclass,
      'city_delivery_callback_outbox'::regclass,
      'city_delivery_callback_watermark'::regclass,
      'city_delivery_reconciliation_case'::regclass
    ) AND contype = 'f' AND confdeltype = 'r'
  ) <> 4 THEN
    RAISE EXCEPTION '0130 city delivery callback constraint integrity verification failed';
  END IF;

  SELECT array_agg(index_relation.relname::text ORDER BY index_relation.relname) INTO index_names
  FROM pg_index AS index_row
  JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
  WHERE index_row.indrelid IN (
    'city_delivery_callback_event'::regclass,
    'city_delivery_callback_outbox'::regclass,
    'city_delivery_callback_watermark'::regclass,
    'city_delivery_reconciliation_case'::regclass
  );
  IF index_names IS DISTINCT FROM ARRAY[
    'cdcevt_actionable_status', 'cdcevt_provider_event_uq', 'cdcevt_replay_key_uq',
    'cdcevt_retention_due', 'cdcevt_subject_order', 'cdcout_dispatch_ready',
    'cdcout_event_uq', 'cdcout_expired_lease', 'cdcout_replay_key_uq',
    'cdcrc_delivery_order_uq', 'cdcrc_due', 'cdcrc_expired_lease', 'cdcrc_last_event',
    'cdcrc_provider_subject_uq', 'cdcwm_last_event', 'cdcwm_pkey',
    'city_delivery_callback_event_pkey', 'city_delivery_callback_outbox_pkey',
    'city_delivery_reconciliation_case_pkey'
  ]::text[] THEN
    RAISE EXCEPTION '0130 city delivery callback index verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    WHERE index_row.indrelid IN (
      'city_delivery_callback_event'::regclass,
      'city_delivery_callback_outbox'::regclass,
      'city_delivery_callback_watermark'::regclass,
      'city_delivery_reconciliation_case'::regclass
    ) AND (NOT index_row.indisvalid OR NOT index_row.indisready)
  ) OR to_regclass('sdo_dada_reconcile_scan') IS NULL THEN
    RAISE EXCEPTION '0130 city delivery callback index integrity verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class AS c
    WHERE c.oid IN (
      'city_delivery_callback_event'::regclass,
      'city_delivery_callback_outbox'::regclass,
      'city_delivery_callback_watermark'::regclass,
      'city_delivery_reconciliation_case'::regclass
    ) AND (c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules)
  ) OR EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid IN (
      'city_delivery_callback_event'::regclass,
      'city_delivery_callback_outbox'::regclass,
      'city_delivery_callback_watermark'::regclass,
      'city_delivery_reconciliation_case'::regclass
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid IN (
      'city_delivery_callback_event'::regclass,
      'city_delivery_callback_outbox'::regclass,
      'city_delivery_callback_watermark'::regclass,
      'city_delivery_reconciliation_case'::regclass
    ) AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0130 city delivery callback authority surface verification failed';
  END IF;
END
$city_delivery_callback_verify$;
`;
