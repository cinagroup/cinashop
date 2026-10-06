import { afterEach, beforeEach, expect, it } from 'vitest';
import { financePostgres } from './helpers/financePostgres';
import { createContainerFromDb } from '../src/lib/di';
import { storeOrder, user } from '../src/models/schema';
import { AdminDivisionStatisticsScreenService,
  parseStatisticsScreenRange } from '../src/services/admin/AdminDivisionStatisticsScreenService';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';

let f: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminDivisionStatisticsScreenService(createContainerFromDb(f.db));
const root = { level: 0, divisionId: 0 };
const scoped = { level: 1, divisionId: 101 };
const sec = (date: string) => Math.floor(Date.parse(date) / 1000);
const date1 = sec('2026-09-01T00:00:00+08:00');
const date2 = sec('2026-09-02T00:00:00+08:00');
const date4 = sec('2026-09-04T00:00:00+08:00');

beforeEach(async () => {
  f = await financePostgres([user, storeOrder]);
  await f.db.insert(user).values([
    { uid: 101, nickname: '事业部甲', divisionType: 1 },
    { uid: 201, nickname: '事业部乙', divisionType: 1, status: 0, isDel: 1 },
    { uid: 111, nickname: '代理商甲', divisionType: 2, divisionId: 101 },
    { uid: 112, nickname: '停用代理商', divisionType: 2, divisionId: 101, status: 0, isDel: 1 },
    { uid: 211, nickname: '代理商乙', divisionType: 2, divisionId: 201 },
    { uid: 121, nickname: '员工甲', divisionType: 3, divisionId: 101 },
    { uid: 122, nickname: '员工乙', divisionType: 3, divisionId: 201 },
    { uid: 301, nickname: '软删除事业部', divisionType: 1,
      deleteTime: new Date('2026-08-01T00:00:00Z') },
    { uid: 113, nickname: '软删除代理商', divisionType: 2, divisionId: 101,
      deleteTime: new Date('2026-08-01T00:00:00Z') },
    { uid: 123, nickname: '软删除员工', divisionType: 3, divisionId: 101,
      deleteTime: new Date('2026-08-01T00:00:00Z') },
  ]);
  await f.db.insert(storeOrder).values([
    { id: 1001, orderId: 'DIV-1001', divisionId: 101, pid: 0, paid: 1,
      payPrice: '10.00', divisionBrokerage: '2.00', divisionAgentBrokerage: '1.00',
      divisionStaffBrokerage: '0.50', addTime: date1 },
    { id: 1002, orderId: 'SPLIT-1002', divisionId: 101, pid: 1001, paid: 1,
      payPrice: '5.00', addTime: date1 },
    { id: 1003, orderId: 'UNPAID-1003', divisionId: 101, pid: 0, paid: 0,
      payPrice: '100.00', addTime: date1 },
    { id: 1004, orderId: 'AGENT-ONLY-1004', divisionAgentId: 111,
      pid: 0, paid: 1, payPrice: '20.00', addTime: date1 },
    { id: 1005, orderId: 'STAFF-ONLY-1005', divisionStaffId: 121,
      pid: 0, paid: 1, payPrice: '30.00', addTime: date1 },
    { id: 1006, orderId: 'DIV-1006', divisionId: 201, pid: 0, paid: 1,
      payPrice: '40.00', addTime: date2 },
    { id: 1007, orderId: 'OTHER-DIVISION-1007', divisionId: 111,
      pid: 0, paid: 1, payPrice: '70.00', addTime: date4 },
  ]);
}, 30_000);
afterEach(async () => { await f?.close(); });

it('keeps all six legacy cards independent of time, with any role ID for the order cohort', async () => {
  expect(await service().summary(root)).toEqual({ divisionNum: 2, agentNum: 3,
    staffNum: 2, orderNum: 6, orderPrice: '175.00', brokeragePrice: '3.50' });
  expect(await service().summary(scoped)).toEqual({ divisionNum: 2, agentNum: 2,
    staffNum: 1, orderNum: 2, orderPrice: '15.00', brokeragePrice: '3.50' });
  await expect(service().summary({ level: 1, divisionId: 0 })).rejects.toThrow('未绑定事业部');
});

it('counts split orders in trend, but excludes unpaid and non-division orders', async () => {
  const day = await service().trend('2026/09/01-2026/09/01', root);
  expect(day.xAxis).toHaveLength(24);
  expect(day.series.map(item => item.name)).toEqual(['订单金额', '订单量']);
  expect(day.series[0].data[0]).toBe(15);
  expect(day.series[1].data[0]).toBe(2);
  expect(day.series[0].data.reduce((a, b) => a + b, 0)).toBe(15);
  const restricted = await service().trend('2026/09/01-2026/09/04', scoped);
  expect(restricted.xAxis).toEqual(['2026-09-01','2026-09-02','2026-09-03','2026-09-04']);
  expect(restricted.series[0].data).toEqual([15,0,0,0]);
});

