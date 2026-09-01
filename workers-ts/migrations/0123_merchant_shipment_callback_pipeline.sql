-- Signature-verified Kuaidi100 merchant-shipment callback inbox, durable
-- Queue outbox and state/meta watermarks. Raw form bodies, signatures, courier
-- PII, fee details and image payloads are deliberately never persisted.
CREATE TABLE IF NOT EXISTS "merchant_shipment_callback_event" (
  "id" BIGSERIAL PRIMARY KEY,
  "provider" VARCHAR(24) DEFAULT 'kuaidi100' NOT NULL,
  "event_key" VARCHAR(64) NOT NULL,
  "replay_key" VARCHAR(36) NOT NULL,
  "payload_hash" VARCHAR(64) NOT NULL,
  "subject_key_hash" VARCHAR(64) NOT NULL,
  "task_id" VARCHAR(128) NOT NULL,
  "provider_order_id" VARCHAR(128) DEFAULT '' NOT NULL,
  "carrier_code" VARCHAR(50) DEFAULT '' NOT NULL,
  "tracking_number" VARCHAR(64) DEFAULT '' NOT NULL,
  "callback_status" VARCHAR(16) DEFAULT '' NOT NULL,
  "order_status" VARCHAR(16) DEFAULT '' NOT NULL,
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
  CONSTRAINT "mscevt_provider_ck" CHECK ("provider" = 'kuaidi100'),
  CONSTRAINT "mscevt_hash_key_ck" CHECK (
    "event_key" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND "subject_key_hash" ~ '^[0-9a-f]{64}$'
    AND "replay_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "mscevt_identifier_ck" CHECK (
    btrim("task_id") <> '' AND "task_id" !~ '[[:cntrl:]]'
    AND "provider_order_id" !~ '[[:cntrl:]]' AND "carrier_code" !~ '[[:cntrl:]]'
    AND "tracking_number" !~ '[[:cntrl:]]'
    AND "callback_status" ~ '^[0-9]{1,3}$' AND "order_status" ~ '^[0-9]{1,3}$'
  ),
  CONSTRAINT "mscevt_payload_ck" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "mscevt_status_ck" CHECK (
    "status" IN ('RECEIVED', 'PROCESSING', 'APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'CONFLICT', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "mscevt_time_count_ck" CHECK (
    "attempt_count" >= 0 AND "lease_until" >= 0 AND "received_time" >= 0
    AND "processed_time" >= 0 AND "retain_until" >= "received_time" AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "mscevt_provider_event_uq"
  ON "merchant_shipment_callback_event" ("provider", "event_key");
CREATE UNIQUE INDEX IF NOT EXISTS "mscevt_replay_key_uq"
  ON "merchant_shipment_callback_event" ("replay_key");
CREATE INDEX IF NOT EXISTS "mscevt_subject_order"
  ON "merchant_shipment_callback_event" ("provider", "subject_key_hash", "id");
CREATE INDEX IF NOT EXISTS "mscevt_actionable_status"
  ON "merchant_shipment_callback_event" ("status", "update_time", "id")
  WHERE "status" IN ('RECEIVED', 'FAILED', 'DEAD');
CREATE INDEX IF NOT EXISTS "mscevt_retention_due"
  ON "merchant_shipment_callback_event" ("retain_until", "id")
  WHERE "status" IN ('APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'CONFLICT', 'DEAD');

CREATE TABLE IF NOT EXISTS "merchant_shipment_callback_outbox" (
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
  CONSTRAINT "mscout_event_fk" FOREIGN KEY ("event_id")
    REFERENCES "merchant_shipment_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "mscout_replay_key_ck" CHECK (
    "replay_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "mscout_status_ck" CHECK (
    "status" IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "mscout_time_count_ck" CHECK (
    "dispatch_count" >= 0 AND "attempt_count" >= 0 AND "available_time" >= 0
    AND "lease_until" >= 0 AND "enqueued_time" >= 0 AND "processed_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "mscout_event_uq"
  ON "merchant_shipment_callback_outbox" ("event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "mscout_replay_key_uq"
  ON "merchant_shipment_callback_outbox" ("replay_key");
CREATE INDEX IF NOT EXISTS "mscout_dispatch_ready"
  ON "merchant_shipment_callback_outbox" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS "mscout_expired_lease"
  ON "merchant_shipment_callback_outbox" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING');

CREATE TABLE IF NOT EXISTS "merchant_shipment_callback_watermark" (
  "provider" VARCHAR(24) DEFAULT 'kuaidi100' NOT NULL,
  "projection_type" VARCHAR(16) NOT NULL,
  "subject_key_hash" VARCHAR(64) NOT NULL,
  "last_event_id" BIGINT NOT NULL,
  "last_event_key" VARCHAR(64) NOT NULL,
  "last_state" VARCHAR(32) NOT NULL,
  "last_rank" INTEGER DEFAULT 0 NOT NULL,
  "terminal" SMALLINT DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "mscwm_pkey" PRIMARY KEY ("provider", "projection_type", "subject_key_hash"),
  CONSTRAINT "mscwm_event_fk" FOREIGN KEY ("last_event_id")
    REFERENCES "merchant_shipment_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "mscwm_provider_ck" CHECK ("provider" = 'kuaidi100'),
  CONSTRAINT "mscwm_projection_ck" CHECK (
    "projection_type" IN ('order_state', 'metadata', 'ignored')
  ),
  CONSTRAINT "mscwm_state_ck" CHECK (
    "last_state" IN (
      'ORDER_CREATED', 'ACCEPTED', 'COLLECTING', 'PICKED_UP', 'IN_TRANSIT',
      'DELIVERING', 'SIGNED', 'ABNORMAL_SIGNED', 'SETTLED', 'REASSIGNED',
      'CANCEL_REQUESTED', 'CANCELLED',
      'PICKUP_FAILED', 'ORDER_FAILED', 'RESURRECTED', 'LABEL_CREATED',
      'LABEL_FAILED', 'WEIGHT_CHANGED', 'UNKNOWN'
    )
  ),
  CONSTRAINT "mscwm_hash_rank_ck" CHECK (
    "subject_key_hash" ~ '^[0-9a-f]{64}$' AND "last_event_key" ~ '^[0-9a-f]{64}$'
    AND "last_rank" >= 0 AND "terminal" IN (0, 1) AND "update_time" >= 0
  )
);

DO $merchant_shipment_callback_state_upgrade$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'merchant_shipment_callback_watermark'::regclass
      AND constraint_row.conname = 'mscwm_state_ck'
      AND strpos(pg_get_constraintdef(constraint_row.oid), 'SETTLED') > 0
      AND strpos(pg_get_constraintdef(constraint_row.oid), 'REASSIGNED') > 0
  ) THEN
    ALTER TABLE "merchant_shipment_callback_watermark"
      DROP CONSTRAINT IF EXISTS "mscwm_state_ck";
    ALTER TABLE "merchant_shipment_callback_watermark"
      ADD CONSTRAINT "mscwm_state_ck" CHECK (
        "last_state" IN (
          'ORDER_CREATED', 'ACCEPTED', 'COLLECTING', 'PICKED_UP', 'IN_TRANSIT',
          'DELIVERING', 'SIGNED', 'ABNORMAL_SIGNED', 'SETTLED', 'REASSIGNED',
          'CANCEL_REQUESTED', 'CANCELLED', 'PICKUP_FAILED', 'ORDER_FAILED',
          'RESURRECTED', 'LABEL_CREATED', 'LABEL_FAILED', 'WEIGHT_CHANGED', 'UNKNOWN'
        )
      );
  END IF;
END
$merchant_shipment_callback_state_upgrade$;

CREATE INDEX IF NOT EXISTS "mscwm_last_event"
  ON "merchant_shipment_callback_watermark" ("last_event_id");

DO $merchant_shipment_callback_verify$
DECLARE
  actual text[];
BEGIN
  SELECT array_agg(
    relation.relname || ':' || relation.relkind::text || ':' || relation.relpersistence::text
    ORDER BY relation.relname
  ) INTO actual
  FROM pg_class AS relation
  WHERE relation.oid IN (
    to_regclass('merchant_shipment_callback_event'),
    to_regclass('merchant_shipment_callback_outbox'),
    to_regclass('merchant_shipment_callback_watermark')
  );
  IF actual IS DISTINCT FROM ARRAY[
    'merchant_shipment_callback_event:r:p',
    'merchant_shipment_callback_outbox:r:p',
    'merchant_shipment_callback_watermark:r:p'
  ]::text[] THEN
    RAISE EXCEPTION '0129 merchant shipment callback relation shape verification failed';
  END IF;

  SELECT array_agg(
    relation.relname || ':' || attribute.attname || ':'
      || format_type(attribute.atttypid, attribute.atttypmod) || ':'
      || attribute.attnotnull::text || ':' || attribute.atthasdef::text
    ORDER BY relation.relname, attribute.attnum
  ) INTO actual
  FROM pg_class AS relation
  JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
  WHERE relation.oid IN (
      'merchant_shipment_callback_event'::regclass,
      'merchant_shipment_callback_outbox'::regclass,
      'merchant_shipment_callback_watermark'::regclass
    )
    AND attribute.attnum > 0 AND NOT attribute.attisdropped;
  IF actual IS DISTINCT FROM ARRAY[
    'merchant_shipment_callback_event:id:bigint:true:true',
    'merchant_shipment_callback_event:provider:character varying(24):true:true',
    'merchant_shipment_callback_event:event_key:character varying(64):true:false',
    'merchant_shipment_callback_event:replay_key:character varying(36):true:false',
    'merchant_shipment_callback_event:payload_hash:character varying(64):true:false',
    'merchant_shipment_callback_event:subject_key_hash:character varying(64):true:false',
    'merchant_shipment_callback_event:task_id:character varying(128):true:false',
    'merchant_shipment_callback_event:provider_order_id:character varying(128):true:true',
    'merchant_shipment_callback_event:carrier_code:character varying(50):true:true',
    'merchant_shipment_callback_event:tracking_number:character varying(64):true:true',
    'merchant_shipment_callback_event:callback_status:character varying(16):true:true',
    'merchant_shipment_callback_event:order_status:character varying(16):true:true',
    'merchant_shipment_callback_event:payload:jsonb:true:false',
    'merchant_shipment_callback_event:status:character varying(16):true:true',
    'merchant_shipment_callback_event:attempt_count:integer:true:true',
    'merchant_shipment_callback_event:lease_until:integer:true:true',
    'merchant_shipment_callback_event:lease_token:character varying(36):true:true',
    'merchant_shipment_callback_event:last_error_code:character varying(64):true:true',
    'merchant_shipment_callback_event:received_time:integer:true:true',
    'merchant_shipment_callback_event:processed_time:integer:true:true',
    'merchant_shipment_callback_event:retain_until:integer:true:true',
    'merchant_shipment_callback_event:update_time:integer:true:true',
    'merchant_shipment_callback_outbox:id:bigint:true:true',
    'merchant_shipment_callback_outbox:event_id:bigint:true:false',
    'merchant_shipment_callback_outbox:replay_key:character varying(36):true:false',
    'merchant_shipment_callback_outbox:status:character varying(16):true:true',
    'merchant_shipment_callback_outbox:dispatch_count:integer:true:true',
    'merchant_shipment_callback_outbox:attempt_count:integer:true:true',
    'merchant_shipment_callback_outbox:available_time:integer:true:true',
    'merchant_shipment_callback_outbox:lease_until:integer:true:true',
    'merchant_shipment_callback_outbox:lease_token:character varying(36):true:true',
    'merchant_shipment_callback_outbox:last_error_code:character varying(64):true:true',
    'merchant_shipment_callback_outbox:enqueued_time:integer:true:true',
    'merchant_shipment_callback_outbox:processed_time:integer:true:true',
    'merchant_shipment_callback_outbox:add_time:integer:true:true',
    'merchant_shipment_callback_outbox:update_time:integer:true:true',
    'merchant_shipment_callback_watermark:provider:character varying(24):true:true',
    'merchant_shipment_callback_watermark:projection_type:character varying(16):true:false',
    'merchant_shipment_callback_watermark:subject_key_hash:character varying(64):true:false',
    'merchant_shipment_callback_watermark:last_event_id:bigint:true:false',
    'merchant_shipment_callback_watermark:last_event_key:character varying(64):true:false',
    'merchant_shipment_callback_watermark:last_state:character varying(32):true:false',
    'merchant_shipment_callback_watermark:last_rank:integer:true:true',
    'merchant_shipment_callback_watermark:terminal:smallint:true:true',
    'merchant_shipment_callback_watermark:update_time:integer:true:true'
  ]::text[] THEN
    RAISE EXCEPTION '0129 merchant shipment callback column shape verification failed';
  END IF;

  SELECT array_agg(constraint_row.conname::text ORDER BY constraint_row.conname)
  INTO actual
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid IN (
    'merchant_shipment_callback_event'::regclass,
    'merchant_shipment_callback_outbox'::regclass,
    'merchant_shipment_callback_watermark'::regclass
  );
  IF actual IS DISTINCT FROM ARRAY[
    'merchant_shipment_callback_event_pkey',
    'merchant_shipment_callback_outbox_pkey',
    'mscevt_hash_key_ck', 'mscevt_identifier_ck', 'mscevt_payload_ck',
    'mscevt_provider_ck', 'mscevt_status_ck', 'mscevt_time_count_ck',
    'mscout_event_fk', 'mscout_replay_key_ck', 'mscout_status_ck', 'mscout_time_count_ck',
    'mscwm_event_fk', 'mscwm_hash_rank_ck', 'mscwm_pkey', 'mscwm_projection_ck',
    'mscwm_provider_ck', 'mscwm_state_ck'
  ]::text[] THEN
    RAISE EXCEPTION '0129 merchant shipment callback constraint set verification failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'merchant_shipment_callback_watermark'::regclass
      AND constraint_row.conname = 'mscwm_state_ck'
      AND strpos(pg_get_constraintdef(constraint_row.oid), 'SETTLED') > 0
      AND strpos(pg_get_constraintdef(constraint_row.oid), 'REASSIGNED') > 0
  ) THEN
    RAISE EXCEPTION '0129 merchant shipment callback state constraint verification failed';
  END IF;

  SELECT array_agg(index_relation.relname::text ORDER BY index_relation.relname)
  INTO actual
  FROM pg_index AS index_row
  JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
  WHERE index_row.indrelid IN (
    'merchant_shipment_callback_event'::regclass,
    'merchant_shipment_callback_outbox'::regclass,
    'merchant_shipment_callback_watermark'::regclass
  );
  IF actual IS DISTINCT FROM ARRAY[
    'merchant_shipment_callback_event_pkey', 'merchant_shipment_callback_outbox_pkey',
    'mscevt_actionable_status', 'mscevt_provider_event_uq', 'mscevt_replay_key_uq',
    'mscevt_retention_due', 'mscevt_subject_order', 'mscout_dispatch_ready',
    'mscout_event_uq', 'mscout_expired_lease', 'mscout_replay_key_uq',
    'mscwm_last_event', 'mscwm_pkey'
  ]::text[] THEN
    RAISE EXCEPTION '0129 merchant shipment callback index set verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'merchant_shipment_callback_event'::regclass,
      'merchant_shipment_callback_outbox'::regclass,
      'merchant_shipment_callback_watermark'::regclass
    ) AND (
      NOT constraint_row.convalidated
      OR (constraint_row.contype = 'c' AND constraint_row.connoinherit)
    )
  ) OR (
    SELECT count(*) FROM pg_constraint AS constraint_row
    WHERE constraint_row.conname IN ('mscout_event_fk', 'mscwm_event_fk')
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'merchant_shipment_callback_event'::regclass
      AND constraint_row.confdeltype = 'r'
  ) <> 2 THEN
    RAISE EXCEPTION '0129 merchant shipment callback constraint integrity verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class AS relation
    WHERE relation.oid IN (
      'merchant_shipment_callback_event'::regclass,
      'merchant_shipment_callback_outbox'::regclass,
      'merchant_shipment_callback_watermark'::regclass
    ) AND (relation.relrowsecurity OR relation.relforcerowsecurity OR relation.relhasrules)
  ) OR EXISTS (
    SELECT 1 FROM pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'merchant_shipment_callback_event'::regclass,
      'merchant_shipment_callback_outbox'::regclass,
      'merchant_shipment_callback_watermark'::regclass
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'merchant_shipment_callback_event'::regclass,
      'merchant_shipment_callback_outbox'::regclass,
      'merchant_shipment_callback_watermark'::regclass
    ) AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION '0129 merchant shipment callback authority surface verification failed';
  END IF;

  IF (
    SELECT count(*) FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname IN (
        'merchant_shipment_callback_event_pkey', 'merchant_shipment_callback_outbox_pkey',
        'mscwm_pkey', 'mscevt_provider_event_uq', 'mscevt_replay_key_uq',
        'mscout_event_uq', 'mscout_replay_key_uq'
      )
      AND index_row.indisunique AND index_row.indisvalid AND index_row.indisready
  ) <> 7 OR (
    SELECT count(*) FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname IN (
        'mscevt_actionable_status', 'mscevt_retention_due',
        'mscout_dispatch_ready', 'mscout_expired_lease'
      )
      AND index_row.indpred IS NOT NULL
      AND index_row.indisvalid AND index_row.indisready
  ) <> 4 THEN
    RAISE EXCEPTION '0129 merchant shipment callback index integrity verification failed';
  END IF;
END
$merchant_shipment_callback_verify$;
