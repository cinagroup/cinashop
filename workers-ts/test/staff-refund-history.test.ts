import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { AdminRefundReadService } from '../src/services/admin/AdminRefundReadService';
import { SupplierAfterSaleService } from '../src/services/supplier/SupplierAfterSaleService';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundSplit } from '../src/models/schema';
import * as history from '../src/services/order/RefundReadSnapshot';
import { parseRefundHistory } from '../../view/common/refundHistory';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('staff refund history over real physical generations', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 45_000);

  it.each(['admin', 'supplier'])('%s reads archived items after successive refunds, without repointing the application', async audience => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      const remainder = (await r.receipt(first.refundId)).remainingOrderId!;
      const second = await r.apply(remainder); await r.finish(second.refundId);
      const third = await r.apply(remainder, 71); await r.finish(third.refundId);
      await f.db.update(storeOrderCartInfo).set({ cartInfo: sql`jsonb_set(${storeOrderCartInfo.cartInfo}::jsonb,
        '{product,storeName}', '"Later mutable product"'::jsonb)::text` }).where(eq(storeOrderCartInfo.oid, source.id));
      const before = await f.state();
      for (const id of [first.refundId, second.refundId, third.refundId]) {
        const receipt = await r.receipt(id);
        const detail = audience === 'admin' ? await new AdminRefundReadService(r.container, f.env).detail(id)
          : await new SupplierAfterSaleService(r.container, f.env).detail(7, id);
        expect(detail).toMatchObject({ refundHistory: { version: 1, refundId: id, sourceOrderId: receipt.sourceOrderId,
          physicalOrderId: receipt.selectedOrderId, itemsError: '', items: [{ quantity: 1,
            name: id === third.refundId ? 'Local runtime remainder' : '完整报价隔离样本' }] } });
        expect(detail).toMatchObject(audience === 'admin' ? { storeOrderId: receipt.sourceOrderId } : { store_order_id: receipt.sourceOrderId });
        expect(parseRefundHistory(detail.refundHistory, { id, sourceOrderId: receipt.sourceOrderId,
          refundType: 6, refundNum: 1, isCancel: 0 })).toEqual(detail.refundHistory);
        expect(JSON.stringify(detail.refundHistory)).not.toMatch(/tradeNo|supplierLedger|sourceSnapshot|LOCAL-ONLY/);
      }
      expect(await f.state()).toEqual(before);
    });
  });

  it.each(['missing', 'fingerprint', 'malformed-cart', 'partition'])('both staff readers show a bounded error for %s evidence without live-cart fallback', async fault => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), application = await r.apply(source.id); await r.finish(application.refundId);
      await f.exec('ALTER TABLE store_order_refund_split DISABLE TRIGGER USER');
      try {
        if (fault === 'missing') await f.db.delete(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, application.refundId));
        else await f.db.update(storeOrderRefundSplit).set(fault === 'fingerprint' ? { fingerprint: '0'.repeat(64) }
          : fault === 'partition' ? { partitions: '[]' } : { sourceSnapshot: sql`jsonb_set(${storeOrderRefundSplit.sourceSnapshot}::jsonb,
            '{carts,0,cartInfo}','"not-json"'::jsonb)::text` }).where(eq(storeOrderRefundSplit.refundId, application.refundId));
      } finally { await f.exec('ALTER TABLE store_order_refund_split ENABLE TRIGGER USER'); }
      const before = await f.state();
      const views = [await new AdminRefundReadService(r.container, f.env).detail(application.refundId),
        await new SupplierAfterSaleService(r.container, f.env).detail(7, application.refundId)];
      for (const view of views) expect(view.refundHistory).toEqual({ version: 1, refundId: application.refundId,
        sourceOrderId: source.id, physicalOrderId: null, items: [], itemsError: '退款历史商品证据不一致，请核对后重试' });
      expect(await f.state()).toEqual(before);
    });
  });

  it.each(['foreign-supplier', 'owner', 'store', 'refund-deleted', 'order-deleted', 'system-deleted'])
  ('authorizes %s visibility before exposing any archived item', async fault => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), application = await r.apply(source.id); await r.finish(application.refundId);
      if (fault === 'owner') await f.db.update(storeOrderRefund).set({ uid: 22 }).where(eq(storeOrderRefund.id, application.refundId));
      if (fault === 'store') await f.db.update(storeOrderRefund).set({ storeId: 99 }).where(eq(storeOrderRefund.id, application.refundId));
      if (fault === 'refund-deleted') await f.db.update(storeOrderRefund).set({ isDel: 1 }).where(eq(storeOrderRefund.id, application.refundId));
      if (fault === 'order-deleted' || fault === 'system-deleted') await f.db.update(storeOrder).set(fault === 'order-deleted'
        ? { isDel: 1 } : { isSystemDel: 1 }).where(eq(storeOrder.id, source.id));
      const before = await f.state(), spy = vi.spyOn(history, 'readStaffRefundHistory');
      const supplier = new SupplierAfterSaleService(r.container, f.env), tenant = fault === 'foreign-supplier' ? 8 : 7;
      await expect(supplier.detail(tenant, application.refundId)).rejects.toMatchObject({ message: '售后记录不存在或不属于当前供应商' });
      expect((await supplier.list(tenant, {})).list).toEqual([]);
      if (fault !== 'foreign-supplier') {
        const admin = new AdminRefundReadService(r.container, f.env);
        await expect(admin.detail(application.refundId)).rejects.toMatchObject({ message: '退款记录不存在或关联订单不可读取' });
        expect((await admin.list({})).list).toEqual([]);
      }
      expect(spy).not.toHaveBeenCalled(); expect(await f.state()).toEqual(before);
    });
  });

  it('keeps legacy/pending reads independent of the candidate table and never masks missing archive permissions', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), application = await r.apply(source.id);
      const admin = new AdminRefundReadService(r.container, f.env), supplier = new SupplierAfterSaleService(r.container, f.env);
      const reads = [() => admin.detail(application.refundId), () => supplier.detail(7, application.refundId)];
      await f.exec('ALTER TABLE store_order_refund_split RENAME TO unavailable_staff_history');
      try { for (const read of reads) expect((await read()).refundHistory).toBeNull(); }
      finally { await f.exec('ALTER TABLE unavailable_staff_history RENAME TO store_order_refund_split'); }
      await r.finish(application.refundId);
      await f.exec(`REVOKE SELECT ON store_order_refund_split FROM "${r.role}"`);
      const before = await f.state();
      for (const read of reads) await expect(read()).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await f.state()).toEqual(before);
      await f.db.update(storeOrderRefund).set({ cartInfo: '{"cartIds":[1]}' }).where(eq(storeOrderRefund.id, application.refundId));
      for (const read of reads) expect((await read()).refundHistory).toBeNull();
    });
  });

  it.each(['admin', 'supplier'])('%s preserves a consistent read-only snapshot across an independent refund completion', async audience => {
    await f.withRuntime(async writer => {
      const source = await writer.createPaid(), application = await writer.apply(source.id);
      await f.withRuntime(async reader => {
        expect(reader.pid).not.toBe(writer.pid); await reader.exec("SET statement_timeout='3s'");
        const read = () => audience === 'admin' ? new AdminRefundReadService(reader.container, f.env).detail(application.refundId)
          : new SupplierAfterSaleService(reader.container, f.env).detail(7, application.refundId);
        const actual = history.readStaffRefundHistory;
        const spy = vi.spyOn(history, 'readStaffRefundHistory').mockImplementationOnce(async (tx, refund) => {
          const [state] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout`);
          expect(state).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '3s' });
          expect(await writer.finish(application.refundId)).toBe('completed');
          return actual(tx, refund);
        });
        const during = await read(); expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
        expect(during.refundHistory).toBeNull();
        expect(during).toMatchObject(audience === 'admin' ? { refundType: 0 } : { refund_type: 0 });
        const before = await f.state(), after = await read();
        expect(after.refundHistory?.itemsError).toBe(''); expect(after.refundHistory?.items).toHaveLength(1);
        expect(await f.state()).toEqual(before);
        const [outside] = await reader.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
          current_setting('statement_timeout') AS timeout`);
        expect(outside).toEqual({ readonly: 'off', timeout: '3s' });
      });
    });
  }, 45_000);
});
