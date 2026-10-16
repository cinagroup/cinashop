import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { reviewedManualRefundPromotionLockCatalogQuery } from './cashierSecondCardPromotionLock';
import { inspectCustomerManualRefund } from './runCustomerManualRefund';

export const SUPPLIER_MANUAL_REFUND_IMMUTABLE_BODY = `BEGIN
 RAISE EXCEPTION 'Supplier manual refund evidence is immutable' USING ERRCODE='42501';
END`;
export const SUPPLIER_MANUAL_REFUND_PROMOTION_LOCK_BODY = `BEGIN
 IF current_user=session_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolcanlogin
  AND NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
 THEN RAISE EXCEPTION 'Supplier source lock requires independent LOGIN'; END IF;
 LOCK TABLE ONLY public.store_order_promotions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
END`;
export const SUPPLIER_MANUAL_REFUND_CHANNEL_LOCK_BODY = `BEGIN
 IF current_user=session_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolcanlogin
  AND NOT(rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
 THEN RAISE EXCEPTION 'Supplier source lock requires independent LOGIN'; END IF;
 LOCK TABLE ONLY public.store_order_refund_payment IN SHARE ROW EXCLUSIVE MODE NOWAIT;
END`;
export const SUPPLIER_MANUAL_REFUND_PROMOTION_BODY = `
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
END`;
export const SUPPLIER_MANUAL_REFUND_SQL = `
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
 SET search_path=pg_catalog AS $smr$${SUPPLIER_MANUAL_REFUND_IMMUTABLE_BODY}$smr$;
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
 AS $smr_promotion$${SUPPLIER_MANUAL_REFUND_PROMOTION_BODY}$smr_promotion$;
REVOKE ALL ON FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer) FROM PUBLIC;
CREATE FUNCTION public.supplier_manual_refund_promotion_lock_v1() RETURNS void
 LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
 AS $smr_lock$${SUPPLIER_MANUAL_REFUND_PROMOTION_LOCK_BODY}$smr_lock$;
CREATE FUNCTION public.supplier_manual_refund_channel_lock_v1() RETURNS void
 LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
 AS $smr_lock$${SUPPLIER_MANUAL_REFUND_CHANNEL_LOCK_BODY}$smr_lock$;
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
`;

// Canonical PG16 constraints are independently calibrated by the native suite.
export const SUPPLIER_MANUAL_REFUND_CONSTRAINTS_SHA256 = '69ba73b5ab27126f55d8e1d7567a55c66c5eaf987a6f8869514faa9ba3854f3f';
const tableNames = ['supplier_manual_refund_operation_v1','supplier_manual_refund_proof_v1'] as const;
const operationColumns = [['operation_id','uuid'],['actor_id','integer'],['supplier_id','integer'],['refund_id','integer'],
  ['request_hash','character varying(64)'],['state','character varying(16)'],['intent','jsonb'],['source_hash','character varying(64)'],
  ['proof_hash','character varying(64)'],['result','jsonb'],['created_at','integer']];
const proofColumns = [['refund_id','integer'],['operation_id','uuid'],['actor_id','integer'],['supplier_id','integer'],
  ['order_id','integer'],['payment_order_id','integer'],['buyer_id','integer'],['pay_type','character varying(8)'],
  ['amount','character varying(20)'],['intent','jsonb'],['intent_json','text'],['request_hash','character varying(64)'],
  ['source','jsonb'],['source_json','text'],['source_hash','character varying(64)'],['proof','jsonb'],['proof_json','text'],
  ['proof_hash','character varying(64)'],['transaction_id','bigint'],['created_at','integer']];
const expectedColumns = (columns: string[][], operation: boolean) => columns.map(([name,type],index) => [index+1,name,type,
  !(operation && ['intent','result'].includes(name)),name==='transaction_id'?'txid_current()':null,
  '', '',false, ['text'].includes(type)||type.startsWith('character')?'"default"':null]);

