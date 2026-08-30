-- Separate durable callback transport/order state from business projection outcome.
ALTER TABLE "work_callback_event"
  ADD COLUMN IF NOT EXISTS "projection_status" varchar(16) NOT NULL DEFAULT 'PENDING';

-- IF NOT EXISTS must not silently accept a same-named column with an unsafe shape.
DO $$
DECLARE
  column_compatible boolean;
BEGIN
  SELECT data_type = 'character varying'
      AND character_maximum_length = 16
      AND is_nullable = 'NO'
      AND column_default IN ('''PENDING''::character varying', '''PENDING''::text')
    INTO column_compatible
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'work_callback_event'
    AND column_name = 'projection_status';

  IF NOT COALESCE(column_compatible, false) THEN
    RAISE EXCEPTION 'work_callback_event.projection_status has an incompatible shape';
  END IF;
END $$;

-- Backfill the states used by C0/C1 before event.status is normalized to pipeline state.
UPDATE "work_callback_event"
SET "projection_status" = CASE "status"
  WHEN 'PROCESSING' THEN 'PROCESSING'
  WHEN 'ORDERED' THEN 'REFRESH_REQUIRED'
  WHEN 'APPLIED' THEN 'APPLIED'
  WHEN 'APPLIED_NOOP' THEN 'APPLIED_NOOP'
  WHEN 'SUPERSEDED' THEN 'SUPERSEDED'
  WHEN 'IGNORED' THEN 'IGNORED'
  WHEN 'FAILED' THEN 'FAILED'
  WHEN 'DEAD' THEN 'DEAD'
  ELSE 'PENDING'
END
WHERE "projection_status" = 'PENDING'
  AND "projection_status" IS DISTINCT FROM CASE "status"
    WHEN 'PROCESSING' THEN 'PROCESSING'
    WHEN 'ORDERED' THEN 'REFRESH_REQUIRED'
    WHEN 'APPLIED' THEN 'APPLIED'
    WHEN 'APPLIED_NOOP' THEN 'APPLIED_NOOP'
    WHEN 'SUPERSEDED' THEN 'SUPERSEDED'
    WHEN 'IGNORED' THEN 'IGNORED'
    WHEN 'FAILED' THEN 'FAILED'
    WHEN 'DEAD' THEN 'DEAD'
    ELSE 'PENDING'
  END;

UPDATE "work_callback_event"
SET "status" = 'ORDERED'
WHERE "status" IN ('APPLIED', 'APPLIED_NOOP', 'SUPERSEDED', 'IGNORED');

-- Expand phase: accept both the legacy projection outcomes and the five new
-- pipeline states until the new Worker is fully deployed and old writers exit.
DO $$
DECLARE
  status_definition text;
  status_normalized text;
  status_catalog_compatible boolean;
BEGIN
  SELECT pg_get_constraintdef(constraint_row.oid),
      constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND constraint_row.conkey = ARRAY[column_row.attnum]::smallint[]
    INTO status_definition, status_catalog_compatible
  FROM pg_constraint AS constraint_row
  JOIN pg_attribute AS column_row
    ON column_row.attrelid = constraint_row.conrelid
   AND column_row.attname = 'status'
   AND NOT column_row.attisdropped
  WHERE constraint_row.conname = 'wce_status_ck'
    AND constraint_row.contype = 'c'
    AND constraint_row.conrelid = 'work_callback_event'::regclass;

  status_normalized := lower(regexp_replace(
    COALESCE(status_definition, ''), '[[:space:]()"]+', '', 'g'
  ));
  status_normalized := replace(status_normalized, '::charactervarying[]', '');
  status_normalized := replace(status_normalized, '::varchar[]', '');
  status_normalized := replace(status_normalized, '::text[]', '');
  status_normalized := replace(status_normalized, '::charactervarying', '');
  status_normalized := replace(status_normalized, '::varchar', '');
  status_normalized := replace(status_normalized, '::text', '');

  IF NOT COALESCE(status_catalog_compatible, false)
     OR status_normalized <> 'checkstatus=anyarray[''received'',''processing'',''ordered'',''applied'',''applied_noop'',''superseded'',''ignored'',''failed'',''dead'']' THEN
    IF status_definition IS NOT NULL THEN
      ALTER TABLE "work_callback_event" DROP CONSTRAINT "wce_status_ck";
    END IF;
    ALTER TABLE "work_callback_event"
      ADD CONSTRAINT "wce_status_ck" CHECK (
        "status" IN (
          'RECEIVED','PROCESSING','ORDERED','APPLIED','APPLIED_NOOP',
          'SUPERSEDED','IGNORED','FAILED','DEAD'
        )
      );
  END IF;
END $$;

DO $$
DECLARE
  status_definition text;
  status_normalized text;
  status_catalog_compatible boolean;
BEGIN
  SELECT pg_get_constraintdef(constraint_row.oid),
      constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND constraint_row.conkey = ARRAY[column_row.attnum]::smallint[]
    INTO status_definition, status_catalog_compatible
  FROM pg_constraint AS constraint_row
  JOIN pg_attribute AS column_row
    ON column_row.attrelid = constraint_row.conrelid
   AND column_row.attname = 'projection_status'
   AND NOT column_row.attisdropped
  WHERE constraint_row.conname = 'wce_projection_status_ck'
    AND constraint_row.contype = 'c'
    AND constraint_row.conrelid = 'work_callback_event'::regclass;

  status_normalized := lower(regexp_replace(
    COALESCE(status_definition, ''), '[[:space:]()"]+', '', 'g'
  ));
  status_normalized := replace(status_normalized, '::charactervarying[]', '');
  status_normalized := replace(status_normalized, '::varchar[]', '');
  status_normalized := replace(status_normalized, '::text[]', '');
  status_normalized := replace(status_normalized, '::charactervarying', '');
  status_normalized := replace(status_normalized, '::varchar', '');
  status_normalized := replace(status_normalized, '::text', '');

  IF NOT COALESCE(status_catalog_compatible, false)
     OR status_normalized <> 'checkprojection_status=anyarray[''pending'',''processing'',''refresh_required'',''applied'',''applied_noop'',''superseded'',''ignored'',''failed'',''dead'']' THEN
    IF status_definition IS NOT NULL THEN
      ALTER TABLE "work_callback_event" DROP CONSTRAINT "wce_projection_status_ck";
    END IF;
    ALTER TABLE "work_callback_event"
      ADD CONSTRAINT "wce_projection_status_ck" CHECK (
        "projection_status" IN (
          'PENDING','PROCESSING','REFRESH_REQUIRED','APPLIED','APPLIED_NOOP',
          'SUPERSEDED','IGNORED','FAILED','DEAD'
        )
      );
  END IF;
END $$;

-- A same-named but malformed index is a deployment error, not a reason to
-- silently skip the projection scan index.
DO $$
DECLARE
  index_exists boolean;
  index_ready boolean;
BEGIN
  SELECT to_regclass(format('%I.%I', current_schema(), 'wce_projection_status_time')) IS NOT NULL
    INTO index_exists;

  SELECT EXISTS (
    SELECT 1
    FROM pg_class AS index_class
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
    JOIN pg_index AS index_metadata ON index_metadata.indexrelid = index_class.oid
    JOIN pg_class AS table_class ON table_class.oid = index_metadata.indrelid
    JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
    JOIN pg_am AS access_method ON access_method.oid = index_class.relam
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = 'wce_projection_status_time'
      AND table_namespace.nspname = current_schema()
      AND table_class.relname = 'work_callback_event'
      AND access_method.amname = 'btree'
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indislive
      AND NOT index_metadata.indisunique
      AND index_metadata.indnkeyatts = 3
      AND index_metadata.indnatts = 3
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND replace(pg_get_indexdef(index_class.oid, 1, true), '"', '') = 'projection_status'
      AND replace(pg_get_indexdef(index_class.oid, 2, true), '"', '') = 'update_time'
      AND replace(pg_get_indexdef(index_class.oid, 3, true), '"', '') = 'id'
  ) INTO index_ready;

  IF index_exists AND NOT index_ready THEN
    RAISE EXCEPTION 'wce_projection_status_time has an incompatible definition';
  END IF;
  IF NOT index_exists THEN
    CREATE INDEX "wce_projection_status_time"
      ON "work_callback_event" ("projection_status", "update_time", "id");
  END IF;
END $$;

COMMENT ON COLUMN "work_callback_event"."status" IS
  'Durable callback pipeline state. Legacy projection outcomes remain accepted during the expand phase; ORDERED does not imply a business projection was applied.';
COMMENT ON COLUMN "work_callback_event"."projection_status" IS
  'Business projection outcome, independent from callback/outbox transport completion.';
