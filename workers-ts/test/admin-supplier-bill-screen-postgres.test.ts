import { afterEach, beforeEach, expect, it } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { supplierFlowingWater, systemSupplier, user } from '../src/models/schema';
import { AdminSupplierBillScreenService } from '../src/services/admin/AdminSupplierBillScreenService';
import { financePostgres } from './helpers/financePostgres';

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminSupplierBillScreenService(createContainerFromDb(fixture.db));
const query = (value: string) => new URLSearchParams(value);
const time = (value: string) => Math.floor(Date.parse(value) / 1000);
const sep1 = time('2026-09-01T12:00:00+08:00');

beforeEach(async () => {
  fixture = await financePostgres([systemSupplier, supplierFlowingWater, user]);
  await fixture.db.insert(systemSupplier).values([
    { id: 1, adminId: 1, supplierName: '甲供应商' },
    { id: 2, adminId: 2, supplierName: '乙供应商', isShow: 0 },
    { id: 3, adminId: 3, supplierName: '已删除供应商', isDel: 1 },
  ]);
  await fixture.db.insert(user).values([
    { uid: 101, nickname: 'Alice Buyer' },
    { uid: 102, nickname: 'Private Buyer', deleteTime: new Date('2026-08-01T00:00:00Z') },
  ]);
  await fixture.db.insert(supplierFlowingWater).values([
    { id: 1, supplierId: 1, uid: 101, orderId: 'FIRST-A', number: '10.00', pm: 1, status: 0,
      type: 1, payType: 'weixin', addTime: sep1, tradeTime: sep1 },
    { id: 2, supplierId: 1, uid: 101, orderId: 'SECOND-B', number: '3.00', pm: 0, status: 1,
      type: 2, payType: 'yue', addTime: sep1 + 3600,
      finishTime: time('2026-09-02T10:00:00+08:00') },
    { id: 3, supplierId: 2, orderId: 'THIRD-C', number: '7.00', pm: 1, status: 1,
      addTime: time('2026-09-02T00:00:00+08:00'), finishTime: time('2026-09-03T10:00:00+08:00') },
    { id: 4, supplierId: 3, orderId: 'OLD-D', number: '2.00', pm: 0, status: -1,
      addTime: sep1 + 7200 },
    { id: 5, supplierId: 999, orderId: 'ORPHAN-E', number: '4.00', pm: 1, status: 0,
      addTime: sep1 + 10800 },
    { id: 6, supplierId: 1, orderId: 'DELETED-F', number: '100.00', pm: 1, status: 0,
      isDel: 1, addTime: sep1 },
    { id: 7, supplierId: 1, uid: 102, orderId: 'VISIBLE-G', number: '1.00', pm: 1,
      status: 0, addTime: sep1 + 14400 },
    { id: 8, supplierId: 1, orderId: 'WEEK-2020', number: '2.00', pm: 1,
      addTime: time('2020-12-31T12:00:00+08:00') },
    { id: 9, supplierId: 1, orderId: 'WEEK-2021', number: '5.00', pm: 1,
      addTime: time('2021-01-01T12:00:00+08:00') },
  ]);
}, 30_000);
afterEach(async () => { await fixture?.close(); });

it('lists disabled suppliers but excludes deleted options, while all historical ledger rows still aggregate', async () => {
  expect(await service().suppliers(query(''))).toEqual([
    { id: 2, supplier_name: '乙供应商' }, { id: 1, supplier_name: '甲供应商' },
  ]);
  const result = await service().groups(query('timeType=day&data=2026%2F09%2F01%2012%3A00%3A00-2026%2F09%2F01%2023%3A59%3A59'));
  expect(result).toMatchObject({ count: 1, list: [{ period: '2026-09-01',
    income_num: '15.00', exp_num: '5.00', entry_num: '10.00' }] });
  const deleted = await service().groups(query('timeType=day&supplier_id=3&status=-1'));
  expect(deleted.list.find(row => row.period === '2026-09-01')).toMatchObject({ exp_num: '2.00' });
  await expect(service().groups(query('supplier_id=404'))).rejects.toThrow('供应商不存在');
  expect((await service().groups(query('supplier_id=0&status=-1'))).count).toBe(1);
});

