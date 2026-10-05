/** Explicit owner maintenance only. Customer UserJWT identity has its own
 * immutable namespace; neither an Admin ID nor a store staff ID substitutes. */
export const CUSTOMER_WORK_OPERATION_SQL = `
CREATE TABLE public.customer_work_operation_request (
 actor_uid integer NOT NULL, request_key uuid NOT NULL,
 request_hash varchar(64) NOT NULL, service_id integer NOT NULL,
 order_id integer NOT NULL, kind varchar(32) NOT NULL, outcome varchar(32) NOT NULL,
 scope_key varchar(64) NOT NULL, expected_revision varchar(64) NOT NULL,
 expected_fulfillment_revision varchar(64) NOT NULL,
 intent jsonb NOT NULL, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cwo_pk PRIMARY KEY(actor_uid,request_key),
 CONSTRAINT cwo_identity_ck CHECK(actor_uid>0 AND service_id>=0 AND order_id>0
   AND (outcome IN ('abandoned','rollback-rejected') OR service_id>0)),
 CONSTRAINT cwo_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT cwo_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_key ~ '^[a-f0-9]{64}$'
   AND expected_revision ~ '^[a-f0-9]{64}$' AND expected_fulfillment_revision ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cwo_json_ck CHECK(jsonb_typeof(intent)='object' AND jsonb_typeof(evidence)='object'
   AND octet_length(intent::text)<=262144 AND octet_length(evidence::text)<=16384),
 CONSTRAINT cwo_outcome_ck CHECK(
   outcome IN ('abandoned','rollback-rejected') OR
   (kind='remark' AND outcome='remark-saved') OR
   (kind IN ('manual_delivery','split_delivery') AND outcome='delivery-recorded') OR
   (kind IN ('electronic_waybill','electronic_split_waybill','city_delivery','city_split_delivery') AND outcome='provider-admitted') OR
   (kind IN ('waybill_apply_existing','waybill_confirm_issued','waybill_confirm_retry','waybill_close') AND outcome='job-updated')),
 CONSTRAINT cwo_kind_ck CHECK(kind IN ('remark','manual_delivery','split_delivery','electronic_waybill','electronic_split_waybill',
   'city_delivery','city_split_delivery','waybill_apply_existing','waybill_confirm_issued','waybill_confirm_retry','waybill_close'))
);
CREATE INDEX cwo_order_history ON public.customer_work_operation_request(order_id,created_at,actor_uid,request_key);
`;
export const CUSTOMER_WORK_OPERATION_INSTALLATION_SQL = `
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
DO $cwo_install$
BEGIN
 IF current_setting('server_version_num')::int/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
 RAISE EXCEPTION 'Customer operation installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_try_advisory_xact_lock(731634,0) THEN RAISE EXCEPTION 'Customer operation installation already running'; END IF;
 IF to_regclass('public.customer_work_operation_request') IS NOT NULL THEN
 RAISE EXCEPTION 'Existing customer operation table requires exact catalog review, no reinstall'; END IF;
END $cwo_install$;
${CUSTOMER_WORK_OPERATION_SQL}
`;
