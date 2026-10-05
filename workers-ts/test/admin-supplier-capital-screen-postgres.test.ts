import { afterEach, beforeEach, expect, it } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { supplierFlowingWater, systemLog, systemSupplier, user } from '../src/models/schema';
import { AdminSupplierCapitalScreenService, isMachineLineageRemark } from '../src/services/admin/AdminSupplierCapitalScreenService';
import { financePostgres } from './helpers/financePostgres';

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminSupplierCapitalScreenService(createContainerFromDb(fixture.db));
const query = (value: string) => new URLSearchParams(value);
const time = (value: string) => Math.floor(Date.parse(value) / 1000);
const sep1 = time('2026-09-01T12:00:00+08:00');
const actor = { id: 7, name: '平台管理员', ip: '127.0.0.1' };

beforeEach(async () => {
  fixture = await financePostgres([systemSupplier, supplierFlowingWater, user, systemLog]);
  await fixture.db.insert(systemSupplier).values([
    { id: 1, adminId: 1, supplierName: '甲供应商' },
    { id: 2, adminId: 2, supplierName: '停用供应商', isShow: 0 },
    { id: 3, adminId: 3, supplierName: '已删除供应商', isDel: 1 },
  ]);
  await fixture.db.insert(user).values([
    { uid: 101, nickname: 'Alice Buyer' },
    { uid: 102, nickname: 'Private Buyer', deleteTime: new Date('2026-08-01T00:00:00Z') },
  ]);
  await fixture.db.insert(supplierFlowingWater).values([
    { id: 1, supplierId: 1, uid: 101, orderId: 'FIRST-A', linkId: 'ORDER-A', number: '10.00',
      pm: 1, type: 1, payType: 'weixin', addTime: sep1, tradeTime: sep1, mark: 'supplier-private' },
    { id: 2, supplierId: 2, uid: 101, orderId: 'SECOND-B', number: '3.00', pm: 0,
      type: 2, payType: 'yue', addTime: time('2026-09-02T00:00:00+08:00') },
    { id: 3, supplierId: 3, orderId: 'OLD-C', number: '2.00', pm: 0, addTime: sep1 + 3600 },
    { id: 4, supplierId: 999, orderId: 'ORPHAN-D', number: '4.00', pm: 1, addTime: sep1 + 7200 },
    { id: 5, supplierId: 1, orderId: 'DELETED-E', number: '100.00', pm: 1, isDel: 1, addTime: sep1 },
    { id: 6, supplierId: 1, uid: 102, orderId: 'VISIBLE-F', number: '1.00', pm: 1, addTime: sep1 + 10800 },
    { id: 7, supplierId: 1, orderId: 'A%_LITERAL', number: '1.00', pm: 1, addTime: sep1 + 14400 },
    { id: 8, supplierId: 1, orderId: '=SUM(1,1)', number: '1.00', pm: 1, addTime: sep1 + 18000 },
    { id: 9, supplierId: 1, orderId: 'MACHINE-I', number: '1.00', pm: 1, addTime: sep1 + 21600,
      remark: JSON.stringify({ version: 'supplier-split-income-v1', sourceFlowId: 1 }) },
    { id: 10, supplierId: 1, orderId: 'JSON-J', number: '1.00', pm: 1, addTime: sep1 + 25200,
      remark: JSON.stringify({ note: '普通历史 JSON' }) },
  ]);
}, 30_000);
afterEach(async () => { await fixture?.close(); });

it('lists only live supplier options, but retains deleted-supplier and orphan ledger history', async () => {
  expect(await service().suppliers(query(''))).toEqual([
    { id: 2, supplier_name: '停用供应商' }, { id: 1, supplier_name: '甲供应商' },
  ]);
  const all = await service().list(query('page=1&limit=20'));
  expect(all).toMatchObject({ count: 9, page: 1, limit: 20 });
  expect(all.list.map(row => row.id)).toEqual([10, 9, 8, 7, 6, 4, 3, 2, 1]);
  expect(all.list.find(row => row.id === 3)?.supplier_name).toBe('已删除供应商');
  expect(all.list.find(row => row.id === 4)?.supplier_name).toBe('');
  expect((await service().list(query('supplier_id=3'))).list.map(row => row.id)).toEqual([3]);
  expect((await service().list(query('supplier_id=999'))).list.map(row => row.id)).toEqual([4]);
  expect((await service().list(query('page=2&limit=2'))).list.map(row => row.id)).toEqual([8, 7]);
  await fixture.db.insert(supplierFlowingWater).values({ id: 11, supplierId: 0,
    orderId: 'ZERO-SUPPLIER', number: '1.00', pm: 1, addTime: sep1 });
  expect((await service().list(query('supplier_id=0'))).list.map(row => row.id)).toEqual([11]);
  expect((await service().list(query('supplier_id='))).count).toBe(10);
});

