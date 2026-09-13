/** Unregistered protocol definition. Only the owned-test candidate installs it.
 * Registration and complete runtime/maintenance privilege policy remain open. */
export const SHIPPING_LIFECYCLE_CANDIDATE_SQL = String.raw`
CREATE FUNCTION public.shipping_lifecycle_ref(temp integer, freight integer) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog,pg_temp
AS $$ SELECT CASE WHEN temp>0 THEN temp WHEN freight NOT IN (1,2) THEN 1 ELSE 0 END $$;

CREATE FUNCTION public.shipping_lifecycle_bind(template integer, owner_type integer, owner_id integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET row_security=off AS $$
DECLARE parent record;
BEGIN
 IF template=0 THEN RETURN; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='25000',MESSAGE='Shipping lifecycle requires READ COMMITTED';
 END IF;
 SELECT s.id,s.owner_type,s.relation_id,s.is_del,s.status INTO parent
 FROM public.shipping_templates s WHERE s.id=template FOR SHARE NOWAIT;
 IF NOT FOUND OR parent.is_del<>0 OR parent.status<>1 OR owner_type NOT IN (0,1,2)
   OR (owner_type=0 AND owner_id<>0) OR (owner_type<>0 AND owner_id<=0)
   OR parent.owner_type<>owner_type OR parent.relation_id<>owner_id THEN
  RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping template binding is unavailable or belongs to another owner';
 END IF;
END $$;

CREATE FUNCTION public.shipping_lifecycle_child() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET row_security=off AS $$
DECLARE incoming jsonb; previous jsonb; source record; reference integer; dependent integer;
BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME NOT IN
  ('store_product','store_seckill','store_bargain','store_combination','store_integral','store_discounts_products') THEN
  RAISE EXCEPTION 'Unexpected shipping lifecycle table';
 END IF;
 IF TG_OP<>'DELETE' THEN incoming=to_jsonb(NEW); END IF;
 IF TG_OP<>'INSERT' THEN previous=to_jsonb(OLD); END IF;
 -- Zero is the only unbound/default sentinel. Reject negative stored IDs before
 -- either free/fixed freight or an unchanged-row shortcut can hide invalid data.
 IF TG_OP<>'DELETE' AND (incoming->>'temp_id')::integer<0 THEN
  RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping template ID cannot be negative';
 END IF;
 -- Final values, not UPDATE's column list: catches a BEFORE trigger rebinding
 -- during an apparently unrelated update. Ordinary price/stock writes are free.
 IF TG_OP='UPDATE' AND (incoming->'id',incoming->'temp_id',incoming->'freight',incoming->'product_id',incoming->'type',incoming->'relation_id')
  IS NOT DISTINCT FROM (previous->'id',previous->'temp_id',previous->'freight',previous->'product_id',previous->'type',previous->'relation_id') THEN
  RETURN NULL;
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='25000',MESSAGE='Shipping lifecycle requires READ COMMITTED';
 END IF;
 IF TG_TABLE_NAME='store_product' THEN
  -- Product ownership is also the authority for independent activity bindings.
  -- Hold the actual product write lock already acquired by the outer DML;
  -- acquire templates in ID order, NOWAIT, without waiting in reverse order.
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (NEW.id,NEW.type,NEW.relation_id) IS DISTINCT FROM (OLD.id,OLD.type,OLD.relation_id)) THEN
   FOR dependent IN SELECT DISTINCT refs.ref FROM (
    SELECT public.shipping_lifecycle_ref(temp_id,freight) AS ref FROM public.store_seckill WHERE product_id=OLD.id
    UNION ALL SELECT public.shipping_lifecycle_ref(temp_id,freight) FROM public.store_bargain WHERE product_id=OLD.id
    UNION ALL SELECT public.shipping_lifecycle_ref(temp_id,freight) FROM public.store_combination WHERE product_id=OLD.id
    UNION ALL SELECT public.shipping_lifecycle_ref(temp_id,freight) FROM public.store_integral WHERE product_id=OLD.id
    UNION ALL SELECT public.shipping_lifecycle_ref(temp_id,2) FROM public.store_discounts_products WHERE product_id=OLD.id
   ) refs WHERE refs.ref>0 ORDER BY refs.ref LOOP
    IF TG_OP='DELETE' OR NEW.id<>OLD.id THEN
     RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping activity still references the source product';
    END IF;
    PERFORM public.shipping_lifecycle_bind(dependent,NEW.type,NEW.relation_id);
   END LOOP;
  END IF;
  IF TG_OP='DELETE' THEN RETURN NULL; END IF;
  PERFORM public.shipping_lifecycle_bind(public.shipping_lifecycle_ref(NEW.temp_id,NEW.freight),NEW.type,NEW.relation_id);
 ELSE
  IF TG_OP='DELETE' THEN RETURN NULL; END IF;
  reference=public.shipping_lifecycle_ref((incoming->>'temp_id')::integer,COALESCE((incoming->>'freight')::integer,2));
  IF reference>0 THEN
   SELECT p.id,p.type,p.relation_id INTO source FROM public.store_product p
    WHERE p.id=(incoming->>'product_id')::integer FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping source product is missing'; END IF;
   PERFORM public.shipping_lifecycle_bind(reference,source.type,source.relation_id);
  END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION public.shipping_lifecycle_parent() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET row_security=off AS $$
BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'shipping_templates' THEN RAISE EXCEPTION 'Unexpected shipping parent table'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.owner_type,NEW.relation_id,NEW.is_del,NEW.status) IS NOT DISTINCT FROM
     (OLD.id,OLD.owner_type,OLD.relation_id,OLD.is_del,OLD.status) THEN RETURN NULL; END IF;
  IF NEW.id=OLD.id AND NEW.owner_type=OLD.owner_type AND NEW.relation_id=OLD.relation_id
    AND NEW.is_del=0 AND NEW.status=1 THEN RETURN NULL; END IF;
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='25000',MESSAGE='Shipping lifecycle requires READ COMMITTED';
 END IF;
 -- VOLATILE SPI reads a fresh RC snapshot after the parent DML lock is held.
 -- Child admission's SHARE lock prevents a successful concurrent retirement.
 IF EXISTS(SELECT 1 FROM public.store_product WHERE public.shipping_lifecycle_ref(temp_id,freight)=OLD.id)
 OR EXISTS(SELECT 1 FROM public.store_seckill WHERE public.shipping_lifecycle_ref(temp_id,freight)=OLD.id)
 OR EXISTS(SELECT 1 FROM public.store_bargain WHERE public.shipping_lifecycle_ref(temp_id,freight)=OLD.id)
 OR EXISTS(SELECT 1 FROM public.store_combination WHERE public.shipping_lifecycle_ref(temp_id,freight)=OLD.id)
 OR EXISTS(SELECT 1 FROM public.store_integral WHERE public.shipping_lifecycle_ref(temp_id,freight)=OLD.id)
 OR EXISTS(SELECT 1 FROM public.store_discounts_products WHERE public.shipping_lifecycle_ref(temp_id,2)=OLD.id) THEN
  RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping template is still referenced';
 END IF;
 RETURN NULL;
END $$;

CREATE TRIGGER shipping_lifecycle_parent AFTER UPDATE OR DELETE ON public.shipping_templates
 FOR EACH ROW EXECUTE FUNCTION public.shipping_lifecycle_parent();
CREATE TRIGGER shipping_lifecycle_child AFTER INSERT OR UPDATE OR DELETE ON public.store_product
 FOR EACH ROW EXECUTE FUNCTION public.shipping_lifecycle_child();
CREATE TRIGGER shipping_lifecycle_child AFTER INSERT OR UPDATE OR DELETE ON public.store_seckill
 FOR EACH ROW EXECUTE FUNCTION public.shipping_lifecycle_child();
CREATE TRIGGER shipping_lifecycle_child AFTER INSERT OR UPDATE OR DELETE ON public.store_bargain
 FOR EACH ROW EXECUTE FUNCTION public.shipping_lifecycle_child();
CREATE TRIGGER shipping_lifecycle_child AFTER INSERT OR UPDATE OR DELETE ON public.store_combination
 FOR EACH ROW EXECUTE FUNCTION public.shipping_lifecycle_child();
CREATE TRIGGER shipping_lifecycle_child AFTER INSERT OR UPDATE OR DELETE ON public.store_integral
 FOR EACH ROW EXECUTE FUNCTION public.shipping_lifecycle_child();
CREATE TRIGGER shipping_lifecycle_child AFTER INSERT OR UPDATE OR DELETE ON public.store_discounts_products
 FOR EACH ROW EXECUTE FUNCTION public.shipping_lifecycle_child();
CREATE FUNCTION public.shipping_lifecycle_no_truncate() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping template/source TRUNCATE requires a separate maintenance protocol'; END $$;
CREATE TRIGGER shipping_lifecycle_no_truncate BEFORE TRUNCATE ON public.shipping_templates
 FOR EACH STATEMENT EXECUTE FUNCTION public.shipping_lifecycle_no_truncate();
CREATE TRIGGER shipping_lifecycle_no_truncate BEFORE TRUNCATE ON public.store_product
 FOR EACH STATEMENT EXECUTE FUNCTION public.shipping_lifecycle_no_truncate();
`;