async function inspectSourceLock(tx:Pick<DbClient,'execute'>,kind:'promotion'|'channel',promotionOwner:number) {
  const channel=kind==='channel',name=channel?'supplier_manual_refund_channel_lock_v1':'supplier_manual_refund_promotion_lock_v1';
  const body=channel?SUPPLIER_MANUAL_REFUND_CHANNEL_LOCK_BODY:SUPPLIER_MANUAL_REFUND_PROMOTION_LOCK_BODY;
  const target=channel?'store_order_refund_payment':'store_order_promotions';
  const [state]=await tx.execute(sql`SELECT p.oid::text AS oid,p.proowner::integer AS owner,
    p.prosrc=${body} AND p.prosecdef AND p.prokind='f' AND p.pronargs=0 AND p.proargtypes=''::oidvector
      AND p.prorettype='void'::regtype AND NOT p.proretset AND NOT p.proleakproof AND NOT p.proisstrict
      AND p.provolatile='v' AND p.proparallel='u' AND p.prosupport=0 AND p.provariadic=0 AND p.pronargdefaults=0
      AND p.proargdefaults IS NULL AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL
      AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.protrftypes IS NULL AND p.procost=100 AND p.prorows=0
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp'] AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND (SELECT count(*)=1 FROM pg_catalog.pg_proc WHERE pronamespace=p.pronamespace AND proname=p.proname)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=p.oid) AS definition,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles o ON o.oid=c.relowner
      WHERE c.oid=to_regclass(${'public.'+target}) AND c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relpersistence='p'
       AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.reloptions IS NULL
       AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap') AND c.relnatts=${channel?17:7} AND o.rolsuper
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0 AND attisdropped)
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)) AS target_safe,
    NOT(r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=r.oid)
      AND NOT has_schema_privilege(r.oid,'public','CREATE')
      AND NOT has_parameter_privilege(r.oid,'session_replication_role','SET')
      AND NOT has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
      AND CASE WHEN ${channel} THEN r.oid<>${promotionOwner}::oid
       AND has_table_privilege(r.oid,'public.store_order_refund_payment','UPDATE')
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN('r','p') AND(
         has_table_privilege(r.oid,c.oid,'SELECT,INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege(r.oid,c.oid,'INSERT,REFERENCES')
         OR c.oid<>to_regclass('public.store_order_refund_payment') AND(has_table_privilege(r.oid,c.oid,'UPDATE') OR has_any_column_privilege(r.oid,c.oid,'UPDATE'))))
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee=r.oid AND a.is_grantable)
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc other WHERE other.proowner=r.oid AND other.oid<>p.oid)
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc other JOIN pg_catalog.pg_namespace n ON n.oid=other.pronamespace
        WHERE n.nspname='public' AND other.prosecdef AND other.oid<>p.oid AND has_function_privilege(r.oid,other.oid,'EXECUTE'))
       ELSE r.oid=${promotionOwner}::oid END AS owner_safe,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS acl,
    has_function_privilege(current_user,p.oid,'EXECUTE') AS executable
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.oid=to_regprocedure(${'public.'+name+'()'})`);
  return state;
}

