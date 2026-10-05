import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemLog, systemSupplier } from '../src/models/schema';
import { AdminSupplierDirectoryService } from '../src/services/admin/AdminSupplierDirectoryService';
import { SupplierService, normalizeSupplierProfileInput } from '../src/services/supplier/SupplierService';
import { financePostgres } from './helpers/financePostgres';

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const env = { APP_KEY: 'supplier-profile-directory-test' } as Env;
const actor = { id: 91, name: '目录管理员', ip: '127.0.0.1' };
const fullForm = (account: string) => ({
  supplier_name: '在营供应商', name: '原联系人', phone: '13800138000',
  email: 'owner@example.com', address: '原地址', province: 1, city: 2,
  area: 3, street: 0, detailed_address: '门牌一', mark: '原备注',
  account, pwd: '', conf_pwd: '', sort: 0, is_show: 1,
});
const supplierService = () => new SupplierService(createContainerFromDb(fixture.db), env);
const directoryService = () => new AdminSupplierDirectoryService(createContainerFromDb(fixture.db));

beforeEach(async () => {
  fixture = await financePostgres([systemSupplier, systemAdmin, systemLog]);
  await fixture.db.insert(systemSupplier).values([
    { id: 1, adminId: 101, supplierName: '在营供应商', name: '原联系人',
      phone: '13800138000', email: 'owner@example.com', address: '原地址',
      province: 1, city: 2, area: 3, detailedAddress: '门牌一', mark: '原备注' },
    { id: 2, adminId: 102, supplierName: '另一供应商', name: '另一联系人',
      phone: '13800138001' },
  ]);
  await fixture.db.insert(systemAdmin).values([
    { id: 101, adminType: 4, relationId: 1, account: 'primary-a',
      pwd: 'hash-a', realName: '原联系人', phone: '13800138000', status: 1 },
    { id: 102, adminType: 4, relationId: 2, account: 'primary-b',
      pwd: 'hash-b', status: 1 },
    { id: 103, adminType: 4, relationId: 1, account: 'child-a',
      pwd: 'hash-child', level: 2, status: 1 },
    { id: 104, adminType: 1, account: 'platform-admin', pwd: 'hash-platform', status: 1 },
  ]);
}, 30_000);
afterEach(async () => { await fixture?.close(); });

it('preserves Admin-only and omitted supplier fields during a Supplier patch', async () => {
  const initial = await directoryService().detail(1);
  const adminEdit = await directoryService().update(1, {
    ...fullForm('primary-a'), address: '管理员新地址', province: 11, city: 12,
    area: 13, detailed_address: '管理员门牌', mark: '管理员备注',
    expected_revision: initial.revision, expected_account: initial.account,
  }, actor);
  await supplierService().updateProfile(1, 101, { name: '供应商新联系人' });
  const [supplier] = await fixture.db.select().from(systemSupplier).where(eq(systemSupplier.id, 1));
  expect(supplier).toMatchObject({
    name: '供应商新联系人', address: '管理员新地址', province: 11, city: 12,
    area: 13, detailedAddress: '管理员门牌', mark: '管理员备注',
  });
  const [primary] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 101));
  expect(primary).toMatchObject({ account: 'primary-a', realName: '供应商新联系人' });
  expect((await directoryService().detail(1)).revision).not.toBe(adminEdit.revision);
});

it('returns a two-row opaque revision and rejects stale same-field or primary-account edits', async () => {
  const displayed = await supplierService().profile(1, 101);
  expect(displayed.revision).toMatch(/^[0-9a-f]{64}$/);
  const directory = await directoryService().detail(1);
  await directoryService().update(1, {
    ...fullForm('primary-a'), name: '管理员改过的联系人',
    expected_revision: directory.revision, expected_account: directory.account,
  }, actor);
  await expect(supplierService().updateProfile(1, 101, {
    name: '供应商陈旧联系人', expectedRevision: displayed.revision,
  })).rejects.toMatchObject({ httpStatus: 409 });
  const [afterAdmin] = await fixture.db.select().from(systemSupplier).where(eq(systemSupplier.id, 1));
  expect(afterAdmin.name).toBe('管理员改过的联系人');
  const fresh = await supplierService().profile(1, 101);
  expect(fresh.revision).not.toBe(displayed.revision);
  await supplierService().updateProfile(1, 101, {
    name: '供应商新联系人', expectedRevision: fresh.revision,
  });
  const afterSupplier = await supplierService().profile(1, 101);
  expect(afterSupplier.name).toBe('供应商新联系人');
  expect(afterSupplier.revision).not.toBe(fresh.revision);
  await fixture.db.update(systemAdmin).set({ pwd: 'changed-password-hash' })
    .where(eq(systemAdmin.id, 101));
  const afterPassword = await supplierService().profile(1, 101);
  expect(afterPassword.revision).not.toBe(afterSupplier.revision);
  await expect(supplierService().updateProfile(1, 101, {
    name: '陈旧密码窗口', expectedRevision: afterSupplier.revision,
  })).rejects.toMatchObject({ httpStatus: 409 });
});

