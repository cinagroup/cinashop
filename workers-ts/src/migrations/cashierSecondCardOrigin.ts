/** Explicit customer cashier origin, draft and paid-receipt maintenance protocol. */
export const CASHIER_SECOND_CARD_MAINTENANCE_LOCK_KEY = 731685;
export const CASHIER_SECOND_CARD_REQUEST_LOCK_KEY = 731688;
export const CASHIER_SECOND_CARD_MAX_JSON_BYTES = 262144;
const object = (value: string, keys: readonly string[]) =>
  `(CASE WHEN pg_catalog.jsonb_typeof(${value}) IS DISTINCT FROM 'object' THEN false ELSE (${value}) ?& ARRAY[${keys.map(key => `'${key}'`).join(',')}]::text[] AND (${value})-ARRAY[${keys.map(key => `'${key}'`).join(',')}]::text[]='{}'::jsonb END)`;
const integer = (value: string, min = 1, max = 2147483647) =>
  `(CASE WHEN pg_catalog.jsonb_typeof(${value}) IS DISTINCT FROM 'number' THEN false WHEN (${value} #>> '{}') !~ '${min === 0 ? '^(0|[1-9][0-9]{0,9})$' : '^[1-9][0-9]{0,9}$'}' THEN false ELSE (${value} #>> '{}')::numeric BETWEEN ${min} AND ${max} END)`;
const numericValue = (value: string, min = 1) => `(CASE WHEN ${integer(value, min)} THEN (${value} #>> '{}')::numeric ELSE NULL END)`;
const sha = (value: string) => `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^[a-f0-9]{64}$'`;
const uuid = (value: string) => `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`;
const whitespace = '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const text = (value: string, max: number) => `pg_catalog.jsonb_typeof(${value})='string' AND pg_catalog.char_length(${value} #>> '{}') BETWEEN 1 AND ${max}
 AND (${value} #>> '{}') !~ '[\u0001-\u001f\u007f]' AND pg_catalog.btrim(${value} #>> '{}','${whitespace}')=(${value} #>> '{}')`;
const sn = (value: string) => `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^[A-Za-z0-9_-]{1,32}$'`;
const money = (value: string) => `pg_catalog.jsonb_typeof(${value})='string' AND (${value} #>> '{}') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'`;
const bytesHash = (value: string) => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${value},'UTF8')),'hex')`;
export const CASHIER_SECOND_CARD_EMPTY_TOURIST_HASH_SQL = bytesHash(`'""'`);
const originKeys = ['version', 'creator_kind', 'creator_uid', 'service_id', 'buyer_uid', 'scope_key', 'root_order_id', 'root_order_no',
  'creation_key', 'creation_hash', 'quote_fingerprint', 'creation_status_id', 'cart_facts'];
const cartKeys = ['cart_row_id', 'opaque_cart_id', 'product_id', 'product_type', 'owner_type', 'owner_id', 'sku_unique', 'purchase_quantity', 'write_times', 'snapshot_hash'];
const cart = "$2->'cart_facts'->0";
// All keys are fixed ASCII names. Each scalar jsonb::text is its canonical JSON
// string/integer representation, with no object whitespace or key-order guess.
const canonicalObject = (value: string, keys: readonly string[], substitutions: Readonly<Record<string, string>> = {}) =>
  `('{'||${[...keys].sort().map((key, index) => `'${index ? ',' : ''}"${key}":'||${substitutions[key] ?? `((${value})->'${key}')::text`}`).join('||')}||'}')`;
export const CASHIER_SECOND_CARD_CANONICAL_ORIGIN_SQL = canonicalObject('$2', originKeys,
  { cart_facts: `('['||${canonicalObject(cart, cartKeys)}||']')` });
const cartValid = `${object(cart, cartKeys)} AND ${integer(`${cart}->'cart_row_id'`)} AND ${text(`${cart}->'opaque_cart_id'`, 64)}
 AND ${integer(`${cart}->'product_id'`)} AND ${cart}->'product_type'='4'::jsonb AND ${integer(`${cart}->'owner_type'`, 0, 2)} AND ${integer(`${cart}->'owner_id'`, 0)}
 AND (CASE WHEN ${cart}->'owner_type'='0'::jsonb THEN ${cart}->'owner_id'='0'::jsonb ELSE ${integer(`${cart}->'owner_id'`)} END)
 AND ${text(`${cart}->'sku_unique'`, 64)} AND ${integer(`${cart}->'purchase_quantity'`)} AND ${integer(`${cart}->'write_times'`)}
 AND ${numericValue(`${cart}->'write_times'`)} % ${numericValue(`${cart}->'purchase_quantity'`)}=0 AND ${sha(`${cart}->'snapshot_hash'`)}`;
export const CASHIER_SECOND_CARD_ORIGIN_BODY = `
 SELECT COALESCE(CASE WHEN $1 IS NULL OR $1 !~ '^[a-f0-9]{64}$' THEN false
 WHEN NOT (${object('$2', originKeys)}) OR pg_catalog.octet_length($2::text)>${CASHIER_SECOND_CARD_MAX_JSON_BYTES} THEN false
 WHEN $2->'version' IS DISTINCT FROM '"cashier-second-card-origin-v1"'::jsonb OR $2->'creator_kind' IS DISTINCT FROM '"customer"'::jsonb THEN false
 WHEN pg_catalog.jsonb_typeof($2->'cart_facts') IS DISTINCT FROM 'array' THEN false
 WHEN pg_catalog.jsonb_array_length($2->'cart_facts')<>1 THEN false
 ELSE ${integer("$2->'creator_uid'")} AND ${integer("$2->'service_id'")} AND ${integer("$2->'buyer_uid'", 0)} AND ${sha("$2->'scope_key'")}
 AND ${integer("$2->'root_order_id'")} AND ${sn("$2->'root_order_no'")} AND ${uuid("$2->'creation_key'")}
 AND ${sha("$2->'creation_hash'")} AND ${sha("$2->'quote_fingerprint'")} AND ${integer("$2->'creation_status_id'")}
 AND ${cartValid} AND $1=${bytesHash(CASHIER_SECOND_CARD_CANONICAL_ORIGIN_SQL)} END,false)
