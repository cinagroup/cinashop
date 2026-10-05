import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { storeOrder, storeOrderRefund, systemAdmin, systemMenus, systemRole, systemSupplier } from '../src/models/schema';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated supplier statistics fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated supplier statistics fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-supplier-statistics-only', UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'supplier-statistics-role';
const identities = { reader: 9801, capitalOnly: 9802, legacyStatistics: 9803,
  legacyList: 9804 } as const;
const tokens = new Map<keyof typeof identities, string>();
const time = 'time=2026%2F09%2F01-2026%2F09%2F01';

beforeEach(async () => {
  fixture = await financePostgres([systemAdmin, systemRole, systemMenus, systemSupplier,
    storeOrder, storeOrderRefund]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(systemSupplier).values({ id: 1, adminId: 1, supplierName: '甲' });
  await fixture.db.insert(storeOrder).values({ id: 1, orderId: 'A-1', supplierId: 1,
    paid: 1, payPrice: '6.00', addTime: Math.floor(Date.parse('2026-09-01T12:00:00+08:00') / 1000) });
  await fixture.db.insert(systemMenus).values([
    { id: 1455, menuName: '供应商订单统计', authType: 1, type: 1, access: 1,
      menuPath: '/admin/supplier/orderStatistics/index', uniqueAuth: 'admin-supplier-supplier_list' },
    { id: 1439, menuName: '供应商列表', authType: 1, type: 1, access: 1,
      menuPath: '/admin/supplier/supplier-supplier_list', uniqueAuth: 'admin-supplier-supplier_list' },
  ]);
  const rules: Record<keyof typeof identities, string> = {
    reader: 'supplier_order_statistics.view', capitalOnly: 'supplier_capital.view',
    legacyStatistics: '1455', legacyList: '1439',
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Stat ${name}`, rules: rules[name as keyof typeof identities],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `stat-${name}`, pwd: password, roles: String(id), level: 1,
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

it.each(['/adminapi', '/api/admin'])('protects six read-only statistics endpoints on %s', async base => {
  for (const action of ['suppliers', 'summary', 'trend', 'channel', 'type', 'supplier-table']) {
    const path = `supplier/order-statistics-screen/${action}${action === 'suppliers' ? '' : `?${time}`}`;
    for (const name of ['anonymous', 'capitalOnly', 'legacyList'] as const) {
      expect((await request(base, name, path)).body.status).not.toBe(200);
    }
    expect((await request(base, 'reader', path)).body.status).toBe(200);
    expect((await request(base, 'legacyStatistics', path)).body.status).toBe(200);
    expect(requiredAdminPermission('GET', `${base}/supplier/order-statistics-screen/${action}`))
      .toBe('supplier_order_statistics.view');
  }
  const summary = await request(base, 'reader', `supplier/order-statistics-screen/summary?${time}`);
  expect(summary.cache).toContain('no-store');
  expect(summary.body).toMatchObject({ status: 200, data: { payPrice: '6.00', payCount: 1 } });
  const table = await request(base, 'reader', `supplier/order-statistics-screen/supplier-table?${time}`);
  expect(table.body).toMatchObject({ status: 200, data: {
    count: 1, list: [{ id: 1, supplierName: '甲', orderPrice: '6.00' }] } });
  expect((await request(base, 'reader', `supplier/order-statistics-screen/summary?${time}`, 'POST')).body.status)
    .not.toBe(200);
});

it('maps only the exact legacy statistics menu despite the shared uniqueAuth', async () => {
  const perms = new AdminPermissionService(createContainerFromDb(fixture.db));
  expect(await perms.resolveRulePermissionKeys('1455')).toContain('supplier_order_statistics.view');
  expect(await perms.resolveRulePermissionKeys('1439')).not.toContain('supplier_order_statistics.view');
  expect(perms.buildMenus(new Set(['supplier_order_statistics.view'])).map(row => row.path))
    .toEqual(['/supplier/order-statistics']);
  expect(requiredAdminPermission('GET', '/adminapi/supplier/home/header'))
    .not.toBe('supplier_order_statistics.view');
});

it('rejects malformed time and extraneous query parameters', async () => {
  for (const path of ['summary', 'trend', 'channel', 'type', 'supplier-table']) {
    expect((await request('/adminapi', 'reader', `supplier/order-statistics-screen/${path}`)).body.status)
      .not.toBe(200);
    expect((await request('/adminapi', 'reader',
      `supplier/order-statistics-screen/${path}?${time}&unexpected=1`)).body.status).not.toBe(200);
  }
  expect((await request('/adminapi', 'reader', 'supplier/order-statistics-screen/suppliers?time=today')).body.status)
    .not.toBe(200);
});
