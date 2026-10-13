/** Independent ordinary Customer cashier commissioning. Never installed by
 * application startup or the numbered runAll migration sequence. */
export const CASHIER_ORDINARY_MAINTENANCE_LOCK = 731734;
export const CASHIER_ORDINARY_TABLES = ['cashier_ordinary_draft_v1', 'cashier_ordinary_cart_v1',
  'cashier_ordinary_operation_v1', 'cashier_ordinary_origin_v1'] as const;
const uuid = (column: string) => `${column}::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`;
const hash = (column: string) => `${column} ~ '^[a-f0-9]{64}$'`;
export const CASHIER_ORDINARY_PROTECT_BODY = `BEGIN RAISE EXCEPTION 'ordinary cashier source and operation receipts are append-only'; END`;
export const CASHIER_ORDINARY_SQL = `
 CREATE TABLE public.cashier_ordinary_draft_v1(
 actor_uid integer NOT NULL,draft_key uuid NOT NULL,buyer_uid integer NOT NULL,tourist_hash varchar(64) NOT NULL,
 scope_key varchar(64) NOT NULL,request_hash varchar(64) NOT NULL,intent_json text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cod_pk PRIMARY KEY(actor_uid,draft_key),
 CONSTRAINT cod_ids_ck CHECK(actor_uid>0 AND buyer_uid>=0 AND ${uuid('draft_key')}),
 CONSTRAINT cod_hashes_ck CHECK(${hash('tourist_hash')} AND ${hash('scope_key')} AND ${hash('request_hash')}
  AND request_hash=encode(sha256(convert_to(intent_json,'UTF8')),'hex')),
 CONSTRAINT cod_intent_ck CHECK(octet_length(intent_json) BETWEEN 2 AND 262144 AND jsonb_typeof(intent_json::jsonb)='object')
 );
 CREATE TABLE public.cashier_ordinary_cart_v1(
 cart_id integer NOT NULL,actor_uid integer NOT NULL,draft_key uuid NOT NULL,product_id integer NOT NULL,
 sku_unique varchar(16) NOT NULL,created_quantity integer NOT NULL,source_json text NOT NULL,source_hash varchar(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT coc_pk PRIMARY KEY(cart_id),CONSTRAINT coc_selection_uq UNIQUE(actor_uid,draft_key,product_id,sku_unique),
 CONSTRAINT coc_ids_ck CHECK(cart_id>0 AND actor_uid>0 AND product_id>0 AND ${uuid('draft_key')}),
 CONSTRAINT coc_quantity_ck CHECK(created_quantity BETWEEN 1 AND 32767 AND char_length(sku_unique) BETWEEN 1 AND 16),
 CONSTRAINT coc_source_ck CHECK(octet_length(source_json) BETWEEN 2 AND 4096 AND jsonb_typeof(source_json::jsonb)='object'
  AND ${hash('source_hash')} AND source_hash=encode(sha256(convert_to(source_json,'UTF8')),'hex')),
 CONSTRAINT coc_draft_fk FOREIGN KEY(actor_uid,draft_key) REFERENCES public.cashier_ordinary_draft_v1(actor_uid,draft_key)
 );
 CREATE TABLE public.cashier_ordinary_operation_v1(
 actor_uid integer NOT NULL,request_key uuid NOT NULL,kind varchar(12) NOT NULL,request_hash varchar(64) NOT NULL,
 scope_key varchar(64) NOT NULL,draft_key uuid,order_id integer,intent_json text NOT NULL,evidence_json text NOT NULL,evidence_hash varchar(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT coo_pk PRIMARY KEY(actor_uid,request_key),
 CONSTRAINT coo_ids_ck CHECK(actor_uid>0 AND ${uuid('request_key')} AND (draft_key IS NULL OR ${uuid('draft_key')}) AND (order_id IS NULL OR order_id>0)),
 CONSTRAINT coo_kind_ck CHECK(kind IN('draft','append','quantity','remove','creation','payment','abandon')),
 CONSTRAINT coo_hashes_ck CHECK(${hash('request_hash')} AND ${hash('scope_key')} AND ${hash('evidence_hash')}
  AND request_hash=encode(sha256(convert_to(intent_json,'UTF8')),'hex') AND evidence_hash=encode(sha256(convert_to(evidence_json,'UTF8')),'hex')),
 CONSTRAINT coo_payload_ck CHECK(octet_length(intent_json) BETWEEN 2 AND 262144 AND octet_length(evidence_json) BETWEEN 2 AND 262144
  AND jsonb_typeof(intent_json::jsonb)='object' AND jsonb_typeof(evidence_json::jsonb)='object')
 );
 CREATE INDEX coo_draft_history ON public.cashier_ordinary_operation_v1(actor_uid,draft_key,created_at,request_key);
 CREATE UNIQUE INDEX coo_payment_order_uq ON public.cashier_ordinary_operation_v1(order_id) WHERE kind='payment';
 CREATE TABLE public.cashier_ordinary_origin_v1(
 order_id integer NOT NULL,actor_uid integer NOT NULL,service_id integer NOT NULL,buyer_uid integer NOT NULL,
 request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,scope_key varchar(64) NOT NULL,
 origin_json text NOT NULL,origin_hash varchar(64) NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT coorig_pk PRIMARY KEY(order_id),CONSTRAINT coorig_request_uq UNIQUE(actor_uid,request_key),
 CONSTRAINT coorig_ids_ck CHECK(order_id>0 AND actor_uid>0 AND service_id>0 AND buyer_uid>=0 AND ${uuid('request_key')}),
 CONSTRAINT coorig_hashes_ck CHECK(${hash('request_hash')} AND ${hash('scope_key')} AND ${hash('origin_hash')}
  AND origin_hash=encode(sha256(convert_to(origin_json,'UTF8')),'hex')),
 CONSTRAINT coorig_payload_ck CHECK(octet_length(origin_json) BETWEEN 2 AND 262144 AND jsonb_typeof(origin_json::jsonb)='object')
 );
 CREATE FUNCTION public.protect_cashier_ordinary_v1() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,pg_temp AS $ordinary_protect$${CASHIER_ORDINARY_PROTECT_BODY}$ordinary_protect$;
 REVOKE ALL ON FUNCTION public.protect_cashier_ordinary_v1() FROM PUBLIC;
 ${CASHIER_ORDINARY_TABLES.map(table => `REVOKE ALL ON public.${table} FROM PUBLIC;
 CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.${table}
 FOR EACH STATEMENT EXECUTE FUNCTION public.protect_cashier_ordinary_v1();`).join('\n')}
`;
export const CASHIER_ORDINARY_INSTALLATION_SQL = `
 SET LOCAL search_path=public,pg_temp; SET LOCAL row_security=off;
 DO $ordinary_install$ BEGIN
 IF current_setting('server_version_num')::integer/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN
 RAISE EXCEPTION 'Ordinary cashier commissioning requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock(${CASHIER_ORDINARY_MAINTENANCE_LOCK},0) THEN RAISE EXCEPTION 'Ordinary cashier commissioning already running'; END IF;
 IF ${CASHIER_ORDINARY_TABLES.map(table => `to_regclass('public.${table}') IS NOT NULL`).join(' OR ')}
 OR to_regprocedure('public.protect_cashier_ordinary_v1()') IS NOT NULL THEN
 RAISE EXCEPTION 'Existing ordinary cashier protocol requires exact review; no reinstall'; END IF;
 IF (SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN(to_regclass('public.store_cart'),to_regclass('public.store_order'),to_regclass('public.store_order_cart_info'))
  AND relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity AND pg_catalog.pg_has_role(current_user,relowner,'USAGE'))<>3 THEN
 RAISE EXCEPTION 'Ordinary cashier commissioning requires actual source-table owner'; END IF;
 END $ordinary_install$;
 ${CASHIER_ORDINARY_SQL}
`;
