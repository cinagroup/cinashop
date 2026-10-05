import { afterEach, beforeEach, expect, it } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { storeOrder, storeOrderRefund, systemSupplier } from '../src/models/schema';
import { AdminSupplierOrderStatisticsScreenService, parseSupplierOrderStatisticsRange } from
  '../src/services/admin/AdminSupplierOrderStatisticsScreenService';
import { financePostgres } from './helpers/financePostgres';

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminSupplierOrderStatisticsScreenService(createContainerFromDb(fixture.db));
const query = (value: string) => new URLSearchParams(value);
const at = (value: string) => Math.floor(Date.parse(value) / 1000);
const first = at('2026-09-01T12:00:00+08:00');
const lastSecond = at('2026-09-01T23:59:59+08:00');
const nextMidnight = at('2026-09-02T00:00:00+08:00');
const day = 'time=2026%2F09%2F01-2026%2F09%2F01';

beforeEach(async () => {
  fixture = await financePostgres([systemSupplier, storeOrder, storeOrderRefund]);
  await fixture.db.insert(systemSupplier).values([
    { id: 1, adminId: 1, supplierName: '甲' },
    { id: 2, adminId: 2, supplierName: '乙', isShow: 0 },
    { id: 3, adminId: 3, supplierName: '已删除', isDel: 1 },
    { id: 4, adminId: 4, supplierName: '丁' },
  ]);
  await fixture.db.insert(storeOrder).values([
    { id: 1, orderId: 'A1', supplierId: 1, pid: 0, paid: 1, payPrice: '10.00',
      type: 0, isChannel: 0, addTime: first },
    { id: 2, orderId: 'A2', supplierId: 1, pid: 5, paid: 1, payPrice: '20.00',
      refundStatus: 3, refundType: 6, refundPrice: '7.00', type: 4,
      isChannel: 1, addTime: lastSecond },
    { id: 3, orderId: 'PARENT', supplierId: 1, pid: -1, paid: 1, payPrice: '30.00',
      type: 1, isChannel: 2, addTime: first },
    { id: 4, orderId: 'DELETED', supplierId: 1, pid: 0, paid: 1, payPrice: '40.00',
      isDel: 1, type: 2, isChannel: 3, addTime: first },
    { id: 5, orderId: 'SYSTEM-DELETED', supplierId: 1, pid: 0, paid: 1, payPrice: '50.00',
      isSystemDel: 1, type: 3, isChannel: 4, addTime: first },
    { id: 6, orderId: 'UNPAID', supplierId: 1, paid: 0, payPrice: '60.00', addTime: first },
    { id: 7, orderId: 'DISABLED-SUPPLIER', supplierId: 2, paid: 1,
      payPrice: '70.00', addTime: first },
    { id: 8, orderId: 'DELETED-SUPPLIER', supplierId: 3, paid: 1,
      payPrice: '80.00', addTime: first },
    { id: 9, orderId: 'NEXT-DAY', supplierId: 1, paid: 1,
      payPrice: '90.00', addTime: nextMidnight },
    { id: 10, orderId: 'REFUND-ORDER', supplierId: 1, paid: 1, payPrice: '5.00',
      refundStatus: 1, refundType: 6, refundPrice: '3.00', addTime: first },
  ]);
  await fixture.db.insert(storeOrderRefund).values([
    { id: 1, orderId: 'R1', supplierId: 1, refundType: 6,
      refundPrice: '11.00', refundedPrice: '9.00', addTime: first },
    { id: 2, orderId: 'R2', supplierId: 1, refundType: 6, isDel: 1,
      refundPrice: '2.00', refundedPrice: '2.00', addTime: lastSecond },
    { id: 3, orderId: 'R3', supplierId: 2, refundType: 6,
      refundPrice: '5.00', refundedPrice: '4.00', addTime: first },
    { id: 4, orderId: 'PENDING', supplierId: 1, refundType: 5,
      refundPrice: '99.00', refundedPrice: '99.00', addTime: first },
    { id: 5, orderId: 'NEXT-DAY-REFUND', supplierId: 1, refundType: 6,
      refundPrice: '99.00', refundedPrice: '99.00', addTime: nextMidnight },
  ]);
}, 30_000);
afterEach(async () => { await fixture?.close(); });

it('keeps header filters and its refund_price source distinct from other panels', async () => {
  expect(await service().summary(query(`${day}&supplier_id=1`)))
    .toEqual({ payPrice: '80.00', payCount: 3, refundPrice: '13.00', refundCount: 2 });
  expect(await service().summary(query(`${day}&supplier_id=0`)))
    .toEqual({ payPrice: '230.00', payCount: 5, refundPrice: '18.00', refundCount: 3 });
  expect((await service().summary(query('time=2026%2F09%2F01-2026%2F09%2F02&supplier_id=1')))
    .payPrice).toBe('170.00');
});

it('charts child orders, excludes split parents/deleted rows, and uses order.refund_price', async () => {
  const result = await service().trend(query(`${day}&supplier_id=1`));
  expect(result.xAxis).toHaveLength(24);
  expect(result.series.map(row => row.name)).toEqual(['订单金额', '订单量', '退款金额', '退款订单量']);
  const position = result.xAxis.indexOf('23');
  expect(result.series[0].data[position]).toBe(20);
  expect(result.series[1].data[position]).toBe(1);
  expect(result.series[2].data[position]).toBe(7);
  expect(result.series[3].data[position]).toBe(1);
  expect(result.series[0].data.reduce((sum, value) => sum + value, 0)).toBe(30);
  expect(result.series[2].data.reduce((sum, value) => sum + value, 0)).toBe(10);
  expect(result.series[3].data.reduce((sum, value) => sum + value, 0)).toBe(2);
});

