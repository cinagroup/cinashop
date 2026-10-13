import { CUSTOMER_FINANCIAL_INTENT_BODY, CUSTOMER_FINANCIAL_EVIDENCE_BODY } from './customerFinancialOperation';
import {CUSTOMER_MANUAL_GUEST_IDENTITY_UPGRADE_SQL,CUSTOMER_MANUAL_GUEST_IDENTITY_POSTCHECK_SQL} from './customerManualRefundGuestIdentity';

const exact = (value:string,keys:readonly string[]) => `(CASE WHEN pg_catalog.jsonb_typeof(${value}) IS DISTINCT FROM 'object' THEN false ELSE ${value} ?& ARRAY[${keys.map(x=>`'${x}'`).join(',')}]::text[] AND (${value})-ARRAY[${keys.map(x=>`'${x}'`).join(',')}]::text[]='{}'::jsonb END)`;
const d="$2->'payload'->'decision'", oldDecision=exact(d,['apply_type','refund_type','received']);
// Upgrade only execution. Return/refusal and all historical bodies retain their exact keys.
const start=CUSTOMER_FINANCIAL_INTENT_BODY.indexOf(" WHEN 'refund_execute'"),end=CUSTOMER_FINANCIAL_INTENT_BODY.indexOf(" WHEN 'refund_remark'",start);
export const CUSTOMER_MANUAL_REFUND_INTENT_BODY=CUSTOMER_FINANCIAL_INTENT_BODY.slice(0,start)
 +CUSTOMER_FINANCIAL_INTENT_BODY.slice(start,end).replace(oldDecision,()=>`(${oldDecision} OR (${exact(d,['apply_type','refund_type','received','cash_returned'])} AND ${d}->'cash_returned'='true'::jsonb AND $2->'payload'->>'refund_price'<>'0.00'))`)
 +CUSTOMER_FINANCIAL_INTENT_BODY.slice(end);
const cashKeys=['refund_id','refund_no','payment_order_id','uid','store_id','supplier_id','pay_type','amount','cash_returned','manual_proof_hash','verified'];
const number=(v:string,zero=false)=>`(CASE WHEN jsonb_typeof(${v}) IS DISTINCT FROM 'number' OR (${v}#>>'{}') !~ '${zero?'^(0|[1-9][0-9]{0,9})$':'^[1-9][0-9]{0,9}$'}' THEN false ELSE (${v}#>>'{}')::numeric BETWEEN ${zero?0:1} AND 2147483647 END)`;
export const CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY=CUSTOMER_FINANCIAL_EVIDENCE_BODY.replace(" WHEN $2='abandoned' THEN",()=>" WHEN $3->'payload'->'decision'->'cash_returned'='true'::jsonb AND $2<>'cash-settled' THEN false\n WHEN $2='abandoned' THEN").replace(
 "   WHEN $2='provider-admitted'",()=>`
   WHEN $2='zero-settled' THEN ${exact('$4',['refund_id','verified'])} AND $4->'refund_id'=$3->'payload'->'refund_id' AND ${number("$4->'refund_id'")} AND $4->'verified'='true'::jsonb AND $3->'payload'->>'refund_price'='0.00' AND NOT($3->'payload'->'decision' ? 'cash_returned')
   WHEN $2='cash-settled' THEN ${exact('$4',cashKeys)} AND $4->'refund_id'=$3->'payload'->'refund_id' AND ${number("$4->'refund_id'")}
    AND $4->'refund_no'=$3->'payload'->'refund_no' AND ${number("$4->'payment_order_id'")} AND ${number("$4->'uid'",true)} AND ${number("$4->'store_id'",true)} AND ${number("$4->'supplier_id'",true)}
    AND $4->'pay_type' IN('"cash"'::jsonb,'"offline"'::jsonb) AND $4->'amount'=$3->'payload'->'refund_price' AND $4->>'amount'<>'0.00'
    AND $4->'cash_returned'='true'::jsonb AND $3->'payload'->'decision'->'cash_returned'='true'::jsonb
    AND jsonb_typeof($4->'manual_proof_hash')='string' AND $4->>'manual_proof_hash' ~ '^[a-f0-9]{64}$' AND $4->'verified'='true'::jsonb
   WHEN $2='provider-admitted'`);

