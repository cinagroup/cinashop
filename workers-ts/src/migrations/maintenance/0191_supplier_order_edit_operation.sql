-- Explicit independent PG16 maintenance; runtime never executes this installer.
CREATE TABLE public.supplier_order_edit_operation_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  order_id integer NOT NULL,
  request_hash varchar(64) NOT NULL,
  state varchar(16) NOT NULL,
  before_hash varchar(64) NOT NULL,
  after_hash varchar(64) NOT NULL,
  evidence jsonb,
  result jsonb,
  created_at integer NOT NULL,
  CONSTRAINT soeo_pk PRIMARY KEY (operation_id),
  CONSTRAINT soeo_identity_ck CHECK (actor_id > 0 AND supplier_id > 0 AND order_id > 0 AND created_at > 0),
  CONSTRAINT soeo_key_ck CHECK (operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT soeo_state_ck CHECK ((
    (state = 'not_applied' AND request_hash = '' AND before_hash = '' AND after_hash = '' AND evidence IS NULL AND result IS NULL) OR
    (state = 'committed' AND request_hash ~ '^[0-9a-f]{64}$'
      AND before_hash ~ '^[0-9a-f]{64}$' AND after_hash ~ '^[0-9a-f]{64}$'
      AND evidence IS NOT NULL AND jsonb_typeof(evidence) = 'object'
      AND octet_length(evidence::text) <= 196608
      AND evidence->>'version' = 'supplier-unpaid-gain-edit-v1'
      AND evidence->>'operation_id' = operation_id::text
      AND jsonb_typeof(evidence->'lines') = 'array' AND jsonb_array_length(evidence->'lines') BETWEEN 1 AND 200
      AND result IS NOT NULL AND jsonb_typeof(result) = 'object'
      AND result->'id' = to_jsonb(order_id)
      AND jsonb_typeof(result->'order_id') = 'string' AND (result->>'order_id') ~ '^[A-Za-z0-9]{1,32}$'
      AND jsonb_typeof(result->'pay_price') = 'string' AND (result->>'pay_price') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'
      AND jsonb_typeof(result->'change_price') = 'string' AND (result->>'change_price') ~ '^-?(0|[1-9][0-9]{0,5})[.][0-9]{2}$'
      AND jsonb_typeof(result->'gain_integral') = 'string' AND (result->>'gain_integral') ~ '^(0|[1-9][0-9]{0,9})[.]00$'
      AND jsonb_typeof(result->'changed') = 'boolean'
      AND result - 'id' - 'order_id' - 'pay_price' - 'change_price' - 'gain_integral' - 'changed' = '{}'::jsonb)) IS TRUE)
);
CREATE FUNCTION public.supplier_order_edit_operation_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $soeo_immutable$BEGIN
  RAISE EXCEPTION 'Supplier order edit operation evidence is immutable' USING ERRCODE='42501';
END$soeo_immutable$;
REVOKE ALL ON FUNCTION public.supplier_order_edit_operation_immutable_v1() FROM PUBLIC;
CREATE TRIGGER soeo_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_order_edit_operation_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_order_edit_operation_immutable_v1();
CREATE TRIGGER soeo_immutable_truncate BEFORE TRUNCATE ON public.supplier_order_edit_operation_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_order_edit_operation_immutable_v1();
REVOKE ALL ON TABLE public.supplier_order_edit_operation_v1 FROM PUBLIC;
