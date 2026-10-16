-- Explicit standalone PG16 owner maintenance; historical bootstrap and runtime HTTP never install this addon.
CREATE TABLE public.supplier_proactive_refund_operation_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  order_id integer NOT NULL,
  state text NOT NULL,
  kind text,
  request_hash text NOT NULL,
  intent jsonb,
  intent_json text,
  source jsonb,
  source_json text,
  source_hash text NOT NULL,
  result jsonb,
  created_at integer NOT NULL,
  CONSTRAINT spro_pk PRIMARY KEY (operation_id),
  CONSTRAINT spro_identity_ck CHECK (actor_id>0 AND supplier_id>0 AND order_id>0 AND created_at>0),
  CONSTRAINT spro_uuid_ck CHECK (operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT spro_state_ck CHECK (((state='not_applied' AND kind IS NULL AND request_hash='' AND source_hash=''
      AND intent IS NULL AND intent_json IS NULL AND source IS NULL AND source_json IS NULL AND result IS NULL)
    OR (state='committed' AND kind IN ('goods','money','refuse')
      AND request_hash ~ '^[0-9a-f]{64}$' AND source_hash ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(intent)='object' AND octet_length(intent::text)<=16384
      AND octet_length(intent_json)>0 AND octet_length(intent_json)<=16384 AND intent_json::jsonb=intent
      AND intent->>'version'='supplier-proactive-refund-intent-v1'
      AND intent->>'operation_id'=operation_id::text AND intent->'actor_id'=to_jsonb(actor_id)
      AND intent->'supplier_id'=to_jsonb(supplier_id) AND intent->'order_id'=to_jsonb(order_id)
      AND ((kind='refuse' AND intent->'type'='2'::jsonb) OR (kind IN ('goods','money') AND intent->'type'='1'::jsonb))
      AND jsonb_typeof(source)='object' AND octet_length(source::text)<=16777216
      AND octet_length(source_json)>0 AND octet_length(source_json)<=16777216 AND source_json::jsonb=source
      AND jsonb_typeof(result)='object' AND octet_length(result::text)<=65536)) IS TRUE)
);
CREATE INDEX spro_order ON public.supplier_proactive_refund_operation_v1 USING btree (order_id,created_at,operation_id);
CREATE TABLE public.supplier_proactive_refund_decision_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  order_id integer NOT NULL,
  kind text NOT NULL,
  outcome text NOT NULL,
  request_hash text NOT NULL,
  evidence jsonb NOT NULL,
  evidence_json text NOT NULL,
  evidence_hash text NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT sprd_pk PRIMARY KEY (operation_id),
  CONSTRAINT sprd_operation_fk FOREIGN KEY (operation_id) REFERENCES public.supplier_proactive_refund_operation_v1(operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT sprd_identity_ck CHECK (actor_id>0 AND supplier_id>0 AND order_id>0 AND created_at>0
    AND request_hash ~ '^[0-9a-f]{64}$' AND evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sprd_kind_ck CHECK ((kind='refuse' AND outcome='refused')
    OR (kind IN ('goods','money') AND outcome IN ('local-settled','provider-admitted'))),
  CONSTRAINT sprd_payload_ck CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=16777216
    AND octet_length(evidence_json)>0 AND octet_length(evidence_json)<=16777216 AND evidence_json::jsonb=evidence)
);
CREATE TABLE public.supplier_refund_money_payment_v1 (
  id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.supplier_refund_money_payment_v1_id_seq) NOT NULL,
  operation_id uuid NOT NULL,
  order_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  provider text NOT NULL,
  out_refund_no text NOT NULL,
  transaction_id text NOT NULL,
  request_amount integer NOT NULL,
  total_amount integer NOT NULL,
  provider_status text NOT NULL,
  provider_refund_id text DEFAULT '' NOT NULL,
  last_error text DEFAULT '' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  request_lease_until integer,
  next_retry_at integer DEFAULT 0 NOT NULL,
  last_queried_at integer,
  query_count integer DEFAULT 0 NOT NULL,
  request jsonb NOT NULL,
  request_json text NOT NULL,
  request_hash text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT srmp_pk PRIMARY KEY (id),
  CONSTRAINT srmp_operation_uq UNIQUE (operation_id),
  CONSTRAINT srmp_out_refund_no_uq UNIQUE (out_refund_no),
  CONSTRAINT srmp_operation_fk FOREIGN KEY (operation_id) REFERENCES public.supplier_proactive_refund_operation_v1(operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT srmp_identity_ck CHECK (id>0 AND order_id>0 AND payment_order_id>0 AND created_at>0 AND updated_at>=created_at
    AND request_amount>0 AND total_amount>=request_amount),
  CONSTRAINT srmp_provider_ck CHECK (provider IN ('wechat','alipay') AND octet_length(out_refund_no)>0
    AND octet_length(out_refund_no)<=64 AND octet_length(transaction_id)<=100 AND octet_length(provider_refund_id)<=100),
  CONSTRAINT srmp_progress_ck CHECK (provider_status IN ('INIT','REQUESTING','PROCESSING','SUCCESS','CLOSED','ABNORMAL','UNKNOWN')
    AND octet_length(last_error)<=4096 AND attempts>=0 AND query_count>=0 AND next_retry_at>=0
    AND (request_lease_until IS NULL OR request_lease_until>0) AND (last_queried_at IS NULL OR last_queried_at>0)),
  CONSTRAINT srmp_payload_ck CHECK (request_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(request)='object'
    AND octet_length(request::text)<=65536 AND octet_length(request_json)>0 AND octet_length(request_json)<=65536
    AND request_json::jsonb=request)
);
CREATE INDEX srmp_retry ON public.supplier_refund_money_payment_v1 USING btree (provider_status,next_retry_at,id);
CREATE TABLE public.supplier_refund_money_completion_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  order_id integer NOT NULL,
  first_refund_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  amount numeric(12,2) NOT NULL,
  pay_type text NOT NULL,
  source_hash text NOT NULL,
  request_hash text NOT NULL,
  before_refunded numeric(12,2) NOT NULL,
  after_refunded numeric(12,2) NOT NULL,
  proof jsonb NOT NULL,
  proof_json text NOT NULL,
  proof_hash text NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT srmc_pk PRIMARY KEY (operation_id),
  CONSTRAINT srmc_operation_fk FOREIGN KEY (operation_id) REFERENCES public.supplier_proactive_refund_operation_v1(operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT srmc_identity_ck CHECK (actor_id>0 AND supplier_id>0 AND order_id>0 AND first_refund_id>0 AND payment_order_id>0 AND created_at>0
    AND pay_type IN ('cash','offline','yue','weixin','alipay') AND source_hash ~ '^[0-9a-f]{64}$'
    AND request_hash ~ '^[0-9a-f]{64}$' AND proof_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT srmc_money_ck CHECK (amount>0 AND amount<=9999999999.99 AND before_refunded>=0
    AND before_refunded<=9999999999.99 AND after_refunded<=9999999999.99 AND after_refunded=before_refunded+amount),
  CONSTRAINT srmc_payload_ck CHECK (jsonb_typeof(proof)='object' AND octet_length(proof::text)<=16777216
    AND octet_length(proof_json)>0 AND octet_length(proof_json)<=16777216 AND proof_json::jsonb=proof)
);
CREATE INDEX srmc_order ON public.supplier_refund_money_completion_v1 USING btree (order_id,created_at,operation_id);
CREATE FUNCTION public.supplier_proactive_refund_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $spr_immutable$BEGIN
  RAISE EXCEPTION 'Supplier proactive refund evidence is immutable' USING ERRCODE='42501';
END$spr_immutable$;
CREATE FUNCTION public.supplier_refund_money_payment_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $srmp_guard$BEGIN
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Supplier refund money payment cannot be removed' USING ERRCODE='42501';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['provider_status','provider_refund_id','last_error','attempts','request_lease_until','next_retry_at','last_queried_at','query_count','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['provider_status','provider_refund_id','last_error','attempts','request_lease_until','next_retry_at','last_queried_at','query_count','updated_at'])
    OR NEW.updated_at<OLD.updated_at OR NEW.attempts<OLD.attempts OR NEW.query_count<OLD.query_count
    OR (OLD.last_queried_at IS NOT NULL AND (NEW.last_queried_at IS NULL OR NEW.last_queried_at<OLD.last_queried_at))
    OR (OLD.provider_status='SUCCESS' AND NEW.provider_status<>'SUCCESS')
    OR (OLD.provider_refund_id<>'' AND NEW.provider_refund_id<>OLD.provider_refund_id) THEN
    RAISE EXCEPTION 'Supplier refund money payment identity or progress changed' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END$srmp_guard$;
