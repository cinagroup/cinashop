import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext, reset } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { ProductAutoShelfService } from '../../src/services/product/ProductAutoShelfService';
import type { Env, OrderMessage, ProductAutoShelfMessage, ProductAutoShelfScanMessage, ScheduledMaintenanceMessage } from '../../src/env';
afterEach(async()=>{await reset();vi.restoreAllMocks();});
const scheduledAt=1786276800000, base={job:'product_auto_shelf' as const,runId:`scheduled:${scheduledAt}`,scheduledAt};
describe('actual workerd shelf root/scan/work Queue dispatch with mocked SQL services',()=>{
  const entries: Array<{method:'start'|'scan'|'process';body:ScheduledMaintenanceMessage|ProductAutoShelfScanMessage|ProductAutoShelfMessage}> = [
    {method:'start',body:{...base,action:'runScheduledMaintenance',cursor:0,threshold:null}},
    {method:'scan',body:{...base,action:'scanProductAutoShelf',phase:'on',maximumId:100,cursorTime:0,cursorId:0}},
    {method:'process',body:{...base,action:'processProductAutoShelf',productId:10}},
  ];
  it('enqueues just the product root on the minute cron, retaining the five-minute jobs separately',async()=>{
    const messages:OrderMessage[]=[], bindings={...env,ORDER_QUEUE:{send:async(body:OrderMessage)=>{messages.push(body);},sendBatch:async(batch:Array<{body:OrderMessage}>)=>{messages.push(...batch.map(row=>row.body));}}} as unknown as Env;
    for(const cron of ['* * * * *','*/5 * * * *']) {
      messages.length=0;const context=createExecutionContext();
      await worker.scheduled(createScheduledController({scheduledTime:new Date(scheduledAt),cron}),bindings,context);await waitOnExecutionContext(context);
      if(cron==='* * * * *') expect(messages).toEqual([entries[0].body]);
      else {expect(messages.some(row=>'job' in row && row.job==='product_auto_shelf')).toBe(false);expect(messages.length).toBeGreaterThan(10);}
    }
  });
  it.each(entries)('retries failed $method and acknowledges successful replay without losing the reference',async({method,body})=>{
    const action=vi.spyOn(ProductAutoShelfService.prototype,method).mockRejectedValueOnce(Error('isolated SQL unavailable')).mockResolvedValueOnce({event:'isolated_shelf_completed'});
    for(const attempts of [1,2]) {
      const id=`shelf-${method}-${attempts}`, batch=createMessageBatch<OrderMessage>('cinashop-order-runtime-test',[{id,timestamp:new Date(scheduledAt),attempts,body}]);
      await worker.queue(batch,env as Env); const result=await getQueueResult(batch,createExecutionContext());
      expect(result.explicitAcks).toEqual(attempts===1?[]:[id]); expect(result.retryMessages).toEqual(attempts===1?[{msgId:id}]:[]);
      expect(action).toHaveBeenNthCalledWith(attempts,body);
    }
  });
});
