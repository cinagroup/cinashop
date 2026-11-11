import { describe, expect, it, vi } from 'vitest';
import type { OrderMessage } from '@/env';
import { capturePurchasedProductLabelMessage, capturePurchasedProductLabelDispatch,
  isPurchasedProductLabelMessage } from '@/services/order/PurchasedProductLabelQueue';
import { consumePurchasedProductLabelQueueMessage } from '@/services/order/PurchasedProductLabelQueueConsumer';
import { prepareOrderQueueDeadLetter } from '@/services/order/OrderQueueDeadLetterService';
import { requiredAdminPermission } from '@/services/admin/AdminPermissionService';
const ref = { action: 'processPurchasedProductLabels' as const, taskId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', eventKey: 'order.product.labels:1:2' };
describe('purchased label reference-only Queue and authenticated recovery contracts', () => {
  it('captures detached immutable references and a closed scanner command', () => {
    const input = { ...ref }, captured = capturePurchasedProductLabelMessage(input);
    input.eventKey = 'order.product.labels:3:4'; expect(captured).toEqual(ref); expect(Object.isFrozen(captured)).toBe(true);
    expect(capturePurchasedProductLabelDispatch({ action: 'dispatchPurchasedProductLabels' })).toEqual({ action: 'dispatchPurchasedProductLabels' });
    expect(() => capturePurchasedProductLabelDispatch({ action: 'dispatchPurchasedProductLabels', taskId: ref.taskId })).toThrow();
  });
  it.each([
    { ...ref, uid: 11 }, { ...ref, labelIds: [1] }, { ...ref, source: {} }, { ...ref, taskId: '../task' },
    { ...ref, taskId: ref.taskId.toUpperCase() }, { ...ref, eventKey: 'order.product.labels:01:2' },
    { ...ref, eventKey: 'order.product.labels:1:0' }, Object.create(ref),
  ])('refuses business facts or noncanonical identities in Queue messages: %j', input => {
    expect(isPurchasedProductLabelMessage(input)).toBe(false);
    expect(prepareOrderQueueDeadLetter(input).replayPolicy).not.toBe('ALLOW');
  });
  it('does not invoke caller getters or coercion hooks', () => {
    const getter = vi.fn(), coercion = vi.fn();
    expect(() => capturePurchasedProductLabelMessage(Object.defineProperty({ ...ref }, 'eventKey', { enumerable: true, get: getter }))).toThrow();
    expect(() => capturePurchasedProductLabelMessage({ ...ref, eventKey: { toString: coercion } })).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(coercion).not.toHaveBeenCalled();
  });
  it.each(['completed', 'already-completed', 'dead', 'not-found'] as const)('acknowledges durable %s outcomes', async outcome => {
    const service = { process: vi.fn(async () => outcome), dispatchPending: vi.fn() }, ack = vi.fn(), retry = vi.fn();
    await consumePurchasedProductLabelQueueMessage({ body: ref, attempts: 1, ack, retry }, service);
    expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled(); expect(service.process).toHaveBeenCalledWith(ref);
  });
  it('backs off busy leases and transport failures without acknowledging them', async () => {
    for (const attempt of [1, 2, 8, 100]) {
      const service = { process: vi.fn(async () => 'busy' as const), dispatchPending: vi.fn() }, ack = vi.fn(), retry = vi.fn();
      await consumePurchasedProductLabelQueueMessage({ body: ref, attempts: attempt, ack, retry }, service);
      expect(ack).not.toHaveBeenCalled(); expect(retry).toHaveBeenCalledWith({ delaySeconds: Math.min(30 * 2 ** (attempt-1), 900) });
    }
    const ack = vi.fn(), retry = vi.fn(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await consumePurchasedProductLabelQueueMessage({ body: ref, attempts: 2, ack, retry },
        { process: vi.fn(async () => { throw Error('owned transport failure'); }), dispatchPending: vi.fn() });
      expect(ack).not.toHaveBeenCalled(); expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    } finally { log.mockRestore(); }
  });
  it('dispatches scanner commands without supplying customer or product facts', async () => {
    const service = { process: vi.fn(), dispatchPending: vi.fn(async () => ({ claimed: 0, enqueued: 0 })) }, ack = vi.fn(), retry = vi.fn();
    await consumePurchasedProductLabelQueueMessage({ body: { action: 'dispatchPurchasedProductLabels' } as OrderMessage, attempts: 1, ack, retry }, service);
    expect(service.dispatchPending).toHaveBeenCalledWith(); expect(service.process).not.toHaveBeenCalled(); expect(ack).toHaveBeenCalledOnce();
  });
  it('archives only closed task references or scanner commands for guarded replay', () => {
    expect(prepareOrderQueueDeadLetter(ref)).toMatchObject({ replayPolicy: 'ALLOW', body: ref, replayMessage: ref });
    expect(prepareOrderQueueDeadLetter({ action: 'dispatchPurchasedProductLabels' })).toMatchObject({ replayPolicy: 'ALLOW', replayMessage: { action: 'dispatchPurchasedProductLabels' } });
  });
  it('uses existing Outbox view/manage capabilities instead of broad order management', () => {
    expect(requiredAdminPermission('GET', '/api/admin/order/product-label-tasks')).toBe('outbox.view');
    expect(requiredAdminPermission('POST', '/api/admin/order/product-label-tasks/:id/replay')).toBe('outbox.manage');
  });
});
