-- Explicit PG16 owner maintenance only; provision two distinct constrained NOLOGIN owners and both cinashop.supplier_manual_refund_owner / cinashop.supplier_manual_refund_channel_owner settings inside the reviewed transaction. Never runtime DDL.

CREATE TABLE public.supplier_manual_refund_operation_v1(
 operation_id uuid NOT NULL, actor_id integer NOT NULL, supplier_id integer NOT NULL, refund_id integer NOT NULL,
 request_hash varchar(64) NOT NULL, state varchar(16) NOT NULL, intent jsonb,
 source_hash varchar(64) NOT NULL, proof_hash varchar(64) NOT NULL, result jsonb, created_at integer NOT NULL,
 CONSTRAINT smro_pk PRIMARY KEY(operation_id),
 CONSTRAINT smro_identity_ck CHECK(actor_id>0 AND supplier_id>0 AND refund_id>0 AND created_at>0),
 CONSTRAINT smro_key_ck CHECK(operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT smro_state_ck CHECK(((state='not_applied' AND request_hash='' AND source_hash='' AND proof_hash='' AND intent IS NULL AND result IS NULL)
 OR(state='committed' AND request_hash ~ '^[a-f0-9]{64}$' AND source_hash ~ '^[a-f0-9]{64}$' AND proof_hash ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(intent)='object' AND octet_length(intent::text)<=16384
  AND intent->>'version'='supplier-manual-refund-intent-v1' AND intent->'actor_id'=to_jsonb(actor_id)
  AND intent->'supplier_id'=to_jsonb(supplier_id) AND intent->'refund_id'=to_jsonb(refund_id)
  AND intent->>'operation_id'=operation_id::text
  AND jsonb_typeof(result)='object' AND result->'refund_id'=to_jsonb(refund_id)
  AND result->>'status' IN('CASH_SUCCESS','ZERO_SUCCESS') AND octet_length(result::text)<=1024)) IS TRUE)
);
CREATE TABLE public.supplier_manual_refund_proof_v1(
 refund_id integer NOT NULL, operation_id uuid NOT NULL, actor_id integer NOT NULL, supplier_id integer NOT NULL,
 order_id integer NOT NULL, payment_order_id integer NOT NULL, buyer_id integer NOT NULL, pay_type varchar(8) NOT NULL,
 amount varchar(20) NOT NULL, intent jsonb NOT NULL, intent_json text NOT NULL, request_hash varchar(64) NOT NULL,
 source jsonb NOT NULL, source_json text NOT NULL, source_hash varchar(64) NOT NULL,
 proof jsonb NOT NULL, proof_json text NOT NULL, proof_hash varchar(64) NOT NULL,
 transaction_id bigint NOT NULL DEFAULT txid_current(), created_at integer NOT NULL,
 CONSTRAINT smrp_pk PRIMARY KEY(refund_id), CONSTRAINT smrp_operation_uq UNIQUE(operation_id),
 CONSTRAINT smrp_identity_ck CHECK(refund_id>0 AND actor_id>0 AND supplier_id>0 AND order_id>0 AND payment_order_id>0 AND buyer_id>=0 AND created_at>0),
 CONSTRAINT smrp_key_ck CHECK(operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT smrp_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND source_hash ~ '^[a-f0-9]{64}$' AND proof_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT smrp_binding_ck CHECK((pay_type IN('cash','offline') AND amount ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'
  AND jsonb_typeof(intent)='object' AND intent->>'version'='supplier-manual-refund-intent-v1'
  AND intent->'actor_id'=to_jsonb(actor_id) AND intent->'supplier_id'=to_jsonb(supplier_id)
  AND intent->'refund_id'=to_jsonb(refund_id) AND intent->>'operation_id'=operation_id::text AND intent->>'refund_price'=amount
  AND CASE WHEN amount='0.00' THEN NOT(intent ? 'cash_returned') ELSE intent->'cash_returned'='true'::jsonb END
  AND jsonb_typeof(source)='object' AND source->>'version'='supplier-manual-refund-source-v1'
  AND source->'order'->'id'=to_jsonb(order_id) AND source->'order'->'uid'=to_jsonb(buyer_id)
  AND source->'order'->'supplierId'=to_jsonb(supplier_id) AND source->'payment'->'root_id'=to_jsonb(payment_order_id)
  AND source->'payment'->>'pay_type'=pay_type
  AND jsonb_typeof(source->'carts')='array' AND jsonb_array_length(source->'carts') BETWEEN 1 AND 200
  AND jsonb_typeof(source->'promotion_rows')='array' AND jsonb_array_length(source->'promotion_rows')<=200
  AND jsonb_typeof(proof)='object' AND proof->>'version'='supplier-manual-refund-proof-v1'
  AND proof->'refund_id'=to_jsonb(refund_id) AND proof->>'operation_id'=operation_id::text
  AND proof->'actor_id'=to_jsonb(actor_id) AND proof->'supplier_id'=to_jsonb(supplier_id)
  AND proof->'order_id'=to_jsonb(order_id) AND proof->'payment_order_id'=to_jsonb(payment_order_id)
  AND proof->'buyer_id'=to_jsonb(buyer_id) AND proof->>'amount'=amount AND proof->>'pay_type'=pay_type
  AND proof->>'source_hash'=source_hash AND proof->>'request_hash'=request_hash) IS TRUE),
 CONSTRAINT smrp_bytes_ck CHECK((octet_length(intent_json)<=16384 AND octet_length(source_json)<=16777216 AND octet_length(proof_json)<=16384
  AND intent_json::jsonb=intent AND source_json::jsonb=source AND proof_json::jsonb=proof
  AND request_hash=encode(sha256(convert_to(intent_json,'UTF8')),'hex')
  AND source_hash=encode(sha256(convert_to(source_json,'UTF8')),'hex')
  AND proof_hash=encode(sha256(convert_to(proof_json,'UTF8')),'hex')) IS TRUE)
);
CREATE FUNCTION public.supplier_manual_refund_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog AS $smr$BEGIN
 RAISE EXCEPTION 'Supplier manual refund evidence is immutable' USING ERRCODE='42501';
END$smr$;
REVOKE ALL ON FUNCTION public.supplier_manual_refund_immutable_v1() FROM PUBLIC;
CREATE TRIGGER smro_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_manual_refund_operation_v1
 FOR EACH ROW EXECUTE FUNCTION public.supplier_manual_refund_immutable_v1();
CREATE TRIGGER smro_immutable_truncate BEFORE TRUNCATE ON public.supplier_manual_refund_operation_v1
 FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_manual_refund_immutable_v1();
CREATE TRIGGER smrp_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_manual_refund_proof_v1
 FOR EACH ROW EXECUTE FUNCTION public.supplier_manual_refund_immutable_v1();
CREATE TRIGGER smrp_immutable_truncate BEFORE TRUNCATE ON public.supplier_manual_refund_proof_v1
 FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_manual_refund_immutable_v1();
REVOKE ALL ON public.supplier_manual_refund_operation_v1,public.supplier_manual_refund_proof_v1 FROM PUBLIC;
CREATE FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer) RETURNS integer
 LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
 AS $smr_promotion$
DECLARE saved public.supplier_manual_refund_proof_v1%ROWTYPE; actual jsonb; deleted integer;
BEGIN
 IF current_user=session_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolcanlogin
  AND NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
 THEN RAISE EXCEPTION 'Supplier manual refund requires independent LOGIN'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(63841,$1);
 PERFORM pg_catalog.pg_advisory_xact_lock(63842,$2);
 SELECT * INTO STRICT saved FROM public.supplier_manual_refund_proof_v1 WHERE refund_id=$1 AND order_id=$2;
 IF saved.transaction_id<>pg_catalog.txid_current()
 OR EXISTS(SELECT 1 FROM public.supplier_manual_refund_operation_v1 WHERE operation_id=saved.operation_id)
 OR EXISTS(SELECT 1 FROM public.store_order_refund_split WHERE refund_id=$1)
 OR NOT EXISTS(SELECT 1 FROM public.store_order_refund r JOIN public.store_order o ON o.id=r.store_order_id
  WHERE r.id=$1 AND o.id=$2 AND r.refund_type=6 AND r.refunded_price=r.refund_price AND r.refund_price::text=saved.amount
  AND r.is_cancel=0 AND r.is_del=0 AND o.paid=1 AND o.uid=saved.buyer_id AND r.uid=o.uid
  AND o.supplier_id=saved.supplier_id AND r.supplier_id=o.supplier_id AND o.supplier_id>0
  AND r.store_id=o.store_id AND saved.source->'order'->'storeId'=to_jsonb(o.store_id)
  AND saved.source->'refund'->'id'=to_jsonb(r.id) AND saved.source->'refund'->>'orderId'=r.order_id
  AND o.pay_type=saved.pay_type AND CASE WHEN o.pid>0 THEN o.pid ELSE o.id END=saved.payment_order_id)
 THEN RAISE EXCEPTION 'Supplier manual refund lacks same transaction physical proof'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'oid',p.oid,'uid',p.uid,'promotions_id',p.promotions_id,
  'product_id',p.product_id,'promotions_price',p.promotions_price::text,'add_time',p.add_time) ORDER BY p.id),'[]'::jsonb)
 INTO actual FROM public.store_order_promotions p WHERE p.oid=$2;
 IF jsonb_array_length(actual)>200 OR actual IS DISTINCT FROM saved.source->'promotion_rows'
  OR EXISTS(SELECT 1 FROM public.store_order_promotions WHERE oid=$2 AND uid<>saved.buyer_id)
 THEN RAISE EXCEPTION 'Supplier manual refund promotion source changed'; END IF;
 DELETE FROM public.store_order_promotions WHERE oid=$2;
 GET DIAGNOSTICS deleted=ROW_COUNT; RETURN deleted;
