/** A fresh immutable courier ledger. No alteration/backfill of manager or old
 * writeoff tables, runtime installation, or application privilege repair. */
export const DELIVERY_ORDER_OPERATION_SQL = `
CREATE TABLE public.delivery_order_operation_request (
 actor_uid integer NOT NULL, request_key uuid NOT NULL,
 request_hash varchar(64) NOT NULL, scope_kind varchar(16) NOT NULL,
 delivery_id integer NOT NULL, store_id integer NOT NULL, order_id integer NOT NULL,
 outcome varchar(32) NOT NULL, scope_key varchar(64) NOT NULL,
 expected_revision varchar(64) NOT NULL, intent jsonb NOT NULL, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT dor_pk PRIMARY KEY(actor_uid,request_key),
 CONSTRAINT dor_identity_ck CHECK(actor_uid>0 AND delivery_id>=0 AND order_id>0 AND
   ((scope_kind='platform' AND store_id=0) OR (scope_kind='store' AND store_id>0))),
 CONSTRAINT dor_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT dor_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_key ~ '^[a-f0-9]{64}$' AND expected_revision ~ '^[a-f0-9]{64}$'),
 CONSTRAINT dor_json_ck CHECK(jsonb_typeof(intent)='object' AND jsonb_typeof(evidence)='object' AND octet_length(intent::text)<=262144 AND octet_length(evidence::text)<=16384),
 CONSTRAINT dor_outcome_ck CHECK(outcome IN('partial-delivered','delivered','abandoned','rollback-rejected') AND
   ((outcome IN('abandoned','rollback-rejected') AND delivery_id=0) OR (outcome IN('partial-delivered','delivered') AND delivery_id>0)))
);
CREATE INDEX dor_order_history ON public.delivery_order_operation_request(order_id,actor_uid,created_at,request_key);
`;
export const DELIVERY_ORDER_OPERATION_INSTALLATION_SQL = `
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
DO $dor_install$
BEGIN
 IF current_setting('server_version_num')::int/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
 RAISE EXCEPTION 'Delivery operation installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_try_advisory_xact_lock(742026,0) THEN RAISE EXCEPTION 'Delivery operation installation already running'; END IF;
 IF to_regclass('public.delivery_order_operation_request') IS NOT NULL THEN
 RAISE EXCEPTION 'Existing delivery operation table requires explicit comparison, no automatic reinstall'; END IF;
END $dor_install$;
${DELIVERY_ORDER_OPERATION_SQL}
`;
