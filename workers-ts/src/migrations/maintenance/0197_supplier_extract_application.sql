-- Explicit independent PG16 maintenance only; never HTTP/startup.
CREATE TABLE public.supplier_extract_application_operation_v1 (
 operation_id uuid NOT NULL, actor_id integer NOT NULL, supplier_id integer NOT NULL,
 extract_id integer, state text NOT NULL, request_hash varchar(64) NOT NULL,
 intent jsonb, source jsonb, source_hash varchar(64) NOT NULL, result jsonb, result_hash varchar(64) NOT NULL, created_at integer NOT NULL,
 CONSTRAINT seao_pk PRIMARY KEY(operation_id),
 CONSTRAINT seao_extract_uq UNIQUE(extract_id),
 CONSTRAINT seao_extract_fk FOREIGN KEY(extract_id) REFERENCES public.supplier_extract(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE FUNCTION public.supplier_extract_application_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $seao$BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Supplier extract application evidence is immutable' USING ERRCODE='42501';
  END IF;
  IF (NEW.actor_id > 0 AND NEW.supplier_id > 0 AND NEW.created_at > 0
    AND NEW.operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ((NEW.state='not_applied' AND NEW.extract_id IS NULL AND NEW.request_hash='' AND NEW.source_hash='' AND NEW.result_hash=''
      AND NEW.intent IS NULL AND NEW.source IS NULL AND NEW.result IS NULL)
    OR (NEW.state='committed' AND NEW.extract_id>0 AND NEW.request_hash ~ '^[a-f0-9]{64}$'
      AND NEW.source_hash ~ '^[a-f0-9]{64}$' AND NEW.result_hash ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(NEW.intent)='object' AND octet_length(NEW.intent::text)<=16384
      AND jsonb_typeof(NEW.source)='object' AND octet_length(NEW.source::text)<=65536
      AND jsonb_typeof(NEW.result)='object' AND octet_length(NEW.result::text)<=65536
      AND NEW.intent->>'version'='supplier-extract-application-intent-v1'
      AND NEW.intent->>'operation_id'=NEW.operation_id::text
      AND NEW.intent->'actor_id'=to_jsonb(NEW.actor_id) AND NEW.intent->'supplier_id'=to_jsonb(NEW.supplier_id)
      AND NEW.source->>'version'='supplier-extract-application-source-v1' AND NEW.source->'supplier_id'=to_jsonb(NEW.supplier_id)
      AND NEW.result->'id'=to_jsonb(NEW.extract_id) AND NEW.result->'status'='0'::jsonb AND NEW.result->'pay_status'='0'::jsonb
      AND NEW.result->'add_time'=to_jsonb(NEW.created_at)))) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Invalid supplier extract application evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END$seao$;
REVOKE ALL ON FUNCTION public.supplier_extract_application_guard_v1() FROM PUBLIC;
CREATE TRIGGER seao_insert BEFORE INSERT ON public.supplier_extract_application_operation_v1 FOR EACH ROW EXECUTE FUNCTION public.supplier_extract_application_guard_v1();
CREATE TRIGGER seao_rows BEFORE UPDATE OR DELETE ON public.supplier_extract_application_operation_v1 FOR EACH ROW EXECUTE FUNCTION public.supplier_extract_application_guard_v1();
CREATE TRIGGER seao_truncate BEFORE TRUNCATE ON public.supplier_extract_application_operation_v1 FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_extract_application_guard_v1();
REVOKE ALL ON TABLE public.supplier_extract_application_operation_v1 FROM PUBLIC;
