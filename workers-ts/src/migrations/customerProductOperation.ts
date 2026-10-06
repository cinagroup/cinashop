/** Explicit PG16 owner maintenance. Customer product operations use their own
 * append-only UserJWT namespace; an Admin ID is never a customer actor. */
export const CUSTOMER_PRODUCT_TARGETS_BODY = `
 SELECT CASE WHEN pg_catalog.jsonb_typeof($1) IS DISTINCT FROM 'array' THEN false
 ELSE pg_catalog.jsonb_array_length($1) BETWEEN 1 AND 100 AND NOT EXISTS (
   SELECT 1 FROM (
     SELECT value,ordinality,pg_catalog.lag(value->'product_id') OVER (ORDER BY ordinality) AS previous_id
     FROM pg_catalog.jsonb_array_elements($1) WITH ORDINALITY
   ) target WHERE CASE
     WHEN pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'object' THEN true
     WHEN NOT(value ? 'product_id' AND value ? 'expected_product_revision')
       OR value - ARRAY['product_id','expected_product_revision']::text[] <> '{}'::jsonb THEN true
     WHEN pg_catalog.jsonb_typeof(value->'product_id') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(value->'expected_product_revision') IS DISTINCT FROM 'string' THEN true
     WHEN (value->>'product_id') !~ '^[1-9][0-9]{0,9}$'
       OR (value->>'expected_product_revision') !~ '^[a-f0-9]{64}$' THEN true
     ELSE (value->>'product_id')::numeric > 2147483647
       OR (previous_id IS NOT NULL AND CASE
         WHEN pg_catalog.jsonb_typeof(previous_id) IS DISTINCT FROM 'number'
           OR (previous_id #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN true
         ELSE (previous_id #>> '{}')::numeric >= (value->>'product_id')::numeric END)
   END
 ) END
`;
export const CUSTOMER_PRODUCT_OPERATION_SQL = `
CREATE FUNCTION public.customer_product_targets_valid_v1(jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_product_targets$${CUSTOMER_PRODUCT_TARGETS_BODY}$customer_product_targets$;
REVOKE ALL ON FUNCTION public.customer_product_targets_valid_v1(jsonb) FROM PUBLIC;
CREATE TABLE public.customer_product_operation_request (
 actor_uid integer NOT NULL, request_key uuid NOT NULL,
 request_hash varchar(64) NOT NULL, service_id integer NOT NULL,
 kind varchar(32) NOT NULL, scope_key varchar(64) NOT NULL,
 targets jsonb NOT NULL, expected_catalog_revision varchar(64) NOT NULL,
 intent jsonb NOT NULL, evidence jsonb NOT NULL, outcome varchar(32) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cpo_pk PRIMARY KEY(actor_uid,request_key),
 CONSTRAINT cpo_identity_ck CHECK(actor_uid>0 AND service_id>=0
   AND (outcome IN ('abandoned','rollback-rejected') OR service_id>0)),
 CONSTRAINT cpo_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT cpo_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$'
   AND scope_key ~ '^[a-f0-9]{64}$' AND expected_catalog_revision ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cpo_targets_ck CHECK(public.customer_product_targets_valid_v1(targets)),
 CONSTRAINT cpo_json_ck CHECK(jsonb_typeof(intent)='object' AND jsonb_typeof(evidence)='object'
   AND octet_length(intent::text)<=262144 AND octet_length(evidence::text)<=16384),
 CONSTRAINT cpo_intent_ck CHECK(
   intent ?& ARRAY['version','scope_key','targets','expected_catalog_revision','payload']::text[]
   AND intent - ARRAY['version','scope_key','targets','expected_catalog_revision','payload']::text[]='{}'::jsonb
   AND intent->'version'='"customer-work-product-operation-v1"'::jsonb
   AND intent->'scope_key'=to_jsonb(scope_key)
   AND intent->'targets'=targets
   AND intent->'expected_catalog_revision'=to_jsonb(expected_catalog_revision)
   AND jsonb_typeof(intent->'payload')='object'),
 CONSTRAINT cpo_kind_ck CHECK(kind IN('set_show','replace_categories','replace_labels','update_skus')),
 CONSTRAINT cpo_outcome_ck CHECK(outcome IN('abandoned','rollback-rejected')
   OR(kind IN('set_show','replace_categories','replace_labels') AND outcome='products-updated')
   OR(kind='update_skus' AND outcome='skus-updated'))
);
CREATE INDEX cpo_actor_history ON public.customer_product_operation_request(actor_uid,created_at,request_key);
`;
export const CUSTOMER_PRODUCT_OPERATION_INSTALLATION_SQL = `
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
DO $cpo_install$
BEGIN
 IF current_setting('server_version_num')::int/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
 RAISE EXCEPTION 'Customer product installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_try_advisory_xact_lock(731645,0) THEN RAISE EXCEPTION 'Customer product installation already running'; END IF;
 IF to_regclass('public.customer_product_operation_request') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='customer_product_targets_valid_v1') THEN
 RAISE EXCEPTION 'Existing customer product protocol requires exact catalog review, no reinstall'; END IF;
END $cpo_install$;
${CUSTOMER_PRODUCT_OPERATION_SQL}
`;
