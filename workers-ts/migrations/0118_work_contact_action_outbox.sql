-- Durable post-projection actions for Enterprise WeChat external contacts.
ALTER TABLE "work_callback_event"
  ADD COLUMN IF NOT EXISTS "payload_retained_until" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "payload_redacted_time" integer NOT NULL DEFAULT 0;

UPDATE "work_callback_event"
SET "payload_retained_until" = GREATEST(
  "received_time" + 2592000,
  "processed_time" + 2592000
)
WHERE "payload_retained_until" = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_callback_event'::regclass
      AND conname = 'wce_payload_retention_ck'
  ) THEN
    ALTER TABLE "work_callback_event"
      ADD CONSTRAINT "wce_payload_retention_ck" CHECK (
        payload_retained_until >= received_time
        AND payload_redacted_time >= 0
        AND (payload_redacted_time = 0 OR payload_redacted_time >= received_time)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "wce_payload_redaction_ready"
  ON "work_callback_event" ("payload_retained_until", "id")
  WHERE "status" = 'ORDERED' AND "payload_redacted_time" = 0;

CREATE TABLE IF NOT EXISTS "work_contact_action_outbox" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL,
  "event_key" varchar(64) NOT NULL,
  "action_key" varchar(64) NOT NULL,
  "action_type" varchar(24) NOT NULL,
  "corp_id" varchar(18) NOT NULL,
  "client_id" integer NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "payload_hash" varchar(64) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "dispatch_count" integer NOT NULL DEFAULT 0,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "available_time" integer NOT NULL DEFAULT 0,
  "deadline_time" integer NOT NULL DEFAULT 0,
  "lease_until" integer NOT NULL DEFAULT 0,
  "lease_token" varchar(36) NOT NULL DEFAULT '',
  "last_error_code" varchar(64) NOT NULL DEFAULT '',
  "provider_code" integer,
  "enqueued_time" integer NOT NULL DEFAULT 0,
  "processed_time" integer NOT NULL DEFAULT 0,
  "unknown_time" integer NOT NULL DEFAULT 0,
  "add_time" integer NOT NULL DEFAULT 0,
  "update_time" integer NOT NULL DEFAULT 0,
  CONSTRAINT "wcao_event_fk" FOREIGN KEY ("event_id")
    REFERENCES "work_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "wcao_client_fk" FOREIGN KEY ("corp_id", "client_id")
    REFERENCES "work_client_current" ("corp_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "wcao_hashes_ck" CHECK (
    event_key ~ '^[0-9a-f]{64}$'
    AND action_key ~ '^[0-9a-f]{64}$'
    AND payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "wcao_identity_ck" CHECK (
    corp_id ~ '^[A-Za-z0-9_-]{1,18}$' AND client_id > 0
  ),
  CONSTRAINT "wcao_action_type_ck" CHECK (
    action_type IN ('WELCOME_SEND','AUTO_TAG','CLIENT_UID_LINK')
  ),
  CONSTRAINT "wcao_status_ck" CHECK (
    status IN (
      'PENDING','ENQUEUING','ENQUEUED','PROCESSING','RETRYABLE',
      'SUCCEEDED','SKIPPED','EXPIRED','UNKNOWN','DEAD','CLOSED'
    )
  ),
  CONSTRAINT "wcao_payload_ck" CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536
  ),
  CONSTRAINT "wcao_time_ck" CHECK (
    dispatch_count >= 0 AND attempt_count >= 0 AND available_time >= 0
    AND deadline_time >= 0 AND lease_until >= 0 AND enqueued_time >= 0
    AND processed_time >= 0 AND unknown_time >= 0
    AND add_time >= 0 AND update_time >= 0
  ),
  CONSTRAINT "wcao_welcome_deadline_ck" CHECK (
    action_type <> 'WELCOME_SEND' OR deadline_time > 0
  ),
  CONSTRAINT "wcao_lease_ck" CHECK (
    (status IN ('ENQUEUING','ENQUEUED','PROCESSING')
      AND lease_until > 0 AND lease_token <> '')
    OR (status NOT IN ('ENQUEUING','ENQUEUED','PROCESSING')
      AND lease_until = 0 AND lease_token = '')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "wcao_event_action_uq"
  ON "work_contact_action_outbox" ("event_id", "action_type");
CREATE UNIQUE INDEX IF NOT EXISTS "wcao_action_key_uq"
  ON "work_contact_action_outbox" ("action_key");
CREATE INDEX IF NOT EXISTS "wcao_dispatch_ready"
  ON "work_contact_action_outbox" ("available_time", "deadline_time", "id")
  WHERE "status" IN ('PENDING','RETRYABLE');
CREATE INDEX IF NOT EXISTS "wcao_expired_lease"
  ON "work_contact_action_outbox" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING','ENQUEUED','PROCESSING');
CREATE INDEX IF NOT EXISTS "wcao_event_status"
  ON "work_contact_action_outbox" ("event_id", "status", "id");
CREATE INDEX IF NOT EXISTS "wcao_manual_queue"
  ON "work_contact_action_outbox" ("status", "update_time", "id")
  WHERE "status" IN ('UNKNOWN','DEAD');

CREATE TABLE IF NOT EXISTS "work_contact_action_audit" (
  "id" serial PRIMARY KEY,
  "action_id" integer NOT NULL,
  "request_key" varchar(36) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "operation" varchar(24) NOT NULL,
  "from_status" varchar(16) NOT NULL,
  "to_status" varchar(16) NOT NULL,
  "actor_id" integer NOT NULL,
  "reason" varchar(500) NOT NULL,
  "risk_accepted" boolean NOT NULL DEFAULT false,
  "provider_reference_hash" varchar(64),
  "add_time" integer NOT NULL DEFAULT 0,
  CONSTRAINT "wcaa_action_fk" FOREIGN KEY ("action_id")
    REFERENCES "work_contact_action_outbox" ("id") ON DELETE RESTRICT,
  CONSTRAINT "wcaa_request_ck" CHECK (
    request_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND request_hash ~ '^[0-9a-f]{64}$'
    AND (provider_reference_hash IS NULL OR provider_reference_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "wcaa_operation_ck" CHECK (
    operation IN ('CONFIRM_SUCCEEDED','RETRY_WITH_RISK','CLOSE')
  ),
  CONSTRAINT "wcaa_status_ck" CHECK (
    from_status IN ('UNKNOWN','DEAD')
    AND to_status IN ('SUCCEEDED','RETRYABLE','CLOSED')
  ),
  CONSTRAINT "wcaa_actor_reason_ck" CHECK (
    actor_id > 0 AND char_length(btrim(reason)) BETWEEN 8 AND 500
    AND reason !~ '[[:cntrl:]]' AND add_time >= 0
  ),
  CONSTRAINT "wcaa_risk_ck" CHECK (
    operation <> 'RETRY_WITH_RISK' OR risk_accepted
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "wcaa_request_uq"
  ON "work_contact_action_audit" ("action_id", "request_key");
CREATE INDEX IF NOT EXISTS "wcaa_action_time"
  ON "work_contact_action_audit" ("action_id", "add_time", "id");

CREATE OR REPLACE FUNCTION wcao_guard_immutable_0118()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.event_key IS DISTINCT FROM OLD.event_key
    OR NEW.action_key IS DISTINCT FROM OLD.action_key
    OR NEW.action_type IS DISTINCT FROM OLD.action_type
    OR NEW.corp_id IS DISTINCT FROM OLD.corp_id
    OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.deadline_time IS DISTINCT FROM OLD.deadline_time
    OR NEW.add_time IS DISTINCT FROM OLD.add_time THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'wcao_immutable';
  END IF;
  IF NEW.payload IS DISTINCT FROM OLD.payload
    AND NOT (
      NEW.payload = '{}'::jsonb
      AND NEW.status IN ('SUCCEEDED','SKIPPED','EXPIRED','CLOSED')
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'wcao_payload_immutable';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS "wcao_guard_immutable_0118" ON "work_contact_action_outbox";
CREATE TRIGGER "wcao_guard_immutable_0118"
BEFORE UPDATE ON "work_contact_action_outbox"
FOR EACH ROW EXECUTE FUNCTION wcao_guard_immutable_0118();

CREATE OR REPLACE FUNCTION wcaa_guard_immutable_0118()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'wcaa_immutable';
END
$function$;

DROP TRIGGER IF EXISTS "wcaa_guard_immutable_0118" ON "work_contact_action_audit";
CREATE TRIGGER "wcaa_guard_immutable_0118"
BEFORE UPDATE OR DELETE ON "work_contact_action_audit"
FOR EACH ROW EXECUTE FUNCTION wcaa_guard_immutable_0118();

DO $work_contact_action_0118_verify$
DECLARE
  outbox_columns text[];
  audit_columns text[];
  outbox_constraints text[];
  audit_constraints text[];
  outbox_indexes text[];
  audit_indexes text[];
  guard_functions integer;
  guard_triggers integer;
BEGIN
  SELECT array_agg(column_name ORDER BY ordinal_position)
    INTO outbox_columns
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'work_contact_action_outbox';
  SELECT array_agg(column_name ORDER BY ordinal_position)
    INTO audit_columns
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'work_contact_action_audit';
  IF outbox_columns IS DISTINCT FROM ARRAY[
      'id','event_id','event_key','action_key','action_type','corp_id','client_id',
      'payload','payload_hash','status','dispatch_count','attempt_count','available_time',
      'deadline_time','lease_until','lease_token','last_error_code','provider_code',
      'enqueued_time','processed_time','unknown_time','add_time','update_time'
    ]::text[]
    OR audit_columns IS DISTINCT FROM ARRAY[
      'id','action_id','request_key','request_hash','operation','from_status','to_status',
      'actor_id','reason','risk_accepted','provider_reference_hash','add_time'
    ]::text[] THEN
    RAISE EXCEPTION '0118 action table column set drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'work_callback_event'
      AND column_name = 'payload_retained_until' AND data_type = 'integer'
      AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'work_callback_event'
      AND column_name = 'payload_redacted_time' AND data_type = 'integer'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '0118 callback retention column drift';
  END IF;

  SELECT array_agg(conname ORDER BY conname) INTO outbox_constraints
  FROM pg_constraint
  WHERE conrelid = 'work_contact_action_outbox'::regclass;
  SELECT array_agg(conname ORDER BY conname) INTO audit_constraints
  FROM pg_constraint
  WHERE conrelid = 'work_contact_action_audit'::regclass;
  IF outbox_constraints IS DISTINCT FROM ARRAY[
      'wcao_action_type_ck','wcao_client_fk','wcao_event_fk','wcao_hashes_ck',
      'wcao_identity_ck','wcao_lease_ck','wcao_payload_ck','wcao_status_ck',
      'wcao_time_ck','wcao_welcome_deadline_ck','work_contact_action_outbox_pkey'
    ]::text[]
    OR audit_constraints IS DISTINCT FROM ARRAY[
      'wcaa_action_fk','wcaa_actor_reason_ck','wcaa_operation_ck','wcaa_request_ck',
      'wcaa_risk_ck','wcaa_status_ck','work_contact_action_audit_pkey'
    ]::text[] THEN
    RAISE EXCEPTION '0118 action constraint set drift';
  END IF;

  SELECT array_agg(indexname ORDER BY indexname) INTO outbox_indexes
  FROM pg_indexes
  WHERE schemaname = current_schema() AND tablename = 'work_contact_action_outbox';
  SELECT array_agg(indexname ORDER BY indexname) INTO audit_indexes
  FROM pg_indexes
  WHERE schemaname = current_schema() AND tablename = 'work_contact_action_audit';
  IF outbox_indexes IS DISTINCT FROM ARRAY[
      'wcao_action_key_uq','wcao_dispatch_ready','wcao_event_action_uq',
      'wcao_event_status','wcao_expired_lease','wcao_manual_queue',
      'work_contact_action_outbox_pkey'
    ]::text[]
    OR audit_indexes IS DISTINCT FROM ARRAY[
      'wcaa_action_time','wcaa_request_uq','work_contact_action_audit_pkey'
    ]::text[] THEN
    RAISE EXCEPTION '0118 action index set drift';
  END IF;

  SELECT count(*) INTO guard_functions
  FROM pg_proc AS function_row
  JOIN pg_namespace AS namespace ON namespace.oid = function_row.pronamespace
  WHERE namespace.nspname = current_schema()
    AND function_row.proname IN ('wcao_guard_immutable_0118','wcaa_guard_immutable_0118')
    AND function_row.pronargs = 0
    AND function_row.prorettype = 'trigger'::regtype
    AND function_row.proconfig = ARRAY['search_path=pg_catalog']::text[];
  SELECT count(*) INTO guard_triggers
  FROM pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid IN (
      'work_contact_action_outbox'::regclass,
      'work_contact_action_audit'::regclass
    )
    AND trigger_row.tgname IN ('wcao_guard_immutable_0118','wcaa_guard_immutable_0118')
    AND NOT trigger_row.tgisinternal;
  IF guard_functions <> 2 OR guard_triggers <> 2 THEN
    RAISE EXCEPTION '0118 immutable guard drift';
  END IF;
END
$work_contact_action_0118_verify$;
