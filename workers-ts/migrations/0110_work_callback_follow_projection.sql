-- Add an explicit terminal projection state and canonical active identities
-- before callback consumers mutate Enterprise WeChat follow relationships.
DO $$
DECLARE
  status_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO status_definition
  FROM pg_constraint
  WHERE conname = 'wce_status_ck'
    AND conrelid = 'work_callback_event'::regclass;

  IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'work_callback_event'
         AND column_name = 'projection_status'
     ) AND (
       status_definition IS NULL
       OR position('''RECEIVED''' in status_definition) = 0
       OR position('''PROCESSING''' in status_definition) = 0
       OR position('''ORDERED''' in status_definition) = 0
       OR position('''APPLIED''' in status_definition) = 0
       OR position('''APPLIED_NOOP''' in status_definition) = 0
       OR position('''SUPERSEDED''' in status_definition) = 0
       OR position('''IGNORED''' in status_definition) = 0
       OR position('''FAILED''' in status_definition) = 0
       OR position('''DEAD''' in status_definition) = 0
     ) THEN
    IF status_definition IS NOT NULL THEN
      ALTER TABLE "work_callback_event" DROP CONSTRAINT "wce_status_ck";
    END IF;
    ALTER TABLE "work_callback_event"
      ADD CONSTRAINT "wce_status_ck" CHECK (
        status IN (
          'RECEIVED','PROCESSING','ORDERED','APPLIED','APPLIED_NOOP',
          'SUPERSEDED','IGNORED','FAILED','DEAD'
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "work_client_active_identity_uq"
  ON "work_client" ("corp_id", "external_userid")
  WHERE "delete_time" IS NULL AND "external_userid" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS "work_client_follow_active_identity_uq"
  ON "work_client_follow" ("client_id", "userid")
  WHERE "is_del_user" = 0 AND "client_id" > 0 AND "userid" <> '';
