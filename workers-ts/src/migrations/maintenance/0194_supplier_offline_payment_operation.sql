-- Explicit independent PG16 maintenance; runtime never executes this installer.
CREATE TABLE public.supplier_offline_payment_operation_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  order_id integer NOT NULL,
  request_hash varchar(64) NOT NULL,
  state varchar(16) NOT NULL,
  intent jsonb,
  source jsonb,
  source_hash varchar(64) NOT NULL,
  evidence jsonb,
  result jsonb,
  created_at integer NOT NULL,
  CONSTRAINT sopo_pk PRIMARY KEY (operation_id),
  CONSTRAINT sopo_identity_ck CHECK (actor_id > 0 AND supplier_id > 0 AND order_id > 0 AND created_at > 0),
  CONSTRAINT sopo_key_ck CHECK (operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT sopo_state_ck CHECK (((state = 'not_applied' AND request_hash = '' AND source_hash = ''
      AND intent IS NULL AND source IS NULL AND evidence IS NULL AND result IS NULL) OR
    (state = 'committed' AND request_hash ~ '^[0-9a-f]{64}$' AND source_hash ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(intent) = 'object' AND octet_length(intent::text) <= 8192
      AND intent->>'version' = 'supplier-offline-payment-v1'
      AND intent->'actor_id' = to_jsonb(actor_id) AND intent->'supplier_id' = to_jsonb(supplier_id)
      AND intent->'order_id' = to_jsonb(order_id) AND intent->>'operation_id' = operation_id::text
      AND ((intent->>'amount'='0.00' AND NOT intent ? 'cash_received')
        OR (intent->>'amount'<>'0.00' AND intent->'cash_received'='true'::jsonb))
      AND jsonb_typeof(source) = 'object' AND octet_length(source::text) <= 20971520
      AND jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 4096
      AND jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096
      AND result->'id' = to_jsonb(order_id) AND result->'paid' = '1'::jsonb
      AND result->>'pay_type' = 'offline'
      AND (result->>'pay_price') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'
      AND (result->>'pay_time') ~ '^[1-9][0-9]{0,9}$')) IS TRUE)
);
CREATE UNIQUE INDEX sopo_committed_order ON public.supplier_offline_payment_operation_v1 USING btree (order_id) WHERE state = 'committed';
CREATE FUNCTION public.supplier_offline_payment_operation_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $sopo_immutable$BEGIN
  RAISE EXCEPTION 'Supplier offline payment operation evidence is immutable' USING ERRCODE='42501';
END$sopo_immutable$;
REVOKE ALL ON FUNCTION public.supplier_offline_payment_operation_immutable_v1() FROM PUBLIC;
CREATE TRIGGER sopo_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_offline_payment_operation_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_offline_payment_operation_immutable_v1();
CREATE TRIGGER sopo_immutable_truncate BEFORE TRUNCATE ON public.supplier_offline_payment_operation_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_offline_payment_operation_immutable_v1();
REVOKE ALL ON TABLE public.supplier_offline_payment_operation_v1 FROM PUBLIC;
