/** Canonical registered definition, not a standalone installer. Use the guarded
 * runPurchaseCancellationEvidence protocol for catalog/ownership/ACL checks.
 * No backfill or quota policy. ORM construction needs explicit empty completion.
 * Runtime needs SELECT,INSERT on the receipt and existing source read rights.
 * All functions are invoker-only; schema owners/business writers remain trusted.
 */
export const PURCHASE_CANCELLATION_TABLE_SQL = String.raw`
CREATE TABLE public.store_order_purchase_cancellation (
  order_id integer PRIMARY KEY CHECK (order_id > 0),
  buyer_id integer NOT NULL CHECK (buyer_id >= 0),
  version text NOT NULL CHECK (version = 'purchase-cancellation-v1'),
  order_type smallint NOT NULL CHECK (order_type BETWEEN 0 AND 8),
  total_num integer NOT NULL CHECK (total_num > 0),
  restored_points bigint NOT NULL CHECK (restored_points BETWEEN 0 AND 9999999999),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'
    AND jsonb_array_length(lines) BETWEEN 1 AND 200 AND octet_length(lines::text) <= 131072),
  origin_recorded_at timestamptz NOT NULL,
  cancelled_at timestamptz NOT NULL
);
CREATE INDEX sopc_buyer_history ON public.store_order_purchase_cancellation(buyer_id, order_id);
REVOKE ALL ON public.store_order_purchase_cancellation FROM PUBLIC;

`.replace(/\r\n/g, '\n');