// Closed manifest, independent of the observed database. Bodies are extracted
// only from the fixed version-controlled DDL above, never from catalog output.
const functionSpecs = [
  ['shipping_lifecycle_ref', '23 23', ['temp', 'freight'], 23, 'sql', 'i', true, false],
  ['shipping_lifecycle_bind', '23 23 23', ['template', 'owner_type', 'owner_id'], 2278, 'plpgsql', 'v', false, true],
  ['shipping_lifecycle_child', '', null, 2279, 'plpgsql', 'v', false, true],
  ['shipping_lifecycle_parent', '', null, 2279, 'plpgsql', 'v', false, true],
  ['shipping_lifecycle_no_truncate', '', null, 2279, 'plpgsql', 'v', false, false],
] as const;
export const SHIPPING_LIFECYCLE_FUNCTIONS = functionSpecs.map(([name, args, argNames, returns, language, volatility, strict, rls]) => {
  const body = SHIPPING_LIFECYCLE_CANDIDATE_SQL.match(new RegExp(`CREATE FUNCTION public\\.${name}\\([^]*?AS \\$\\$([^]*?)\\$\\$;`))?.[1];
  if (body === undefined) throw new Error('Shipping protocol manifest has no function body');
  return { name, args, argNames, returns, language, volatility, strict, body,
    config: ['search_path=pg_catalog, pg_temp', ...(rls ? ['row_security=off'] : [])] };
});
export const SHIPPING_LIFECYCLE_TRIGGERS = [
  { table: 'shipping_templates', name: 'shipping_lifecycle_parent', function: 'shipping_lifecycle_parent', type: 25 },
  ...['store_product', 'store_seckill', 'store_bargain', 'store_combination', 'store_integral', 'store_discounts_products']
    .map(table => ({ table, name: 'shipping_lifecycle_child', function: 'shipping_lifecycle_child', type: 29 })),
  ...['shipping_templates', 'store_product'].map(table =>
    ({ table, name: 'shipping_lifecycle_no_truncate', function: 'shipping_lifecycle_no_truncate', type: 34 })),
];
