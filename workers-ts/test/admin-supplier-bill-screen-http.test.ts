import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { supplierFlowingWater, systemAdmin, systemMenus, systemRole, systemSupplier, user } from '../src/models/schema';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated supplier bill fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated supplier bill fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-supplier-bill-only', UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'supplier-bill-role';
const identities = { reader: 9801, billOnly: 9802, extractOnly: 9803,
  legacyPage: 9804 } as const;
const tokens = new Map<keyof typeof identities, string>();

beforeEach(async () => {
  fixture = await financePostgres([systemAdmin, systemRole, systemMenus, systemSupplier,
    supplierFlowingWater, user]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(systemSupplier).values([
    { id: 1, adminId: 1, supplierName: '甲' },
    { id: 2, adminId: 2, supplierName: '乙' },
  ]);
  await fixture.db.insert(supplierFlowingWater).values([
    { id: 1, supplierId: 1, orderId: 'A-1', pm: 1, number: '6.00',
      addTime: Math.floor(Date.parse('2026-09-01T12:00:00+08:00') / 1000) },
    { id: 2, supplierId: 2, orderId: 'B-1', pm: 0, number: '2.00',
      addTime: Math.floor(Date.parse('2026-09-01T13:00:00+08:00') / 1000) },
  ]);
  await fixture.db.insert(systemMenus).values([
    { id: 17001, menuName: '供应商账单', authType: 1, type: 1,
      menuPath: '/admin/supplier/bill/index', uniqueAuth: 'admin-supplier-bill-index' },
    { id: 17002, menuName: '供应商入驻', authType: 1, type: 1,
      menuPath: '/admin/supplier/apply', uniqueAuth: 'admin-supplier-apply' },
  ]);
  const rules: Record<keyof typeof identities, string> = {
    reader: 'supplier_bill.view', billOnly: 'bill.view',
    extractOnly: 'supplier_extract.view', legacyPage: '17001',
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Supplier bill ${name}`, rules: rules[name as keyof typeof identities],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `supplier-bill-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as keyof typeof identities,
      (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
  }
}, 30_000);
afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(base: string, name: keyof typeof identities | 'anonymous', path: string,
  method = 'GET') {
  const response = await app.request(`${base}/${path}`, {
    method, headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}` },
  }, env);
  return { status: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: any }>() };
}

it.each(['/adminapi', '/api/admin'])('protects supplier bill reads with a separate capability on %s', async base => {
  for (const path of ['supplier/bill-screen/suppliers', 'supplier/bill-screen/groups',
    'supplier/bill-screen/details?period=2026-09-01',
    'supplier/bill-screen/export?period=2026-09-01&supplier_id=1']) {
    for (const name of ['anonymous', 'billOnly', 'extractOnly'] as const) {
      expect((await request(base, name, path)).body.status).not.toBe(200);
    }
    expect((await request(base, 'reader', path)).body.status).toBe(200);
    expect((await request(base, 'legacyPage', path)).body.status).toBe(200);
  }
  const groups = await request(base, 'reader', 'supplier/bill-screen/groups?timeType=day&supplier_id=1');
  expect(groups.cache).toContain('no-store');
  expect(groups.body).toMatchObject({ status: 200, data: { list: [
    { period: '2026-09-01', income_num: '6.00', exp_num: '0.00' }], count: 1 } });
  const details = await request(base, 'reader',
    'supplier/bill-screen/details?timeType=day&period=2026-09-01&supplier_id=1');
  expect(details.body).toMatchObject({ status: 200, data: { count: 1,
    list: [{ order_id: 'A-1', supplier_id: 1 }] } });
  const exported = await request(base, 'reader',
    'supplier/bill-screen/export?timeType=day&period=2026-09-01&supplier_id=1');
  expect(exported.body).toMatchObject({ status: 200, data: { count: 1,
    export: [{ order_id: 'A-1', pm: '收入' }] } });
  expect((await request(base, 'reader', 'supplier/flowing_water/fund_record_info?ids=1')).body.status)
    .not.toBe(200);
});

it('rejects ID-list compatibility claims, malformed queries, and writes', async () => {
  for (const path of ['supplier/bill-screen/details?ids=1,2',
    'supplier/bill-screen/details?period=2026-09-01&supplier_id=999',
    'supplier/bill-screen/export?period=2026-09-01&page=1',
    'supplier/bill-screen/groups?timeType=week&timeType=day',
    'supplier/bill-screen/groups?data=2026%2F09%2F31-2026%2F09%2F31']) {
    expect((await request('/adminapi', 'reader', path)).body.status).not.toBe(200);
  }
  expect((await request('/adminapi', 'reader', 'supplier/bill-screen/groups', 'POST')).body.status)
    .not.toBe(200);
});

it('maps the audited legacy page to supplier_bill.view without granting other supplier capabilities', async () => {
  const perms = new AdminPermissionService(createContainerFromDb(fixture.db));
  expect(await perms.resolveRulePermissionKeys('17001')).toContain('supplier_bill.view');
  expect(await perms.resolveRulePermissionKeys('17002')).not.toContain('supplier_bill.view');
  expect(perms.buildMenus(new Set(['supplier_bill.view'])).map(row => row.path))
    .toEqual(['/supplier/bills']);
  for (const base of ['/adminapi', '/api/admin']) {
    for (const action of ['suppliers', 'groups', 'details', 'export']) {
      expect(requiredAdminPermission('GET', `${base}/supplier/bill-screen/${action}`))
        .toBe('supplier_bill.view');
    }
    expect(requiredAdminPermission('GET', `${base}/supplier/extract/list`))
      .toBe('supplier_extract.view');
  }
});
