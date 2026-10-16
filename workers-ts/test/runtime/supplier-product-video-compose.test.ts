import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Env, OrderMessage } from '../../src/env';
import { composeProductVideo, type ProductVideoComposition } from '../../src/services/system/ProductVideoCompose';
import { SupplierProductVideoUploadService } from '../../src/services/supplier/SupplierProductVideoUploadService';
import worker from '../../src/index';

const bucket = (env as unknown as Env).ASSETS_BUCKET;
afterEach(async () => { await reset(); vi.restoreAllMocks(); });
async function seed() {
  const upload = crypto.randomUUID(), bytes = Uint8Array.from({ length: 43 }, (_, index) => index);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  const parts: ProductVideoComposition['parts'] = [];
  for (let index = 0; index < 3; index++) {
    const chunk = bytes.slice(index * 16, (index + 1) * 16), key = `attachments/tmp/supplier/7/1/${upload}/${index + 1}.part`;
    await bucket.put(key, chunk);
    parts.push({ key, size: chunk.length, sha256: createHash('sha256').update(chunk).digest('hex') });
  }
  return { bytes, plan: { destination: `attachments/supplier/7/2026/10/${upload}.mp4`, parts } };
}
it('verifies ordered digests through native workerd FixedLengthStream and the isolated R2 binding', async () => {
  const { bytes, plan } = await seed(), stored = await composeProductVideo(bucket, plan);
  expect(stored.size).toBe(bytes.length);
  const object = await bucket.get(plan.destination);
  expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
  expect(object!.httpMetadata?.contentType).toBe('video/mp4');
  const range = await bucket.get(plan.destination, { range: { offset: 16, length: 8 } });
  expect(range!.range).toEqual({ offset: 16, length: 8 }); expect(new Uint8Array(await range!.arrayBuffer())).toEqual(bytes.slice(16, 24));
});
it('refuses changed source bytes without deleting or replacing an existing final object', async () => {
  const { plan } = await seed(); await bucket.put(plan.destination, 'already-published-object');
  await bucket.put(plan.parts[1].key, new Uint8Array(16));
  await expect(composeProductVideo(bucket, plan)).rejects.toThrow('内容已变化');
  expect(await (await bucket.get(plan.destination))!.text()).toBe('already-published-object');
});
it('returns an early provider rejection promptly with the actual native fixed stream', async () => {
  const { plan } = await seed(), refused = Error('Owned early provider rejection');
  const failing = { get: bucket.get.bind(bucket), put: async () => { throw refused; } } as unknown as R2Bucket;
  await expect(composeProductVideo(failing, plan)).rejects.toBe(refused);
  expect(await bucket.get(plan.destination)).toBeNull();
}, 3000);
it('rejects mixed sessions and owners before any R2 I/O', async () => {
  const { plan } = await seed(); let calls = 0;
  const noIo = { get: async () => { calls++; throw Error('Unexpected R2 get'); }, put: async () => { calls++; throw Error('Unexpected R2 put'); } } as unknown as R2Bucket;
  for (const changed of [
    { ...plan, parts: plan.parts.map(part => ({ ...part, key: part.key.replace('/supplier/7/1/', '/admin/1/') })) },
    { ...plan, destination: plan.destination.replace('/supplier/7/', '/admin/1/') },
    { ...plan, destination: plan.destination.replace('/supplier/7/', '/supplier/8/') },
    { ...plan, parts: plan.parts.map((part, index) => index === 1 ? { ...part, key: part.key.replace('/supplier/7/1/', '/supplier/7/2/') } : part) },
    { ...plan, parts: plan.parts.map((part, index) => index === 1 ? { ...part, key: part.key.replace(/\/2\.part$/, '/1.part') } : part) },
  ]) await expect(composeProductVideo(noIo, changed)).rejects.toThrow('上下文');
  expect(calls).toBe(0);
});
it.each([false, true])('actual Queue handler acknowledges only completed guarded cleanup (failure=%s)', async failure => {
  const message = { action: 'cleanupSupplierVideoUpload' as const, uploadId: crypto.randomUUID() };
  const cleanup = vi.spyOn(SupplierProductVideoUploadService.prototype, 'cleanup');
  if (failure) cleanup.mockRejectedValueOnce(Error('Owned guarded cleanup failure'));
  else cleanup.mockResolvedValueOnce({ deleted: 2, deferred: false });
  const context = createExecutionContext(), batch = createMessageBatch<OrderMessage>('cinashop-order-runtime-test', [{
    id: 'video-cleanup', timestamp: new Date(), attempts: 1, body: message,
  }]);
  await worker.queue(batch, env as unknown as Env);
  expect(cleanup).toHaveBeenCalledExactlyOnceWith(message);
  const result = await getQueueResult(batch, context);
  expect(result.explicitAcks).toEqual(failure ? [] : ['video-cleanup']);
  expect(result.retryMessages).toEqual(failure ? [{ msgId: 'video-cleanup' }] : []);
});