REVOKE ALL ON FUNCTION public.supplier_proactive_refund_immutable_v1(),public.supplier_refund_money_payment_guard_v1() FROM PUBLIC;
CREATE TRIGGER spro_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_proactive_refund_operation_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER spro_immutable_truncate BEFORE TRUNCATE ON public.supplier_proactive_refund_operation_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER sprd_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_proactive_refund_decision_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER sprd_immutable_truncate BEFORE TRUNCATE ON public.supplier_proactive_refund_decision_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER srmp_guard_rows BEFORE UPDATE OR DELETE ON public.supplier_refund_money_payment_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_refund_money_payment_guard_v1();
CREATE TRIGGER srmp_guard_truncate BEFORE TRUNCATE ON public.supplier_refund_money_payment_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_refund_money_payment_guard_v1();
CREATE TRIGGER srmc_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_refund_money_completion_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER srmc_immutable_truncate BEFORE TRUNCATE ON public.supplier_refund_money_completion_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
REVOKE ALL ON TABLE public.supplier_proactive_refund_operation_v1,public.supplier_proactive_refund_decision_v1,
public.supplier_refund_money_payment_v1,public.supplier_refund_money_completion_v1 FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.supplier_refund_money_payment_v1_id_seq FROM PUBLIC;
