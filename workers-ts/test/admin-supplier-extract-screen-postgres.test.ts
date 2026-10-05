import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { supplierExtract, supplierFlowingWater, systemAdmin, systemLog, systemSupplier } from '../src/models/schema';
import { AdminSupplierFinanceService } from '../src/services/admin/AdminSupplierFinanceService';
import { financePostgres } from './helpers/financePostgres';

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminSupplierFinanceService(createContainerFromDb(fixture.db));
const query = (value: string) => new URLSearchParams(value);
const time = (value: string) => Math.floor(Date.parse(value) / 1000);
const sep1 = time('2026-09-01T12:00:00+08:00');

beforeEach(async () => {
  fixture = await financePostgres([systemSupplier, supplierExtract, supplierFlowingWater, systemAdmin, systemLog]);
  await fixture.db.insert(systemSupplier).values([
    { id: 1, adminId: 1, supplierName: '甲供应商' },
    { id: 2, adminId: 2, supplierName: '已停用供应商', isShow: 0 },
    { id: 3, adminId: 3, supplierName: '已删供应商', isDel: 1 },
  ]);
  await fixture.db.insert(supplierFlowingWater).values([
    { id: 1, supplierId: 1, number: '100.00', pm: 1, status: 1 },
    { id: 2, supplierId: 1, number: '20.00', pm: 0, status: 1 },
    { id: 3, supplierId: 1, number: '100.00', pm: 1, status: 0 },
    { id: 4, supplierId: 1, number: '10.00', pm: 1, status: 1, isDel: 1 },
    { id: 5, supplierId: 2, number: '50.00', pm: 1, status: 1 },
    { id: 6, supplierId: 3, number: '30.00', pm: 1, status: 1 },
    { id: 7, supplierId: 99, number: '20.00', pm: 1, status: 1 },
  ]);
  await fixture.db.insert(supplierExtract).values([
    { id: 1, supplierId: 1, extractType: 'bank', extractPrice: '10.00', supplierMark: '申请说明',
      status: 0, payStatus: 0, addTime: sep1 },
    { id: 2, supplierId: 1, extractType: 'weixin', extractPrice: '5.00', status: 1,
      payStatus: 0, addTime: time('2026-09-01T23:59:59+08:00') },
    { id: 3, supplierId: 1, extractType: 'alipay', extractPrice: '7.00', status: 1,
      payStatus: 1, addTime: time('2026-09-02T00:00:00+08:00') },
    { id: 4, supplierId: 1, extractType: 'bank', extractPrice: '4.00', status: -1,
      payStatus: 0, addTime: sep1 },
    { id: 5, supplierId: 2, extractType: 'bank', extractPrice: '20.00', status: 0,
      payStatus: 0, addTime: sep1 },
    { id: 6, supplierId: 3, extractType: 'bank', extractPrice: '8.00', status: 0,
      payStatus: 0, addTime: sep1 },
    { id: 7, supplierId: 99, extractType: 'bank', extractPrice: '6.00', status: 0,
      payStatus: 0, addTime: sep1 },
  ]);
}, 30_000);
afterEach(async () => { await fixture?.close(); });

it('preserves deleted and orphan supplier history while options exclude deleted suppliers', async () => {
  expect(await service().suppliers(query(''))).toEqual({ list: [
    { id: 2, supplierName: '已停用供应商' }, { id: 1, supplierName: '甲供应商' },
  ] });
  const all = await service().list(query(''));
  expect(all).toMatchObject({ count: 7, page: 1, limit: 15,
    extract_statistics: { withdrawable: '124.00', pending_review: '44.00',
      pending_transfer: '5.00', paid: '7.00' } });
  expect(all.list.map(row => row.id)).toEqual([7, 6, 5, 4, 3, 2, 1]);
  expect(all.list.find(row => row.id === 7)).toMatchObject({ supplierName: '' });
  expect(all.list.find(row => row.id === 6)).toMatchObject({ supplierName: '已删供应商' });
  expect((await service().list(query('supplier_id=3'))).list.map(row => row.id)).toEqual([6]);
  expect((await service().list(query('supplier_id=0'))).count).toBe(0);
  await expect(service().suppliers(query('page=1'))).rejects.toThrow('不接受查询参数');
});

it('combines supplier, review, transfer, payment type and Shanghai time filters without changing the finance balance', async () => {
  const base = 'supplier_id=1&status=1&pay_status=0&extract_type=wx';
  const result = await service().list(query(`${base}&start_time=2026%2F09%2F01%2012%3A00%3A00&end_time=2026%2F09%2F01%2023%3A59%3A59`));
  expect(result).toMatchObject({ count: 1, list: [{ id: 2 }],
    extract_statistics: { pending_review: '0.00', pending_transfer: '5.00',
      withdrawable: '58.00' } });
  const paid = await service().list(query('supplier_id=1&status=1&pay_status=1'));
  expect(paid).toMatchObject({ count: 1, list: [{ id: 3 }], extract_statistics: { withdrawable: '58.00' } });
  const midnight = await service().list(query('supplier_id=1&start_time=2026%2F09%2F01&end_time=2026%2F09%2F01'));
  expect(midnight.list.map(row => row.id)).toContain(3);
  const sameSecond = await service().list(query('supplier_id=1&start_time=2026%2F09%2F01%2012%3A00%3A00&end_time=2026%2F09%2F01%2012%3A00%3A00'));
  expect(sameSecond.list.map(row => row.id)).toContain(3);
  expect((await service().list(query('supplier_id=1&pay_status=1'))).extract_statistics.pending_review).toBe('0.00');
});

