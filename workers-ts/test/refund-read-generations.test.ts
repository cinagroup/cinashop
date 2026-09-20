import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { refundRuntimeFixture, shipping } from './helpers/refundRuntimeFixture';
import { CustomerRefundReadService } from '../src/services/order/CustomerRefundReadService';
import * as history from '../src/services/order/RefundReadSnapshot';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { storeOrderCartInfo, storeOrderRefund, storeOrderRefundSplit } from '../src/models/schema';
import { parseRefundDetail } from '../../view/common/refundRecords';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('historical customer refund items across physical generations', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 45_000);
  const query = () => new URLSearchParams('view=customer');

  it('shows the second completed refund even after its original cart row was consumed by a retained-ID split', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      const remainder = (await r.receipt(first.refundId)).remainingOrderId!;
      const second = await r.apply(remainder); await r.finish(second.refundId);
      const third = await r.apply(remainder, 71); await r.finish(third.refundId);
      const before = await f.state(), reader = new CustomerRefundReadService(r.container);
      const detail = await reader.detail(11, String(second.refundId), query());
      expect(detail.itemsError).toBe('');
      expect(detail.items).toHaveLength(1);
      expect(detail.items[0]).toMatchObject({ name: '完整报价隔离样本', sku: '红色,大号', quantity: 1 });
      expect(detail.storeOrderId).toBe(remainder);
      for (const id of [first.refundId, second.refundId, third.refundId]) {
        const receipt = await r.receipt(id), current = await reader.detail(11, String(id), query());
        expect(current).toMatchObject({ storeOrderId: receipt.sourceOrderId,
          physicalOrderId: receipt.selectedOrderId, itemsError: '', refundType: 6 });
        expect(parseRefundDetail(current, 11, id).items).toEqual(current.items);
      }
      expect(await f.state()).toEqual(before);
    });
  });

  it('does not replace an archived refund product with later mutable order-cart content', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      await f.db.update(storeOrderCartInfo).set({ cartInfo: sql`jsonb_set(${storeOrderCartInfo.cartInfo}::jsonb,
        '{product,storeName}', '"Later mutable product"'::jsonb)::text` }).where(eq(storeOrderCartInfo.oid, source.id));
      const before = await f.state(), detail = await new CustomerRefundReadService(r.container).detail(11, String(first.refundId), query());
      expect(detail.itemsError).toBe('');
      expect(detail.items[0]).toMatchObject({ name: '完整报价隔离样本', quantity: 1 });
      expect(await f.state()).toEqual(before);
    });
  });

  it('reads whole refunds of fulfillment branches while preserving original application links in the list', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      const remainder = (await r.receipt(first.refundId)).remainingOrderId!;
      const line = (await r.carts(remainder)).find(cart => cart.productId === 70)!;
      const fulfillment = new SupplierFulfillmentService(r.container, f.env);
      const fork = await fulfillment.splitDelivery(7, remainder, shipping, [{ cartId: line.cartId, cartNum: 1 }]);
      const second = await r.apply(fork.order_id); await r.finish(second.refundId);
      const third = await r.apply(fork.remaining_order_id!, 71); await r.finish(third.refundId);
      const before = await f.state(), reader = new CustomerRefundReadService(r.container);
      for (const id of [first.refundId, second.refundId, third.refundId]) {
        const receipt = await r.receipt(id), detail = await reader.detail(11, String(id), query());
        expect(detail).toMatchObject({ storeOrderId: receipt.sourceOrderId,
          physicalOrderId: receipt.selectedOrderId, itemsError: '' });
        expect(detail.items).toHaveLength(1);
        expect(detail.items[0].quantity).toBe(1);
      }
      const listed = await reader.list(11, new URLSearchParams('view=customer&filter=completed'));
      expect(listed.items.map(row => [row.id, row.storeOrderId])).toEqual([
        [third.refundId, fork.remaining_order_id], [second.refundId, fork.order_id], [first.refundId, source.id],
      ]);
      expect(await f.state()).toEqual(before);
    });
  });

  it.each(['missing receipt', 'fingerprint', 'foreign source', 'foreign cart', 'selected quantity',
    'shared target', 'unselected quantity', 'whole mapping', 'malformed cart', 'oversized public text'])
  ('does not substitute current carts when historical evidence is invalid: %s', async fault => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId);
      const archive: { source: { uid: number }; carts: Array<{ uid: number; cartInfo: string }> } = JSON.parse(receipt.sourceSnapshot);
      const parts: Array<{ sourceRowId: number; selectedRowId: number | null; remainingRowId: number | null;
        selectedNum: number; remainingNum: number }> = JSON.parse(receipt.partitions);
      const patch: Partial<typeof storeOrderRefundSplit.$inferInsert> = {};
      if (fault === 'fingerprint') patch.fingerprint = '0'.repeat(64);
      if (fault === 'foreign source') archive.source.uid = 22;
      if (fault === 'foreign cart') archive.carts[0].uid = 22;
      if (fault === 'selected quantity') parts[0].selectedNum++;
      if (fault === 'shared target') parts[0].remainingRowId = parts[0].selectedRowId;
      if (fault === 'unselected quantity') parts[1].remainingNum++;
      if (fault === 'whole mapping') Object.assign(patch, { disposition: 'whole', selectedOrderId: source.id, remainingOrderId: null });
      if (fault === 'malformed cart') archive.carts[0].cartInfo = 'not-json';
      if (fault === 'oversized public text') {
        const info = JSON.parse(archive.carts[0].cartInfo) as { product: { storeName: string } };
        info.product.storeName = '测'.repeat(1400); archive.carts[0].cartInfo = JSON.stringify(info);
      }
      Object.assign(patch, { sourceSnapshot: JSON.stringify(archive), partitions: JSON.stringify(parts) });
      // Only the synthetic maintenance owner can create these impossible-at-runtime faults.
      await f.exec('ALTER TABLE store_order_refund_split DISABLE TRIGGER USER');
      try {
        if (fault === 'missing receipt') await f.db.delete(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, first.refundId));
        else await f.db.update(storeOrderRefundSplit).set(patch).where(eq(storeOrderRefundSplit.refundId, first.refundId));
      } finally { await f.exec('ALTER TABLE store_order_refund_split ENABLE TRIGGER USER'); }
      const before = await f.state();
      const detail = await new CustomerRefundReadService(r.container).detail(11, String(first.refundId), query());
      expect(detail.itemsError).toBe('退款历史商品证据不一致，请联系商家核对');
      expect(detail.items).toEqual([]); expect(detail.physicalOrderId).toBeNull();
      expect(detail.refundType).toBe(6); expect(await f.state()).toEqual(before);
    });
  });

  it('returns only bounded public item fields, never private archive content', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      await f.exec('ALTER TABLE store_order_refund_split DISABLE TRIGGER USER');
      try {
        await f.db.update(storeOrderRefundSplit).set({ sourceSnapshot: sql`jsonb_set(${storeOrderRefundSplit.sourceSnapshot}::jsonb,
          '{privatePayload}',to_jsonb(repeat('PRIVATE-ARCHIVE',30000)))::text` }).where(eq(storeOrderRefundSplit.refundId, first.refundId));
      } finally { await f.exec('ALTER TABLE store_order_refund_split ENABLE TRIGGER USER'); }
      const before = await f.state(), detail = await new CustomerRefundReadService(r.container).detail(11, String(first.refundId), query());
      expect(detail.itemsError).toBe('');
      expect(Object.keys(detail.items[0]).sort()).toEqual(['cartId', 'id', 'image', 'name', 'quantity', 'sku']);
      const serialized = JSON.stringify(detail);
      for (const privateField of ['PRIVATE-ARCHIVE', 'LOCAL-ONLY', 'supplierLedger', 'sourceSnapshot', 'tradeNo', 'financial_version'])
        expect(serialized).not.toContain(privateField);
      expect(new TextEncoder().encode(serialized).length).toBeLessThan(8192);
      expect(await f.state()).toEqual(before);
    });
  });

  it('authorizes before reading the archive and hides foreign or deleted refunds', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      const spy = vi.spyOn(history, 'readMaterializedRefundSnapshot'), reader = new CustomerRefundReadService(r.container);
      await expect(reader.detail(22, String(first.refundId), query())).rejects.toMatchObject({ message: '退款记录不存在' });
      await f.db.update(storeOrderRefund).set({ isDel: 1 }).where(eq(storeOrderRefund.id, first.refundId));
      const before = await f.state();
      await expect(reader.detail(11, String(first.refundId), query())).rejects.toMatchObject({ message: '退款记录不存在' });
      expect(spy).not.toHaveBeenCalled(); expect(await f.state()).toEqual(before);
    });
  });

  it('requires the evidence SELECT grant for completed v2 reads but not pending or legacy reads', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id), reader = new CustomerRefundReadService(r.container);
      await f.exec(`REVOKE SELECT ON store_order_refund_split FROM "${r.role}"`);
      expect((await reader.detail(11, String(first.refundId), query())).itemsError).toBe('');
      await f.exec(`GRANT SELECT ON store_order_refund_split TO "${r.role}"`);
      await r.finish(first.refundId);
      await f.exec(`REVOKE SELECT ON store_order_refund_split FROM "${r.role}"`);
      const before = await f.state();
      await expect(reader.detail(11, String(first.refundId), query())).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await f.state()).toEqual(before);
      await f.db.update(storeOrderRefund).set({ cartInfo: JSON.stringify({ cartIds: [{ cartId: 1, cartNum: 1 }] }) })
        .where(eq(storeOrderRefund.id, first.refundId));
      const legacy = await reader.detail(11, String(first.refundId), query());
      expect(legacy.itemsError).toBe(''); expect(legacy.physicalOrderId).toBeNull();
    });
  });

  it('does not require a candidate relation for pending reads, but a completed v2 read fails if it is absent', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id), reader = new CustomerRefundReadService(r.container);
      await f.exec('ALTER TABLE store_order_refund_split RENAME TO unavailable_refund_split');
      try { expect((await reader.detail(11, String(first.refundId), query())).itemsError).toBe(''); }
      finally { await f.exec('ALTER TABLE unavailable_refund_split RENAME TO store_order_refund_split'); }
      await r.finish(first.refundId);
      await f.exec('ALTER TABLE store_order_refund_split RENAME TO unavailable_refund_split');
      try { await expect(reader.detail(11, String(first.refundId), query())).rejects.toMatchObject({ cause: { code: '42P01' } }); }
      finally { await f.exec('ALTER TABLE unavailable_refund_split RENAME TO store_order_refund_split'); }
    });
  });

  it('keeps one read-only snapshot when an independent LOGIN completes a refund between the detail queries', async () => {
    await f.withRuntime(async writer => {
      const source = await writer.createPaid(), first = await writer.apply(source.id); await writer.finish(first.refundId);
      const remainder = (await writer.receipt(first.refundId)).remainingOrderId!;
      const second = await writer.apply(remainder);
      await f.withRuntime(async reader => {
        expect(reader.pid).not.toBe(writer.pid);
        const service = new CustomerRefundReadService(reader.container), actual = history.readMaterializedRefundSnapshot;
        let completedState: Awaited<ReturnType<typeof f.state>> | undefined;
        const spy = vi.spyOn(history, 'readMaterializedRefundSnapshot').mockImplementationOnce(async (tx, refund) => {
          const [state] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout`);
          expect(state).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' });
          expect(await writer.finish(second.refundId)).toBe('completed');
          completedState = await f.state();
          return actual(tx, refund); // Scheduling barrier only; all service queries and effects remain real.
        });
        const during = await service.detail(11, String(second.refundId), query());
        expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
        expect(during.refundType).not.toBe(6); expect(during.itemsError).toBe('');
        expect(during.items[0]).toMatchObject({ name: '完整报价隔离样本', quantity: 1 });
        expect(during.physicalOrderId).toBeNull();
        const after = await service.detail(11, String(second.refundId), query());
        expect(after).toMatchObject({ refundType: 6, itemsError: '', physicalOrderId: (await writer.receipt(second.refundId)).selectedOrderId });
        expect(after.items).toEqual(during.items); expect(await f.state()).toEqual(completedState);
        const [outside] = await reader.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
          current_setting('statement_timeout') AS timeout`);
        expect(outside).toEqual({ readonly: 'off', timeout: '30s' });
        await reader.exec("SET statement_timeout='3s'");
        const strict = vi.spyOn(history, 'readMaterializedRefundSnapshot').mockImplementationOnce(async (tx, refund) => {
          const [setting] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS timeout`);
          expect(setting.timeout).toBe('3s');
          return actual(tx, refund);
        });
        expect((await service.detail(11, String(second.refundId), query())).itemsError).toBe('');
        expect(strict).toHaveBeenCalledTimes(1); strict.mockRestore();
      });
    });
  }, 45_000);
});