`;

const paymentKeys = ['version', 'order_id', 'order_no', 'buyer_uid', 'creator_uid', 'paid', 'pay_type', 'pay_time', 'amount', 'trade_no',
  'status_id', 'outbox_id', 'event_key', 'payload_hash', 'origin_hash'];
export const CASHIER_SECOND_CARD_PAYMENT_BODY = `
 SELECT COALESCE(CASE WHEN $1 NOT IN('cash','zero') OR $1 IS NULL THEN false
 WHEN NOT (${object('$2', paymentKeys)}) OR pg_catalog.octet_length($2::text)>${CASHIER_SECOND_CARD_MAX_JSON_BYTES} THEN false
 WHEN $2->'version' IS DISTINCT FROM '"cashier-second-card-payment-v1"'::jsonb THEN false
 ELSE ${integer("$2->'order_id'")} AND ${sn("$2->'order_no'")} AND ${integer("$2->'buyer_uid'", 0)} AND ${integer("$2->'creator_uid'")}
 AND $2->'paid'='1'::jsonb AND $2->'pay_type'='"cash"'::jsonb AND ${integer("$2->'pay_time'")}
 AND ${money("$2->'amount'")} AND (CASE WHEN $1='zero' THEN $2->'amount'='"0.00"'::jsonb
 ELSE CASE WHEN ${money("$2->'amount'")} THEN ($2->>'amount')::numeric>0 ELSE false END END)
 AND $2->'trade_no'='""'::jsonb AND ${integer("$2->'status_id'")} AND ${integer("$2->'outbox_id'")}
 AND $2->'event_key'=pg_catalog.to_jsonb('order.paid:'||($2->>'order_id'))
 AND ${sha("$2->'payload_hash'")} AND ${sha("$2->'origin_hash'")} END,false)