it('validates date and pagination scope rather than broadening malformed filters', async () => {
  for (const input of ['supplier_id=-1', 'supplier_id=oops', 'status=2', 'pay_status=3',
    'limit=101', 'page=0', 'status=0&status=1', 'unknown=1',
    'start_time=2026%2F02%2F30', 'end_time=2039%2F01%2F01',
    'start_time=2026%2F09%2F02&end_time=2026%2F09%2F01',
    'start_time=2025%2F01%2F01&end_time=2026%2F09%2F01']) {
    await expect(service().list(query(input)), input).rejects.toThrow();
  }
});

it('updates the shared supplier_mark with CAS and leaves the separate mark column untouched', async () => {
  const updated = await service().updateMark(1, 42, { mark: '财务已复核', expected_supplier_mark: '申请说明' });
  expect(updated).toEqual({ id: 1, supplierMark: '财务已复核' });
  expect((await fixture.db.select().from(supplierExtract).where(eq(supplierExtract.id, 1)))[0])
    .toMatchObject({ supplierMark: '财务已复核', mark: '' });
  expect((await fixture.db.select().from(systemLog))).toHaveLength(1);
  await expect(service().updateMark(1, 43, { mark: '旧页面覆盖', expected_supplier_mark: '申请说明' }))
    .rejects.toMatchObject({ httpStatus: 409 });
  await fixture.db.update(supplierExtract).set({ supplierMark: '供应商又修改' }).where(eq(supplierExtract.id, 1));
  await expect(service().updateMark(1, 42, { mark: '覆盖供应商', expected_supplier_mark: '财务已复核' }))
    .rejects.toMatchObject({ httpStatus: 409 });
  expect((await fixture.db.select().from(systemLog))).toHaveLength(1);
  await expect(service().updateMark(1, 42, { mark: 'x'.repeat(201), expected_supplier_mark: '供应商又修改' }))
    .rejects.toThrow('超过200字');
  await expect(service().updateMark(1, 42, { mark: '', expected_supplier_mark: '供应商又修改' }))
    .rejects.toThrow('备注无效');
  await expect(service().updateMark(999, 42, { mark: '无记录', expected_supplier_mark: '' }))
    .rejects.toThrow('不存在');
});

it('releases only rejected reservations and records one actual transfer without requiring an image', async () => {
  await service().review(1, 42, { type: '2', message: '账户信息错误' });
  const rejected = (await fixture.db.select().from(supplierExtract).where(eq(supplierExtract.id, 1)))[0];
  expect(rejected).toMatchObject({ status: -1, adminId: 42, failMsg: '账户信息错误' });
  expect(rejected.failTime).toBeGreaterThan(0);
  expect((await service().list(query('supplier_id=1&status=1'))).extract_statistics.withdrawable).toBe('68.00');
  await expect(service().review(1, 43, { type: 1 })).rejects.toThrow('已审核');
  await expect(service().transfer(1, 43, { voucher_title: '不能转账' })).rejects.toThrow('请先审核');

  await service().review(5, 43, { type: 1 });
  await service().transfer(5, 44, { voucher_title: '银行确认', voucher_image: '' });
  const paid = (await fixture.db.select().from(supplierExtract).where(eq(supplierExtract.id, 5)))[0];
  expect(paid).toMatchObject({ status: 1, payStatus: 1, adminId: 44,
    voucherTitle: '银行确认', voucherImage: '' });
  expect(paid.payTime).toBeGreaterThan(0);
  expect((await service().list(query('supplier_id=2'))).extract_statistics.withdrawable).toBe('30.00');
  await expect(service().transfer(5, 45, { voucher_title: '重复' })).rejects.toThrow('已经完成');
  await expect(service().review(5, 45, { type: 0, message: '反向拒绝' })).rejects.toThrow('已审核');
});

it('accepts only one of two opposing concurrent review decisions', async () => {
  const decisions = await Promise.allSettled([
    service().review(1, 42, { type: 1 }),
    service().review(1, 43, { type: 2, message: '拒绝' }),
  ]);
  expect(decisions.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(decisions.filter(result => result.status === 'rejected')).toHaveLength(1);
  const row = (await fixture.db.select().from(supplierExtract).where(eq(supplierExtract.id, 1)))[0];
  expect([1, -1]).toContain(row.status);
  expect(row.adminId).toBe(row.status === 1 ? 42 : 43);
  expect((await service().list(query('supplier_id=1'))).extract_statistics.withdrawable)
    .toBe(row.status === 1 ? '58.00' : '68.00');
});
