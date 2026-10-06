import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { supplierFlowingWater, systemAdmin, systemLog, systemMenus, systemRole, systemSupplier, user } from '../src/models/schema';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated supplier capital fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated supplier capital fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-supplier-capital-only', UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'supplier-capital-role';
const identities = { reader: 9801, writer: 9802, billOnly: 9803, platformOnly: 9804,
  legacyPage: 9805 } as const;
const tokens = new Map<keyof typeof identities, string>();

beforeEach(async () => {
  fixture = await financePostgres([systemAdmin, systemRole, systemMenus, systemSupplier,
    supplierFlowingWater, user, systemLog]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(systemSupplier).values({ id: 1, adminId: 1, supplierName: '甲' });
  await fixture.db.insert(supplierFlowingWater).values({ id: 1, supplierId: 1, orderId: 'A-1',
    pm: 1, number: '6.00', addTime: Math.floor(Date.parse('2026-09-01T12:00:00+08:00') / 1000) });
  await fixture.db.insert(systemMenus).values([
    { id: 1576, menuName: '供应商资金流水', authType: 1, type: 1,
      menuPath: '/admin/supplier/capital/index', uniqueAuth: 'admin-supplier-capital-index' },
    { id: 17001, menuName: '供应商账单', authType: 1, type: 1,
      menuPath: '/admin/supplier/bill/index', uniqueAuth: 'admin-supplier-bill-index' },
  ]);
  const rules: Record<keyof typeof identities, string> = {
    reader: 'supplier_capital.view', writer: 'supplier_capital.manage',
    billOnly: 'supplier_bill.view', platformOnly: 'capital_flow.manage', legacyPage: '1576',
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Supplier capital ${name}`, rules: rules[name as keyof typeof identities],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `supplier-capital-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as keyof typeof identities,
      (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
  }
}, 30_000);
afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(base: string, name: keyof typeof identities | 'anonymous', path: string,
  method = 'GET', body?: object) {
  const response = await app.request(`${base}/${path}`, { method,
    headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined }, env);
  return { httpStatus: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: any }>() };
}

it.each(['/adminapi', '/api/admin'])('routes read and guarded remark through %s with isolated permissions', async base => {
  for (const action of ['suppliers', 'list', 'export']) {
    for (const name of ['anonymous', 'billOnly', 'platformOnly'] as const) {
      expect((await request(base, name, `supplier/capital-screen/${action}`)).body.status).not.toBe(200);
    }
    for (const name of ['reader', 'writer', 'legacyPage'] as const) {
      expect((await request(base, name, `supplier/capital-screen/${action}`)).body.status).toBe(200);
    }
  }
  const listed = await request(base, 'reader', 'supplier/capital-screen/list?supplier_id=1');
  expect(listed.cache).toContain('no-store');
  expect(listed.body).toMatchObject({ status: 200, data: { count: 1,
    list: [{ order_id: 'A-1', supplier_name: '甲', remark_editable: true }] } });
  const path = 'supplier/capital-screen/remark/1';
  const payload = { remark: '已核对', expected_remark: '' };
  for (const name of ['anonymous', 'reader', 'billOnly', 'platformOnly', 'legacyPage'] as const) {
    expect((await request(base, name, path, 'PUT', payload)).body.status).not.toBe(200);
  }
  const written = await request(base, 'writer', path, 'PUT', payload);
  expect(written).toMatchObject({ httpStatus: 200, body: { status: 200,
    data: { id: 1, remark: '已核对' } } });
  const stale = await request(base, 'writer', path, 'PUT', payload);
  expect(stale.httpStatus).toBe(409);
  expect(stale.body.status).toBe(409);
});

it('rejects malformed inputs and keeps old broad routes unavailable', async () => {
  expect((await request('/adminapi', 'reader', 'supplier/capital-screen/list?page=1&page=2')).body.status)
    .not.toBe(200);
  expect((await request('/adminapi', 'reader', 'supplier/capital-screen/export?page=1')).body.status)
    .not.toBe(200);
  expect((await request('/adminapi', 'writer', 'supplier/capital-screen/remark/abc', 'PUT',
    { remark: 'x', expected_remark: '' })).body.status).not.toBe(200);
  expect((await request('/adminapi', 'writer', 'supplier/capital-screen/remark/1', 'PUT',
    { remark: 'x' })).body.status).not.toBe(200);
  expect((await request('/adminapi', 'reader', 'supplier/flowing_water/list')).body.status).not.toBe(200);
  expect((await request('/adminapi', 'reader', 'supplierWaterExport')).body.status).not.toBe(200);
});

it('maps legacy page 1576 into supplier_capital.view only', async () => {
  const permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
  expect(await permissions.resolveRulePermissionKeys('1576')).toContain('supplier_capital.view');
  expect(await permissions.resolveRulePermissionKeys('17001')).not.toContain('supplier_capital.view');
  expect(permissions.buildMenus(new Set(['supplier_capital.view'])).map(row => row.path))
    .toEqual(['/supplier/capital-flow']);
  for (const base of ['/adminapi', '/api/admin']) {
    for (const action of ['suppliers', 'list', 'export']) {
      expect(requiredAdminPermission('GET', `${base}/supplier/capital-screen/${action}`))
        .toBe('supplier_capital.view');
    }
    expect(requiredAdminPermission('PUT', `${base}/supplier/capital-screen/remark/1`))
      .toBe('supplier_capital.manage');
    expect(requiredAdminPermission('GET', `${base}/supplier/bill-screen/groups`))
      .toBe('supplier_bill.view');
  }
});
