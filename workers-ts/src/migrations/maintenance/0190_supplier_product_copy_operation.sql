-- Explicit PG16 owner maintenance only; never run by HTTP/bootstrap.
CREATE TABLE public.supplier_product_copy_operation_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  source_id integer NOT NULL,
  request_hash varchar(64) NOT NULL,
  state varchar(16) NOT NULL,
  result jsonb,
  created_at integer NOT NULL,
  CONSTRAINT spco_pk PRIMARY KEY (operation_id),
  CONSTRAINT spco_identity_ck CHECK (actor_id > 0 AND supplier_id > 0 AND source_id > 0 AND created_at > 0),
  CONSTRAINT spco_key_ck CHECK (operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT spco_state_ck CHECK ((
    (state = 'not_applied' AND request_hash = '' AND result IS NULL) OR
    (state = 'committed' AND request_hash ~ '^[0-9a-f]{64}$'
      AND result IS NOT NULL AND jsonb_typeof(result) = 'object'
      AND jsonb_typeof(result->'id') = 'number' AND (result->>'id') ~ '^[1-9][0-9]{0,9}$'
      AND (result->>'id')::bigint <= 2147483647
      AND result->'is_show' = '0'::jsonb AND result->'is_verify' = '0'::jsonb
      AND result - 'id' - 'is_show' - 'is_verify' = '{}'::jsonb)) IS TRUE)
);
CREATE FUNCTION public.supplier_product_copy_operation_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $spco_immutable$BEGIN
  RAISE EXCEPTION 'Supplier product copy operation evidence is immutable' USING ERRCODE='42501';
END$spco_immutable$;
REVOKE ALL ON FUNCTION public.supplier_product_copy_operation_immutable_v1() FROM PUBLIC;
CREATE TRIGGER spco_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_product_copy_operation_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_product_copy_operation_immutable_v1();
CREATE TRIGGER spco_immutable_truncate BEFORE TRUNCATE ON public.supplier_product_copy_operation_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_product_copy_operation_immutable_v1();
REVOKE ALL ON TABLE public.supplier_product_copy_operation_v1 FROM PUBLIC;
