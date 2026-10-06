/** Independent immutable receipt realm for ordinary customer writeoff. */
export const CUSTOMER_WRITEOFF_MAINTENANCE_LOCK_KEY = 731675;
export const CUSTOMER_WRITEOFF_REQUEST_LOCK_KEY = 731678;
export const CUSTOMER_WRITEOFF_MAX_JSON_BYTES = 262144;

const object = (value: string, keys: readonly string[]) =>
  `(CASE WHEN pg_catalog.jsonb_typeof(${value}) IS DISTINCT FROM 'object' THEN false ELSE (${value}) ?& ARRAY[${keys.map(key => `'${key}'`).join(',')}]::text[] AND (${value})-ARRAY[${keys.map(key => `'${key}'`).join(',')}]::text[]='{}'::jsonb END)`;
const integer = (value: string, min = 1, max = 2147483647) =>
  `(CASE WHEN pg_catalog.jsonb_typeof(${value}) IS DISTINCT FROM 'number' THEN false WHEN (${value} #>> '{}') !~ '${min === 0 ? '^(0|[1-9][0-9]{0,9})$' : '^[1-9][0-9]{0,9}$'}' THEN false ELSE (${value} #>> '{}')::numeric BETWEEN ${min} AND ${max} END)`;
const numericValue = (value: string, min = 1) =>
  `(CASE WHEN ${integer(value, min)} THEN (${value} #>> '{}')::numeric ELSE NULL END)`;
const sha = (value: string) => `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^[a-f0-9]{64}$'`;
const money = (value: string) => `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'`;
const whitespace = '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const text = (value: string, max: number) =>
  `pg_catalog.jsonb_typeof(${value})='string' AND pg_catalog.char_length(${value} #>> '{}') BETWEEN 1 AND ${max} AND (${value} #>> '{}') !~ '[\u0001-\u001f\u007f]' AND pg_catalog.btrim(${value} #>> '{}','${whitespace}')=(${value} #>> '{}')`;
const sn = (value: string) => `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^[A-Za-z0-9_-]{1,32}$'`;
const array = (value: string) => `(CASE WHEN pg_catalog.jsonb_typeof(${value})='array' THEN ${value} ELSE '[]'::jsonb END)`;
// The code is an ASCII string: jsonb::text exactly matches canonicalJson(string).
const stringHash = (value: string) => `pg_catalog.to_jsonb(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((${value})::text,'UTF8')),'hex'))`;
const payload = "$2->'payload'";
const items = `${payload}->'items'`;
const itemsValid = `(CASE WHEN pg_catalog.jsonb_typeof(${items}) IS DISTINCT FROM 'array' THEN false ELSE
 pg_catalog.jsonb_array_length(${items}) BETWEEN 1 AND 200 AND NOT EXISTS(
 SELECT 1 FROM (SELECT value,pg_catalog.lag(value->'cart_row_id') OVER(ORDER BY ordinality) AS previous
 FROM pg_catalog.jsonb_array_elements(${array(items)}) WITH ORDINALITY) item
 WHERE (${object('value', ['cart_row_id', 'writeoff_num'])} AND ${integer("value->'cart_row_id'")} AND ${integer("value->'writeoff_num'")}) IS DISTINCT FROM true
 OR (previous IS NOT NULL AND (NOT ${integer('previous')} OR ${numericValue('previous')}>=${numericValue("value->'cart_row_id'")}))) END)`;

export const CUSTOMER_WRITEOFF_INTENT_BODY = `
 SELECT COALESCE(CASE WHEN $1 IS DISTINCT FROM 'writeoff' THEN false
 WHEN NOT (${object('$2', ['version', 'scope_key', 'order_id', 'expected_order_revision', 'expected_writeoff_revision', 'payload'])}) THEN false
 WHEN $2->'version' IS DISTINCT FROM '"customer-work-writeoff-operation-v1"'::jsonb
 OR NOT (${sha("$2->'scope_key'")} AND ${integer("$2->'order_id'")} AND ${sha("$2->'expected_order_revision'")} AND ${sha("$2->'expected_writeoff_revision'")}) THEN false
 WHEN NOT (${object(payload, ['order_no', 'root_order_id', 'root_order_no', 'code', 'target_fingerprint', 'items'])}) THEN false
 ELSE ${sn(`${payload}->'order_no'`)} AND ${integer(`${payload}->'root_order_id'`)} AND ${sn(`${payload}->'root_order_no'`)}
 AND pg_catalog.jsonb_typeof(${payload}->'code')='string' AND (${payload}->>'code') ~ '^[0-9]{12}$'
 AND ${sha(`${payload}->'target_fingerprint'`)} AND ${itemsValid}
 AND pg_catalog.octet_length($2::text)<=${CUSTOMER_WRITEOFF_MAX_JSON_BYTES} END,false)
`;

