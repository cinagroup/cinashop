import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { cityArea, storeOrder, storeProduct, systemAdmin, systemLog, systemMenus,
  systemRole, systemSupplier } from '../src/models/schema';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Supplier directory fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Supplier directory fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-supplier-directory-http-only',
  UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const identities = { reader: 9701, manager: 9702, legacyPage: 9703,
  unrelated: 9704 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
let supplierToken = '';
const supplierPasswordHash = 'supplier-directory-token-hash';
const revisionPattern = /^[0-9a-f]{64}$/;
const form = (account = 'new-directory-supplier') => ({
  supplier_name: '新建供应商', name: '联系人', phone: '13800138000',
  email: 'owner@example.com', address: '广东省深圳市南山区',
  province: 1, city: 2, area: 3, street: 4, detailed_address: '科技园',
  mark: '线下签约', account, pwd: 'Strong-password-2026',
  conf_pwd: 'Strong-password-2026', sort: 12, is_show: 1,
});

beforeEach(async () => {
  fixture = await financePostgres([cityArea, systemAdmin, systemRole, systemMenus,
    systemSupplier, systemLog, storeOrder, storeProduct]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(cityArea).values([
    { id: 1, parentId: 0, name: '广东省', level: 1 },
    { id: 2, parentId: 1, name: '深圳市', level: 2 },
    { id: 3, parentId: 2, name: '南山区', level: 3 },
    { id: 4, parentId: 3, name: '粤海街道', level: 4 },
  ]);
  await fixture.db.insert(systemMenus).values({
    id: 1458, menuName: '供应商目录', authType: 1, type: 1,
    menuPath: '/admin/supplier/menu/list', uniqueAuth: 'admin-supplier-menu-list',
  });
  const rules: Record<Identity, string> = {
    reader: 'supplier_directory.view', manager: 'supplier_directory.manage',
    legacyPage: '1458', unrelated: 'supplier_application.view',
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: 'Directory ' + name, rules: rules[name as Identity],
  })));
  await fixture.db.insert(systemSupplier).values({
    id: 100, adminId: 2000, supplierName: '在营供应商', name: '联系人',
    phone: '13800138000', province: 1, city: 2, area: 3, street: 4,
    address: '广东省深圳市南山区', detailedAddress: '科技园', isShow: 1,
  });
  await fixture.db.insert(systemAdmin).values([
    ...Object.entries(identities).map(([name, id]) => ({
      id, account: 'directory-' + name, pwd: 'admin-password', roles: String(id),
      level: 1, adminType: 1, status: 1, isDel: 0,
    })),
    { id: 2000, account: 'supplier-existing', pwd: supplierPasswordHash,
      adminType: 4, relationId: 100, level: 0, status: 1, isDel: 0 },
  ]);
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as Identity,
      (await createToken(id, 'admin', md5('admin-password'), env.APP_KEY)).token);
  }
  supplierToken = (await createToken(2000, 'supplier',
    md5(supplierPasswordHash), env.APP_KEY)).token;
}, 30_000);

afterEach(async () => {
  wiring.container = undefined; tokens.clear(); supplierToken = '';
  await fixture?.close();
});

async function request(base: string, name: Identity | 'anonymous', path: string,
  method = 'GET', data?: Record<string, unknown>) {
  const response = await app.request(base + '/' + path, {
    method,
    headers: name === 'anonymous' ? {} : {
      Authorization: 'Bearer ' + tokens.get(name),
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }, env);
  return { status: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: any }>() };
}

