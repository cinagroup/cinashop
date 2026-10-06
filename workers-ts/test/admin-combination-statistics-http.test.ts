import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { storeCombination, storePink, storeOrder, storeProduct, systemAdmin, systemRole } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { ApiErrorCode } from '../src/utils/errors';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

// Assembled Hono/JWT/account/permission/controller queries, with actual independently
// authenticated formal-schema app/Admin roles. Only the application connection
// binding is redirected to the owned loopback fixture; no SQL/service mocks.
const wiring = vi.hoisted(() => ({ application: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.application) throw Error('Missing owned app LOGIN'); return wiring.application; },
}));
const prefixes = ['/adminapi', '/api/admin'];
const actors = { all: 5301, group: 5302, statistics: 5303, export: 5304, manager: 5305, generic: 5306 };
const password = 'synthetic-read-http-digest';
const reads = [
  ['/activity/combinations/export', 'export'],
  ['/activity/combination-groups/head', 'group'],
  ['/activity/combination-groups', 'group'],
  ['/activity/combination-groups/9011/members', 'group'],
  ['/activity/combination-statistics/901/head', 'statistics'],
  ['/activity/combination-statistics/901/groups', 'statistics'],
  ['/activity/combination-statistics/901/orders', 'statistics'],
  ['/activity/combination-statistics/901/groups/9011/members', 'statistics'],
] as const;
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Missing HTTP object');
  return value as Record<string, any>;
};

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Combination readonly HTTP with commissioned formal Admin LOGIN', () => {
  const http = createApp();
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  const tokens = new Map<string, string>();
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture(); f.env.APP_KEY = 'local-read-http-signing-key';
    await f.db.update(storeProduct).set({ otPrice: '29.00' }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeCombination).values([
      { id: 901, productId: 70, storeName: 'HTTP历史拼团', info: '字面50%_筛选', price: '5.25', image: '/images/http-local.png',
        startTime: new Date('2026-01-01T00:00:00Z'), stopTime: new Date('2030-01-01T00:00:00Z'), people: 3, isShow: 1, status: 1 },
      { id: 902, productId: 71, storeName: '已删除邻活动', isDel: 1 },
    ]);
    await f.db.insert(storePink).values([
      { id: 9011, combinationId: 901, productId: 70, uid: 11, nickname: '主队长', kId: 0, status: 2, people: 3,
        orderId: 'LOCAL-PINK-9201', orderIdKey: '9201', memberCount: 3, addTime: 1760000000 },
      { id: 9012, combinationId: 901, productId: 70, uid: 22, nickname: '退款后成员', kId: 9011, status: 2, people: 3,
        orderId: 'LOCAL-PINK-9202', orderIdKey: '9202', addTime: 1760000001 },
      { id: 9013, combinationId: 901, productId: 70, uid: 0, nickname: '虚拟成员', isVirtual: 1, kId: 9011, status: 2,
        orderId: '0', orderIdKey: '0', people: 3, addTime: 1760000002 },
      { id: 9014, combinationId: 901, productId: 70, uid: 22, nickname: '已退款历史行', kId: 9011, isRefund: 9011, status: 2, people: 3 },
      { id: 9015, combinationId: 901, productId: 70, uid: 11, nickname: '过期待处理', kId: 0, status: 1, people: 3,
        stopTime: new Date('2020-01-01T00:00:00Z'), addTime: 1760000003 },
      { id: 9021, combinationId: 902, productId: 71, uid: 22, nickname: '已删除活动团', kId: 0, status: 2, people: 3 },
    ]);
    await f.db.insert(storeOrder).values([
      { id: 9201, orderId: 'LOCAL-PINK-9201', unique: 'local-read-9201', uid: 11, type: 3, activityId: 901, pinkId: 9011, paid: 1, pid: 0, payPrice: '9.00', realName: '本机买家', userPhone: '0000011' },
      { id: 9202, orderId: 'LOCAL-PINK-9202', unique: 'local-read-9202', uid: 22, type: 3, activityId: 901, pinkId: 9011, paid: 1, pid: -1, payPrice: '11.00', refundStatus: 2, refundType: 3, isDel: 1 },
      { id: 9203, orderId: 'LOCAL-PINK-9203', unique: 'local-read-9203', uid: 11, type: 3, activityId: 901, paid: 0, payPrice: '100.00' },
      { id: 9204, orderId: 'LOCAL-PINK-9204', unique: 'local-read-9204', uid: 11, type: 3, activityId: 901, paid: 1, pid: 9201, payPrice: '100.00' },
      { id: 9205, orderId: 'LOCAL-PINK-9205', unique: 'local-read-9205', uid: 22, type: 3, activityId: 902, paid: 1, payPrice: '31.00' },
    ]);
    const rules = { all: 'combination_group.view,combination_statistics.view,combination_export.view', group: 'combination_group.view',
      statistics: 'combination_statistics.view', export: 'combination_export.view', manager: 'combination.manage', generic: 'activity.manage' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, roleName: `Local ${name}`, rules: rules[name as keyof typeof rules] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `local-read-${name}`, pwd: password,
      roles: String(id), level: 1, adminType: 1, status: 1, isDel: 0 })));
    for (const [name, id] of Object.entries(actors)) tokens.set(name, (await createToken(id, 'admin', md5(password), f.env.APP_KEY)).token);
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { wiring.application = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); } }, 30000);
  type Role = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (r: infer R) => unknown ? R : never;
  async function profiles(run: (env: Env, admin: Role) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [db] = await f.exec('SELECT current_database() AS name');
      const names = { app: app.role, admin: admin.role, maintenance: 'finance_test', database: String(db.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect(await auditRuntimeBusinessPrivileges(app.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      expect((await admin.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: admin.role, session: admin.role });
      wiring.application = createContainerFromDb(app.db);
      const env: Env = { ...f.env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
        HYPERDRIVE: { connectionString: app.connectionString } as Env['HYPERDRIVE'], HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } as Env['HYPERDRIVE_ADMIN'] };
      Object.assign(env, { NODE_ENV: 'test' });
      try { await run(env, admin); } finally { wiring.application = undefined; }
    }));
  }
  async function get(env: Env, url: string, actor = 'all') {
    const response = await http.request(url, { headers: { 'Authori-zation': `Bearer ${tokens.get(actor) ?? ''}` } }, env);
    expect(response.headers.get('Cache-Control')).toContain('private'); expect(response.headers.get('Cache-Control')).toContain('no-store');
    return object(await response.json());
  }
  async function state() {
    const result: Record<string, unknown> = {};
    for (const table of ['store_combination','store_pink','store_product','store_order','store_order_cart_info','system_log','store_order_outbox'])
      result[table] = (await f.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
    result.sequences = (await f.query('SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname=\'public\' ORDER BY sequencename')).rows;
    return result;
  }
  it.each(prefixes)('executes all eight %s reads with exact raw/gross projections and no writes', async base => {
    await profiles(async env => {
      const before = await state();
      for (const [route] of reads) {
        const response = await get(env, `${base}${route}`); expect(response.status, response.msg).toBe(200);
        const data = object(response.data);
        if (route.endsWith('/export')) expect(data).toMatchObject({ count: 1, page: 1, limit: 1000, has_more: false, snapshot: expect.stringMatching(/^[a-f0-9]{64}$/) });
        else if (route === '/activity/combination-groups/head') expect(data).toMatchObject({ participant_record_count: 6, success_count: 2 });
        else if (route.endsWith('/head')) expect(data).toMatchObject({ people_count: 3, spread_count: 2, start_count: 2, success_count: 1, pay_price: '20.00', pay_count: 2 });
        else if (route.endsWith('/members')) {
          expect(data).toMatchObject({ group_id: 9011, combination_id: 901, count: 3, page: 1, limit: 15 });
          expect(data.list).toEqual(expect.arrayContaining([expect.objectContaining({ pink_id: 9013, uid: 0, is_virtual: 1, order_id: '', detail_available: false }),
            expect.objectContaining({ pink_id: 9011, order_id: 'LOCAL-PINK-9201', detail_available: true }),
            expect.objectContaining({ pink_id: 9012, order_id: 'LOCAL-PINK-9202', detail_available: false })]));
        } else if (route.endsWith('/orders')) expect(data).toMatchObject({ count: 2, page: 1, limit: 15,
          list: expect.arrayContaining([expect.objectContaining({ id: 9201, order_id: 'LOCAL-PINK-9201' }),expect.objectContaining({ id: 9202, deleted: true })]) });
        else expect(data).toMatchObject({ count: route.includes('combination-statistics') ? 2 : 3, page: 1, limit: 15,
          list: expect.arrayContaining([expect.objectContaining({ id: 9015, status_raw: 1, expired_pending: true })]) });
      }
      expect(await state()).toEqual(before);
    });
  }, 90000);
  it.each(prefixes)('enforces three independent read/export domains on %s', async base => {
    await profiles(async env => {
      const before = await state();
      for (const actor of ['group','statistics','export','manager','generic']) for (const [route, permission] of reads) {
        const response = await get(env, `${base}${route}`, actor);
        expect(response.status, `${actor} ${route}: ${response.msg}`).toBe(actor === permission ? 200 : ApiErrorCode.ERR_AUTH);
      }
      for (const route of ['/activity/combinations', '/activity/combinations/901'])
        expect((await get(env, base + route, 'export')).status).toBe(ApiErrorCode.ERR_AUTH);
      expect(await state()).toEqual(before);
    });
  }, 90000);
  it.each(prefixes)('rejects ambiguous query/ID/scope inputs and leaves %s history unchanged', async base => {
    await profiles(async env => {
      const before = await state();
      for (const route of ['/activity/combination-groups/head?status=1','/activity/combination-statistics/901/head?page=1',
        '/activity/combination-groups?page=1&page=2','/activity/combination-groups?status=9','/activity/combination-groups?start_day=2026-02-30',
        '/activity/combination-statistics/901/groups?combination_id=902','/activity/combination-groups/9011/members?unknown=1',
        '/activity/combination-statistics/901/orders?status=99','/activity/combinations/export?page=0','/activity/combinations/export?page=2',
        '/activity/combination-statistics/0/head']) expect((await get(env, base + route)).status, route).toBe(400);
      expect((await get(env, `${base}/activity/combination-statistics/901/groups/9021/members`)).status).toBe(404);
      expect((await get(env, `${base}/activity/combination-statistics/999999/head`)).status).toBe(404);
      const paidZero = await get(env, `${base}/activity/combination-statistics/901/orders?status=0`);
      expect(paidZero).toMatchObject({ status: 200, data: { list: [], count: 0 } });
      expect(await state()).toEqual(before);
    });
  }, 90000);
});