const evidence = '$4';
const writeoffRows = "$4->'writeoff_rows'";
const rowKeys = ['writeoff_id', 'cart_row_id', 'opaque_cart_id', 'quantity', 'before_remaining', 'after_remaining', 'writeoff_price', 'snapshot_hash', 'sale_price_hash'];
const writeoffRowsValid = `(CASE WHEN pg_catalog.jsonb_typeof(${writeoffRows}) IS DISTINCT FROM 'array' THEN false ELSE
 pg_catalog.jsonb_array_length(${writeoffRows})=pg_catalog.jsonb_array_length($3->'payload'->'items')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(${array(writeoffRows)}) WITH ORDINALITY AS r(value,ordinality)
 WHERE (${object('value', rowKeys)} AND ${integer("value->'writeoff_id'")} AND ${integer("value->'cart_row_id'")}
 AND ${text("value->'opaque_cart_id'", 128)} AND ${integer("value->'quantity'")} AND ${integer("value->'before_remaining'")}
 AND ${integer("value->'after_remaining'", 0)} AND ${money("value->'writeoff_price'")} AND ${sha("value->'snapshot_hash'")} AND ${sha("value->'sale_price_hash'")}
 AND ${numericValue("value->'before_remaining'")}-${numericValue("value->'after_remaining'", 0)}=${numericValue("value->'quantity'")}
 AND value->'cart_row_id'=($3->'payload'->'items')->(ordinality::integer-1)->'cart_row_id'
 AND value->'quantity'=($3->'payload'->'items')->(ordinality::integer-1)->'writeoff_num') IS DISTINCT FROM true)
 AND (SELECT count(*)=count(DISTINCT value->'writeoff_id') FROM pg_catalog.jsonb_array_elements(${array(writeoffRows)})) END)`;

const ascii = (value: string, max: number, empty = false, punctuation = false) =>
  `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^[A-Za-z0-9_${punctuation ? '.:' : ''}-]{${empty ? 0 : 1},${max}}$'`;
const link = (value: string) => `(CASE WHEN pg_catalog.jsonb_typeof(${value}) IS DISTINCT FROM 'string' THEN false
 WHEN (${value} #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (${value} #>> '{}')::numeric<=2147483647 END)`;
const sortedRows = (value: string, keys: readonly string[], valid: string, max: number, id = 'row_id') =>
  `(CASE WHEN pg_catalog.jsonb_typeof(${value}) IS DISTINCT FROM 'array' THEN false ELSE
 pg_catalog.jsonb_array_length(${value})<=${max} AND NOT EXISTS(SELECT 1 FROM
 (SELECT value,pg_catalog.lag(value->'${id}') OVER(ORDER BY ordinality) AS previous FROM pg_catalog.jsonb_array_elements(${array(value)}) WITH ORDINALITY) r
 WHERE (${object('value', keys)} AND ${integer(`value->'${id}'`)} AND ${valid}) IS DISTINCT FROM true
 OR (previous IS NOT NULL AND (NOT ${integer('previous')} OR ${numericValue('previous')}>=${numericValue(`value->'${id}'`)}))) END)`;
const settlement = "$4->'settlement'";
const accountRows = `${settlement}->'account_deltas'`;
const accountHasUid = `EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(${array(accountRows)}) AS accounts(account) WHERE account->'uid'=value->'uid')`;
const supplierRowsValid = sortedRows(`${settlement}->'supplier_rows'`, ['row_id', 'before_status', 'after_status', 'amount', 'pm', 'type'],
  `${integer("value->'before_status'", 0, 1)} AND value->'after_status'='1'::jsonb AND ${money("value->'amount'")}
 AND ${integer("value->'pm'", 0, 1)} AND value->'type' IN('1'::jsonb,'2'::jsonb)`, 200);
const rewardRowsValid = sortedRows(`${settlement}->'reward_rows'`, ['row_id', 'uid', 'link_id', 'category', 'event_key', 'type', 'pm', 'amount', 'balance'],
  `${integer("value->'uid'")} AND ${link("value->'link_id'")} AND value->'category' IN('"integral"'::jsonb,'"exp"'::jsonb)
 AND ${ascii("value->'event_key'", 64)} AND ${ascii("value->'type'", 64)} AND ${integer("value->'pm'", 0, 1)}
 AND ${money("value->'amount'")} AND ${money("value->'balance'")} AND ${accountHasUid}`, 200);
