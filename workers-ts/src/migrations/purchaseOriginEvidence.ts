/** Canonical DDL reference; numbered 0163 installs it through the guarded protocol. */
export const PURCHASE_ORIGIN_TABLE_SQL = String.raw`-- Raw definition reference, not a standalone installer; use the guarded 0163 protocol.
-- Install in a caller-owned maintenance transaction on reviewed PostgreSQL 16.
-- Runtime gets SELECT,INSERT on this table only; triggers are SECURITY INVOKER.
-- No historical backfill or cancellation/quota release is performed here.
CREATE TABLE public.store_order_purchase_origin (
  order_id integer PRIMARY KEY CHECK (order_id > 0),
  buyer_id integer NOT NULL CHECK (buyer_id >= 0),
  version text NOT NULL CHECK (version = 'purchase-origin-v1'),
  order_type smallint NOT NULL CHECK (order_type BETWEEN 0 AND 8),
  total_num integer NOT NULL CHECK (total_num > 0),
  used_points bigint NOT NULL CHECK (used_points >= 0),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'
    AND jsonb_array_length(lines) BETWEEN 1 AND 200 AND octet_length(lines::text) <= 131072),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX sopo_buyer_history ON public.store_order_purchase_origin(buyer_id, order_id);
REVOKE ALL ON public.store_order_purchase_origin FROM PUBLIC;

`.replace(/\r\n/g, '\n');

/** Shared by fresh installation and explicitly approved empty ORM completion. */
export const PURCHASE_ORIGIN_PROTECTION_SQL = String.raw`CREATE FUNCTION public.capture_purchase_origin_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  parent record; item record; info jsonb; items jsonb := '[]'::jsonb;
  carts text[] := ARRAY[]::text[]; claimed text[];
  quantity bigint := 0; points bigint := 0; bytes bigint := 0;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_origin'
    OR NEW.version IS NOT NULL OR NEW.order_type IS NOT NULL OR NEW.total_num IS NOT NULL
    OR NEW.used_points IS NOT NULL OR NEW.lines IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purchase origin accepts only order and buyer identity' USING ERRCODE='23514';
  END IF;
  SELECT id, uid, type, pid, paid, status, is_del, is_system_del, supplier_allocation_status,
    refund_status, refund_type, total_num, use_integral, cart_id INTO parent
  FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.pid <> 0 OR parent.paid <> 0
    OR parent.status <> 0 OR parent.is_del <> 0 OR parent.is_system_del <> 0
    OR parent.supplier_allocation_status NOT IN (0,1) OR parent.refund_status <> 0 OR parent.refund_type <> 0
    OR parent.use_integral < 0 OR parent.use_integral <> trunc(parent.use_integral)
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION 'Purchase origin requires an unsplit active unpaid root' USING ERRCODE='23514';
  END IF;
  IF parent.cart_id IS NULL OR length(parent.cart_id) > 2199 OR parent.cart_id !~ '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$' THEN
    RAISE EXCEPTION 'Purchase origin cart identities invalid' USING ERRCODE='23514';
  END IF;
  claimed := string_to_array(parent.cart_id, ',');
  FOR item IN SELECT id, oid, uid, cart_id, old_cart_id, product_id, sku_unique, cart_num,
    refund_num, split_status, split_surplus_num, surplus_num, is_writeoff,
    CASE WHEN octet_length(cart_info) <= 65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF cardinality(carts) >= 200 OR item.uid IS DISTINCT FROM parent.uid OR item.product_id <= 0
      OR item.cart_id !~ '^[1-9][0-9]{0,9}$' OR item.cart_id::bigint > 2147483647
      OR item.cart_id=ANY(carts) OR NOT item.cart_id=ANY(claimed) OR item.old_cart_id <> ''
      OR item.cart_num NOT BETWEEN 1 AND 32767 OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.snapshot IS NULL THEN
      RAISE EXCEPTION 'Purchase origin line ownership or quantity invalid' USING ERRCODE='23514';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes > 8388608 THEN RAISE EXCEPTION 'Purchase origin snapshots too large' USING ERRCODE='23514'; END IF;
    info := item.snapshot::jsonb;
    IF jsonb_typeof(info) IS DISTINCT FROM 'object'
      OR info->>'financial_version' IS DISTINCT FROM 'checkout-line-finance-v1'
      OR info->'id' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->'cart_num' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>'{product,id}' IS DISTINCT FROM to_jsonb(item.product_id)
      OR info ? 'refund_order_generation'
      OR jsonb_typeof(info#>'{sku,id}') IS DISTINCT FROM 'number'
      OR COALESCE(info#>>'{sku,id}', '') !~ '^[1-9][0-9]{0,9}$'
      OR COALESCE(info#>>'{sku,id}', '0')::numeric > 2147483647
      OR NOT (info#>'{sku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)
        OR (parent.type IN (1,2,3) AND info#>'{activitySku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)))
      OR jsonb_typeof(info->'use_integral') IS DISTINCT FROM 'string'
      OR COALESCE(info->>'use_integral','') !~ '^(0|[1-9][0-9]{0,9})$' THEN
      RAISE EXCEPTION 'Purchase origin requires coherent modern checkout evidence' USING ERRCODE='23514';
    END IF;
    carts := array_append(carts,item.cart_id);
    quantity := quantity + item.cart_num; points := points + (info->>'use_integral')::bigint;
    items := items || jsonb_build_array(jsonb_build_object('rowId',item.id,'cartId',item.cart_id,
      'productId',item.product_id,'skuId',(info#>>'{sku,id}')::integer,'skuUnique',item.sku_unique,
      'quantity',item.cart_num,'usedPoints',(info->>'use_integral')::bigint));
  END LOOP;
  IF cardinality(carts)=0 OR cardinality(carts)<>cardinality(claimed)
    OR quantity<>parent.total_num OR points<>parent.use_integral THEN
    RAISE EXCEPTION 'Purchase origin totals do not match checkout' USING ERRCODE='23514';
  END IF;
  NEW.version := 'purchase-origin-v1'; NEW.order_type := parent.type;
  NEW.total_num := quantity; NEW.used_points := points; NEW.lines := items; NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE FUNCTION public.protect_purchase_origin_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Purchase origin evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER sopo_capture BEFORE INSERT ON public.store_order_purchase_origin
  FOR EACH ROW EXECUTE FUNCTION public.capture_purchase_origin_v1();
CREATE TRIGGER sopo_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_purchase_origin
  FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_origin_v1();
CREATE TRIGGER sopo_no_truncate BEFORE TRUNCATE ON public.store_order_purchase_origin
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_purchase_origin_v1();
REVOKE ALL ON FUNCTION public.capture_purchase_origin_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_purchase_origin_v1() FROM PUBLIC;
`.replace(/\r\n/g, '\n');

export const PURCHASE_ORIGIN_DEFINITION_SQL = PURCHASE_ORIGIN_TABLE_SQL + PURCHASE_ORIGIN_PROTECTION_SQL;
