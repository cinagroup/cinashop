import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { helpBargain } from '../src/controllers/api/v1/ActivityJoinController';
import { storeBargain, storeBargainUser } from '../src/models/schema';

describe('bargain helper admission on isolated SQL (not multi-connection proof)', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => {
    f = await createBargainSelectionFixture(); f.app.post('/api/bargain/help', helpBargain);
    await f.db.update(storeBargain).set({ people: 1, bargainNum: 1 });
    await f.db.update(storeBargainUser).set({ status: 1, price: '0.00' }).where(eq(storeBargainUser.id, 80));
    await f.db.update(storeBargainUser).set({ price: '0.00' }).where(eq(storeBargainUser.id, 81));
    await f.db.insert(storeBargainUser).values({ id: 84, uid: 22, bargainId: 40,
      bargainPrice: '10.00', bargainPriceMin: '2.00', price: '0.00', status: 1 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const help = (uid = 11, participant = 81) => new ActivityJoinService(f.container).helpBargain(uid, participant);

  it('actual HTTP help enforces one friend allowance across different records but does not charge self help', async () => {
    const before = await f.snapshot();
    const response = await f.app.request('/api/bargain/help', { method: 'POST',
      headers: { 'x-fixture-user': '11', 'Content-Type': 'application/json' }, body: JSON.stringify({ bargain_user_id: 81 }) }, f.env);
    expect(await response.json()).toMatchObject({ status: 200, data: { price: '8.00' } });
    await expect(help(11, 84)).rejects.toThrow('您不能再帮砍此件商品');
    expect(await help(11, 80)).toEqual({ price: '8.00' });
    const after = await f.snapshot();
    expect(after.helps.map(row => ({ uid: row.uid, record: row.bargainUserId, type: row.type, price: row.price })))
      .toEqual([{ uid: 11, record: 81, type: 0, price: '8.00' }, { uid: 11, record: 80, type: 1, price: '8.00' }]);
    expect(after.participations.find(row => row.id === 84)).toEqual(before.participations.find(row => row.id === 84));
    expect({ ...after, helps: before.helps, participations: before.participations, sequences: before.sequences }).toEqual(before);
  });
  it('different activities retain separate allowances for the same helper', async () => {
    const [activity] = await f.db.select().from(storeBargain).where(eq(storeBargain.id, 40));
    await f.db.insert(storeBargain).values({ ...activity, id: 41 });
    await f.db.insert(storeBargainUser).values({ id: 85, uid: 22, bargainId: 41,
      bargainPrice: '10.00', bargainPriceMin: '2.00', price: '0.00', status: 1 });
    expect(await help(11, 81)).toEqual({ price: '8.00' }); expect(await help(11, 85)).toEqual({ price: '8.00' });
    expect((await f.snapshot()).helps.map(row => row.bargainId)).toEqual([40, 41]);
  });
  it('another helper has an independent allowance and repeats cannot double-cut', async () => {
    expect(await help(11, 81)).toEqual({ price: '8.00' });
    expect(await help(22, 80)).toEqual({ price: '8.00' }); const before = await f.snapshot();
    await expect(help(11, 81)).rejects.toThrow('砍价已结束'); expect(await f.snapshot()).toEqual(before);
  });
  it.each([0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER])('rejects invalid 32-bit IDs %s before any mutation', async value => {
    const before = await f.snapshot(); await expect(help(value, 81)).rejects.toThrow('用户ID错误');
    await expect(help(11, value)).rejects.toThrow('砍价记录ID错误'); expect(await f.snapshot()).toEqual(before);
  });
  it('holds both transaction-scoped namespaces at the actual help INSERT and releases them on commit', async () => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_help_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND classid=731628 AND objid=NEW.uid AND objsubid=2)
        OR NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND classid=731627 AND objid=NEW.bargain_user_id AND objsubid=2)
      THEN RAISE EXCEPTION 'missing transaction admission locks'; END IF;
      RETURN NEW; END $$`));
    await f.db.execute(sql.raw('CREATE TRIGGER qa_help_lock_guard BEFORE INSERT ON store_bargain_user_help FOR EACH ROW EXECUTE FUNCTION qa_help_lock_guard()'));
    expect(await help()).toEqual({ price: '8.00' });
    const [locks] = await f.db.select({ count: sql<number>`count(*)::int` }).from(sql`pg_locks`)
      .where(sql`locktype='advisory' AND pid=pg_backend_pid() AND classid IN (731627,731628)`);
    expect(locks.count).toBe(0);
  });
  it.each([false, true])('uses fresh READ COMMITTED and bounded local settings, preserving stricter caller settings=%s', async strict => {
    const expected = strict ? ['500ms','1500ms','1200ms'] : ['2s','5s','5s'];
    await f.db.execute(sql.raw(`SET default_transaction_isolation='repeatable read'`));
    await f.db.execute(sql.raw(`SET lock_timeout='${strict ? '500ms' : '0'}'`));
    await f.db.execute(sql.raw(`SET statement_timeout='${strict ? '1500ms' : '0'}'`));
    await f.db.execute(sql.raw(`SET idle_in_transaction_session_timeout='${strict ? '1200ms' : '0'}'`));
    const settings = () => f.db.execute(sql`SELECT current_setting('default_transaction_isolation') AS isolation,
      current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle`);
    const before = await settings();
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_help_setting_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' OR current_setting('lock_timeout') <> '${expected[0]}'
        OR current_setting('statement_timeout') <> '${expected[1]}' OR current_setting('idle_in_transaction_session_timeout') <> '${expected[2]}'
      THEN RAISE EXCEPTION 'unexpected help transaction settings'; END IF;
      RETURN NEW; END $$`));
    await f.db.execute(sql.raw('CREATE TRIGGER qa_help_setting_guard BEFORE INSERT ON store_bargain_user_help FOR EACH ROW EXECUTE FUNCTION qa_help_setting_guard()'));
    expect(await help()).toEqual({ price: '8.00' }); expect(await settings()).toEqual(before);
  });
  it('rolls back help and participation together after an actual participant write failure and can retry', async () => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_help_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic participant write failure'; END $$`));
    await f.db.execute(sql.raw('CREATE TRIGGER qa_help_failure BEFORE UPDATE ON store_bargain_user FOR EACH ROW EXECUTE FUNCTION qa_help_failure()'));
    const before = await f.snapshot(); await expect(help()).rejects.toThrow(); const after = await f.snapshot();
    // PostgreSQL sequence allocation is intentionally nontransactional.
    expect({ ...after, sequences: before.sequences }).toEqual(before);
    await f.db.execute(sql.raw('DROP TRIGGER qa_help_failure ON store_bargain_user'));
    expect(await help()).toEqual({ price: '8.00' }); expect((await f.snapshot()).helps).toHaveLength(1);
  });
});
