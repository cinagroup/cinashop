import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeBargain, storeBargainUser, storeProduct, user } from '../src/models/schema';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { retirePlatformSourceProduct } from '../src/services/activity/BargainSourceProductLifecycle';
import { SupplierProductManagementService } from '../src/services/supplier/SupplierProductManagementService';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

// Only the fixture-owned loopback PostgreSQL 16 database is eligible. Independent
// backends and pg_blocking_pids prove the admission/retirement commit order.
// This suite does not prove checkout's final product guard or the existing
// supplier product->cart versus checkout cart->product lock order.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain source retirement admission on PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;

  beforeEach(async () => {
    f = await createBargainSelectionFixture();
    await f.db.insert(user).values({ uid: 30, account: 'new-owner-30', nickname: '新参与者30' });
    await f.db.insert(storeBargain).values({ id: 41, productId: 70, title: '同源第二活动',
      price: '10.00', minPrice: '2.00', people: 2, stock: 8, quota: 8,
      startTime: f.startTime, stopTime: f.stopTime });
    await f.db.insert(storeBargainUser).values({ id: 84, uid: 22, bargainId: 41,
      bargainPrice: '10.00', bargainPriceMin: '2.00', price: '0.00', status: 1 });
  }, 30_000);

  afterEach(async () => { await f?.close(); });

  const state = async () => {
    const snapshot = await f.snapshot();
    return { participations: snapshot.participations, helps: snapshot.helps,
      products: snapshot.products, bargains: snapshot.bargains };
  };

  it.each(['platform', 'supplier'] as const)('%s retirement blocks new starts and help on both activities while retaining history', async surface => {
    if (surface === 'supplier') {
      await f.db.update(storeProduct).set({ type: 2, relationId: 7 }).where(eq(storeProduct.id, 70));
      await new SupplierProductManagementService(f.container).recycleProduct(7, 70);
    } else {
      await retirePlatformSourceProduct(f.container, 70);
    }
    const before = await state();
    const service = new ActivityJoinService(f.container);
    for (const activityId of [40, 41]) {
      await expect(service.startBargain(30, activityId)).rejects.toThrow('关联商品');
    }
    for (const participantId of [81, 84]) {
      await expect(service.helpBargain(11, participantId)).rejects.toThrow('关联商品');
    }
    expect(await state()).toEqual(before);
    expect(before.products.find(product => product.id === 70)?.isDel).toBe(1);
    expect(before.participations.some(participant => participant.id === 81)).toBe(true);
  }, 15_000);

  it('retirement commits first: a new start waits and rejects the retired source', async () => {
    await f.exec(`CREATE FUNCTION qa_source_retire_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_source_retire_wait AFTER UPDATE OF is_del ON store_product
      FOR EACH ROW EXECUTE FUNCTION qa_source_retire_wait()`);
    await withFinancePeers(f.db, async ([gate, retiring, starting]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const retirement = outcome(retirePlatformSourceProduct(createContainerFromDb(retiring.db), 70));
      await waitForFinanceBlock(f.db, retiring.pid, gate.pid);
      const start = outcome(new ActivityJoinService(createContainerFromDb(starting.db)).startBargain(30, 41));
      await waitForFinanceBlock(f.db, starting.pid, retiring.pid);
      await gate.exec('COMMIT');
      expect(await retirement).toMatchObject({ ok: true });
      expect(await start).toMatchObject({ ok: false, error: { message: '砍价关联商品不存在或已删除' } });
    });
    expect((await state()).participations.some(participant => participant.uid === 30)).toBe(false);
  }, 15_000);

  it('help commits first on another activity: supplier retirement waits and leaves its history intact', async () => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 7 }).where(eq(storeProduct.id, 70));
    await f.exec(`CREATE FUNCTION qa_source_help_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.bargain_user_id=84 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_source_help_wait AFTER INSERT ON store_bargain_user_help
      FOR EACH ROW EXECUTE FUNCTION qa_source_help_wait()`);
    await withFinancePeers(f.db, async ([gate, helping, retiring]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const help = outcome(new ActivityJoinService(createContainerFromDb(helping.db)).helpBargain(11, 84));
      await waitForFinanceBlock(f.db, helping.pid, gate.pid);
      const retirement = outcome(new SupplierProductManagementService(createContainerFromDb(retiring.db)).recycleProduct(7, 70));
      await waitForFinanceBlock(f.db, retiring.pid, helping.pid);
      await gate.exec('COMMIT');
      expect(await help).toMatchObject({ ok: true });
      expect(await retirement).toMatchObject({ ok: true });
    });
    const after = await state();
    expect(after.helps.filter(help => help.bargainUserId === 84)).toHaveLength(1);
    expect(after.products.find(product => product.id === 70)?.isDel).toBe(1);
    await expect(new ActivityJoinService(f.container).helpBargain(11, 81)).rejects.toThrow('关联商品');
  }, 15_000);

  it('retirement preserves stricter timeouts, rolls back a busy attempt and allows an explicit retry', async () => {
    await withFinancePeers(f.db, async ([gate, retiring]) => {
      await retiring.exec("SET lock_timeout='500ms'; SET statement_timeout='1500ms'; SET idle_in_transaction_session_timeout='1200ms'");
      const settings = () => retiring.exec("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle");
      const original = await settings();
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock_shared(731634,70)');
      const retirement = outcome(retirePlatformSourceProduct(createContainerFromDb(retiring.db), 70));
      await waitForFinanceBlock(f.db, retiring.pid, gate.pid);
      const failed = await retirement;
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        let cause: unknown = failed.error;
        while (cause && typeof cause === 'object' && 'cause' in cause && cause.cause) cause = cause.cause;
        expect(cause).toMatchObject({ code: '55P03' });
      }
      expect((await state()).products.find(product => product.id === 70)?.isDel).toBe(0);
      expect(await settings()).toEqual(original);
      await gate.exec('COMMIT');
      await expect(retirePlatformSourceProduct(createContainerFromDb(retiring.db), 70)).resolves.toBeUndefined();
      expect(await settings()).toEqual(original);
    });
    expect((await state()).products.find(product => product.id === 70)?.isDel).toBe(1);
  }, 15_000);
});
