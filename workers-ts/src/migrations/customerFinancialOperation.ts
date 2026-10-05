/** Explicit maintenance protocol. Customer finance has its own actor/UUID realm. */
const object = (value: string, keys: readonly string[]) =>
  `(CASE WHEN pg_catalog.jsonb_typeof(${value}) IS DISTINCT FROM 'object' THEN false ELSE ${value} ?& ARRAY[${keys.map(key => `'${key}'`).join(',')}]::text[] AND (${value})-ARRAY[${keys.map(key => `'${key}'`).join(',')}]::text[]='{}'::jsonb END)`;
const integer = (value: string, min = 1, max = 2147483647) =>
  `(CASE WHEN pg_catalog.jsonb_typeof(${value}) IS DISTINCT FROM 'number' THEN false WHEN (${value} #>> '{}') !~ '${min === 0 ? '^(0|[1-9][0-9]{0,9})$' : '^[1-9][0-9]{0,9}$'}' THEN false ELSE (${value} #>> '{}')::numeric BETWEEN ${min} AND ${max} END)`;
const numericValue = (value: string, min = 1) =>
  `(CASE WHEN ${integer(value, min)} THEN (${value} #>> '{}')::numeric ELSE NULL END)`;
const sha = (value: string) => `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^[a-f0-9]{64}$'`;
const money = (value: string) => `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'`;
// The same Unicode whitespace that ECMAScript trim removes. C0/DEL are rejected everywhere.
const whitespace = '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const text = (value: string, max: number) =>
  `pg_catalog.jsonb_typeof(${value})='string' AND pg_catalog.char_length(${value} #>> '{}') BETWEEN 1 AND ${max} AND (${value} #>> '{}') !~ '[\u0001-\u001f\u007f]' AND pg_catalog.btrim(${value} #>> '{}','${whitespace}')=(${value} #>> '{}')`;
const payload = "$2->'payload'";
const decision = `${payload}->'decision'`;
const decisionValid = `${object(decision, ['apply_type','refund_type','received'])} AND ${decision}->'apply_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb) AND ${decision}->'refund_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb,'4'::jsonb,'5'::jsonb) AND pg_catalog.jsonb_typeof(${decision}->'received')='boolean'`;
const refundIdentity = `${integer(`${payload}->'refund_id'`)} AND ${text(`${payload}->'refund_no'`,50)} AND ${sha(`${payload}->'expected_refund_revision'`)} AND ${sha(`${payload}->'review_fingerprint'`)}`;
const refundKeys = ['refund_id','refund_no','expected_refund_revision','review_fingerprint','decision'];
const itemsValid = `(CASE WHEN pg_catalog.jsonb_typeof(${payload}->'items') IS DISTINCT FROM 'array' THEN false ELSE pg_catalog.jsonb_array_length(${payload}->'items')<=100 AND NOT EXISTS(SELECT 1 FROM (SELECT value,pg_catalog.lag(value->'cart_row_id') OVER(ORDER BY ordinality) AS previous FROM pg_catalog.jsonb_array_elements(${payload}->'items') WITH ORDINALITY) item WHERE NOT(${object('value',['cart_row_id','cart_num'])} AND ${integer("value->'cart_row_id'")} AND ${integer("value->'cart_num'")}) OR (previous IS NOT NULL AND (NOT ${integer('previous')} OR ${numericValue('previous')}>=${numericValue("value->'cart_row_id'")}))) END)`;

