import { PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL } from './purchaseCancellationGiftEvidence';

const readPhysical=String.raw`  SELECT order_id,buyer_id,version,order_type,total_num,lines INTO physical
    FROM public.store_order_purchase_physical_origin WHERE order_id=NEW.order_id;
  IF physical.order_id IS NOT NULL AND (physical.buyer_id IS DISTINCT FROM NEW.buyer_id
    OR physical.version<>'purchase-physical-origin-v1' OR physical.order_type IS DISTINCT FROM NEW.order_type
    OR physical.total_num IS DISTINCT FROM parent.total_num
    OR (SELECT jsonb_agg(value-'kind'-'gift' ORDER BY (value->>'rowId')::integer)
      FROM jsonb_array_elements(physical.lines) value WHERE value->>'kind'='charged') IS DISTINCT FROM NEW.lines) THEN
    RAISE EXCEPTION 'Cancellation differs from protected physical origin' USING ERRCODE='23514';
  END IF;
`;
const checkLine=String.raw`    IF physical.order_id IS NOT NULL THEN
      SELECT value INTO frozen FROM jsonb_array_elements(physical.lines) value
        WHERE value->'rowId'=to_jsonb(item.id);
      IF NOT FOUND OR frozen IS DISTINCT FROM jsonb_build_object(
        'rowId',item.id,'cartId',item.cart_id,'productId',item.product_id,
        'skuId',info#>'{sku,id}','skuUnique',item.sku_unique,'quantity',item.cart_num,
        'usedPoints',(info->>'use_integral')::bigint,
        'kind',CASE WHEN item.is_gift=1 THEN 'gift' ELSE 'charged' END,
        'gift',CASE WHEN item.is_gift=1 THEN jsonb_build_object(
          'rootId',info#>'{promotion_gift,root_id}','tierId',info#>'{promotion_gift,tier_id}',
          'auxId',info#>'{promotion_gift,aux_id}') ELSE NULL END) THEN
        RAISE EXCEPTION 'Cancellation physical line differs from immutable original' USING ERRCODE='23514';
      END IF;
    END IF;
`;
/** Forward-only body. All 0177 checks remain; old roots without a physical
 * anchor retain their exact cancellation contract. New roots bind every row. */
export const PURCHASE_PHYSICAL_CANCELLATION_VALIDATE_SQL=PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL
  .replace('DECLARE parent record;', 'DECLARE physical record; frozen jsonb; parent record;')
  .replace('  claimed := string_to_array(parent.cart_id, \',\');', readPhysical+"  claimed := string_to_array(parent.cart_id, ',');")
  .replace('    info := item.snapshot::jsonb;', '    info := item.snapshot::jsonb;\n'+checkLine)
  .replace('  RETURN NEW;', String.raw`  IF physical.order_id IS NOT NULL AND jsonb_array_length(physical.lines)<>rows THEN
    RAISE EXCEPTION 'Cancellation physical line coverage incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NEW;`);
export const PURCHASE_PHYSICAL_CANCELLATION_VALIDATE_BODY=PURCHASE_PHYSICAL_CANCELLATION_VALIDATE_SQL.slice(
  PURCHASE_PHYSICAL_CANCELLATION_VALIDATE_SQL.indexOf('AS $$')+5,
  PURCHASE_PHYSICAL_CANCELLATION_VALIDATE_SQL.lastIndexOf('$$;'));
