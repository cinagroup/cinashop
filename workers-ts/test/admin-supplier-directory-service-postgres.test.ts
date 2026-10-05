import { compare } from 'bcryptjs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeOrder, storeProduct, supplierExtract, supplierFlowingWater,
  systemAdmin, systemLog, systemSupplier } from '../src/models/schema';
import { AdminSupplierDirectoryService } from '../src/services/admin/AdminSupplierDirectoryService';
import { financePostgres } from './helpers/financePostgres';

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminSupplierDirectoryService(createContainerFromDb(fixture.db));
const actor = { id: 91, name: '目录管理员', ip: '127.0.0.1' };
const form = (account = 'manual-supplier') => ({
  supplier_name: '手工供应商', name: '联系人', phone: '13800138000',
  email: 'owner@example.com', address: '广东省深圳市南山区',
  province: 1, city: 2, area: 3, street: 0, detailed_address: '科技园',
  mark: '线下签约', account, pwd: 'A-strong-password-2026',
  conf_pwd: 'A-strong-password-2026', sort: 12, is_show: 1,
});

beforeEach(async () => {
  fixture = await financePostgres([systemSupplier, systemAdmin, storeOrder,
    storeProduct, supplierExtract, supplierFlowingWater, systemLog]);
}, 30_000);
afterEach(async () => { await fixture?.close(); });

it('lists active and disabled directory entries, omits retired ones and never returns password hashes', async () => {
  await fixture.db.insert(systemSupplier).values([
    { id: 1, adminId: 101, supplierName: '甲公司', name: '甲', phone: '13800138001',
      addTime: Math.floor(Date.parse('2026-09-01T00:00:00+08:00') / 1000) },
    { id: 2, adminId: 102, supplierName: '乙公司', isShow: 0 },
    { id: 3, adminId: 103, supplierName: '甲已删', isDel: 1 },
  ]);
  await fixture.db.insert(systemAdmin).values([
    { id: 101, adminType: 4, relationId: 1, account: 'a', pwd: 'private-hash' },
    { id: 102, adminType: 4, relationId: 2, account: 'b', pwd: 'private-hash' },
    { id: 103, adminType: 4, relationId: 3, account: 'c', pwd: 'private-hash' },
  ]);
  const listed = await service().list(new URLSearchParams());
  expect(listed).toMatchObject({ count: 2, page: 1, limit: 15,
    list: [{ id: 2, is_show: 0 }, { id: 1, _add_time: '2026-09-01 00:00:00' }] });
  expect(listed.list[0].revision).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(listed)).not.toContain('private-hash');
  expect((await service().list(new URLSearchParams('keywords=%E7%94%B2'))).list.map(row => row.id)).toEqual([1]);
  expect((await service().list(new URLSearchParams('page=2&limit=1'))).list.map(row => row.id)).toEqual([1]);
  expect(await service().detail(1)).toMatchObject({ id: 1, account: 'a', pwd: '',
    conf_pwd: '', province: 0, is_show: 1 });
  await expect(service().detail(3)).rejects.toThrow('不存在');
  await expect(service().detail(0)).rejects.toThrow('ID无效');
  for (const params of ['limit=0', 'page=-1', 'keywords=a&keywords=b', 'unknown=1']) {
    await expect(service().list(new URLSearchParams(params))).rejects.toThrow();
  }
});

it('atomically creates the supplier and bound primary account with a bcrypt password', async () => {
  const created = await service().create(form(), actor);
  const [supplier] = await fixture.db.select().from(systemSupplier).where(eq(systemSupplier.id, created.id));
  const [admin] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, created.admin_id));
  expect(supplier).toMatchObject({ supplierName: '手工供应商', isShow: 1,
    name: '联系人', phone: '13800138000', mark: '线下签约', adminId: admin.id });
  expect(admin).toMatchObject({ account: 'manual-supplier', adminType: 4,
    relationId: supplier.id, status: 1, isDel: 0, level: 0 });
  expect(admin.pwd).not.toContain('A-strong-password-2026');
  expect(await compare('A-strong-password-2026', admin.pwd)).toBe(true);
  expect((await fixture.db.select().from(systemLog))).toMatchObject([
    { adminId: actor.id, action: `supplier_directory.create:${supplier.id}` },
  ]);
  await expect(service().create(form('MANUAL-SUPPLIER'), actor)).rejects.toThrow('账号已存在');
  expect((await fixture.db.select().from(systemSupplier))).toHaveLength(1);
  await expect(service().create({ ...form('weak'), pwd: '1234', conf_pwd: '1234' }, actor))
    .rejects.toThrow('至少需要12位');
  await expect(service().create({ ...form('unicode'), pwd: '密'.repeat(30), conf_pwd: '密'.repeat(30) }, actor))
    .rejects.toThrow('72字节');
});

it('edits full directory details with stale-form protection and optional password replacement', async () => {
  const created = await service().create(form(), actor);
  const original = await service().detail(created.id);
  const [before] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, created.admin_id));
  const edited = await service().update(created.id, { ...form('supplier-renamed'),
    supplier_name: '已改名', pwd: '', conf_pwd: '', expected_revision: original.revision,
    expected_account: original.account }, actor);
  expect(edited).toMatchObject({ supplier_name: '已改名', account: 'supplier-renamed', pwd: '' });
  const [after] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, created.admin_id));
  expect(after.pwd).toBe(before.pwd);
  await expect(service().update(created.id, { ...form('overwrite'),
    expected_revision: original.revision, expected_account: original.account }, actor))
    .rejects.toMatchObject({ httpStatus: 409 });
  const replaced = await service().update(created.id, { ...form('supplier-renamed'),
    pwd: 'New-supplier-password-2026', conf_pwd: 'New-supplier-password-2026',
    expected_revision: edited.revision, expected_account: edited.account }, actor);
  expect(replaced.account).toBe('supplier-renamed');
  const [newAdmin] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, created.admin_id));
  expect(await compare('New-supplier-password-2026', newAdmin.pwd)).toBe(true);
  expect(newAdmin.pwd).not.toBe(before.pwd);
  expect((await fixture.db.select().from(systemLog))).toHaveLength(3);
});