export const CUSTOMER_MANUAL_REFUND_SQL=`
CREATE OR REPLACE FUNCTION public.customer_financial_intent_valid_v1(text,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_financial_intent$${CUSTOMER_MANUAL_REFUND_INTENT_BODY}$customer_financial_intent$;
CREATE OR REPLACE FUNCTION public.customer_financial_evidence_valid_v1(text,text,jsonb,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_financial_evidence$${CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY}$customer_financial_evidence$;
CREATE TABLE public.customer_financial_manual_refund_v1(
 refund_id integer NOT NULL,actor_uid integer NOT NULL,request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,
 service_id integer NOT NULL,order_id integer NOT NULL,payment_order_id integer NOT NULL,buyer_uid integer NOT NULL,
 store_id integer NOT NULL,supplier_id integer NOT NULL,pay_type varchar(8) NOT NULL,amount varchar(20) NOT NULL,
 settlement varchar(4) NOT NULL,cash_returned boolean NOT NULL,intent jsonb NOT NULL,intent_json text NOT NULL,
 source jsonb NOT NULL,source_json text NOT NULL,source_hash varchar(64) NOT NULL,
 proof jsonb NOT NULL,proof_json text NOT NULL,proof_hash varchar(64) NOT NULL,
 transaction_id bigint NOT NULL DEFAULT txid_current(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cmfr_pk PRIMARY KEY(refund_id),CONSTRAINT cmfr_request_uq UNIQUE(actor_uid,request_key),
 CONSTRAINT cmfr_identity_ck CHECK(refund_id>0 AND actor_uid>0 AND service_id>0 AND order_id>0 AND payment_order_id>0 AND buyer_uid>=0 AND store_id>=0 AND supplier_id>=0),
 CONSTRAINT cmfr_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT cmfr_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND source_hash ~ '^[a-f0-9]{64}$' AND proof_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cmfr_settlement_ck CHECK(pay_type IN('cash','offline') AND amount ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'
  AND ((settlement='cash' AND cash_returned AND amount<>'0.00') OR (settlement='zero' AND NOT cash_returned AND amount='0.00'))),
 CONSTRAINT cmfr_intent_ck CHECK((public.customer_financial_intent_valid_v1('refund_execute',intent)
  AND intent->'order_id'=to_jsonb(order_id) AND intent->'payload'->'refund_id'=to_jsonb(refund_id)
  AND intent->'payload'->'refund_price'=to_jsonb(amount)
  AND ((cash_returned AND intent->'payload'->'decision'->'cash_returned'='true'::jsonb)
    OR (NOT cash_returned AND NOT(intent->'payload'->'decision' ? 'cash_returned')))) IS TRUE),
 CONSTRAINT cmfr_bytes_ck CHECK((octet_length(intent_json)<=262144 AND octet_length(source_json)<=16777216 AND octet_length(proof_json)<=16384
  AND intent_json::jsonb->'input'=intent AND intent_json::jsonb->'actor_uid'=to_jsonb(actor_uid)
  AND intent_json::jsonb->>'kind'='refund_execute' AND intent_json::jsonb->>'version'='customer-work-financial-operation-v1'
  AND source_json::jsonb=source AND proof_json::jsonb=proof
  AND request_hash=encode(sha256(convert_to(intent_json,'UTF8')),'hex')
  AND source_hash=encode(sha256(convert_to(source_json,'UTF8')),'hex')
  AND proof_hash=encode(sha256(convert_to(proof_json,'UTF8')),'hex')) IS TRUE),
 CONSTRAINT cmfr_source_ck CHECK((jsonb_typeof(source)='object' AND source->>'version'='customer-manual-refund-source-v1'
  AND jsonb_typeof(source->'carts')='array' AND jsonb_typeof(source->'promotion_rows')='array' AND source->'order'->'id'=to_jsonb(order_id)
  AND source->'order'->'uid'=to_jsonb(buyer_uid) AND source->'payment'->'root_id'=to_jsonb(payment_order_id)
  AND source->'payment'->'pay_type'=to_jsonb(pay_type)) IS TRUE),
 CONSTRAINT cmfr_proof_ck CHECK((jsonb_typeof(proof)='object' AND proof->>'version'='customer-manual-refund-proof-v1'
  AND proof->'refund_id'=to_jsonb(refund_id) AND proof->'actor_uid'=to_jsonb(actor_uid) AND proof->'request_key'=to_jsonb(request_key::text)
  AND proof->'request_hash'=to_jsonb(request_hash) AND proof->'service_id'=to_jsonb(service_id)
  AND proof->'order_id'=to_jsonb(order_id) AND proof->'payment_order_id'=to_jsonb(payment_order_id)
  AND proof->'buyer_uid'=to_jsonb(buyer_uid) AND proof->'store_id'=to_jsonb(store_id) AND proof->'supplier_id'=to_jsonb(supplier_id)
  AND proof->'pay_type'=to_jsonb(pay_type) AND proof->'amount'=to_jsonb(amount) AND proof->'settlement'=to_jsonb(settlement)
  AND proof->'cash_returned'=to_jsonb(cash_returned) AND proof->'source_hash'=to_jsonb(source_hash)) IS TRUE)
);
CREATE INDEX cmfr_actor_history ON public.customer_financial_manual_refund_v1(actor_uid,created_at,request_key);
REVOKE ALL ON public.customer_financial_manual_refund_v1 FROM PUBLIC;
CREATE FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) RETURNS integer
 LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
 AS $cmfr_promotion$
DECLARE saved public.customer_financial_manual_refund_v1%ROWTYPE;actual jsonb;deleted integer;
BEGIN
 IF current_user=session_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls)
 THEN RAISE EXCEPTION 'Manual promotion deletion requires independent ordinary LOGIN';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(63841,$1);
 PERFORM pg_catalog.pg_advisory_xact_lock(63842,$2);
 SELECT * INTO STRICT saved FROM public.customer_financial_manual_refund_v1 WHERE refund_id=$1 AND order_id=$2;
 IF saved.transaction_id<>pg_catalog.txid_current() OR EXISTS(SELECT 1 FROM public.store_order_refund_split WHERE refund_id=$1)
 OR EXISTS(SELECT 1 FROM public.customer_financial_operation_request WHERE actor_uid=saved.actor_uid AND request_key=saved.request_key)
 OR NOT EXISTS(SELECT 1 FROM public.store_order_refund r JOIN public.store_order o ON o.id=r.store_order_id
 WHERE r.id=$1 AND o.id=$2 AND r.refund_type=6 AND r.refunded_price=r.refund_price AND r.refund_price::text=saved.amount
 AND r.is_cancel=0 AND r.is_del=0 AND o.paid=1 AND o.uid=saved.buyer_uid AND r.uid=o.uid
 AND o.store_id=saved.store_id AND r.store_id=o.store_id AND o.supplier_id=saved.supplier_id AND r.supplier_id=o.supplier_id
 AND o.pay_type=saved.pay_type AND CASE WHEN o.pid>0 THEN o.pid ELSE o.id END=saved.payment_order_id)
 THEN RAISE EXCEPTION 'Manual promotion deletion lacks same transaction physical refund proof';END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'oid',p.oid,'uid',p.uid,'promotions_id',p.promotions_id,'product_id',p.product_id,'promotions_price',p.promotions_price::text,'add_time',p.add_time) ORDER BY p.id),'[]'::jsonb)
 INTO actual FROM public.store_order_promotions p WHERE p.oid=$2;
 IF jsonb_array_length(actual)>200 OR actual IS DISTINCT FROM saved.source->'promotion_rows'
 OR EXISTS(SELECT 1 FROM public.store_order_promotions WHERE oid=$2 AND uid<>saved.buyer_uid)
 THEN RAISE EXCEPTION 'Manual promotion original rows changed';END IF;
 DELETE FROM public.store_order_promotions WHERE oid=$2;
 GET DIAGNOSTICS deleted=ROW_COUNT;RETURN deleted;
END $cmfr_promotion$;
REVOKE ALL ON FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) FROM PUBLIC;
`;
export const CUSTOMER_MANUAL_REFUND_PROTOCOL_INSTALLATION_SQL=`
SET LOCAL search_path=public,pg_temp;SET LOCAL row_security=off;
DO $cmfr_install$ BEGIN
 IF current_setting('server_version_num')::int/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR current_user<>session_user OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=to_regclass('public.customer_financial_operation_request') AND r.rolname=current_user)
 THEN RAISE EXCEPTION 'Manual refund installation requires reviewed PG16 financial owner transaction'; END IF;
 IF NOT pg_try_advisory_xact_lock(731711,0) THEN RAISE EXCEPTION 'Manual refund installation already running'; END IF;
 IF to_regclass('public.customer_financial_manual_refund_v1') IS NOT NULL THEN RAISE EXCEPTION 'Existing manual refund protocol requires exact catalog review'; END IF;
END $cmfr_install$;
${CUSTOMER_MANUAL_REFUND_SQL}
`;
export const CUSTOMER_MANUAL_REFUND_INSTALLATION_SQL=`${CUSTOMER_MANUAL_GUEST_IDENTITY_UPGRADE_SQL}\n${CUSTOMER_MANUAL_GUEST_IDENTITY_POSTCHECK_SQL}\n${CUSTOMER_MANUAL_REFUND_PROTOCOL_INSTALLATION_SQL}`;
