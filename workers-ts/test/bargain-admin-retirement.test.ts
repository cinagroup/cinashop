import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { adminActivityDel, adminBargainList } from '../src/controllers/api/v1/AdminCrudController';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { retireBargain } from '../src/services/activity/BargainRetirementService';
import { StoreOrderCreateService, cancelStoreOrder } from '../src/services/order/StoreOrderCreateService';
import { finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { storeCart, storeBargain, systemStore, storeOrderCartInfo, storeOrderStatus,
  printDocument, storeOrder, storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage } from '../src/models/schema';

// Actual HTTP controller and business SQL, with a trusted fixture container.
// This is not authentication/provider/production acceptance. Peers require PG16.
describe('admin bargain retirement preserves transaction history', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeOrderCartInfo, storeOrderStatus, printDocument,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage]);
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.insert(storeCart).values({ id: 10, uid: 11, productId: 70,
      productAttrUnique: 'qared001', cartNum: 1, type: 2, activityId: 40, isNew: 1, status: 1 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const app = (container = f.container) => {
    const http = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    http.use('*', async (c, next) => { c.set('container', container); await next(); });
    http.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    http.delete('/activity/del/:type/:id', adminActivityDel);
    http.get('/activity/bargain', adminBargainList);
    return http;
  };
  const retire = async (container = f.container, id = '40') =>
    (await app(container).request(`/activity/del/bargain/${id}`, { method: 'DELETE' }, f.env)).json();
  const create = (container: Container = f.container) => StoreOrderCreateService.createWithRuntime(container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'isolated_retired_bargain' },
    { uid: 11, key: 'retired_bargain', cartIds: [10], type: 2, bargainUserId: 80,
      shippingType: 2, storeId: 1, realName: '隔离删除', userPhone: '00000000000', userIp: '127.0.0.1' });
  const snapshot = async () => ({ ...await f.snapshot(), sequences: undefined,
    details: await f.db.select().from(storeOrderCartInfo),
    statuses: await f.db.select().from(storeOrderStatus),
    refunds: await f.db.select().from(storeOrderRefund) });

  it('sets only the PHP deletion marker, preserves all history and permits an idempotent repeat', async () => {
    const before = await snapshot();
    expect(await retire()).toMatchObject({ status: 200 });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, isDel: 1 })) });
    const after = await snapshot();
    expect(await retire()).toMatchObject({ status: 200 });
    expect(await snapshot()).toEqual(after);
  });

  it('hides retired activity before applying the actual admin list limit', async () => {
    await f.db.update(storeBargain).set({ isDel: 1 });
    await f.db.insert(storeBargain).values(Array.from({ length: 101 }, (_, n) => ({ id: 100 + n, productId: 70 })));
    const response = await app().request('/activity/bargain', {}, f.env);
    const body = await response.json() as { status: number; data: Array<{ isDel: number; id: number }> };
    expect(body.status).toBe(200); expect(body.data).toHaveLength(100);
    expect(body.data.every((row: { isDel: number; id: number }) => row.isDel === 0 && row.id !== 40)).toBe(true);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it.each(['0', '-1', '1.5', '2147483648', 'nope', '4e1', '040'])('rejects malformed activity identity %s without any mutation', async id => {
    const before = await snapshot();
    expect(await retire(f.container, id)).toMatchObject({ status: 400, msg: '砍价活动ID错误' });
    expect(await snapshot()).toEqual(before);
  });

  it('does not report successful retirement for an absent activity', async () => {
    const before = await snapshot();
    expect(await retire(f.container, '999')).toMatchObject({ status: 400, msg: '砍价活动不存在' });
    expect(await snapshot()).toEqual(before);
  });

  it.each(['cancel', 'refund'])('retains exact activity/SKU compensation after retirement and %s', async action => {
    await create();
    if (action === 'refund') {
      const [order] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue' }).returning();
      await f.db.insert(storeOrderRefund).values({ id: 1, storeOrderId: order.id, uid: 11, orderId: 'isolated_retire_refund',
        applyType: 1, refundType: 0, refundPrice: '2.00', refundNum: 1,
        cartInfo: JSON.stringify({ cartIds: [{ cartId: 10, cartNum: 1 }] }) });
    }
    const before = await snapshot();
    expect(await retire()).toMatchObject({ status: 200 });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, isDel: 1 })) });
    if (action === 'cancel') await cancelStoreOrder(f.container, { uid: 11, orderId: 'isolated_retired_bargain' });
    else expect(await finalizeStoreOrderRefund(f.container, 1)).toBe('completed');
    const state = await snapshot();
    expect(state.bargains[0]).toMatchObject({ id: 40, isDel: 1, stock: 8, quota: 8, sales: 0 });
    expect(state.products[0]).toMatchObject({ stock: 8, sales: 0 });
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(action === 'cancel' ? 3 : 4);
    expect(state.details).toEqual(before.details.map(row => ({ ...row, refundNum: action === 'refund' ? 1 : row.refundNum })));
    if (action === 'refund') expect(state.users.find(row => row.uid === 11)?.nowMoney).toBe('2.00');
  });

  it('refuses new starts, help, catalog admission and orders after retirement', async () => {
    await retire(); const before = await snapshot();
    const service = new ActivityJoinService(f.container);
    await expect(service.startBargain(11, 40)).rejects.toThrow('不存在');
    await expect(service.helpBargain(11, 81)).rejects.toThrow();
    await expect(create()).rejects.toThrow('砍价活动');
    const response = await f.app.request('/api/bargain/detail/40?view=skus', { headers: { 'x-fixture-user': '11' } }, f.env);
    expect(await response.json()).toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('waits behind actual checkout without losing its committed activity history', async () => {
    await withFinancePeers(f.db, async ([blocker, buyer, admin]) => {
      await blocker.exec('BEGIN; SELECT id FROM store_cart WHERE id=10 FOR UPDATE');
      const buying = outcome(create(createContainerFromDb(buyer.db)));
      await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      const deleting = retire(createContainerFromDb(admin.db));
      await waitForFinanceBlock(f.db, admin.pid, buyer.pid);
      await blocker.exec('COMMIT');
      expect(await buying).toMatchObject({ ok: true }); expect(await deleting).toMatchObject({ status: 200 });
    });
    expect((await snapshot()).bargains[0]).toMatchObject({ id: 40, isDel: 1, stock: 7, quota: 7, sales: 1 });
    await cancelStoreOrder(f.container, { uid: 11, orderId: 'isolated_retired_bargain' });
    expect((await snapshot()).bargains[0]).toMatchObject({ id: 40, isDel: 1, stock: 8, quota: 8, sales: 0 });
  }, 15_000);

  it('rolls back an injected SQL failure after the deletion marker write', async () => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_retire_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated retirement failure'; END $$;
      CREATE TRIGGER qa_retire_fail AFTER UPDATE OF is_del ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_retire_fail()`));
    const before = await snapshot();
    expect(await retire()).toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rejects checkout waiting behind an actual retirement and rolls back the order', async () => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_retire_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731629,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_retire_wait AFTER UPDATE OF is_del ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_retire_wait()`));
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, buyer, admin]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731629,40)');
      const deleting = retire(createContainerFromDb(admin.db));
      await waitForFinanceBlock(f.db, admin.pid, blocker.pid);
      const buying = outcome(create(createContainerFromDb(buyer.db)));
      await waitForFinanceBlock(f.db, buyer.pid, admin.pid);
      await blocker.exec('COMMIT');
      expect(await deleting).toMatchObject({ status: 200 });
      const result = await buying;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('砍价活动');
    });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, isDel: 1 })) });
  }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('permits retirement beside actual help KEY SHARE and rolls back the late help', async () => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_help_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731629,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_help_wait AFTER INSERT ON store_bargain_user_help FOR EACH ROW EXECUTE FUNCTION qa_help_wait()`));
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, helper, admin]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731629,40)');
      const helping = outcome(new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(11, 81));
      await waitForFinanceBlock(f.db, helper.pid, blocker.pid);
      expect(await retire(createContainerFromDb(admin.db))).toMatchObject({ status: 200 });
      await blocker.exec('COMMIT');
      const result = await helping;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('砍价活动');
    });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, isDel: 1 })) });
  }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('honors a stricter lock timeout, restores settings and permits a later retry', async () => {
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, , admin]) => {
      await admin.exec("SET lock_timeout='500ms'; SET statement_timeout='1500ms'; SET idle_in_transaction_session_timeout='1200ms'");
      const settings = () => admin.exec("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle");
      const original = await settings();
      await blocker.exec('BEGIN; SELECT id FROM store_bargain WHERE id=40 FOR NO KEY UPDATE');
      const deleting = outcome(retireBargain(createContainerFromDb(admin.db), '40'));
      await waitForFinanceBlock(f.db, admin.pid, blocker.pid);
      const result = await deleting;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        let cause = result.error;
        while (cause.cause) cause = cause.cause;
        expect(cause).toMatchObject({ code: '55P03' });
      }
      expect(await settings()).toEqual(original);
      expect(await snapshot()).toEqual(before);
      await blocker.exec('COMMIT');
      expect(await retire(createContainerFromDb(admin.db))).toMatchObject({ status: 200 });
      expect(await settings()).toEqual(original);
    });
  }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each([false, true])('bounds all transaction settings without weakening stricter values=%s', async strict => {
    const expected = strict ? ['500ms', '1500ms', '1200ms'] : ['2s', '5s', '5s'];
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_retire_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('lock_timeout') <> '${expected[0]}' OR current_setting('statement_timeout') <> '${expected[1]}'
        OR current_setting('idle_in_transaction_session_timeout') <> '${expected[2]}'
      THEN RAISE EXCEPTION 'unexpected retirement settings'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_retire_settings BEFORE UPDATE OF is_del ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_retire_settings()`));
    await withFinancePeers(f.db, async ([, , admin]) => {
      await admin.exec(`SET lock_timeout='${strict ? '500ms' : '0'}'; SET statement_timeout='${strict ? '1500ms' : '0'}'; SET idle_in_transaction_session_timeout='${strict ? '1200ms' : '0'}'`);
      const settings = () => admin.exec("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle");
      const before = await settings();
      expect(await retire(createContainerFromDb(admin.db))).toMatchObject({ status: 200 });
      expect(await settings()).toEqual(before);
    });
  }, 15_000);
});
