import { afterEach, beforeEach, expect, it } from 'vitest';
import { financePostgres } from './helpers/financePostgres';
import { createContainerFromDb } from '../src/lib/di';
import { user, userBrokerage, userExtract } from '../src/models/schema';
import { AdminCommissionReadService } from '../src/services/admin/AdminCommissionReadService';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';

let f: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminCommissionReadService(createContainerFromDb(f.db));
const at = (minute: number) => Math.floor(Date.UTC(2026, 8, 28, 2, minute) / 1000);

beforeEach(async () => {
  f = await financePostgres([user, userBrokerage, userExtract]);
  await f.db.insert(user).values([
    { uid: 11, nickname: 'Alice', phone: '13800000011', account: 'alice-account',
      nowMoney: '50.00', brokeragePrice: '100.00', spreadUid: 99, addTime: at(1) },
    { uid: 12, nickname: 'No ledger', brokeragePrice: '5.00', addTime: at(2) },
    { uid: 13, nickname: 'Deleted user', brokeragePrice: '20.00',
      deleteTime: new Date('2026-09-28T02:30:00Z') },
    { uid: 99, nickname: 'Promoter', brokeragePrice: '0.00' },
  ]);
  await f.db.insert(userBrokerage).values([
    { id: 101, uid: 11, type: 'one_brokerage', number: '40.00', pm: 1,
      status: 1, mark: 'Income', addTime: at(5) },
    { id: 102, uid: 11, type: 'refund', number: '10.00', pm: 0,
      status: 1, mark: 'Refund', addTime: at(6) },
    { id: 103, uid: 11, type: 'extract', number: '5.00', pm: 0,
      status: 0, mark: 'Transfer', addTime: at(7) },
    { id: 104, uid: 11, type: 'brokerage_user', number: '3.00', pm: 1,
      status: -1, mark: 'Historical invalid', addTime: at(8) },
    { id: 105, uid: 13, type: 'two_brokerage', number: '2.00', pm: 1,
      status: 1, addTime: at(9) },
  ]);
  await f.db.insert(userExtract).values([
    { id: 201, uid: 11, status: 0, extractPrice: '15.00', extractFee: '1.00' },
    { id: 202, uid: 11, status: 1, extractPrice: '20.00', extractFee: '2.00' },
    { id: 203, uid: 11, status: -1, extractPrice: '50.00', extractFee: '5.00' },
  ]);
}, 30_000);
afterEach(async () => { await f?.close(); });

it('maps both Admin routes to commission.view rather than distribution or bill', () => {
  for (const base of ['/adminapi', '/api/admin']) {
    expect(requiredAdminPermission('GET', `${base}/finance/commissions`)).toBe('commission.view');
    expect(requiredAdminPermission('GET', `${base}/finance/commissions/11`)).toBe('commission.view');
    expect(requiredAdminPermission('GET', `${base}/finance/commissions/11/records`)).toBe('commission.view');
    expect(requiredAdminPermission('GET', `${base}/brokerage/list`)).toBe('distribution.view');
  }
});

it('preserves the old left-join user cohort, current-balance range and full-period extract gross', async () => {
  const all = await service().list(new URLSearchParams());
  expect(all.count).toBe(4);
  expect(all.list.map(row => row.uid)).toEqual([13, 11, 99, 12]);
  expect(all.list.find(row => row.uid === 12)).toMatchObject({ time: 0,
    brokerage_price: '5.00', extract_price: '0.00', sum_number: '5.00' });
  expect(all.list.find(row => row.uid === 11)).toMatchObject({
    display_name: 'Alice|13800000011|11', now_money: '50.00',
    brokerage_price: '100.00', extract_price: '38.00', sum_number: '138.00', time: at(8),
  });
  expect(all.list.find(row => row.uid === 13)).toMatchObject({ user_deleted: true });
  const minute = await service().list(new URLSearchParams({
    start_time: '2026-09-28 10:05', end_time: '2026-09-28 10:05' }));
  expect(minute).toMatchObject({ count: 1,
    list: [{ uid: 11, time: at(5), extract_price: '38.00', sum_number: '138.00' }] });
  expect((await service().list(new URLSearchParams({ price_min: '120' }))).count).toBe(0);
  expect((await service().list(new URLSearchParams({ price_min: '100', price_max: '100.00' }))).list
    .map(row => row.uid)).toEqual([11]);
  for (const keyword of ['Alice', 'alice-account', '13800000011', '11']) {
    expect((await service().list(new URLSearchParams({ keyword }))).list.map(row => row.uid)).toContain(11);
  }
});