export const CUSTOMER_FINANCIAL_INTENT_BODY = `
 SELECT COALESCE(CASE WHEN pg_catalog.jsonb_typeof($2) IS DISTINCT FROM 'object' THEN false
 WHEN NOT (${object('$2',['version','scope_key','order_id','expected_order_revision','expected_financial_revision','payload'])}) THEN false
 WHEN $2->'version' IS DISTINCT FROM '"customer-work-financial-operation-v1"'::jsonb
 OR NOT (${sha("$2->'scope_key'")} AND ${integer("$2->'order_id'")} AND ${sha("$2->'expected_order_revision'")} AND ${sha("$2->'expected_financial_revision'")})
 OR pg_catalog.jsonb_typeof(${payload}) IS DISTINCT FROM 'object' THEN false
 ELSE CASE $1
 WHEN 'change_price' THEN ${object(payload,['price'])} AND ${money(`${payload}->'price'`)}
 WHEN 'confirm_offline' THEN ${payload}='{}'::jsonb
 WHEN 'refund_create' THEN ${object(payload,['mode','items','quoted_price','refund_price','quote_fingerprint','reason'])}
   AND ${payload}->'mode' IN ('"remaining"'::jsonb,'"items"'::jsonb) AND ${itemsValid}
   AND (CASE WHEN pg_catalog.jsonb_typeof(${payload}->'items') IS DISTINCT FROM 'array' THEN false ELSE CASE WHEN ${payload}->'mode'='"remaining"'::jsonb THEN pg_catalog.jsonb_array_length(${payload}->'items')=0 ELSE pg_catalog.jsonb_array_length(${payload}->'items') BETWEEN 1 AND 100 END END)
   AND (CASE WHEN ${money(`${payload}->'quoted_price'`)} AND ${money(`${payload}->'refund_price'`)} THEN (${payload}->>'refund_price')::numeric<=(${payload}->>'quoted_price')::numeric ELSE false END)
   AND ${sha(`${payload}->'quote_fingerprint'`)} AND ${text(`${payload}->'reason'`,255)}
 WHEN 'refund_return' THEN ${object(payload,refundKeys)} AND ${refundIdentity} AND ${decisionValid}
   AND ${decision}->'apply_type' IN ('2'::jsonb,'3'::jsonb) AND ${decision}->'refund_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb)
 WHEN 'refund_refuse' THEN ${object(payload,[...refundKeys,'reason'])} AND ${refundIdentity} AND ${decisionValid} AND ${text(`${payload}->'reason'`,255)}
 WHEN 'refund_execute' THEN ${object(payload,[...refundKeys,'refund_price'])} AND ${refundIdentity} AND ${decisionValid} AND ${money(`${payload}->'refund_price'`)}
   AND ${decision}->'apply_type' IN ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)
   AND (CASE WHEN ${decision}->'apply_type' IN ('2'::jsonb,'3'::jsonb) THEN ${decision}->'received'='true'::jsonb AND ((${decision}->'apply_type'='2'::jsonb AND ${decision}->'refund_type'='5'::jsonb) OR (${decision}->'apply_type'='3'::jsonb AND ${decision}->'refund_type' IN ('4'::jsonb,'5'::jsonb))) ELSE true END)
 WHEN 'refund_remark' THEN ${object(payload,['refund_id','refund_no','expected_refund_revision','review_fingerprint','remark'])} AND ${refundIdentity} AND ${text(`${payload}->'remark'`,255)}
 ELSE false END END,false)
`;

const evidence = '$4';
const boundRefund = `${integer("$4->'refund_id'")} AND $4->'refund_id'=$3->'payload'->'refund_id'`;
const verified = "$4->'verified'='true'::jsonb";
const changed = `${integer("$4->'changed'",0,1)} AND ${verified}`;
const providerKeys = ['refund_id','refund_no','payment_order_id','uid','store_id','supplier_id','provider','out_refund_no','request_amount','total_amount','verified'];
export const CUSTOMER_FINANCIAL_EVIDENCE_BODY = `
 SELECT COALESCE(CASE WHEN NOT public.customer_financial_intent_valid_v1($1,$3) THEN false
 WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false
 WHEN $2='abandoned' THEN $4='{}'::jsonb
 WHEN $2='rollback-rejected' THEN ${object(evidence,['code'])} AND ${text("$4->'code'",128)}
 ELSE CASE $1
 WHEN 'change_price' THEN $2='price-changed' AND ${object(evidence,['changed','verified'])} AND ${changed}
 WHEN 'confirm_offline' THEN $2='offline-paid' AND ${object(evidence,['outbox_id','verified'])} AND ${integer("$4->'outbox_id'")} AND ${verified}
 WHEN 'refund_create' THEN $2='refund-created' AND ${object(evidence,['refund_id','refund_no','verified'])} AND ${integer("$4->'refund_id'")} AND ${text("$4->'refund_no'",32)} AND ${verified}
 WHEN 'refund_return' THEN $2='return-approved' AND ${object(evidence,['refund_id','changed','verified'])} AND ${boundRefund} AND ${changed}
 WHEN 'refund_refuse' THEN $2='refused' AND ${object(evidence,['refund_id','verified'])} AND ${boundRefund} AND ${verified}
 WHEN 'refund_execute' THEN CASE WHEN $2='balance-settled' THEN ${object(evidence,['refund_id','verified'])} AND ${boundRefund} AND ${verified}
   WHEN $2='provider-admitted' THEN ${object(evidence,providerKeys)} AND ${boundRefund} AND $4->'refund_no'=$3->'payload'->'refund_no'
   AND ${integer("$4->'payment_order_id'")} AND ${integer("$4->'uid'")} AND ${integer("$4->'store_id'",0)} AND ${integer("$4->'supplier_id'",0)}
   AND $4->'provider' IN ('"wechat"'::jsonb,'"alipay"'::jsonb)
   AND $4->'out_refund_no'=pg_catalog.to_jsonb('CNSR'||($4->>'refund_id'))
   AND ${integer("$4->'request_amount'")} AND ${integer("$4->'total_amount'")}
   AND ${numericValue("$4->'request_amount'")}<=${numericValue("$4->'total_amount'")}
   AND (CASE WHEN ${money("$3->'payload'->'refund_price'")} THEN ${numericValue("$4->'request_amount'")}=(($3->'payload'->>'refund_price')::numeric*100) ELSE false END) AND ${verified}
   ELSE false END
 WHEN 'refund_remark' THEN $2='refund-remark-saved' AND ${object(evidence,['refund_id','changed','verified'])} AND ${boundRefund} AND ${changed}
 ELSE false END END,false)
`;