export async function inspectSupplierManualRefund(tx: Pick<DbClient,'execute'>, mode:'read'|'write'='write') {
  const rows = await tx.execute(sql`SELECT c.relname AS name,c.oid::text AS oid,
    current_user=session_user AND current_schema()='public' AND current_setting('server_version_num')::integer/10000=16
      AND current_setting('session_replication_role')='origin'
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.reloptions IS NULL AND c.relreplident='d' AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND c.relnatts=CASE WHEN c.relname='supplier_manual_refund_operation_v1' THEN 11 ELSE 20 END
      AND c.relchecks=CASE WHEN c.relname='supplier_manual_refund_operation_v1' THEN 3 ELSE 5 END
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=c.relowner AND rolsuper)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid OR conrelid=c.oid AND
       (contype NOT IN('p','u','c','n') OR NOT convalidated OR condeferrable OR condeferred OR NOT conislocal OR coninhcount<>0 OR conparentid<>0)) AS safe,
    (SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,a.attisdropped,
      CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END) ORDER BY a.attnum)
     FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid=c.oid AND a.attnum>0) AS columns,
    (SELECT count(*)=CASE WHEN c.relname='supplier_manual_refund_operation_v1' THEN 4 ELSE 7 END
     FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN('p','u','c')) AS constraints_count,
    (SELECT count(*)=CASE WHEN c.relname='supplier_manual_refund_operation_v1' THEN 1 ELSE 2 END
     AND bool_and(i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
       AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct AND i.indnatts=1 AND i.indnkeyatts=1
       AND i.indoption::text='0' AND i.indcollation::text='0' AND i.indexprs IS NULL AND i.indpred IS NULL
       AND ic.relkind='i' AND ic.relpersistence='p' AND ic.relowner=c.relowner AND ic.relnamespace=c.relnamespace
       AND ic.reloptions IS NULL AND ic.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
       AND ((ic.relname='smro_pk' AND c.relname='supplier_manual_refund_operation_v1' AND i.indisprimary AND i.indkey::text='1'
          AND i.indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))
        OR(ic.relname='smrp_pk' AND c.relname='supplier_manual_refund_proof_v1' AND i.indisprimary AND i.indkey::text='1'
          AND i.indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='int4_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=ic.relam))
        OR(ic.relname='smrp_operation_uq' AND c.relname='supplier_manual_refund_proof_v1' AND NOT i.indisprimary AND i.indkey::text='2'
          AND i.indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))))
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgparentid=0
      AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgargs='\\x'::bytea AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND ((t.tgname=CASE WHEN c.relname='supplier_manual_refund_operation_v1' THEN 'smro_immutable_rows' ELSE 'smrp_immutable_rows' END AND t.tgtype=27)
        OR(t.tgname=CASE WHEN c.relname='supplier_manual_refund_operation_v1' THEN 'smro_immutable_truncate' ELSE 'smrp_immutable_truncate' END AND t.tgtype=34)))
     FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${SUPPLIER_MANUAL_REFUND_IMMUTABLE_BODY} AND NOT f.prosecdef AND f.prorettype='trigger'::regtype
      AND f.pronargs=0 AND NOT f.proretset AND NOT f.proleakproof AND NOT f.proisstrict AND f.prokind='f'
      AND f.provolatile='v' AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0
      AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargnames IS NULL AND f.proargmodes IS NULL
      AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL AND f.procost=100 AND f.prorows=0
      AND f.proconfig=ARRAY['search_path=pg_catalog'] AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND (SELECT count(*)=1 FROM pg_catalog.pg_proc WHERE pronamespace=c.relnamespace AND proname=f.proname)
      AND (SELECT count(*)=4 FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a WHERE a.grantee<>f.proowner) AS function,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL)
      AND has_table_privilege(current_user,c.oid,'SELECT') AND (${mode==='read'} OR has_table_privilege(current_user,c.oid,'INSERT'))
      AND(c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
        OR NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS privileges
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.supplier_manual_refund_immutable_v1()')
    WHERE c.oid IN(to_regclass('public.supplier_manual_refund_operation_v1'),to_regclass('public.supplier_manual_refund_proof_v1'))
    ORDER BY c.relname`);
  const [constraints] = await tx.execute(sql`SELECT encode(sha256(convert_to(jsonb_object_agg(name,items ORDER BY name)::text,'UTF8')),'hex') AS hash
    FROM(SELECT c.relname AS name,jsonb_object_agg(k.conname,pg_get_constraintdef(k.oid,false) ORDER BY k.conname) AS items
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid
      WHERE c.oid IN(to_regclass('public.supplier_manual_refund_operation_v1'),to_regclass('public.supplier_manual_refund_proof_v1'))
       AND k.contype IN('p','u','c') GROUP BY c.relname) q`);
  const [promotion] = await tx.execute(sql`SELECT p.oid::text AS oid,p.proowner::integer AS owner,
    p.prosrc=${SUPPLIER_MANUAL_REFUND_PROMOTION_BODY} AND p.prosecdef AND p.prokind='f' AND p.pronargs=2
      AND p.proargtypes='23 23'::oidvector AND p.prorettype='integer'::regtype AND NOT p.proretset
      AND NOT p.proleakproof AND NOT p.proisstrict AND p.provolatile='v' AND p.proparallel='u'
      AND p.prosupport=0 AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargdefaults IS NULL
      AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL AND p.probin IS NULL
      AND p.prosqlbody IS NULL AND p.protrftypes IS NULL AND p.procost=100 AND p.prorows=0
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp'] AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND (SELECT count(*)=1 FROM pg_catalog.pg_proc WHERE pronamespace=p.pronamespace AND proname=p.proname)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=p.oid) AS definition,
    NOT(r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
      AND NOT has_schema_privilege(r.oid,'public','CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN('r','p') AND(has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES') OR c.relname<>'store_order_promotions' AND has_table_privilege(r.oid,c.oid,'DELETE')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc old WHERE old.oid=to_regprocedure('public.customer_manual_refund_promotion_delete_v1(integer,integer)') AND old.proowner<>r.oid)
      AND has_table_privilege(r.oid,'public.supplier_manual_refund_proof_v1','SELECT')
      AND has_table_privilege(r.oid,'public.supplier_manual_refund_operation_v1','SELECT')
      AND has_table_privilege(r.oid,'public.store_order','SELECT') AND has_table_privilege(r.oid,'public.store_order_refund','SELECT')
      AND has_table_privilege(r.oid,'public.store_order_refund_split','SELECT') AND has_table_privilege(r.oid,'public.store_order_promotions','SELECT')
      AND has_table_privilege(r.oid,'public.store_order_promotions','DELETE') AS owner_safe,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
     WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS acl,
    has_function_privilege(current_user,p.oid,'EXECUTE') AS executable
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.oid=to_regprocedure('public.supplier_manual_refund_promotion_delete_v1(integer,integer)')`);
  const promotion_lock=await inspectSourceLock(tx,'promotion',Number(promotion?.owner??0));
  const channel_lock=await inspectSourceLock(tx,'channel',Number(promotion?.owner??0));
  return { rows, constraints_hash:constraints?.hash, promotion,promotion_lock,channel_lock };
}
export async function assertSupplierManualRefundReady(tx: Pick<DbClient,'execute'>, mode:'read'|'write'='write') {
  try {
    await tx.execute(sql`SELECT operation_id FROM public.supplier_manual_refund_operation_v1 LIMIT 0`);
    await tx.execute(sql`SELECT refund_id FROM public.supplier_manual_refund_proof_v1 LIMIT 0`);
    const state=await inspectSupplierManualRefund(tx,mode);
    if(state.rows.length!==2 || state.rows.some((r,i)=>r.name!==tableNames[i]
      || ['supported','safe','constraints_count','indexes','triggers','function','privileges'].some(k=>r[k]!==true)
      || JSON.stringify(r.columns)!==JSON.stringify(expectedColumns(i===0?operationColumns:proofColumns,i===0)))
      || state.constraints_hash!==SUPPLIER_MANUAL_REFUND_CONSTRAINTS_SHA256
      || !state.promotion || ['definition','owner_safe','acl'].some(k=>state.promotion![k]!==true)
      || [state.promotion_lock,state.channel_lock].some(lock=>!lock||['definition','target_safe','owner_safe','acl'].some(k=>lock[k]!==true)
        ||mode==='write'&&lock.executable!==true)
      || mode==='write' && state.promotion.executable!==true)throw Error('Supplier manual refund catalog/ACL drift');
    if(mode==='write') {
      const [identity]=await tx.execute<{role:string;safe:boolean}>(sql`WITH RECURSIVE authority(oid) AS(
       SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(current_user,session_user)
       UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON a.oid=m.member)
       SELECT session_user::text AS role,current_user=session_user AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_catalog.pg_roles r ON r.oid=a.oid
       WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR r.oid IN(${Number(state.promotion.owner)}::oid,${Number(state.channel_lock!.owner)}::oid) OR has_schema_privilege(r.oid,'public','CREATE')
        OR has_parameter_privilege(r.oid,'session_replication_role','SET') OR has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=r.oid)) AS safe`);
      // Explicit owner maintenance may inspect its own newly installed catalog;
      // execution service separately requires an actual restricted LOGIN below.
      const [owner]=await tx.execute(sql`SELECT rolsuper AS maintenance FROM pg_catalog.pg_roles WHERE rolname=current_user`);
      if(owner?.maintenance!==true) {
        if(identity?.safe!==true)throw Error('Supplier manual refund runtime authority unsafe');
        const [guard]=await tx.execute(reviewedManualRefundPromotionLockCatalogQuery(identity.role,Number(state.promotion.owner)));
        if(!guard || ['tablesSafe','definitionSafe','triggerSafe','ownerSafe','roleSafe','aclSafe'].some(k=>guard[k]!==true))throw Error('Supplier promotion guard not commissioned');
      }
    }
  } catch(cause) { throw Object.assign(new ServiceUnavailableException('供应商现金退款协议或实际权限尚未就绪'),{cause}); }
}

