/** Explicit PG16 owner maintenance. UserJWT operations never borrow Admin actor, replay or audit authority. */
import { CUSTOMER_USER_CATALOG_LOCK_KEY } from './customerUserCatalogLock';
export const CUSTOMER_USER_TARGETS_BODY = `
 SELECT CASE WHEN pg_catalog.jsonb_typeof($1) IS DISTINCT FROM 'array' THEN false
 ELSE pg_catalog.jsonb_array_length($1) BETWEEN 1 AND 100 AND NOT EXISTS (
   SELECT 1 FROM (
     SELECT value,ordinality,pg_catalog.lag(value->'uid') OVER (ORDER BY ordinality) AS previous_id
     FROM pg_catalog.jsonb_array_elements($1) WITH ORDINALITY
   ) target WHERE CASE
     WHEN pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'object' THEN true
     WHEN NOT(value ? 'uid' AND value ? 'expected_user_revision')
       OR value - ARRAY['uid','expected_user_revision']::text[] <> '{}'::jsonb THEN true
     WHEN pg_catalog.jsonb_typeof(value->'uid') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(value->'expected_user_revision') IS DISTINCT FROM 'string' THEN true
     WHEN (value->>'uid') !~ '^[1-9][0-9]{0,9}$'
       OR (value->>'expected_user_revision') !~ '^[a-f0-9]{64}$' THEN true
     ELSE (value->>'uid')::numeric > 2147483647
       OR (previous_id IS NOT NULL AND CASE
         WHEN pg_catalog.jsonb_typeof(previous_id) IS DISTINCT FROM 'number'
           OR (previous_id #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN true
         ELSE (previous_id #>> '{}')::numeric >= (value->>'uid')::numeric END)
   END
 ) END
`;
export const CUSTOMER_USER_INTENT_BODY = `
 SELECT COALESCE(CASE WHEN pg_catalog.jsonb_typeof($2) IS DISTINCT FROM 'object' THEN false
 WHEN NOT($2 ?& ARRAY['version','scope_key','targets','expected_catalog_revision','payload']::text[] AND $2 - ARRAY['version','scope_key','targets','expected_catalog_revision','payload']::text[]='{}'::jsonb) THEN false
 WHEN $2->'version' IS DISTINCT FROM '"customer-work-user-operation-v1"'::jsonb
 OR pg_catalog.jsonb_typeof($2->'scope_key') IS DISTINCT FROM 'string' OR ($2->>'scope_key') !~ '^[a-f0-9]{64}$'
 OR pg_catalog.jsonb_typeof($2->'expected_catalog_revision') IS DISTINCT FROM 'string' OR ($2->>'expected_catalog_revision') !~ '^[a-f0-9]{64}$'
 OR NOT public.customer_user_targets_valid_v1($2->'targets')
 OR pg_catalog.jsonb_typeof($2->'payload') IS DISTINCT FROM 'object' THEN false
 ELSE CASE $1
 WHEN 'replace_level' THEN pg_catalog.jsonb_array_length($2->'targets')=1 AND $2->'payload' ?& ARRAY['level_id']::text[] AND ($2->'payload') - ARRAY['level_id']::text[]='{}'::jsonb AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'level_id') IS DISTINCT FROM 'number' THEN false WHEN ($2->'payload'->'level_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'payload'->'level_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END)
 WHEN 'replace_group' THEN $2->'payload' ?& ARRAY['group_id']::text[] AND ($2->'payload') - ARRAY['group_id']::text[]='{}'::jsonb AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'group_id') IS DISTINCT FROM 'number' THEN false WHEN ($2->'payload'->'group_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'payload'->'group_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END)
 WHEN 'replace_labels' THEN $2->'payload' ?& ARRAY['label_ids']::text[] AND ($2->'payload') - ARRAY['label_ids']::text[]='{}'::jsonb AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'label_ids') IS DISTINCT FROM 'array' THEN false ELSE pg_catalog.jsonb_array_length($2->'payload'->'label_ids')<=100 AND NOT EXISTS(SELECT 1 FROM (SELECT value,pg_catalog.lag(value) OVER(ORDER BY ordinality) AS previous FROM pg_catalog.jsonb_array_elements($2->'payload'->'label_ids') WITH ORDINALITY) labels WHERE CASE WHEN NOT(CASE WHEN pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'number' THEN false WHEN (value #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (value #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) THEN true WHEN previous IS NULL THEN false WHEN NOT(CASE WHEN pg_catalog.jsonb_typeof(previous) IS DISTINCT FROM 'number' THEN false WHEN (previous #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (previous #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) THEN true ELSE (previous #>> '{}')::numeric >= (value #>> '{}')::numeric END) END)
 WHEN 'grant_coupons' THEN $2->'payload' ?& ARRAY['issue_id','expected_issue_revision']::text[] AND ($2->'payload') - ARRAY['issue_id','expected_issue_revision']::text[]='{}'::jsonb AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'issue_id') IS DISTINCT FROM 'number' THEN false WHEN ($2->'payload'->'issue_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'payload'->'issue_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND pg_catalog.jsonb_typeof($2->'payload'->'expected_issue_revision')='string' AND ($2->'payload'->>'expected_issue_revision') ~ '^[a-f0-9]{64}$'
 WHEN 'adjust_membership' THEN pg_catalog.jsonb_array_length($2->'targets')=1 AND $2->'payload' ?& ARRAY['direction','days']::text[] AND ($2->'payload') - ARRAY['direction','days']::text[]='{}'::jsonb AND $2->'payload'->'direction' IN ('"add"'::jsonb,'"subtract"'::jsonb) AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'days') IS DISTINCT FROM 'number' THEN false WHEN ($2->'payload'->'days' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'payload'->'days' #>> '{}')::numeric BETWEEN 1 AND 999999 END)
 WHEN 'adjust_money' THEN pg_catalog.jsonb_array_length($2->'targets')=1 AND $2->'payload' ?& ARRAY['direction','amount']::text[] AND ($2->'payload') - ARRAY['direction','amount']::text[]='{}'::jsonb AND $2->'payload'->'direction' IN ('"add"'::jsonb,'"subtract"'::jsonb) AND CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'amount') IS DISTINCT FROM 'string' THEN false WHEN ($2->'payload'->>'amount') !~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN false ELSE ($2->'payload'->>'amount')::numeric > 0 AND ($2->'payload'->>'amount')::numeric<=9999999999.99 END
 WHEN 'adjust_integral' THEN pg_catalog.jsonb_array_length($2->'targets')=1 AND $2->'payload' ?& ARRAY['direction','amount']::text[] AND ($2->'payload') - ARRAY['direction','amount']::text[]='{}'::jsonb AND $2->'payload'->'direction' IN ('"add"'::jsonb,'"subtract"'::jsonb) AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'amount') IS DISTINCT FROM 'number' THEN false WHEN ($2->'payload'->'amount' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'payload'->'amount' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END)
 ELSE false END END,false)
`;
export const CUSTOMER_USER_OPERATION_SQL = `
CREATE FUNCTION public.customer_user_targets_valid_v1(jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_user_targets$${CUSTOMER_USER_TARGETS_BODY}$customer_user_targets$;
REVOKE ALL ON FUNCTION public.customer_user_targets_valid_v1(jsonb) FROM PUBLIC;
CREATE FUNCTION public.customer_user_intent_valid_v1(text,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_user_intent$${CUSTOMER_USER_INTENT_BODY}$customer_user_intent$;
REVOKE ALL ON FUNCTION public.customer_user_intent_valid_v1(text,jsonb) FROM PUBLIC;
CREATE TABLE public.customer_user_operation_request (
 actor_uid integer NOT NULL, request_key uuid NOT NULL,
 request_hash varchar(64) NOT NULL, service_id integer NOT NULL,
 kind varchar(32) NOT NULL, scope_key varchar(64) NOT NULL,
 targets jsonb NOT NULL, expected_catalog_revision varchar(64) NOT NULL,
 intent jsonb NOT NULL, evidence jsonb NOT NULL, outcome varchar(32) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cuo_pk PRIMARY KEY(actor_uid,request_key),
 CONSTRAINT cuo_identity_ck CHECK(actor_uid>0 AND service_id>=0
   AND ((outcome IN ('abandoned','rollback-rejected') AND service_id=0) OR (outcome NOT IN ('abandoned','rollback-rejected') AND service_id>0))),
 CONSTRAINT cuo_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT cuo_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_key ~ '^[a-f0-9]{64}$' AND expected_catalog_revision ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cuo_targets_ck CHECK(public.customer_user_targets_valid_v1(targets)),
 CONSTRAINT cuo_json_ck CHECK(jsonb_typeof(intent)='object' AND jsonb_typeof(evidence)='object' AND octet_length(intent::text)<=262144 AND octet_length(evidence::text)<=16384),
 CONSTRAINT cuo_intent_ck CHECK(public.customer_user_intent_valid_v1(kind,intent) AND intent->'scope_key'=to_jsonb(scope_key) AND intent->'targets'=targets AND intent->'expected_catalog_revision'=to_jsonb(expected_catalog_revision)),
 CONSTRAINT cuo_kind_ck CHECK(kind IN('replace_level','replace_group','replace_labels','grant_coupons','adjust_membership','adjust_money','adjust_integral')),
 CONSTRAINT cuo_outcome_ck CHECK(COALESCE(CASE WHEN jsonb_typeof(evidence) IS DISTINCT FROM 'object' THEN false
 WHEN outcome='abandoned' THEN evidence='{}'::jsonb
 WHEN outcome='rollback-rejected' THEN evidence ?& ARRAY['code']::text[] AND evidence - ARRAY['code']::text[]='{}'::jsonb AND jsonb_typeof(evidence->'code')='string' AND char_length(evidence->>'code') BETWEEN 1 AND 128
 WHEN jsonb_typeof(targets) IS DISTINCT FROM 'array' THEN false
 WHEN kind IN('replace_level','replace_group','replace_labels') AND outcome='users-updated' THEN evidence ?& ARRAY['changed','verified']::text[] AND evidence - ARRAY['changed','verified']::text[]='{}'::jsonb AND (CASE WHEN pg_catalog.jsonb_typeof(evidence->'changed') IS DISTINCT FROM 'number' THEN false WHEN (evidence->'changed' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE (evidence->'changed' #>> '{}')::numeric BETWEEN 0 AND 2147483647 END) AND evidence->'verified'='true'::jsonb AND CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof(evidence->'changed') IS DISTINCT FROM 'number' THEN false WHEN (evidence->'changed' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE (evidence->'changed' #>> '{}')::numeric BETWEEN 0 AND 2147483647 END) THEN (evidence->>'changed')::numeric<=jsonb_array_length(targets) ELSE false END
 WHEN kind='grant_coupons' AND outcome='coupons-granted' THEN evidence ?& ARRAY['changed','issued_count','issue_id','verified']::text[] AND evidence - ARRAY['changed','issued_count','issue_id','verified']::text[]='{}'::jsonb AND (CASE WHEN pg_catalog.jsonb_typeof(evidence->'changed') IS DISTINCT FROM 'number' THEN false WHEN (evidence->'changed' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE (evidence->'changed' #>> '{}')::numeric BETWEEN 0 AND 2147483647 END) AND (CASE WHEN pg_catalog.jsonb_typeof(evidence->'issued_count') IS DISTINCT FROM 'number' THEN false WHEN (evidence->'issued_count' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (evidence->'issued_count' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND (CASE WHEN pg_catalog.jsonb_typeof(evidence->'issue_id') IS DISTINCT FROM 'number' THEN false WHEN (evidence->'issue_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (evidence->'issue_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND evidence->'verified'='true'::jsonb AND evidence->'changed'=to_jsonb(jsonb_array_length(targets)) AND evidence->'issued_count'=evidence->'changed' AND evidence->'issue_id'=intent->'payload'->'issue_id'
 WHEN kind='adjust_membership' AND outcome='membership-adjusted' THEN evidence ?& ARRAY['changed','other_order_id','verified']::text[] AND evidence - ARRAY['changed','other_order_id','verified']::text[]='{}'::jsonb AND (CASE WHEN pg_catalog.jsonb_typeof(evidence->'changed') IS DISTINCT FROM 'number' THEN false WHEN (evidence->'changed' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE (evidence->'changed' #>> '{}')::numeric BETWEEN 0 AND 1 END) AND (CASE WHEN pg_catalog.jsonb_typeof(evidence->'other_order_id') IS DISTINCT FROM 'number' THEN false WHEN (evidence->'other_order_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (evidence->'other_order_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND evidence->'verified'='true'::jsonb
 WHEN kind IN('adjust_money','adjust_integral') AND outcome='finance-adjusted' THEN CASE WHEN kind='adjust_money' THEN evidence ?& ARRAY['changed','money_ledger_id','verified']::text[] AND evidence - ARRAY['changed','money_ledger_id','verified']::text[]='{}'::jsonb ELSE evidence ?& ARRAY['changed','integral_ledger_id','verified']::text[] AND evidence - ARRAY['changed','integral_ledger_id','verified']::text[]='{}'::jsonb END AND (CASE WHEN pg_catalog.jsonb_typeof(evidence->'changed') IS DISTINCT FROM 'number' THEN false WHEN (evidence->'changed' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE (evidence->'changed' #>> '{}')::numeric BETWEEN 0 AND 1 END) AND (CASE WHEN pg_catalog.jsonb_typeof(evidence->(CASE WHEN kind='adjust_money' THEN 'money_ledger_id' ELSE 'integral_ledger_id' END)) IS DISTINCT FROM 'number' THEN false WHEN (evidence->(CASE WHEN kind='adjust_money' THEN 'money_ledger_id' ELSE 'integral_ledger_id' END) #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE (evidence->(CASE WHEN kind='adjust_money' THEN 'money_ledger_id' ELSE 'integral_ledger_id' END) #>> '{}')::numeric BETWEEN 0 AND 2147483647 END) AND evidence->'verified'='true'::jsonb AND CASE WHEN evidence->'changed'='0'::jsonb THEN evidence->(CASE WHEN kind='adjust_money' THEN 'money_ledger_id' ELSE 'integral_ledger_id' END)='0'::jsonb ELSE evidence->(CASE WHEN kind='adjust_money' THEN 'money_ledger_id' ELSE 'integral_ledger_id' END)<>'0'::jsonb END
 ELSE false END,false))
);
CREATE INDEX cuo_actor_history ON public.customer_user_operation_request(actor_uid,created_at,request_key);
`;
export const CUSTOMER_USER_OPERATION_INSTALLATION_SQL = `
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
DO $cuo_install$
BEGIN
 IF current_setting('server_version_num')::int/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
 RAISE EXCEPTION 'Customer user installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_try_advisory_xact_lock(${CUSTOMER_USER_CATALOG_LOCK_KEY},0) THEN RAISE EXCEPTION 'Customer user installation already running'; END IF;
 IF to_regclass('public.customer_user_operation_request') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('customer_user_targets_valid_v1','customer_user_intent_valid_v1')) THEN
 RAISE EXCEPTION 'Existing customer user protocol requires exact catalog review, no reinstall'; END IF;
END $cuo_install$;
${CUSTOMER_USER_OPERATION_SQL}
`;