it('uses finish_time only for status=1 grouping and keeps date selection on add_time', async () => {
  const data = 'data=2026%2F09%2F01%2012%3A00%3A00-2026%2F09%2F01%2023%3A59%3A59';
  const settled = await service().groups(query(`timeType=day&status=1&${data}`));
  expect(settled).toMatchObject({ count: 1, list: [{ period: '2026-09-02',
    income_num: '0.00', exp_num: '3.00', entry_num: '-3.00' }] });
  const rows = await service().details(query(`timeType=day&period=2026-09-02&status=1&${data}`));
  expect(rows).toMatchObject({ count: 1, list: [{ id: 2, order_id: 'SECOND-B',
    trade_time: '2026-09-01 13:00:00' }] });
  const all = await service().groups(query(`timeType=day&status=&${data}`));
  expect(all.list[0]).toMatchObject({ period: '2026-09-01', exp_num: '5.00' });
  // PHP treats both endpoints as inclusive and extends midnight endings or
  // identical non-midnight instants by one day.
  const midnight = await service().groups(query('timeType=day&data=2026%2F09%2F01-2026%2F09%2F01'));
  expect(midnight.list.map(row => row.period)).toContain('2026-09-02');
  const sameSecond = await service().groups(query('timeType=day&data=2026%2F09%2F01%2012%3A00%3A00-2026%2F09%2F01%2012%3A00%3A00'));
  expect(sameSecond.list.map(row => row.period)).toContain('2026-09-02');
});

it('uses MySQL calendar-year week 00/53 keys, including the January rollover', async () => {
  const groups = await service().groups(query('timeType=week&data=2020%2F12%2F31-2021%2F01%2F02'));
  expect(groups.list.filter(row => row.period.startsWith('2020-') || row.period.startsWith('2021-')))
    .toMatchObject([{ period: '2021-00', income_num: '5.00' },
      { period: '2020-53', income_num: '2.00' }]);
  expect((await service().details(query('timeType=week&period=2021-00'))).list.map(row => row.id))
    .toEqual([9]);
});

it('recomputes details from period and supplier scope rather than trusting a truncated ID list', async () => {
  await fixture.db.insert(supplierFlowingWater).values(Array.from({ length: 105 }, (_, index) => ({
    id: 100 + index, supplierId: index % 2 ? 2 : 1, orderId: `MANY-${index}`,
    number: '1.00', pm: 1, status: 0, addTime: sep1 + 20_000,
  })));
  const base = 'timeType=day&period=2026-09-01&supplier_id=1&status=0';
  const first = await service().details(query(`${base}&page=1&limit=100`));
  expect(first.count).toBe(55); // 53 new supplier-1 rows plus two originals.
  expect(first.list[0].order_id).toBe('MANY-104');
  const full = await service().export(query(base));
  expect(full.count).toBe(55);
  expect(full.export[0].order_id).toBe('MANY-104');
  expect(full.export.every(row => !row.order_id.includes('MANY-103'))).toBe(true);
  const all = await service().details(query('timeType=day&period=2026-09-01&status=0&limit=100'));
  expect(all.count).toBeGreaterThan(100);
  await expect(service().details(query(`${base}&ids=1,2,3`))).rejects.toThrow('未知或重复');
});

it('keeps soft-deleted user ledger rows, hides their nickname, and escapes literal search/export cells', async () => {
  const base = 'timeType=day&period=2026-09-01&supplier_id=1&status=0';
  expect((await service().details(query(base))).list.find(row => row.id === 7))
    .toMatchObject({ user_nickname: '游客' });
  expect((await service().details(query(`${base}&keyword=Private%20Buyer`))).count).toBe(0);
  expect((await service().details(query(`${base}&keyword=first-a`))).count).toBe(1);
  await fixture.db.insert(supplierFlowingWater).values({ id: 301, supplierId: 1,
    orderId: 'A%_LITERAL', number: '1.00', pm: 1, addTime: sep1 });
  expect((await service().details(query(`${base}&keyword=%25_`))).list.map(row => row.id))
    .toEqual([301]);
  await fixture.db.insert(supplierFlowingWater).values({ id: 300, supplierId: 1,
    orderId: '=SUM(1,1)', number: '1.00', pm: 1, addTime: sep1 });
  expect((await service().export(query(base))).export.find(row => row.order_id.includes('SUM'))?.order_id)
    .toBe("'=SUM(1,1)");
  await expect(service().groups(query('timeType=quarter'))).rejects.toThrow();
  await expect(service().details(query(`${base}&period=2026-09-02`))).rejects.toThrow('重复');
});

it('rejects an oversized complete export instead of silently sending a truncated page', async () => {
  const batchSize = 500;
  for (let offset = 0; offset < 5_001; offset += batchSize) {
    await fixture.db.insert(supplierFlowingWater).values(
      Array.from({ length: Math.min(batchSize, 5_001 - offset) }, (_, index) => ({
        id: 10_000 + offset + index, supplierId: 1,
        orderId: `EXPORT-${offset + index}`, number: '1.00', pm: 1,
        addTime: sep1 + 20_000,
      })),
    );
  }
  await expect(service().export(query('timeType=day&period=2026-09-01&supplier_id=1&status=0')))
    .rejects.toThrow('超过5000行');
}, 60_000);