const brokerageRowsValid = sortedRows(`${settlement}->'brokerage_rows'`, ['row_id', 'uid', 'link_id', 'type', 'source_type', 'pm', 'amount', 'balance'],
  `${integer("value->'uid'")} AND ${link("value->'link_id'")} AND ${ascii("value->'type'", 64)} AND ${ascii("value->'source_type'", 64, true)}
 AND ${integer("value->'pm'", 0, 1)} AND ${money("value->'amount'")} AND ${money("value->'balance'")} AND ${accountHasUid}`, 200);
const accountRowsValid = sortedRows(accountRows, ['uid', 'integral_before', 'integral_after', 'exp_before', 'exp_after', 'brokerage_before', 'brokerage_after'],
  `${integer("value->'integral_before'", 0)} AND ${integer("value->'integral_after'", 0)}
 AND ${money("value->'exp_before'")} AND ${money("value->'exp_after'")} AND ${money("value->'brokerage_before'")} AND ${money("value->'brokerage_after'")}`, 70, 'uid');
const paidRoot = `${settlement}->'paid_root'`;
const paidRootValid = `${object(paidRoot, ['order_id', 'order_no', 'uid', 'pay_type', 'pay_price', 'paid', 'identity_hash'])}
 AND ${integer(`${paidRoot}->'order_id'`)} AND ${paidRoot}->'order_id'=$3->'payload'->'root_order_id'
 AND ${sn(`${paidRoot}->'order_no'`)} AND ${paidRoot}->'order_no'=$3->'payload'->'root_order_no'
 AND ${integer(`${paidRoot}->'uid'`, 0)} AND ${ascii(`${paidRoot}->'pay_type'`, 32)} AND ${money(`${paidRoot}->'pay_price'`)}
 AND ${paidRoot}->'paid'='1'::jsonb AND ${sha(`${paidRoot}->'identity_hash'`)}`;
const paidOutboxRowsValid = sortedRows(`${settlement}->'paid_outbox_rows'`, ['row_id', 'event_key', 'event_type', 'payload_hash'],
  `${ascii("value->'event_key'", 128, false, true)} AND value->'event_type'='"order.paid"'::jsonb AND ${sha("value->'payload_hash'")}`, 200);
const settlementValid = `${object(settlement, ['version', 'take_delivery_status_id', 'supplier_rows', 'reward_rows', 'brokerage_rows', 'account_deltas', 'paid_root', 'paid_outbox_rows', 'new_paid_outbox_count'])}
 AND ${settlement}->'version'='"customer-writeoff-settlement-v1"'::jsonb AND ${integer(`${settlement}->'take_delivery_status_id'`)}
 AND ${settlement}->'new_paid_outbox_count'='0'::jsonb AND ${supplierRowsValid} AND ${rewardRowsValid} AND ${brokerageRowsValid}
 AND ${accountRowsValid} AND ${paidRootValid} AND ${paidOutboxRowsValid}`;
const emptyCodeHash = stringHash(`'""'::jsonb`);

export const CUSTOMER_WRITEOFF_EVIDENCE_BODY = `
 SELECT COALESCE(CASE WHEN NOT public.customer_writeoff_intent_valid_v1($1,$3) THEN false
 WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' OR pg_catalog.octet_length($4::text)>${CUSTOMER_WRITEOFF_MAX_JSON_BYTES} THEN false
 WHEN $2='abandoned' THEN $4='{}'::jsonb
 WHEN $2='rollback-rejected' THEN ${object(evidence, ['code'])} AND ${ascii("$4->'code'", 128)}
 WHEN $2 NOT IN('partial-writtenoff','written-off') OR $2 IS NULL THEN false
 WHEN NOT (${object(evidence, ['verified', 'order_completed', 'status', 'physical_order_id', 'root_order_id', 'writeoff_rows', 'before_code_hash', 'after_code_hash', 'post_order_revision', 'post_writeoff_revision', 'settlement'])}) THEN false
 ELSE $4->'verified'='true'::jsonb AND ${integer("$4->'physical_order_id'")} AND $4->'physical_order_id'=$3->'order_id'
 AND ${integer("$4->'root_order_id'")} AND $4->'root_order_id'=$3->'payload'->'root_order_id'
 AND ${sha("$4->'before_code_hash'")} AND $4->'before_code_hash'=${stringHash("$3->'payload'->'code'")}
 AND ${sha("$4->'after_code_hash'")} AND ${sha("$4->'post_order_revision'")} AND ${sha("$4->'post_writeoff_revision'")}
 AND ${writeoffRowsValid} AND (CASE WHEN $2='partial-writtenoff' THEN $4->'status'='5'::jsonb AND $4->'order_completed'='false'::jsonb
 AND $4->'settlement'='null'::jsonb AND $4->'after_code_hash'<>$4->'before_code_hash' AND $4->'after_code_hash'<>${emptyCodeHash}
 ELSE $4->'status'='2'::jsonb AND $4->'order_completed'='true'::jsonb AND $4->'after_code_hash'=${emptyCodeHash}
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(${array(writeoffRows)}) r WHERE r->'after_remaining' IS DISTINCT FROM '0'::jsonb)
 AND ${settlementValid} END) END,false)
`;

