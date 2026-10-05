/** Forward-only replacement of the deferred cancellation validator. The
 * purchase-origin capture, source trigger, receipt shape and all old no-gift
 * checks remain untouched. Gift rows are physical extras, never origin lines. */
export const PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL = String.raw`CREATE OR REPLACE FUNCTION public.validate_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent record; item record; info jsonb; expected jsonb; bills record;
  campaign jsonb; gift jsonb; marker jsonb; intent jsonb; expected_gift jsonb;
  gift_map jsonb := '{}'::jsonb; gift_key text; eligible jsonb; eligible_id text;
  rows integer := 0; purchased_rows integer := 0; gift_rows integer := 0;
  gift_count integer := 0; gift_total bigint := 0; bytes bigint := 0;
  claimed text[]; purchased_claimed text[] := ARRAY[]::text[];
  carts text[] := ARRAY[]::text[]; gift_seen text[] := ARRAY[]::text[];
  log_count integer; deduction_count integer := 0; restoration_count integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_cancellation' THEN
    RAISE EXCEPTION 'Invalid purchase cancellation validation source' USING ERRCODE='23514';
  END IF;
  SELECT id,uid,type,pid,paid,status,is_del,is_system_del,supplier_allocation_status,
    refund_status,refund_type,total_num,use_integral,cart_id,promotions_give INTO parent
    FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.type IS DISTINCT FROM NEW.order_type
    OR parent.use_integral IS DISTINCT FROM NEW.restored_points
    OR parent.paid <> 0 OR parent.status <> -2 OR parent.is_del <> 1 OR parent.is_system_del <> 0
    OR parent.pid <> 0 OR parent.supplier_allocation_status NOT IN (0,1)
    OR parent.refund_status <> 0 OR parent.refund_type <> 0
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION 'Purchase cancellation final root does not match origin' USING ERRCODE='23514';
  END IF;
  IF parent.cart_id IS NULL OR length(parent.cart_id)>2199
    OR parent.cart_id !~ '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$' THEN
    RAISE EXCEPTION 'Purchase cancellation cart identities invalid' USING ERRCODE='23514';
  END IF;
  claimed := string_to_array(parent.cart_id, ',');
  IF cardinality(claimed) <> (SELECT count(DISTINCT value) FROM unnest(claimed) AS value) THEN
    RAISE EXCEPTION 'Purchase cancellation cart identities repeat' USING ERRCODE='23514';
  END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    IF jsonb_typeof(expected->'cartId') IS DISTINCT FROM 'string'
      OR (expected->>'cartId') !~ '^[1-9][0-9]{0,9}$'
      OR (expected->>'cartId')::bigint>2147483647
      OR NOT (expected->>'cartId')=ANY(claimed)
      OR (expected->>'cartId')=ANY(purchased_claimed) THEN
      RAISE EXCEPTION 'Purchase cancellation origin cart identities invalid' USING ERRCODE='23514';
    END IF;
    purchased_claimed := array_append(purchased_claimed,expected->>'cartId');
  END LOOP;
  IF parent.promotions_give IS NOT NULL AND parent.promotions_give NOT IN ('','null') THEN
    IF octet_length(parent.promotions_give)>65536 THEN
      RAISE EXCEPTION 'Purchase cancellation gift intent too large' USING ERRCODE='23514';
    END IF;
    intent := parent.promotions_give::jsonb;
    IF jsonb_typeof(intent)='object' AND intent->>'version'='order-promotion-gifts-v1' THEN
      IF jsonb_typeof(intent->'promotions') IS DISTINCT FROM 'array'
        OR jsonb_array_length(intent->'promotions') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Purchase cancellation gift intent invalid' USING ERRCODE='23514';
      END IF;
      FOR campaign IN SELECT value FROM jsonb_array_elements(intent->'promotions') LOOP
        IF jsonb_typeof(campaign) IS DISTINCT FROM 'object'
          OR jsonb_typeof(campaign->'products') IS DISTINCT FROM 'array'
          OR jsonb_typeof(campaign->'eligible_cart_ids') IS DISTINCT FROM 'array'
          OR jsonb_array_length(campaign->'products')>100
          OR jsonb_array_length(campaign->'eligible_cart_ids') NOT BETWEEN 1 AND 200
          OR (campaign->>'id') !~ '^[1-9][0-9]{0,9}$'
          OR (campaign->>'tier_id') !~ '^[1-9][0-9]{0,9}$' THEN
          RAISE EXCEPTION 'Purchase cancellation gift campaign invalid' USING ERRCODE='23514';
        END IF;
        FOR eligible IN SELECT value FROM jsonb_array_elements(campaign->'eligible_cart_ids') LOOP
          eligible_id := eligible #>> '{}';
          IF jsonb_typeof(eligible)<>'string' OR NOT eligible_id=ANY(purchased_claimed) THEN
            RAISE EXCEPTION 'Purchase cancellation gift eligibility differs from purchase' USING ERRCODE='23514';
          END IF;
        END LOOP;
        FOR gift IN SELECT value FROM jsonb_array_elements(campaign->'products') LOOP
          gift_key := gift->>'cart_id';
          IF jsonb_typeof(gift) IS DISTINCT FROM 'object'
            OR jsonb_typeof(gift->'cart_id') IS DISTINCT FROM 'string'
            OR gift_key IS NULL OR gift_key !~ '^[1-9][0-9]{0,9}$'
            OR gift_key::bigint>2147483647
            OR gift_map ? gift_key OR gift_key=ANY(purchased_claimed)
            OR NOT gift_key=ANY(claimed)
            OR (gift->>'product_id') !~ '^[1-9][0-9]{0,9}$'
            OR (gift->>'sku_id') !~ '^[1-9][0-9]{0,9}$'
            OR (gift->>'aux_id') !~ '^[1-9][0-9]{0,9}$'
            OR (gift->>'quantity') !~ '^[1-9][0-9]{0,9}$'
            OR jsonb_typeof(gift->'unique')<>'string'
            OR length(gift->>'unique') NOT BETWEEN 1 AND 8 THEN
            RAISE EXCEPTION 'Purchase cancellation gift identity invalid' USING ERRCODE='23514';
          END IF;
          gift_count := gift_count+1;
          gift_total := gift_total+(gift->>'quantity')::bigint;
          IF gift_count>200-cardinality(claimed) OR gift_total>2147483647 THEN
            RAISE EXCEPTION 'Purchase cancellation gift quantity exceeds bounds' USING ERRCODE='23514';
          END IF;
          gift_map := gift_map||jsonb_build_object(gift_key,jsonb_build_object(
            'root_id',(campaign->>'id')::integer,'tier_id',(campaign->>'tier_id')::integer,
            'aux_id',(gift->>'aux_id')::integer,'product_id',(gift->>'product_id')::integer,
            'sku_id',(gift->>'sku_id')::integer,'unique',gift->>'unique',
            'quantity',(gift->>'quantity')::integer));
        END LOOP;
      END LOOP;
    END IF;
  END IF;
  IF parent.total_num IS DISTINCT FROM NEW.total_num+gift_total THEN
    RAISE EXCEPTION 'Purchase cancellation physical quantity differs from origin and gifts' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT id,uid,cart_id,old_cart_id,product_id,sku_unique,cart_num,refund_num,
    split_status,split_surplus_num,surplus_num,is_writeoff,is_gift,product_type,
    settle_price,write_times,write_surplus_times,promotions_id,
    CASE WHEN octet_length(cart_info)<=65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF rows>=200 OR item.snapshot IS NULL OR item.uid IS DISTINCT FROM NEW.buyer_id
      OR item.old_cart_id <> '' OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.cart_id=ANY(carts) OR item.is_gift NOT IN (0,1) THEN
      RAISE EXCEPTION 'Purchase cancellation line ownership or state invalid' USING ERRCODE='23514';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes>8388608 THEN RAISE EXCEPTION 'Purchase cancellation snapshots too large' USING ERRCODE='23514'; END IF;
    info := item.snapshot::jsonb;
    IF jsonb_typeof(info) IS DISTINCT FROM 'object'
      OR info->>'financial_version' IS DISTINCT FROM 'checkout-line-finance-v1'
      OR info ? 'refund_order_generation' OR info->'id' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->'cart_num' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>'{product,id}' IS DISTINCT FROM to_jsonb(item.product_id) THEN
      RAISE EXCEPTION 'Purchase cancellation snapshot identity invalid' USING ERRCODE='23514';
    END IF;
    IF item.is_gift=0 THEN
      expected := NEW.lines->purchased_rows;
      IF NOT item.cart_id=ANY(purchased_claimed) OR expected IS NULL OR info ? 'promotion_gift'
        OR info#>'{sku,id}' IS DISTINCT FROM expected->'skuId'
        OR NOT (info#>'{sku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)
          OR (parent.type IN (1,2,3) AND info#>'{activitySku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)))
        OR info->'use_integral' IS DISTINCT FROM to_jsonb(expected->>'usedPoints')
        OR expected->'rowId' IS DISTINCT FROM to_jsonb(item.id)
        OR expected->'cartId' IS DISTINCT FROM to_jsonb(item.cart_id)
        OR expected->'productId' IS DISTINCT FROM to_jsonb(item.product_id)
        OR expected->'skuUnique' IS DISTINCT FROM to_jsonb(item.sku_unique)
        OR expected->'quantity' IS DISTINCT FROM to_jsonb(item.cart_num) THEN
        RAISE EXCEPTION 'Purchase cancellation lines differ from original purchase' USING ERRCODE='23514';
      END IF;
      purchased_rows := purchased_rows+1;
    ELSE
      expected_gift := gift_map->item.cart_id;
      marker := info->'promotion_gift';
      IF expected_gift IS NULL OR item.cart_id=ANY(gift_seen)
        OR item.product_id IS DISTINCT FROM (expected_gift->>'product_id')::integer
        OR item.sku_unique IS DISTINCT FROM expected_gift->>'unique'
        OR item.cart_num IS DISTINCT FROM (expected_gift->>'quantity')::integer
        OR info#>'{sku,id}' IS DISTINCT FROM expected_gift->'sku_id'
        OR info#>'{sku,unique}' IS DISTINCT FROM expected_gift->'unique'
        OR marker IS DISTINCT FROM jsonb_build_object('version','order-promotion-gifts-v1',
          'root_id',(expected_gift->>'root_id')::integer,
          'tier_id',(expected_gift->>'tier_id')::integer,
          'aux_id',(expected_gift->>'aux_id')::integer)
        OR item.promotions_id IS DISTINCT FROM expected_gift->>'root_id'
        OR item.product_type<>0 OR item.settle_price<>0
        OR item.write_times<>item.cart_num OR item.write_surplus_times<>item.cart_num
        OR info->>'use_integral' IS DISTINCT FROM '0' OR info->'integral' IS DISTINCT FROM '0'::jsonb
        OR info#>>'{sku,price}' IS DISTINCT FROM '0.00'
        OR info->>'gain_integral' IS DISTINCT FROM '0'
        OR EXISTS(SELECT 1 FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          'sum_price','vip_truePrice','member_postage_price','member_coupon_price',
          'raw_postage_price','postage_price','coupon_price','integral_price',
          'first_order_price','sum_true_price','promotions_true_price','costPrice',
          'one_brokerage','two_brokerage','division_staff_brokerage',
          'division_agent_brokerage','division_brokerage']) AND kv.value<>'0.00')
        OR (SELECT count(*) FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          'sum_price','vip_truePrice','member_postage_price','member_coupon_price',
          'raw_postage_price','postage_price','coupon_price','integral_price',
          'first_order_price','sum_true_price','promotions_true_price','costPrice',
          'one_brokerage','two_brokerage','division_staff_brokerage',
          'division_agent_brokerage','division_brokerage']))<>17 THEN
        RAISE EXCEPTION 'Purchase cancellation gift row differs from strict intent' USING ERRCODE='23514';
      END IF;
      gift_seen := array_append(gift_seen,item.cart_id);
      gift_rows := gift_rows+1;
    END IF;
    rows := rows+1; carts := array_append(carts,item.cart_id);
  END LOOP;
  IF purchased_rows<>jsonb_array_length(NEW.lines) OR purchased_rows<>cardinality(purchased_claimed)
    OR gift_rows<>gift_count OR rows<>purchased_rows+gift_rows
    OR cardinality(claimed)<>purchased_rows+gift_rows THEN
    RAISE EXCEPTION 'Purchase cancellation line coverage incomplete' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO log_count FROM (SELECT id FROM public.store_order_status
    WHERE oid=NEW.order_id AND change_type='cancel' LIMIT 2) s;
  IF log_count<>1 THEN RAISE EXCEPTION 'Purchase cancellation log missing or ambiguous' USING ERRCODE='23514'; END IF;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category='integral' AND type='deduction' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    deduction_count := deduction_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>0 OR bills.event_key<>'order_integral_deduction'
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION 'Purchase cancellation original points ledger inconsistent' USING ERRCODE='23514';
    END IF;
  END LOOP;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category='integral' AND type='order_cancel' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    restoration_count := restoration_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>1 OR bills.event_key<>'order_cancel_integral_back'
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION 'Purchase cancellation restored points ledger inconsistent' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (NEW.restored_points>0 AND (deduction_count<>1 OR restoration_count<>1))
    OR (NEW.restored_points=0 AND (deduction_count<>0 OR restoration_count<>0)) THEN
    RAISE EXCEPTION 'Purchase cancellation points ledger missing or ambiguous' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;`.replace(/\r\n/g, '\n');

/** Stable body used by the exact 0177 catalog check, never a caller claim. */
export const PURCHASE_CANCELLATION_GIFT_VALIDATE_BODY =
  PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL.slice(
    PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL.indexOf('AS $$') + 5,
    PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL.lastIndexOf('$$;'));
