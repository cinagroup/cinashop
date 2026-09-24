/** Real checkout capture on an isolated full schema and restricted LOGIN.
 * Pure-core checkout without capture below models pre-activation rows only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { orderConfirm, orderCreate } from '@/controllers/api/v1/OrderController';
import { createContainerFromDb, withTx } from '@/lib/di';
import { storeCart, storeOrder, storeOrderCartInfo, storeProduct } from '@/models/schema';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '@/services/supplier/SupplierFinanceService';
import { readPurchaseOriginEvidence, recordPurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';
import { runPurchaseOriginEvidenceSchema, runPurchaseOriginEvidence } from '@/migrations/runPurchaseOriginEvidence';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome, waitForFinanceBlock, waitForFinanceClock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = Parameters<Parameters<Fixture['withRuntime']>[0]>[0];
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('purchase origin checkout on isolated PostgreSQL16', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await runPurchaseOriginEvidenceSchema(f.db);
  }, 45000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); vi.useRealTimers(); await f?.close(); } }, 45000);
  const grant = (r: Runtime) => runPurchaseOriginEvidence(f.db, r.role);
  const read = (r: Runtime, id: number, buyerId = 11) => withTx(r.container, tx => readPurchaseOriginEvidence(tx, { orderId: id, buyerId }));
  const capture = (r: Runtime, id: number, buyerId = 11) => withTx(r.container, tx => recordPurchaseOriginEvidence(tx, { orderId: id, buyerId }));
  async function checkout(r: Runtime, fail = false, presale = false, afterCapture?: () => Promise<void>) {
    const transaction = r.db.transaction.bind(r.db);
    const intercept: typeof r.db.transaction = (fn, config) => transaction(async tx => {
      const result = await fn(tx);
      // Only fault injection remains outside the service. The service itself
      // must have persisted the receipt before returning from its transaction.
      const [receipt] = await tx.execute(sql`SELECT count(*)::integer AS n FROM public.store_order_purchase_origin`);
      expect(receipt.n).toBe(1);
      await afterCapture?.();
      if (fail) await tx.execute(sql`SELECT 1/0`);
      return result;
    }, config);
    const db = new Proxy(r.db, { get(target, key, receiver) { return key === 'transaction' ? intercept : Reflect.get(target, key, receiver); } });
    const created = await StoreOrderCreateService.createWithRuntime(createContainerFromDb(db),
      { CONFIG_KV: f.env.CONFIG_KV, requirePurchaseOrigin: true, nextOrderId: async () => 'local-origin-checkout' },
      { uid: 11, key: 'local-origin-checkout', cartIds: presale ? [1] : [1, 2], type: presale ? 6 : 0,
        addressId: 11, useIntegral: true, userIp: '127.0.0.1' });
    return (await r.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId)))[0];
  }
  it('captures once inside real mixed checkout, preserving quantities after cancellation and source changes', async () => {
    await f.db.update(storeProduct).set({ type: 1, relationId: 0 }).where(eq(storeProduct.id, 71));
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r), saved = await read(r, root.id);
      expect(root.supplierAllocationStatus).toBe(1);
      expect(saved).toMatchObject({ orderId: root.id, buyerId: 11, orderType: 0, totalNum: 3, usedPoints: 100 });
      expect(saved?.lines.map(row => [row.productId, row.quantity])).toEqual([[70, 2], [71, 1]]);
      expect(await checkout(r)).toEqual(root);
      expect(await capture(r, root.id)).toEqual(saved);
      await new StoreOrderCreateService(r.container, f.env).cancel(11, root.orderId);
      await f.db.update(storeOrderCartInfo).set({ cartNum: 99, uid: 22 }).where(eq(storeOrderCartInfo.oid, root.id));
      expect(await read(r, root.id)).toEqual(saved);
      expect(await capture(r, root.id)).toEqual(saved);
      await expect(read(r, root.id, 22)).rejects.toThrow('原始购买数量');
      expect(await r.db.execute(sql`SELECT count(*)::integer AS n FROM public.store_order_purchase_origin`)).toMatchObject([{ n: 1 }]);
    });
  }, 45000);
  it('keeps original presale quantity unchanged through a real refund and hidden history', async () => {
    await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: 0, presaleEndTime: 2147483647, isLimit: 0 })
      .where(eq(storeProduct.id, 70));
    await f.db.update(storeCart).set({ type: 6, cartNum: 3 }).where(eq(storeCart.id, 1));
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r, false, true), saved = await read(r, root.id);
      expect(saved).toMatchObject({ orderType: 6, totalNum: 3, usedPoints: 100 });
      const fulfillment = await withTx(r.container, async tx => {
        await tx.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'LOCAL-SYNTHETIC' }).where(eq(storeOrder.id, root.id));
        const allocation = await allocatePaidOrderBySupplier(tx, root.id, root.orderId, 100);
        for (const child of allocation.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
        expect(allocation.fulfillmentOrders).toHaveLength(1); return allocation.fulfillmentOrders[0];
      });
      const refund = await r.apply(fulfillment.id); expect(await r.finish(refund.refundId)).toBe('completed');
      await f.db.update(storeOrder).set({ isDel: 1, isSystemDel: 1 });
      expect(await read(r, root.id)).toEqual(saved);
    });
  }, 45000);
  it.each(['late-failure', 'missing-insert', 'missing-select', 'missing-table'] as const)('rolls back checkout stock, cart, points and evidence on %s', async failure => {
    await f.withRuntime(async r => {
      if (failure === 'missing-insert' || failure === 'missing-select')
        await f.exec(`REVOKE ${failure === 'missing-insert' ? 'INSERT' : 'SELECT'} ON public.store_order_purchase_origin FROM "${r.role}"`);
      // State includes the receipt table, so restore its name only after the
      // failed transaction when comparing the whole synthetic scenario.
      const before = await f.state();
      if (failure === 'missing-table') await f.exec('ALTER TABLE public.store_order_purchase_origin RENAME TO local_missing_origin');
      await expect(checkout(r, failure === 'late-failure')).rejects.toThrow();
      if (failure === 'missing-table') await f.exec('ALTER TABLE public.local_missing_origin RENAME TO store_order_purchase_origin');
      expect(await f.state()).toEqual(before);
      expect(await f.db.execute(sql`SELECT count(*)::integer AS n FROM public.store_order_purchase_origin`)).toMatchObject([{ n: 0 }]);
      await grant(r); expect((await checkout(r)).paid).toBe(0);
    });
  }, 45000);

  it('forces origin capture through public confirmation/create, and quote/replay never write a receipt', async () => {
    await f.withRuntime(async r => {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', r.container); c.set('uid', 11); await next(); });
      app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
      app.post('/confirm', orderConfirm); app.post('/create/:key', orderCreate);
      const sequence = vi.fn(async () => new Response('public-origin-checkout'));
      Object.assign(f.env, { SEQUENCE: { idFromName: () => 'local', get: () => ({ fetch: sequence }) } });
      const post = async (path: string, body: object) => (await app.request(path, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, f.env))
        .json<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; orderId: string } }>();
      const input = { cartIds: [1, 2], addressId: 11, useIntegral: true };
      const before = await f.state(), quote = await post('/confirm', input);
      expect(quote.status, quote.msg).toBe(200); expect(await f.state()).toEqual(before); expect(sequence).not.toHaveBeenCalled();
      // Neither an untrusted flag nor missing rights can disable capture.
      await f.exec(`REVOKE INSERT ON public.store_order_purchase_origin FROM "${r.role}"`);
      const path = `/create/${quote.data.orderKey}`;
      const body = { ...input, quoteToken: quote.data.quoteToken, requirePurchaseOrigin: false };
      expect((await post(path, body)).status).toBe(400); expect(await f.state()).toEqual(before);
      await grant(r);
      const created = await post(path, body); expect(created.status, created.msg).toBe(200);
      const committed = await f.state(); expect(committed.store_order_purchase_origin).toHaveLength(1);
      await f.exec(`REVOKE SELECT,INSERT ON public.store_order_purchase_origin FROM "${r.role}"`);
      expect((await post(path, { quoteToken: 'expired', requirePurchaseOrigin: false })).data).toEqual(created.data);
      expect(await f.state()).toEqual(committed); expect(sequence).toHaveBeenCalledTimes(2);
    });
  }, 45000);

  it('does not backfill pre-activation orders on the public service replay path', async () => {
    await f.withRuntime(async r => {
      const created = await r.checkout(), before = await f.state();
      expect(before.store_order_purchase_origin).toEqual([]);
      await f.exec(`REVOKE SELECT,INSERT ON public.store_order_purchase_origin FROM "${r.role}"`);
      expect(await new StoreOrderCreateService(r.container, f.env).createOrder({ uid: 11,
        key: created.key, cartIds: [], userIp: '127.0.0.1' })).toEqual(created);
      expect(await f.state()).toEqual(before);
    });
  }, 45000);

  it('serializes two actual same-key checkouts and does not recapture on the post-lock replay path', async () => {
    await f.withRuntime(async first => f.withRuntime(async second => {
      // A replay must not need the origin writer; a new order with this role
      // would fail closed. Start it while the first order is still invisible.
      await f.exec(`REVOKE SELECT,INSERT ON public.store_order_purchase_origin FROM "${second.role}"`);
      let competing: ReturnType<typeof outcome<{ orderId: string; key: string }>> | undefined;
      const root = await checkout(first, false, false, async () => {
        competing = outcome(StoreOrderCreateService.createWithRuntime(second.container,
          { CONFIG_KV: f.env.CONFIG_KV, requirePurchaseOrigin: true, nextOrderId: async () => 'losing-local-origin-number' },
          { uid: 11, key: 'local-origin-checkout', cartIds: [1, 2], addressId: 11, useIntegral: true, userIp: '127.0.0.1' }));
        await waitForFinanceBlock(f.db, second.pid, first.pid);
      });
      expect(await competing).toEqual({ ok: true, value: { orderId: root.orderId, key: 'local-origin-checkout' } });
      const state = await f.state();
      expect(state.store_order).toHaveLength(1); expect(state.store_order_purchase_origin).toHaveLength(1);
      expect(state.user_bill).toHaveLength(1);
      expect(await read(first, root.id)).toMatchObject({ totalNum: 3, usedPoints: 100 });
    }));
  }, 45000);

  it('rechecks the presale wall clock after the service has captured origin, rolling everything back on expiry', async () => {
    await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: 0, isLimit: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeCart).set({ type: 6 }).where(eq(storeCart.id, 1));
    await f.withRuntime(async r => f.withPeer!(async observer => {
      const [clock] = await f.db.execute(sql`SELECT extract(epoch from clock_timestamp())*1000 AS millis`);
      const millis = Math.floor(Number(clock.millis)), end = Math.floor(millis / 1000) + 2;
      await f.db.update(storeProduct).set({ presaleEndTime: end }).where(eq(storeProduct.id, 70));
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(millis);
      const before = await f.state(), original = PostgresJsPreparedQuery.prototype.execute;
      let captured = false;
      vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function (
        this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args
      ) {
        const result = await original.apply(this, args);
        if (!captured && this.getQuery().sql.startsWith('INSERT INTO public.store_order_purchase_origin(')) {
          captured = true;
          // Independent observer cannot see the uncommitted receipt.
          expect(await observer.db.execute(sql`SELECT count(*)::integer AS n FROM public.store_order_purchase_origin`)).toMatchObject([{ n: 0 }]);
          await waitForFinanceClock(observer.db, (end + 1) * 1000 + 10);
        }
        return result;
      });
      await expect(checkout(r, false, true)).rejects.toThrow(/重新确认/);
      expect(captured).toBe(true); expect(await f.state()).toEqual(before);
    }));
  }, 45000);
  it.each(['UPDATE', 'DELETE', 'TRUNCATE'] as const)('blocks %s even if a runtime receives that accidental privilege', async action => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r), saved = await read(r, root.id);
      await f.exec(`GRANT ${action} ON public.store_order_purchase_origin TO "${r.role}"`);
      const statement = action === 'UPDATE' ? 'UPDATE public.store_order_purchase_origin SET total_num=999'
        : action === 'DELETE' ? 'DELETE FROM public.store_order_purchase_origin' : 'TRUNCATE public.store_order_purchase_origin';
      await expect(r.db.execute(sql.raw(statement))).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await read(r, root.id)).toEqual(saved);
    });
  }, 45000);
  it.each(['wrong-buyer', 'paid', 'child', 'quantity', 'legacy', 'oversized', 'injected-payload'] as const)(
    'rejects unsafe origin capture: %s', async damage => {
      await f.withRuntime(async r => {
        await grant(r); const created = await r.checkout();
        const [root] = await r.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
        const [line] = await r.carts(root.id);
        if (damage === 'paid' || damage === 'child') await f.db.update(storeOrder).set(damage === 'paid' ? { paid: 1 } : { pid: 999 }).where(eq(storeOrder.id, root.id));
        if (damage === 'quantity' || damage === 'legacy' || damage === 'oversized') await f.db.update(storeOrderCartInfo)
          .set(damage === 'quantity' ? { cartNum: line.cartNum + 1 }
            : { cartInfo: damage === 'legacy' ? JSON.stringify({ sku: { id: 1 } })
              : JSON.stringify({ ...JSON.parse(line.cartInfo!), note: '图'.repeat(22000) }) }).where(eq(storeOrderCartInfo.id, line.id));
        const before = await f.state();
        if (damage === 'injected-payload') await expect(r.db.execute(sql`INSERT INTO public.store_order_purchase_origin(order_id,buyer_id,total_num)
          VALUES (${root.id},11,999)`)).rejects.toMatchObject({ cause: { code: '23514' } });
        else await expect(capture(r, root.id, damage === 'wrong-buyer' ? 22 : 11)).rejects.toThrow();
        expect(await f.state()).toEqual(before); expect(await read(r, root.id)).toBeNull();
      });
    }, 45000);
  it('serializes concurrent attempts and stores just one canonical origin', async () => {
    await f.withRuntime(async first => {
      await grant(first); const created = await first.checkout();
      const [root] = await first.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      await f.withRuntime(async second => {
        await grant(second);
        const { stored, competing } = await withTx(first.container, async tx => {
          const stored = await recordPurchaseOriginEvidence(tx, { orderId: root.id, buyerId: 11 });
          const competing = outcome(capture(second, root.id));
          await waitForFinanceBlock(f.db, second.pid, first.pid);
          return { stored, competing };
        });
        expect(await competing).toEqual({ ok: true, value: stored });
        expect(await read(second, root.id)).toEqual(stored);
      });
    });
  }, 45000);
  it('rechecks root status after an independent payment writer commits', async () => {
    await f.withRuntime(async r => {
      await grant(r); const created = await r.checkout();
      const [root] = await r.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      await f.withPeer!(async peer => {
        const { capturing } = await peer.db.transaction(async tx => {
          await tx.update(storeOrder).set({ paid: 1 }).where(eq(storeOrder.id, root.id));
          const capturing = outcome(capture(r, root.id));
          await waitForFinanceBlock(f.db, r.pid, peer.pid); return { capturing };
        });
        expect((await capturing).ok).toBe(false); expect(await read(r, root.id)).toBeNull();
      });
    });
  }, 45000);
  it('rechecks the locked line after a concurrent inconsistent quantity edit', async () => {
    await f.withRuntime(async r => {
      await grant(r); const created = await r.checkout();
      const [root] = await r.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      const [line] = await r.carts(root.id);
      await f.withPeer!(async peer => {
        const { capturing } = await peer.db.transaction(async tx => {
          await tx.execute(sql`SELECT id FROM public.store_order_cart_info WHERE id=${line.id} FOR UPDATE`);
          const capturing = outcome(capture(r, root.id));
          await waitForFinanceBlock(f.db, r.pid, peer.pid);
          await tx.update(storeOrderCartInfo).set({ cartNum: line.cartNum + 1 }).where(eq(storeOrderCartInfo.id, line.id));
          return { capturing };
        });
        expect((await capturing).ok).toBe(false); expect(await read(r, root.id)).toBeNull();
        await f.db.update(storeOrderCartInfo).set({ cartNum: line.cartNum }).where(eq(storeOrderCartInfo.id, line.id));
        expect((await capture(r, root.id)).totalNum).toBe(3);
      });
    });
  }, 45000);
  it('keeps missing evidence distinct and requires exact relation authority and an explicit transaction', async () => {
    await f.withRuntime(async r => {
      await grant(r); expect(await read(r, 12345)).toBeNull();
      await expect(readPurchaseOriginEvidence(r.db, { orderId: 12345, buyerId: 11 })).rejects.toThrow('caller-owned transaction');
      const [permissions] = await r.db.execute(sql`SELECT
        has_table_privilege(current_user,'public.store_order_purchase_origin','UPDATE,DELETE,TRUNCATE,TRIGGER') AS rewrite,
        has_function_privilege(current_user,'public.capture_purchase_origin_v1()','EXECUTE') AS direct_function,
        has_schema_privilege(current_user,'public','CREATE') AS create_schema`);
      expect(permissions).toMatchObject({ rewrite: false, direct_function: false, create_schema: false });
      const root = await checkout(r);
      await f.exec(`REVOKE SELECT ON public.store_order_purchase_origin FROM "${r.role}"`);
      await expect(read(r, root.id)).rejects.toMatchObject({ cause: { code: '42501' } });
    });
  }, 45000);
});
