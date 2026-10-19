import { eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { storeOrder } from '@/models/schema';
import { orderReadStatusPredicate } from '@/services/order/OrderReadStatusPredicate';
import type { SupplierOrderListInput } from './SupplierOrderListInput';

/** Scalar EXISTS only: never return a payment parent's address, answers, money
 * or provider fields. The outer list remains the tenant's physical rows. */
function parentNumber(keyword: string): SQL {
  return sql`EXISTS(SELECT 1 FROM public.store_order r WHERE r.id=${storeOrder.pid} AND r.pid=-1
    AND r.order_id=${keyword} AND r.uid=${storeOrder.uid} AND r.is_system_del=0
    AND ((r.supplier_id=${storeOrder.supplierId} AND r.store_id=${storeOrder.storeId})
      OR (r.supplier_id=0 AND r.store_id=0 AND r.supplier_allocation_status=2)))`;
}
export function supplierOrderListConditions(supplierId: number, input: SupplierOrderListInput): SQL[] {
  const { keyword, field } = input;
  const conditions: SQL[] = [eq(storeOrder.supplierId, supplierId), eq(storeOrder.isSystemDel, 0), gte(storeOrder.pid, 0)];
  if (input.paid !== null) conditions.push(eq(storeOrder.paid, input.paid));
  if (input.status !== null) conditions.push(eq(storeOrder.status, input.status));
  if (input.businessStatus !== null) conditions.push(orderReadStatusPredicate(input.businessStatus));
  if (input.type !== null) conditions.push(input.type === 105 ? eq(storeOrder.shippingType, 2)
    : input.type === 106 ? eq(storeOrder.shippingType, 4) : input.type === 107 ? inArray(storeOrder.shippingType, [1, 3]) : eq(storeOrder.type, input.type));
  if (input.payType) conditions.push(eq(storeOrder.payType, input.payType));
  if (input.start !== null) conditions.push(gte(storeOrder.addTime, input.start));
  if (input.end !== null) conditions.push(lte(storeOrder.addTime, input.end));
  if (!keyword) return conditions;
  if (field === 'legacy') {
    // Preserve unversioned wildcard and three-field precedence behavior.
    const pattern = `%${keyword}%`;
    conditions.push(or(ilike(storeOrder.orderId, pattern), ilike(storeOrder.realName, pattern), ilike(storeOrder.userPhone, pattern))!);
    return conditions;
  }
  const pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
  const title = sql`EXISTS(SELECT 1 FROM public.store_order_cart_info c JOIN public.store_product p ON p.id=c.product_id
    WHERE c.oid=${storeOrder.id} AND c.uid=${storeOrder.uid}
      AND ((c.type IN(0,2) AND c.relation_id=${storeOrder.supplierId}) OR (c.type=0 AND c.relation_id=0
        AND NOT EXISTS(SELECT 1 FROM public.store_order_cart_info legacy WHERE legacy.oid=${storeOrder.id}
          AND (legacy.uid<>${storeOrder.uid} OR legacy.type<>0 OR legacy.relation_id<>0))))
      AND ((p.type=2 AND p.relation_id=${storeOrder.supplierId}) OR (p.type=0 AND p.relation_id=0))
      AND (p.store_name ILIKE ${pattern} OR p.keyword ILIKE ${pattern}))`;
  if (field === 'uid' || field === 'total_num') conditions.push(eq(field === 'uid' ? storeOrder.uid : storeOrder.totalNum, Number(keyword)));
  else if (field === 'title') conditions.push(title);
  else if (field === 'order_id') conditions.push(or(eq(storeOrder.orderId, keyword), parentNumber(keyword))!);
  else if (field === 'real_name' || field === 'user_phone') conditions.push(eq(field === 'real_name' ? storeOrder.realName : storeOrder.userPhone, keyword));
  else conditions.push(or(ilike(storeOrder.orderId, pattern), ilike(storeOrder.realName, pattern), ilike(storeOrder.userPhone, pattern), parentNumber(keyword), title,
    sql`EXISTS(SELECT 1 FROM public."user" u WHERE u.uid=${storeOrder.uid} AND (u.nickname ILIKE ${pattern} OR u.phone ILIKE ${pattern} OR u.uid::text ILIKE ${pattern}))`,
    sql`EXISTS(SELECT 1 FROM public.user_address a WHERE a.uid=${storeOrder.uid} AND (a.real_name ILIKE ${pattern} OR a.phone ILIKE ${pattern} OR a.uid::text ILIKE ${pattern}))`,
    sql`(${storeOrder.type}=1 AND EXISTS(SELECT 1 FROM public.store_seckill a WHERE a.id=${storeOrder.activityId}
      AND ((a.type=2 AND a.relation_id=${storeOrder.supplierId}) OR (a.type=0 AND a.relation_id=0)) AND (a.store_name ILIKE ${pattern} OR a.info ILIKE ${pattern})))`,
    sql`(${storeOrder.type}=2 AND EXISTS(SELECT 1 FROM public.store_bargain a WHERE a.id=${storeOrder.activityId}
      AND ((a.type=2 AND a.relation_id=${storeOrder.supplierId}) OR (a.type=0 AND a.relation_id=0)) AND (a.title ILIKE ${pattern} OR a.info ILIKE ${pattern})))`,
    sql`(${storeOrder.type}=3 AND EXISTS(SELECT 1 FROM public.store_combination a WHERE a.id=${storeOrder.activityId}
      AND ((a.type=2 AND a.relation_id=${storeOrder.supplierId}) OR (a.type=0 AND a.relation_id=0)) AND (a.store_name ILIKE ${pattern} OR a.info ILIKE ${pattern})))`)!);
  return conditions;
}
