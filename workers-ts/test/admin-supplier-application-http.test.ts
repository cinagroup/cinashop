import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemAttachment, systemMenus, systemMessage, systemNotification,
  systemRole, systemSupplier, systemUserApply, user } from '../src/models/schema';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated supplier application fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated supplier application fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-supplier-application-http-only', UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'supplier-application-role';
const identities = { reader: 9701, manager: 9702, legacyPage: 9703,
  wrongLegacy: 9704, unrelated: 9705 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
const shanghaiEpoch = (text: string) => Math.floor(Date.parse(`${text.replace(' ', 'T')}+08:00`) / 1000);

function paths(base: string, id = 106) {
  return base === '/adminapi'
    ? { list: 'supplier/apply/list', detail: `supplier/apply/info/${id}`,
      review: `supplier/apply/verify/${id}`, mark: `supplier/apply/mark/${id}`,
      delete: `supplier/apply/del/${id}` }
    : { list: 'supplier/applications', detail: `supplier/applications/${id}`,
      review: `supplier/applications/${id}/review`, mark: `supplier/applications/${id}/mark`,
      delete: `supplier/applications/${id}` };
}

beforeEach(async () => {
  fixture = await financePostgres([systemAdmin, systemAttachment, systemRole, systemMenus,
    systemMessage, systemNotification, systemSupplier, systemUserApply, user]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(systemNotification).values([
    { mark: 'supplier_verify_success', isSystem: 1 },
    { mark: 'supplier_verify_fail', isSystem: 1 },
  ]);
  await fixture.db.insert(user).values([
    { uid: 8206, account: 'applicant-8206', phone: '13800008206', status: 1 },
    { uid: 8207, account: 'applicant-8207', phone: '13800008207', status: 1 },
  ]);
  await fixture.db.insert(systemUserApply).values([
    { id: 106, type: 2, uid: 8206, phone: '13800008206', systemName: '澄明家居',
      name: '林澄', images: '[]', mark: '资质待复核', status: 0,
      addTime: shanghaiEpoch('2026-09-28 00:00:00') },
    { id: 107, type: 2, uid: 8207, phone: '13800008207', systemName: '海岸选品',
      name: '周予安', images: '[]', status: 0,
      addTime: shanghaiEpoch('2026-09-27 23:59:59') },
    { id: 108, type: 1, uid: 8206, phone: '13800008206', systemName: '其他申请',
      name: '无关', images: '[]', status: 0,
      addTime: shanghaiEpoch('2026-09-28 00:00:00') },
  ]);
  await fixture.db.insert(systemMenus).values([
    { id: 17011, menuName: '供应商入驻', authType: 1, type: 1,
      menuPath: '/admin/supplier/apply', uniqueAuth: 'admin-supplier-apply' },
    { id: 17012, menuName: '伪供应商入驻', authType: 1, type: 1,
      menuPath: '/admin/supplier/apply', uniqueAuth: 'not-admin-supplier-apply' },
  ]);
  const rules: Record<Identity, string> = {
    reader: 'supplier_application.view', manager: 'supplier_application.manage',
    legacyPage: '17011', wrongLegacy: '17012', unrelated: 'supplier_extract.view',
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Supplier application ${name}`, rules: rules[name as Identity],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `supplier-application-${name}`, pwd: password, roles: String(id),
    level: 1, adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as Identity, (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
  }
}, 30_000);

afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(base: string, name: Identity | 'anonymous', path: string,
  method = 'GET', data?: Record<string, unknown>) {
  const response = await app.request(`${base}/${path}`, { method,
    headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}`,
      ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }, env);
  return { status: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: any }>() };
}

it.each(['/adminapi', '/api/admin'])('separates supplier application read and manage access on %s', async base => {
  const route = paths(base);
  for (const path of [route.list, route.detail]) {
    for (const name of ['anonymous', 'wrongLegacy', 'unrelated'] as const) {
      expect((await request(base, name, path)).body.status).not.toBe(200);
    }
    for (const name of ['reader', 'manager', 'legacyPage'] as const) {
      expect((await request(base, name, path)).body.status).toBe(200);
    }
  }
  const list = await request(base, 'reader', `${route.list}?status=0&start_time=2026-09-28%2000%3A00%3A00&end_time=2026-09-28%2000%3A00%3A00`);
  expect(list.cache).toContain('no-store');
  expect(list.body).toMatchObject({ status: 200, data: { count: 1, list: [{ id: 106 }] } });
  expect(list.body.data.list[0].version).toMatch(/^[0-9a-f]{64}$/);
  const detail = await request(base, 'reader', route.detail);
  expect(detail.cache).toContain('no-store');
  expect(detail.body.data.version).toBe(list.body.data.list[0].version);

  const version = detail.body.data.version as string;
  for (const name of ['reader', 'legacyPage', 'wrongLegacy', 'unrelated'] as const) {
    for (const [path, method, data] of [
      [route.review, 'POST', { status: 2, fail_msg: '无权审核', expected_version: version }],
      [route.mark, 'POST', { mark: '无权备注', expected_version: version }],
      [`${route.delete}?expected_version=${version}`, 'DELETE', undefined],
    ] as const) {
      expect((await request(base, name, path, method, data)).body.status).not.toBe(200);
    }
  }
  expect((await fixture.db.select().from(systemUserApply).where(eq(systemUserApply.id, 106)))[0])
    .toMatchObject({ status: 0, mark: '资质待复核', isDel: 0 });
});

it('maps only the exact legacy menu to view, and both route families to the same capabilities', async () => {
  const permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
  expect(await permissions.resolveRulePermissionKeys('17011')).toContain('supplier_application.view');
  expect(await permissions.resolveRulePermissionKeys('17011')).not.toContain('supplier_application.manage');
  expect(await permissions.resolveRulePermissionKeys('17012')).not.toContain('supplier_application.view');
  for (const base of ['/adminapi', '/api/admin']) {
    const route = paths(base);
    for (const path of [route.list, route.detail]) {
      expect(requiredAdminPermission('GET', `${base}/${path}`)).toBe('supplier_application.view');
    }
    for (const [method, path] of [['POST', route.review], ['POST', route.mark],
      ['DELETE', route.delete]] as const) {
      expect(requiredAdminPermission(method, `${base}/${path}`)).toBe('supplier_application.manage');
    }
  }
});

it.each(['/adminapi', '/api/admin'])('rejects missing and stale versions, then completes guarded writes on %s', async base => {
  const route = paths(base);
  const initial = await request(base, 'manager', route.detail);
  expect(initial.body.status).toBe(200);
  const version = initial.body.data.version as string;

  for (const [path, method, data] of [
    [route.review, 'POST', { status: 2, fail_msg: '资料不符' }],
    [route.mark, 'POST', { mark: '新备注' }],
    [route.delete, 'DELETE', undefined],
  ] as const) {
    const missing = await request(base, 'manager', path, method, data);
    expect(missing.body.status).toBe(400);
  }
  for (const [path, method, data] of [
    [route.review, 'POST', { status: 2, fail_msg: '资料不符', expected_version: '0'.repeat(64) }],
    [route.mark, 'POST', { mark: '新备注', expected_version: '0'.repeat(64) }],
    [`${route.delete}?expected_version=${'0'.repeat(64)}`, 'DELETE', undefined],
  ] as const) {
    const stale = await request(base, 'manager', path, method, data);
    expect(stale.status).toBe(409);
    expect(stale.body.status).toBe(409);
  }
  expect((await fixture.db.select().from(systemUserApply).where(eq(systemUserApply.id, 106)))[0])
    .toMatchObject({ status: 0, mark: '资质待复核', isDel: 0 });

  const marked = await request(base, 'manager', route.mark, 'POST',
    { mark: '新备注', expected_version: version });
  expect(marked.body).toMatchObject({ status: 200, data: { id: 106, mark: '新备注' } });
  const afterMark = await request(base, 'manager', route.detail);
  const markedVersion = afterMark.body.data.version as string;
  expect(markedVersion).not.toBe(version);
  expect((await request(base, 'manager', route.review, 'POST',
    { status: 2, fail_msg: '资料不符', expected_version: version })).status).toBe(409);
  expect((await request(base, 'manager', `${route.delete}?expected_version=${version}`, 'DELETE')).status).toBe(409);

  const reviewed = await request(base, 'manager', route.review, 'POST',
    { status: 2, fail_msg: '资料不符', expected_version: markedVersion });
  expect(reviewed.body).toMatchObject({ status: 200, data: { id: 106, status: 2 } });
  expect(await fixture.db.select().from(systemMessage)).toMatchObject([
    { eventKey: expect.stringMatching(/^supplier\.application\.review:106:\d+:2$/), mark: 'supplier_verify_fail',
      userId: 8206, type: 1, look: 0, status: 1, isDel: 0 },
  ]);
  const afterReview = await request(base, 'manager', route.detail);
  expect(afterReview.body.data.version).not.toBe(markedVersion);
  const removed = await request(base, 'manager',
    `${route.delete}?expected_version=${afterReview.body.data.version}`, 'DELETE');
  expect(removed.body).toMatchObject({ status: 200, data: { id: 106 } });
  expect((await request(base, 'reader', route.list)).body.data.list.map((row: { id: number }) => row.id))
    .not.toContain(106);
  expect((await fixture.db.select().from(systemUserApply).where(eq(systemUserApply.id, 106)))[0].isDel)
    .toBe(1);
});

it('approves with a current version and exposes the frozen supplier through the other Admin route', async () => {
  const modern = paths('/api/admin', 107);
  const legacy = paths('/adminapi', 107);
  const current = await request('/api/admin', 'manager', modern.detail);
  const approved = await request('/api/admin', 'manager', modern.review, 'POST',
    { status: 1, expected_version: current.body.data.version });
  expect(approved.body).toMatchObject({ status: 200, data: { id: 107, status: 1,
    account: '13800008207', activation_required: true } });
  const notices = await fixture.db.select().from(systemMessage);
  expect(notices).toMatchObject([{ eventKey: expect.stringMatching(/^supplier\.application\.review:107:\d+:1$/),
    mark: 'supplier_verify_success', userId: 8207, type: 1, look: 0 }]);
  expect(notices[0].content).toContain('短信验证');
  expect(notices[0].content).not.toContain('13800008207');
  const detail = await request('/adminapi', 'reader', legacy.detail);
  expect(detail.body).toMatchObject({ status: 200, data: { id: 107, status: 1,
    account: '13800008207', activation_required: true, activated: false } });
  expect(detail.body.data.version).not.toBe(current.body.data.version);
  const approvedList = await request('/adminapi', 'reader', `${legacy.list}?status=1`);
  expect(approvedList.body).toMatchObject({ status: 200, data: { count: 1,
    list: [{ id: 107, status: 1 }] } });
  const forbiddenDelete = await request('/adminapi', 'manager',
    `${legacy.delete}?expected_version=${detail.body.data.version}`, 'DELETE');
  expect(forbiddenDelete.body.status).toBe(400);
  expect((await fixture.db.select().from(systemUserApply).where(eq(systemUserApply.id, 107)))[0].isDel)
    .toBe(0);
});
