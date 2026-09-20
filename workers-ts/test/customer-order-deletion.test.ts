import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { CustomerRefundReadService } from '../src/services/order/CustomerRefundReadService';
import { StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { storeOrder, storeOrderStatus, storeOrderRefund } from '../src/models/schema';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { orderDel } from '../src/controllers/api/v1/OrderController';
import type { AppVariables, Env } from '../src/env';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('customer deletion across order generations', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 45_000);

  it('allows the completed refunded child without compensating financial resources again', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), selected = await r.order(receipt.selectedOrderId);
      const before = await f.state();
      await expect(new StoreOrderCreateService(r.container, f.env).del(11, selected.orderId)).resolves.toBeUndefined();
      expect((await r.order(selected.id)).isDel).toBe(1);
      const after = await f.state();
      for (const table of Object.keys(before).filter(name => !['store_order', 'store_order_status'].includes(name))) expect(after[table], table).toEqual(before[table]);
      expect((await r.order(receipt.remainingOrderId!)).isDel).toBe(0);
    });
  });

  it.each([2, 4, 5])('rejects paid nonterminal status %s (review pending, partial shipping or partial writeoff)', async status => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(); await f.db.update(storeOrder).set({ status }).where(eq(storeOrder.id, source.id));
      const before = await f.state();
      await expect(new StoreOrderCreateService(r.container, f.env).del(11, source.orderId)).rejects.toThrow('订单状态不允许删除');
      expect(await f.state()).toEqual(before);
    });
  });

  it('deletes an unpaid order through atomic cancellation instead of leaving reserved stock/points', async () => {
    await f.withRuntime(async r => {
      const before = await f.state(), created = await r.checkout();
      await expect(new StoreOrderCreateService(r.container, f.env).del(11, created.orderId)).resolves.toBeUndefined();
      const after = await f.state();
      for (const table of ['store_product', 'store_product_attr_value', 'user']) expect(after[table], table).toEqual(before[table]);
      const rows = await f.db.select().from(storeOrder);
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: -2, isDel: 1, paid: 0 });
    });
  });

  it('rejects an actual pending refund even if the order summary flag is stale', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), application = await r.apply(source.id);
      await f.db.update(storeOrder).set({ status: 3, refundStatus: 0 }).where(eq(storeOrder.id, source.id));
      for (const refundType of [0, 1, 2, 4, 5]) {
        await f.db.update(storeOrderRefund).set({ refundType }).where(eq(storeOrderRefund.id, application.refundId));
        const before = await f.state();
        await expect(new StoreOrderCreateService(r.container, f.env).del(11, source.orderId)).rejects.toThrow('退款处理中');
        expect(await f.state()).toEqual(before);
      }
    });
  });

  it('deleting completed children leaves later refunds, immutable history and finalizer replays intact', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), service = new StoreOrderCreateService(r.container, f.env);
      const first = await r.apply(source.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), remainder = receipt.remainingOrderId!;
      await service.del(11, (await r.order(receipt.selectedOrderId)).orderId);
      const second = await r.apply(remainder); await r.finish(second.refundId);
      await service.del(11, (await r.order((await r.receipt(second.refundId)).selectedOrderId)).orderId);
      const third = await r.apply(remainder, 71); await r.finish(third.refundId);
      await service.del(11, (await r.order(remainder)).orderId);
      const before = await f.state();
      expect(await service.list(11, {})).toEqual([]);
      for (const application of [first, second, third]) {
        expect(await r.finish(application.refundId)).toBe('already-completed');
        expect(await new CustomerRefundReadService(r.container).detail(11, String(application.refundId), new URLSearchParams('view=customer')))
          .toMatchObject({ refundType: 6, itemsError: '' });
      }
      expect(await f.state()).toEqual(before);
      await expect(service.del(11, (await r.order(remainder)).orderId)).rejects.toThrow('订单已删除');
      expect((await r.order(source.id)).isDel).toBe(0);
    });
  });

  it('rejects hidden/foreign orders, allocation in progress and payment audit roots without writes', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), service = new StoreOrderCreateService(r.container, f.env);
      for (const patch of [{ uid: 22 }, { isSystemDel: 1 }, { supplierAllocationStatus: 1 }, { pid: -1 }]) {
        await f.db.update(storeOrder).set({ status: 3, uid: 11, isSystemDel: 0, supplierAllocationStatus: 0, pid: 0, ...patch })
          .where(eq(storeOrder.id, source.id));
        const before = await f.state();
        await expect(service.del(11, source.orderId)).rejects.toThrow(); expect(await f.state()).toEqual(before);
      }
    });
  });

  it.each(['paid', 'unpaid'] as const)('rolls back all %s deletion effects on a late remove_order audit failure', async mode => {
    await f.withRuntime(async r => {
      const created = mode === 'paid' ? await r.createPaid() : await r.checkout();
      if (mode === 'paid') await f.db.update(storeOrder).set({ status: 3 }).where(eq(storeOrder.orderId, created.orderId));
      await f.exec(`CREATE FUNCTION reject_local_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.change_type='remove_order' THEN RAISE EXCEPTION 'local delete audit fault'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_local_delete_audit BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION reject_local_delete_audit()`);
      const before = await f.state();
      await expect(new StoreOrderCreateService(r.container, f.env).del(11, created.orderId)).rejects.toMatchObject({ cause: { code: 'P0001' } });
      expect(await f.state()).toEqual(before);
    });
  });

  it.each(['uid=22', 'status=1', 'is_system_del=1'])('rechecks %s after a real row-lock wait', async change => {
    await f.withRuntime(async blocker => {
      const source = await blocker.createPaid(); await f.db.update(storeOrder).set({ status: 3 }).where(eq(storeOrder.id, source.id));
      await f.withRuntime(async deleter => {
        await blocker.exec(`BEGIN; SELECT id FROM store_order WHERE id=${source.id} FOR UPDATE`);
        const pending = outcome(new StoreOrderCreateService(deleter.container, f.env).del(11, source.orderId));
        try {
          await waitForFinanceBlock(f.db, deleter.pid, blocker.pid);
          await blocker.exec(`UPDATE store_order SET ${change} WHERE id=${source.id}`);
        } finally { await blocker.exec('COMMIT'); }
        expect((await pending).ok).toBe(false); expect((await blocker.order(source.id)).isDel).toBe(0);
        expect(await f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.changeType, 'remove_order'))).toEqual([]);
      });
    });
  });

  it('locks the payment root before its child and rejects an ancestry change after waiting', async () => {
    await f.withRuntime(async blocker => {
      const source = await blocker.createPaid(), first = await blocker.apply(source.id); await blocker.finish(first.refundId);
      const selected = await blocker.order((await blocker.receipt(first.refundId)).selectedOrderId);
      await f.withRuntime(async deleter => {
        await blocker.exec(`BEGIN; SELECT id FROM store_order WHERE id=${source.id} FOR UPDATE`);
        const pending = outcome(new StoreOrderCreateService(deleter.container, f.env).del(11, selected.orderId));
        try {
          await waitForFinanceBlock(f.db, deleter.pid, blocker.pid);
          await blocker.exec(`SELECT id FROM store_order WHERE id=${selected.id} FOR UPDATE NOWAIT;
            UPDATE store_order SET pid=0 WHERE id=${selected.id}`);
        } finally { await blocker.exec('COMMIT'); }
        expect((await pending).ok).toBe(false); expect((await blocker.order(selected.id)).isDel).toBe(0);
      });
    });
  });

  it('serializes concurrent duplicate deletion into one visibility change and one audit record', async () => {
    await f.withRuntime(async first => {
      const source = await first.createPaid(); await f.db.update(storeOrder).set({ status: 3 }).where(eq(storeOrder.id, source.id));
      await f.withRuntime(async second => {
        const results = await Promise.all([first, second].map(peer => outcome(new StoreOrderCreateService(peer.container, f.env).del(11, source.orderId))));
        expect(results.filter(result => result.ok)).toHaveLength(1);
        expect(await f.db.select().from(storeOrderStatus).where(and(eq(storeOrderStatus.oid, source.id), eq(storeOrderStatus.changeType, 'remove_order')))).toHaveLength(1);
      });
    });
  });

  it('a winning deletion blocks a queued real refund application from creating a claim', async () => {
    await f.withRuntime(async blocker => {
      const source = await blocker.createPaid(); await f.db.update(storeOrder).set({ status: 3 }).where(eq(storeOrder.id, source.id));
      await f.withRuntime(async deleter => f.withRuntime(async applicant => {
        await blocker.exec(`BEGIN; SELECT pg_advisory_xact_lock(63842,${source.id})`);
        const deletion = outcome(new StoreOrderCreateService(deleter.container, f.env).del(11, source.orderId));
        let application: ReturnType<typeof outcome<{ refundId: number }>> | undefined;
        try {
          await waitForFinanceBlock(f.db, deleter.pid, blocker.pid);
          application = outcome(applicant.apply(source.id));
          await waitForFinanceBlock(f.db, applicant.pid, deleter.pid);
        } finally { await blocker.exec('COMMIT'); }
        expect((await deletion).ok).toBe(true); expect((await application!).ok).toBe(false);
        expect(await f.db.select().from(storeOrderRefund)).toEqual([]);
      }));
    });
  });

  it('does not reverse refund-first lock order while a real finalizer holds its refund row', async () => {
    await f.withRuntime(async writer => {
      const source = await writer.createPaid(), application = await writer.apply(source.id);
      // Keep the real unfulfilled status and supplier ledger consistent. Only
      // the stale summary flag is fault-injected; the actual claim stays open.
      await f.db.update(storeOrder).set({ refundStatus: 0 }).where(eq(storeOrder.id, source.id));
      await f.withRuntime(async deleter => {
        const actual = PostgresJsSession.prototype.prepareQuery; let reached = false;
        const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
          const prepared = actual.apply(this, args);
          if (/from "store_order_refund".*for update/s.test(args[0].sql)) {
            const execute = prepared.execute.bind(prepared);
            prepared.execute = async values => {
              const rows = await execute(values);
              if (!reached) {
                reached = true;
                await expect(new StoreOrderCreateService(deleter.container, f.env).del(11, source.orderId)).rejects.toThrow('退款处理中');
              }
              return rows;
            };
          }
          return prepared;
        });
        try { expect(await writer.finish(application.refundId)).toBe('completed'); }
        finally { spy.mockRestore(); }
        expect(reached).toBe(true); expect((await writer.order(source.id)).isDel).toBe(0);
      });
    });
  });

  it('does not release resources when an unpaid deletion loses its order lock to a paid transition', async () => {
    await f.withRuntime(async blocker => {
      const created = await blocker.checkout();
      const [source] = await f.db.select().from(storeOrder);
      await f.withRuntime(async deleter => {
        await blocker.exec(`BEGIN; SELECT id FROM store_order WHERE id=${source.id} FOR UPDATE`);
        const pending = outcome(new StoreOrderCreateService(deleter.container, f.env).del(11, created.orderId));
        try {
          await waitForFinanceBlock(f.db, deleter.pid, blocker.pid);
          // Synthetic committed payment state, not provider acceptance.
          await blocker.exec(`UPDATE store_order SET paid=1,pay_type='yue' WHERE id=${source.id}`);
        } finally { await blocker.exec('COMMIT'); }
        expect((await pending).ok).toBe(false);
        const before = await f.state();
        expect((await blocker.order(source.id)).isDel).toBe(0);
        await expect(new StoreOrderCreateService(deleter.container, f.env).del(11, created.orderId)).rejects.toThrow();
        expect(await f.state()).toEqual(before);
        expect(await f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.changeType, 'cancel'))).toEqual([]);
      });
    });
  });

  it('permits completed-order deletion after a real refund cancellation releases the pending claim', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(), application = await r.apply(source.id);
      await new StoreOrderRefundService(r.container, f.env).cancelApply(11, application.refundId);
      await f.db.update(storeOrder).set({ status: 3 }).where(eq(storeOrder.id, source.id));
      const before = await f.state();
      await new StoreOrderCreateService(r.container, f.env).del(11, source.orderId);
      const after = await f.state();
      for (const table of Object.keys(before).filter(name => !['store_order', 'store_order_status'].includes(name))) expect(after[table], table).toEqual(before[table]);
      expect((await r.order(source.id)).isDel).toBe(1);
    });
  });

  it('retains actual HTTP order_id/uni compatibility and refuses unauthenticated/invalid deletion', async () => {
    await f.withRuntime(async r => {
      const source = await r.createPaid(); await f.db.update(storeOrder).set({ status: 3 }).where(eq(storeOrder.id, source.id));
      await f.db.insert(storeOrder).values({ ...source, id: undefined, status: 3, orderId: 'local-delete-alias', unique: 'local-delete-alias' });
      const app = new Hono<{ Variables: AppVariables; Bindings: Env }>();
      app.use('*', async (c, next) => { c.set('container', r.container); c.set('uid', Number(c.req.header('x-test-user') ?? '0')); await next(); });
      app.post('/api/order/del', orderDel);
      const request = async (body: unknown, authenticated = true) => (await app.request('/api/order/del', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'x-test-user': '11' } : {}) }, body: JSON.stringify(body),
      }, f.env)).json() as Promise<{ status: number; msg: string }>;
      expect((await request({ order_id: source.orderId }, false)).status).not.toBe(200);
      expect((await request({ order_id: 123 })).status).not.toBe(200);
      expect(await request({ order_id: source.orderId })).toMatchObject({ status: 200, msg: '已删除' });
      expect(await request({ uni: 'local-delete-alias' })).toMatchObject({ status: 200 });
      expect((await request({ order_id: source.orderId })).status).not.toBe(200);
    });
  });
});
