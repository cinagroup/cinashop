import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { LegacyOrderCompatibilityService } from '../src/services/order/LegacyOrderCompatibilityService';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import type { Sql } from 'postgres';
import { storeOrder, storeOrderRefund } from '../src/models/schema';

// Scheduling barrier only: execute the real SELECT, then let a separately
// authenticated writer commit before the following cart/count/detail queries.
function afterOrderHeaderRead(callback: (client: Sql) => Promise<void>) {
  let reached = false;
  const actual = PostgresJsSession.prototype.prepareQuery;
  const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
    const prepared = actual.apply(this, args);
    if (/^select .* from "store_order" where /s.test(args[0].sql) && !args[0].sql.includes('COUNT(')) {
      const execute = prepared.execute.bind(prepared);
      prepared.execute = async values => {
        const rows = await execute(values);
        if (!reached) { reached = true; await callback(this.client); }
        return rows;
      };
    }
    return prepared;
  });
  return { restore: () => { spy.mockRestore(); expect(reached).toBe(true); } };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('customer order views across real refund generations', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 45_000);

  async function allowDetail(role: string) {
    if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Not an isolated runtime role');
    // Extra SELECTs are scenario-local, not broader production grants.
    await f.exec(`GRANT SELECT ON store_order_economize, store_order_promotions, store_promotions, store_order_writeoff TO "${role}"`);
  }

  it('PHP PC pid=0 semantics include current child orders, not the retired payment root', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), application = await r.apply(source.id); await r.finish(application.refundId);
      const receipt = await r.receipt(application.refundId), before = await f.state();
      const service = new StoreOrderCreateService(r.container, f.env);
      const result = await service.listLegacyPc(11, { limit: 100 });
      expect(result.list.map(order => order.id).sort((a, b) => a - b)).toEqual([receipt.selectedOrderId, receipt.remainingOrderId!].sort((a, b) => a - b));
      expect(result.count).toBe(2);
      expect((await service.listLegacyPc(11, { status: 1 })).list.map(order => order.id)).toEqual([receipt.remainingOrderId]);
      expect(await f.state()).toEqual(before);
    });
  });

  it('order counters keep current generations and conserved paid value after an actual partial refund', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), application = await r.apply(source.id); await r.finish(application.refundId);
      const before = await f.state();
      expect(await new LegacyOrderCompatibilityService(r.container, f.env).orderData(11)).toMatchObject({
        order_count: '2', sum_price: source.payPrice, unpaid_count: '0', unshipped_count: '1',
        received_count: '0', evaluated_count: '0', complete_count: '0', refunded_count: '1', refund_count: '1',
      });
      expect(await f.state()).toEqual(before);
    });
  });

  it('reads all three completed generations without stale carts or duplicate paid value', async () => {
    await f.withRuntime(async r => {
      await allowDetail(r.role);
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      const firstReceipt = await r.receipt(first.refundId), remainder = firstReceipt.remainingOrderId!;
      const second = await r.apply(remainder); await r.finish(second.refundId);
      const secondReceipt = await r.receipt(second.refundId);
      const third = await r.apply(remainder, 71); await r.finish(third.refundId);
      const before = await f.state(), service = new StoreOrderCreateService(r.container, f.env);
      const ids = [firstReceipt.selectedOrderId, secondReceipt.selectedOrderId, remainder].sort((a, b) => a - b);
      for (const orders of [await service.list(11, { limit: 100 }), (await service.listLegacyPc(11, { limit: 100 })).list]) {
        expect(orders.map(row => row.id).sort((a, b) => a - b)).toEqual(ids);
        expect(orders.every(row => row.refundStatus === 2 && row.cartInfo.length === 1)).toBe(true);
        expect(orders.reduce((total, row) => total + Math.round(Number(row.payPrice) * 100), 0)).toBe(5500);
        expect(orders.flatMap(row => row.cartInfo).reduce((n, line) => n + Number(line.cartNum), 0)).toBe(3);
      }
      const root = await service.detail(11, source.orderId);
      expect(root.pid).toBe(-1);
      expect(root.splitOrders.map(row => row.id)).toEqual(ids);
      expect(root.splitOrders.every(row => row.cartInfo.length === 1)).toBe(true);
      const current = await service.detail(11, (await r.order(remainder)).orderId);
      expect(current.cartInfo.map(line => line.productId)).toEqual([71]);
      expect(current.splitOrders).toEqual([]);
      expect(await new LegacyOrderCompatibilityService(r.container, f.env).orderData(11)).toMatchObject({
        order_count: '3', sum_price: '55.00', unshipped_count: '0', refunded_count: '3', refund_count: '3',
      });
      for (const status of [-2, -3]) expect((await service.listLegacyPc(11, { status })).list.map(row => row.id).sort((a, b) => a - b)).toEqual(ids);
      const firstPage = await service.listLegacyPc(11, { page: 1, limit: 2 });
      const secondPage = await service.listLegacyPc(11, { page: 2, limit: 2 });
      expect(firstPage.count).toBe(3); expect(secondPage.count).toBe(3);
      expect(new Set([...firstPage.list, ...secondPage.list].map(row => row.id)).size).toBe(3);
      expect(await f.state()).toEqual(before);
    });
  });

  it('owner/deletion filters also protect split detail and refund counters retain legitimate hidden-order history', async () => {
    await f.withRuntime(async r => {
      await allowDetail(r.role);
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), service = new StoreOrderCreateService(r.container, f.env);
      await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, receipt.selectedOrderId));
      expect((await service.detail(11, source.orderId)).splitOrders.map(row => row.id)).toEqual([receipt.remainingOrderId]);
      await expect(service.detail(11, (await r.order(receipt.selectedOrderId)).orderId)).rejects.toMatchObject({ message: '订单不存在' });
      await f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, receipt.remainingOrderId!));
      expect((await service.detail(11, source.orderId)).splitOrders).toEqual([]);
      expect((await service.listLegacyPc(11, {})).count).toBe(0);
      expect(await service.list(22, {})).toEqual([]);
      await expect(service.detail(22, source.orderId)).rejects.toMatchObject({ message: '订单不存在' });
      const stats = new LegacyOrderCompatibilityService(r.container, f.env);
      await f.db.update(storeOrder).set({ isDel: 1, isSystemDel: 1 }).where(eq(storeOrder.id, source.id));
      expect(await stats.orderData(11)).toMatchObject({ order_count: '0', sum_price: '0', refund_count: '1' });
      const [refund] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, first.refundId));
      await f.db.insert(storeOrderRefund).values([
        { ...refund, id: undefined, orderId: 'local-orphan', storeOrderId: 999999 },
        { ...refund, id: undefined, orderId: 'local-wrong-owner', uid: 22 },
        { ...refund, id: undefined, orderId: 'local-cancelled', isCancel: 1 },
        { ...refund, id: undefined, orderId: 'local-deleted', isDel: 1 },
      ]);
      const before = await f.state();
      expect(await stats.orderData(11)).toMatchObject({ refund_count: '1' });
      expect(await stats.orderData(22)).toMatchObject({ order_count: '0', refund_count: '0' });
      expect(await f.state()).toEqual(before);
    });
  });

  it('status counters match current child-list filters, including pickup and partial fulfillment', async () => {
    await f.withRuntime(async r => {
      const cases = [
        { paid: 0, status: 0 }, { status: 0 }, { status: 4 }, { status: 1 }, { status: 5 },
        { status: 0, shippingType: 2 }, { status: 5, shippingType: 2 }, { status: 2 },
        { status: 3 }, { status: 1, shippingType: 2 }, { status: 0, refundStatus: 3 },
        { status: 0, refundStatus: 2 }, { status: 0, isDel: 1 }, { status: 0, isSystemDel: 1 },
        { status: 0, uid: 22 }, { status: 0, pid: -1, shippingType: 2 },
      ];
      await f.db.insert(storeOrder).values(cases.map((values, i) => ({
        orderId: `local-status-${i}`, unique: `local-status-${i}`, uid: 11, pid: 900, paid: 1, shippingType: 1, payPrice: '10.00', ...values,
      })));
      const before = await f.state(), service = new StoreOrderCreateService(r.container, f.env);
      const counts = await new LegacyOrderCompatibilityService(r.container, f.env).orderData(11);
      expect(counts).toMatchObject({ order_count: '12', sum_price: '110.00', unpaid_count: '1', unshipped_count: '3',
        received_count: '4', evaluated_count: '1', complete_count: '1', unwritoff_count: '3' });
      for (const [status, count] of [[0, 1], [1, 3], [2, 4], [3, 1], [4, 1], [5, 3]]) {
        expect(await service.list(11, { status, limit: 100 })).toHaveLength(count);
        expect((await service.listLegacyPc(11, { status, limit: 100 })).count).toBe(count);
      }
      expect(await f.state()).toEqual(before);
    });
  });

  it('caps default read timeout, restores it and propagates database permissions failures without empty-success fallbacks', async () => {
    await f.withRuntime(async r => {
      await allowDetail(r.role);
      const source = await r.createPaid(), service = new StoreOrderCreateService(r.container, f.env);
      const before = await f.state();
      const barrier = afterOrderHeaderRead(async client => {
        const [settings] = await client.unsafe(`SELECT current_setting('transaction_read_only') AS readonly,
          current_setting('statement_timeout') AS timeout`);
        expect(settings).toEqual({ readonly: 'on', timeout: '5s' });
      });
      try { expect((await service.listLegacyPc(11, {})).count).toBe(1); } finally { barrier.restore(); }
      await f.exec(`REVOKE SELECT ON store_order_cart_info FROM "${r.role}"`);
      try {
        for (const read of [() => service.list(11, {}), () => service.listLegacyPc(11, {}), () => service.detail(11, source.orderId)]) {
          await expect(read()).rejects.toMatchObject({ cause: { code: '42501' } });
          const [settings] = await r.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
            current_setting('statement_timeout') AS timeout`);
          expect(settings).toEqual({ readonly: 'off', timeout: '30s' });
        }
      } finally { await f.exec(`GRANT SELECT ON store_order_cart_info TO "${r.role}"`); }
      await f.exec(`REVOKE SELECT ON store_order_refund FROM "${r.role}"`);
      try { await expect(new LegacyOrderCompatibilityService(r.container, f.env).orderData(11)).rejects.toMatchObject({ cause: { code: '42501' } }); }
      finally { await f.exec(`GRANT SELECT ON store_order_refund TO "${r.role}"`); }
      expect(await f.state()).toEqual(before);
    });
  });

  for (const generation of ['first', 'later'] as const) it.each(['modern', 'pc', 'detail'] as const)(
    `%s reads stay on one read-only snapshot across a real ${generation} split`, async mode => {
      await f.withRuntime(async writer => {
        const root = await writer.createPaid();
        let currentId = root.id;
        if (generation === 'later') {
          const first = await writer.apply(currentId); await writer.finish(first.refundId);
          currentId = (await writer.receipt(first.refundId)).remainingOrderId!;
        }
        const application = await writer.apply(currentId), current = await writer.order(currentId);
        await f.withRuntime(async reader => {
          expect(reader.pid).not.toBe(writer.pid); await allowDetail(reader.role);
          await reader.exec("SET statement_timeout='3s'");
          const service = new StoreOrderCreateService(reader.container, f.env);
          const read = async () => mode === 'detail' ? { list: [await service.detail(11, current.orderId)], count: null }
            : mode === 'pc' ? service.listLegacyPc(11, { limit: 100 }) : { list: await service.list(11, { limit: 100 }), count: null };
          const before = await read();
          let completedState: Awaited<ReturnType<typeof f.state>> | undefined;
          const barrier = afterOrderHeaderRead(async client => {
            const [settings] = await client.unsafe(`SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout`);
            expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '3s' });
            expect(await writer.finish(application.refundId)).toBe('completed');
            completedState = await f.state();
          });
          try { expect(await read()).toEqual(before); } finally { barrier.restore(); }
          expect(await read()).not.toEqual(before);
          expect(await f.state()).toEqual(completedState);
          const [settings] = await reader.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
            current_setting('statement_timeout') AS timeout`);
          expect(settings).toEqual({ readonly: 'off', timeout: '3s' });
        });
      });
    }, 45_000,
  );
});
