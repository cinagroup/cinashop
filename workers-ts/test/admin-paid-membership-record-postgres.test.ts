import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { memberShip, otherOrder, user } from '../src/models/schema';
import { AdminPaidMembershipService } from '../src/services/user/AdminPaidMembershipService';
import { financePostgres } from './helpers/financePostgres';

const shanghai = (time: string) => Math.floor(Date.parse(`${time}+08:00`) / 1000);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy paid membership record filters on owned PG16', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: AdminPaidMembershipService;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    fixture = await financePostgres([user, memberShip, otherOrder]);
    service = new AdminPaidMembershipService(createContainerFromDb(fixture.db));
    await fixture.db.insert(user).values({ uid: 7, nickname: '上海会员', phone: '13800000007' });
    await fixture.db.insert(memberShip).values([
      { id: 2, title: '年度会员', type: 'year' },
      { id: 3, title: '体验会员', type: 'free' },
    ]);
    await fixture.db.insert(otherOrder).values([
      { id: 1, uid: 7, type: 1, orderId: 'hy-1', memberType: '2', payType: 'weixin', paid: 1,
        addTime: shanghai('2026-09-28T09:15:00'), payTime: shanghai('2026-09-28T09:16:00') },
      { id: 2, uid: 7, type: 1, orderId: 'hy-2', memberType: '2', payType: 'weixin', paid: 1,
        addTime: shanghai('2026-09-28T10:30:59'), payTime: shanghai('2026-09-28T10:31:10') },
      { id: 3, uid: 7, type: 1, orderId: 'hy-3', memberType: '2', payType: 'weixin', paid: 1,
        addTime: shanghai('2026-09-28T10:31:00') },
      { id: 4, uid: 7, type: 2, orderId: 'hy-card', memberType: 'free', code: 'CARD-SECRET', paid: 1,
        addTime: shanghai('2026-09-28T10:00:00'), overdueTime: shanghai('2026-10-28T10:00:00') },
      { id: 5, uid: 7, type: 0, orderId: 'hy-free', memberType: 'free', code: '', paid: 1,
        addTime: shanghai('2026-09-28T10:00:00') },
      { id: 6, uid: 7, type: 1, orderId: 'hy-free-plan', memberType: '3', code: '', payType: 'weixin',
        isFree: 1, paid: 1, addTime: shanghai('2026-09-28T10:00:00') },
      { id: 7, uid: 7, type: 4, orderId: 'hy-gift', memberType: '2', payType: 'admin', paid: 1,
        addTime: shanghai('2026-09-28T10:00:00') },
      { id: 8, uid: 7, type: 2, orderId: 'hy-unpaid', memberType: 'free', code: 'UNPAID', paid: 0,
        addTime: shanghai('2026-09-28T10:00:00') },
      { id: 9, uid: 7, type: 3, orderId: 'other-domain', memberType: '2', paid: 1,
        addTime: shanghai('2026-09-28T10:00:00') },
    ]);
  }, 30_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await fixture?.close(); }
  }, 30_000);

  const ids = (result: Awaited<ReturnType<AdminPaidMembershipService['records']>>) => result.list.map(row => row.id);

  it('separates card activations from free activations by code while excluding unpaid and unrelated orders', async () => {
    const before = await fixture.db.select().from(otherOrder);
    expect(ids(await service.records({ member_type: 'card' }))).toEqual([4]);
    expect(ids(await service.records({ member_type: 'free' }))).toEqual([5]);
    expect(ids(await service.records({ member_type: '2' }))).toEqual([7, 3, 2, 1]);
    const card = (await service.records({ member_type: 'card' })).list[0];
    expect(card).toMatchObject({ type: 2, member_title: '卡密激活', overdue_time: shanghai('2026-10-28T10:00:00') });
    expect(JSON.stringify(card)).not.toContain('CARD-SECRET');
    expect(await fixture.db.select().from(otherOrder)).toEqual(before);
  });

  it('treats free as source types 0/2/4 or type 1 with is_free, regardless of pay_type text', async () => {
    expect(ids(await service.records({ pay_type: 'free' }))).toEqual([7, 6, 5, 4]);
    expect(ids(await service.records({ pay_type: 'weixin' }))).toEqual([6, 3, 2, 1]);
    expect(ids(await service.records({ member_type: 'card', pay_type: 'free' }))).toEqual([4]);
    expect(ids(await service.records({ member_type: '2', pay_type: 'free' }))).toEqual([7]);
  });

  it('filters purchase add_time, including both endpoint seconds and paginates the same filtered set', async () => {
    const window = { member_type: '2', pay_type: 'weixin',
      start_time: shanghai('2026-09-28T09:15:00'), end_time: shanghai('2026-09-28T10:30:59') };
    expect(ids(await service.records(window))).toEqual([2, 1]);
    expect((await service.records({ ...window, page: 1, limit: 1 })).count).toBe(2);
    expect(ids(await service.records({ ...window, page: 2, limit: 1 }))).toEqual([1]);
    expect(ids(await service.records({ ...window, end_time: shanghai('2026-09-28T10:30:58') }))).toEqual([1]);
    expect(ids(await service.records({ ...window, start_time: shanghai('2026-09-28T09:15:01') }))).toEqual([2]);
  });
});
