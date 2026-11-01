import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { OrderNotificationDeliveryDispatcher } from './OrderNotificationDeliveryService';
import { emitOperationalEvent, operationalErrorCode } from '@/utils/observability';

/** Financial settlement has committed. A failed/ambiguous Queue send is
 * recoverable from the durable delivery and never reruns wallet or rights. */
export async function dispatchCommittedRoutineVirtualShipping(container:Container,env:Pick<Env,'ORDER_QUEUE'>,eventKey?:string){
  if(!eventKey)return;
  try{await new OrderNotificationDeliveryDispatcher(container,env.ORDER_QUEUE).dispatchVirtualPaid(eventKey);}
  catch(error){emitOperationalEvent('error',{event:'virtual_paid_shipping_dispatch_failed',component:'queue',
    operation:'notification_delivery',outcome:'failure',errorCode:operationalErrorCode(error)});}
}
