import { describe, expect, it } from 'vitest';
import type { DbClient } from '@/lib/di';
import { assertSupplierOrderPriceRevisionReady, SUPPLIER_ORDER_PRICE_REVISION_CHECK_DEFINITION } from '@/migrations/supplierOrderPriceRevision';
import { REFUND_SUCCESS_NOTICE_SUCCESSORS } from '@/migrations/refundSuccessNotice';
import { ROUTINE_VIRTUAL_SHIPPING_SUBJECT_DEFINITION, routineVirtualShippingEventDefinition } from '@/migrations/routineVirtualShippingSubjects';

// Catalog stubs exercise the SELECT-only business admission gate. Actual ALTER
// and preservation of database rows/ACLs belong to native PostgreSQL validation.
function target(definition: string, partialVirtual = false) {
  const calls: unknown[] = [];
  const tx = { execute: async (query: unknown) => {
    calls.push(query);
    if (calls.length === 1) return [];
    if (calls.length === 2) return [{ supported: true, safe: true, definition }];
    return [{ safe: true, core: true, subject_safe: true, event_safe: true,
      event_definition: definition, subject_columns: 2, columns_ready: true,
      indexes: 1, index_ready: !partialVirtual, subject_definition: ROUTINE_VIRTUAL_SHIPPING_SUBJECT_DEFINITION,
      maintenance: 'owned_maintenance', maintenance_oid: '17' }];
  } } as unknown as Pick<DbClient, 'execute'>;
  return { tx, calls };
}

describe('refund-success whitelist preserves Supplier price admission', () => {
  it.each([
    [SUPPLIER_ORDER_PRICE_REVISION_CHECK_DEFINITION, 2],
    [routineVirtualShippingEventDefinition(true), 3],
    [REFUND_SUCCESS_NOTICE_SUCCESSORS[1], 2],
    [REFUND_SUCCESS_NOTICE_SUCCESSORS[3], 3],
  ] as const)('accepts the exact price-enabled catalog %s', async (definition, count) => {
    const t = target(definition);
    await expect(assertSupplierOrderPriceRevisionReady(t.tx)).resolves.toBeUndefined();
    expect(t.calls).toHaveLength(count);
  });

  it.each([
    REFUND_SUCCESS_NOTICE_SUCCESSORS[0], REFUND_SUCCESS_NOTICE_SUCCESSORS[2],
    REFUND_SUCCESS_NOTICE_SUCCESSORS[1].replace('order.refund.success.notice', 'order.refund.success.notice.extra'),
    REFUND_SUCCESS_NOTICE_SUCCESSORS[3].replace("'order.price.revision'", "'order.unregistered.revision'"),
  ])('rejects a missing price event or unregistered whitelist %s', async definition => {
    const t = target(definition);
    await expect(assertSupplierOrderPriceRevisionReady(t.tx)).rejects.toMatchObject({ httpStatus: 503 });
    expect(t.calls).toHaveLength(2);
  });

  it('still requires the entire virtual-subject structure for the price+virtual+success successor', async () => {
    const t = target(REFUND_SUCCESS_NOTICE_SUCCESSORS[3], true);
    await expect(assertSupplierOrderPriceRevisionReady(t.tx)).rejects.toMatchObject({ httpStatus: 503 });
    expect(t.calls).toHaveLength(3);
  });
});
