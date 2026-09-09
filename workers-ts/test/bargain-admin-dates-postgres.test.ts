import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { storeBargain } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('admin bargain dates on independent PG16 backends', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => { f = await createBargainSelectionFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); });
  const snapshot = async () => ({ ...await f.snapshot(), sequences: undefined });
  const refuses = async (pending: ReturnType<typeof outcome>, message: string) => {
    const result = await pending; expect(result.ok).toBe(false);
    if(!result.ok) expect(result.error.message).toContain(message);
  };
  it.each(['before-write', 'after-write'])('does not extend an old deadline crossed during a verified %s wait', async phase => {
    if(phase === 'after-write') await f.exec(`CREATE FUNCTION qa_date_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(731631,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_date_wait AFTER UPDATE OF store_name ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_date_wait()`);
    await withFinancePeers(f.db, async ([blocker, editor]) => {
      const [deadline] = await f.db.update(storeBargain).set({ stopTime: sql`(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 second'` })
        .where(eq(storeBargain.id,40)).returning({ stop: storeBargain.stopTime });
      const before = await snapshot();
      await blocker.exec(phase === 'before-write' ? 'BEGIN; SELECT id FROM store_bargain WHERE id=40 FOR NO KEY UPDATE' : 'BEGIN; SELECT pg_advisory_xact_lock(731631,40)');
      const editing = outcome(saveBargain(createContainerFromDb(editor.db), { id: 40, storeName: '不能复活', stopTime: f.stopTime.toISOString() }));
      await waitForFinanceBlock(f.db, editor.pid, blocker.pid);
      await waitForFinanceClock(f.db, deadline.stop!.getTime());
      await blocker.exec('COMMIT');
      await refuses(editing, '活动已结束'); expect(await snapshot()).toEqual(before);
    });
  }, 15_000);
  it('rolls back an actual insert held past its new deadline', async () => {
    await f.exec(`CREATE FUNCTION qa_date_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(731631,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_date_wait AFTER INSERT ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_date_wait()`);
    const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, editor]) => {
      const [clock] = await f.db.select({ deadline: sql<number>`floor(extract(epoch from clock_timestamp())*1000)+1000` }).from(sql`(VALUES(1)) AS p(n)`);
      const deadline = Number(clock.deadline);
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731631,40)');
      const creating = outcome(saveBargain(createContainerFromDb(editor.db), { productId: 70, storeName:'跨截止新建',price:'10.00',minPrice:'2.00',
        startTime:f.startTime.toISOString(),stopTime:new Date(deadline).toISOString() }));
      await waitForFinanceBlock(f.db,editor.pid,blocker.pid); await waitForFinanceClock(f.db,deadline); await blocker.exec('COMMIT');
      await refuses(creating,'时间'); expect(await snapshot()).toEqual(before);
    });
  }, 15_000);
  it.each(['UTC','Asia/Shanghai','America/New_York'])('preserves UTC instants and admission in SQL timezone %s', async zone => {
    await withFinancePeers(f.db, async ([, editor]) => {
      await editor.exec(`SET TIME ZONE '${zone}'`);
      const stop = new Date(f.stopTime.getTime()+3600000);
      await saveBargain(createContainerFromDb(editor.db), { id:40, stopTime:stop.toISOString() });
      expect((await snapshot()).bargains[0]).toMatchObject({startTime:f.startTime,stopTime:stop});
    });
  }, 15_000);
  it('revalidates a partial endpoint against another committed date edit', async () => {
    await f.exec(`CREATE FUNCTION qa_date_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(731631,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_date_wait AFTER UPDATE OF start_time ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_date_wait()`);
    const start = new Date(Date.now()+1800000), stop = new Date(Date.now()+600000);
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731631,40)');
      const firstEdit = outcome(saveBargain(createContainerFromDb(first.db),{id:40,startTime:start.toISOString()}));
      await waitForFinanceBlock(f.db,first.pid,blocker.pid);
      const secondEdit = outcome(saveBargain(createContainerFromDb(second.db),{id:40,stopTime:stop.toISOString()}));
      await waitForFinanceBlock(f.db,second.pid,first.pid); await blocker.exec('COMMIT');
      expect(await firstEdit).toMatchObject({ok:true,value:40}); await refuses(secondEdit,'开始时间必须早于结束时间');
    });
    expect((await snapshot()).bargains[0]).toMatchObject({startTime:start,stopTime:f.stopTime});
  }, 15_000);
  it('postponing the start remains compatible with help KEY SHARE and rejects late help', async () => {
    await f.exec(`CREATE FUNCTION qa_date_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(731631,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_date_wait AFTER INSERT ON store_bargain_user_help FOR EACH ROW EXECUTE FUNCTION qa_date_wait()`);
    const before = await snapshot(), startTime = new Date(Date.now()+1800000);
    await withFinancePeers(f.db,async ([blocker,helper,editor]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731631,40)');
      const helping = outcome(new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(11,81));
      await waitForFinanceBlock(f.db,helper.pid,blocker.pid);
      await saveBargain(createContainerFromDb(editor.db),{id:40,startTime:startTime.toISOString()});
      await blocker.exec('COMMIT'); await refuses(helping,'砍价活动');
    });
    expect(await snapshot()).toEqual({...before,bargains:before.bargains.map(row=>({...row,startTime}))});
  }, 15_000);
});
