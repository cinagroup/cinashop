/** 0184 adds a final physical-row witness without changing charged origin-v1. */
export const PURCHASE_PHYSICAL_ORIGIN_TABLE_SQL = String.raw`CREATE TABLE public.store_order_purchase_physical_origin (
  order_id integer PRIMARY KEY CHECK (order_id > 0),
  buyer_id integer NOT NULL CHECK (buyer_id >= 0),
  version text NOT NULL CHECK (version = 'purchase-physical-origin-v1'),
  order_type smallint NOT NULL CHECK (order_type BETWEEN 0 AND 8),
  total_num integer NOT NULL CHECK (total_num > 0),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'
    AND jsonb_array_length(lines) BETWEEN 1 AND 200 AND octet_length(lines::text) <= 131072),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX soppo_buyer_history ON public.store_order_purchase_physical_origin(buyer_id,order_id);
REVOKE ALL ON public.store_order_purchase_physical_origin FROM PUBLIC;
`;

export const PURCHASE_PHYSICAL_ORIGIN_CAPTURE_SQL = String.raw`CREATE FUNCTION public.capture_purchase_physical_origin_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent record; original record; item record; info jsonb; expected jsonb;
  intent jsonb; campaign jsonb; gift jsonb; marker jsonb; eligible jsonb;
  gifts jsonb := '{}'::jsonb; gift_key text; items jsonb := '[]'::jsonb;
  claimed text[]; carts text[] := ARRAY[]::text[]; charged text[] := ARRAY[]::text[];
  seen_gifts text[] := ARRAY[]::text[]; charged_items jsonb := '[]'::jsonb;
  quantity bigint := 0; points bigint := 0; bytes bigint := 0; gift_count integer := 0;
  transaction_xid numeric; origin_xid numeric;
BEGIN
  IF TG_OP<>'INSERT' OR TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'store_order_purchase_physical_origin'
    OR NEW.version IS NOT NULL OR NEW.order_type IS NOT NULL OR NEW.total_num IS NOT NULL
    OR NEW.lines IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Physical origin accepts only order and buyer identity' USING ERRCODE='23514';
  END IF;
  SELECT id,uid,type,pid,paid,status,is_del,is_system_del,supplier_allocation_status,
    refund_status,refund_type,total_num,use_integral,cart_id,promotions_give INTO parent
    FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.pid<>0 OR parent.paid<>0
    OR parent.status<>0 OR parent.is_del<>0 OR parent.is_system_del<>0
    OR parent.supplier_allocation_status NOT IN (0,1) OR parent.refund_status<>0 OR parent.refund_type<>0
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION 'Physical origin requires a new active unpaid root' USING ERRCODE='23514';
  END IF;
  SELECT buyer_id,version,order_type,total_num,used_points,lines,xmin::text::bigint AS transaction_id INTO original
    FROM public.store_order_purchase_origin WHERE order_id=NEW.order_id;
  IF NOT FOUND OR original.buyer_id IS DISTINCT FROM NEW.buyer_id OR original.version<>'purchase-origin-v1'
    OR original.order_type IS DISTINCT FROM parent.type OR original.used_points IS DISTINCT FROM parent.use_integral THEN
    RAISE EXCEPTION 'Physical origin requires charged origin captured in this transaction; no backfill' USING ERRCODE='23514';
  END IF;
  -- A visible uncommitted tuple belongs to this transaction, including its
  -- savepoints. An older committed xmin reconstructed forward can lie in the
  -- future; pg_xact_status rejects it. Snapshot xmax can be cached before our
  -- own XID allocation, so it must not reject an actual local top/sub XID.
  transaction_xid := pg_current_xact_id()::text::numeric;
  origin_xid := transaction_xid+mod(original.transaction_id-mod(transaction_xid,4294967296)+4294967296,4294967296);
  BEGIN
    IF pg_xact_status(origin_xid::text::xid8) IS DISTINCT FROM 'in progress' THEN
      RAISE EXCEPTION 'Physical origin requires this transaction or its savepoint' USING ERRCODE='23514';
    END IF;
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE EXCEPTION 'Physical origin cannot backfill a prior transaction' USING ERRCODE='23514';
  END;
  IF parent.cart_id IS NULL OR length(parent.cart_id)>2199
    OR parent.cart_id !~ '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$' THEN
    RAISE EXCEPTION 'Physical origin cart identities invalid' USING ERRCODE='23514';
  END IF;
  claimed := string_to_array(parent.cart_id,',');
  IF cardinality(claimed)<>(SELECT count(DISTINCT value) FROM unnest(claimed) value) THEN
    RAISE EXCEPTION 'Physical origin cart identities repeat' USING ERRCODE='23514';
  END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements(original.lines) LOOP
    charged := array_append(charged,expected->>'cartId');
  END LOOP;
  IF parent.promotions_give IS NOT NULL AND parent.promotions_give NOT IN ('','null') THEN
    IF octet_length(parent.promotions_give)>65536 THEN
      RAISE EXCEPTION 'Physical origin gift intent scope invalid' USING ERRCODE='23514';
    END IF;
    intent := parent.promotions_give::jsonb;
    IF jsonb_typeof(intent)='object' AND intent->>'version'='order-promotion-gifts-v1' THEN
    IF parent.type<>0 OR jsonb_typeof(intent->'promotions') IS DISTINCT FROM 'array'
      OR jsonb_array_length(intent->'promotions') NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'Physical origin gift intent invalid' USING ERRCODE='23514';
    END IF;
    FOR campaign IN SELECT value FROM jsonb_array_elements(intent->'promotions') LOOP
      IF jsonb_typeof(campaign) IS DISTINCT FROM 'object'
        OR jsonb_typeof(campaign->'id') IS DISTINCT FROM 'number'
        OR jsonb_typeof(campaign->'tier_id') IS DISTINCT FROM 'number'
        OR COALESCE(campaign->>'id','') !~ '^[1-9][0-9]{0,9}$' OR (campaign->>'id')::numeric>2147483647
        OR COALESCE(campaign->>'tier_id','') !~ '^[1-9][0-9]{0,9}$' OR (campaign->>'tier_id')::numeric>2147483647
        OR jsonb_typeof(campaign->'products') IS DISTINCT FROM 'array' OR jsonb_array_length(campaign->'products')>100
        OR jsonb_typeof(campaign->'eligible_cart_ids') IS DISTINCT FROM 'array'
        OR jsonb_array_length(campaign->'eligible_cart_ids') NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'Physical origin gift campaign invalid' USING ERRCODE='23514';
      END IF;
      FOR eligible IN SELECT value FROM jsonb_array_elements(campaign->'eligible_cart_ids') LOOP
        IF jsonb_typeof(eligible) IS DISTINCT FROM 'string' OR NOT (eligible #>> '{}')=ANY(charged) THEN
          RAISE EXCEPTION 'Physical origin gift eligibility differs from charged origin' USING ERRCODE='23514';
        END IF;
      END LOOP;
      FOR gift IN SELECT value FROM jsonb_array_elements(campaign->'products') LOOP
        gift_key := gift->>'cart_id';
        IF jsonb_typeof(gift) IS DISTINCT FROM 'object'
          OR jsonb_typeof(gift->'product_id') IS DISTINCT FROM 'number'
          OR jsonb_typeof(gift->'sku_id') IS DISTINCT FROM 'number'
          OR jsonb_typeof(gift->'aux_id') IS DISTINCT FROM 'number'
          OR jsonb_typeof(gift->'quantity') IS DISTINCT FROM 'number'
          OR COALESCE(gift_key,'') !~ '^[1-9][0-9]{0,9}$'
          OR gift_key::numeric>2147483647 OR gifts ? gift_key OR gift_key=ANY(charged) OR NOT gift_key=ANY(claimed)
          OR COALESCE(gift->>'product_id','') !~ '^[1-9][0-9]{0,9}$' OR (gift->>'product_id')::numeric>2147483647
          OR COALESCE(gift->>'sku_id','') !~ '^[1-9][0-9]{0,9}$' OR (gift->>'sku_id')::numeric>2147483647
          OR COALESCE(gift->>'aux_id','') !~ '^[1-9][0-9]{0,9}$' OR (gift->>'aux_id')::numeric>2147483647
          OR COALESCE(gift->>'quantity','') !~ '^[1-9][0-9]{0,4}$' OR (gift->>'quantity')::integer>32767
          OR jsonb_typeof(gift->'unique') IS DISTINCT FROM 'string' OR length(gift->>'unique') NOT BETWEEN 1 AND 8 THEN
          RAISE EXCEPTION 'Physical origin gift identity invalid' USING ERRCODE='23514';
        END IF;
        gift_count := gift_count+1;
        IF gift_count+cardinality(charged)>200 THEN RAISE EXCEPTION 'Physical origin has too many rows' USING ERRCODE='23514'; END IF;
        gifts := gifts||jsonb_build_object(gift_key,gift||jsonb_build_object('root_id',campaign->'id','tier_id',campaign->'tier_id'));
      END LOOP;
    END LOOP;
    END IF;
  END IF;
  FOR item IN SELECT id,uid,cart_id,old_cart_id,product_id,sku_unique,cart_num,refund_num,
    split_status,split_surplus_num,surplus_num,is_writeoff,is_gift,product_type,settle_price,
    write_times,write_surplus_times,promotions_id,
    CASE WHEN octet_length(cart_info)<=65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF cardinality(carts)>=200 OR item.uid IS DISTINCT FROM NEW.buyer_id OR item.product_id<=0
      OR item.cart_id !~ '^[1-9][0-9]{0,9}$' OR item.cart_id::numeric>2147483647
      OR item.cart_id=ANY(carts) OR NOT item.cart_id=ANY(claimed) OR item.old_cart_id<>''
      OR item.cart_num NOT BETWEEN 1 AND 32767 OR item.refund_num<>0 OR item.split_status<>0
      OR item.split_surplus_num<>item.cart_num OR item.surplus_num<>item.cart_num OR item.is_writeoff<>0
      OR item.is_gift NOT IN (0,1) OR item.snapshot IS NULL THEN
      RAISE EXCEPTION 'Physical origin line ownership or quantity invalid' USING ERRCODE='23514';
    END IF;
    bytes := bytes+octet_length(item.snapshot);
    IF bytes>8388608 THEN RAISE EXCEPTION 'Physical origin snapshots too large' USING ERRCODE='23514'; END IF;
    info := item.snapshot::jsonb;
    IF jsonb_typeof(info) IS DISTINCT FROM 'object' OR info->>'financial_version' IS DISTINCT FROM 'checkout-line-finance-v1'
      OR info->'id' IS DISTINCT FROM to_jsonb(item.cart_id) OR info->'cart_num' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>'{product,id}' IS DISTINCT FROM to_jsonb(item.product_id) OR info ? 'refund_order_generation'
      OR jsonb_typeof(info#>'{sku,id}') IS DISTINCT FROM 'number'
      OR COALESCE(info#>>'{sku,id}','') !~ '^[1-9][0-9]{0,9}$' OR (info#>>'{sku,id}')::numeric>2147483647
      OR jsonb_typeof(info->'use_integral') IS DISTINCT FROM 'string'
      OR COALESCE(info->>'use_integral','') !~ '^(0|[1-9][0-9]{0,9})$' THEN
      RAISE EXCEPTION 'Physical origin requires coherent checkout snapshots' USING ERRCODE='23514';
    END IF;
    expected := jsonb_build_object('rowId',item.id,'cartId',item.cart_id,'productId',item.product_id,
      'skuId',(info#>>'{sku,id}')::integer,'skuUnique',item.sku_unique,'quantity',item.cart_num,
      'usedPoints',(info->>'use_integral')::bigint);
    IF item.is_gift=0 THEN
      IF info ? 'promotion_gift' OR gifts ? item.cart_id OR NOT expected=ANY(ARRAY(SELECT value FROM jsonb_array_elements(original.lines))) THEN
        RAISE EXCEPTION 'Physical charged row differs from protected origin' USING ERRCODE='23514';
      END IF;
      charged_items := charged_items||jsonb_build_array(expected);
      items := items||jsonb_build_array(expected||jsonb_build_object('kind','charged','gift',NULL));
    ELSE
      gift := gifts->item.cart_id;
      marker := jsonb_build_object('version','order-promotion-gifts-v1','root_id',gift->'root_id','tier_id',gift->'tier_id','aux_id',gift->'aux_id');
      IF gift IS NULL OR item.cart_id=ANY(seen_gifts) OR item.product_id IS DISTINCT FROM (gift->>'product_id')::integer
        OR item.sku_unique IS DISTINCT FROM gift->>'unique' OR item.cart_num IS DISTINCT FROM (gift->>'quantity')::integer
        OR info#>'{sku,id}' IS DISTINCT FROM gift->'sku_id' OR info#>'{sku,unique}' IS DISTINCT FROM gift->'unique'
        OR info->'promotion_gift' IS DISTINCT FROM marker OR item.promotions_id IS DISTINCT FROM gift->>'root_id'
        OR item.product_type<>0 OR item.settle_price<>0 OR item.write_times<>item.cart_num OR item.write_surplus_times<>item.cart_num
        OR info->>'use_integral' IS DISTINCT FROM '0' OR info->'integral' IS DISTINCT FROM '0'::jsonb
        OR info#>>'{sku,price}' IS DISTINCT FROM '0.00' OR info->>'gain_integral' IS DISTINCT FROM '0'
        OR (SELECT count(*) FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          'sum_price','vip_truePrice','member_postage_price','member_coupon_price','raw_postage_price','postage_price',
          'coupon_price','integral_price','first_order_price','sum_true_price','promotions_true_price','costPrice',
          'one_brokerage','two_brokerage','division_staff_brokerage','division_agent_brokerage','division_brokerage']) AND kv.value='0.00')<>17 THEN
        RAISE EXCEPTION 'Physical gift row differs from frozen intent or zero-priced snapshot' USING ERRCODE='23514';
      END IF;
      seen_gifts := array_append(seen_gifts,item.cart_id);
      items := items||jsonb_build_array(expected||jsonb_build_object('kind','gift','gift',
        jsonb_build_object('rootId',gift->'root_id','tierId',gift->'tier_id','auxId',gift->'aux_id')));
    END IF;
    carts := array_append(carts,item.cart_id);quantity := quantity+item.cart_num;points := points+(info->>'use_integral')::bigint;
  END LOOP;
  IF cardinality(carts)<>cardinality(claimed) OR quantity<>parent.total_num OR points<>original.used_points
    OR charged_items IS DISTINCT FROM original.lines OR cardinality(seen_gifts)<>gift_count THEN
    RAISE EXCEPTION 'Physical origin does not cover exact charged and gift rows' USING ERRCODE='23514';
  END IF;
  NEW.version := 'purchase-physical-origin-v1';NEW.order_type := parent.type;
  NEW.total_num := quantity;NEW.lines := items;NEW.recorded_at := clock_timestamp();RETURN NEW;
END $$;
`;
export const PURCHASE_PHYSICAL_ORIGIN_PROTECT_SQL = String.raw`CREATE FUNCTION public.protect_purchase_physical_origin_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Physical origin evidence is append-only' USING ERRCODE='42501'; END $$;
`;
export const PURCHASE_PHYSICAL_ORIGIN_PROTECTION_SQL = PURCHASE_PHYSICAL_ORIGIN_CAPTURE_SQL+PURCHASE_PHYSICAL_ORIGIN_PROTECT_SQL+String.raw`CREATE TRIGGER soppo_capture BEFORE INSERT ON public.store_order_purchase_physical_origin
  FOR EACH ROW EXECUTE FUNCTION public.capture_purchase_physical_origin_v1();
CREATE TRIGGER soppo_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_purchase_physical_origin
  FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_physical_origin_v1();
CREATE TRIGGER soppo_no_truncate BEFORE TRUNCATE ON public.store_order_purchase_physical_origin
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_purchase_physical_origin_v1();
REVOKE ALL ON FUNCTION public.capture_purchase_physical_origin_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_purchase_physical_origin_v1() FROM PUBLIC;
`;
export const PURCHASE_PHYSICAL_ORIGIN_DEFINITION_SQL=PURCHASE_PHYSICAL_ORIGIN_TABLE_SQL+PURCHASE_PHYSICAL_ORIGIN_PROTECTION_SQL;
export function physicalOriginFunctionBody(source:string):string {
  return source.slice(source.indexOf('AS $$')+5,source.lastIndexOf('$$;'));
}
