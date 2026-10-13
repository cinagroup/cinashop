/** Additive, append-only original-request fences. No order cancellation or payment reversal. */
export const CASHIER_SECOND_CARD_ABANDON_TABLE = 'cashier_second_card_abandon_v1';
export const CASHIER_SECOND_CARD_ABANDON_SQL = `
CREATE TABLE public.cashier_second_card_abandon_v1 (
 actor_uid integer NOT NULL, request_key uuid NOT NULL, kind varchar(8) NOT NULL,
 request_hash varchar(64) NOT NULL, scope_key varchar(64) NOT NULL, intent jsonb NOT NULL, intent_json text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT csca_pk PRIMARY KEY(actor_uid,request_key,kind),
 CONSTRAINT csca_actor_ck CHECK(actor_uid>0),
 CONSTRAINT csca_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT csca_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_key ~ '^[a-f0-9]{64}$'),
 CONSTRAINT csca_content_ck CHECK(octet_length(intent_json)<=262144 AND intent_json::jsonb=intent
  AND request_hash=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(intent_json,'UTF8')),'hex')),
 CONSTRAINT csca_intent_ck CHECK((jsonb_typeof(intent)='object' AND octet_length(intent::text)<=262144
  AND intent->'scope_key'=to_jsonb(scope_key) AND (
  (kind='creation' AND intent->'version'='"customer-cashier-second-card-v1"'::jsonb
   AND intent ?& ARRAY['version','scope_key','buyer_uid','tourist_key','product_id','sku_unique','quantity','real_name','user_phone','mark','custom_form','coupon_id','use_integral']::text[]
   AND intent-ARRAY['version','scope_key','buyer_uid','tourist_key','product_id','sku_unique','quantity','real_name','user_phone','mark','custom_form','coupon_id','use_integral']::text[]='{}'::jsonb)
  OR (kind='payment' AND intent->'version'='"customer-cashier-second-card-payment-v1"'::jsonb
   AND intent ?& ARRAY['version','scope_key','order_id','order_no','expected_amount']::text[]
   AND intent-ARRAY['version','scope_key','order_id','order_no','expected_amount']::text[]='{}'::jsonb))) IS TRUE),
 CONSTRAINT csca_types_ck CHECK((
  (kind='creation' AND jsonb_typeof(intent->'buyer_uid')='number' AND (intent->>'buyer_uid') ~ '^(0|[1-9][0-9]{0,9})$'
   AND (intent->>'buyer_uid')::numeric BETWEEN 0 AND 2147483647
   AND jsonb_typeof(intent->'tourist_key')='string'
   AND (((intent->>'buyer_uid')='0' AND (intent->>'tourist_key') ~ '^[A-Za-z0-9_-]{1,50}$')
     OR ((intent->>'buyer_uid')<>'0' AND (intent->>'tourist_key')=''))
   AND jsonb_typeof(intent->'product_id')='number' AND (intent->>'product_id') ~ '^[1-9][0-9]{0,9}$'
   AND (intent->>'product_id')::numeric BETWEEN 1 AND 2147483647
   AND jsonb_typeof(intent->'quantity')='number' AND (intent->>'quantity') ~ '^[1-9][0-9]{0,4}$'
   AND (intent->>'quantity')::numeric BETWEEN 1 AND 32767
   AND jsonb_typeof(intent->'coupon_id')='number' AND (intent->>'coupon_id') ~ '^(0|[1-9][0-9]{0,9})$'
   AND (intent->>'coupon_id')::numeric BETWEEN 0 AND 2147483647
   AND jsonb_typeof(intent->'sku_unique')='string' AND char_length(intent->>'sku_unique') BETWEEN 1 AND 16
   AND jsonb_typeof(intent->'real_name')='string' AND char_length(intent->>'real_name') BETWEEN 1 AND 32
   AND jsonb_typeof(intent->'user_phone')='string' AND char_length(intent->>'user_phone') BETWEEN 1 AND 20
   AND jsonb_typeof(intent->'mark')='string' AND char_length(intent->>'mark')<=512
   AND jsonb_typeof(intent->'use_integral')='boolean')
  OR (kind='payment' AND jsonb_typeof(intent->'order_id')='number' AND (intent->>'order_id') ~ '^[1-9][0-9]{0,9}$'
   AND (intent->>'order_id')::numeric BETWEEN 1 AND 2147483647
   AND jsonb_typeof(intent->'order_no')='string' AND (intent->>'order_no') ~ '^[A-Za-z0-9_-]{1,32}$'
   AND jsonb_typeof(intent->'expected_amount')='string' AND (intent->>'expected_amount') ~ '^(0|[1-9][0-9]{0,9})\\.[0-9]{2}$')
 ) IS TRUE),
 CONSTRAINT csca_kind_ck CHECK(kind IN('creation','payment'))
);
CREATE INDEX csca_actor_history ON public.cashier_second_card_abandon_v1(actor_uid,created_at,request_key,kind);
REVOKE ALL ON public.cashier_second_card_abandon_v1 FROM PUBLIC;
`;
export const CASHIER_SECOND_CARD_ABANDON_INSTALLATION_SQL = `
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
DO $csca_install$ BEGIN
 IF current_setting('server_version_num')::int/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR current_user<>session_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
  WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=current_user)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN
 RAISE EXCEPTION 'Cashier abandonment installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock(731710,0) THEN RAISE EXCEPTION 'Cashier abandonment installation already running'; END IF;
 IF to_regclass('public.cashier_second_card_abandon_v1') IS NOT NULL THEN
 RAISE EXCEPTION 'Existing cashier abandonment protocol requires exact catalog review, no reinstall'; END IF;
END $csca_install$;
${CASHIER_SECOND_CARD_ABANDON_SQL}
`;
