/** Real mixed-owner checkout and cancellation under independent restricted LOGINs.
 * Native owned PostgreSQL16 only. No provider, production, or external Queue I/O. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { ScheduledMaintenanceService } from '@/services/order/ScheduledMaintenanceService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '@/services/supplier/SupplierFinanceService';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { withTx } from '@/lib/di';
import { storeCart, storeOrder, storeOrderCartInfo, storeOrderStatus, storeProduct, user, userBill } from '@/models/schema';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = Parameters<Parameters<Fixture['withRuntime']>[0]>[0];
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('unpaid mixed-owner cancellation on PostgreSQL16', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    if (!f.withPeer) throw Error('Independent native lock-holder connection required');
    // One supplier product and one platform product: allocation happens only after payment.
    await f.db.update(storeProduct).set({ type: 1, relationId: 0 }).where(eq(storeProduct.id, 71));
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 45_000);
  async function checkout(r: Runtime) {
    const created = await r.checkout();
    const [order] = await r.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(order).toMatchObject({ pid: 0, paid: 0, status: 0, supplierId: 0, supplierAllocationStatus: 1, useIntegral: '100.00' });
    expect(await r.carts(order.id)).toHaveLength(2);
    return order;
  }
  it.each(['cancel', 'delete', 'scheduled'] as const)('restores the unsplit mixed order once through %s', async action => {
    await f.withRuntime(async r => {
      const before = await f.state(), order = await checkout(r);
      const service = new StoreOrderCreateService(r.container, f.env);
      const perform = async () => {
        if (action === 'scheduled') return new ScheduledMaintenanceService(r.container, f.env).processOrder({
          action: 'processScheduledOrder', job: 'unpaid_order_cancel', runId: 'local-mixed-cancel',
          scheduledAt: (order.addTime + 7200) * 1000, threshold: order.addTime + 3600, orderId: order.id,
        });
        return action === 'delete' ? service.del(11, order.orderId) : service.cancel(11, order.orderId);
      };
      const result = await perform();
      if (action === 'scheduled') expect(result).toMatchObject({ event: 'scheduled_order_processed', completed: true });
      const after = await f.state();
      for (const table of ['store_product', 'store_product_attr_value', 'user', 'store_cart']) expect(after[table], table).toEqual(before[table]);
      for (const table of ['supplier_flowing_water', 'supplier_transactions', 'store_order_refund', 'store_order_refund_split', 'store_order_fulfillment_branch', 'store_order_outbox'])
        expect(after[table], table).toEqual(before[table]);
      expect(await r.db.select().from(storeOrder)).toHaveLength(1);
      expect(await r.order(order.id)).toMatchObject({ pid: 0, paid: 0, status: -2, isDel: 1, supplierAllocationStatus: 1 });
      expect((await r.db.select().from(userBill)).map(row => ({ event: row.eventKey, number: row.number, pm: row.pm }))).toEqual([
        { event: 'order_integral_deduction', number: '100.00', pm: 0 },
        { event: 'order_cancel_integral_back', number: '100.00', pm: 1 },
      ]);
      const statuses = await r.db.select().from(storeOrderStatus);
      expect(statuses.filter(row => row.changeType === 'cancel')).toHaveLength(1);
      expect(statuses.filter(row => row.changeType === 'remove_order')).toHaveLength(action === 'delete' ? 1 : 0);
      if (action === 'scheduled') expect(await perform()).toMatchObject({ event: 'scheduled_order_skipped' });
      else await expect(perform()).rejects.toThrow();
      expect(await f.state()).toEqual(after);
    });
  }, 45_000);
  it.each([{ pid: -1 }, { pid: 999 }, { supplierAllocationStatus: 2 }, { paid: 1 }, { isSystemDel: 1 }])(
    'does not cancel invalid or already transitioned ancestry: %j', async patch => {
      await f.withRuntime(async r => {
        const order = await checkout(r);
        await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, order.id));
        const before = await f.state(), service = new StoreOrderCreateService(r.container, f.env);
        await expect(service.cancel(11, order.orderId)).rejects.toThrow();
        await expect(service.del(11, order.orderId)).rejects.toThrow();
        expect(await f.state()).toEqual(before);
      });
    }, 45_000);
  it('rejects a root with an existing child even if its unsplit flags are stale', async () => {
    await f.withRuntime(async r => {
      const root = await checkout(r);
      await f.db.insert(storeOrder).values({ ...root, id: undefined, orderId: 'local-stale-child', unique: 'local-stale-child', pid: root.id });
      const before = await f.state();
      await expect(new StoreOrderCreateService(r.container, f.env).cancel(11, root.orderId)).rejects.toThrow('已存在履约子单');
      expect(await f.state()).toEqual(before);
    });
  }, 45_000);
  it.each(['quantity', 'owner', 'cart-identity', 'snapshot-product'] as const)(
    'refuses inconsistent cancellation line evidence without restoring resources: %s', async damage => {
      await f.withRuntime(async r => {
        const root = await checkout(r), [line] = await r.carts(root.id);
        const snapshot = JSON.parse(line.cartInfo!);
        if (damage === 'snapshot-product') snapshot.product.id = 71;
        await f.db.update(storeOrderCartInfo).set(damage === 'quantity' ? { cartNum: line.cartNum + 1 }
          : damage === 'owner' ? { uid: 22 } : damage === 'cart-identity' ? { cartId: '999' }
          : { cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, line.id));
        const before = await f.state(), service = new StoreOrderCreateService(r.container, f.env);
        await expect(service.cancel(11, root.orderId)).rejects.toThrow(/取消.*(数量|归属|凭据)/);
        expect(await f.state()).toEqual(before);
      });
    }, 45_000);
  it.each(['points', 'order-cart-identity', 'oversized-snapshot'] as const)(
    'rejects inconsistent or unbounded original cancellation evidence: %s', async damage => {
      await f.withRuntime(async r => {
        const root = await checkout(r), [line] = await r.carts(root.id);
        if (damage === 'order-cart-identity') {
          await f.db.update(storeOrder).set({ cartId: '1,999' }).where(eq(storeOrder.id, root.id));
        } else {
          const snapshot = JSON.parse(line.cartInfo!);
          if (damage === 'points') snapshot.use_integral = String(Number(snapshot.use_integral) + 1);
          else snapshot.note = '图'.repeat(22000);
          await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(snapshot) })
            .where(eq(storeOrderCartInfo.id, line.id));
        }
        const before = await f.state();
        await expect(new StoreOrderCreateService(r.container, f.env).cancel(11, root.orderId))
          .rejects.toThrow(/取消.*(数量|归属|凭据)/);
        expect(await f.state()).toEqual(before);
      });
    }, 45_000);
  it('locks original lines and revalidates committed quantities after a real row-lock wait', async () => {
    await f.withRuntime(async r => {
      const root = await checkout(r), [line] = await r.carts(root.id), before = await f.state();
      await f.withPeer!(async holder => {
        const { cancelling } = await holder.db.transaction(async tx => {
          await tx.execute(sql`SELECT id FROM store_order_cart_info WHERE id=${line.id} FOR UPDATE`);
          const cancelling = outcome(new StoreOrderCreateService(r.container, f.env).cancel(11, root.orderId));
          await waitForFinanceBlock(f.db, r.pid, holder.pid);
          await tx.update(storeOrderCartInfo).set({ cartNum: line.cartNum + 1 }).where(eq(storeOrderCartInfo.id, line.id));
          return { cancelling };
        });
        const result = await cancelling;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toMatch(/取消.*(数量|归属|凭据)/);
        // Removing only the injected corruption restores the full before-state:
        // cancellation did not compensate any stock, cart, points, or log.
        expect((await r.carts(root.id)).find(row => row.id === line.id)?.cartNum).toBe(line.cartNum + 1);
        await f.db.update(storeOrderCartInfo).set({ cartNum: line.cartNum }).where(eq(storeOrderCartInfo.id, line.id));
        expect(await f.state()).toEqual(before);
        await new StoreOrderCreateService(r.container, f.env).cancel(11, root.orderId);
        expect((await r.order(root.id))?.status).toBe(-2);
      });
    });
  }, 45_000);
  it.each(['user_bill', 'store_order_status'] as const)('rolls back all mixed-order compensation without INSERT on %s, then retries', async table => {
    await f.withRuntime(async r => {
      const root = await checkout(r), before = await f.state(), service = new StoreOrderCreateService(r.container, f.env);
      await f.exec(`REVOKE INSERT ON public.${table} FROM "${r.role}"`);
      try {
        await expect(service.del(11, root.orderId)).rejects.toMatchObject({ cause: { code: '42501' } });
        expect(await f.state()).toEqual(before);
      } finally { await f.exec(`GRANT INSERT ON public.${table} TO "${r.role}"`); }
      await service.del(11, root.orderId);
      const done = await f.state(); await expect(service.cancel(11, root.orderId)).rejects.toThrow();
      expect(await f.state()).toEqual(done);
    });
  }, 45_000);
  it('rechecks the actual payment allocation after waiting and never releases paid parent or child quantities', async () => {
    await f.withRuntime(async payer => {
      const root = await checkout(payer);
      await f.withRuntime(async canceller => {
        const { cancellation, children } = await withTx(payer.container, async tx => {
          // Synthetic payment marker; allocation and supplier accounting are the real services.
          await tx.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'LOCAL-SYNTHETIC' })
            .where(eq(storeOrder.id, root.id));
          const allocation = await allocatePaidOrderBySupplier(tx, root.id, root.orderId, 100);
          expect(allocation.fulfillmentOrders).toHaveLength(2);
          for (const child of allocation.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
          const cancellation = outcome(new StoreOrderCreateService(canceller.container, f.env).cancel(11, root.orderId));
          await waitForFinanceBlock(f.db, canceller.pid, payer.pid);
          return { cancellation, children: allocation.fulfillmentOrders };
        });
        const result = await cancellation; expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toMatch(/拆分审计订单不能取消/);
        const before = await f.state(), service = new StoreOrderCreateService(canceller.container, f.env);
        for (const order of [root, ...children]) {
          await expect(service.cancel(11, order.orderId)).rejects.toThrow();
          await expect(service.del(11, order.orderId)).rejects.toThrow();
        }
        expect((await f.db.select().from(userBill)).filter(bill => bill.eventKey === 'order_cancel_integral_back')).toEqual([]);
        expect(await f.state()).toEqual(before);
      });
    });
  }, 45_000);
  it('serializes two independent cancellation calls and compensates only once', async () => {
    await f.withRuntime(async first => {
      const root = await checkout(first);
      await f.withRuntime(async second => {
        await f.withPeer!(async holder => {
          const { cancelling, competing } = await holder.db.transaction(async tx => {
            await tx.execute(sql`SELECT id FROM store_order WHERE id=${root.id} FOR UPDATE`);
            const cancelling = outcome(new StoreOrderCreateService(first.container, f.env).cancel(11, root.orderId));
            await waitForFinanceBlock(f.db, first.pid, holder.pid);
            const competing = outcome(new StoreOrderCreateService(second.container, f.env).del(11, root.orderId));
            await waitForFinanceBlock(f.db, second.pid, first.pid);
            return { cancelling, competing };
          });
          expect((await cancelling).ok).toBe(true); expect((await competing).ok).toBe(false);
          expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(100);
          expect((await f.db.select().from(userBill)).filter(bill => bill.eventKey === 'order_cancel_integral_back')).toHaveLength(1);
          expect((await f.db.select().from(storeOrderStatus)).filter(row => row.changeType === 'cancel')).toHaveLength(1);
        });
      });
    });
  }, 45_000);
  it('does not reverse user/SKU locks against a new ordinary points checkout', async () => {
    await f.withRuntime(async buyer => {
      const root = await checkout(buyer);
      const carts = await f.db.select().from(storeCart).orderBy(storeCart.id);
      await f.db.insert(storeCart).values(carts.map(row => ({ ...row, id: row.id + 2, isPay: 0 })));
      await f.withRuntime(async canceller => {
        await f.withPeer!(async holder => {
          const { buying } = await holder.db.transaction(async tx => {
            await tx.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
            const buying = outcome(StoreOrderCreateService.createWithRuntime(buyer.container,
              { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'local-mixed-next' },
              { uid: 11, key: 'local-mixed-next', cartIds: [3, 4], addressId: 11, useIntegral: true, userIp: '127.0.0.1' }));
            await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
            const before = await f.state();
            await expect(new StoreOrderCreateService(canceller.container, f.env).cancel(11, root.orderId)).rejects.toThrow('积分余额正在更新');
            expect(await f.state()).toEqual(before);
            return { buying };
          });
          expect((await buying).ok).toBe(true);
          await new StoreOrderCreateService(canceller.container, f.env).cancel(11, root.orderId);
          expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(100);
          expect((await f.db.select().from(storeProduct).orderBy(storeProduct.id)).map(row => row.stock)).toEqual([6, 7]);
        });
      });
    });
  }, 45_000);
});