it('keeps missing expected_revision compatible for old clients, with explicit last-writer risk', async () => {
  expect(normalizeSupplierProfileInput({ name: '旧客户端' }).expectedRevision).toBeUndefined();
  expect(() => normalizeSupplierProfileInput({ expected_revision: 'bad' }))
    .toThrow('资料版本无效');
  const directory = await directoryService().detail(1);
  await directoryService().update(1, {
    ...fullForm('primary-a'), name: '管理员改名',
    expected_revision: directory.revision, expected_account: directory.account,
  }, actor);
  // Legacy full-form clients lack the displayed revision; keep them working
  // until their migration, while documenting that same-field overwrite remains.
  await supplierService().updateProfile(1, 101,
    normalizeSupplierProfileInput({ name: '旧客户端仍可覆盖' }));
  expect((await supplierService().profile(1, 101)).name).toBe('旧客户端仍可覆盖');
});

it('shares the global case-insensitive account namespace and keeps child accounts fixed', async () => {
  await expect(supplierService().updateProfile(1, 101, { account: 'PRIMARY-B' }))
    .rejects.toThrow('账号已存在');
  await expect(supplierService().updateProfile(1, 101, { account: 'PLATFORM-ADMIN' }))
    .rejects.toThrow('账号已存在');
  await expect(supplierService().updateProfile(1, 101, { account: '' }))
    .rejects.toThrow('不能为空');
  await expect(supplierService().updateProfile(1, 103, { account: 'child-renamed' }))
    .rejects.toThrow('子管理员不能');
  await supplierService().updateProfile(1, 101, { account: 'new-primary-a' });
  const [primary] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 101));
  expect(primary.account).toBe('new-primary-a');
});

it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)(
  'serializes Admin and Supplier same-field edits so one stale revision fails', async () => {
    const supplierView = await supplierService().profile(1, 101);
    const adminView = await directoryService().detail(1);
    const outcomes = await Promise.allSettled([
      directoryService().update(1, {
        ...fullForm('primary-a'), name: '管理员并发改名',
        expected_revision: adminView.revision, expected_account: adminView.account,
      }, actor),
      supplierService().updateProfile(1, 101, {
        name: '供应商并发改名', expectedRevision: supplierView.revision,
      }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { httpStatus: 409 } });
    const final = await supplierService().profile(1, 101);
    expect(['管理员并发改名', '供应商并发改名']).toContain(final.name);
  },
);

it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)(
  'rechecks active supplier state after waiting on an Admin row lock', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const holder = fixture.db.transaction(async tx => {
      await tx.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 1));
      entered();
      await gate;
    });
    await locked;
    const pending = supplierService().updateProfile(1, 101, { name: '不能写入' });
    await new Promise(resolve => setTimeout(resolve, 40));
    release();
    await holder;
    await expect(pending).rejects.toThrow('供应商不存在');
    const [supplier] = await fixture.db.select().from(systemSupplier).where(eq(systemSupplier.id, 1));
    expect(supplier).toMatchObject({ isShow: 0, name: '原联系人' });
  },
);

it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)(
  'serializes competing supplier account renames on separate supplier rows', async () => {
    const outcomes = await Promise.allSettled([
      supplierService().updateProfile(1, 101, { account: 'shared-account' }),
      supplierService().updateProfile(2, 102, { account: 'SHARED-ACCOUNT' }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    const admins = await fixture.db.select().from(systemAdmin);
    expect(admins.filter(row => row.account.toLowerCase() === 'shared-account')).toHaveLength(1);
  },
);
