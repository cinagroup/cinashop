import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, reset } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { OrderOutboxService } from '../../src/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService } from '../../src/services/order/OrderNotificationDeliveryService';
import type { Env, OrderMessage, OrderNotificationOutboxMessage } from '../../src/env';
afterEach(async()=>{await reset();vi.restoreAllMocks();});
describe('actual workerd recycle outbox Queue routing with mocked SQL/effect processing',()=>{
  it('keeps the immutable recycle reference on failure and acknowledges a successful replay',async()=>{
    const body:OrderNotificationOutboxMessage={action:'processOrderNotificationOutbox',outboxId:1000,eventKey:'product.recycle.effects:10:01863c9b-5ae1-4583-bb49-983341f6d1c8'};
    const process=vi.spyOn(OrderOutboxService.prototype,'processMessage').mockRejectedValueOnce(Error('isolated recycle effect unavailable')).mockResolvedValueOnce('completed');
    // The generic notification Queue branch also performs this SQL follow-up.
    // Keep that boundary mocked too; no test Hyperdrive TCP connection is used.
    const deliveries=vi.spyOn(OrderNotificationDeliveryService.prototype,'dispatchPending').mockResolvedValue({claimed:0,enqueued:0,unknown:0});
    for(const attempts of [1,2]){
      const id=`recycle-effects-${attempts}`,batch=createMessageBatch<OrderMessage>('cinashop-order-runtime-test',[{id,timestamp:new Date('2026-10-15T00:00:00Z'),attempts,body}]);
      await worker.queue(batch,env as Env);const result=await getQueueResult(batch,createExecutionContext());
      expect(result.explicitAcks).toEqual(attempts===1?[]:[id]);expect(result.retryMessages).toEqual(attempts===1?[{msgId:id}]:[]);
      expect(process).toHaveBeenNthCalledWith(attempts,body);
      expect(deliveries).toHaveBeenNthCalledWith(attempts,10,body.eventKey);
    }
  });
});
