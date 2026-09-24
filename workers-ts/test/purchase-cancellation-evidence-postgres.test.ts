/** Registered protocol acceptance on owned full-schema PG16 only, using the
 * reviewed installer. This is not production acceptance. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { inspectPurchaseCancellationEvidence, runPurchaseCancellationEvidenceSchema, runPurchaseCancellationEvidence } from '@/migrations/runPurchaseCancellationEvidence';
import { readPurchaseCancellationEvidence } from '@/services/order/PurchaseCancellationEvidence';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { ScheduledMaintenanceService } from '@/services/order/ScheduledMaintenanceService';
import { storeCart, storeOrder, storeOrderCartInfo, storeOrderStatus, storeProduct, userBill } from '@/models/schema';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = Parameters<Parameters<Fixture['withRuntime']>[0]>[0];
type Tx = Parameters<Parameters<DbClient['transaction']>[0]>[0];
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered cancellation evidence on native PostgreSQL16', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    // Verify registration BEFORE repeat installation can mask a missing step.
    expect(await inspectPurchaseCancellationEvidence(f.db)).toEqual({ state:'v1',sourcesReady:true });
    await runPurchaseCancellationEvidenceSchema(f.db);
    await f.db.update(storeProduct).set({ type: 1, relationId: 0 }).where(eq(storeProduct.id, 71));
  }, 45000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 45000);
  const grant = (r: Runtime) => runPurchaseCancellationEvidence(f.db,r.role);
  const read = (r: Runtime, orderId: number, buyerId = 11) => withTx(r.container,
    tx => readPurchaseCancellationEvidence(tx, { orderId, buyerId }));
  const state = async () => ({ ...await f.state(), cancellation: await f.db.execute(sql`
    SELECT to_jsonb(t) AS row FROM public.store_order_purchase_cancellation t ORDER BY order_id`) });
  async function checkout(r: Runtime, presale = false, points = true, origin = true) {
    const created = await StoreOrderCreateService.createWithRuntime(r.container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'local-cancel-receipt', ...(origin ? { requirePurchaseOrigin: true as const } : {}) },
      { uid: 11, key: 'local-cancel-receipt', cartIds: presale ? [1] : [1, 2], type: presale ? 6 : 0,
        addressId: 11, useIntegral: points, userIp: '127.0.0.1' });
    return (await r.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId)))[0];
  }
  // Fault injection only. Receipt capture is from the installed registered DB
  // transition trigger, never a test callback that writes an alleged success.
  function service(r: Runtime, after?: (tx: Tx) => Promise<void>) {
    if (!after) return new StoreOrderCreateService(r.container, f.env);
    const transact = r.db.transaction.bind(r.db);
    const intercept: typeof r.db.transaction = (fn, config) => transact(async tx => {
      const result = await fn(tx); await after(tx); return result;
    }, config);
    return new StoreOrderCreateService(createContainerFromDb(new Proxy(r.db, {
      get(target, key, receiver) { return key === 'transaction' ? intercept : Reflect.get(target, key, receiver); },
    })), f.env);
  }
  it.each(['cancel', 'delete', 'scheduled'] as const)('captures one immutable receipt through actual %s compensation', async action => {
    await f.withRuntime(async r => {
      await grant(r); const before = await state(), root = await checkout(r);
      expect(await read(r, root.id)).toBeNull();
      if (action === 'scheduled') {
        expect(await new ScheduledMaintenanceService(r.container, f.env).processOrder({ action: 'processScheduledOrder',
          job: 'unpaid_order_cancel', runId: 'local-receipt', scheduledAt: (root.addTime + 7200) * 1000,
          threshold: root.addTime + 3600, orderId: root.id })).toMatchObject({ completed: true });
      } else await service(r)[action === 'delete' ? 'del' : 'cancel'](11, root.orderId);
      const receipt = await read(r, root.id);
      expect(receipt).toMatchObject({ version: 'purchase-cancellation-v1', origin: {
        orderId: root.id, buyerId: 11, orderType: 0, totalNum: 3, usedPoints: 100 } });
      expect(receipt?.origin.lines.map(line => [line.productId, line.quantity])).toEqual([[70, 2], [71, 1]]);
      const after = await state();
      for (const table of ['store_product', 'store_product_attr_value', 'user', 'store_cart'])
        expect(after[table as keyof typeof after]).toEqual(before[table as keyof typeof before]);
      expect(after.cancellation).toHaveLength(1);
      await expect(service(r).cancel(11, root.orderId)).rejects.toThrow(); expect(await state()).toEqual(after);
      // No unrelated order/contact/snapshot fields enter the bounded receipt.
      expect(JSON.stringify(receipt)).not.toMatch(/realName|phone|address|cartInfo|balance/);
      await expect(read(r, root.id, 22)).rejects.toThrow();
    });
  }, 45000);
  it.each([true, false])('captures presale with points enabled=%s and keeps original quantities', async points => {
    await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: 0, presaleEndTime: 2147483647, isLimit: 0 })
      .where(eq(storeProduct.id, 70));
    await f.db.update(storeCart).set({ type: 6 }).where(eq(storeCart.id, 1));
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r, true, points);
      await service(r).cancel(11, root.orderId);
      expect((await read(r, root.id))?.origin).toMatchObject({ orderType: 6, totalNum: 2, usedPoints: points ? 100 : 0 });
    });
  }, 45000);
  it('does not promote pre-activation orders to trusted cancellation history', async () => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r, false, true, false);
      await service(r).cancel(11, root.orderId);
      expect(await read(r, root.id)).toBeNull();
      expect((await r.order(root.id)).status).toBe(-2);
      await expect(r.db.execute(sql`INSERT INTO public.store_order_purchase_cancellation(order_id,buyer_id)
        VALUES (${root.id},11)`)).rejects.toThrow();
      expect(await read(r, root.id)).toBeNull();
    });
  }, 45000);
  it.each(['missing-insert', 'missing-origin-select', 'late-sql', 'missing-table'] as const)(
    'rolls back receipt, points, stock, cart and status on %s', async failure => {
      await f.withRuntime(async r => {
        await grant(r); const root = await checkout(r), before = await state();
        if (failure === 'missing-insert') await f.exec(`REVOKE INSERT ON public.store_order_purchase_cancellation FROM "${r.role}"`);
        if (failure === 'missing-origin-select') await f.exec(`REVOKE SELECT ON public.store_order_purchase_origin FROM "${r.role}"`);
        if (failure === 'missing-table') await f.exec('ALTER TABLE public.store_order_purchase_cancellation RENAME TO local_missing_cancellation');
        await expect(service(r, failure === 'late-sql' ? async tx => { await tx.execute(sql`SELECT 1/0`); } : undefined)
          .del(11, root.orderId)).rejects.toThrow();
        if (failure === 'missing-table') await f.exec('ALTER TABLE public.local_missing_cancellation RENAME TO store_order_purchase_cancellation');
        expect(await state()).toEqual(before);
      });
    }, 45000);
  it.each(['missing-log', 'duplicate-log', 'missing-deduction', 'wrong-deduction', 'missing-restoration', 'wrong-restoration', 'duplicate-restoration',
    'late-line-drift', 'late-child', 'late-paid'] as const)('rejects at COMMIT and rolls back on %s', async damage => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r), before = await state();
      // Maintenance permissions for precise test corruption only; never an installer profile.
      await f.exec(`GRANT DELETE ON public.store_order_status,public.user_bill TO "${r.role}"`);
      const failed = service(r, async tx => {
        if (damage === 'missing-log') await tx.delete(storeOrderStatus).where(eq(storeOrderStatus.changeType, 'cancel'));
        if (damage === 'duplicate-log') await tx.insert(storeOrderStatus).values({ oid: root.id, changeType: 'cancel' });
        if (damage === 'missing-deduction') await tx.delete(userBill).where(eq(userBill.eventKey, 'order_integral_deduction'));
        if (damage === 'wrong-deduction') await tx.update(userBill).set({ number: '99.00' }).where(eq(userBill.eventKey, 'order_integral_deduction'));
        if (damage === 'missing-restoration') await tx.delete(userBill).where(eq(userBill.eventKey, 'order_cancel_integral_back'));
        if (damage === 'wrong-restoration') await tx.update(userBill).set({ number: '99.00' }).where(eq(userBill.eventKey, 'order_cancel_integral_back'));
        if (damage === 'duplicate-restoration') {
          const [bill] = await tx.select().from(userBill).where(eq(userBill.eventKey, 'order_cancel_integral_back'));
          await tx.insert(userBill).values({ ...bill, id: undefined });
        }
        if (damage === 'late-line-drift') await tx.update(storeOrderCartInfo).set({ cartNum: 4 }).where(eq(storeOrderCartInfo.oid, root.id));
        if (damage === 'late-child') await tx.insert(storeOrder).values({ ...root, id: undefined, orderId: 'local-late-child', unique: 'local-late-child', pid: root.id });
        if (damage === 'late-paid') await tx.update(storeOrder).set({ paid: 1 }).where(eq(storeOrder.id, root.id));
        // Receipt exists inside the open transaction, but is not a committed fact.
        expect(await readPurchaseCancellationEvidence(tx, { orderId: root.id, buyerId: 11 })).not.toBeNull();
      });
      await expect(failed.cancel(11, root.orderId)).rejects.toThrow();
      expect(await state()).toEqual(before);
      await service(r).cancel(11, root.orderId); expect(await read(r, root.id)).not.toBeNull();
    });
  }, 45000);
  it('forbids forged direct capture, rewrite, delete and truncate, including accidental owner rewrites', async () => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r);
      await expect(r.db.execute(sql`INSERT INTO public.store_order_purchase_cancellation(order_id,buyer_id)
        VALUES (${root.id},11)`)).rejects.toThrow();
      await service(r).cancel(11, root.orderId); const before = await state();
      for (const db of [r.db, f.db]) {
        for (const statement of ['UPDATE public.store_order_purchase_cancellation SET total_num=99',
          'DELETE FROM public.store_order_purchase_cancellation', 'TRUNCATE public.store_order_purchase_cancellation'])
          await expect(db.execute(sql.raw(statement))).rejects.toThrow();
      }
      expect(await state()).toEqual(before);
      const [rights] = await r.db.execute(sql`SELECT has_table_privilege(current_user,'public.store_order_purchase_cancellation','UPDATE') AS u,
        has_function_privilege(current_user,'public.capture_purchase_cancellation_v1()','EXECUTE') AS f`);
      expect(rights).toEqual({ u: false, f: false });
    });
  }, 45000);
  it('keeps committed evidence after later source changes without recomputing history', async () => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r); await service(r).cancel(11, root.orderId);
      const saved = await read(r, root.id);
      await f.db.update(storeOrderCartInfo).set({ cartNum: 99, uid: 22 }).where(eq(storeOrderCartInfo.oid, root.id));
      await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, root.id));
      await f.db.update(userBill).set({ number: '999.00' }).where(eq(userBill.eventKey, 'order_cancel_integral_back'));
      expect(await read(r, root.id)).toEqual(saved);
    });
  }, 45000);
  it('rejects coherent live quantity rewrites that pass structural cancellation checks but disagree with origin', async () => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r), [line] = await r.carts(root.id);
      const snapshot = JSON.parse(line.cartInfo!); snapshot.cart_num++;
      await f.db.update(storeOrderCartInfo).set({ cartNum: line.cartNum + 1, splitSurplusNum: line.cartNum + 1,
        surplusNum: line.cartNum + 1, cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, line.id));
      await f.db.update(storeOrder).set({ totalNum: root.totalNum + 1 }).where(eq(storeOrder.id, root.id));
      const before = await state();
      await expect(service(r).cancel(11, root.orderId)).rejects.toThrow();
      expect(await state()).toEqual(before);
    });
  }, 45000);
  it('does not certify a status-only write without atomic compensation evidence', async () => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r), before = await state();
      await expect(r.db.update(storeOrder).set({ status: -2, isDel: 1 }).where(eq(storeOrder.id, root.id))).rejects.toThrow();
      expect(await state()).toEqual(before);
    });
  }, 45000);
  it.each([{ paid: 1 }, { pid: -1 }, { supplierAllocationStatus: 2 }, { refundStatus: 1 }, { isDel: 1 }, { isSystemDel: 1 }])(
    'rejects invalid direct cancellation transition from %j', async patch => {
      await f.withRuntime(async r => {
        await grant(r); const root = await checkout(r);
        await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, root.id));
        const before = await state();
        await expect(r.db.update(storeOrder).set({ status: -2, isDel: 1 }).where(eq(storeOrder.id, root.id))).rejects.toThrow();
        expect(await state()).toEqual(before);
      });
    }, 45000);
  it('does not retroactively capture already cancelled origin-backed orders after protocol activation', async () => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r);
      // Model a cancellation before activation. Only the fixture owner disables
      // the trigger; runtime has neither ownership nor ALTER/TRIGGER authority.
      await f.exec('ALTER TABLE public.store_order DISABLE TRIGGER sopc_order_transition');
      try { await service(r).cancel(11, root.orderId); }
      finally { await f.exec('ALTER TABLE public.store_order ENABLE TRIGGER sopc_order_transition'); }
      await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, root.id));
      expect(await read(r, root.id)).toBeNull();
      await expect(r.db.execute(sql`INSERT INTO public.store_order_purchase_cancellation(order_id,buyer_id)
        VALUES (${root.id},11)`)).rejects.toThrow();
      expect(await read(r, root.id)).toBeNull();
    });
  }, 45000);
  it('rejects root clients, invalid scopes and missing read privilege without returning another buyer data', async () => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r); await service(r).cancel(11, root.orderId);
      await expect(readPurchaseCancellationEvidence(r.db, { orderId: root.id, buyerId: 11 })).rejects.toThrow('caller-owned');
      for (const scope of [{ orderId: 0, buyerId: 11 }, { orderId: root.id, buyerId: -1 },
        { orderId: root.id, buyerId: 2147483648 }, { orderId: 2147483648, buyerId: 11 }])
        await expect(withTx(r.container, tx => readPurchaseCancellationEvidence(tx, scope))).rejects.toThrow();
      await f.exec(`REVOKE SELECT ON public.store_order_purchase_cancellation FROM "${r.role}"`);
      await expect(read(r, root.id)).rejects.toThrow();
    });
  }, 45000);
  it('uses the existing bounded source lookup indexes with 200000 unrelated rows per log/points table', async () => {
    await f.withRuntime(async r => {
      await grant(r); const root = await checkout(r);
      await f.exec(`INSERT INTO public.store_order_status(oid,change_type)
        SELECT 1000000+g,'cancel' FROM generate_series(1,200000) g;
        INSERT INTO public.user_bill(uid,link_id,category,type,event_key,number,pm)
        SELECT 22,(1000000+g)::text,'integral',CASE WHEN g%2=0 THEN 'deduction' ELSE 'order_cancel' END,
          CASE WHEN g%2=0 THEN 'order_integral_deduction' ELSE 'order_cancel_integral_back' END,1,g%2
        FROM generate_series(1,200000) g;
        ANALYZE public.store_order_status; ANALYZE public.user_bill;`);
      const statements = [
        sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM public.store_order_status WHERE oid=${root.id} AND change_type='cancel' LIMIT 2`,
        sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT uid,pm,event_key,number,status FROM public.user_bill
          WHERE category='integral' AND type='deduction' AND link_id=${String(root.id)} LIMIT 2`,
        sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT uid,pm,event_key,number,status FROM public.user_bill
          WHERE category='integral' AND type='order_cancel' AND link_id=${String(root.id)} LIMIT 2`,
      ];
      for (const [index, statement] of statements.entries()) {
        const plan = JSON.stringify(await r.db.execute(statement));
        expect(plan).not.toContain('Seq Scan');
        expect(plan).toMatch(index === 0 ? /sos_oid_idx|sos_oid_change_time/ : /ub_cat_type_link_idx/);
      }
      await service(r).cancel(11, root.orderId); expect(await read(r, root.id)).not.toBeNull();
    });
  }, 60000);
  it('serializes actual cancel/delete contenders and creates one receipt and one points return', async () => {
    await f.withRuntime(async first => f.withRuntime(async second => {
      await grant(first); await grant(second); const root = await checkout(first);
      await f.withPeer!(async holder => {
        const { cancelling, deleting } = await holder.db.transaction(async tx => {
          await tx.execute(sql`SELECT id FROM public.store_order WHERE id=${root.id} FOR UPDATE`);
          const cancelling = outcome(service(first).cancel(11, root.orderId));
          await waitForFinanceBlock(f.db, first.pid, holder.pid);
          const deleting = outcome(service(second).del(11, root.orderId));
          await waitForFinanceBlock(f.db, second.pid, first.pid);
          return { cancelling, deleting };
        });
        expect((await cancelling).ok).toBe(true); expect((await deleting).ok).toBe(false);
      });
      const saved = await state(); expect(saved.cancellation).toHaveLength(1);
      expect((await first.db.select().from(userBill)).filter(row => row.eventKey === 'order_cancel_integral_back')).toHaveLength(1);
    }));
  }, 45000);
});
