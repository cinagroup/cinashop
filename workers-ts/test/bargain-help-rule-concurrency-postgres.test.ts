import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeBargain, storeBargainUser, storeBargainUserHelp, user } from '../src/models/schema';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

// Runs only against the fixture-owned loopback PG16 database. Each service call
// uses a separate backend; pg_blocking_pids proves which transaction is waiting.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain people edits and live help on independent PostgreSQL backends', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;

  beforeEach(async () => {
    f = await createBargainSelectionFixture();
    await f.db.update(storeBargain).set({ people: 3, bargainNum: 1 }).where(eq(storeBargain.id, 40));
    await f.db.update(storeBargainUser).set({ price: '1.00', status: 1 }).where(eq(storeBargainUser.id, 81));
    await f.db.insert(user).values([
      { uid: 30, account: 'prior-helper-30', nickname: '先前帮助者 30' },
      { uid: 31, account: 'prior-helper-31', nickname: '先前帮助者 31' },
    ]);
    await f.db.insert(storeBargainUserHelp).values([
      { uid: 30, bargainId: 40, bargainUserId: 81, price: '0.50', type: 0 },
      { uid: 31, bargainId: 40, bargainUserId: 81, price: '0.50', type: 0 },
    ]);
  }, 30_000);

  afterEach(async () => { await f?.close(); });

  const state = async () => {
    const [activity] = await f.db.select({ people: storeBargain.people }).from(storeBargain)
      .where(eq(storeBargain.id, 40));
    const [count] = await f.db.select({ helps: sql<number>`count(*)::int` }).from(storeBargainUserHelp)
      .where(eq(storeBargainUserHelp.bargainUserId, 81));
    return { people: activity.people, helps: count.helps };
  };

  it('does not strand an unfinished participation by lowering people to its current help count', async () => {
    const before = await state();
    await expect(saveBargain(f.container, { id: 40, people: 2 }))
      .rejects.toThrow('砍价人数调整会使未完成参与无法继续砍价');
    expect(await state()).toEqual(before);
    await expect(new ActivityJoinService(f.container).helpBargain(11, 81)).resolves.toMatchObject({ price: '7.00' });
    expect(await state()).toEqual({ people: 3, helps: 3 });
  });

  it('does not treat an overcut active record as purchase-ready at the new limit', async () => {
    await f.db.update(storeBargainUser).set({ price: '9.00' }).where(eq(storeBargainUser.id, 81));
    const before = await state();
    await expect(saveBargain(f.container, { id: 40, people: 2 }))
      .rejects.toThrow('砍价人数调整会使未完成参与无法继续砍价');
    expect(await state()).toEqual(before);
  });

  it('admin wins: a third helper waits for the committed smaller people limit and is rejected', async () => {
    // A full two-person cut is already purchase-ready; equal count is legal.
    await f.db.update(storeBargainUserHelp).set({ price: '4.00' })
      .where(eq(storeBargainUserHelp.bargainUserId, 81));
    await f.db.update(storeBargainUser).set({ price: '8.00' }).where(eq(storeBargainUser.id, 81));
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_people_admin_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731640,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_people_admin_wait AFTER UPDATE OF people ON store_bargain
      FOR EACH ROW EXECUTE FUNCTION qa_people_admin_wait()`));

    await withFinancePeers(f.db, async ([gate, admin, helper]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731640,40)');
      const editing = outcome(saveBargain(createContainerFromDb(admin.db), { id: 40, people: 2 }));
      await waitForFinanceBlock(f.db, admin.pid, gate.pid);

      const helping = outcome(new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(11, 81));
      await waitForFinanceBlock(f.db, helper.pid, admin.pid);

      await gate.exec('COMMIT');
      expect(await editing).toEqual({ ok: true, value: 40 });
      expect(await helping).toMatchObject({ ok: false, error: { message: '砍价帮助人数已满' } });
    });
    expect(await state()).toEqual({ people: 2, helps: 2 });
  }, 15_000);

  it('helper wins: a smaller people limit waits, then rejects the newly committed third help', async () => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_people_help_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731641,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_people_help_wait AFTER INSERT ON store_bargain_user_help
      FOR EACH ROW EXECUTE FUNCTION qa_people_help_wait()`));

    await withFinancePeers(f.db, async ([gate, helper, admin]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731641,40)');
      const helping = outcome(new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(11, 81));
      await waitForFinanceBlock(f.db, helper.pid, gate.pid);

      const editing = outcome(saveBargain(createContainerFromDb(admin.db), { id: 40, people: 2 }));
      await waitForFinanceBlock(f.db, admin.pid, helper.pid);

      await gate.exec('COMMIT');
      expect(await helping).toMatchObject({ ok: true });
      expect(await editing).toMatchObject({ ok: false, error: { message: '砍价人数不能少于已帮助人数' } });
    });
    expect(await state()).toEqual({ people: 3, helps: 3 });
  }, 15_000);
});
