/** Exact bundled copy of migrations/0122_wechat_callback_pipeline.sql. */
export const WECHAT_CALLBACK_PIPELINE_SQL = `-- Signature-verified official-account/mini-program callback inbox, durable
-- Queue outbox and state-projection watermark. Raw XML, signatures, arbitrary
-- provider fields and user message text are deliberately never persisted.
CREATE TABLE IF NOT EXISTS "wechat_callback_event" (
  "id" BIGSERIAL PRIMARY KEY,
  "source" VARCHAR(16) NOT NULL,
  "event_key" VARCHAR(64) NOT NULL,
  "replay_key" VARCHAR(36) NOT NULL,
  "payload_hash" VARCHAR(64) NOT NULL,
  "subject_key_hash" VARCHAR(64) NOT NULL,
  "app_id" VARCHAR(64) NOT NULL,
  "from_user" VARCHAR(128) NOT NULL,
  "msg_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "event_type" VARCHAR(64) DEFAULT '' NOT NULL,
  "event_time" INTEGER DEFAULT 0 NOT NULL,
  "sequence_rank" INTEGER DEFAULT 0 NOT NULL,
  "payload" JSONB NOT NULL,
  "reply_payload" JSONB NOT NULL,
  "status" VARCHAR(16) DEFAULT 'RECEIVED' NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "last_error_code" VARCHAR(64) DEFAULT '' NOT NULL,
  "received_time" INTEGER DEFAULT 0 NOT NULL,
  "processed_time" INTEGER DEFAULT 0 NOT NULL,
  "retain_until" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "wcevt_source_ck" CHECK ("source" IN ('official', 'mini')),
  CONSTRAINT "wcevt_hash_key_ck" CHECK (
    "event_key" ~ '^[0-9a-f]{64}$' AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND "subject_key_hash" ~ '^[0-9a-f]{64}$'
    AND "replay_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "wcevt_payload_ck" CHECK (
    jsonb_typeof("payload") = 'object' AND jsonb_typeof("reply_payload") = 'object'
  ),
  CONSTRAINT "wcevt_status_ck" CHECK (
    "status" IN ('RECEIVED', 'PROCESSING', 'APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "wcevt_time_count_ck" CHECK (
    "event_time" > 0 AND "sequence_rank" >= 0 AND "attempt_count" >= 0
    AND "lease_until" >= 0 AND "received_time" >= 0 AND "processed_time" >= 0
    AND "retain_until" >= "received_time" AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "wcevt_source_event_uq"
  ON "wechat_callback_event" ("source", "event_key");
CREATE UNIQUE INDEX IF NOT EXISTS "wcevt_replay_key_uq"
  ON "wechat_callback_event" ("replay_key");
CREATE INDEX IF NOT EXISTS "wcevt_subject_order"
  ON "wechat_callback_event" ("source", "subject_key_hash", "event_time", "sequence_rank", "id");
CREATE INDEX IF NOT EXISTS "wcevt_actionable_status"
  ON "wechat_callback_event" ("status", "update_time", "id")
  WHERE "status" IN ('RECEIVED', 'FAILED', 'DEAD');
CREATE INDEX IF NOT EXISTS "wcevt_retention_due"
  ON "wechat_callback_event" ("retain_until", "id")
  WHERE "status" IN ('APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED', 'DEAD');

CREATE TABLE IF NOT EXISTS "wechat_callback_outbox" (
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
  CONSTRAINT "wcout_event_fk" FOREIGN KEY ("event_id")
    REFERENCES "wechat_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "wcout_replay_key_ck" CHECK (
    "replay_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "wcout_status_ck" CHECK (
    "status" IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "wcout_time_count_ck" CHECK (
    "dispatch_count" >= 0 AND "attempt_count" >= 0 AND "available_time" >= 0
    AND "lease_until" >= 0 AND "enqueued_time" >= 0 AND "processed_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "wcout_event_uq"
  ON "wechat_callback_outbox" ("event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "wcout_replay_key_uq"
  ON "wechat_callback_outbox" ("replay_key");
CREATE INDEX IF NOT EXISTS "wcout_dispatch_ready"
  ON "wechat_callback_outbox" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS "wcout_expired_lease"
  ON "wechat_callback_outbox" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING');

CREATE TABLE IF NOT EXISTS "wechat_callback_watermark" (
  "source" VARCHAR(16) NOT NULL,
  "projection_type" VARCHAR(32) NOT NULL,
  "subject_key_hash" VARCHAR(64) NOT NULL,
  "last_event_id" BIGINT NOT NULL,
  "last_event_key" VARCHAR(64) NOT NULL,
  "last_event_time" INTEGER DEFAULT 0 NOT NULL,
  "last_sequence_rank" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "wcwm_pkey" PRIMARY KEY ("source", "projection_type", "subject_key_hash"),
  CONSTRAINT "wcwm_event_fk" FOREIGN KEY ("last_event_id")
    REFERENCES "wechat_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "wcwm_source_ck" CHECK ("source" IN ('official', 'mini')),
  CONSTRAINT "wcwm_projection_ck" CHECK (
    "projection_type" IN ('follow', 'scan', 'card', 'payment', 'receipt', 'message', 'ignored')
  ),
  CONSTRAINT "wcwm_hash_time_ck" CHECK (
    "subject_key_hash" ~ '^[0-9a-f]{64}$' AND "last_event_key" ~ '^[0-9a-f]{64}$'
    AND "last_event_time" > 0 AND "last_sequence_rank" >= 0 AND "update_time" >= 0
  )
);

CREATE INDEX IF NOT EXISTS "wcwm_last_event"
  ON "wechat_callback_watermark" ("last_event_id");

DO $wechat_callback_pipeline_verify$
DECLARE
  actual text[];
BEGIN
  SELECT array_agg(
    relation.relname || ':' || relation.relkind::text || ':' || relation.relpersistence::text
    ORDER BY relation.relname
  ) INTO actual
  FROM pg_class AS relation
  WHERE relation.oid IN (
    to_regclass('wechat_callback_event'),
    to_regclass('wechat_callback_outbox'),
    to_regclass('wechat_callback_watermark')
  );
  IF actual IS DISTINCT FROM ARRAY[
    'wechat_callback_event:r:p',
    'wechat_callback_outbox:r:p',
    'wechat_callback_watermark:r:p'
  ]::text[] THEN
    RAISE EXCEPTION '0128 wechat callback relation shape verification failed';
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
      'wechat_callback_event'::regclass,
      'wechat_callback_outbox'::regclass,
      'wechat_callback_watermark'::regclass
    )
    AND attribute.attnum > 0 AND NOT attribute.attisdropped;
  IF actual IS DISTINCT FROM ARRAY[
    'wechat_callback_event:id:bigint:true:true',
    'wechat_callback_event:source:character varying(16):true:false',
    'wechat_callback_event:event_key:character varying(64):true:false',
    'wechat_callback_event:replay_key:character varying(36):true:false',
    'wechat_callback_event:payload_hash:character varying(64):true:false',
    'wechat_callback_event:subject_key_hash:character varying(64):true:false',
    'wechat_callback_event:app_id:character varying(64):true:false',
    'wechat_callback_event:from_user:character varying(128):true:false',
    'wechat_callback_event:msg_type:character varying(32):true:true',
    'wechat_callback_event:event_type:character varying(64):true:true',
    'wechat_callback_event:event_time:integer:true:true',
    'wechat_callback_event:sequence_rank:integer:true:true',
    'wechat_callback_event:payload:jsonb:true:false',
    'wechat_callback_event:reply_payload:jsonb:true:false',
    'wechat_callback_event:status:character varying(16):true:true',
    'wechat_callback_event:attempt_count:integer:true:true',
    'wechat_callback_event:lease_until:integer:true:true',
    'wechat_callback_event:lease_token:character varying(36):true:true',
    'wechat_callback_event:last_error_code:character varying(64):true:true',
    'wechat_callback_event:received_time:integer:true:true',
    'wechat_callback_event:processed_time:integer:true:true',
    'wechat_callback_event:retain_until:integer:true:true',
    'wechat_callback_event:update_time:integer:true:true',
    'wechat_callback_outbox:id:bigint:true:true',
    'wechat_callback_outbox:event_id:bigint:true:false',
    'wechat_callback_outbox:replay_key:character varying(36):true:false',
    'wechat_callback_outbox:status:character varying(16):true:true',
    'wechat_callback_outbox:dispatch_count:integer:true:true',
    'wechat_callback_outbox:attempt_count:integer:true:true',
    'wechat_callback_outbox:available_time:integer:true:true',
    'wechat_callback_outbox:lease_until:integer:true:true',
    'wechat_callback_outbox:lease_token:character varying(36):true:true',
    'wechat_callback_outbox:last_error_code:character varying(64):true:true',
    'wechat_callback_outbox:enqueued_time:integer:true:true',
    'wechat_callback_outbox:processed_time:integer:true:true',
    'wechat_callback_outbox:add_time:integer:true:true',
    'wechat_callback_outbox:update_time:integer:true:true',
    'wechat_callback_watermark:source:character varying(16):true:false',
    'wechat_callback_watermark:projection_type:character varying(32):true:false',
    'wechat_callback_watermark:subject_key_hash:character varying(64):true:false',
    'wechat_callback_watermark:last_event_id:bigint:true:false',
    'wechat_callback_watermark:last_event_key:character varying(64):true:false',
    'wechat_callback_watermark:last_event_time:integer:true:true',
    'wechat_callback_watermark:last_sequence_rank:integer:true:true',
    'wechat_callback_watermark:update_time:integer:true:true'
  ]::text[] THEN
    RAISE EXCEPTION '0128 wechat callback column shape verification failed';
  END IF;

  SELECT array_agg(constraint_row.conname::text ORDER BY constraint_row.conname)
  INTO actual
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid IN (
    'wechat_callback_event'::regclass,
    'wechat_callback_outbox'::regclass,
    'wechat_callback_watermark'::regclass
  );
  IF actual IS DISTINCT FROM ARRAY[
    'wcevt_hash_key_ck',
    'wcevt_payload_ck',
    'wcevt_source_ck',
    'wcevt_status_ck',
    'wcevt_time_count_ck',
    'wcout_event_fk',
    'wcout_replay_key_ck',
    'wcout_status_ck',
    'wcout_time_count_ck',
    'wcwm_event_fk',
    'wcwm_hash_time_ck',
    'wcwm_pkey',
    'wcwm_projection_ck',
    'wcwm_source_ck',
    'wechat_callback_event_pkey',
    'wechat_callback_outbox_pkey'
  ]::text[] THEN
    RAISE EXCEPTION '0128 wechat callback constraint set verification failed';
  END IF;

  SELECT array_agg(index_relation.relname::text ORDER BY index_relation.relname)
  INTO actual
  FROM pg_index AS index_row
  JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
  WHERE index_row.indrelid IN (
    'wechat_callback_event'::regclass,
    'wechat_callback_outbox'::regclass,
    'wechat_callback_watermark'::regclass
  );
  IF actual IS DISTINCT FROM ARRAY[
    'wcevt_actionable_status',
    'wcevt_replay_key_uq',
    'wcevt_retention_due',
    'wcevt_source_event_uq',
    'wcevt_subject_order',
    'wcout_dispatch_ready',
    'wcout_event_uq',
    'wcout_expired_lease',
    'wcout_replay_key_uq',
    'wcwm_last_event',
    'wcwm_pkey',
    'wechat_callback_event_pkey',
    'wechat_callback_outbox_pkey'
  ]::text[] THEN
    RAISE EXCEPTION '0128 wechat callback index set verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'wechat_callback_event'::regclass,
      'wechat_callback_outbox'::regclass,
      'wechat_callback_watermark'::regclass
    ) AND (
      NOT constraint_row.convalidated
      OR (constraint_row.contype = 'c' AND constraint_row.connoinherit)
    )
  ) OR (
    SELECT count(*) FROM pg_constraint AS constraint_row
    WHERE constraint_row.conname IN ('wcout_event_fk', 'wcwm_event_fk')
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'wechat_callback_event'::regclass
      AND constraint_row.confdeltype = 'r'
  ) <> 2 THEN
    RAISE EXCEPTION '0128 wechat callback constraint integrity verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class AS relation
    WHERE relation.oid IN (
      'wechat_callback_event'::regclass,
      'wechat_callback_outbox'::regclass,
      'wechat_callback_watermark'::regclass
    ) AND (relation.relrowsecurity OR relation.relforcerowsecurity OR relation.relhasrules)
  ) OR EXISTS (
    SELECT 1 FROM pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'wechat_callback_event'::regclass,
      'wechat_callback_outbox'::regclass,
      'wechat_callback_watermark'::regclass
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'wechat_callback_event'::regclass,
      'wechat_callback_outbox'::regclass,
      'wechat_callback_watermark'::regclass
    ) AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION '0128 wechat callback authority surface verification failed';
  END IF;

  IF (
    SELECT count(*) FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname IN (
        'wechat_callback_event_pkey', 'wechat_callback_outbox_pkey', 'wcwm_pkey',
        'wcevt_source_event_uq', 'wcevt_replay_key_uq',
        'wcout_event_uq', 'wcout_replay_key_uq'
      )
      AND index_row.indisunique AND index_row.indisvalid AND index_row.indisready
  ) <> 7 OR (
    SELECT count(*) FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname IN (
        'wcevt_actionable_status', 'wcevt_retention_due',
        'wcout_dispatch_ready', 'wcout_expired_lease'
      )
      AND index_row.indpred IS NOT NULL
      AND index_row.indisvalid AND index_row.indisready
  ) <> 4 THEN
    RAISE EXCEPTION '0128 wechat callback index integrity verification failed';
  END IF;
END
$wechat_callback_pipeline_verify$;
`;
