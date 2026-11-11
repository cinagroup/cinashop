/** Dedicated post-allocation task. No generic notification event CHECK or
 * provider-account authority is changed by installing these objects. */
export const PURCHASED_PRODUCT_LABEL_EVENT = 'order.product.labels';
export const PURCHASED_PRODUCT_LABEL_TABLES = ['purchased_product_label_intent',
  'purchased_product_label_state', 'purchased_product_label_result'] as const;
export const PURCHASED_LABEL_IMMUTABLE_BODY = `BEGIN
 RAISE EXCEPTION 'Purchased product label evidence is immutable' USING ERRCODE='42501';
END`;
/** Only the explicit maintenance owner executes this DDL. The intent and
 * success receipt are append-only; worker lease/retry state is separate. */
export const PURCHASED_PRODUCT_LABEL_SQL = `
CREATE TABLE public.purchased_product_label_intent (
 task_id uuid NOT NULL,
 event_key varchar(128) NOT NULL,
 payment_event_id integer NOT NULL,
 payment_order_id integer NOT NULL,
 order_id integer NOT NULL,
 customer_uid integer NOT NULL,
 source_hash varchar(64) NOT NULL,
 source jsonb NOT NULL,
 created_at integer NOT NULL,
 CONSTRAINT ppli_pk PRIMARY KEY(task_id),
 CONSTRAINT ppli_key_uq UNIQUE(event_key),
 CONSTRAINT ppli_source_uq UNIQUE(task_id,source_hash),
 CONSTRAINT ppli_payment_fk FOREIGN KEY(payment_event_id) REFERENCES public.store_order_outbox(id) ON DELETE RESTRICT,
 CONSTRAINT ppli_uuid_ck CHECK(task_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 CONSTRAINT ppli_key_ck CHECK(event_key='order.product.labels:'||payment_order_id::text||':'||order_id::text),
 CONSTRAINT ppli_ids_ck CHECK(payment_event_id>0 AND payment_order_id>0 AND order_id>0 AND customer_uid>0),
 CONSTRAINT ppli_hash_ck CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT ppli_source_ck CHECK(pg_catalog.jsonb_typeof(source)='object' AND
  pg_catalog.octet_length(source::text)<=196608 AND
  source ?& ARRAY['format','paymentEventId','paymentOrderId','paymentOrderNo','paymentSourceHash','orderId','orderNo',
   'userId','financialStoreId','supplierId','orderType','activityId','totalNum','occurredAt','carts'] AND source->'format'='1'::jsonb AND
  source->'paymentEventId'=pg_catalog.to_jsonb(payment_event_id) AND
  source->'paymentOrderId'=pg_catalog.to_jsonb(payment_order_id) AND
  source->'orderId'=pg_catalog.to_jsonb(order_id) AND source->'userId'=pg_catalog.to_jsonb(customer_uid) AND
  pg_catalog.jsonb_typeof(source->'paymentOrderNo')='string' AND pg_catalog.char_length(source->>'paymentOrderNo') BETWEEN 1 AND 50 AND
  pg_catalog.jsonb_typeof(source->'orderNo')='string' AND pg_catalog.char_length(source->>'orderNo') BETWEEN 1 AND 50 AND
  ((order_id=payment_order_id)=(source->>'orderNo'=source->>'paymentOrderNo')) AND
  pg_catalog.jsonb_typeof(source->'paymentSourceHash')='string' AND (source->>'paymentSourceHash') ~ '^[a-f0-9]{64}$' AND
  NOT pg_catalog.jsonb_path_exists(source,'$.keyvalue() ? ((@.key == "financialStoreId" || @.key == "supplierId" || @.key == "activityId" || @.key == "occurredAt") && (@.value.type() != "number" || @.value < 0 || @.value > 2147483647 || @.value.floor() != @.value))') AND
  NOT pg_catalog.jsonb_path_exists(source,'$.orderType ? (@.type() != "number" || @ < 0 || @ > 32767 || @.floor() != @)') AND
  NOT pg_catalog.jsonb_path_exists(source,'$.totalNum ? (@.type() != "number" || @ <= 0 || @ > 2147483647 || @.floor() != @)') AND
  pg_catalog.jsonb_typeof(source->'carts')='array' AND pg_catalog.jsonb_array_length(source->'carts') BETWEEN 1 AND 200 AND
  NOT pg_catalog.jsonb_path_exists(source,'$.carts[*] ? (@.type() != "object" || !exists(@.rowId) || !exists(@.cartId) || !exists(@.productId) || !exists(@.productType) || !exists(@.ownerType) || !exists(@.ownerId) || !exists(@.skuUnique) || !exists(@.quantity) || !exists(@.isGift) || @.rowId.type() != "number" || @.rowId <= 0 || @.rowId > 2147483647 || @.rowId.floor() != @.rowId || @.productId.type() != "number" || @.productId <= 0 || @.productId > 2147483647 || @.productId.floor() != @.productId || @.quantity.type() != "number" || @.quantity <= 0 || @.quantity > 2147483647 || @.quantity.floor() != @.quantity || @.productType.type() != "number" || @.productType < 0 || @.productType > 32767 || @.productType.floor() != @.productType || @.ownerType.type() != "number" || @.ownerType < 0 || @.ownerType > 2 || @.ownerType.floor() != @.ownerType || @.ownerId.type() != "number" || @.ownerId < 0 || @.ownerId > 2147483647 || @.ownerId.floor() != @.ownerId || (@.ownerType > 0 && @.ownerId == 0) || @.isGift.type() != "number" || (@.isGift != 0 && @.isGift != 1) || @.cartId.type() != "string" || !(@.cartId like_regex "^.{1,50}$" flag "s") || @.skuUnique.type() != "string" || !(@.skuUnique like_regex "^.{0,255}$" flag "s"))') AND
  NOT pg_catalog.jsonb_path_exists(source,'$.carts[*].keyvalue() ? (@.key != "rowId" && @.key != "cartId" && @.key != "productId" && @.key != "productType" && @.key != "ownerType" && @.key != "ownerId" && @.key != "skuUnique" && @.key != "quantity" && @.key != "isGift")') AND
  source-ARRAY['format','paymentEventId','paymentOrderId','paymentOrderNo','paymentSourceHash','orderId','orderNo',
   'userId','financialStoreId','supplierId','orderType','activityId','totalNum','occurredAt','carts']='{}'::jsonb),
 CONSTRAINT ppli_created_ck CHECK(created_at>0)
);
CREATE INDEX ppli_payment_idx ON public.purchased_product_label_intent(payment_event_id,order_id);
CREATE INDEX ppli_customer_idx ON public.purchased_product_label_intent(customer_uid,created_at,task_id);
CREATE TABLE public.purchased_product_label_state (
 task_id uuid NOT NULL,
 status varchar(16) DEFAULT 'PENDING' NOT NULL,
 dispatch_count integer DEFAULT 0 NOT NULL,
 attempt_count integer DEFAULT 0 NOT NULL,
 replay_count integer DEFAULT 0 NOT NULL,
 available_at integer DEFAULT 0 NOT NULL,
 lease_until integer DEFAULT 0 NOT NULL,
 lease_token varchar(36) DEFAULT '' NOT NULL,
 last_error varchar(1000) DEFAULT '' NOT NULL,
 processed_at integer DEFAULT 0 NOT NULL,
 updated_at integer NOT NULL,
 CONSTRAINT ppls_pk PRIMARY KEY(task_id),
 CONSTRAINT ppls_intent_fk FOREIGN KEY(task_id) REFERENCES public.purchased_product_label_intent(task_id) ON DELETE RESTRICT,
 CONSTRAINT ppls_status_ck CHECK(status IN('PENDING','ENQUEUING','ENQUEUED','PROCESSING','FAILED','DEAD','COMPLETED')),
 CONSTRAINT ppls_count_ck CHECK(dispatch_count>=0 AND attempt_count>=0 AND replay_count>=0),
 CONSTRAINT ppls_time_ck CHECK(available_at>=0 AND lease_until>=0 AND processed_at>=0 AND updated_at>0),
 CONSTRAINT ppls_lease_ck CHECK(lease_token='' OR lease_token ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
);
CREATE INDEX ppls_pending_idx ON public.purchased_product_label_state(available_at,task_id) WHERE status IN('PENDING','FAILED');
CREATE INDEX ppls_lease_idx ON public.purchased_product_label_state(lease_until,task_id) WHERE status IN('ENQUEUING','ENQUEUED','PROCESSING');
CREATE TABLE public.purchased_product_label_result (
 task_id uuid NOT NULL,
 source_hash varchar(64) NOT NULL,
 result jsonb NOT NULL,
 completed_at integer NOT NULL,
 CONSTRAINT pplr_pk PRIMARY KEY(task_id),
 CONSTRAINT pplr_intent_fk FOREIGN KEY(task_id,source_hash) REFERENCES public.purchased_product_label_intent(task_id,source_hash) ON DELETE RESTRICT,
 CONSTRAINT pplr_hash_ck CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT pplr_result_ck CHECK(pg_catalog.jsonb_typeof(result)='object' AND pg_catalog.octet_length(result::text)<=1048576),
 CONSTRAINT pplr_completed_ck CHECK(completed_at>0)
);
CREATE INDEX pplr_source_idx ON public.purchased_product_label_result(task_id,source_hash);
CREATE FUNCTION public.purchased_product_label_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $ppl$${PURCHASED_LABEL_IMMUTABLE_BODY}$ppl$;
CREATE TRIGGER ppli_immutable_rows BEFORE UPDATE OR DELETE ON public.purchased_product_label_intent
FOR EACH ROW EXECUTE FUNCTION public.purchased_product_label_immutable_v1();
CREATE TRIGGER ppli_immutable_truncate BEFORE TRUNCATE ON public.purchased_product_label_intent
FOR EACH STATEMENT EXECUTE FUNCTION public.purchased_product_label_immutable_v1();
CREATE TRIGGER pplr_immutable_rows BEFORE UPDATE OR DELETE ON public.purchased_product_label_result
FOR EACH ROW EXECUTE FUNCTION public.purchased_product_label_immutable_v1();
CREATE TRIGGER pplr_immutable_truncate BEFORE TRUNCATE ON public.purchased_product_label_result
FOR EACH STATEMENT EXECUTE FUNCTION public.purchased_product_label_immutable_v1();
REVOKE ALL ON public.purchased_product_label_intent,public.purchased_product_label_state,public.purchased_product_label_result FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purchased_product_label_immutable_v1() FROM PUBLIC;
`;
