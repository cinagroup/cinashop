import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext, reset } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { ProductVideoGcService, productVideoGcRoot } from '../../src/services/system/ProductVideoGcService';
import type { Env, OrderMessage } from '../../src/env';

afterEach(async () => { await reset(); vi.restoreAllMocks(); });
const scheduledAt = 1792108800000;
describe('actual workerd video GC cron and Queue with mocked SQL service boundary', () => {
  it('publishes both fixed-scope roots only on the five-minute cron and retains minute shelf behavior', async () => {
    const messages: OrderMessage[] = [];
    const bindings = { ...env, ORDER_QUEUE: { send: async (body: OrderMessage) => { messages.push(body); },
      sendBatch: async (batch: Array<{ body: OrderMessage }>) => { messages.push(...batch.map(row => row.body)); } } } as unknown as Env;
    for (const cron of ['* * * * *', '*/5 * * * *']) {
      messages.length = 0; const context = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: new Date(scheduledAt), cron }), bindings, context);
      await waitOnExecutionContext(context);
      if (cron === '* * * * *') {
        expect(messages).toHaveLength(1); expect(messages[0]).toMatchObject({ job: 'product_auto_shelf' });
      } else expect(messages.filter(row => row.action === 'dispatchProductVideoCleanup')).toEqual([productVideoGcRoot('admin'), productVideoGcRoot('supplier')]);
    }
  });
  it.each(['admin', 'supplier'] as const)('retries failed %s dispatch and acknowledges successful replay', async scope => {
    const body = productVideoGcRoot(scope), action = vi.spyOn(ProductVideoGcService.prototype, 'dispatch')
      .mockRejectedValueOnce(Error('Owned SQL unavailable')).mockResolvedValueOnce({ status: 'advanced', examined: 80, enqueued: 50 });
    for (const attempts of [1, 2]) {
      const id = `video-gc-${scope}-${attempts}`, batch = createMessageBatch<OrderMessage>('cinashop-order-runtime-test', [{ id, timestamp: new Date(scheduledAt), attempts, body }]);
      await worker.queue(batch, env as Env); const result = await getQueueResult(batch, createExecutionContext());
      expect(result.explicitAcks).toEqual(attempts === 1 ? [] : [id]); expect(result.retryMessages).toEqual(attempts === 1 ? [{ msgId: id }] : []);
      expect(action).toHaveBeenNthCalledWith(attempts, body);
    }
  });
  it.each(['busy', 'throttled', 'completed'] as const)('acknowledges %s results without treating an empty page as failure', async status => {
    vi.spyOn(ProductVideoGcService.prototype, 'dispatch').mockResolvedValueOnce({ status, examined: 0, enqueued: 0 });
    const batch = createMessageBatch<OrderMessage>('cinashop-order-runtime-test', [{ id: 'video-gc-' + status, timestamp: new Date(scheduledAt), attempts: 1, body: productVideoGcRoot('admin') }]);
    await worker.queue(batch, env as Env); const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toEqual(['video-gc-' + status]); expect(result.retryMessages).toEqual([]);
  });
});