END$smr_promotion$;
REVOKE ALL ON FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer) FROM PUBLIC;
CREATE FUNCTION public.supplier_manual_refund_promotion_lock_v1() RETURNS void
 LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
 AS $smr_lock$BEGIN
 IF current_user=session_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolcanlogin
  AND NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
 THEN RAISE EXCEPTION 'Supplier source lock requires independent LOGIN'; END IF;
 LOCK TABLE ONLY public.store_order_promotions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
END$smr_lock$;
CREATE FUNCTION public.supplier_manual_refund_channel_lock_v1() RETURNS void
 LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
 AS $smr_lock$BEGIN
 IF current_user=session_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolcanlogin
  AND NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
 THEN RAISE EXCEPTION 'Supplier source lock requires independent LOGIN'; END IF;
 LOCK TABLE ONLY public.store_order_refund_payment IN SHARE ROW EXCLUSIVE MODE NOWAIT;
END$smr_lock$;
REVOKE ALL ON FUNCTION public.supplier_manual_refund_promotion_lock_v1(),public.supplier_manual_refund_channel_lock_v1() FROM PUBLIC;
DO $smr_owner$
DECLARE target text:=current_setting('cinashop.supplier_manual_refund_owner',true);
 channel_target text:=current_setting('cinashop.supplier_manual_refund_channel_owner',true); old_owner oid;
