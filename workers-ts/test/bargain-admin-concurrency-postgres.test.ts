import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { saveBargain, setBargainStatus } from '../src/services/activity/BargainAdminService';
import { retireBargain } from '../src/services/activity/BargainRetirementService';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { StoreOrderCreateService, cancelStoreOrder } from '../src/services/order/StoreOrderCreateService';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { storeCart, systemStore, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain admin writes on independent PG16 backends', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.insert(storeCart).values({ id: 10, uid: 11, productId: 70, productAttrUnique: 'qared001',
      cartNum: 1, type: 2, activityId: 40, bargainUserId: 80, isNew: 1, status: 1 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const create = (container: Container = f.container) => StoreOrderCreateService.createWithRuntime(container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'isolated_admin_edit' },
    { uid: 11, key: 'isolated_admin_edit', cartIds: [10], type: 2, bargainUserId: 80,
      shippingType: 2, storeId: 1, realName: '隔离编辑', userPhone: '00000000000', userIp: '127.0.0.1' });
  const snapshot = async () => ({ ...await f.snapshot(), sequences: undefined });
  const rejected = async (work: ReturnType<typeof outcome>, message: string) => {
    const result = await work; expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  };

  it.each(['rename', 'inventory'])('rechecks the current row after actual checkout before %s', async mode => {
    await withFinancePeers(f.db, async ([blocker, buyer, admin]) => {
      await blocker.exec('BEGIN; SELECT id FROM store_cart WHERE id=10 FOR UPDATE');
      const buying = outcome(create(createContainerFromDb(buyer.db)));
      await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      const editing = outcome(saveBargain(createContainerFromDb(admin.db), { id: 40, ...(mode === 'rename'
        ? { storeName: '并发改名' } : { stock: 10, expected: { stock: 8, quota: 8 } }) }));
      await waitForFinanceBlock(f.db, admin.pid, buyer.pid);
      await blocker.exec('COMMIT');
      expect(await buying).toMatchObject({ ok: true });
      if (mode === 'rename') expect(await editing).toMatchObject({ ok: true, value: 40 });
      else await rejected(editing, '库存或额度已变化');
    });
    const state = await snapshot();
    expect(state.orders).toHaveLength(1);
    expect(state.bargains[0]).toMatchObject({ stock: 7, quota: 7, sales: 1, ...(mode === 'rename' ? { storeName: '并发改名' } : {}) });
    await cancelStoreOrder(f.container, { uid: 11, orderId: 'isolated_admin_edit' });
    expect((await snapshot()).bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
  }, 15_000);

  it('checkout waiting behind an actual status change rejects and rolls back', async () => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_admin_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731630,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_admin_wait AFTER UPDATE OF status ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_admin_wait()`));
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, buyer, admin]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731630,40)');
      const editing = outcome(setBargainStatus(createContainerFromDb(admin.db), { id: 40, status: 0 }));
      await waitForFinanceBlock(f.db, admin.pid, blocker.pid);
      const buying = outcome(create(createContainerFromDb(buyer.db)));
      await waitForFinanceBlock(f.db, buyer.pid, admin.pid);
      await blocker.exec('COMMIT');
      expect(await editing).toMatchObject({ ok: true });
      await rejected(buying, '砍价活动');
    });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, status: 0 })) });
  }, 15_000);

  it.each(['save', 'status'])('rejects %s after waiting behind actual retirement', async mode => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_admin_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731630,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_admin_wait AFTER UPDATE OF is_del ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_admin_wait()`));
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, retiring, admin]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731630,40)');
      const deleting = outcome(retireBargain(createContainerFromDb(retiring.db), '40'));
      await waitForFinanceBlock(f.db, retiring.pid, blocker.pid);
      const container = createContainerFromDb(admin.db);
      const editing = outcome<number | void>(mode === 'save' ? saveBargain(container, { id: 40, storeName: '迟到编辑' })
        : setBargainStatus(container, { id: 40, status: 0 }));
      await waitForFinanceBlock(f.db, admin.pid, retiring.pid);
      await blocker.exec('COMMIT');
      expect(await deleting).toMatchObject({ ok: true }); await rejected(editing, '已删除');
    });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, isDel: 1 })) });
  }, 15_000);

  it('can disable while actual help holds KEY SHARE and the late help rolls back', async () => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_admin_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731630,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_admin_wait AFTER INSERT ON store_bargain_user_help FOR EACH ROW EXECUTE FUNCTION qa_admin_wait()`));
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, helper, admin]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731630,40)');
      const helping = outcome(new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(11, 81));
      await waitForFinanceBlock(f.db, helper.pid, blocker.pid);
      await setBargainStatus(createContainerFromDb(admin.db), { id: 40, status: 0 });
      await blocker.exec('COMMIT'); await rejected(helping, '砍价活动');
    });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, status: 0 })) });
  }, 15_000);

  it('rechecks inventory after an actual cancellation restores it', async () => {
    await create();
    await withFinancePeers(f.db, async ([blocker, cancelling, admin]) => {
      await blocker.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=3 FOR UPDATE');
      const cancellation = outcome(cancelStoreOrder(createContainerFromDb(cancelling.db), { uid: 11, orderId: 'isolated_admin_edit' }));
      await waitForFinanceBlock(f.db, cancelling.pid, blocker.pid);
      const editing = outcome(saveBargain(createContainerFromDb(admin.db), { id: 40, stock: 10, expected: { stock: 7, quota: 7 } }));
      await waitForFinanceBlock(f.db, admin.pid, cancelling.pid);
      await blocker.exec('COMMIT');
      expect(await cancellation).toMatchObject({ ok: true }); await rejected(editing, '库存或额度已变化');
    });
    expect((await snapshot()).bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
  }, 15_000);

  it.each(['save', 'status'])('preserves strict deadlines through %s lock failure and successful retry', async mode => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_edit_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' OR current_setting('lock_timeout') <> '500ms'
        OR current_setting('statement_timeout') <> '1500ms' OR current_setting('idle_in_transaction_session_timeout') <> '1200ms'
      THEN RAISE EXCEPTION 'unexpected edit transaction settings'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_edit_settings BEFORE UPDATE ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_edit_settings()`));
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, , admin]) => {
      await admin.exec("SET lock_timeout='500ms'; SET statement_timeout='1500ms'; SET idle_in_transaction_session_timeout='1200ms'; SET default_transaction_isolation='repeatable read'");
      const settings = () => admin.exec("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('default_transaction_isolation') AS isolation");
      const original = await settings(), container = createContainerFromDb(admin.db);
      const write = () => mode === 'save' ? saveBargain(container, { id: 40, storeName: '重试' }) : setBargainStatus(container, { id: 40, status: 0 });
      await blocker.exec('BEGIN; SELECT id FROM store_bargain WHERE id=40 FOR NO KEY UPDATE');
      const editing = outcome<number | void>(write()); await waitForFinanceBlock(f.db, admin.pid, blocker.pid);
      const result = await editing; expect(result.ok).toBe(false);
      if (!result.ok) { let cause = result.error; while (cause.cause) cause = cause.cause; expect(cause).toMatchObject({ code: '55P03' }); }
      expect(await settings()).toEqual(original); expect(await snapshot()).toEqual(before);
      await blocker.exec('COMMIT'); await write(); expect(await settings()).toEqual(original);
    });
  }, 15_000);
});