async function supplierRequest(method: string, data?: Record<string, unknown>) {
  const response = await app.request('/supplierapi/supplier', {
    method, headers: {
      Authorization: 'Bearer ' + supplierToken,
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }, env);
  return response.json<{ status: number; msg: string; data: any }>();
}

it.each(['/adminapi', '/api/admin'])('protects directory reads, writes and lazy cities on %s', async base => {
  const prefix = 'supplier/supplier';
  for (const path of [prefix, prefix + '/100', prefix + '/cities?pid=0']) {
    for (const name of ['anonymous', 'unrelated'] as const) {
      expect((await request(base, name, path)).body.status).not.toBe(200);
    }
    for (const name of ['reader', 'manager', 'legacyPage'] as const) {
      expect((await request(base, name, path)).body.status).toBe(200);
    }
  }
  const list = await request(base, 'reader', prefix + '?keywords=%E5%9C%A8%E8%90%A5');
  expect(list).toMatchObject({ body: { status: 200, data: {
    count: 1, list: [{ id: 100, supplier_name: '在营供应商' }],
  } } });
  expect(list.body.data.list[0].revision).toMatch(revisionPattern);
  expect(list.cache).toContain('no-store');
  const detail = await request(base, 'reader', prefix + '/100');
  expect(detail.body.data).toMatchObject({ id: 100, account: 'supplier-existing',
    pwd: '', conf_pwd: '' });
  expect(JSON.stringify(detail.body)).not.toContain(supplierPasswordHash);
  for (const [pid, expected, parent] of [[0, '广东省', '中国'],
    [1, '深圳市', '广东省'], [2, '南山区', '深圳市'],
    [3, '粤海街道', '南山区']] as const) {
    const cities = await request(base, 'reader', prefix + '/cities?pid=' + pid);
    expect(cities.body.data).toMatchObject([{ value: pid + 1, id: pid + 1,
      label: expected, pid, level: pid + 1, parent_name: parent }]);
  }
  for (const [method, path, data] of [
    ['POST', prefix, form()],
    ['PUT', prefix + '/100', { ...form(), expected_revision: detail.body.data.revision,
      expected_account: 'supplier-existing' }],
    ['PUT', prefix + '/set_status/100/0',
      { expected_revision: detail.body.data.revision }],
    ['DELETE', prefix + '/100', { expected_revision: detail.body.data.revision }],
  ] as const) {
    for (const name of ['reader', 'legacyPage', 'unrelated'] as const) {
      expect((await request(base, name, path, method, data)).body.status).not.toBe(200);
    }
  }
  expect(requiredAdminPermission('GET', base + '/' + prefix + '/cities'))
    .toBe('supplier_directory.view');
  expect(requiredAdminPermission('DELETE', base + '/' + prefix + '/100'))
    .toBe('supplier_directory.manage');
  expect((await fixture.db.select().from(systemSupplier).where(eq(systemSupplier.id, 100)))[0])
    .toMatchObject({ isShow: 1, isDel: 0 });
});

it.each(['/adminapi', '/api/admin'])('requires current revisions and account on %s', async base => {
  const prefix = 'supplier/supplier';
  const detail = (await request(base, 'manager', prefix + '/100')).body.data;
  const current = detail.revision as string;
  expect(current).toMatch(revisionPattern);
  for (const [path, method, data] of [
    [prefix + '/100', 'PUT', { ...form('supplier-existing'), pwd: '', conf_pwd: '',
      expected_account: 'supplier-existing' }],
    [prefix + '/set_status/100/0', 'PUT', {}],
    [prefix + '/100', 'DELETE', {}],
  ] as const) {
    expect((await request(base, 'manager', path, method, data)).body.status).toBe(400);
  }
  for (const [path, method, data] of [
    [prefix + '/100', 'PUT', { ...form('supplier-existing'), pwd: '', conf_pwd: '',
      expected_revision: '0'.repeat(64), expected_account: 'supplier-existing' }],
    [prefix + '/set_status/100/0', 'PUT', { expected_revision: '0'.repeat(64) }],
    [prefix + '/100', 'DELETE', { expected_revision: '0'.repeat(64) }],
  ] as const) {
    const stale = await request(base, 'manager', path, method, data);
    expect(stale.status).toBe(409);
    expect(stale.body.status).toBe(409);
  }
  const wrongAccount = await request(base, 'manager', prefix + '/100', 'PUT',
    { ...form('supplier-existing'), pwd: '', conf_pwd: '',
      expected_revision: current, expected_account: 'other' });
  expect(wrongAccount.body.status).toBe(409);
  const updated = await request(base, 'manager', prefix + '/100', 'PUT',
    { ...form('supplier-existing'), pwd: '', conf_pwd: '',
      expected_revision: current, expected_account: 'supplier-existing' });
  expect(updated.body.status).toBe(200);
  expect(updated.body.data.revision).toMatch(revisionPattern);
  expect(updated.body.data.revision).not.toBe(current);
  expect((await request(base, 'manager', prefix + '/set_status/100/0', 'PUT',
    { expected_revision: current })).body.status).toBe(409);
  const created = await request(base, 'manager', prefix, 'POST', form());
  expect(created.body).toMatchObject({ status: 200, data: {
    id: expect.any(Number), admin_id: expect.any(Number),
  } });
  const createdDetail = await request(base, 'manager',
    prefix + '/' + created.body.data.id);
  expect(createdDetail.body.data.account).toBe('new-directory-supplier');
  expect(JSON.stringify(createdDetail.body)).not.toContain('Strong-password-2026');
});

it('disabled supplier sessions cannot write; pending orders block retirement across route prefixes', async () => {
  const prefix = 'supplier/supplier';
  const before = await supplierRequest('GET');
  expect(before.status).toBe(200);
  const current = (await request('/adminapi', 'manager', prefix + '/100')).body.data.revision;
  const disabled = await request('/adminapi', 'manager',
    prefix + '/set_status/100/0', 'PUT', { expected_revision: current });
  expect(disabled.body).toMatchObject({ status: 200, data: { id: 100, is_show: 0 } });
  const rejectedWrite = await supplierRequest('PUT', { supplier_name: '越权改名' });
  expect(rejectedWrite.status).not.toBe(200);
  expect((await fixture.db.select().from(systemSupplier).where(eq(systemSupplier.id, 100)))[0])
    .toMatchObject({ supplierName: '在营供应商', isDel: 0 });
  await fixture.db.insert(storeOrder).values({
    id: 500, orderId: 'supplier-pending-http', supplierId: 100, status: 4,
  });
  const blocked = await request('/api/admin', 'manager', prefix + '/100', 'DELETE',
    { expected_revision: disabled.body.data.revision });
  expect(blocked.body.status).not.toBe(200);
  expect(blocked.body.msg).toContain('待处理订单');
  await fixture.db.update(storeOrder).set({ status: 3 }).where(eq(storeOrder.id, 500));
  await fixture.db.insert(storeProduct).values({
    id: 600, type: 2, relationId: 100, storeName: '待下架商品', isShow: 1,
  });
  const retired = await request('/api/admin', 'manager', prefix + '/100', 'DELETE',
    { expected_revision: disabled.body.data.revision });
  expect(retired.body).toMatchObject({ status: 200, data: { id: 100, is_del: 1 } });
  expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 2000)))[0])
    .toMatchObject({ status: 0, isDel: 1 });
  expect((await fixture.db.select().from(storeProduct).where(eq(storeProduct.id, 600)))[0])
    .toMatchObject({ isShow: 0, isDel: 1 });
  expect((await supplierRequest('PUT', { supplier_name: '删除后写入' })).status).not.toBe(200);
});

it('exposes Supplier profile revision and rejects stale same-field PUT over Admin edits', async () => {
  const supplierView = await supplierRequest('GET');
  expect(supplierView.data.revision).toMatch(revisionPattern);
  const originalRevision = supplierView.data.revision as string;
  const directory = (await request('/adminapi', 'manager', 'supplier/supplier/100')).body.data;
  const adminEdit = await request('/adminapi', 'manager', 'supplier/supplier/100', 'PUT', {
    ...form('supplier-existing'), name: '管理员新联系人', pwd: '', conf_pwd: '',
    expected_revision: directory.revision, expected_account: directory.account,
  });
  expect(adminEdit.body.status).toBe(200);
  const stale = await supplierRequest('PUT', {
    name: '供应商旧页面联系人', expected_revision: originalRevision,
  });
  expect(stale.status).toBe(409);
  expect((await fixture.db.select().from(systemSupplier).where(eq(systemSupplier.id, 100)))[0].name)
    .toBe('管理员新联系人');
});