BEGIN
 IF target IS NULL OR target !~ '^[a-z][a-z0-9_]{0,62}$' OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE rolname=target
  AND NOT(rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))
 THEN RAISE EXCEPTION 'Explicit restricted Supplier promotion owner required'; END IF;
 IF channel_target IS NULL OR channel_target=target OR channel_target !~ '^[a-z][a-z0-9_]{0,62}$'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE rolname=channel_target
  AND NOT(rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))
 THEN RAISE EXCEPTION 'Separate restricted Supplier channel-lock owner required'; END IF;
 SELECT proowner INTO old_owner FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('public.customer_manual_refund_promotion_delete_v1(integer,integer)');
 IF old_owner IS NOT NULL AND old_owner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=target)
 THEN RAISE EXCEPTION 'Existing Customer promotion owner must be composed explicitly'; END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',target);
 EXECUTE format('GRANT SELECT ON public.supplier_manual_refund_proof_v1,public.supplier_manual_refund_operation_v1,public.store_order,public.store_order_refund,public.store_order_refund_split,public.store_order_promotions TO %I',target);
 EXECUTE format('GRANT DELETE ON public.store_order_promotions TO %I',target);
 EXECUTE format('ALTER FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer) OWNER TO %I',target);
 EXECUTE format('ALTER FUNCTION public.supplier_manual_refund_promotion_lock_v1() OWNER TO %I',target);
 EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',channel_target);
 EXECUTE format('GRANT UPDATE ON public.store_order_refund_payment TO %I',channel_target);
 EXECUTE format('ALTER FUNCTION public.supplier_manual_refund_channel_lock_v1() OWNER TO %I',channel_target);
END $smr_owner$;
