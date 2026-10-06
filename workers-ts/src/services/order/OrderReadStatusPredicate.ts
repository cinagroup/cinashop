import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { storeOrder } from '@/models/schema';

/** PHP StoreOrderDao selector 1: paid orders still awaiting fulfillment.
 * Status 4 is partially shipped; raw status 1 is already shipped. Actor,
 * store and parent-family scope remain explicit in each caller's query. */
export function unshippedOrderStatusPredicate(): SQL {
  return and(
    eq(storeOrder.paid, 1),
    inArray(storeOrder.status, [0, 4]),
    inArray(storeOrder.refundStatus, [0, 3]),
    inArray(storeOrder.shippingType, [1, 3]),
    eq(storeOrder.isDel, 0),
    eq(storeOrder.isSystemDel, 0),
  )!;
}

/** All fourteen legacy business selectors. Caller owns store/user/parent scope. */
export function orderReadStatusPredicate(selector: number | null): SQL {
  if(selector===null)return sql`true`;
  const paid=eq(storeOrder.paid,1),alive=eq(storeOrder.isDel,0),refund=inArray(storeOrder.refundStatus,[0,3]);
  switch(selector){
    case 0:return and(eq(storeOrder.paid,0),eq(storeOrder.status,0),eq(storeOrder.refundStatus,0),alive)!;
    case 1:return and(paid,inArray(storeOrder.status,[0,4]),refund,inArray(storeOrder.shippingType,[1,3]),alive)!;
    case 2:return and(paid,or(and(inArray(storeOrder.status,[1,5]),eq(storeOrder.shippingType,1)),and(inArray(storeOrder.status,[0,5]),eq(storeOrder.shippingType,2))),refund,alive)!;
    case 3:return and(paid,eq(storeOrder.status,2),refund,alive)!;
    case 4:return and(paid,eq(storeOrder.status,3),refund,alive)!;
    case 5:return and(paid,inArray(storeOrder.status,[0,1,5]),refund,eq(storeOrder.shippingType,2),alive)!;
    case 6:return and(paid,eq(storeOrder.status,2),refund,eq(storeOrder.shippingType,2),alive)!;
    case 7:return and(paid,eq(storeOrder.status,4),refund,alive)!;
    case 8:return and(paid,inArray(storeOrder.status,[0,1,2,5]),refund,eq(storeOrder.shippingType,2),alive)!;
    case 9:return and(paid,inArray(storeOrder.status,[2,3]),refund,alive)!;
    case -1:return and(paid,inArray(storeOrder.refundStatus,[1,4]),alive)!;
    case -2:return and(paid,eq(storeOrder.refundStatus,2),alive)!;
    case -3:return and(paid,inArray(storeOrder.refundStatus,[1,2,4]),alive)!;
    case -4:return eq(storeOrder.isDel,1);
    default:throw new Error('Unsupported order business selector');
  }
}
