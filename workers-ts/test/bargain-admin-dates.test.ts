import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { storeBargain } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';

describe('admin bargain date contract', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => { f = await createBargainSelectionFixture(); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const snapshot = async () => ({ ...await f.snapshot(), sequences: undefined });
  const createBody = () => ({ productId: 70, storeName: '时间活动', price: '10.00', minPrice: '2.00', people: 2, stock:8, quota:8, sku:{baseUnique:'qared001'},
    startTime: f.startTime.toISOString(), stopTime: f.stopTime.toISOString() });
  it('persists exact UTC instants on creation and changes only a supplied endpoint on edit', async () => {
    const id = await saveBargain(f.container, createBody());
    const [created] = await f.db.select().from(storeBargain).where(eq(storeBargain.id, id));
    expect(created).toMatchObject({ startTime: f.startTime, stopTime: f.stopTime });
    const before = await snapshot(), stopTime = new Date(f.stopTime.getTime() + 3600000);
    await saveBargain(f.container, { id: 40, stopTime: stopTime.toISOString() });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => row.id === 40 ? { ...row, stopTime } : row) });
  });
  it.each([null, '', 1780000000, '2026-02-30T00:00:00.000Z', '2026-01-01', '2026-01-01T00:00:00', '2026-01-01T08:00:00.000+08:00'])('rejects malformed or timezone-ambiguous endpoint %s', async startTime => {
    const before = await snapshot();
    await expect(saveBargain(f.container, { id: 40, startTime })).rejects.toThrow('时间');
    expect(await snapshot()).toEqual(before);
  });
  it.each(['missing', 'equal', 'reversed', 'past'])('rejects %s creation window before allocating an activity', async mode => {
    const body: Record<string, unknown> = createBody();
    if(mode === 'missing') delete body.startTime;
    if(mode === 'equal') body.startTime = body.stopTime;
    if(mode === 'reversed') body.startTime = new Date(f.stopTime.getTime()+1000).toISOString();
    if(mode === 'past') { body.startTime = '2000-01-01T00:00:00.000Z'; body.stopTime = '2001-01-01T00:00:00.000Z'; }
    const before = await snapshot(); await expect(saveBargain(f.container, body)).rejects.toThrow('时间');
    expect(await snapshot()).toEqual(before);
  });
  it('cannot resurrect an expired activity by supplying a new future deadline', async () => {
    await f.db.update(storeBargain).set({ startTime: new Date('2000-01-01Z'), stopTime: new Date('2001-01-01Z') });
    const before = await snapshot();
    await expect(saveBargain(f.container, { id: 40, startTime: f.startTime.toISOString(), stopTime: f.stopTime.toISOString() })).rejects.toThrow('活动已结束');
    expect(await snapshot()).toEqual(before);
  });
  it('requires explicit configuration for an old unconfigured activity without silently filling dates', async () => {
    await f.db.update(storeBargain).set({ startTime: null, stopTime: null });
    const before = await snapshot();
    await expect(saveBargain(f.container, { id: 40, storeName: '无日期' })).rejects.toThrow('时间');
    expect(await snapshot()).toEqual(before);
    await saveBargain(f.container, { id: 40, startTime: f.startTime.toISOString(), stopTime: f.stopTime.toISOString() });
    expect((await snapshot()).bargains[0]).toMatchObject({ startTime: f.startTime, stopTime: f.stopTime });
  });
  it.each([-7200000, 7200000])('uses PG admission rather than application clock skew %s', async skew => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now+skew);
    await expect(saveBargain(f.container, { id: 40, storeName: '数据库仍开放' })).resolves.toBe(40);
    await f.db.update(storeBargain).set({ stopTime: new Date('2001-01-01Z') });
    await expect(saveBargain(f.container, { id: 40, storeName: '已过期' })).rejects.toThrow('活动已结束');
  });
  it.each(['create', 'edit'])('rolls back %s when an actual after-write trigger crosses its deadline', async mode => {
    await f.exec(`CREATE FUNCTION qa_expire_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE store_bargain SET stop_time=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=NEW.id;
      RETURN NEW; END $$;
      CREATE TRIGGER qa_expire_save AFTER ${mode === 'create' ? 'INSERT' : 'UPDATE OF store_name'} ON store_bargain
      FOR EACH ROW EXECUTE FUNCTION qa_expire_save()`);
    const before = await snapshot();
    await expect(saveBargain(f.container, mode === 'create' ? createBody() : { id: 40, storeName: '跨截止' })).rejects.toThrow('时间');
    expect(await snapshot()).toEqual(before);
  });
});
