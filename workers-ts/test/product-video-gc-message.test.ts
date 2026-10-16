import { describe, expect, it } from 'vitest';
import { isProductVideoGcMessage, productVideoGcRoot } from '@/services/system/ProductVideoGcService';
import { prepareOrderQueueDeadLetter } from '@/services/order/OrderQueueDeadLetterService';

describe('video GC Queue and DLQ protocol', () => {
  it.each(['admin', 'supplier'] as const)('allows only the opaque fixed %s scope for replay', scope => {
    const body = productVideoGcRoot(scope);
    expect(isProductVideoGcMessage(body)).toBe(true);
    expect(prepareOrderQueueDeadLetter(body)).toMatchObject({ messageType: body.action, replayPolicy: 'ALLOW', replayMessage: body });
  });
  it.each([null, [], {}, { action: 'dispatchProductVideoCleanup', scope: 'other' },
    { ...productVideoGcRoot('admin'), cursor: '10000000-0000-4000-8000-000000000001' },
    { ...productVideoGcRoot('supplier'), keys: ['attachments/admin/1/owned.mp4'] },
    { ...productVideoGcRoot('supplier'), supplierId: 7 },
    { ...productVideoGcRoot('admin'), leaseToken: '11111111-1111-4111-8111-111111111111' },
    { ...productVideoGcRoot('admin'), scheduledAt: 1792108800000 },
  ])('rejects malformed or caller-selected authority %#', body => {
    expect(isProductVideoGcMessage(body)).toBe(false);
    expect(prepareOrderQueueDeadLetter(body).replayPolicy).toBe('BLOCK_UNSUPPORTED');
  });
});