/** Shared by fresh installation and explicit exact empty-ORM completion. */
export const PURCHASE_CANCELLATION_PROTECTION_SQL = String.raw`-- Only a live unpaid->cancelled UPDATE can initiate capture. Existing cancelled
-- orders and orders without a trusted origin stay outside the evidence domain.
CREATE FUNCTION public.begin_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order'
    OR pg_trigger_depth() <> 1 THEN
    RAISE EXCEPTION 'Purchase cancellation requires a direct order transition' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.store_order_purchase_origin WHERE order_id=OLD.id) THEN RETURN NEW; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.uid IS DISTINCT FROM NEW.uid
    OR OLD.type IS DISTINCT FROM NEW.type OR OLD.total_num IS DISTINCT FROM NEW.total_num
    OR OLD.use_integral IS DISTINCT FROM NEW.use_integral OR OLD.cart_id IS DISTINCT FROM NEW.cart_id
    OR OLD.paid <> 0 OR OLD.status <> 0 OR OLD.is_del <> 0 OR OLD.is_system_del <> 0
    OR OLD.pid <> 0 OR OLD.supplier_allocation_status NOT IN (0,1)
    OR OLD.refund_status <> 0 OR OLD.refund_type <> 0
    OR NEW.paid <> 0 OR NEW.status <> -2 OR NEW.is_del <> 1 OR NEW.is_system_del <> 0
    OR NEW.pid <> 0 OR NEW.supplier_allocation_status NOT IN (0,1)
    OR NEW.refund_status <> 0 OR NEW.refund_type <> 0 THEN
    RAISE EXCEPTION 'Purchase cancellation requires an unsplit unpaid root transition' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.store_order_purchase_cancellation(order_id,buyer_id) VALUES (NEW.id,NEW.uid);
  RETURN NEW;
END $$;

CREATE FUNCTION public.capture_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE origin record;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_cancellation'
    OR pg_trigger_depth() <> 2 OR NEW.version IS NOT NULL OR NEW.order_type IS NOT NULL
    OR NEW.total_num IS NOT NULL OR NEW.restored_points IS NOT NULL OR NEW.lines IS NOT NULL
    OR NEW.origin_recorded_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purchase cancellation cannot be inserted or backfilled directly' USING ERRCODE='23514';
  END IF;
  SELECT buyer_id,version,order_type,total_num,used_points,lines,recorded_at INTO origin
    FROM public.store_order_purchase_origin WHERE order_id=NEW.order_id;
  IF NOT FOUND OR origin.buyer_id IS DISTINCT FROM NEW.buyer_id OR origin.version <> 'purchase-origin-v1' THEN
    RAISE EXCEPTION 'Purchase cancellation requires trusted purchase origin' USING ERRCODE='23514';
  END IF;
  NEW.version := 'purchase-cancellation-v1'; NEW.order_type := origin.order_type;
  NEW.total_num := origin.total_num; NEW.restored_points := origin.used_points;
  NEW.lines := origin.lines; NEW.origin_recorded_at := origin.recorded_at; NEW.cancelled_at := clock_timestamp();
  RETURN NEW;
END $$;

-- Deferred validation runs after compensation and the cancel log, before COMMIT.
-- This proves the transition/evidence and points ledger agree. Inventory/cart/
-- coupon compensation remains the trusted atomic service's responsibility;
-- current stock/balance is not misrepresented as historical compensation proof.
CREATE FUNCTION public.validate_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent record; item record; info jsonb; expected jsonb; bills record;
  rows integer := 0; bytes bigint := 0; claimed text[]; carts text[] := ARRAY[]::text[];
  log_count integer; deduction_count integer := 0; restoration_count integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_cancellation' THEN
    RAISE EXCEPTION 'Invalid purchase cancellation validation source' USING ERRCODE='23514';
  END IF;
  SELECT id,uid,type,pid,paid,status,is_del,is_system_del,supplier_allocation_status,
    refund_status,refund_type,total_num,use_integral,cart_id INTO parent
    FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.type IS DISTINCT FROM NEW.order_type
    OR parent.total_num IS DISTINCT FROM NEW.total_num OR parent.use_integral IS DISTINCT FROM NEW.restored_points
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
  FOR item IN SELECT id,uid,cart_id,old_cart_id,product_id,sku_unique,cart_num,refund_num,
    split_status,split_surplus_num,surplus_num,is_writeoff,
    CASE WHEN octet_length(cart_info)<=65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF rows>=200 OR item.snapshot IS NULL OR item.uid IS DISTINCT FROM NEW.buyer_id
      OR item.old_cart_id <> '' OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.cart_id=ANY(carts) OR NOT item.cart_id=ANY(claimed) THEN
      RAISE EXCEPTION 'Purchase cancellation line ownership or state invalid' USING ERRCODE='23514';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes>8388608 THEN RAISE EXCEPTION 'Purchase cancellation snapshots too large' USING ERRCODE='23514'; END IF;
    info := item.snapshot::jsonb; expected := NEW.lines->rows;
    IF expected IS NULL OR jsonb_typeof(info) IS DISTINCT FROM 'object'
      OR info->>'financial_version' IS DISTINCT FROM 'checkout-line-finance-v1'
      OR info ? 'refund_order_generation'
      OR info->'id' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->'cart_num' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>'{product,id}' IS DISTINCT FROM to_jsonb(item.product_id)
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
    rows := rows+1; carts := array_append(carts,item.cart_id);
  END LOOP;
  IF rows<>jsonb_array_length(NEW.lines) OR rows<>cardinality(claimed) THEN
    RAISE EXCEPTION 'Purchase cancellation line coverage incomplete' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO log_count FROM (SELECT id FROM public.store_order_status
    WHERE oid=NEW.order_id AND change_type='cancel' LIMIT 2) s;
  IF log_count<>1 THEN RAISE EXCEPTION 'Purchase cancellation log missing or ambiguous' USING ERRCODE='23514'; END IF;
  -- Use the existing category/type/link index, not an unbounded all-user scan.
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
END $$;

CREATE FUNCTION public.protect_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Purchase cancellation evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER sopc_capture BEFORE INSERT ON public.store_order_purchase_cancellation
  FOR EACH ROW EXECUTE FUNCTION public.capture_purchase_cancellation_v1();
CREATE TRIGGER sopc_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_purchase_cancellation
  FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_cancellation_v1();
CREATE TRIGGER sopc_no_truncate BEFORE TRUNCATE ON public.store_order_purchase_cancellation
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_purchase_cancellation_v1();
CREATE CONSTRAINT TRIGGER sopc_validate AFTER INSERT ON public.store_order_purchase_cancellation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_purchase_cancellation_v1();
CREATE TRIGGER sopc_order_transition AFTER UPDATE ON public.store_order
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status=-2)
  EXECUTE FUNCTION public.begin_purchase_cancellation_v1();
REVOKE ALL ON FUNCTION public.begin_purchase_cancellation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_purchase_cancellation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_purchase_cancellation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_purchase_cancellation_v1() FROM PUBLIC;
`.replace(/\r\n/g, '\n');

export const PURCHASE_CANCELLATION_DEFINITION_SQL = PURCHASE_CANCELLATION_TABLE_SQL + PURCHASE_CANCELLATION_PROTECTION_SQL;