it('advances revisions for identical edits and password-only changes', async () => {
  const created = await service().create(form(), actor);
  const initial = await service().detail(created.id);
  const unchanged = await service().update(created.id, { ...form(), pwd: '', conf_pwd: '',
    expected_revision: initial.revision, expected_account: initial.account }, actor);
  expect(unchanged.revision).not.toBe(initial.revision);
  await expect(service().update(created.id, { ...form(), pwd: '', conf_pwd: '',
    expected_revision: initial.revision, expected_account: initial.account }, actor))
    .rejects.toMatchObject({ httpStatus: 409 });
  const passwordOnly = await service().update(created.id, { ...form(),
    pwd: 'New-supplier-password-2026', conf_pwd: 'New-supplier-password-2026',
    expected_revision: unchanged.revision, expected_account: unchanged.account }, actor);
  expect(passwordOnly.revision).not.toBe(unchanged.revision);
  const [admin] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, created.admin_id));
  expect(await compare('New-supplier-password-2026', admin.pwd)).toBe(true);
  await expect(service().update(created.id, { ...form(), pwd: '', conf_pwd: '',
    expected_revision: unchanged.revision, expected_account: unchanged.account }, actor))
    .rejects.toMatchObject({ httpStatus: 409 });
});

it('toggles status only against the displayed revision and immediately changes active lookup', async () => {
  const created = await service().create(form(), actor);
  const current = await service().detail(created.id);
  const disabled = await service().setStatus(created.id, 0,
    { expected_revision: current.revision }, actor);
  expect(disabled).toMatchObject({ id: created.id, is_show: 0 });
  expect(await createContainerFromDb(fixture.db).systemSupplierDao.findActiveById(created.id)).toBeNull();
  await expect(service().setStatus(created.id, 1, { expected_revision: current.revision }, actor))
    .rejects.toMatchObject({ httpStatus: 409 });
  const enabled = await service().setStatus(created.id, 1,
    { expected_revision: disabled.revision }, actor);
  expect(enabled.is_show).toBe(1);
  expect(await createContainerFromDb(fixture.db).systemSupplierDao.findActiveById(created.id))
    .toMatchObject({ id: created.id });
  expect((await fixture.db.select().from(systemLog))).toHaveLength(3);
});

it('blocks unfinished orders and retires products/accounts while retaining order and finance history', async () => {
  const created = await service().create(form(), actor);
  await fixture.db.insert(systemAdmin).values({ account: 'child', adminType: 4,
    relationId: created.id, level: 2, status: 1 });
  await fixture.db.insert(storeProduct).values([
    { id: 201, type: 2, relationId: created.id, storeName: '供应商商品', isShow: 1 },
    { id: 202, type: 0, relationId: 0, storeName: '平台商品', isShow: 1 },
  ]);
  await fixture.db.insert(supplierExtract).values({ id: 301, supplierId: created.id,
    extractPrice: '10.00' });
  await fixture.db.insert(supplierFlowingWater).values({ id: 401, supplierId: created.id,
    number: '20.00' });
  await fixture.db.insert(storeOrder).values({ id: 501, orderId: 'supplier-pending',
    supplierId: created.id, status: 4 });
  const current = await service().detail(created.id);
  await expect(service().delete(created.id, { expected_revision: current.revision }, actor))
    .rejects.toThrow('待处理订单');
  expect((await fixture.db.select().from(systemSupplier))[0].isDel).toBe(0);
  await fixture.db.update(storeOrder).set({ status: 3 }).where(eq(storeOrder.id, 501));
  expect(await service().delete(created.id, { expected_revision: current.revision }, actor))
    .toEqual({ id: created.id, is_del: 1 });
  const [supplier] = await fixture.db.select().from(systemSupplier);
  expect(supplier).toMatchObject({ isDel: 1, isShow: 0 });
  expect((await fixture.db.select().from(systemAdmin)).every(row => row.isDel === 1 && row.status === 0)).toBe(true);
  expect((await fixture.db.select().from(storeProduct).where(eq(storeProduct.id, 201)))[0])
    .toMatchObject({ isDel: 1, isShow: 0 });
  expect((await fixture.db.select().from(storeProduct).where(eq(storeProduct.id, 202)))[0])
    .toMatchObject({ isDel: 0, isShow: 1 });
  expect((await fixture.db.select().from(storeOrder))).toHaveLength(1);
  expect((await fixture.db.select().from(supplierExtract))).toHaveLength(1);
  expect((await fixture.db.select().from(supplierFlowingWater))).toHaveLength(1);
  await expect(service().detail(created.id)).rejects.toThrow('不存在');
  await expect(service().delete(created.id, { expected_revision: current.revision }, actor))
    .rejects.toThrow('不存在');
});

it('serializes two manual creations for one account', async () => {
  const outcomes = await Promise.allSettled([
    service().create(form('same-account'), actor),
    service().create(form('SAME-ACCOUNT'), actor),
  ]);
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
  expect((await fixture.db.select().from(systemSupplier))).toHaveLength(1);
  expect((await fixture.db.select().from(systemAdmin))).toHaveLength(1);
});
