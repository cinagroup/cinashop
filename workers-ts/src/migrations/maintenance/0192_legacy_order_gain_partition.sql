-- Independent explicit PG16 maintenance only; no historical/bootstrap installation.
CREATE TABLE public.legacy_order_gain_partition_v1 (
  partition_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  source_order_id integer NOT NULL,
  child_order_id integer NOT NULL,
  buyer_id integer NOT NULL,
  supplier_id integer NOT NULL,
  kind varchar(16) NOT NULL,
  source_hash varchar(64) NOT NULL,
  child_hash varchar(64) NOT NULL,
  evidence jsonb NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT logp_pk PRIMARY KEY (partition_id),
  CONSTRAINT logp_identity_ck CHECK (source_order_id > 0 AND child_order_id > 0 AND buyer_id >= 0 AND supplier_id > 0 AND created_at > 0),
  CONSTRAINT logp_key_ck CHECK (partition_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT logp_evidence_ck CHECK ((kind IN ('allocation','fulfillment','refund')
    AND source_hash ~ '^[0-9a-f]{64}$' AND child_hash ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=196608
    AND evidence->>'version'='legacy-order-gain-partition-v1'
    AND jsonb_typeof(evidence->'source')='object' AND jsonb_typeof(evidence->'child')='object'
    AND jsonb_typeof(evidence->'selection')='array' AND jsonb_array_length(evidence->'selection') BETWEEN 1 AND 200) IS TRUE)
);
CREATE UNIQUE INDEX logp_child_state ON public.legacy_order_gain_partition_v1(child_order_id,child_hash);
CREATE FUNCTION public.legacy_order_gain_partition_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $logp_immutable$BEGIN
  RAISE EXCEPTION 'Legacy order gain partition operation evidence is immutable' USING ERRCODE='42501';
END$logp_immutable$;
REVOKE ALL ON FUNCTION public.legacy_order_gain_partition_immutable_v1() FROM PUBLIC;
CREATE TRIGGER logp_immutable_rows BEFORE UPDATE OR DELETE ON public.legacy_order_gain_partition_v1
FOR EACH ROW EXECUTE FUNCTION public.legacy_order_gain_partition_immutable_v1();
CREATE TRIGGER logp_immutable_truncate BEFORE TRUNCATE ON public.legacy_order_gain_partition_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.legacy_order_gain_partition_immutable_v1();
REVOKE ALL ON TABLE public.legacy_order_gain_partition_v1 FROM PUBLIC;
