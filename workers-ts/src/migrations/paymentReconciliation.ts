export const PAYMENT_RECONCILIATION_SQL = `-- Durable payment-query reconciliation cases and immutable operator decisions.
-- Provider responses are reduced to transaction, status, amount and time evidence;
-- payer identity, raw response bodies and credentials are never persisted.
CREATE TABLE IF NOT EXISTS "payment_reconciliation_case" (
  "id" BIGSERIAL PRIMARY KEY,
  "replay_key" VARCHAR(36) NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "profile" VARCHAR(16) NOT NULL,
  "order_domain" VARCHAR(16) DEFAULT '' NOT NULL,
  "order_no" VARCHAR(64) NOT NULL,
  "expected_amount_cents" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "status" VARCHAR(16) DEFAULT 'OPEN' NOT NULL,
  "provider_status" VARCHAR(16) DEFAULT 'UNKNOWN' NOT NULL,
  "provider_transaction_id" VARCHAR(100) DEFAULT '' NOT NULL,
  "provider_event_time" INTEGER DEFAULT 0 NOT NULL,
  "callback_event_id" BIGINT,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "next_check_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "last_query_time" INTEGER DEFAULT 0 NOT NULL,
  "last_error_code" VARCHAR(64) DEFAULT '' NOT NULL,
  "initiated_time" INTEGER DEFAULT 0 NOT NULL,
  "resolved_time" INTEGER DEFAULT 0 NOT NULL,
  "retain_until" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "prc_callback_event_fk" FOREIGN KEY ("callback_event_id")
    REFERENCES "payment_callback_event" ("id") ON DELETE RESTRICT,
  CONSTRAINT "prc_provider_profile_ck" CHECK (
    ("provider" = 'alipay' AND "profile" = 'alipay')
    OR ("provider" = 'wechat' AND "profile" IN ('wechat', 'routine', 'app'))
  ),
  CONSTRAINT "prc_order_domain_ck" CHECK (
    "order_domain" IN ('', 'store_order', 'recharge', 'membership')
  ),
  CONSTRAINT "prc_business_ck" CHECK (
    "order_no" ~ '^[A-Za-z0-9_-]{2,64}$' AND "expected_amount_cents" > 0
    AND "currency" = 'CNY' AND ("provider_transaction_id" = ''
      OR "provider_transaction_id" ~ '^[A-Za-z0-9_-]{1,100}$')
  ),
  CONSTRAINT "prc_status_ck" CHECK (
    "status" IN (
      'OPEN', 'QUEUED', 'QUERYING', 'WAITING', 'SETTLED', 'CONFIRMED',
      'NO_PAYMENT', 'UNKNOWN', 'CONFLICT', 'DEAD', 'CLOSED'
    )
  ),
  CONSTRAINT "prc_provider_status_ck" CHECK (
    "provider_status" IN ('UNKNOWN', 'PENDING', 'SUCCESS', 'CLOSED', 'NOT_FOUND')
  ),
  CONSTRAINT "prc_replay_lease_ck" CHECK (
    "replay_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ("lease_token" = '' OR "lease_token" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  ),
  CONSTRAINT "prc_time_count_ck" CHECK (
    "provider_event_time" >= 0 AND "attempt_count" >= 0 AND "next_check_time" >= 0
    AND "lease_until" >= 0 AND "last_query_time" >= 0 AND "initiated_time" >= 0
    AND "resolved_time" >= 0 AND "retain_until" >= "add_time"
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "prc_replay_key_uq"
  ON "payment_reconciliation_case" ("replay_key");
CREATE UNIQUE INDEX IF NOT EXISTS "prc_provider_order_uq"
  ON "payment_reconciliation_case" ("provider", "order_no");
CREATE INDEX IF NOT EXISTS "prc_due"
  ON "payment_reconciliation_case" ("next_check_time", "id")
  WHERE "status" IN ('OPEN', 'WAITING', 'UNKNOWN');
CREATE INDEX IF NOT EXISTS "prc_expired_lease"
  ON "payment_reconciliation_case" ("lease_until", "id")
  WHERE "status" IN ('QUEUED', 'QUERYING');
CREATE INDEX IF NOT EXISTS "prc_attention"
  ON "payment_reconciliation_case" ("status", "update_time", "id")
  WHERE "status" IN ('UNKNOWN', 'CONFLICT', 'DEAD');
CREATE INDEX IF NOT EXISTS "prc_retention"
  ON "payment_reconciliation_case" ("retain_until", "id")
  WHERE "status" IN ('SETTLED', 'CONFIRMED', 'NO_PAYMENT', 'CLOSED');

CREATE TABLE IF NOT EXISTS "payment_reconciliation_action" (
  "id" BIGSERIAL PRIMARY KEY,
  "case_id" BIGINT NOT NULL,
  "action_key" VARCHAR(36) NOT NULL,
  "admin_id" INTEGER NOT NULL,
  "action_type" VARCHAR(16) NOT NULL,
  "reason_code" VARCHAR(64) NOT NULL,
  "before_status" VARCHAR(16) NOT NULL,
  "after_status" VARCHAR(16) NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "pra_case_fk" FOREIGN KEY ("case_id")
    REFERENCES "payment_reconciliation_case" ("id") ON DELETE RESTRICT,
  CONSTRAINT "pra_action_key_ck" CHECK (
    "action_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "pra_business_ck" CHECK (
    "admin_id" > 0 AND "action_type" IN ('RETRY', 'ACCEPT_LOCAL', 'CLOSE')
    AND "reason_code" ~ '^[a-z][a-z0-9_]{2,63}$'
    AND "before_status" IN (
      'OPEN', 'QUEUED', 'QUERYING', 'WAITING', 'SETTLED', 'CONFIRMED',
      'NO_PAYMENT', 'UNKNOWN', 'CONFLICT', 'DEAD', 'CLOSED'
    )
    AND "after_status" IN (
      'OPEN', 'QUEUED', 'QUERYING', 'WAITING', 'SETTLED', 'CONFIRMED',
      'NO_PAYMENT', 'UNKNOWN', 'CONFLICT', 'DEAD', 'CLOSED'
    )
    AND "add_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pra_action_key_uq"
  ON "payment_reconciliation_action" ("action_key");
CREATE INDEX IF NOT EXISTS "pra_case_history"
  ON "payment_reconciliation_action" ("case_id", "id");

DO $payment_reconciliation_verify$
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
    to_regclass('payment_reconciliation_case'),
    to_regclass('payment_reconciliation_action')
  );
  IF actual IS DISTINCT FROM ARRAY[
    'payment_reconciliation_action:r:p',
    'payment_reconciliation_case:r:p'
  ]::text[] THEN
    RAISE EXCEPTION '0127 payment reconciliation relation shape verification failed';
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
      'payment_reconciliation_case'::regclass,
      'payment_reconciliation_action'::regclass
    )
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF actual IS DISTINCT FROM ARRAY[
    'payment_reconciliation_action:id:bigint:true:true',
    'payment_reconciliation_action:case_id:bigint:true:false',
    'payment_reconciliation_action:action_key:character varying(36):true:false',
    'payment_reconciliation_action:admin_id:integer:true:false',
    'payment_reconciliation_action:action_type:character varying(16):true:false',
    'payment_reconciliation_action:reason_code:character varying(64):true:false',
    'payment_reconciliation_action:before_status:character varying(16):true:false',
    'payment_reconciliation_action:after_status:character varying(16):true:false',
    'payment_reconciliation_action:add_time:integer:true:true',
    'payment_reconciliation_case:id:bigint:true:true',
    'payment_reconciliation_case:replay_key:character varying(36):true:false',
    'payment_reconciliation_case:provider:character varying(16):true:false',
    'payment_reconciliation_case:profile:character varying(16):true:false',
    'payment_reconciliation_case:order_domain:character varying(16):true:true',
    'payment_reconciliation_case:order_no:character varying(64):true:false',
    'payment_reconciliation_case:expected_amount_cents:integer:true:false',
    'payment_reconciliation_case:currency:character varying(3):true:false',
    'payment_reconciliation_case:status:character varying(16):true:true',
    'payment_reconciliation_case:provider_status:character varying(16):true:true',
    'payment_reconciliation_case:provider_transaction_id:character varying(100):true:true',
    'payment_reconciliation_case:provider_event_time:integer:true:true',
    'payment_reconciliation_case:callback_event_id:bigint:false:false',
    'payment_reconciliation_case:attempt_count:integer:true:true',
    'payment_reconciliation_case:next_check_time:integer:true:true',
    'payment_reconciliation_case:lease_until:integer:true:true',
    'payment_reconciliation_case:lease_token:character varying(36):true:true',
    'payment_reconciliation_case:last_query_time:integer:true:true',
    'payment_reconciliation_case:last_error_code:character varying(64):true:true',
    'payment_reconciliation_case:initiated_time:integer:true:true',
    'payment_reconciliation_case:resolved_time:integer:true:true',
    'payment_reconciliation_case:retain_until:integer:true:true',
    'payment_reconciliation_case:add_time:integer:true:true',
    'payment_reconciliation_case:update_time:integer:true:true'
  ]::text[] THEN
    RAISE EXCEPTION '0127 payment reconciliation column shape verification failed';
  END IF;

  SELECT array_agg(constraint_row.conname::text ORDER BY constraint_row.conname)
  INTO actual
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid IN (
    'payment_reconciliation_case'::regclass,
    'payment_reconciliation_action'::regclass
  );
  IF actual IS DISTINCT FROM ARRAY[
    'payment_reconciliation_action_pkey',
    'payment_reconciliation_case_pkey',
    'pra_action_key_ck',
    'pra_business_ck',
    'pra_case_fk',
    'prc_business_ck',
    'prc_callback_event_fk',
    'prc_order_domain_ck',
    'prc_provider_profile_ck',
    'prc_provider_status_ck',
    'prc_replay_lease_ck',
    'prc_status_ck',
    'prc_time_count_ck'
  ]::text[] THEN
    RAISE EXCEPTION '0127 payment reconciliation constraint set verification failed';
  END IF;

  SELECT array_agg(index_relation.relname::text ORDER BY index_relation.relname)
  INTO actual
  FROM pg_index AS index_row
  JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
  WHERE index_row.indrelid IN (
    'payment_reconciliation_case'::regclass,
    'payment_reconciliation_action'::regclass
  );
  IF actual IS DISTINCT FROM ARRAY[
    'payment_reconciliation_action_pkey',
    'payment_reconciliation_case_pkey',
    'pra_action_key_uq',
    'pra_case_history',
    'prc_attention',
    'prc_due',
    'prc_expired_lease',
    'prc_provider_order_uq',
    'prc_replay_key_uq',
    'prc_retention'
  ]::text[] THEN
    RAISE EXCEPTION '0127 payment reconciliation index set verification failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'payment_reconciliation_case'::regclass,
      'payment_reconciliation_action'::regclass
    )
      AND (
        NOT constraint_row.convalidated
        OR (constraint_row.contype = 'c' AND constraint_row.connoinherit)
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'payment_reconciliation_case'::regclass
      AND constraint_row.conname = 'prc_callback_event_fk'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'payment_callback_event'::regclass
      AND constraint_row.confdeltype = 'r'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'payment_reconciliation_action'::regclass
      AND constraint_row.conname = 'pra_case_fk'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'payment_reconciliation_case'::regclass
      AND constraint_row.confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION '0127 payment reconciliation constraint integrity verification failed';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname IN (
      'payment_reconciliation_action_pkey',
      'payment_reconciliation_case_pkey',
      'pra_action_key_uq',
      'prc_provider_order_uq',
      'prc_replay_key_uq'
    )
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
  ) <> 5 OR (
    SELECT count(*)
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname IN (
      'prc_attention', 'prc_due', 'prc_expired_lease', 'prc_retention'
    )
      AND index_row.indpred IS NOT NULL
      AND index_row.indisvalid
      AND index_row.indisready
  ) <> 4 THEN
    RAISE EXCEPTION '0127 payment reconciliation index integrity verification failed';
  END IF;
END
$payment_reconciliation_verify$;
`;
