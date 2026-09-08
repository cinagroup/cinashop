import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { withFinancePeers, waitForFinanceBlock, waitForFinanceClock, outcome } from './helpers/financePeers';
import { createContainerFromDb } from '../src/lib/di';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { storeBargain, storeBargainUser } from '../src/models/schema';

// Requires the existing guarded loopback finance_test PG16 service; never production.
// Exact backend blocking observations, not Promise.all or elapsed sleeps, are the barriers.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain independent PostgreSQL helper admission', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => {
    f = await createBargainSelectionFixture();
    await f.db.update(storeBargain).set({ people: 1, bargainNum: 1 });
    for (const id of [80,81]) await f.db.update(storeBargainUser).set({ price: '0.00', status: 1 }).where(eq(storeBargainUser.id, id));
    await f.db.insert(storeBargainUser).values({ id: 84, uid: 22, bargainId: 40, bargainPrice: '10.00', bargainPriceMin: '2.00', price: '0.00', status: 1 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });

  it.each([1,2])('one helper across two records serializes and observes the committed count at limit %s', async limit => {
    await f.db.update(storeBargain).set({ bargainNum: limit });
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await second.exec("SET default_transaction_isolation='repeatable read'");
      await blocker.exec('BEGIN; SELECT id FROM store_bargain_user WHERE id=81 FOR UPDATE');
      const a = outcome(new ActivityJoinService(createContainerFromDb(first.db)).helpBargain(11,81));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(new ActivityJoinService(createContainerFromDb(second.db)).helpBargain(11,84));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec('COMMIT');
      expect(await a).toEqual({ ok:true, value:{ price:'8.00' } });
      if (limit === 1) expect(await b).toMatchObject({ ok:false, error:{ message:'您不能再帮砍此件商品' } });
      else expect(await b).toEqual({ ok:true, value:{ price:'8.00' } });
    });
    const after = await f.snapshot(); expect(after.helps).toHaveLength(limit);
    expect(after.helps.every(row => row.uid === 11 && row.bargainId === 40 && row.type === 0)).toBe(true);
    if (limit === 1) expect(after.participations.find(row=>row.id===84)).toEqual(before.participations.find(row=>row.id===84));
    expect(after.orders).toEqual([]); expect(after.carts).toEqual([]);
  }, 15_000);

  it('different helpers on the same record still serialize and cannot both consume its last cut', async () => {
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT id FROM store_bargain_user WHERE id=81 FOR UPDATE');
      const a = outcome(new ActivityJoinService(createContainerFromDb(first.db)).helpBargain(11,81));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(new ActivityJoinService(createContainerFromDb(second.db)).helpBargain(22,81));
      await waitForFinanceBlock(f.db, second.pid, first.pid); await blocker.exec('COMMIT');
      expect(await a).toEqual({ ok:true, value:{ price:'8.00' } });
      expect(await b).toMatchObject({ ok:false, error:{ message:'砍价已结束' } });
    });
    expect((await f.snapshot()).helps).toHaveLength(1);
  }, 15_000);

  it('a blocked helper does not serialize a different helper on a different participation', async () => {
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT id FROM store_bargain_user WHERE id=81 FOR UPDATE');
      const pending = outcome(new ActivityJoinService(createContainerFromDb(first.db)).helpBargain(11,81));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      expect(await new ActivityJoinService(createContainerFromDb(second.db)).helpBargain(22,80)).toEqual({ price:'8.00' });
      // It completed while the other backend remains blocked, not merely after releasing it.
      await waitForFinanceBlock(f.db, first.pid, blocker.pid); await blocker.exec('COMMIT');
      expect(await pending).toEqual({ ok:true, value:{ price:'8.00' } });
    });
    expect((await f.snapshot()).helps).toHaveLength(2);
  }, 15_000);

  it('retains a stricter lock timeout, releases locks on rollback and permits a later explicit retry', async () => {
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([blocker, helper]) => {
      await helper.exec("SET lock_timeout='500ms'");
      const settings = await helper.exec("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS deadline");
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731628,11)');
      const pending = outcome(new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(11,81));
      await waitForFinanceBlock(f.db, helper.pid, blocker.pid); const result = await pending;
      expect(result.ok).toBe(false); if (result.ok) throw new Error('Expected lock timeout');
      let cause: unknown = result.error;
      while (cause && typeof cause === 'object' && 'cause' in cause && cause.cause) cause = cause.cause;
      expect(cause).toMatchObject({ code:'55P03' }); expect(await f.snapshot()).toEqual(before);
      expect(await helper.exec("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS deadline")).toEqual(settings);
      await blocker.exec('COMMIT');
      expect(await new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(11,81)).toEqual({ price:'8.00' });
    });
  }, 15_000);

  it('rejects activity expiry after an observed helper-admission lock wait without writing help', async () => {
    await withFinancePeers(f.db, async ([blocker, helper]) => {
      const stop = Date.now()+1000; await f.db.update(storeBargain).set({ stopTime:new Date(stop) });
      const before = await f.snapshot(); await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731628,11)');
      const pending = outcome(new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(11,81));
      await waitForFinanceBlock(f.db, helper.pid, blocker.pid); await waitForFinanceClock(f.db, stop);
      await blocker.exec('COMMIT');
      expect(await pending).toMatchObject({ ok:false, error:{ message:'砍价活动已结束' } }); expect(await f.snapshot()).toEqual(before);
    });
  }, 15_000);
});
