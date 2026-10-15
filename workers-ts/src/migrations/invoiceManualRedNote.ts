/** Explicit owner maintenance candidate; never registered in runAll/startup. */
export const INVOICE_MANUAL_RED_NOTE_TABLE_SQL=`
CREATE TABLE public.store_order_invoice_manual_red_note (
 id varchar(36) PRIMARY KEY, invoice_id integer NOT NULL, source_order_id integer NOT NULL, payment_order_id integer NOT NULL,
 uid integer NOT NULL, actor_id integer NOT NULL, request_hash varchar(64) NOT NULL, record_hash varchar(64) NOT NULL,
 record_json text NOT NULL, created_time integer NOT NULL,
 CONSTRAINT soimrn_identity_ck CHECK (id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND invoice_id>0 AND source_order_id>0 AND payment_order_id>0 AND uid>=0 AND actor_id>0 AND created_time>0),
 CONSTRAINT soimrn_hash_ck CHECK (request_hash ~ '^[a-f0-9]{64}$' AND record_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT soimrn_json_ck CHECK (octet_length(record_json)<=65536 AND jsonb_typeof(record_json::jsonb)='object' AND record_json::jsonb @> '{"version":"invoice-manual-red-note-v1","currency":"CNY"}'::jsonb)
);
CREATE INDEX soimrn_invoice ON public.store_order_invoice_manual_red_note(invoice_id,created_time);
CREATE TABLE public.store_order_invoice_manual_red_review (
 id varchar(36) PRIMARY KEY, record_id varchar(36) NOT NULL, invoice_id integer NOT NULL, source_order_id integer NOT NULL, payment_order_id integer NOT NULL,
 uid integer NOT NULL, actor_id integer NOT NULL, decision varchar(7) NOT NULL, original_document_number varchar(50) NOT NULL,red_document_number varchar(20) NOT NULL,
 request_hash varchar(64) NOT NULL,record_hash varchar(64) NOT NULL,review_hash varchar(64) NOT NULL,review_json text NOT NULL,created_time integer NOT NULL,
 CONSTRAINT soimrr_identity_ck CHECK (id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND record_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND invoice_id>0 AND source_order_id>0 AND payment_order_id>0 AND uid>=0 AND actor_id>0 AND created_time>0 AND decision IN ('confirm','reject') AND btrim(original_document_number)<>'' AND original_document_number !~ '[[:cntrl:]]' AND red_document_number ~ '^[0-9]{8,20}$'),
 CONSTRAINT soimrr_hash_ck CHECK (request_hash ~ '^[a-f0-9]{64}$' AND record_hash ~ '^[a-f0-9]{64}$' AND review_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT soimrr_json_ck CHECK (octet_length(review_json)<=4096 AND jsonb_typeof(review_json::jsonb)='object' AND review_json::jsonb @> '{"version":"invoice-manual-red-review-v1","manual_checked":true}'::jsonb)
);
CREATE UNIQUE INDEX soimrr_record_uq ON public.store_order_invoice_manual_red_review(record_id);
CREATE UNIQUE INDEX soimrr_confirmed_origin_uq ON public.store_order_invoice_manual_red_review(invoice_id,original_document_number) WHERE decision='confirm';
CREATE UNIQUE INDEX soimrr_confirmed_red_uq ON public.store_order_invoice_manual_red_review(red_document_number) WHERE decision='confirm';
`;
export const INVOICE_MANUAL_RED_NOTE_PROTECTION_SQL=`
CREATE FUNCTION public.protect_invoice_manual_red_note() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Manual red-note evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE FUNCTION public.guard_invoice_manual_red_note() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; captured jsonb; r public.store_order_invoice_manual_red_note%ROWTYPE; e public.store_order_invoice_evidence%ROWTYPE;
 s public.store_order%ROWTYPE; root public.store_order%ROWTYPE; keys text[];
BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Unexpected manual invoice source' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(731702,hashtext(NEW.id));
 IF TG_TABLE_NAME='store_order_invoice_manual_red_note' THEN
  p:=NEW.record_json::jsonb;keys:=ARRAY['version','request_id','actor_id','invoice_id','source_order_id','payment_order_id','uid','currency','original','red','platform','payment','source','created_time'];
  IF NOT ((p ?& keys AND p-keys='{}'::jsonb AND p->>'version'='invoice-manual-red-note-v1' AND p->>'currency'='CNY'
   AND p @> jsonb_build_object('request_id',NEW.id,'actor_id',NEW.actor_id,'invoice_id',NEW.invoice_id,'source_order_id',NEW.source_order_id,'payment_order_id',NEW.payment_order_id,'uid',NEW.uid,'created_time',NEW.created_time)
   AND p->>'request_id'=NEW.id AND (p->>'actor_id')::integer=NEW.actor_id AND (p->>'invoice_id')::integer=NEW.invoice_id
   AND (p->>'source_order_id')::integer=NEW.source_order_id AND (p->>'payment_order_id')::integer=NEW.payment_order_id AND (p->>'uid')::integer=NEW.uid AND (p->>'created_time')::integer=NEW.created_time
   AND NEW.record_hash=encode(sha256(convert_to(NEW.record_json,'UTF8')),'hex')
   AND p->'original' ?& ARRAY['document_number','snapshot_hash','amount','snapshot'] AND (p->'original')-ARRAY['document_number','snapshot_hash','amount','snapshot']='{}'::jsonb
   AND p->'red' ?& ARRAY['document_number','amount'] AND (p->'red')-ARRAY['document_number','amount']='{}'::jsonb
   AND p->'platform' ?& ARRAY['kind','content','content_hash'] AND (p->'platform')-ARRAY['kind','content','content_hash']='{}'::jsonb
   AND jsonb_typeof(p->'original'->'document_number')='string' AND char_length(p->'original'->>'document_number') BETWEEN 1 AND 50
   AND btrim(p->'original'->>'document_number')<>'' AND p->'original'->>'document_number' !~ '[[:cntrl:]]'
   AND jsonb_typeof(p->'red'->'document_number')='string' AND p->'red'->>'document_number' ~ '^[0-9]{8,20}$'
   AND p->'original'->>'document_number'<>p->'red'->>'document_number'
   AND jsonb_typeof(p->'original'->'snapshot')='string' AND jsonb_typeof(p->'original'->'snapshot_hash')='string'
   AND jsonb_typeof(p->'original'->'amount')='string' AND jsonb_typeof(p->'red'->'amount')='string'
   AND p->'original'->>'amount' ~ '^(0|[1-9][0-9]{0,9})\\.[0-9]{2}$' AND p->'red'->>'amount'=p->'original'->>'amount'
   AND p->'platform'->>'kind'='manual-tax-platform' AND octet_length(p->'platform'->>'content') BETWEEN 1 AND 4096
   AND jsonb_typeof(p->'platform'->'content')='string' AND jsonb_typeof(p->'platform'->'content_hash')='string'
   AND p->'platform'->>'content_hash'=encode(sha256(convert_to(p->'platform'->>'content','UTF8')),'hex')) IS TRUE) THEN RAISE EXCEPTION 'Manual red-note payload inconsistent' USING ERRCODE='23514'; END IF;
  SELECT * INTO e FROM public.store_order_invoice_evidence WHERE invoice_id=NEW.invoice_id AND kind='issued' AND document_number=p->'original'->>'document_number';
  SELECT * INTO s FROM public.store_order WHERE id=NEW.source_order_id;
  SELECT * INTO root FROM public.store_order WHERE id=NEW.payment_order_id;
  IF NOT ((e.invoice_id=NEW.invoice_id AND e.order_id=NEW.source_order_id AND e.uid=NEW.uid AND e.snapshot=p->'original'->>'snapshot'
   AND encode(sha256(convert_to(e.snapshot,'UTF8')),'hex')=p->'original'->>'snapshot_hash'
   AND e.snapshot::jsonb->'invoice'->>'invoice_amount'=p->'original'->>'amount'
   AND e.snapshot::jsonb->'invoice' @> jsonb_build_object('id',NEW.invoice_id,'order_id',NEW.source_order_id,'uid',NEW.uid,'category','order','is_pay',1,'invoice_number',p->'original'->>'document_number')
   AND s.uid=NEW.uid AND root.uid=NEW.uid AND s.paid=1 AND root.paid=1 AND s.pay_type=root.pay_type AND s.is_del=0 AND s.is_system_del=0 AND root.is_del=0 AND root.is_system_del=0
   AND NEW.payment_order_id=CASE WHEN s.pid>0 THEN s.pid ELSE s.id END
   AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence WHERE order_id IN(s.id,root.id) AND kind='unverified')
   AND p->'source'=jsonb_build_object('id',s.id,'order_number',s.order_id,'uid',s.uid,'pid',s.pid,'paid',s.paid,'pay_type',s.pay_type,'pay_time',s.pay_time,'store_id',s.store_id,'supplier_id',s.supplier_id)
   AND p->'payment'=jsonb_build_object('id',root.id,'order_number',root.order_id,'uid',root.uid,'pid',root.pid,'paid',root.paid,'pay_type',root.pay_type,'pay_time',root.pay_time,'store_id',root.store_id,'supplier_id',root.supplier_id)
   AND NEW.request_hash=encode(sha256(convert_to('["invoice-manual-red-record-intent-v1",'||NEW.invoice_id::text||','||NEW.actor_id::text||','||to_json(p->'original'->>'document_number')::text||','||to_json(p->'original'->>'snapshot_hash')::text||','||to_json(p->'original'->>'amount')::text||',"CNY",'||to_json(p->'red'->>'document_number')::text||','||to_json(p->'red'->>'amount')::text||','||to_json(p->'platform'->>'content')::text||']','UTF8')),'hex')
   AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_manual_red_review WHERE id=NEW.id)) IS TRUE) THEN RAISE EXCEPTION 'Original issued invoice identity missing' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='store_order_invoice_manual_red_review' THEN
  p:=NEW.review_json::jsonb;keys:=ARRAY['version','request_id','record_id','record_hash','actor_id','invoice_id','source_order_id','payment_order_id','uid','original_document_number','red_document_number','decision','manual_checked','review_note','created_time'];
  SELECT * INTO r FROM public.store_order_invoice_manual_red_note WHERE id=NEW.record_id;
  IF NOT ((p ?& keys AND p-keys='{}'::jsonb AND p->>'version'='invoice-manual-red-review-v1' AND p->'manual_checked'='true'::jsonb
   AND p @> jsonb_build_object('request_id',NEW.id,'record_id',NEW.record_id,'record_hash',NEW.record_hash,'actor_id',NEW.actor_id,'invoice_id',NEW.invoice_id,'source_order_id',NEW.source_order_id,'payment_order_id',NEW.payment_order_id,'uid',NEW.uid,'created_time',NEW.created_time)
   AND p->>'request_id'=NEW.id AND p->>'record_id'=NEW.record_id AND p->>'record_hash'=NEW.record_hash AND p->>'decision'=NEW.decision
   AND p->>'original_document_number'=NEW.original_document_number AND p->>'red_document_number'=NEW.red_document_number
   AND (p->>'actor_id')::integer=NEW.actor_id AND (p->>'invoice_id')::integer=NEW.invoice_id AND (p->>'source_order_id')::integer=NEW.source_order_id
   AND (p->>'payment_order_id')::integer=NEW.payment_order_id AND (p->>'uid')::integer=NEW.uid AND (p->>'created_time')::integer=NEW.created_time
   AND octet_length(p->>'review_note') BETWEEN 1 AND 1024 AND NEW.review_hash=encode(sha256(convert_to(NEW.review_json,'UTF8')),'hex')
   AND jsonb_typeof(p->'review_note')='string'
   AND r.id=NEW.record_id AND r.invoice_id=NEW.invoice_id AND r.source_order_id=NEW.source_order_id AND r.payment_order_id=NEW.payment_order_id AND r.uid=NEW.uid AND r.record_hash=NEW.record_hash
   AND r.record_json::jsonb->'original'->>'document_number'=NEW.original_document_number AND r.record_json::jsonb->'red'->>'document_number'=NEW.red_document_number
   AND NEW.request_hash=encode(sha256(convert_to('["invoice-manual-red-review-intent-v1",'||NEW.invoice_id::text||','||to_json(NEW.record_id)::text||','||NEW.actor_id::text||','||to_json(NEW.record_hash)::text||','||to_json(NEW.decision)::text||',true,'||to_json(p->>'review_note')::text||']','UTF8')),'hex')
   AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_manual_red_note WHERE id=NEW.id)) IS TRUE) THEN RAISE EXCEPTION 'Manual red-review payload inconsistent' USING ERRCODE='23514'; END IF;
  captured:=r.record_json::jsonb;
  SELECT * INTO e FROM public.store_order_invoice_evidence WHERE invoice_id=r.invoice_id AND kind='issued' AND document_number=NEW.original_document_number;
  SELECT * INTO root FROM public.store_order WHERE id=r.payment_order_id FOR UPDATE;
  SELECT * INTO s FROM public.store_order WHERE id=r.source_order_id FOR UPDATE;
  IF NOT ((e.invoice_id=r.invoice_id AND e.order_id=r.source_order_id AND e.uid=r.uid AND e.snapshot=captured->'original'->>'snapshot'
   AND encode(sha256(convert_to(e.snapshot,'UTF8')),'hex')=captured->'original'->>'snapshot_hash'
   AND e.snapshot::jsonb->'invoice'->>'invoice_amount'=captured->'original'->>'amount'
   AND s.uid=r.uid AND root.uid=r.uid AND s.paid=1 AND root.paid=1 AND s.pay_type=root.pay_type
   AND s.is_del=0 AND s.is_system_del=0 AND root.is_del=0 AND root.is_system_del=0
   AND r.payment_order_id=CASE WHEN s.pid>0 THEN s.pid ELSE s.id END
   AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence WHERE order_id IN(s.id,root.id) AND kind='unverified')
   AND (captured->'source')-ARRAY['pid']=jsonb_build_object('id',s.id,'order_number',s.order_id,'uid',s.uid,'paid',s.paid,'pay_type',s.pay_type,'pay_time',s.pay_time,'store_id',s.store_id,'supplier_id',s.supplier_id)
   AND (captured->'payment')-ARRAY['pid']=jsonb_build_object('id',root.id,'order_number',root.order_id,'uid',root.uid,'paid',root.paid,'pay_type',root.pay_type,'pay_time',root.pay_time,'store_id',root.store_id,'supplier_id',root.supplier_id)) IS TRUE)
   THEN RAISE EXCEPTION 'Manual red-review original source changed' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Unexpected manual invoice table' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER soimrn_insert_guard BEFORE INSERT ON public.store_order_invoice_manual_red_note FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_manual_red_note();
CREATE TRIGGER soimrn_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_invoice_manual_red_note FOR EACH ROW EXECUTE FUNCTION public.protect_invoice_manual_red_note();
CREATE TRIGGER soimrn_no_truncate BEFORE TRUNCATE ON public.store_order_invoice_manual_red_note FOR EACH STATEMENT EXECUTE FUNCTION public.protect_invoice_manual_red_note();
CREATE TRIGGER soimrr_insert_guard BEFORE INSERT ON public.store_order_invoice_manual_red_review FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_manual_red_note();
CREATE TRIGGER soimrr_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_invoice_manual_red_review FOR EACH ROW EXECUTE FUNCTION public.protect_invoice_manual_red_note();
CREATE TRIGGER soimrr_no_truncate BEFORE TRUNCATE ON public.store_order_invoice_manual_red_review FOR EACH STATEMENT EXECUTE FUNCTION public.protect_invoice_manual_red_note();
REVOKE ALL ON public.store_order_invoice_manual_red_note,public.store_order_invoice_manual_red_review FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_invoice_manual_red_note(),public.protect_invoice_manual_red_note() FROM PUBLIC;
`;