it('keeps the detail lifetime net distinct from the grid total, and reads all brokerage types/statuses', async () => {
  expect(await service().detail(11)).toMatchObject({ uid: 11, nickname: 'Alice',
    spread_name: 'Promoter', number: '33.00', now_money: '50.00',
    brokerage_price: '100.00', add_time: at(1) });
  const records = await service().records(11, new URLSearchParams());
  expect(records).toMatchObject({ count: 4, page: 1, limit: 20 });
  expect(records.list.map(row => row.id)).toEqual([104, 103, 102, 101]);
  expect(records.list[0]).toMatchObject({ type: 'brokerage_user', status: -1, pm: 1,
    number: '3.00', mark: 'Historical invalid' });
  expect(records.list[2]).toMatchObject({ pm: 0, number: '10.00', mark: 'Refund' });
  expect((await service().records(11, new URLSearchParams({
    start_time: '2026-09-28', end_time: '2026-09-28' }))).count).toBe(4);
  expect((await service().records(11, new URLSearchParams({
    start_time: '2026-09-28 10:06', end_time: '2026-09-28 10:06' }))).list)
    .toMatchObject([{ id: 102, number: '10.00' }]);
  await expect(service().detail(777)).rejects.toThrow('不存在');
  await expect(service().records(777, new URLSearchParams())).rejects.toThrow('不存在');
});

it('includes the last second of an ending minute and excludes the next Shanghai day', async () => {
  const endMinuteLastSecond = at(6) + 59;
  const nextShanghaiDay = Math.floor(Date.UTC(2026, 8, 28, 16, 0, 0) / 1000);
  await f.db.insert(userBrokerage).values([
    { id: 106, uid: 13, type: 'system_add', number: '1.00', pm: 1,
      status: 1, addTime: endMinuteLastSecond },
    { id: 107, uid: 11, type: 'next_day', number: '1.00', pm: 1,
      status: 1, addTime: nextShanghaiDay },
  ]);
  const sameMinute = await service().list(new URLSearchParams({
    start_time: '2026-09-28 10:05', end_time: '2026-09-28 10:05' }));
  expect(sameMinute.list).toMatchObject([{ uid: 11, time: at(5) }]);
  const throughNextMinute = await service().list(new URLSearchParams({
    start_time: '2026-09-28 10:05', end_time: '2026-09-28 10:06' }));
  expect(throughNextMinute.list.map(row => [row.uid, row.time]))
    .toEqual([[13, endMinuteLastSecond], [11, at(6)]]);
  const day = await service().records(11, new URLSearchParams({
    start_time: '2026-09-28', end_time: '2026-09-28' }));
  expect(day.count).toBe(4);
  expect(day.list.map(row => row.id)).toEqual([104, 103, 102, 101]);
  expect((await service().records(11, new URLSearchParams({
    start_time: '2026-09-29', end_time: '2026-09-29' }))).list)
    .toMatchObject([{ id: 107, add_time: nextShanghaiDay }]);
});

it('rejects invalid query shapes and caps date range, money and pagination', async () => {
  await expect(service().list(new URLSearchParams({ price_min: '-1' }))).rejects.toThrow('最低佣金');
  await expect(service().list(new URLSearchParams({ price_min: '2', price_max: '1' }))).rejects.toThrow('范围');
  await expect(service().list(new URLSearchParams({ page: '1001' }))).rejects.toThrow('分页');
  await expect(service().list(new URLSearchParams({ keyword: 'x', unknown: '1' }))).rejects.toThrow('未知');
  await expect(service().list(new URLSearchParams({ start_time: '2026-09-28 10:05' })))
    .rejects.toThrow('成对');
  await expect(service().records(11, new URLSearchParams({
    start_time: '2026-09-28', end_time: '2026-09-28 10:05' })))
    .rejects.toThrow('精度');
});