export const CUSTOMER_WRITEOFF_OPERATION_SQL = `
 CREATE FUNCTION public.customer_writeoff_intent_valid_v1(text,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_writeoff_intent$${CUSTOMER_WRITEOFF_INTENT_BODY}$customer_writeoff_intent$;
 REVOKE ALL ON FUNCTION public.customer_writeoff_intent_valid_v1(text,jsonb) FROM PUBLIC;
 CREATE FUNCTION public.customer_writeoff_evidence_valid_v1(text,text,jsonb,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_writeoff_evidence$${CUSTOMER_WRITEOFF_EVIDENCE_BODY}$customer_writeoff_evidence$;
 REVOKE ALL ON FUNCTION public.customer_writeoff_evidence_valid_v1(text,text,jsonb,jsonb) FROM PUBLIC;
 CREATE TABLE public.customer_writeoff_operation_request(
 actor_uid integer NOT NULL,request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,
 service_id integer NOT NULL,order_id integer NOT NULL,kind varchar(32) NOT NULL,outcome varchar(32) NOT NULL,
 scope_key varchar(64) NOT NULL,expected_revision varchar(64) NOT NULL,expected_writeoff_revision varchar(64) NOT NULL,
 intent jsonb NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cwo_pk PRIMARY KEY(actor_uid,request_key),
 CONSTRAINT cwo_identity_ck CHECK(actor_uid>0 AND order_id>0 AND service_id>=0 AND ((outcome IN('abandoned','rollback-rejected') AND service_id=0) OR (outcome IN('partial-writtenoff','written-off') AND service_id>0))),
 CONSTRAINT cwo_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT cwo_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_key ~ '^[a-f0-9]{64}$' AND expected_revision ~ '^[a-f0-9]{64}$' AND expected_writeoff_revision ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cwo_json_ck CHECK(pg_catalog.jsonb_typeof(intent)='object' AND pg_catalog.jsonb_typeof(evidence)='object' AND pg_catalog.octet_length(intent::text)<=${CUSTOMER_WRITEOFF_MAX_JSON_BYTES} AND pg_catalog.octet_length(evidence::text)<=${CUSTOMER_WRITEOFF_MAX_JSON_BYTES}),
 CONSTRAINT cwo_intent_ck CHECK(public.customer_writeoff_intent_valid_v1(kind,intent) AND intent->'scope_key'=pg_catalog.to_jsonb(scope_key) AND intent->'order_id'=pg_catalog.to_jsonb(order_id) AND intent->'expected_order_revision'=pg_catalog.to_jsonb(expected_revision) AND intent->'expected_writeoff_revision'=pg_catalog.to_jsonb(expected_writeoff_revision)),
 CONSTRAINT cwo_kind_ck CHECK(kind='writeoff'),
 CONSTRAINT cwo_outcome_ck CHECK(public.customer_writeoff_evidence_valid_v1(kind,outcome,intent,evidence))
 );
 CREATE INDEX cwo_actor_history ON public.customer_writeoff_operation_request(actor_uid,created_at,request_key);
`;

export const CUSTOMER_WRITEOFF_OPERATION_INSTALLATION_SQL = `
 SET LOCAL search_path=public,pg_temp;
 SET LOCAL row_security=off;
 DO $cwo_install$ BEGIN
 IF current_setting('server_version_num')::integer/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'Customer writeoff installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock(${CUSTOMER_WRITEOFF_MAINTENANCE_LOCK_KEY},0) THEN RAISE EXCEPTION 'Customer writeoff installation already running'; END IF;
 IF to_regclass('public.customer_writeoff_operation_request') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('customer_writeoff_intent_valid_v1','customer_writeoff_evidence_valid_v1')) THEN
 RAISE EXCEPTION 'Existing customer writeoff protocol requires exact catalog review, no reinstall'; END IF;
 END $cwo_install$;
 ${CUSTOMER_WRITEOFF_OPERATION_SQL}
`;
