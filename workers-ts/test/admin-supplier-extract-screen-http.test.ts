import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { supplierExtract, supplierFlowingWater, systemAdmin, systemLog, systemMenus, systemRole, systemSupplier } from '../src/models/schema';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated supplier extract fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated supplier extract fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-supplier-extract-only', UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'supplier-extract-role';
const identities = { reader: 9901, manager: 9902, legacyPage: 9903,
  wrongLegacy: 9904, other: 9905 } as const;
const tokens = new Map<keyof typeof identities, string>();

beforeEach(async () => {
  fixture = await financePostgres([systemAdmin, systemRole, systemMenus, systemSupplier,
    supplierExtract, supplierFlowingWater, systemLog]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(systemSupplier).values([
    { id: 1, adminId: 1, supplierName: '甲供应商' },
    { id: 2, adminId: 2, supplierName: '已停用乙', isShow: 0 },
  ]);
  await fixture.db.insert(supplierFlowingWater).values({ supplierId: 1,
    number: '30.00', pm: 1, status: 1 });
  await fixture.db.insert(supplierExtract).values({ id: 1, supplierId: 1,
    extractPrice: '10.00', supplierMark: '旧备注', status: 0, payStatus: 0,
    addTime: Math.floor(Date.parse('2026-09-01T12:00:00+08:00') / 1000) });
  await fixture.db.insert(systemMenus).values([
    { id: 1578, menuName: '转账申请', authType: 1, type: 1,
      menuPath: '/admin/supplier/cash/index', uniqueAuth: 'admin-supplier-cash-index' },
    { id: 1579, menuName: '伪转账申请', authType: 1, type: 1,
      menuPath: '/admin/supplier/cash/index', uniqueAuth: 'not-admin-supplier-cash-index' },
  ]);
  const rules: Record<keyof typeof identities, string> = {
    reader: 'supplier_extract.view', manager: 'supplier_extract.manage',
    legacyPage: '1578', wrongLegacy: '1579', other: 'supplier_bill.view',
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Supplier extract ${name}`, rules: rules[name as keyof typeof identities],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `supplier-extract-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as keyof typeof identities,
      (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
  }
}, 30_000);
afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(base: string, name: keyof typeof identities | 'anonymous', path: string,
  method = 'GET', data?: Record<string, unknown>) {
  const response = await app.request(`${base}/${path}`, { method,
    headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}`,
      ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }, env);
  return { status: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: any }>() };
}

it.each(['/adminapi', '/api/admin'])('enforces independent supplier extract view and manage grants on %s', async base => {
  for (const path of ['supplier/extract/suppliers', 'supplier/extract/list']) {
    for (const name of ['anonymous', 'wrongLegacy', 'other'] as const) {
      expect((await request(base, name, path)).body.status).not.toBe(200);
    }
    for (const name of ['reader', 'manager', 'legacyPage'] as const) {
      expect((await request(base, name, path)).body.status).toBe(200);
    }
  }
  const suppliers = await request(base, 'reader', 'supplier/extract/suppliers');
  expect(suppliers.cache).toContain('no-store');
  expect(suppliers.body).toMatchObject({ status: 200, data: { list: [
    { id: 2, supplierName: '已停用乙' }, { id: 1, supplierName: '甲供应商' },
  ] } });
  const list = await request(base, 'reader', 'supplier/extract/list?supplier_id=1&limit=15');
  expect(list.body).toMatchObject({ status: 200, data: { count: 1, limit: 15,
    extract_statistics: { withdrawable: '20.00' } } });
  for (const path of ['supplier/extract/verify/1', 'supplier/extract/save_transfer/1',
    'supplier/extract/mark/1']) {
    for (const name of ['reader', 'legacyPage', 'other', 'wrongLegacy'] as const) {
      expect((await request(base, name, path, 'POST',
        path.endsWith('mark/1') ? { mark: '越权', expected_supplier_mark: '旧备注' } : { type: 1 })).body.status)
        .not.toBe(200);
    }
  }
});

it('keeps legacy menu 1578 to view only and performs a guarded, visible note update', async () => {
  const permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
  expect(await permissions.resolveRulePermissionKeys('1578')).toContain('supplier_extract.view');
  expect(await permissions.resolveRulePermissionKeys('1578')).not.toContain('supplier_extract.manage');
  expect(await permissions.resolveManyRulePermissionKeys(['1578', '1579']))
    .toEqual([['supplier_extract.view'], []]);
  expect(await permissions.resolveRulePermissionKeys('1579')).not.toContain('supplier_extract.view');
  for (const base of ['/adminapi', '/api/admin']) {
    expect(requiredAdminPermission('GET', `${base}/supplier/extract/suppliers`)).toBe('supplier_extract.view');
    expect(requiredAdminPermission('GET', `${base}/supplier/extract/list`)).toBe('supplier_extract.view');
    expect(requiredAdminPermission('POST', `${base}/supplier/extract/mark/1`)).toBe('supplier_extract.manage');
    expect(requiredAdminPermission('POST', `${base}/supplier/extract/verify/1`)).toBe('supplier_extract.manage');
    expect(requiredAdminPermission('POST', `${base}/supplier/extract/save_transfer/1`)).toBe('supplier_extract.manage');
  }
  const updated = await request('/adminapi', 'manager', 'supplier/extract/mark/1', 'POST',
    { mark: '后台确认', expected_supplier_mark: '旧备注' });
  expect(updated).toMatchObject({ status: 200,
    body: { status: 200, data: { id: 1, supplierMark: '后台确认' } } });
  const list = await request('/api/admin', 'reader', 'supplier/extract/list');
  expect(list.body.data.list[0]).toMatchObject({ id: 1, supplierMark: '后台确认', mark: '' });
  const conflict = await request('/api/admin', 'manager', 'supplier/extract/mark/1', 'POST',
    { mark: '过期版本', expected_supplier_mark: '旧备注' });
  expect(conflict.status).toBe(409);
  expect((await fixture.db.select().from(systemLog))).toHaveLength(1);
  const legacyRefusal = await request('/adminapi', 'manager', 'supplier/extract/verify/1', 'POST',
    { type: '2', message: '旧后台拒绝语义' });
  expect(legacyRefusal.body.status).toBe(200);
  const refused = await request('/api/admin', 'reader', 'supplier/extract/list?status=-1');
  expect(refused.body).toMatchObject({ status: 200, data: { count: 1,
    list: [{ id: 1, status: -1, failMsg: '旧后台拒绝语义' }] } });
});
