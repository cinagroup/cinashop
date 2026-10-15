-- Explicit independent owner-only PG16 maintenance addon. Never run by HTTP or historical bootstrap.
CREATE TABLE public.admin_product_editor_operation_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  requested_id integer NOT NULL,
  request_hash varchar(64) NOT NULL,
  state varchar(16) NOT NULL,
  result jsonb,
  created_at integer NOT NULL,
  CONSTRAINT apeo_pk PRIMARY KEY (operation_id),
  CONSTRAINT apeo_identity_ck CHECK (actor_id > 0 AND requested_id >= 0 AND created_at > 0),
  CONSTRAINT apeo_key_ck CHECK (operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT apeo_state_ck CHECK ((
    (state = 'not_applied' AND request_hash = '' AND result IS NULL) OR
    (state = 'committed' AND request_hash ~ '^[0-9a-f]{64}$'
      AND result IS NOT NULL AND jsonb_typeof(result) = 'object'
      AND jsonb_typeof(result->'id') = 'number' AND (result->>'id') ~ '^[1-9][0-9]{0,9}$'
      AND (result->>'id')::bigint <= 2147483647
      AND jsonb_typeof(result->'created') = 'boolean'
      AND (result->>'created')::boolean = (requested_id = 0)
      AND (requested_id = 0 OR (result->>'id')::bigint = requested_id)
      AND result - 'id' - 'created' = '{}'::jsonb AND result ? 'created')) IS TRUE)
);
CREATE FUNCTION public.admin_product_editor_operation_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $apeo_immutable$BEGIN
  RAISE EXCEPTION 'Product editor operation evidence is immutable' USING ERRCODE='42501';
END$apeo_immutable$;
REVOKE ALL ON FUNCTION public.admin_product_editor_operation_immutable_v1() FROM PUBLIC;
CREATE TRIGGER apeo_immutable_rows BEFORE UPDATE OR DELETE ON public.admin_product_editor_operation_v1
FOR EACH ROW EXECUTE FUNCTION public.admin_product_editor_operation_immutable_v1();
CREATE TRIGGER apeo_immutable_truncate BEFORE TRUNCATE ON public.admin_product_editor_operation_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_product_editor_operation_immutable_v1();
REVOKE ALL ON TABLE public.admin_product_editor_operation_v1 FROM PUBLIC;
