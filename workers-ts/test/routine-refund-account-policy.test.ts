import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { appendRoutineRefundAccountPolicy, type RoutineRefundAccountPolicy } from '@/services/payment/RoutineRefundAccountPolicy';

const data = (): RoutineRefundAccountPolicy => ({ accountId: 'old_routine_refunds', state: 'active', appId: 'wx_old',
  merchantId: '1234567890', credentialRef: 'archived_merchant', credentialVersion: 1, credentialStamp: 'a'.repeat(64),
  purposes: ['refund_query'], validFrom: 1700000000, validUntil: 1700000300 });
const target = { database: 'owned_test', maintenance: 'maintenance_test', app: 'app_test', admin: 'admin_test' };

describe('Routine refund maintenance input boundary', () => {
  it.each([
    ['payment query purpose', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'purposes', ['query'])],
    ['payment notify purpose', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'purposes', ['notify'])],
    ['duplicate purpose', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'purposes', ['refund_query', 'refund_query'])],
    ['empty purposes', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'purposes', [])],
    ['unknown state', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'state', 'accepted')],
    ['unbounded validity', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'validUntil', d.validFrom + 366 * 86400 + 1)],
    ['zero validity', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'validUntil', d.validFrom)],
    ['missing material version', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'credentialVersion', 0)],
    ['unbounded version', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'credentialVersion', Number.MAX_SAFE_INTEGER)],
    ['URL material selector', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'credentialRef', 'https://keys.example/old')],
    ['non-primitive merchant', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'merchantId', 1234567890)],
    ['unknown public data', (d: RoutineRefundAccountPolicy) => Reflect.set(d, 'providerRequest', {})],
  ])('rejects %s before opening SQL', async (_label, change) => {
    const transaction = vi.fn(), d = data(); change(d);
    await expect(appendRoutineRefundAccountPolicy({ transaction } as unknown as DbClient, { APP_KEY: 'owned-phase29-input-key' },
      target, { operationId: randomUUID(), expectedRevision: 0, data: d })).rejects.toMatchObject({ code: 503 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('never invokes property accessors, array accessors or object coercions to construct an approval', async () => {
    const getter = vi.fn(() => 'refund_query'), coercion = vi.fn(() => 'wx_old');
    const property = data(); Object.defineProperty(property, 'appId', { enumerable: true, get: getter });
    const array = data(); Object.defineProperty(array.purposes, '0', { enumerable: true, get: getter });
    const object = data(); Reflect.set(object, 'appId', { toString: coercion, toJSON: coercion });
    const sparse = data(); Reflect.set(sparse, 'purposes', Array(1));
    const extended = data(); Reflect.set(extended.purposes, 'extra', 'refund_notify');
    for (const d of [property, array, object, sparse, extended]) {
      const transaction = vi.fn();
      await expect(appendRoutineRefundAccountPolicy({ transaction } as unknown as DbClient, { APP_KEY: 'owned-phase29-input-key' },
        target, { operationId: randomUUID(), expectedRevision: 0, data: d })).rejects.toMatchObject({ code: 503 });
      expect(transaction).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled(); expect(coercion).not.toHaveBeenCalled();
  });

  it.each([-1, 64, 1.5, '0', null])('rejects invalid expected revision %s before opening SQL', async expectedRevision => {
    const transaction = vi.fn();
    await expect(appendRoutineRefundAccountPolicy({ transaction } as unknown as DbClient, { APP_KEY: 'owned-phase29-input-key' },
      target, { operationId: randomUUID(), expectedRevision: expectedRevision as number, data: data() })).rejects.toMatchObject({ code: 503 });
    expect(transaction).not.toHaveBeenCalled();
  });
});
