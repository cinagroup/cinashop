/** Complete native PG16/App/JWT acceptance. No real payment, provider or Queue. */
import { expect, it, describe } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import { storeCart, storeOrder, storeOrderStatus } from '@/models/schema';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { withEditScenario, type EditScenario } from './helpers/adminOrderEdit';
import { orderCreationClient } from './helpers/orderCreationHistory';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const rows = (s: EditScenario, id?: number) => s.f.db.select().from(storeOrderStatus)
  .where(id === undefined ? undefined : eq(storeOrderStatus.oid, id)).orderBy(asc(storeOrderStatus.id));
const sequences = (s: EditScenario) => s.f.exec("SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
const state = async (s: EditScenario) => ({ business: await s.f.state(), sequences: await sequences(s) });
const createdRow = (order: { id: number; addTime: number }) => ({ oid: order.id, changeType: 'cache_key_create_order', changeMessage: '订单生成', changeTime: order.addTime });
const rawCreate = (db: Parameters<typeof createContainerFromDb>[0], s: EditScenario, key: string, orderId: string, assisted = false) =>
  StoreOrderCreateService.createWithRuntime(createContainerFromDb(db), { CONFIG_KV: s.env.CONFIG_KV, nextOrderId: async () => orderId },
    { uid: 11, key, cartIds: [1, 2], addressId: 11, useIntegral: true, userIp: '127.0.0.1',
      ...(assisted ? { assisted: { adminId: 102, touristUid: '' } } : {}) });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PHP creation history from actual checkout through independently commissioned native LOGINs', () => {
  it('keeps confirm/computed read-only, then exposes one actual creation through both Admin contracts and the buyer delivery timeline', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s), before = await state(s), receipt = await client.quote();
    const computed = await s.request('POST', '/api/order/computed/' + receipt.orderKey, client.input, client.token);
    expect(computed.status, computed.msg).toBe(200); expect(await state(s)).toEqual(before); expect(client.sequenceCalls()).toBe(0);
    const result = await client.create({ orderKey: receipt.orderKey, quoteToken: computed.data.quoteToken });
    expect(result.status, result.msg).toBe(200);
    const [order] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.data.orderId));
    expect(order).toMatchObject({ uid: 11, paid: 0, pid: 0, status: 0 });
    const history = await rows(s, order.id); expect(history).toHaveLength(1); expect(history[0]).toMatchObject(createdRow(order));
    expect(history.some(row => row.changeType === 'pay_success' || row.changeType === 'order_edit')).toBe(false);
    const after = await state(s);
    for (const prefix of ['/adminapi', '/api/admin']) {
      const legacy = await s.request('GET', prefix + '/order/status/' + order.id, undefined, s.token('viewer'));
      expect(legacy.status, legacy.msg).toBe(200); expect(legacy.data).toHaveLength(1);
      expect(legacy.data[0]).toMatchObject({ id: history[0].id, oid: order.id, change_type: 'cache_key_create_order', change_message: '订单生成' });
      const page = await s.request('GET', prefix + '/order/history/' + order.id + '?order_id=' + order.orderId, undefined, s.token('viewer'));
      expect(page.status, page.msg).toBe(200); expect(page.data).toMatchObject({ count: 1, id: order.id, order_id: order.orderId });
      expect(page.data.list[0]).toEqual({ ...legacy.data[0], timestamp: order.addTime });
    }
    const delivery = await s.request('GET', '/api/delivery_order/detail/' + order.id, undefined, client.token);
    expect(delivery.status, delivery.msg).toBe(200);
    expect(delivery.data.order_log.create).toBe((await s.request('GET', '/adminapi/order/status/' + order.id)).data[0].change_time.slice(0, 10));
    expect(await state(s)).toEqual(after); expect(client.sequenceCalls()).toBe(1);
  }), 120000);

  it('replays a committed HTTP key after its receipt is unusable without another status, sequence or business write', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s), { receipt, result, order } = await client.checkout(), before = await state(s);
    for (let n = 0; n < 2; n++) {
      const replay = await client.create(receipt, { quoteToken: 'unusable-old-receipt', cartIds: [] });
      expect(replay.status, replay.msg).toBe(200); expect(replay.data).toEqual(result.data);
    }
    expect(await rows(s, order.id)).toMatchObject([createdRow(order)]); expect(await rows(s, order.id)).toHaveLength(1);
    expect(await state(s)).toEqual(before); expect(client.sequenceCalls()).toBe(1);
  }), 120000);

  it('rejects anonymous and Admin/Supplier token substitutions before any creation or status sequence is claimed', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s), receipt = await client.quote(), before = await state(s);
    for (const token of [null, s.token('root'), s.token('supplier')]) {
      const response = await s.request('POST', '/api/order/create/' + receipt.orderKey, { ...client.input, quoteToken: receipt.quoteToken }, token);
      expect(response.status).not.toBe(200);
    }
    expect(await state(s)).toEqual(before); expect(client.sequenceCalls()).toBe(0);
  }), 120000);

  it('rolls back the entire checkout if the creation history INSERT fails, then admits one row on a deliberate retry', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s), receipt = await client.quote(), before = await s.f.state();
    await s.f.exec("CREATE FUNCTION reject_creation_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.change_type='cache_key_create_order' THEN RAISE EXCEPTION 'owned creation history rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_creation_history BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION reject_creation_history()");
    expect((await client.create(receipt)).status).not.toBe(200); expect(await s.f.state()).toEqual(before);
    await s.f.exec('DROP TRIGGER reject_creation_history ON store_order_status; DROP FUNCTION reject_creation_history()');
    const result = await client.create(receipt); expect(result.status, result.msg).toBe(200);
    const [order] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.data.orderId));
    expect(await rows(s)).toHaveLength(1); expect((await rows(s))[0]).toMatchObject(createdRow(order));
  }), 120000);

  it('removes the already inserted creation history when a later physical cart snapshot write rejects the same transaction', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s), receipt = await client.quote(), before = await s.f.state();
    await s.f.exec("CREATE FUNCTION reject_creation_cart() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned late cart rejection'; END $$; CREATE TRIGGER reject_creation_cart BEFORE INSERT ON store_order_cart_info FOR EACH ROW EXECUTE FUNCTION reject_creation_cart()");
    expect((await client.create(receipt)).status).not.toBe(200); expect(await s.f.state()).toEqual(before); expect(await rows(s)).toEqual([]);
    await s.f.exec('DROP TRIGGER reject_creation_cart ON store_order_cart_info; DROP FUNCTION reject_creation_cart()');
  }), 120000);

  it('does not repair missing commissioned INSERT authority or leave a partially created order', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s), receipt = await client.quote(), before = await s.f.state();
    expect(/^cinashop_runtime_[a-f0-9]{32}$/.test(s.roles.app)).toBe(true);
    await s.f.exec('REVOKE INSERT ON public.store_order_status FROM "' + s.roles.app + '"');
    expect((await client.create(receipt)).status).not.toBe(200); expect(await s.f.state()).toEqual(before);
    const [privilege] = await s.databases.app.execute(sql`SELECT has_table_privilege(current_user,'public.store_order_status','INSERT') AS allowed`);
    expect(privilege.allowed).toBe(false);
  }), 120000);

  it('rolls back the creation history together with an explicit outer business transaction', async () => withEditScenario(async s => {
    const before = await s.f.state();
    await s.f.withRuntime(async runtime => {
      await expect(withTx(runtime.container, async tx => {
        await rawCreate(tx, s, 'outer-history', 'OuterHistory');
        expect(await tx.select().from(storeOrderStatus)).toHaveLength(1);
        throw Error('owned outer rollback');
      })).rejects.toThrow('owned outer rollback');
    });
    expect(await s.f.state()).toEqual(before);
  }), 120000);

  it('serializes independently authenticated concurrent requests for one key into one order and one creation history', async () => withEditScenario(async s => {
    await s.f.withRuntime(first => s.f.withRuntime(async second => {
      await s.f.exec('BEGIN; SELECT pg_advisory_xact_lock(731649,1)'); let open = true;
      try {
        const creating = outcome(withTx(first.container, async tx => {
          const value = await rawCreate(tx, s, 'same-history-key', 'HistoryWinner');
          await tx.execute(sql`SELECT pg_advisory_xact_lock(731649,1)`); return value;
        }));
        const [owner] = await s.f.db.execute(sql`SELECT pg_backend_pid() AS pid`);
        await waitForFinanceBlock(s.f.db, first.pid, Number(owner.pid));
        expect(await rows(s)).toEqual([]);
        const retrying = outcome(rawCreate(second.db, s, 'same-history-key', 'HistoryLoser'));
        await waitForFinanceBlock(s.f.db, second.pid, first.pid);
        await s.f.exec('COMMIT'); open = false;
        const a = await creating, b = await retrying; expect(a.ok).toBe(true); expect(b).toEqual(a);
        if (!a.ok) throw a.error;
        expect(a.value.orderId).toBe('HistoryWinner');
        const orders = await s.f.db.select().from(storeOrder); expect(orders).toHaveLength(1);
        expect(await rows(s)).toHaveLength(1); expect((await rows(s))[0]).toMatchObject(createdRow(orders[0]));
      } finally { if (open) await s.f.exec('ROLLBACK'); }
    }));
  }), 120000);

  it('binds two independently created orders for the same buyer to their own single history rows', async () => withEditScenario(async s => {
    const client = await orderCreationClient(s), first = await client.checkout();
    await s.f.db.insert(storeCart).values({ id: 3, uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 1, status: 1, isNew: 1 });
    const receipt = await client.quote({ cartIds: [3] }), result = await client.create(receipt, { cartIds: [3] });
    expect(result.status, result.msg).toBe(200);
    const [second] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.data.orderId));
    expect(second.id).not.toBe(first.order.id); expect(await rows(s)).toHaveLength(2);
    for (const order of [first.order, second]) {
      const own = await rows(s, order.id); expect(own).toHaveLength(1); expect(own[0]).toMatchObject(createdRow(order));
      const read = await s.request('GET', '/adminapi/order/history/' + order.id + '?order_id=' + order.orderId);
      expect(read.data.list.map((row: { oid: number }) => row.oid)).toEqual([order.id]);
    }
  }), 120000);

  it('keeps the common creation record and existing assisted actor record distinct and idempotent', async () => withEditScenario(async s => {
    await s.f.db.update(storeCart).set({ staffId: 102 }).where(sql`${storeCart.id} IN (1,2)`);
    await s.f.withRuntime(async runtime => {
      const made = await rawCreate(runtime.db, s, 'assisted-history', 'AssistedHistory', true);
      const [order] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, made.orderId));
      expect(await rows(s, order.id)).toMatchObject([createdRow(order), { oid: order.id, changeType: 'admin_assisted_create' }]);
      expect(await rows(s, order.id)).toHaveLength(2);
      const before = await state(s); expect(await rawCreate(runtime.db, s, 'assisted-history', 'UnusedNumber', true)).toEqual(made);
      expect(await state(s)).toEqual(before);
    });
  }), 120000);

  it('retains the creation event on its original payment source across a genuine refund split without copying it onto children', async () => withEditScenario(async s => {
    await s.f.withRuntime(async runtime => {
      // This fixture explicitly admits synthetic paid state; no payment is called.
      const root = await runtime.createPaid(), before = await rows(s, root.id);
      expect(before.filter(row => row.changeType === 'cache_key_create_order')).toHaveLength(1);
      const refund = await runtime.apply(root.id); await runtime.finish(refund.refundId);
      const receipt = await runtime.receipt(refund.refundId);
      expect((await rows(s, root.id)).filter(row => row.changeType === 'cache_key_create_order')).toEqual(before.filter(row => row.changeType === 'cache_key_create_order'));
      for (const child of [receipt.selectedOrderId, receipt.remainingOrderId!])
        expect((await rows(s, child)).filter(row => row.changeType === 'cache_key_create_order')).toEqual([]);
    });
  }), 120000);
});