it('counts source channels, sums order types, and retains PHP pid>=0 and deletion differences', async () => {
  const channel = await service().channel(query(`${day}&supplier_id=1`));
  expect(channel.totalCount).toBe(5);
  expect(channel.items.map(row => [row.key, row.value]))
    .toEqual([[0, 2], [1, 1], [3, 1], [4, 1], [2, 0]]);
  expect(channel.items[0].percent).toBe(40);
  const type = await service().type(query(`${day}&supplier_id=1`));
  expect(type.totalPrice).toBe('125.00');
  expect(type.items.find(row => row.key === 4)).toMatchObject({ value: '20.00', percent: 16 });
  expect(type.items.find(row => row.key === 1)).toMatchObject({ value: '0.00' });
  expect(type.items).toHaveLength(9);
});

it('pages visible suppliers in descending ID order and applies the selected supplier', async () => {
  expect(await service().suppliers(query(''))).toEqual({ list: [
    { id: 4, supplierName: '丁' }, { id: 2, supplierName: '乙' },
    { id: 1, supplierName: '甲' },
  ] });
  expect(await service().supplierTable(query(`${day}&page=1&limit=1`)))
    .toEqual({ list: [{ id: 4, supplierName: '丁', orderPrice: '0.00', orderCount: 0,
      refundOrderPrice: '0.00', refundOrderCount: 0 }], count: 2, page: 1, limit: 1 });
  expect(await service().supplierTable(query(`${day}&page=2&limit=1`)))
    .toEqual({ list: [{ id: 1, supplierName: '甲', orderPrice: '30.00', orderCount: 2,
      refundOrderPrice: '11.00', refundOrderCount: 2 }], count: 2, page: 2, limit: 1 });
  expect((await service().supplierTable(query(`${day}&supplier_id=1`))).count).toBe(1);
  expect((await service().supplierTable(query(`${day}&supplier_id=2`))).count).toBe(0);
});

it('validates Shanghai daily windows, query keys, and bounded table pages', async () => {
  expect(parseSupplierOrderStatisticsRange('2026/09/01-2026/09/01'))
    .toMatchObject({ start: at('2026-09-01T00:00:00+08:00'),
      endExclusive: nextMidnight, days: 1 });
  expect(parseSupplierOrderStatisticsRange('2026/01/01-2027/01/01').days).toBe(366);
  expect(() => parseSupplierOrderStatisticsRange('2026/01/01-2027/01/02')).toThrow('366');
  expect(() => parseSupplierOrderStatisticsRange('2026/02/30-2026/03/01')).toThrow('无效');
  await expect(service().summary(query(`${day}&time=2026%2F09%2F01-2026%2F09%2F01`)))
    .rejects.toThrow('重复');
  await expect(service().trend(query(`${day}&page=2`))).rejects.toThrow('未知');
  await expect(service().supplierTable(query(`${day}&page=1000&limit=100`)))
    .rejects.toThrow('分页超出范围');
  await expect(service().suppliers(query('supplier_id=1'))).rejects.toThrow('未知');
});

it('formats historic negative type totals without losing the sign', async () => {
  await fixture.db.insert(storeOrder).values({ id: 100, orderId: 'NEGATIVE', supplierId: 4,
    pid: 0, paid: 1, payPrice: '-1.23', type: 8, addTime: first });
  expect((await service().type(query(`${day}&supplier_id=4`))).totalPrice).toBe('-1.23');
});

it('truncates percentages to two decimals after four decimal quotient precision', async () => {
  await fixture.db.insert(storeOrder).values([
    { id: 101, orderId: 'THIRD-1', supplierId: 4, pid: 0, paid: 1,
      payPrice: '1.00', type: 0, isChannel: 0, addTime: first },
    { id: 102, orderId: 'THIRD-2', supplierId: 4, pid: 0, paid: 1,
      payPrice: '1.00', type: 1, isChannel: 1, addTime: first },
    { id: 103, orderId: 'THIRD-3', supplierId: 4, pid: 0, paid: 1,
      payPrice: '1.00', type: 2, isChannel: 2, addTime: first },
  ]);
  expect((await service().channel(query(`${day}&supplier_id=4`))).items[0].percent).toBe(33.33);
  expect((await service().type(query(`${day}&supplier_id=4`))).items[0].percent).toBe(33.33);
});

it('shows every cross-year day for 32–92 days and aggregates longer windows by month', async () => {
  await fixture.db.insert(storeOrder).values([
    { id: 201, orderId: 'YEAR-END', supplierId: 4, paid: 1, payPrice: '2.00',
      addTime: at('2026-12-31T12:00:00+08:00') },
    { id: 202, orderId: 'NEW-YEAR', supplierId: 4, paid: 1, payPrice: '3.00',
      addTime: at('2027-01-01T12:00:00+08:00') },
  ]);
  const byDay = await service().trend(query('time=2026%2F11%2F20-2027%2F01%2F10&supplier_id=4'));
  expect(byDay.xAxis).toHaveLength(52);
  expect(byDay.series[0].data[byDay.xAxis.indexOf('2026-12-31')]).toBe(2);
  expect(byDay.series[0].data[byDay.xAxis.indexOf('2027-01-01')]).toBe(3);
  const byMonth = await service().trend(query('time=2026%2F09%2F01-2027%2F01%2F10&supplier_id=4'));
  expect(byMonth.xAxis).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
  expect(byMonth.series[0].data).toEqual([0, 0, 0, 2, 3]);
});