it('uses sampled single-day points for 32–92 days and monthly buckets above 92 days', async () => {
  const sampled = await service().trend('2026/09/01-2026/10/03', root);
  expect(sampled.xAxis.slice(0, 3)).toEqual(['2026-09-01','2026-09-04','2026-09-07']);
  expect(sampled.series[0].data.slice(0, 3)).toEqual([15,70,0]);
  expect(sampled.series[1].data.slice(0, 3)).toEqual([2,1,0]);
  expect(sampled.series[0].data).not.toContain(40);
  const monthly = await service().trend('2026/01/01-2026/05/01', root);
  expect(monthly.xAxis).toEqual(['2026-01','2026-02','2026-03','2026-04','2026-05']);
  expect(parseStatisticsScreenRange('2026/01/31-2026/05/31').xAxis)
    .toEqual(['2026-01','2026-03','2026-04','2026-05']);
});

it('uses half-open Shanghai date bounds and rejects invalid or excessive ranges', async () => {
  await f.db.insert(storeOrder).values({ id: 1100, orderId: 'NEXT-MIDNIGHT',
    divisionId: 101, pid: 0, paid: 1, payPrice: '9.00', addTime: date2 });
  const result = await service().trend('2026/09/01-2026/09/01', root);
  expect(result.series[0].data[0]).toBe(15);
  const monthly = await service().trend('2026/05/01-2026/09/03', root);
  expect(monthly.xAxis).toEqual(['2026-05','2026-06','2026-07','2026-08','2026-09']);
  expect(monthly.series[0].data.at(-1)).toBe(64);
  expect(monthly.series[1].data.at(-1)).toBe(4);
  // PHP's inclusive BETWEEN would also count Sep 4 midnight (70.00) in this month.
  for (const time of ['2026/02/30-2026/03/01', '2026/09/02-2026/09/01',
    '2025/01/01-2026/09/01', '2026-09-01 - 2026-09-02']) {
    await expect(service().trend(time, root)).rejects.toThrow();
  }
});

it('preserves distinct agent/staff columns and unpaid order count; limits scoped reads', async () => {
  expect(await service().ranking(root)).toEqual({ list: [
    { uid: 101, nickname: '事业部甲', spreadAgent: 1, spreadStaff: 1,
      orderNum: 3, orderPrice: '15.00', brokeragePrice: '3.50' },
  ] });
  // The PHP ranking uses division_id=agent UID, which could read another division.
  // Intersecting with the admin's division intentionally prevents that leak.
  expect(await service().ranking(scoped)).toEqual({ list: [
    { uid: 111, nickname: '代理商甲', spreadAgent: 0, spreadStaff: 0,
      orderNum: 0, orderPrice: '0.00', brokeragePrice: '0.00' },
  ] });
});

it('does not add generic deletion/refund visibility filters to legacy financial statistics', async () => {
  await f.db.insert(storeOrder).values({ id: 1200, orderId: 'REFUNDED-DELETED',
    divisionId: 101, pid: 0, paid: 1, isDel: 1, isSystemDel: 1,
    refundStatus: 2, payPrice: '6.25', addTime: date1 });
  expect(await service().summary(root)).toMatchObject({ orderNum: 7, orderPrice: '181.25' });
  const trend = await service().trend('2026/09/01-2026/09/01', root);
  expect(trend.series[0].data[0]).toBe(21.25);
  expect(trend.series[1].data[0]).toBe(3);
  expect((await service().ranking(root)).list[0]).toMatchObject({
    orderNum: 4, orderPrice: '21.25' });
});

it('fails visibly when the unpaginated legacy ranking exceeds its safety bound', async () => {
  await f.db.insert(user).values(Array.from({ length: 500 }, (_, index) => ({
    uid: 1_000 + index, nickname: `事业部 ${index}`, divisionType: 1,
  })));
  await expect(service().ranking(root)).rejects.toThrow('超过 500 行');
});

it('maps only the new routes to the separate statistics capability', () => {
  for (const prefix of ['/adminapi', '/api/admin']) {
    for (const action of ['summary','trend','ranking']) {
      expect(requiredAdminPermission('GET', `${prefix}/agent/division/statistics-screen/${action}`))
        .toBe('division_statistics.view');
    }
    expect(requiredAdminPermission('GET', `${prefix}/agent/division/statistics`)).toBe('division.view');
    expect(requiredAdminPermission('GET', `${prefix}/agent/division/list`)).toBe('division.view');
  }
});