export const CUSTOMER_FINANCIAL_OPERATION_SQL = `
 CREATE FUNCTION public.customer_financial_intent_valid_v1(text,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_financial_intent$${CUSTOMER_FINANCIAL_INTENT_BODY}$customer_financial_intent$;
 REVOKE ALL ON FUNCTION public.customer_financial_intent_valid_v1(text,jsonb) FROM PUBLIC;
 CREATE FUNCTION public.customer_financial_evidence_valid_v1(text,text,jsonb,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_financial_evidence$${CUSTOMER_FINANCIAL_EVIDENCE_BODY}$customer_financial_evidence$;
 REVOKE ALL ON FUNCTION public.customer_financial_evidence_valid_v1(text,text,jsonb,jsonb) FROM PUBLIC;
 CREATE TABLE public.customer_financial_operation_request(
 actor_uid integer NOT NULL,request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,
 service_id integer NOT NULL,order_id integer NOT NULL,kind varchar(32) NOT NULL,outcome varchar(32) NOT NULL,
 scope_key varchar(64) NOT NULL,expected_revision varchar(64) NOT NULL,expected_financial_revision varchar(64) NOT NULL,
 intent jsonb NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cfo_pk PRIMARY KEY(actor_uid,request_key),
 CONSTRAINT cfo_identity_ck CHECK(actor_uid>0 AND order_id>0 AND service_id>=0 AND ((outcome IN('abandoned','rollback-rejected') AND service_id=0) OR (outcome NOT IN('abandoned','rollback-rejected') AND service_id>0))),
 CONSTRAINT cfo_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT cfo_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_key ~ '^[a-f0-9]{64}$' AND expected_revision ~ '^[a-f0-9]{64}$' AND expected_financial_revision ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cfo_json_ck CHECK(jsonb_typeof(intent)='object' AND jsonb_typeof(evidence)='object' AND octet_length(intent::text)<=262144 AND octet_length(evidence::text)<=16384),
 CONSTRAINT cfo_intent_ck CHECK(public.customer_financial_intent_valid_v1(kind,intent) AND intent->'scope_key'=to_jsonb(scope_key) AND intent->'order_id'=to_jsonb(order_id) AND intent->'expected_order_revision'=to_jsonb(expected_revision) AND intent->'expected_financial_revision'=to_jsonb(expected_financial_revision)),
 CONSTRAINT cfo_kind_ck CHECK(kind IN('change_price','confirm_offline','refund_create','refund_return','refund_refuse','refund_execute','refund_remark')),
 CONSTRAINT cfo_outcome_ck CHECK(public.customer_financial_evidence_valid_v1(kind,outcome,intent,evidence))
 );
 CREATE INDEX cfo_actor_history ON public.customer_financial_operation_request(actor_uid,created_at,request_key);
`;
export const CUSTOMER_FINANCIAL_OPERATION_INSTALLATION_SQL = `
 SET LOCAL search_path=public,pg_temp;
 SET LOCAL row_security=off;
 DO $cfo_install$ BEGIN
 IF current_setting('server_version_num')::int/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'Customer financial installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_try_advisory_xact_lock(731665,0) THEN RAISE EXCEPTION 'Customer financial installation already running'; END IF;
 IF to_regclass('public.customer_financial_operation_request') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('customer_financial_intent_valid_v1','customer_financial_evidence_valid_v1')) THEN
 RAISE EXCEPTION 'Existing customer financial protocol requires exact catalog review, no reinstall'; END IF;
 END $cfo_install$;
 ${CUSTOMER_FINANCIAL_OPERATION_SQL}
`;
