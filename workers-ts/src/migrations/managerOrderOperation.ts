/** New user/store principal namespace. No Admin grants, startup installation,
 * historical backfill or alteration of another protocol table. */
export const MANAGER_ORDER_OPERATION_SQL = `
CREATE TABLE public.manager_order_operation_request (
 actor_uid integer NOT NULL, request_key uuid NOT NULL,
 request_hash varchar(64) NOT NULL, store_id integer NOT NULL,
 staff_id integer NOT NULL, order_id integer NOT NULL,
 kind varchar(32) NOT NULL, outcome varchar(32) NOT NULL,
 scope_key varchar(64) NOT NULL, expected_revision varchar(64) NOT NULL,
 intent jsonb NOT NULL, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT mor_pk PRIMARY KEY(actor_uid,request_key),
 CONSTRAINT mor_identity_ck CHECK(actor_uid>0 AND store_id>0 AND staff_id>=0 AND order_id>0),
 CONSTRAINT mor_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT mor_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_key ~ '^[a-f0-9]{64}$' AND expected_revision ~ '^[a-f0-9]{64}$'),
 CONSTRAINT mor_json_ck CHECK(jsonb_typeof(intent)='object' AND jsonb_typeof(evidence)='object' AND octet_length(intent::text)<=262144 AND octet_length(evidence::text)<=16384),
 CONSTRAINT mor_outcome_ck CHECK(
 outcome IN ('abandoned','rollback-rejected') OR
 (kind='remark' AND outcome='remark-saved') OR
 (kind IN ('manual_delivery','split_delivery') AND outcome='delivery-recorded') OR
 (kind='change_price' AND outcome='price-changed') OR
 (kind='confirm_offline' AND outcome='offline-paid') OR
 (kind='refund_create' AND outcome='application-created') OR
 (kind='return_approve' AND outcome='return-approved') OR
 (kind='refund_refuse' AND outcome='refused') OR
 (kind='refund_execute' AND outcome IN ('balance-settled','provider-admitted'))),
 CONSTRAINT mor_kind_ck CHECK(kind IN ('remark','manual_delivery','split_delivery','change_price','confirm_offline','refund_create','return_approve','refund_refuse','refund_execute'))
);
CREATE INDEX mor_order_history ON public.manager_order_operation_request(store_id,order_id,created_at,actor_uid,request_key);
`;

/** Installation guard admits a fresh canonical table only. Existing data/ACL
 * are never repaired or replaced; the separate catalog reader verifies shape.
 * Caller must supply its explicit owner transaction and independently reviewed
 * runtime SELECT+INSERT grants. This string is never run by an API request. */
export const MANAGER_ORDER_OPERATION_INSTALLATION_SQL = `
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
DO $mor_install$
BEGIN
 IF current_setting('server_version_num')::int/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
 RAISE EXCEPTION 'Manager operation installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_try_advisory_xact_lock(731626,0) THEN RAISE EXCEPTION 'Manager operation installation already running'; END IF;
 IF to_regclass('public.manager_order_operation_request') IS NOT NULL THEN
 RAISE EXCEPTION 'Existing manager operation table requires explicit catalog comparison, no automatic reinstall'; END IF;
END $mor_install$;
${MANAGER_ORDER_OPERATION_SQL}
`;