it('uses add_time Shanghai inclusive PHP boundaries and literal order/person search', async () => {
  const selected = await service().list(query('data=2026%2F09%2F01-2026%2F09%2F01'));
  expect(selected.list.map(row => row.id)).toContain(2); // midnight ending expands one day
  expect(selected.list.find(row => row.id === 2)).toMatchObject({ trade_time: '2026-09-02 00:00:00' });
  expect((await service().list(query('keyword=Alice%20Buyer'))).list.map(row => row.id)).toEqual([2, 1]);
  expect((await service().list(query('keyword=101'))).list.map(row => row.id)).toEqual([2, 1]);
  expect((await service().list(query('keyword=Private%20Buyer'))).count).toBe(0);
  expect((await service().list(query('keyword=%25_'))).list.map(row => row.id)).toEqual([7]);
  expect((await service().list(query('keyword=first-a'))).list.map(row => row.id)).toEqual([1]);
  expect(selected.list.find(row => row.id === 6)?.user_nickname).toBe('游客');
  await expect(service().list(query('data=2026%2F09%2F31-2026%2F09%2F31'))).rejects.toThrow();
  await expect(service().list(query('page=1&page=2'))).rejects.toThrow('未知或重复');
  await expect(service().list(query('limit=101'))).rejects.toThrow('超出范围');
});

it('exports every row in the selected scope, eight legacy columns, and guards spreadsheet cells', async () => {
  const result = await service().export(query('supplier_id=1&data=2026%2F09%2F01%2012%3A00%3A00-2026%2F09%2F01%2023%3A59%3A59'));
  expect(result.filekey).toEqual(['order_id', 'link_id', 'trade_time', 'number', 'pm',
    'user_nickname', 'type_name', 'pay_type_name']);
  expect(result.header).toHaveLength(8);
  expect(result.count).toBe(6);
  expect(result.export[0].order_id).toBe('JSON-J');
  expect(result.export.find(row => row.order_id.includes('SUM'))?.order_id).toBe("'=SUM(1,1)");
  expect(result.export.at(-1)).toMatchObject({ order_id: 'FIRST-A', pm: '收入', type_name: '支付订单',
    pay_type_name: '微信支付' });
  await expect(service().export(query('supplier_id=1&page=1'))).rejects.toThrow('未知或重复');
});

it('updates only platform remark with CAS and atomically records a content-free audit', async () => {
  const before = await fixture.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id);
  expect(before[0]).toMatchObject({ remark: '', mark: 'supplier-private' });
  expect(await service().remark(1, { remark: '已核对', expected_remark: '' }, actor))
    .toEqual({ id: 1, remark: '已核对' });
  const after = await fixture.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id);
  expect(after[0]).toMatchObject({ remark: '已核对', mark: 'supplier-private' });
  const audits = await fixture.db.select().from(systemLog);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ adminId: 7, type: 'supplier_capital',
    page: '/supplier/capital-flow', method: 'PUT' });
  expect(audits[0].action).toContain('id=1');
  expect(audits[0].action).not.toContain('已核对');
  await expect(service().remark(1, { remark: '后写覆盖', expected_remark: '' }, actor))
    .rejects.toMatchObject({ httpStatus: 409 });
  expect(await fixture.db.select().from(systemLog)).toHaveLength(1);
  expect(await service().remark(1, { remark: '已核对', expected_remark: '已核对' }, actor))
    .toEqual({ id: 1, remark: '已核对' });
  expect(await fixture.db.select().from(systemLog)).toHaveLength(1);
});

it('protects only known machine lineage JSON and allows ordinary historical JSON text', async () => {
  expect(isMachineLineageRemark('{"version":"supplier-split-income-v1"}')).toBe(true);
  expect(isMachineLineageRemark('{"version":"supplier-refund-split-v1"}')).toBe(true);
  expect(isMachineLineageRemark('{"version":"other"}')).toBe(false);
  expect(isMachineLineageRemark('{"note":"ordinary"}')).toBe(false);
  expect(isMachineLineageRemark('not JSON')).toBe(false);
  const data = await service().list(query(''));
  expect(data.list.find(row => row.id === 9)?.remark_editable).toBe(false);
  expect(data.list.find(row => row.id === 10)?.remark_editable).toBe(true);
  await expect(service().remark(9, { remark: '不能覆盖', expected_remark: data.list.find(row => row.id === 9)?.remark }, actor))
    .rejects.toThrow('系统血缘');
  expect(await service().remark(10, { remark: '核对', expected_remark: '{"note":"普通历史 JSON"}' }, actor))
    .toEqual({ id: 10, remark: '核对' });
  await expect(service().remark(10, { remark: '', expected_remark: '核对' }, actor)).rejects.toThrow('备注无效');
  await expect(service().remark(10, { remark: 'x'.repeat(201), expected_remark: '核对' }, actor)).rejects.toThrow('备注无效');
  await expect(service().remark(10, { remark: 'x', expected_remark: '核对', mark: 'wrong' }, actor))
    .rejects.toThrow('字段无效');
});

it('rolls back the ledger update if the audit insert fails', async () => {
  await fixture.exec('DROP TABLE system_log');
  await expect(service().remark(1, { remark: '不能提交', expected_remark: '' }, actor)).rejects.toThrow();
  const [flow] = await fixture.db.select().from(supplierFlowingWater)
    .where((await import('drizzle-orm')).eq(supplierFlowingWater.id, 1));
  expect(flow.remark).toBe('');
});

it('refuses a silent partial export above the 5000-row cap', async () => {
  for (let offset = 0; offset < 5_001; offset += 500) {
    await fixture.db.insert(supplierFlowingWater).values(
      Array.from({ length: Math.min(500, 5_001 - offset) }, (_, index) => ({
        id: 10_000 + offset + index, supplierId: 1, orderId: `EXPORT-${offset + index}`,
        number: '1.00', pm: 1, addTime: sep1,
      })),
    );
  }
  await expect(service().export(query('supplier_id=1'))).rejects.toThrow('超过5000行');
}, 60_000);
