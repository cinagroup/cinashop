-- Expand-only canonical Enterprise WeChat member projection. The three legacy
-- work_member tables remain untouched as multiset import evidence.
CREATE TABLE IF NOT EXISTS "work_member_current" (
  "id" integer GENERATED ALWAYS AS IDENTITY,
  "corp_id" varchar(18) NOT NULL,
  "userid" varchar(64) NOT NULL,
  "canonical_userid" varchar(64) NOT NULL,
  "lifecycle_state" varchar(16) NOT NULL DEFAULT 'ACTIVE',
  "legacy_member_id" integer,
  "uid" integer,
  "name" varchar(128),
  "position" varchar(128),
  "mobile" varchar(32),
  "gender" smallint,
  "email" varchar(254),
  "biz_mail" varchar(254),
  "direct_leader" text,
  "avatar" varchar(1024),
  "thumb_avatar" varchar(1024),
  "telephone" varchar(64),
  "alias" varchar(64),
  "enable" smallint,
  "is_leader" smallint,
  "hide_mobile" smallint,
  "address" varchar(512),
  "open_userid" varchar(128),
  "main_department" integer,
  "status" smallint,
  "qr_code" varchar(1024),
  "external_position" varchar(128),
  "profile_complete" boolean NOT NULL DEFAULT false,
  "relations_complete" boolean NOT NULL DEFAULT false,
  "deleted_time" integer,
  "last_event_id" integer,
  "last_event_key" varchar(64),
  "last_event_subject_key_hash" varchar(64),
  "last_event_time" integer NOT NULL DEFAULT 0,
  "last_sequence_rank" integer NOT NULL DEFAULT 0,
  "create_time" integer NOT NULL DEFAULT 0,
  "update_time" integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "work_member_identity_alias" (
  "corp_id" varchar(18) NOT NULL,
  "userid" varchar(64) NOT NULL,
  "member_id" integer,
  "canonical_userid" varchar(64) NOT NULL,
  "lifecycle_state" varchar(16) NOT NULL,
  "last_event_id" integer,
  "last_event_key" varchar(64),
  "last_event_subject_key_hash" varchar(64),
  "last_event_time" integer NOT NULL DEFAULT 0,
  "last_sequence_rank" integer NOT NULL DEFAULT 0,
  "link_event_id" integer,
  "link_event_time" integer NOT NULL DEFAULT 0,
  "link_sequence_rank" integer NOT NULL DEFAULT 0,
  "create_time" integer NOT NULL DEFAULT 0,
  "update_time" integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "work_member_other_current" (
  "corp_id" varchar(18) NOT NULL,
  "member_id" integer NOT NULL,
  "extattr" text,
  "external_profile" text,
  "update_time" integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "work_member_relation_current" (
  "corp_id" varchar(18) NOT NULL,
  "member_id" integer NOT NULL,
  "department_id" integer NOT NULL,
  "sort_order" bigint NOT NULL DEFAULT 0,
  "is_leader_in_dept" smallint NOT NULL DEFAULT 0,
  "create_time" integer NOT NULL DEFAULT 0,
  "update_time" integer NOT NULL DEFAULT 0
);

-- CREATE TABLE IF NOT EXISTS must not accept a pre-existing, same-named table
-- with a wider authority surface or subtly incompatible null/default shape.
DO $work_current_columns$
DECLARE
  actual_shape text[];
  expected_shape text[];
  table_name text;
BEGIN
  FOR table_name, expected_shape IN
    SELECT * FROM (VALUES
      ('work_member_current', ARRAY[
        'id|integer|N|a|',
        'corp_id|character varying(18)|N||',
        'userid|character varying(64)|N||',
        'canonical_userid|character varying(64)|N||',
        'lifecycle_state|character varying(16)|N||''ACTIVE''::character varying',
        'legacy_member_id|integer|Y||',
        'uid|integer|Y||',
        'name|character varying(128)|Y||',
        'position|character varying(128)|Y||',
        'mobile|character varying(32)|Y||',
        'gender|smallint|Y||',
        'email|character varying(254)|Y||',
        'biz_mail|character varying(254)|Y||',
        'direct_leader|text|Y||',
        'avatar|character varying(1024)|Y||',
        'thumb_avatar|character varying(1024)|Y||',
        'telephone|character varying(64)|Y||',
        'alias|character varying(64)|Y||',
        'enable|smallint|Y||',
        'is_leader|smallint|Y||',
        'hide_mobile|smallint|Y||',
        'address|character varying(512)|Y||',
        'open_userid|character varying(128)|Y||',
        'main_department|integer|Y||',
        'status|smallint|Y||',
        'qr_code|character varying(1024)|Y||',
        'external_position|character varying(128)|Y||',
        'profile_complete|boolean|N||false',
        'relations_complete|boolean|N||false',
        'deleted_time|integer|Y||',
        'last_event_id|integer|Y||',
        'last_event_key|character varying(64)|Y||',
        'last_event_subject_key_hash|character varying(64)|Y||',
        'last_event_time|integer|N||0',
        'last_sequence_rank|integer|N||0',
        'create_time|integer|N||0',
        'update_time|integer|N||0'
      ]::text[]),
      ('work_member_identity_alias', ARRAY[
        'corp_id|character varying(18)|N||',
        'userid|character varying(64)|N||',
        'member_id|integer|Y||',
        'canonical_userid|character varying(64)|N||',
        'lifecycle_state|character varying(16)|N||',
        'last_event_id|integer|Y||',
        'last_event_key|character varying(64)|Y||',
        'last_event_subject_key_hash|character varying(64)|Y||',
        'last_event_time|integer|N||0',
        'last_sequence_rank|integer|N||0',
        'link_event_id|integer|Y||',
        'link_event_time|integer|N||0',
        'link_sequence_rank|integer|N||0',
        'create_time|integer|N||0',
        'update_time|integer|N||0'
      ]::text[]),
      ('work_member_other_current', ARRAY[
        'corp_id|character varying(18)|N||',
        'member_id|integer|N||',
        'extattr|text|Y||',
        'external_profile|text|Y||',
        'update_time|integer|N||0'
      ]::text[]),
      ('work_member_relation_current', ARRAY[
        'corp_id|character varying(18)|N||',
        'member_id|integer|N||',
        'department_id|integer|N||',
        'sort_order|bigint|N||0',
        'is_leader_in_dept|smallint|N||0',
        'create_time|integer|N||0',
        'update_time|integer|N||0'
      ]::text[])
    ) AS expected(table_name, expected_shape)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = current_schema()
        AND table_class.relname = table_name
        AND table_class.relkind = 'r'
        AND table_class.relpersistence = 'p'
    ) THEN
      RAISE EXCEPTION '% is not an ordinary permanent table in the current schema', table_name;
    END IF;

    SELECT array_agg(
      attribute.attname || '|' ||
      format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
      CASE WHEN attribute.attnotnull THEN 'N' ELSE 'Y' END || '|' ||
      attribute.attidentity::text || '|' ||
      COALESCE(pg_get_expr(attribute_default.adbin, attribute_default.adrelid), '')
      ORDER BY attribute.attnum
    )
      INTO actual_shape
    FROM pg_attribute AS attribute
    LEFT JOIN pg_attrdef AS attribute_default
      ON attribute_default.adrelid = attribute.attrelid
     AND attribute_default.adnum = attribute.attnum
    JOIN pg_class AS table_class ON table_class.oid = attribute.attrelid
    JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
    WHERE table_namespace.nspname = current_schema()
      AND table_class.relname = table_name
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF actual_shape IS DISTINCT FROM expected_shape THEN
      RAISE EXCEPTION '% has an incompatible column shape', table_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_attribute AS attribute
      JOIN pg_class AS table_class ON table_class.oid = attribute.attrelid
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_type AS attribute_type ON attribute_type.oid = attribute.atttypid
      WHERE table_namespace.nspname = current_schema()
        AND table_class.relname = table_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (
          attribute.attgenerated <> ''
          OR attribute.attcollation <> attribute_type.typcollation
        )
    ) THEN
      RAISE EXCEPTION '% has an incompatible generated column or collation', table_name;
    END IF;
  END LOOP;
END
$work_current_columns$;

-- An exact identity column also requires its owned sequence to retain the
-- default integer-identity semantics and to be ahead of every existing id.
DO $work_current_identity$
DECLARE
  table_oid oid := 'work_member_current'::regclass;
  id_attribute_number smallint;
  identity_sequence_oid oid;
  identity_sequence_name text;
  identity_sequence_count integer;
  sequence_last_value bigint;
  sequence_is_called boolean;
  next_sequence_value bigint;
  maximum_member_id integer;
  sequence_shape_compatible boolean;
BEGIN
  SELECT attribute.attnum
    INTO id_attribute_number
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = table_oid
    AND attribute.attname = 'id'
    AND NOT attribute.attisdropped;

  SELECT count(*), min(sequence_class.oid::bigint)::oid, min(
      format('%I.%I', sequence_namespace.nspname, sequence_class.relname)
    )
    INTO identity_sequence_count, identity_sequence_oid, identity_sequence_name
  FROM pg_class AS sequence_class
  JOIN pg_namespace AS sequence_namespace ON sequence_namespace.oid = sequence_class.relnamespace
  JOIN pg_depend AS sequence_dependency
    ON sequence_dependency.classid = 'pg_class'::regclass
   AND sequence_dependency.objid = sequence_class.oid
   AND sequence_dependency.objsubid = 0
   AND sequence_dependency.refclassid = 'pg_class'::regclass
   AND sequence_dependency.refobjid = table_oid
   AND sequence_dependency.refobjsubid = id_attribute_number
   AND sequence_dependency.deptype = 'i'
  JOIN pg_class AS table_class ON table_class.oid = table_oid
  WHERE sequence_class.relkind = 'S'
    AND sequence_class.relpersistence = 'p'
    AND sequence_namespace.nspname = current_schema()
    AND sequence_class.relowner = table_class.relowner;

  IF identity_sequence_count <> 1 OR identity_sequence_oid IS NULL THEN
    RAISE EXCEPTION 'work_member_current.id has an incompatible identity sequence ownership';
  END IF;

  SELECT sequence_catalog.seqtypid = 'integer'::regtype
      AND sequence_catalog.seqstart = 1
      AND sequence_catalog.seqincrement = 1
      AND sequence_catalog.seqmin = 1
      AND sequence_catalog.seqmax = 2147483647
      AND sequence_catalog.seqcache = 1
      AND NOT sequence_catalog.seqcycle
    INTO sequence_shape_compatible
  FROM pg_sequence AS sequence_catalog
  WHERE sequence_catalog.seqrelid = identity_sequence_oid;

  IF NOT COALESCE(sequence_shape_compatible, false) THEN
    RAISE EXCEPTION 'work_member_current.id has incompatible identity sequence parameters';
  END IF;

  EXECUTE format('SELECT last_value, is_called FROM %s', identity_sequence_name)
    INTO sequence_last_value, sequence_is_called;
  SELECT max("id") INTO maximum_member_id FROM "work_member_current";
  next_sequence_value := CASE
    WHEN sequence_is_called THEN sequence_last_value + 1
    ELSE sequence_last_value
  END;

  IF next_sequence_value > 2147483647
     OR (maximum_member_id IS NOT NULL AND next_sequence_value <= maximum_member_id) THEN
    RAISE EXCEPTION 'work_member_current.id identity sequence is not ahead of existing rows';
  END IF;
END
$work_current_identity$;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. Add only absent constraints;
-- the verification block below rejects every incompatible same-named object.
DO $work_current_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_pk' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_pk" PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_last_event_fk' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_last_event_fk" FOREIGN KEY ("last_event_id")
      REFERENCES "work_callback_event" ("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_corp_id_ck' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_corp_id_ck" CHECK ("corp_id" ~ '^[A-Za-z0-9_-]{1,18}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_userid_ck' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_userid_ck" CHECK (
        "userid" <> '' AND "userid" = btrim("userid")
        AND "userid" = lower("userid") AND "userid" !~ '[[:cntrl:]]'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_canonical_userid_ck' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_canonical_userid_ck" CHECK (
        "canonical_userid" <> ''
        AND "canonical_userid" = btrim("canonical_userid")
        AND "canonical_userid" = lower("canonical_userid")
        AND "canonical_userid" !~ '[[:cntrl:]]'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_lifecycle_state_ck' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_lifecycle_state_ck"
      CHECK ("lifecycle_state" IN ('ACTIVE', 'DELETED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_values_ck' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_values_ck" CHECK (
        "id" > 0
        AND ("status" IS NULL OR "status" IN (1, 2, 4, 5))
        AND ("enable" IS NULL OR "enable" IN (0, 1))
        AND ("is_leader" IS NULL OR "is_leader" IN (0, 1))
        AND ("hide_mobile" IS NULL OR "hide_mobile" IN (0, 1))
        AND ("gender" IS NULL OR "gender" IN (0, 1, 2))
        AND ("main_department" IS NULL OR "main_department" > 0)
        AND (
          NOT "profile_complete"
          OR (
            "name" IS NOT NULL
            AND "status" IS NOT NULL
            AND "enable" IS NOT NULL
            AND "main_department" IS NOT NULL
          )
        )
        AND (
          "lifecycle_state" <> 'DELETED'
          OR ("status" = 5 AND "enable" = 0)
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_lifecycle_identity_ck' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_lifecycle_identity_ck" CHECK (
        (
          "lifecycle_state" = 'ACTIVE'
          AND "userid" = "canonical_userid"
          AND "deleted_time" IS NULL
        ) OR (
          "lifecycle_state" = 'DELETED'
          AND "userid" = "canonical_userid"
          AND "deleted_time" IS NOT NULL
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_event_fence_ck' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_event_fence_ck" CHECK (
        (
          "last_event_id" IS NULL
          AND "last_event_key" IS NULL
          AND "last_event_subject_key_hash" IS NULL
          AND "last_event_time" = 0
          AND "last_sequence_rank" = 0
        ) OR (
          "last_event_id" > 0
          AND "last_event_key" ~ '^[0-9a-f]{64}$'
          AND "last_event_subject_key_hash" ~ '^[0-9a-f]{64}$'
          AND "last_event_time" > 0
          AND "last_sequence_rank" >= 0
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmc_time_ck' AND conrelid = 'work_member_current'::regclass
  ) THEN
    ALTER TABLE "work_member_current"
      ADD CONSTRAINT "wmc_time_ck" CHECK (
        "create_time" >= 0 AND "update_time" >= 0
        AND ("deleted_time" IS NULL OR "deleted_time" > 0)
      );
  END IF;
END
$work_current_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS "wmc_corp_id_uq"
  ON "work_member_current" ("corp_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "wmc_corp_userid_uq"
  ON "work_member_current" ("corp_id", "userid");
CREATE UNIQUE INDEX IF NOT EXISTS "wmc_legacy_member_id_uq"
  ON "work_member_current" ("legacy_member_id")
  WHERE "legacy_member_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "wmc_catalog"
  ON "work_member_current" ("corp_id", "lifecycle_state", "status", "name", "id");
CREATE INDEX IF NOT EXISTS "wmc_last_event_idx"
  ON "work_member_current" ("last_event_id")
  WHERE "last_event_id" IS NOT NULL;

DO $work_member_alias_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_pk' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_pk" PRIMARY KEY ("corp_id", "userid");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_member_fk' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_member_fk" FOREIGN KEY ("corp_id", "member_id")
      REFERENCES "work_member_current" ("corp_id", "id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_last_event_fk' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_last_event_fk" FOREIGN KEY ("last_event_id")
      REFERENCES "work_callback_event" ("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_link_event_fk' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_link_event_fk" FOREIGN KEY ("link_event_id")
      REFERENCES "work_callback_event" ("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_corp_id_ck' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_corp_id_ck" CHECK ("corp_id" ~ '^[A-Za-z0-9_-]{1,18}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_userid_ck' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_userid_ck" CHECK (
        "userid" <> '' AND "userid" = btrim("userid")
        AND "userid" = lower("userid") AND "userid" !~ '[[:cntrl:]]'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_canonical_userid_ck' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_canonical_userid_ck" CHECK (
        "canonical_userid" <> ''
        AND "canonical_userid" = btrim("canonical_userid")
        AND "canonical_userid" = lower("canonical_userid")
        AND "canonical_userid" !~ '[[:cntrl:]]'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_lifecycle_state_ck' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_lifecycle_state_ck"
      CHECK ("lifecycle_state" IN ('UNRESOLVED', 'ACTIVE', 'RENAMED', 'DELETED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_lifecycle_identity_ck' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_lifecycle_identity_ck" CHECK (
        ((
          "lifecycle_state" = 'UNRESOLVED'
          AND (
            ("userid" = "canonical_userid" AND "link_event_id" IS NULL)
            OR ("userid" <> "canonical_userid" AND "link_event_id" IS NOT NULL)
          )
        ) OR (
          "lifecycle_state" = 'ACTIVE'
          AND "member_id" IS NOT NULL
          AND "userid" = "canonical_userid"
          AND "link_event_id" IS NULL
        ) OR (
          "lifecycle_state" = 'RENAMED'
          AND "member_id" IS NOT NULL
          AND "userid" <> "canonical_userid"
          AND "link_event_id" IS NULL
        ) OR (
          "lifecycle_state" = 'DELETED'
          AND "userid" = "canonical_userid"
          AND "link_event_id" IS NULL
        ))
        AND ("member_id" IS NULL OR "member_id" > 0)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_event_fence_ck' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_event_fence_ck" CHECK (
        (
          "last_event_id" IS NULL
          AND "last_event_key" IS NULL
          AND "last_event_subject_key_hash" IS NULL
          AND "last_event_time" = 0
          AND "last_sequence_rank" = 0
        ) OR (
          "last_event_id" > 0
          AND "last_event_key" ~ '^[0-9a-f]{64}$'
          AND "last_event_subject_key_hash" ~ '^[0-9a-f]{64}$'
          AND "last_event_time" > 0
          AND "last_sequence_rank" >= 0
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_link_fence_ck' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_link_fence_ck" CHECK (
        (
          "link_event_id" IS NULL
          AND "link_event_time" = 0
          AND "link_sequence_rank" = 0
        ) OR (
          "link_event_id" > 0
          AND "link_event_time" > 0
          AND "link_sequence_rank" >= 0
          AND "last_event_id" IS NOT NULL
          AND ("link_event_time", "link_sequence_rank", "link_event_id")
            <= ("last_event_time", "last_sequence_rank", "last_event_id")
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmia_time_ck' AND conrelid = 'work_member_identity_alias'::regclass
  ) THEN
    ALTER TABLE "work_member_identity_alias"
      ADD CONSTRAINT "wmia_time_ck" CHECK ("create_time" >= 0 AND "update_time" >= 0);
  END IF;
END
$work_member_alias_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS "wmia_active_member_uq"
  ON "work_member_identity_alias" ("corp_id", "member_id")
  WHERE "lifecycle_state" = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS "wmia_active_canonical_uq"
  ON "work_member_identity_alias" ("corp_id", "canonical_userid")
  WHERE "lifecycle_state" = 'ACTIVE';
CREATE INDEX IF NOT EXISTS "wmia_pending_source_idx"
  ON "work_member_identity_alias" ("corp_id", "canonical_userid", "userid")
  WHERE "lifecycle_state" = 'UNRESOLVED' AND "userid" <> "canonical_userid";
CREATE INDEX IF NOT EXISTS "wmia_member_history"
  ON "work_member_identity_alias" ("corp_id", "member_id", "update_time", "userid");
CREATE INDEX IF NOT EXISTS "wmia_last_event_idx"
  ON "work_member_identity_alias" ("last_event_id")
  WHERE "last_event_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "wmia_link_event_idx"
  ON "work_member_identity_alias" ("link_event_id")
  WHERE "link_event_id" IS NOT NULL;

DO $work_current_child_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmoc_pk' AND conrelid = 'work_member_other_current'::regclass
  ) THEN
    ALTER TABLE "work_member_other_current"
      ADD CONSTRAINT "wmoc_pk" PRIMARY KEY ("corp_id", "member_id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmoc_member_fk' AND conrelid = 'work_member_other_current'::regclass
  ) THEN
    ALTER TABLE "work_member_other_current"
      ADD CONSTRAINT "wmoc_member_fk" FOREIGN KEY ("corp_id", "member_id")
      REFERENCES "work_member_current" ("corp_id", "id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmoc_corp_id_ck' AND conrelid = 'work_member_other_current'::regclass
  ) THEN
    ALTER TABLE "work_member_other_current"
      ADD CONSTRAINT "wmoc_corp_id_ck" CHECK ("corp_id" ~ '^[A-Za-z0-9_-]{1,18}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmoc_values_ck' AND conrelid = 'work_member_other_current'::regclass
  ) THEN
    ALTER TABLE "work_member_other_current"
      ADD CONSTRAINT "wmoc_values_ck" CHECK ("member_id" > 0 AND "update_time" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmrc_pk' AND conrelid = 'work_member_relation_current'::regclass
  ) THEN
    ALTER TABLE "work_member_relation_current"
      ADD CONSTRAINT "wmrc_pk" PRIMARY KEY ("corp_id", "member_id", "department_id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmrc_member_fk' AND conrelid = 'work_member_relation_current'::regclass
  ) THEN
    ALTER TABLE "work_member_relation_current"
      ADD CONSTRAINT "wmrc_member_fk" FOREIGN KEY ("corp_id", "member_id")
      REFERENCES "work_member_current" ("corp_id", "id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmrc_corp_id_ck' AND conrelid = 'work_member_relation_current'::regclass
  ) THEN
    ALTER TABLE "work_member_relation_current"
      ADD CONSTRAINT "wmrc_corp_id_ck" CHECK ("corp_id" ~ '^[A-Za-z0-9_-]{1,18}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmrc_values_ck' AND conrelid = 'work_member_relation_current'::regclass
  ) THEN
    ALTER TABLE "work_member_relation_current"
      ADD CONSTRAINT "wmrc_values_ck" CHECK (
        "member_id" > 0 AND "department_id" > 0
        AND "sort_order" BETWEEN 0 AND 4294967295
        AND "is_leader_in_dept" IN (0, 1)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wmrc_time_ck' AND conrelid = 'work_member_relation_current'::regclass
  ) THEN
    ALTER TABLE "work_member_relation_current"
      ADD CONSTRAINT "wmrc_time_ck" CHECK ("create_time" >= 0 AND "update_time" >= 0);
  END IF;
END
$work_current_child_constraints$;

CREATE INDEX IF NOT EXISTS "wmrc_department_catalog"
  ON "work_member_relation_current" ("corp_id", "department_id", "sort_order", "member_id");

-- Validate exact named constraint definitions. Missing constraints were added
-- above; an existing constraint with the same name is never replaced in place.
DO $work_current_constraint_verification$
DECLARE
  expected_record record;
  actual_definition text;
  reference_definition text;
  constraint_compatible boolean;
  reference_suffix text;
  current_reference_name text;
  alias_reference_name text;
  other_reference_name text;
  relation_reference_name text;
  current_reference_oid oid;
  alias_reference_oid oid;
  other_reference_oid oid;
  relation_reference_oid oid;
BEGIN
  -- Compare CHECK parse trees after PostgreSQL deparses both the installed
  -- constraint and an intended same-server reference. This preserves string
  -- literal case and boolean grouping while remaining version-independent.
  reference_suffix := substr(md5(
    pg_backend_pid()::text || clock_timestamp()::text || random()::text
  ), 1, 16);
  current_reference_name := '__wmc_ck_' || reference_suffix;
  alias_reference_name := '__wmia_ck_' || reference_suffix;
  other_reference_name := '__wmoc_ck_' || reference_suffix;
  relation_reference_name := '__wmrc_ck_' || reference_suffix;

  EXECUTE format(
    'CREATE TEMP TABLE %I (LIKE %I.%I) ON COMMIT DROP',
    current_reference_name, current_schema(), 'work_member_current'
  );
  EXECUTE format(
    'CREATE TEMP TABLE %I (LIKE %I.%I) ON COMMIT DROP',
    alias_reference_name, current_schema(), 'work_member_identity_alias'
  );
  EXECUTE format(
    'CREATE TEMP TABLE %I (LIKE %I.%I) ON COMMIT DROP',
    other_reference_name, current_schema(), 'work_member_other_current'
  );
  EXECUTE format(
    'CREATE TEMP TABLE %I (LIKE %I.%I) ON COMMIT DROP',
    relation_reference_name, current_schema(), 'work_member_relation_current'
  );
  current_reference_oid := to_regclass(format('pg_temp.%I', current_reference_name));
  alias_reference_oid := to_regclass(format('pg_temp.%I', alias_reference_name));
  other_reference_oid := to_regclass(format('pg_temp.%I', other_reference_name));
  relation_reference_oid := to_regclass(format('pg_temp.%I', relation_reference_name));

  EXECUTE format($reference_sql$
    ALTER TABLE pg_temp.%I
      ADD CONSTRAINT "expected_wmc_corp_id_ck" CHECK ("corp_id" ~ '^[A-Za-z0-9_-]{1,18}$'),
      ADD CONSTRAINT "expected_wmc_userid_ck" CHECK (
        "userid" <> '' AND "userid" = btrim("userid")
        AND "userid" = lower("userid") AND "userid" !~ '[[:cntrl:]]'
      ),
      ADD CONSTRAINT "expected_wmc_canonical_userid_ck" CHECK (
        "canonical_userid" <> ''
        AND "canonical_userid" = btrim("canonical_userid")
        AND "canonical_userid" = lower("canonical_userid")
        AND "canonical_userid" !~ '[[:cntrl:]]'
      ),
      ADD CONSTRAINT "expected_wmc_lifecycle_state_ck"
        CHECK ("lifecycle_state" IN ('ACTIVE', 'DELETED')),
      ADD CONSTRAINT "expected_wmc_values_ck" CHECK (
        "id" > 0
        AND ("status" IS NULL OR "status" IN (1, 2, 4, 5))
        AND ("enable" IS NULL OR "enable" IN (0, 1))
        AND ("is_leader" IS NULL OR "is_leader" IN (0, 1))
        AND ("hide_mobile" IS NULL OR "hide_mobile" IN (0, 1))
        AND ("gender" IS NULL OR "gender" IN (0, 1, 2))
        AND ("main_department" IS NULL OR "main_department" > 0)
        AND (
          NOT "profile_complete"
          OR (
            "name" IS NOT NULL
            AND "status" IS NOT NULL
            AND "enable" IS NOT NULL
            AND "main_department" IS NOT NULL
          )
        )
        AND (
          "lifecycle_state" <> 'DELETED'
          OR ("status" = 5 AND "enable" = 0)
        )
      ),
      ADD CONSTRAINT "expected_wmc_lifecycle_identity_ck" CHECK (
        (
          "lifecycle_state" = 'ACTIVE'
          AND "userid" = "canonical_userid"
          AND "deleted_time" IS NULL
        ) OR (
          "lifecycle_state" = 'DELETED'
          AND "userid" = "canonical_userid"
          AND "deleted_time" IS NOT NULL
        )
      ),
      ADD CONSTRAINT "expected_wmc_event_fence_ck" CHECK (
        (
          "last_event_id" IS NULL
          AND "last_event_key" IS NULL
          AND "last_event_subject_key_hash" IS NULL
          AND "last_event_time" = 0
          AND "last_sequence_rank" = 0
        ) OR (
          "last_event_id" > 0
          AND "last_event_key" ~ '^[0-9a-f]{64}$'
          AND "last_event_subject_key_hash" ~ '^[0-9a-f]{64}$'
          AND "last_event_time" > 0
          AND "last_sequence_rank" >= 0
        )
      ),
      ADD CONSTRAINT "expected_wmc_time_ck" CHECK (
        "create_time" >= 0 AND "update_time" >= 0
        AND ("deleted_time" IS NULL OR "deleted_time" > 0)
      )
  $reference_sql$, current_reference_name);

  EXECUTE format($reference_sql$
    ALTER TABLE pg_temp.%I
      ADD CONSTRAINT "expected_wmia_corp_id_ck" CHECK ("corp_id" ~ '^[A-Za-z0-9_-]{1,18}$'),
      ADD CONSTRAINT "expected_wmia_userid_ck" CHECK (
        "userid" <> '' AND "userid" = btrim("userid")
        AND "userid" = lower("userid") AND "userid" !~ '[[:cntrl:]]'
      ),
      ADD CONSTRAINT "expected_wmia_canonical_userid_ck" CHECK (
        "canonical_userid" <> ''
        AND "canonical_userid" = btrim("canonical_userid")
        AND "canonical_userid" = lower("canonical_userid")
        AND "canonical_userid" !~ '[[:cntrl:]]'
      ),
      ADD CONSTRAINT "expected_wmia_lifecycle_state_ck"
        CHECK ("lifecycle_state" IN ('UNRESOLVED', 'ACTIVE', 'RENAMED', 'DELETED')),
      ADD CONSTRAINT "expected_wmia_lifecycle_identity_ck" CHECK (
        ((
          "lifecycle_state" = 'UNRESOLVED'
          AND (
            ("userid" = "canonical_userid" AND "link_event_id" IS NULL)
            OR ("userid" <> "canonical_userid" AND "link_event_id" IS NOT NULL)
          )
        ) OR (
          "lifecycle_state" = 'ACTIVE'
          AND "member_id" IS NOT NULL
          AND "userid" = "canonical_userid"
          AND "link_event_id" IS NULL
        ) OR (
          "lifecycle_state" = 'RENAMED'
          AND "member_id" IS NOT NULL
          AND "userid" <> "canonical_userid"
          AND "link_event_id" IS NULL
        ) OR (
          "lifecycle_state" = 'DELETED'
          AND "userid" = "canonical_userid"
          AND "link_event_id" IS NULL
        ))
        AND ("member_id" IS NULL OR "member_id" > 0)
      ),
      ADD CONSTRAINT "expected_wmia_event_fence_ck" CHECK (
        (
          "last_event_id" IS NULL
          AND "last_event_key" IS NULL
          AND "last_event_subject_key_hash" IS NULL
          AND "last_event_time" = 0
          AND "last_sequence_rank" = 0
        ) OR (
          "last_event_id" > 0
          AND "last_event_key" ~ '^[0-9a-f]{64}$'
          AND "last_event_subject_key_hash" ~ '^[0-9a-f]{64}$'
          AND "last_event_time" > 0
          AND "last_sequence_rank" >= 0
        )
      ),
      ADD CONSTRAINT "expected_wmia_link_fence_ck" CHECK (
        (
          "link_event_id" IS NULL
          AND "link_event_time" = 0
          AND "link_sequence_rank" = 0
        ) OR (
          "link_event_id" > 0
          AND "link_event_time" > 0
          AND "link_sequence_rank" >= 0
          AND "last_event_id" IS NOT NULL
          AND ("link_event_time", "link_sequence_rank", "link_event_id")
            <= ("last_event_time", "last_sequence_rank", "last_event_id")
        )
      ),
      ADD CONSTRAINT "expected_wmia_time_ck"
        CHECK ("create_time" >= 0 AND "update_time" >= 0)
  $reference_sql$, alias_reference_name);

  EXECUTE format($reference_sql$
    ALTER TABLE pg_temp.%I
      ADD CONSTRAINT "expected_wmoc_corp_id_ck" CHECK ("corp_id" ~ '^[A-Za-z0-9_-]{1,18}$'),
      ADD CONSTRAINT "expected_wmoc_values_ck" CHECK ("member_id" > 0 AND "update_time" >= 0)
  $reference_sql$, other_reference_name);

  EXECUTE format($reference_sql$
    ALTER TABLE pg_temp.%I
      ADD CONSTRAINT "expected_wmrc_corp_id_ck" CHECK ("corp_id" ~ '^[A-Za-z0-9_-]{1,18}$'),
      ADD CONSTRAINT "expected_wmrc_values_ck" CHECK (
        "member_id" > 0 AND "department_id" > 0
        AND "sort_order" BETWEEN 0 AND 4294967295
        AND "is_leader_in_dept" IN (0, 1)
      ),
      ADD CONSTRAINT "expected_wmrc_time_ck"
        CHECK ("create_time" >= 0 AND "update_time" >= 0)
  $reference_sql$, relation_reference_name);

  FOR expected_record IN
    SELECT * FROM (VALUES
      ('work_member_current', 'wmc_pk', 'p'),
      ('work_member_current', 'wmc_last_event_fk', 'f'),
      ('work_member_current', 'wmc_corp_id_ck', 'c'),
      ('work_member_current', 'wmc_userid_ck', 'c'),
      ('work_member_current', 'wmc_canonical_userid_ck', 'c'),
      ('work_member_current', 'wmc_lifecycle_state_ck', 'c'),
      ('work_member_current', 'wmc_values_ck', 'c'),
      ('work_member_current', 'wmc_lifecycle_identity_ck', 'c'),
      ('work_member_current', 'wmc_event_fence_ck', 'c'),
      ('work_member_current', 'wmc_time_ck', 'c'),
      ('work_member_identity_alias', 'wmia_pk', 'p'),
      ('work_member_identity_alias', 'wmia_member_fk', 'f'),
      ('work_member_identity_alias', 'wmia_last_event_fk', 'f'),
      ('work_member_identity_alias', 'wmia_link_event_fk', 'f'),
      ('work_member_identity_alias', 'wmia_corp_id_ck', 'c'),
      ('work_member_identity_alias', 'wmia_userid_ck', 'c'),
      ('work_member_identity_alias', 'wmia_canonical_userid_ck', 'c'),
      ('work_member_identity_alias', 'wmia_lifecycle_state_ck', 'c'),
      ('work_member_identity_alias', 'wmia_lifecycle_identity_ck', 'c'),
      ('work_member_identity_alias', 'wmia_event_fence_ck', 'c'),
      ('work_member_identity_alias', 'wmia_link_fence_ck', 'c'),
      ('work_member_identity_alias', 'wmia_time_ck', 'c'),
      ('work_member_other_current', 'wmoc_pk', 'p'),
      ('work_member_other_current', 'wmoc_member_fk', 'f'),
      ('work_member_other_current', 'wmoc_corp_id_ck', 'c'),
      ('work_member_other_current', 'wmoc_values_ck', 'c'),
      ('work_member_relation_current', 'wmrc_pk', 'p'),
      ('work_member_relation_current', 'wmrc_member_fk', 'f'),
      ('work_member_relation_current', 'wmrc_corp_id_ck', 'c'),
      ('work_member_relation_current', 'wmrc_values_ck', 'c'),
      ('work_member_relation_current', 'wmrc_time_ck', 'c')
    ) AS expected(table_name, constraint_name, constraint_type)
  LOOP
    SELECT count(*) = 1 AND COALESCE(bool_and(
        constraint_row.convalidated
        AND constraint_row.conislocal
        AND constraint_row.coninhcount = 0
        AND constraint_row.conparentid = 0
        AND (constraint_row.contype <> 'c' OR NOT constraint_row.connoinherit)
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
      ), false)
      INTO constraint_compatible
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
    JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
    WHERE table_namespace.nspname = current_schema()
      AND table_class.relname = expected_record.table_name
      AND constraint_row.conname = expected_record.constraint_name
      AND constraint_row.contype = expected_record.constraint_type;

    IF NOT COALESCE(constraint_compatible, false) THEN
      RAISE EXCEPTION 'constraint %.% has incompatible metadata',
        expected_record.table_name, expected_record.constraint_name;
    END IF;
  END LOOP;

  FOR expected_record IN
    SELECT * FROM (VALUES
      ('work_member_current', 'wmc_pk', ARRAY['id']::text[]),
      ('work_member_identity_alias', 'wmia_pk', ARRAY['corp_id', 'userid']::text[]),
      ('work_member_other_current', 'wmoc_pk', ARRAY['corp_id', 'member_id']::text[]),
      ('work_member_relation_current', 'wmrc_pk', ARRAY['corp_id', 'member_id', 'department_id']::text[])
    ) AS expected(table_name, constraint_name, key_columns)
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = current_schema()
        AND table_class.relname = expected_record.table_name
        AND constraint_row.conname = expected_record.constraint_name
        AND constraint_row.contype = 'p'
        AND ARRAY(
          SELECT attribute.attname::text
          FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
          JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) = expected_record.key_columns
    ) INTO constraint_compatible;

    IF NOT constraint_compatible THEN
      RAISE EXCEPTION 'primary key %.% has incompatible key columns',
        expected_record.table_name, expected_record.constraint_name;
    END IF;
  END LOOP;

  FOR expected_record IN
    SELECT * FROM (VALUES
      ('work_member_current', 'wmc_last_event_fk', ARRAY['last_event_id']::text[],
        'work_callback_event', ARRAY['id']::text[], 'r'),
      ('work_member_identity_alias', 'wmia_member_fk', ARRAY['corp_id', 'member_id']::text[],
        'work_member_current', ARRAY['corp_id', 'id']::text[], 'c'),
      ('work_member_identity_alias', 'wmia_last_event_fk', ARRAY['last_event_id']::text[],
        'work_callback_event', ARRAY['id']::text[], 'r'),
      ('work_member_identity_alias', 'wmia_link_event_fk', ARRAY['link_event_id']::text[],
        'work_callback_event', ARRAY['id']::text[], 'r'),
      ('work_member_other_current', 'wmoc_member_fk', ARRAY['corp_id', 'member_id']::text[],
        'work_member_current', ARRAY['corp_id', 'id']::text[], 'c'),
      ('work_member_relation_current', 'wmrc_member_fk', ARRAY['corp_id', 'member_id']::text[],
        'work_member_current', ARRAY['corp_id', 'id']::text[], 'c')
    ) AS expected(
      table_name, constraint_name, key_columns,
      reference_table_name, reference_columns, delete_action
    )
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = current_schema()
        AND table_class.relname = expected_record.table_name
        AND constraint_row.conname = expected_record.constraint_name
        AND constraint_row.contype = 'f'
        AND constraint_row.confrelid = to_regclass(format(
          '%I.%I', current_schema(), expected_record.reference_table_name
        ))
        AND constraint_row.confupdtype = 'a'
        AND constraint_row.confdeltype = expected_record.delete_action::"char"
        AND constraint_row.confmatchtype = 's'
        AND ARRAY(
          SELECT attribute.attname::text
          FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
          JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) = expected_record.key_columns
        AND ARRAY(
          SELECT attribute.attname::text
          FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attnum, position)
          JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) = expected_record.reference_columns
    ) INTO constraint_compatible;

    IF NOT constraint_compatible THEN
      RAISE EXCEPTION 'foreign key %.% has an incompatible definition',
        expected_record.table_name, expected_record.constraint_name;
    END IF;
  END LOOP;

  FOR expected_record IN
    SELECT * FROM (VALUES
      ('work_member_current', 'wmc_corp_id_ck', current_reference_oid, 'expected_wmc_corp_id_ck'),
      ('work_member_current', 'wmc_userid_ck', current_reference_oid, 'expected_wmc_userid_ck'),
      ('work_member_current', 'wmc_canonical_userid_ck', current_reference_oid, 'expected_wmc_canonical_userid_ck'),
      ('work_member_current', 'wmc_lifecycle_state_ck', current_reference_oid, 'expected_wmc_lifecycle_state_ck'),
      ('work_member_current', 'wmc_values_ck', current_reference_oid, 'expected_wmc_values_ck'),
      ('work_member_current', 'wmc_lifecycle_identity_ck', current_reference_oid, 'expected_wmc_lifecycle_identity_ck'),
      ('work_member_current', 'wmc_event_fence_ck', current_reference_oid, 'expected_wmc_event_fence_ck'),
      ('work_member_current', 'wmc_time_ck', current_reference_oid, 'expected_wmc_time_ck'),
      ('work_member_identity_alias', 'wmia_corp_id_ck', alias_reference_oid, 'expected_wmia_corp_id_ck'),
      ('work_member_identity_alias', 'wmia_userid_ck', alias_reference_oid, 'expected_wmia_userid_ck'),
      ('work_member_identity_alias', 'wmia_canonical_userid_ck', alias_reference_oid, 'expected_wmia_canonical_userid_ck'),
      ('work_member_identity_alias', 'wmia_lifecycle_state_ck', alias_reference_oid, 'expected_wmia_lifecycle_state_ck'),
      ('work_member_identity_alias', 'wmia_lifecycle_identity_ck', alias_reference_oid, 'expected_wmia_lifecycle_identity_ck'),
      ('work_member_identity_alias', 'wmia_event_fence_ck', alias_reference_oid, 'expected_wmia_event_fence_ck'),
      ('work_member_identity_alias', 'wmia_link_fence_ck', alias_reference_oid, 'expected_wmia_link_fence_ck'),
      ('work_member_identity_alias', 'wmia_time_ck', alias_reference_oid, 'expected_wmia_time_ck'),
      ('work_member_other_current', 'wmoc_corp_id_ck', other_reference_oid, 'expected_wmoc_corp_id_ck'),
      ('work_member_other_current', 'wmoc_values_ck', other_reference_oid, 'expected_wmoc_values_ck'),
      ('work_member_relation_current', 'wmrc_corp_id_ck', relation_reference_oid, 'expected_wmrc_corp_id_ck'),
      ('work_member_relation_current', 'wmrc_values_ck', relation_reference_oid, 'expected_wmrc_values_ck'),
      ('work_member_relation_current', 'wmrc_time_ck', relation_reference_oid, 'expected_wmrc_time_ck')
    ) AS expected(table_name, constraint_name, reference_table_oid, reference_constraint_name)
  LOOP
    actual_definition := NULL;
    reference_definition := NULL;
    SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
      INTO actual_definition
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = to_regclass(format(
        '%I.%I', current_schema(), expected_record.table_name
      ))
      AND constraint_row.conname = expected_record.constraint_name
      AND constraint_row.contype = 'c';

    SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
      INTO reference_definition
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = expected_record.reference_table_oid
      AND constraint_row.conname = expected_record.reference_constraint_name
      AND constraint_row.contype = 'c';

    IF actual_definition IS DISTINCT FROM reference_definition THEN
      RAISE EXCEPTION 'check constraint %.% has an incompatible expression',
        expected_record.table_name, expected_record.constraint_name;
    END IF;
  END LOOP;
END
$work_current_constraint_verification$;

-- Validate every named btree index after CREATE INDEX IF NOT EXISTS. This
-- catches collisions on another table, wrong predicates, order, or uniqueness.
DO $work_current_index_verification$
DECLARE
  expected_record record;
  index_compatible boolean;
  reference_suffix text;
  current_reference_name text;
  alias_reference_name text;
  current_reference_oid oid;
  alias_reference_oid oid;
BEGIN
  reference_suffix := substr(md5(
    pg_backend_pid()::text || clock_timestamp()::text || random()::text
  ), 1, 16);
  current_reference_name := '__wmc_ix_' || reference_suffix;
  alias_reference_name := '__wmia_ix_' || reference_suffix;
  EXECUTE format(
    'CREATE TEMP TABLE %I (LIKE %I.%I) ON COMMIT DROP',
    current_reference_name, current_schema(), 'work_member_current'
  );
  EXECUTE format(
    'CREATE TEMP TABLE %I (LIKE %I.%I) ON COMMIT DROP',
    alias_reference_name, current_schema(), 'work_member_identity_alias'
  );
  current_reference_oid := to_regclass(format('pg_temp.%I', current_reference_name));
  alias_reference_oid := to_regclass(format('pg_temp.%I', alias_reference_name));
  EXECUTE format($reference_sql$
    ALTER TABLE pg_temp.%I
      ADD CONSTRAINT "expected_legacy_member_predicate" CHECK ("legacy_member_id" IS NOT NULL),
      ADD CONSTRAINT "expected_current_event_predicate" CHECK ("last_event_id" IS NOT NULL)
  $reference_sql$, current_reference_name);
  EXECUTE format($reference_sql$
    ALTER TABLE pg_temp.%I
      ADD CONSTRAINT "expected_active_alias_predicate" CHECK ("lifecycle_state" = 'ACTIVE'),
      ADD CONSTRAINT "expected_pending_source_predicate" CHECK (
        "lifecycle_state" = 'UNRESOLVED' AND "userid" <> "canonical_userid"
      ),
      ADD CONSTRAINT "expected_alias_event_predicate" CHECK ("last_event_id" IS NOT NULL),
      ADD CONSTRAINT "expected_link_event_predicate" CHECK ("link_event_id" IS NOT NULL)
  $reference_sql$, alias_reference_name);

  FOR expected_record IN
    SELECT * FROM (VALUES
      ('work_member_current', 'wmc_pk', true, true, ARRAY['id']::text[], NULL::oid, NULL::text),
      ('work_member_current', 'wmc_corp_id_uq', true, false, ARRAY['corp_id', 'id']::text[], NULL::oid, NULL::text),
      ('work_member_current', 'wmc_corp_userid_uq', true, false, ARRAY['corp_id', 'userid']::text[], NULL::oid, NULL::text),
      ('work_member_current', 'wmc_legacy_member_id_uq', true, false, ARRAY['legacy_member_id']::text[], current_reference_oid, 'expected_legacy_member_predicate'),
      ('work_member_current', 'wmc_catalog', false, false, ARRAY['corp_id', 'lifecycle_state', 'status', 'name', 'id']::text[], NULL::oid, NULL::text),
      ('work_member_current', 'wmc_last_event_idx', false, false, ARRAY['last_event_id']::text[], current_reference_oid, 'expected_current_event_predicate'),
      ('work_member_identity_alias', 'wmia_pk', true, true, ARRAY['corp_id', 'userid']::text[], NULL::oid, NULL::text),
      ('work_member_identity_alias', 'wmia_active_member_uq', true, false, ARRAY['corp_id', 'member_id']::text[], alias_reference_oid, 'expected_active_alias_predicate'),
      ('work_member_identity_alias', 'wmia_active_canonical_uq', true, false, ARRAY['corp_id', 'canonical_userid']::text[], alias_reference_oid, 'expected_active_alias_predicate'),
      ('work_member_identity_alias', 'wmia_pending_source_idx', false, false, ARRAY['corp_id', 'canonical_userid', 'userid']::text[], alias_reference_oid, 'expected_pending_source_predicate'),
      ('work_member_identity_alias', 'wmia_member_history', false, false, ARRAY['corp_id', 'member_id', 'update_time', 'userid']::text[], NULL::oid, NULL::text),
      ('work_member_identity_alias', 'wmia_last_event_idx', false, false, ARRAY['last_event_id']::text[], alias_reference_oid, 'expected_alias_event_predicate'),
      ('work_member_identity_alias', 'wmia_link_event_idx', false, false, ARRAY['link_event_id']::text[], alias_reference_oid, 'expected_link_event_predicate'),
      ('work_member_other_current', 'wmoc_pk', true, true, ARRAY['corp_id', 'member_id']::text[], NULL::oid, NULL::text),
      ('work_member_relation_current', 'wmrc_pk', true, true, ARRAY['corp_id', 'member_id', 'department_id']::text[], NULL::oid, NULL::text),
      ('work_member_relation_current', 'wmrc_department_catalog', false, false, ARRAY['corp_id', 'department_id', 'sort_order', 'member_id']::text[], NULL::oid, NULL::text)
    ) AS expected(
      table_name, index_name, is_unique, is_primary, key_columns,
      reference_table_oid, reference_constraint_name
    )
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_class AS index_class
      JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
      JOIN pg_index AS index_metadata ON index_metadata.indexrelid = index_class.oid
      JOIN pg_class AS table_class ON table_class.oid = index_metadata.indrelid
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_am AS access_method ON access_method.oid = index_class.relam
      WHERE index_namespace.nspname = current_schema()
        AND index_class.relname = expected_record.index_name
        AND table_namespace.nspname = current_schema()
        AND table_class.relname = expected_record.table_name
        AND access_method.amname = 'btree'
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND index_metadata.indislive
        AND index_metadata.indisunique = expected_record.is_unique
        AND index_metadata.indisprimary = expected_record.is_primary
        AND NOT index_metadata.indisexclusion
        AND index_metadata.indnkeyatts = cardinality(expected_record.key_columns)
        AND index_metadata.indnatts = cardinality(expected_record.key_columns)
        AND index_metadata.indexprs IS NULL
        AND ARRAY(
          SELECT replace(pg_get_indexdef(index_class.oid, position, true), '"', '')
          FROM generate_series(1, index_metadata.indnkeyatts) AS position
          ORDER BY position
        ) = expected_record.key_columns
        AND (
          (
            expected_record.reference_table_oid IS NULL
            AND index_metadata.indpred IS NULL
          ) OR (
            expected_record.reference_table_oid IS NOT NULL
            AND index_metadata.indpred IS NOT NULL
            AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid) = (
              SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
              FROM pg_constraint AS constraint_row
              WHERE constraint_row.conrelid = expected_record.reference_table_oid
                AND constraint_row.conname = expected_record.reference_constraint_name
                AND constraint_row.contype = 'c'
            )
          )
        )
    ) INTO index_compatible;

    IF NOT index_compatible THEN
      RAISE EXCEPTION 'index %.% has an incompatible definition',
        expected_record.table_name, expected_record.index_name;
    END IF;
  END LOOP;
END
$work_current_index_verification$;

DO $work_current_comments$
BEGIN
  IF col_description(
    'work_member_current'::regclass,
    (SELECT attnum FROM pg_attribute
     WHERE attrelid = 'work_member_current'::regclass AND attname = 'last_event_id')
  ) IS DISTINCT FROM
    'Last-applied callback fence; compare (last_event_time,last_sequence_rank,last_event_id) before applying current profile/relations.'
  THEN
    COMMENT ON COLUMN "work_member_current"."last_event_id" IS
      'Last-applied callback fence; compare (last_event_time,last_sequence_rank,last_event_id) before applying current profile/relations.';
  END IF;

  IF col_description(
    'work_member_identity_alias'::regclass,
    (SELECT attnum FROM pg_attribute
     WHERE attrelid = 'work_member_identity_alias'::regclass AND attname = 'last_event_id')
  ) IS DISTINCT FROM
    'Latest-seen callback fence; advance before provider I/O so UNRESOLVED/provider-failed identities reject older responses.'
  THEN
    COMMENT ON COLUMN "work_member_identity_alias"."last_event_id" IS
      'Latest-seen callback fence; advance before provider I/O so UNRESOLVED/provider-failed identities reject older responses.';
  END IF;

  IF col_description(
    'work_member_identity_alias'::regclass,
    (SELECT attnum FROM pg_attribute
     WHERE attrelid = 'work_member_identity_alias'::regclass AND attname = 'link_event_id')
  ) IS DISTINCT FROM
    'Pending-rename edge fence; remains stable while later target events advance the latest-seen fence.'
  THEN
    COMMENT ON COLUMN "work_member_identity_alias"."link_event_id" IS
      'Pending-rename edge fence; remains stable while later target events advance the latest-seen fence.';
  END IF;
END
$work_current_comments$;