export async function installSupplierManualRefund(tx: Pick<DbClient,'execute'>, options:{promotionOwner:string;channelLockOwner:string;runtimeRole?:string}) {
  if(Object.hasOwn(tx,'$client'))throw Error('Supplier manual refund installation requires an existing owner transaction');
  for(const role of [options.promotionOwner,options.channelLockOwner,...(options.runtimeRole?[options.runtimeRole]:[])])
    if(!/^[a-z][a-z0-9_]{0,62}$/.test(role))throw Error('Invalid Supplier manual refund maintenance identity');
  if(options.promotionOwner===options.channelLockOwner)throw Error('Supplier source lock owners must be separate');
  const [gate]=await tx.execute(sql`SELECT current_user=session_user AND current_schema()='public'
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND pg_try_advisory_xact_lock(731627,19) AS supported,
    (to_regclass('public.supplier_manual_refund_operation_v1') IS NOT NULL)::integer
     +(to_regclass('public.supplier_manual_refund_proof_v1') IS NOT NULL)::integer
     +(to_regprocedure('public.supplier_manual_refund_immutable_v1()') IS NOT NULL)::integer
     +(to_regprocedure('public.supplier_manual_refund_promotion_delete_v1(integer,integer)') IS NOT NULL)::integer
     +(to_regprocedure('public.supplier_manual_refund_promotion_lock_v1()') IS NOT NULL)::integer
     +(to_regprocedure('public.supplier_manual_refund_channel_lock_v1()') IS NOT NULL)::integer AS objects`);
  if(gate?.supported!==true)throw Error('Supplier manual refund requires explicit PG16 owner maintenance');
  await tx.execute(sql`SELECT set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
  const [customer]=await tx.execute(sql`SELECT to_regclass('public.customer_financial_manual_refund_v1') IS NOT NULL
    OR to_regprocedure('public.customer_manual_refund_promotion_delete_v1(integer,integer)') IS NOT NULL AS present`);
  if(customer?.present===true&&!(await inspectCustomerManualRefund(tx)).complete)
    throw Error('Existing Customer manual refund catalog requires exact review before composition');
  if(gate.objects!==0) {
    if(gate.objects!==6)throw Error('Partial Supplier manual refund catalog requires review');
    await tx.execute(sql`LOCK TABLE ONLY public.supplier_manual_refund_operation_v1,ONLY public.supplier_manual_refund_proof_v1 IN ACCESS EXCLUSIVE MODE NOWAIT`);
    await assertSupplierManualRefundReady(tx);
    const [owner]=await tx.execute(sql`SELECT pg_get_userbyid(proowner) AS identity FROM pg_catalog.pg_proc
      WHERE oid='public.supplier_manual_refund_promotion_delete_v1(integer,integer)'::regprocedure`);
    if(owner?.identity!==options.promotionOwner)throw Error('Supplier manual promotion owner differs');
    const [channel]=await tx.execute(sql`SELECT pg_get_userbyid(proowner) AS identity FROM pg_catalog.pg_proc
      WHERE oid='public.supplier_manual_refund_channel_lock_v1()'::regprocedure`);
    if(channel?.identity!==options.channelLockOwner)throw Error('Supplier channel-lock owner differs');
    if(options.runtimeRole)await assertRuntimeGrants(tx,options.runtimeRole);
    return {applied:false};
  }
  if(options.runtimeRole) {
    const [r]=await tx.execute(sql`SELECT rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS safe FROM pg_catalog.pg_roles WHERE rolname=${options.runtimeRole}`);
    if(r?.safe!==true)throw Error('Supplier manual refund runtime must be a separate restricted LOGIN');
  }
  await tx.execute(sql`SELECT set_config('cinashop.supplier_manual_refund_owner',${options.promotionOwner},true)`);
  await tx.execute(sql`SELECT set_config('cinashop.supplier_manual_refund_channel_owner',${options.channelLockOwner},true)`);
  await tx.execute(sql.raw(SUPPLIER_MANUAL_REFUND_SQL));
  if(options.runtimeRole)await tx.execute(sql.raw(`GRANT SELECT,INSERT ON public.supplier_manual_refund_operation_v1,public.supplier_manual_refund_proof_v1 TO "${options.runtimeRole}";
    GRANT EXECUTE ON FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer),public.supplier_manual_refund_promotion_lock_v1(),public.supplier_manual_refund_channel_lock_v1() TO "${options.runtimeRole}"`));
  await assertSupplierManualRefundReady(tx);
  if(options.runtimeRole)await assertRuntimeGrants(tx,options.runtimeRole);
  return {applied:true};
}
async function assertRuntimeGrants(tx:Pick<DbClient,'execute'>,role:string) {
  const [row]=await tx.execute(sql`SELECT has_table_privilege(${role},'public.supplier_manual_refund_operation_v1','SELECT')
   AND has_table_privilege(${role},'public.supplier_manual_refund_operation_v1','INSERT')
   AND has_table_privilege(${role},'public.supplier_manual_refund_proof_v1','SELECT')
   AND has_table_privilege(${role},'public.supplier_manual_refund_proof_v1','INSERT')
   AND NOT has_table_privilege(${role},'public.supplier_manual_refund_operation_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   AND NOT has_table_privilege(${role},'public.supplier_manual_refund_proof_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   AND has_function_privilege(${role},'public.supplier_manual_refund_promotion_delete_v1(integer,integer)','EXECUTE')
   AND has_function_privilege(${role},'public.supplier_manual_refund_promotion_lock_v1()','EXECUTE')
   AND has_function_privilege(${role},'public.supplier_manual_refund_channel_lock_v1()','EXECUTE') AS ready`);
  if(row?.ready!==true)throw Error('Supplier manual refund runtime grants require review');
}

/** A private caller cannot supply an OID. Its exact complete protocol, guarded
 * promotion owner and independently authenticated LOGIN privileges come first. */
export async function reviewedSupplierManualRefundCapabilityOids(tx:Pick<DbClient,'execute'>):Promise<string[]> {
  // Metadata-only admission preserves older roles' transaction state. Never
  // attempt a protected SELECT and catch42501: PostgreSQL has already aborted
  // that transaction. An ungranted feature adds no old runtime dependency.
  const [admission]=await tx.execute(sql`SELECT
    COALESCE(has_function_privilege(current_user,to_regprocedure('public.supplier_manual_refund_promotion_delete_v1(integer,integer)'),'EXECUTE'),false) AS deletion,
    COALESCE(has_function_privilege(current_user,to_regprocedure('public.supplier_manual_refund_promotion_lock_v1()'),'EXECUTE'),false) AS promotion_lock,
    COALESCE(has_function_privilege(current_user,to_regprocedure('public.supplier_manual_refund_channel_lock_v1()'),'EXECUTE'),false) AS channel_lock,
    COALESCE(has_table_privilege(current_user,to_regclass('public.supplier_manual_refund_operation_v1'),'SELECT'),false)
      AND COALESCE(has_table_privilege(current_user,to_regclass('public.supplier_manual_refund_operation_v1'),'INSERT'),false)
      AND COALESCE(has_table_privilege(current_user,to_regclass('public.supplier_manual_refund_proof_v1'),'SELECT'),false)
      AND COALESCE(has_table_privilege(current_user,to_regclass('public.supplier_manual_refund_proof_v1'),'INSERT'),false) AS tables`);
  if(!admission||[admission.deletion,admission.promotion_lock,admission.channel_lock].every(value=>value!==true))return[];
  if(admission.tables!==true||[admission.deletion,admission.promotion_lock,admission.channel_lock].some(value=>value!==true))
    throw new ServiceUnavailableException('供应商现金退款组合执行权限不完整');
  // Do not swallow SQL errors; partial/drifted composed grants fail the caller's
  // transaction instead of attempting more SQL in an aborted transaction.
  await assertSupplierManualRefundReady(tx);
  const rows=await tx.execute<{oid:string}>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_proc
    WHERE oid IN('public.supplier_manual_refund_promotion_delete_v1(integer,integer)'::regprocedure,
      'public.supplier_manual_refund_promotion_lock_v1()'::regprocedure,'public.supplier_manual_refund_channel_lock_v1()'::regprocedure) ORDER BY oid`);
  if(rows.length!==3||rows.some(row=>!/^[1-9][0-9]*$/.test(row.oid)))throw new ServiceUnavailableException('供应商现金退款组合能力不完整');
  return rows.map(row=>row.oid);
}

/** Source phantoms are fenced by actual table locks. The runtime receives no
 * source UPDATE/DELETE; fixed independent NOLOGIN owners provide only LOCK. */
export async function lockSupplierManualRefundSources(tx:DbClient) {
  if(Object.hasOwn(tx,'$client'))throw Error('Supplier refund source locks require the original transaction');
  await assertSupplierManualRefundReady(tx);
  await tx.execute(sql`SELECT id FROM public.store_order_refund_payment LIMIT 0`);
  await tx.execute(sql`SELECT id FROM public.store_order_promotions LIMIT 0`);
  await tx.execute(sql`SELECT public.supplier_manual_refund_channel_lock_v1()`);
  await tx.execute(sql`SELECT public.supplier_manual_refund_promotion_lock_v1()`);
  await assertSupplierManualRefundReady(tx);
}
