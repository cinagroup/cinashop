import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { assertCheckoutPaidOrderQualifications } from '../src/services/order/CheckoutPaidOrderAuthority';
import { runBrokeragePaidOrderFence } from '../src/migrations/runBrokeragePaidOrderFence';
import { agentLevel, printDocument, storeOrder, storeOrderCartInfo, storeOrderStatus, storeProductAttrValue, user, userBrokerage } from '../src/models/schema';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('checkout cumulative paid-order authority', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const input = { cartIds: [1], addressId: 11, type: 0 };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([agentLevel, storeOrderCartInfo, storeOrderStatus, printDocument, userBrokerage]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '3', store_brokerage_price: '50',
      brokerage_level: '2', brokerage_compute_type: '1', store_brokerage_ratio: '10', store_brokerage_two: '5' });
    await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
    await f.db.insert(user).values([
      { uid: 22, account: 'paid-first', spreadUid: 33, status: 1, spreadOpen: 1, isPromoter: 0 },
      { uid: 33, account: 'paid-second', status: 1, spreadOpen: 1, isPromoter: 0 },
    ]);
    await f.db.insert(storeOrder).values([
      { id: 900, orderId: 'fixture-first-paid', uid: 22, paid: 1, payPrice: '60.00' },
      { id: 901, orderId: 'fixture-second-paid', uid: 33, paid: 1, payPrice: '60.00' },
    ]);
    const [row] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values(1)) as probe(n)`);
    await runBrokeragePaidOrderFence(f.db, row.schema);
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => new Response('paid_authority_order') }) } });
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; errorCode?: string } }>;
  };
  const state = async () => {
    const snapshot = await f.snapshot();
    // UPDATE changes physical tuple order; compare all business fields by stable PK.
    return { ...snapshot, orders: snapshot.orders.sort((a, b) => a.id - b.id),
      details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus),
      brokerageRows: await f.db.select().from(userBrokerage) };
  };
  const variants = ['refund', 'soft-delete', 'split', 'delete', 'transfer', 'threshold-equal', 'threshold-up',
    'second-refund', 'still-eligible', 'still-ineligible', 'metadata', 'unpaid'] as const;
  type Variant = typeof variants[number];
  const permitted = (v: Variant) => ['still-eligible', 'still-ineligible', 'metadata', 'unpaid'].includes(v);
  const prepare = async (v: Variant) => {
    if (v === 'threshold-up' || v === 'still-ineligible') await f.db.update(storeOrder).set({ payPrice: '50.00' }).where(eq(storeOrder.id, 900));
  };
  const edit = async (db: DbClient, v: Variant) => {
    if (v === 'refund' || v === 'second-refund') await db.update(storeOrder).set({ refundStatus: 1 }).where(eq(storeOrder.id, v === 'refund' ? 900 : 901));
    else if (v === 'soft-delete') await db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, 900));
    else if (v === 'split') await db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, 900));
    else if (v === 'delete') await db.delete(storeOrder).where(eq(storeOrder.id, 900));
    else if (v === 'transfer') await db.update(storeOrder).set({ uid: 33 }).where(eq(storeOrder.id, 900));
    else if (v === 'threshold-equal') await db.update(storeOrder).set({ payPrice: '50.00' }).where(eq(storeOrder.id, 900));
    else if (v === 'threshold-up') await db.insert(storeOrder).values({ id: 902, orderId: 'paid-phantom', uid: 22, paid: 1, payPrice: '0.01' });
    else if (v === 'still-eligible') await db.update(storeOrder).set({ payPrice: '51.00' }).where(eq(storeOrder.id, 900));
    else if (v === 'still-ineligible') await db.update(storeOrder).set({ payPrice: '49.00' }).where(eq(storeOrder.id, 900));
    else if (v === 'metadata') await db.update(storeOrder).set({ mark: 'unchanged contribution' }).where(eq(storeOrder.id, 900));
    else await db.insert(storeOrder).values({ id: 902, orderId: 'unpaid-control', uid: 22, paid: 0, payPrice: '100.00' });
  };
  const assertCreated = async (v: Variant) => {
    const rows = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, 'paid_authority_order'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paid: 0, oneBrokerage: v !== 'still-ineligible' && (permitted(v) || v === 'threshold-up' || v === 'second-refund') ? '2.00' : '0.00',
      twoBrokerage: v === 'second-refund' ? '0.00' : '1.00' });
    expect(await f.db.select().from(userBrokerage)).toEqual([]);
  };
  for (const phase of ['between', 'late'] as const) it.each(variants)(`${phase} actual HTTP aggregate %s`, async v => {
    await prepare(v);
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    let edited: Awaited<ReturnType<typeof state>> | undefined;
    const editing = async () => { await edit(f.db, v); edited = await state(); };
    if (phase === 'between') await editing();
    else {
      const transaction = f.db.transaction.bind(f.db);
      vi.spyOn(f.db, 'transaction').mockImplementationOnce(async (fn, config) => { await editing(); return transaction(fn, config); });
    }
    const path = `/api/order/create/${receipt.data.orderKey}`;
    const result = await request(path, { ...input, quoteToken: receipt.data.quoteToken });
    if (phase === 'late' && !permitted(v)) {
      expect(result).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
      expect(await state()).toEqual(edited);
      const fresh = await request(`/api/order/computed/${receipt.data.orderKey}`, input);
      expect(fresh.status, fresh.msg).toBe(200);
      expect((await request(path, { ...input, quoteToken: fresh.data.quoteToken })).status).toBe(200);
    } else expect(result.status, result.msg).toBe(200);
    await assertCreated(v);
    const beforeReplay = await state(); f.cache.clear();
    expect((await request(path, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200);
    expect(await state()).toEqual(beforeReplay);
  });
  it.each(variants)('independent PostgreSQL aggregate %s', async v => {
    await prepare(v);
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(new StoreOrderCreateService(createContainerFromDb(buyer.db), f.env).createOrder({ ...input,
        uid: 11, key: receipt.data.orderKey, quoteToken: receipt.data.quoteToken, userIp: '127.0.0.1' }));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await edit(editor.db, v); const edited = await state();
      await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(permitted(v));
      if (result.ok) await assertCreated(v);
      else { expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired); expect(await state()).toEqual(edited); }
    });
  }, 15_000);
  it.each(['missing', 'disabled', 'function-drift'] as const)('refuses an unready write protocol: %s', async v => {
    if (v === 'missing') await f.exec('DROP TRIGGER brokerage_paid_insert_0150 ON store_order');
    if (v === 'disabled') await f.exec('ALTER TABLE store_order DISABLE TRIGGER brokerage_paid_update_0150');
    if (v === 'function-drift') await f.exec("CREATE OR REPLACE FUNCTION brokerage_paid_order_fence_0150() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS 'BEGIN RETURN NULL; END'");
    const receipt = await request('/api/order/confirm', input); expect(receipt.status).toBe(200);
    const before = await state();
    const result = await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: receipt.data.quoteToken });
    expect(result.status).toBe(400); expect(await state()).toEqual(before);
  });
  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }) =>
    new StoreOrderCreateService(createContainerFromDb(db), f.env).createOrder({ ...input, uid: 11,
      key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1' });
  for (const commit of [true, false]) it.each([900, 901])(`holds aggregate writer until checkout ${commit ? 'commit' : 'rollback'} (%s)`, async id => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731645,73)');
      const marker = new Error('explicit outer rollback');
      const buying = outcome(withTx(createContainerFromDb(buyer.db), async tx => {
        const result = await create(tx, receipt.data);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731645,73)`);
        if (!commit) throw marker;
        return result;
      }));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      const editing = outcome(editor.db.update(storeOrder).set({ refundStatus: 1 }).where(eq(storeOrder.id, id)));
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
      await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(commit);
      if (!result.ok) expect(result.error).toBe(marker);
      expect((await editing).ok).toBe(true);
    });
    if (commit) await assertCreated('metadata');
    else {
      const after = await state();
      expect(after).toEqual({ ...before, orders: before.orders.map(row => row.id === id ? { ...row, refundStatus: 1 } : row) });
    }
  }, 15_000);
  it.each([900, 901])('rejects an uncommitted contribution writer without reverse row waits (%s)', async id => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await holder.exec('BEGIN');
      await holder.db.update(storeOrder).set({ refundStatus: 1 }).where(eq(storeOrder.id, id));
      const result = await outcome(create(buyer.db, receipt.data));
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect(await state()).toEqual(before); await holder.exec('ROLLBACK');
    });
  }, 15_000);
  it('breaks a paid-order writer to checkout inventory reverse wait', async () => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await editor.exec('BEGIN'); await edit(editor.db, 'refund');
      const editing = outcome(editor.db.update(storeProductAttrValue).set({ stock: 9 }).where(eq(storeProductAttrValue.id, 1)));
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid); await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect((await editing).ok).toBe(true); await editor.exec('COMMIT');
    });
    expect(await state()).toEqual({ ...before,
      orders: before.orders.map(row => row.id === 900 ? { ...row, refundStatus: 1 } : row),
      skus: before.skus.map(row => row.id === 1 ? { ...row, stock: 9 } : row) });
  }, 15_000);
  it.each(['mode-two', 'promoters', 'disabled', 'inactive'] as const)('does not require an unused aggregate protocol (%s)', async v => {
    await f.exec('DROP TRIGGER brokerage_paid_insert_0150 ON store_order');
    if (v === 'mode-two') f.config.store_brokerage_statu = '2';
    if (v === 'promoters') await f.db.update(user).set({ isPromoter: 1 });
    if (v === 'disabled') f.config.brokerage_func_status = '0';
    if (v === 'inactive') await f.db.update(user).set({ spreadOpen: 0 });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status).toBe(200);
    const result = await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: receipt.data.quoteToken });
    expect(result.status, result.msg).toBe(200);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, 'paid_authority_order'));
    expect(order).toMatchObject({ paid: 0, oneBrokerage: v === 'disabled' || v === 'inactive' ? '0.00' : '2.00' });
  });
  it.each(['replica', 'repeatable-read', 'rls', 'function-path', 'wrong-event', 'always-trigger', 'column-type', 'uid-key'] as const)('fails closed on protocol environment drift (%s)', async v => {
    if (v === 'rls') await f.exec('ALTER TABLE store_order ENABLE ROW LEVEL SECURITY');
    if (v === 'function-path') await f.exec('ALTER FUNCTION brokerage_paid_order_fence_0150() SET search_path TO public');
    if (v === 'always-trigger') await f.exec('ALTER TABLE store_order ENABLE ALWAYS TRIGGER brokerage_paid_insert_0150');
    if (v === 'column-type') await f.exec('ALTER TABLE store_order ALTER COLUMN pay_price TYPE numeric(14,2)');
    if (v === 'uid-key') await f.exec('ALTER TABLE "user" DROP CONSTRAINT user_pkey');
    if (v === 'wrong-event') await f.exec('DROP TRIGGER brokerage_paid_insert_0150 ON store_order; CREATE TRIGGER brokerage_paid_insert_0150 AFTER DELETE ON store_order REFERENCING OLD TABLE AS brokerage_new FOR EACH STATEMENT EXECUTE FUNCTION brokerage_paid_order_fence_0150()');
    const receipt = await request('/api/order/confirm', input); expect(receipt.status).toBe(200);
    const before = await state();
    if (v === 'replica' || v === 'repeatable-read') {
      const transaction = f.db.transaction.bind(f.db);
      vi.spyOn(f.db, 'transaction').mockImplementationOnce((fn, config) => transaction(async tx => {
        if (v === 'replica') await tx.execute(sql`SET LOCAL session_replication_role TO replica`);
        return fn(tx);
      }, v === 'repeatable-read' ? { ...config, isolationLevel: 'repeatable read' } : config));
    }
    const result = await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: receipt.data.quoteToken });
    expect(result.status).toBe(400); expect(await state()).toEqual(before);
  });
  it.each([false, true])('supports mode=3 self brokerage with existing integral user lock (%s)', async useIntegral => {
    f.config.is_self_brokerage = '1';
    if (useIntegral) await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '50' });
    await f.db.update(user).set({ status: 1, spreadOpen: 1, isPromoter: 0 }).where(eq(user.uid, 11));
    await f.db.insert(storeOrder).values({ id: 902, orderId: 'buyer-paid-fixture', uid: 11, paid: 1, payPrice: '60.00' });
    const receipt = await request('/api/order/confirm', { ...input, useIntegral }); expect(receipt.status).toBe(200);
    const result = await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, useIntegral, quoteToken: receipt.data.quoteToken });
    expect(result.status, result.msg).toBe(200);
    const [created] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, 'paid_authority_order'));
    expect(created).toMatchObject({ paid: 0, spreadUid: 11, spreadTwoUid: 22, oneBrokerage: '2.00', twoBrokerage: '1.00' });
    const [buyer] = await f.db.select().from(user).where(eq(user.uid, 11));
    expect(buyer.integral).toBe(useIntegral ? 50 : 100);
  });
  it('refuses a root-client call outside the owning transaction', async () => {
    await expect(assertCheckoutPaidOrderQualifications(f.db, [{ uid: 22, thresholdCents: 5000, eligible: true }]))
      .rejects.toThrow('必须位于建单事务内');
  });
  it('refuses a transaction without the existing order-write relation lock', async () => {
    await expect(withTx(f.container, async tx => {
      await tx.execute(sql`SELECT uid FROM "user" WHERE uid=22 FOR SHARE`);
      await assertCheckoutPaidOrderQualifications(tx, [{ uid: 22, thresholdCents: 5000, eligible: true }]);
    })).rejects.toThrow('保护尚未就绪');
  });
});
