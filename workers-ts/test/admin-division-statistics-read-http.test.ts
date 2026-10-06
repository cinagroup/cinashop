import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { financePostgres } from './helpers/financePostgres';
import { storeOrder, systemAdmin, systemMenus, systemRole, user } from '../src/models/schema';
import { AdminPermissionService } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated division statistics fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated division statistics fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let f: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-division-statistics-only', UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'isolated-division-statistics-role';
const identities = { reader: 9901, manager: 9902, legacyPage: 9903,
  unrelatedPage: 9904, unbound: 9905 } as const;
const tokens = new Map<keyof typeof identities, string>();

beforeEach(async () => {
  f = await financePostgres([systemAdmin, systemRole, systemMenus, user, storeOrder]);
  wiring.container = createContainerFromDb(f.db);
  await f.db.insert(user).values([
    { uid: 101, nickname: '事业部甲', divisionType: 1 },
    { uid: 111, nickname: '代理商甲', divisionType: 2, divisionId: 101 },
  ]);
  await f.db.insert(storeOrder).values({ id: 701, orderId: 'DIV-701',
    divisionId: 101, paid: 1, pid: 0, payPrice: '12.50',
    addTime: Math.floor(Date.parse('2026-09-01T00:00:00+08:00') / 1000) });
  await f.db.insert(systemMenus).values([
    { id: 1615, menuName: '团队统计', authType: 1, type: 1,
      menuPath: '/admin/agent/statistics', uniqueAuth: 'agent-division-statistics' },
    { id: 1609, menuName: '区域代理列表', authType: 1, type: 1,
      menuPath: '/admin/agent/division_list', uniqueAuth: 'agent-division-index' },
  ]);
  const rules: Record<keyof typeof identities, string> = {
    reader: 'division_statistics.view', manager: 'division.view,division.manage',
    legacyPage: '1615', unrelatedPage: '1609', unbound: 'division_statistics.view',
  };
  await f.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Division ${name}`, rules: rules[name as keyof typeof identities],
  })));
  await f.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `division-stat-${name}`, pwd: password, roles: String(id), level: 1,
    divisionId: name === 'unbound' ? 0 : 101, adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as keyof typeof identities,
      (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
  }
}, 30_000);
afterEach(async () => { wiring.container = undefined; tokens.clear(); await f?.close(); });

async function request(base: string, name: keyof typeof identities | 'anonymous', path: string,
  method = 'GET') {
  const response = await app.request(`${base}/agent/division/${path}`, {
    method, headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}` },
  }, env);
  return { status: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: Record<string, unknown> | null }>() };
}

it.each(['/adminapi', '/api/admin'])('isolates all three read routes under %s', async base => {
  for (const action of ['summary', 'trend?time=2026%2F09%2F01-2026%2F09%2F01', 'ranking']) {
    const path = `statistics-screen/${action}`;
    for (const name of ['anonymous','manager','unrelatedPage'] as const) {
      expect((await request(base, name, path)).body.status).not.toBe(200);
    }
    expect((await request(base, 'reader', path)).body.status).toBe(200);
    expect((await request(base, 'legacyPage', path)).body.status).toBe(200);
  }
  const summary = await request(base, 'reader', 'statistics-screen/summary');
  expect(summary.cache).toContain('no-store');
  expect(summary.body).toMatchObject({ status: 200, data: { divisionNum: 1,
    agentNum: 1, staffNum: 0, orderNum: 1, orderPrice: '12.50', brokeragePrice: '0.00' } });
  const trend = await request(base, 'reader', 'statistics-screen/trend?time=2026%2F09%2F01-2026%2F09%2F01');
  expect(trend.body).toMatchObject({ status: 200, data: { series: [
    { name: '订单金额', type: 'line' }, { name: '订单量', type: 'line' } ] } });
  expect((trend.body.data?.xAxis as string[])).toHaveLength(24);
  expect((await request(base, 'reader', 'statistics-screen/ranking')).body)
    .toMatchObject({ status: 200, data: { list: [{ uid: 111, nickname: '代理商甲',
      spreadAgent: 0, spreadStaff: 0, orderPrice: '0.00' }] } });
  expect((await request(base, 'reader', 'statistics')).body.status).not.toBe(200);
  expect((await request(base, 'manager', 'statistics')).body.status).toBe(200);
});

it('rejects malformed queries, writes, and nonroot admins without a bound division', async () => {
  for (const path of ['statistics-screen/summary?time=today',
    'statistics-screen/ranking?limit=501',
    'statistics-screen/trend',
    'statistics-screen/trend?time=2026%2F09%2F01-2026%2F09%2F01&time=2026%2F09%2F02-2026%2F09%2F02',
    'statistics-screen/trend?time=2026%2F09%2F30-2026%2F09%2F01']) {
    expect((await request('/adminapi', 'reader', path)).body.status).not.toBe(200);
  }
  expect((await request('/adminapi', 'reader', 'statistics-screen/summary', 'POST')).body.status)
    .not.toBe(200);
  expect((await request('/adminapi', 'unbound', 'statistics-screen/summary')).body.status)
    .not.toBe(200);
});

it('maps only the audited legacy statistics page rule to the new grant', async () => {
  const perms = new AdminPermissionService(createContainerFromDb(f.db));
  expect(await perms.resolveRulePermissionKeys('1615')).toContain('division_statistics.view');
  expect(await perms.resolveRulePermissionKeys('1609')).not.toContain('division_statistics.view');
  expect(perms.buildMenus(new Set(['division_statistics.view'])).map(row => row.path))
    .toEqual(['/division/statistics']);
});