`;

export const CASHIER_SECOND_CARD_ORIGIN_SQL = `
 CREATE FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $cashier_second_card_origin$${CASHIER_SECOND_CARD_ORIGIN_BODY}$cashier_second_card_origin$;
 REVOKE ALL ON FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb) FROM PUBLIC;
 CREATE FUNCTION public.cashier_second_card_payment_valid_v1(text,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $cashier_second_card_payment$${CASHIER_SECOND_CARD_PAYMENT_BODY}$cashier_second_card_payment$;
 REVOKE ALL ON FUNCTION public.cashier_second_card_payment_valid_v1(text,jsonb) FROM PUBLIC;
 CREATE TABLE public.cashier_second_card_cart_v1(
 actor_uid integer NOT NULL,buyer_uid integer NOT NULL,cart_id integer NOT NULL,
 request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,tourist_hash varchar(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cscc_pk PRIMARY KEY(actor_uid,request_key),CONSTRAINT cscc_cart_uq UNIQUE(cart_id),
 CONSTRAINT cscc_identity_ck CHECK(actor_uid>0 AND buyer_uid>=0 AND cart_id>0),
 CONSTRAINT cscc_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT cscc_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND tourist_hash ~ '^[a-f0-9]{64}$'
 AND ((buyer_uid=0 AND tourist_hash<>${CASHIER_SECOND_CARD_EMPTY_TOURIST_HASH_SQL}) OR (buyer_uid>0 AND tourist_hash=${CASHIER_SECOND_CARD_EMPTY_TOURIST_HASH_SQL})))
 );
 CREATE INDEX cscc_actor_history ON public.cashier_second_card_cart_v1(actor_uid,created_at,request_key);
 CREATE TABLE public.cashier_second_card_origin_v1(
 order_id integer NOT NULL,actor_uid integer NOT NULL,service_id integer NOT NULL,buyer_uid integer NOT NULL,
 request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,scope_key varchar(64) NOT NULL,origin_hash varchar(64) NOT NULL,
 origin jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT csco_pk PRIMARY KEY(order_id),CONSTRAINT csco_actor_key_uq UNIQUE(actor_uid,request_key),
 CONSTRAINT csco_identity_ck CHECK(order_id>0 AND actor_uid>0 AND service_id>0 AND buyer_uid>=0),
 CONSTRAINT csco_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT csco_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_key ~ '^[a-f0-9]{64}$' AND origin_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT csco_origin_ck CHECK(public.cashier_second_card_origin_valid_v1(origin_hash,origin)
 AND origin->'root_order_id'=pg_catalog.to_jsonb(order_id) AND origin->'creator_uid'=pg_catalog.to_jsonb(actor_uid)
 AND origin->'service_id'=pg_catalog.to_jsonb(service_id) AND origin->'buyer_uid'=pg_catalog.to_jsonb(buyer_uid)
 AND origin->'creation_key'=pg_catalog.to_jsonb(request_key::text) AND origin->'creation_hash'=pg_catalog.to_jsonb(request_hash)
 AND origin->'scope_key'=pg_catalog.to_jsonb(scope_key))
 );
 CREATE INDEX csco_actor_history ON public.cashier_second_card_origin_v1(actor_uid,created_at,request_key);
 CREATE TABLE public.cashier_second_card_payment_v1(
 order_id integer NOT NULL,actor_uid integer NOT NULL,service_id integer NOT NULL,request_key uuid NOT NULL,
 request_hash varchar(64) NOT NULL,scope_key varchar(64) NOT NULL,amount varchar(13) NOT NULL,payment_kind varchar(8) NOT NULL,
 order_paid_status_id integer NOT NULL,outbox_id integer NOT NULL,evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cscp_pk PRIMARY KEY(actor_uid,request_key),CONSTRAINT cscp_order_uq UNIQUE(order_id),
 CONSTRAINT cscp_identity_ck CHECK(order_id>0 AND actor_uid>0 AND service_id>0 AND order_paid_status_id>0 AND outbox_id>0),
 CONSTRAINT cscp_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT cscp_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_key ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cscp_evidence_ck CHECK(public.cashier_second_card_payment_valid_v1(payment_kind,evidence)
 AND evidence->'order_id'=pg_catalog.to_jsonb(order_id) AND evidence->'creator_uid'=pg_catalog.to_jsonb(actor_uid)
 AND evidence->'amount'=pg_catalog.to_jsonb(amount) AND evidence->'status_id'=pg_catalog.to_jsonb(order_paid_status_id)
 AND evidence->'outbox_id'=pg_catalog.to_jsonb(outbox_id))
 );
 CREATE INDEX cscp_actor_history ON public.cashier_second_card_payment_v1(actor_uid,created_at,request_key);
`;

export const CASHIER_SECOND_CARD_ORIGIN_INSTALLATION_SQL = `
 SET LOCAL search_path=public,pg_temp;
 SET LOCAL row_security=off;
 DO $csc_install$ BEGIN
 IF current_setting('server_version_num')::integer/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'Cashier second card installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock(${CASHIER_SECOND_CARD_MAINTENANCE_LOCK_KEY},0) THEN RAISE EXCEPTION 'Cashier second card installation already running'; END IF;
 IF to_regclass('public.cashier_second_card_origin_v1') IS NOT NULL OR to_regclass('public.cashier_second_card_cart_v1') IS NOT NULL
 OR to_regclass('public.cashier_second_card_payment_v1') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN('cashier_second_card_origin_valid_v1','cashier_second_card_payment_valid_v1')) THEN
 RAISE EXCEPTION 'Existing cashier second card protocol requires exact catalog review, no reinstall'; END IF;
 END $csc_install$;
 ${CASHIER_SECOND_CARD_ORIGIN_SQL}
`;
