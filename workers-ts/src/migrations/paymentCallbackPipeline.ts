export const PAYMENT_CALLBACK_PIPELINE_SQL = `-- Durable, content-minimized ingress for provider-verified payment callbacks.
-- Signature headers, raw forms, decrypted provider payloads and payer data are
-- deliberately excluded. Queue messages carry only event_id + replay_key.
CREATE TABLE IF NOT EXISTS "payment_callback_event" (
  "id" BIGSERIAL PRIMARY KEY,
  "provider" VARCHAR(16) NOT NULL,
  "profile" VARCHAR(16) NOT NULL,
  "provider_event_id" VARCHAR(128) NOT NULL,
  "replay_key" VARCHAR(36) NOT NULL,
  "payload_hash" VARCHAR(64) NOT NULL,
  "order_no" VARCHAR(64) NOT NULL,
  "transaction_id" VARCHAR(100) NOT NULL,
  "trade_state" VARCHAR(32) NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "provider_event_time" INTEGER DEFAULT 0 NOT NULL,
  "order_domain" VARCHAR(16) DEFAULT '' NOT NULL,
  "status" VARCHAR(16) DEFAULT 'RECEIVED' NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "last_error_code" VARCHAR(64) DEFAULT '' NOT NULL,
  "received_time" INTEGER DEFAULT 0 NOT NULL,
  "processed_time" INTEGER DEFAULT 0 NOT NULL,
  "retain_until" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "pce_provider_profile_ck" CHECK (
    ("provider" = 'alipay' AND "profile" = 'alipay')
    OR ("provider" = 'wechat' AND "profile" IN ('wechat', 'routine', 'app'))
  ),
  CONSTRAINT "pce_replay_hash_ck" CHECK (
    "replay_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "payload_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "pce_business_ck" CHECK (
    length("provider_event_id") > 0 AND length("order_no") > 0
    AND length("transaction_id") > 0 AND length("trade_state") > 0
    AND "amount_cents" > 0 AND "currency" = 'CNY'
  ),
  CONSTRAINT "pce_order_domain_ck" CHECK (
    "order_domain" IN ('', 'store_order', 'recharge', 'membership')
  ),
  CONSTRAINT "pce_status_ck" CHECK (
    "status" IN ('RECEIVED', 'PROCESSING', 'COMPLETED', 'IGNORED', 'UNKNOWN', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "pce_time_count_ck" CHECK (
    "provider_event_time" >= 0 AND "attempt_count" >= 0 AND "lease_until" >= 0
    AND "received_time" >= 0 AND "processed_time" >= 0
    AND "retain_until" >= "received_time" AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pce_provider_event_uq"
  ON "payment_callback_event" ("provider", "provider_event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pce_replay_key_uq"
  ON "payment_callback_event" ("replay_key");
CREATE INDEX IF NOT EXISTS "pce_provider_transaction"
  ON "payment_callback_event" ("provider", "transaction_id", "id");
CREATE INDEX IF NOT EXISTS "pce_actionable_status"
  ON "payment_callback_event" ("status", "update_time", "id")
  WHERE "status" IN ('RECEIVED', 'FAILED', 'UNKNOWN', 'DEAD');
CREATE INDEX IF NOT EXISTS "pce_retention_due"
  ON "payment_callback_event" ("retain_until", "id")
  WHERE "status" IN ('COMPLETED', 'IGNORED', 'UNKNOWN', 'DEAD');

CREATE TABLE IF NOT EXISTS "payment_callback_outbox" (
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
  CONSTRAINT "pco_event_fk" FOREIGN KEY ("event_id")
    REFERENCES "payment_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "pco_replay_key_ck" CHECK (
    "replay_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "pco_status_ck" CHECK (
    "status" IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "pco_time_count_ck" CHECK (
    "dispatch_count" >= 0 AND "attempt_count" >= 0 AND "available_time" >= 0
    AND "lease_until" >= 0 AND "enqueued_time" >= 0 AND "processed_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pco_event_uq"
  ON "payment_callback_outbox" ("event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pco_replay_key_uq"
  ON "payment_callback_outbox" ("replay_key");
CREATE INDEX IF NOT EXISTS "pco_dispatch_ready"
  ON "payment_callback_outbox" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS "pco_expired_lease"
  ON "payment_callback_outbox" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING');

DO $payment_callback_pipeline_verify$
DECLARE
  actual text[];
BEGIN
  SELECT array_agg(
    relation.relname || ':' || relation.relkind::text || ':' || relation.relpersistence::text
    ORDER BY relation.relname
  )
  INTO actual
  FROM pg_class AS relation
  WHERE relation.oid IN (
    to_regclass('payment_callback_event'),
    to_regclass('payment_callback_outbox')
  );
  IF actual IS DISTINCT FROM ARRAY[
    'payment_callback_event:r:p',
    'payment_callback_outbox:r:p'
  ]::text[] THEN
    RAISE EXCEPTION '0126 payment callback relation shape verification failed';
  END IF;

  SELECT array_agg(
    relation.relname || ':' || attribute.attname || ':'
      || format_type(attribute.atttypid, attribute.atttypmod) || ':'
      || attribute.attnotnull::text || ':' || attribute.atthasdef::text
    ORDER BY relation.relname, attribute.attnum
  )
  INTO actual
  FROM pg_class AS relation
  JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
  WHERE relation.oid IN (
      'payment_callback_event'::regclass,
      'payment_callback_outbox'::regclass
    )
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF actual IS DISTINCT FROM ARRAY[
    'payment_callback_event:id:bigint:true:true',
    'payment_callback_event:provider:character varying(16):true:false',
    'payment_callback_event:profile:character varying(16):true:false',
    'payment_callback_event:provider_event_id:character varying(128):true:false',
    'payment_callback_event:replay_key:character varying(36):true:false',
    'payment_callback_event:payload_hash:character varying(64):true:false',
    'payment_callback_event:order_no:character varying(64):true:false',
    'payment_callback_event:transaction_id:character varying(100):true:false',
    'payment_callback_event:trade_state:character varying(32):true:false',
    'payment_callback_event:amount_cents:integer:true:false',
    'payment_callback_event:currency:character varying(3):true:false',
    'payment_callback_event:provider_event_time:integer:true:true',
    'payment_callback_event:order_domain:character varying(16):true:true',
    'payment_callback_event:status:character varying(16):true:true',
    'payment_callback_event:attempt_count:integer:true:true',
    'payment_callback_event:lease_until:integer:true:true',
    'payment_callback_event:lease_token:character varying(36):true:true',
    'payment_callback_event:last_error_code:character varying(64):true:true',
    'payment_callback_event:received_time:integer:true:true',
    'payment_callback_event:processed_time:integer:true:true',
    'payment_callback_event:retain_until:integer:true:true',
    'payment_callback_event:update_time:integer:true:true',
    'payment_callback_outbox:id:bigint:true:true',
    'payment_callback_outbox:event_id:bigint:true:false',
    'payment_callback_outbox:replay_key:character varying(36):true:false',
    'payment_callback_outbox:status:character varying(16):true:true',
    'payment_callback_outbox:dispatch_count:integer:true:true',
    'payment_callback_outbox:attempt_count:integer:true:true',
    'payment_callback_outbox:available_time:integer:true:true',
    'payment_callback_outbox:lease_until:integer:true:true',
    'payment_callback_outbox:lease_token:character varying(36):true:true',
    'payment_callback_outbox:last_error_code:character varying(64):true:true',
    'payment_callback_outbox:enqueued_time:integer:true:true',
    'payment_callback_outbox:processed_time:integer:true:true',
    'payment_callback_outbox:add_time:integer:true:true',
    'payment_callback_outbox:update_time:integer:true:true'
  ]::text[] THEN
    RAISE EXCEPTION '0126 payment callback column shape verification failed';
  END IF;

  SELECT array_agg(constraint_row.conname::text ORDER BY constraint_row.conname)
  INTO actual
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid IN (
    'payment_callback_event'::regclass,
    'payment_callback_outbox'::regclass
  );
  IF actual IS DISTINCT FROM ARRAY[
    'payment_callback_event_pkey',
    'payment_callback_outbox_pkey',
    'pce_business_ck',
    'pce_order_domain_ck',
    'pce_provider_profile_ck',
    'pce_replay_hash_ck',
    'pce_status_ck',
    'pce_time_count_ck',
    'pco_event_fk',
    'pco_replay_key_ck',
    'pco_status_ck',
    'pco_time_count_ck'
  ]::text[] THEN
    RAISE EXCEPTION '0126 payment callback constraint set verification failed';
  END IF;

  SELECT array_agg(index_relation.relname::text ORDER BY index_relation.relname)
  INTO actual
  FROM pg_index AS index_row
  JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
  WHERE index_row.indrelid IN (
    'payment_callback_event'::regclass,
    'payment_callback_outbox'::regclass
  );
  IF actual IS DISTINCT FROM ARRAY[
    'payment_callback_event_pkey',
    'payment_callback_outbox_pkey',
    'pce_actionable_status',
    'pce_provider_event_uq',
    'pce_provider_transaction',
    'pce_replay_key_uq',
    'pce_retention_due',
    'pco_dispatch_ready',
    'pco_event_uq',
    'pco_expired_lease',
    'pco_replay_key_uq'
  ]::text[] THEN
    RAISE EXCEPTION '0126 payment callback index set verification failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'payment_callback_event'::regclass,
      'payment_callback_outbox'::regclass
    )
      AND (
        NOT constraint_row.convalidated
        OR (constraint_row.contype = 'c' AND constraint_row.connoinherit)
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'payment_callback_outbox'::regclass
      AND constraint_row.conname = 'pco_event_fk'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'payment_callback_event'::regclass
      AND constraint_row.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION '0126 payment callback constraint integrity verification failed';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname IN (
      'payment_callback_event_pkey',
      'payment_callback_outbox_pkey',
      'pce_provider_event_uq',
      'pce_replay_key_uq',
      'pco_event_uq',
      'pco_replay_key_uq'
    )
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
  ) <> 6 OR (
    SELECT count(*)
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname IN (
      'pce_actionable_status',
      'pce_retention_due',
      'pco_dispatch_ready',
      'pco_expired_lease'
    )
      AND index_row.indpred IS NOT NULL
      AND index_row.indisvalid
      AND index_row.indisready
  ) <> 4 THEN
    RAISE EXCEPTION '0126 payment callback index integrity verification failed';
  END IF;
END
$payment_callback_pipeline_verify$;
`;
