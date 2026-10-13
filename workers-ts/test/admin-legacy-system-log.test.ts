import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { systemAdmin, systemLog, systemMenus, systemRole } from '@/models/schema';
import * as LegacyLog from '@/controllers/api/v1/AdminLegacySystemLogController';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { adminapiRoutes } from '@/routes/adminapi';
import { AdminLegacySystemLogService, parseLegacySystemLogQuery, type AdminLegacySystemLogActor } from '@/services/admin/AdminLegacySystemLogService';
import { requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { ApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createAdminDatabaseSession: wiring.open }));

type Reply = { status: number; msg: string; data: any };
const env = { APP_KEY: 'legacy-system-log-local-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const day = (value: string) => Date.parse(`${value}+08:00`) / 1000;
const actor = (id = 101): AdminLegacySystemLogActor => ({ id, authVersion: md5('fixture-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });

describe('legacy operation log read contract', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>, container: Container, service: AdminLegacySystemLogService;
  let tokens: Record<'reader' | 'super' | 'unrelated' | 'numeric', string>;
  const requests: string[] = [];
  function application(afterAuth?: () => Promise<void>, registered = false) {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', container); await next();
      if (registered) { expect(c.get('container')).toBe(container); expect(c.get('applicationContainer')).toBeUndefined(); }
    });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    if (registered) return app.route('/adminapi', adminapiRoutes);
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const [suffix, handler] of [['', LegacyLog.list], ['/search_admin', LegacyLog.adminOptions]] as const) {
        app.get(`${prefix}/system/log${suffix}`, adminAuthMiddleware(), async (_c, next) => { await afterAuth?.(); await next(); }, handler);
      }
    }
    return app;
  }
  async function get(query = '', token = tokens.reader, suffix = '', app = application(), prefix = '/adminapi') {
    const response = await app.request(`${prefix}/system/log${suffix}${query}`, { headers: token ? { 'Authori-zation': `Bearer ${token}` } : {} }, env);
    return { response, body: await response.json<Reply>() };
  }

  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => { requests.push(String(input)); throw Error('External I/O forbidden'); });
    fixture = await financePostgres([systemAdmin, systemRole, systemMenus, systemLog]);
    container = createContainerFromDb(fixture.db); service = new AdminLegacySystemLogService(container);
    const scoped = createContainerFromDb(fixture.db);
    wiring.open.mockImplementation(() => ({ container: scoped, close: wiring.close }));
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: '日志只读', level: 1, rules: 'log.view' },
      { id: 2, roleName: '系统目录', level: 1, rules: 'system.view' },
      { id: 3, roleName: '旧日志精确 API', level: 1, rules: '900' },
    ]);
    await fixture.db.insert(systemMenus).values([{ id: 900, type: 1, menuName: '旧系统日志', authType: 2, apiUrl: 'system/log', methods: 'GET' }]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'super', realName: '顶级', pwd: 'fixture-password', level: 0 },
      { id: 101, account: 'reader', realName: '当前', pwd: 'fixture-password', level: 1, roles: '1' },
      { id: 102, account: 'unrelated', realName: '系统目录读者', pwd: 'fixture-password', level: 1, roles: '2' },
      { id: 103, account: 'numeric', realName: '旧菜单读者', pwd: 'fixture-password', level: 1, roles: '3' },
      { id: 2, account: 'lower', realName: '下级', level: 2, status: 0 },
      { id: 3, account: 'deleted', realName: '历史下级', level: 3, isDel: 1 },
      { id: 4, account: 'supplier', realName: '供应商秘密', level: 2, adminType: 4 },
      { id: 5, account: 'store', realName: '门店秘密', level: 2, adminType: 2 },
      { id: 6, account: 'foreign-platform', realName: '外域秘密', level: 2, relationId: 8 },
    ]);
    await fixture.db.insert(systemLog).values([
      { id: 10, adminId: 100, adminName: '顶级', path: '/root', page: '上级操作', method: 'GET', type: 'admin', addTime: day('2026-09-28T09:00:00') },
      { id: 11, adminId: 101, adminName: '当前', path: '/orders', page: '订单', method: 'PUT', type: 'admin', ip: '10.0.0.2', addTime: day('2026-09-28T09:00:00') },
      { id: 12, adminId: 2, adminName: '下级', path: '/orders?name=100%', page: '查看%操作', method: 'GET', type: 'admin', ip: '10.0.0.3', addTime: day('2026-09-28T10:00:00') },
      { id: 13, adminId: 3, adminName: '历史下级', path: '/under_score', page: '历史', method: 'POST', type: 'admin', ip: '10.0.0.3', addTime: day('2026-09-28T10:00:00') },
      { id: 14, adminId: 4, adminName: '供应商秘密', path: '/supplier-secret', type: 'admin', addTime: day('2026-09-28T11:00:00') },
      { id: 15, adminId: 5, adminName: '门店秘密', path: '/store-secret', type: 'store', addTime: day('2026-09-28T11:00:00') },
      { id: 16, adminId: 6, adminName: '外域秘密', path: '/foreign-secret', type: 'admin', addTime: day('2026-09-28T11:00:00') },
      { id: 17, adminId: 2, storeId: 8, path: '/store-owned-secret', type: 'store', addTime: day('2026-09-28T11:00:00') },
      { id: 18, adminId: 2, merchantId: 8, path: '/merchant-secret', type: 'admin', addTime: day('2026-09-28T11:00:00') },
      { id: 19, adminId: 101, path: '/private-intent-secret', type: 'city_delivery_intent', addTime: day('2026-09-28T11:00:00') },
      { id: 20, adminId: 101, path: '/private-part-secret', type: 'city_delivery_intent_part', addTime: day('2026-09-28T11:00:00') },
      { id: 21, adminId: 0, path: '/unattributed-secret', type: 'admin', addTime: day('2026-09-28T11:00:00') },
      { id: 22, adminId: 2, path: '/slash\\path', page: '旧历史', method: 'GET', type: 'admin', addTime: 1 },
      { id: 23, adminId: 2, path: '/next-day', page: '明日', type: 'admin', addTime: day('2026-09-29T00:00:00') },
    ]);
    const signed = await Promise.all([101, 100, 102, 103].map(async id => (await createToken(id, 'admin', md5('fixture-password'), env.APP_KEY)).token));
    tokens = { reader: signed[0], super: signed[1], unrelated: signed[2], numeric: signed[3] };
  }, 30_000);
  afterAll(async () => { try { expect(requests).toEqual([]); } finally { vi.restoreAllMocks(); await fixture?.close(); } }, 30_000);

  it('serves the registered old URLs with exact legacy DTO and private response headers', async () => {
    const app = application(undefined, true);
    wiring.open.mockClear(); wiring.close.mockClear();
    const { body, response } = await get('', tokens.reader, '', app);
    expect(body.status, body.msg).toBe(200); expect(Object.keys(body.data).sort()).toEqual(['count', 'list']);
    expect(wiring.open).toHaveBeenCalledExactlyOnceWith(env); expect(wiring.close).toHaveBeenCalledOnce();
    expect(body.data.count).toBe(5); expect(body.data.list.map((row: any) => row.id)).toEqual([23,13,12,11,22]);
    expect(Object.keys(body.data.list[0]).sort()).toEqual(['id','store_id','admin_id','admin_name','path','page','method','ip','type','add_time'].sort());
    expect(body.data.list.find((row: any) => row.id === 12)).toMatchObject({ page: '查看%操作', method: 'GET', admin_id: 2, add_time: day('2026-09-28T10:00:00') });
    expect(JSON.stringify(body)).not.toMatch(/secret|pwd|roles|action|merchant_id/);
    expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('pragma')).toBe('no-cache');
    const options = await get('', tokens.reader, '/search_admin', app);
    expect(options.body.status, options.body.msg).toBe(200); expect(Object.keys(options.body.data)).toEqual(['info']);
    expect(options.body.data.info.map((row: any) => row.id)).toEqual([2,3,101,102,103]);
    expect(Object.keys(options.body.data.info[0]).sort()).toEqual(['id','real_name']);
    expect(wiring.open).toHaveBeenCalledTimes(2); expect(wiring.close).toHaveBeenCalledTimes(2);
    wiring.open.mockClear(); wiring.close.mockClear();
    expect((await get('', tokens.unrelated, '', app)).body.status).not.toBe(200);
    expect(wiring.open).not.toHaveBeenCalled(); expect(wiring.close).not.toHaveBeenCalled();
  });

  it('keeps explicit IDs, administrator options and log rows within the live platform level scope', async () => {
    expect((await get('?admin_id=100')).body.data).toEqual({ list: [], count: 0 });
    for (const id of [4,5,6]) expect((await get(`?admin_id=${id}`)).body.data.list).toEqual([]);
    expect((await get('?admin_id=2')).body.data.list.map((row: any) => row.id)).toEqual([23,12,22]);
    expect((await get('', tokens.super)).body.data.list.map((row: any) => row.id)).toEqual([23,13,12,11,10,22]);
    expect((await get('?admin_id=0')).body.data.count).toBe(5);
  });

  it('preserves stable time/id ordering, filtered pagination and empty filters from the old page', async () => {
    const first = (await get('?page=1&limit=1&pages=&path=&ip=&admin_id=&data=')).body.data;
    const second = (await get('?page=2&limit=1')).body.data;
    expect(first.count).toBe(5); expect(first.list[0].id).toBe(23); expect(second.count).toBe(5); expect(second.list[0].id).toBe(13);
    expect((await get('?page=6&limit=1')).body.data).toEqual({ list: [], count: 5 });
  });

  it('treats pages, path and IP filters literally and combines them with scope and time', async () => {
    for (const [key, value, ids] of [['pages','%',[12]], ['path','%',[12]], ['path','_',[13]], ['path','\\',[22]], ['ip','10.0.0.3',[13,12]]] as const) {
      const result = await get(`?${new URLSearchParams({ [key]: value })}`);
      expect(result.body.status, value).toBe(200); expect(result.body.data.list.map((row: any) => row.id), value).toEqual(ids);
    }
    const query = new URLSearchParams({ pages: '查看', path: '/orders', ip: '10.0.0.3', admin_id: '2', data: '2026/09/28-2026/09/28' });
    expect((await get(`?${query}`)).body.data.list.map((row: any) => row.id)).toEqual([12]);
  });

  it('accepts the old inclusive two-ended and strict open-ended time bounds', async () => {
    for (const [data, ids] of [['2026/09/28-2026/09/28',[23,13,12,11]], ['2026/09/28 09:30:00-2026/09/28 10:00:00',[13,12]],
      ['2026/09/28 10:00:00-2026/09/28 10:00:00',[23,13,12]], ['-2026/09/28',[13,12,11,22]], ['2026/09/29-',[23]]] as const) {
      expect((await get(`?${new URLSearchParams({ data })}`)).body.data.list.map((row: any) => row.id)).toEqual(ids);
    }
  });

  it('resolves calendar shortcuts in Shanghai and rolling windows by server time', () => {
    const now = day('2026-10-13T12:34:56');
    const parsed = (data: string) => parseLegacySystemLogQuery(new URLSearchParams({ data }), now);
    expect(parsed('today')).toMatchObject({ start: day('2026-10-13T00:00:00'), end: day('2026-10-14T00:00:00') });
    expect(parsed('yesterday')).toMatchObject({ start: day('2026-10-12T00:00:00'), end: day('2026-10-13T00:00:00') });
    expect(parsed('week')).toMatchObject({ start: day('2026-10-12T00:00:00'), end: day('2026-10-19T00:00:00') });
    expect(parsed('month')).toMatchObject({ start: day('2026-10-01T00:00:00'), end: day('2026-11-01T00:00:00') });
    expect(parsed('year')).toMatchObject({ start: day('2026-01-01T00:00:00'), end: day('2027-01-01T00:00:00') });
    expect(parsed('lately7')).toMatchObject({ start: now - 7 * 86400, end: now + 1 });
    expect(parsed('lately30')).toMatchObject({ start: now - 30 * 86400, end: now + 1 });
    for (const shortcut of ['last year','last month','last week','quarter']) expect(parsed(shortcut).end).toBeGreaterThan(parsed(shortcut).start!);
  });

  it('preserves PHP midnight, equal-endpoint, end-only and quarter boundary semantics', async () => {
    const now = day('2026-10-13T12:34:56');
    const parsed = (data: string) => parseLegacySystemLogQuery(new URLSearchParams({ data }), now);
    expect(parsed('2026/09/28-2026/09/28')).toMatchObject({ start: day('2026-09-28T00:00:00'), end: day('2026-09-29T00:00:01') });
    expect(parsed('2026/09/28 10:00:00-2026/09/28 10:00:00')).toMatchObject({ start: day('2026-09-28T10:00:00'), end: day('2026-09-29T10:00:01') });
    expect(parsed('-2026/09/28 10:00:00')).toMatchObject({ start: undefined, end: day('2026-09-29T10:00:00') });
    expect(parsed('quarter')).toMatchObject({ start: day('2026-10-01T00:00:00'), end: day('2026-12-31T00:00:01') });
    expect(parsed('1970/01/01 08:00:00-1970/01/01 08:00:00')).toMatchObject({ start: undefined, end: undefined });
    expect(parsed('1970/01/01 08:00:00-1970/01/02 08:00:00')).toMatchObject({ start: undefined, end: 172800 });
    expect(parsed('1970/01/02 08:00:00-1970/01/01 08:00:00')).toMatchObject({ start: 86400, end: undefined });
    expect((await get(`?${new URLSearchParams({ data: '-2026/09/28 09:30:00' })}`)).body.data.list.map((row: any) => row.id)).toEqual([23,13,12,11,22]);
  });

  it('uses the named Shanghai zone for historical wall dates and clocks within integer timestamp storage', () => {
    const parsed = (data: string) => parseLegacySystemLogQuery(new URLSearchParams({ data }));
    expect(parsed('1990/07/01-1990/07/01')).toMatchObject({ start: 646758000, end: 646844401 });
    expect(parsed('1990/07/01 12:34:56-1990/07/01 12:35:00')).toMatchObject({ start: 646803296, end: 646803301 });
    expect(parsed('2026/07/01 12:34:56-')).toMatchObject({ start: day('2026-07-01T12:34:56'), end: undefined });
    expect(parsed('2038/01/19 11:14:07-')).toMatchObject({ start: 2147483647, end: undefined });
    expect(() => parsed('2038/01/19 11:14:08-')).toThrow();
  });

  it('uses named-zone calendar boundaries across short and long historical days', () => {
    const utc = (value: string) => Date.parse(`${value}Z`) / 1000;
    const parsed = (data: string, now: string) => parseLegacySystemLogQuery(new URLSearchParams({ data }), utc(now));
    expect(parsed('today', '1990-04-15T03:00:00')).toMatchObject({ start: utc('1990-04-14T16:00:00'), end: utc('1990-04-15T15:00:00') });
    expect(parsed('today', '1990-09-16T03:00:00')).toMatchObject({ start: utc('1990-09-15T15:00:00'), end: utc('1990-09-16T16:00:00') });
    expect(parsed('yesterday', '1990-04-16T03:00:00')).toMatchObject({ start: utc('1990-04-14T16:00:00'), end: utc('1990-04-15T15:00:00') });
    expect(parsed('week', '1990-04-15T03:00:00')).toMatchObject({ start: utc('1990-04-08T16:00:00'), end: utc('1990-04-15T15:00:00') });
    expect(parsed('month', '1990-04-15T03:00:00')).toMatchObject({ start: utc('1990-03-31T16:00:00'), end: utc('1990-04-30T15:00:00') });
    expect(parsed('year', '1990-07-01T03:00:00')).toMatchObject({ start: utc('1989-12-31T16:00:00'), end: utc('1990-12-31T16:00:00') });
    expect(parsed('quarter', '1990-04-15T03:00:00')).toMatchObject({ start: utc('1990-03-31T16:00:00'), end: utc('1990-06-29T15:00:00') + 1 });
    // The custom PHP +86400 rule remains elapsed seconds even on a 23h day.
    expect(parsed('1990/04/15-1990/04/15', '1990-04-15T03:00:00')).toMatchObject({ start: utc('1990-04-14T16:00:00'), end: utc('1990-04-15T16:00:00') + 1 });
  });

  it('moves rolling shortcuts by wall calendar days across historical DST', () => {
    const utc = (value: string) => Date.parse(`${value}Z`) / 1000;
    const parsed = (data: string, now: string) => parseLegacySystemLogQuery(new URLSearchParams({ data }), utc(now));
    expect(parsed('lately7', '1990-04-20T03:30:00')).toMatchObject({ start: utc('1990-04-13T04:30:00'), end: utc('1990-04-20T03:30:00') + 1 });
    expect(parsed('lately30', '1990-10-01T04:30:00')).toMatchObject({ start: utc('1990-09-01T03:30:00'), end: utc('1990-10-01T04:30:00') + 1 });
  });

  it('rejects nonexistent or repeated historical clocks instead of selecting a guessed instant', () => {
    const query = (data: string, now?: number) => parseLegacySystemLogQuery(new URLSearchParams({ data }), now);
    for (const data of ['1990/04/15 02:00:00-', '1990/04/15 02:30:00-', '1990/04/15 02:59:59-',
      '1990/09/16 01:00:00-', '1990/09/16 01:30:00-', '1990/09/16 01:59:59-']) {
      expect(() => query(data), data).toThrow('系统日志时间不存在或不唯一');
    }
    expect(() => query('1990/02/30-')).toThrow();
    expect(() => query('lately7', Date.parse('1990-04-21T17:30:00Z') / 1000)).toThrow('系统日志时间不存在或不唯一');
    expect(() => query('lately7', Date.parse('1990-09-22T17:30:00Z') / 1000)).toThrow('系统日志时间不存在或不唯一');
    expect(query('1990/04/15 01:59:59-').start).toBe(Date.parse('1990-04-14T17:59:59Z') / 1000);
    expect(query('1990/04/15 03:00:00-').start).toBe(Date.parse('1990-04-14T18:00:00Z') / 1000);
    expect(query('1990/09/16-').start).toBe(Date.parse('1990-09-15T15:00:00Z') / 1000);
  });

  it('rejects malformed, duplicate, unsupported and unbounded query parameters before SQL', async () => {
    const transaction = vi.spyOn(fixture.db, 'transaction');
    try {
      for (const query of ['page=0','page=01','page=1002','page=202&limit=100','limit=0','limit=101','page=1&page=2','method=GET','start_time=1','admin_id=-1','admin_id=2147483648','path=%00','data=__proto__','data=today&data=month','data=2026%2F02%2F30-2026%2F03%2F01','data=2026%2F09%2F29-2026%2F09%2F28','data=2026%2F09%2F28+24%3A00%3A00-2026%2F09%2F29']) {
        await expect(service.list(new URLSearchParams(query), actor()), query).rejects.toThrow();
      }
      await expect(service.list(new URLSearchParams({ pages: 'x'.repeat(65) }), actor())).rejects.toThrow();
      await expect(service.adminOptions(new URLSearchParams('page=1'), actor())).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }
  });

  it('requires log.view for both old paths and admits a valid old numeric API grant', async () => {
    expect((await get('', tokens.unrelated)).body.status).not.toBe(200);
    expect((await get('', tokens.unrelated, '/search_admin')).body.status).not.toBe(200);
    expect((await get('', tokens.numeric)).body.status).toBe(200);
    expect((await get('', tokens.numeric, '/search_admin')).body.status).toBe(200);
    for (const prefix of ['/adminapi','/api/admin']) for (const method of ['GET','HEAD']) for (const suffix of ['','/search_admin']) {
      expect(requiredAdminPermission(method, `${prefix}/system/log${suffix}`)).toBe('log.view');
    }
    for (const method of ['POST','PUT','DELETE']) expect(requiredAdminPermission(method, '/adminapi/system/log')).toBeNull();
    expect((await get('', '')).body.status).not.toBe(200);
  });

  it('rechecks password, status, deletion, domain, level and roles after middleware authentication', async () => {
    for (const patch of [{ pwd: 'changed' }, { status: 0 }, { isDel: 1 }, { adminType: 4 }, { relationId: 7 }, { level: -1 }, { roles: '2' }]) {
      try {
        const app = application(async () => { await fixture.db.update(systemAdmin).set(patch).where(eq(systemAdmin.id, 101)); });
        expect((await get('', tokens.reader, '', app)).body.status, JSON.stringify(patch)).not.toBe(200);
      } finally { await fixture.db.update(systemAdmin).set({ pwd: 'fixture-password', status: 1, isDel: 0, adminType: 1, relationId: 0, level: 1, roles: '1' }).where(eq(systemAdmin.id, 101)); }
    }
    try {
      const app = application(async () => { await fixture.db.update(systemAdmin).set({ level: 3 }).where(eq(systemAdmin.id, 101)); });
      expect((await get('', tokens.reader, '', app)).body.data.list.map((row: any) => row.id)).toEqual([13,11]);
    } finally { await fixture.db.update(systemAdmin).set({ level: 1 }).where(eq(systemAdmin.id, 101)); }
  });

  it('rejects invalid, stale and expired direct identities and expiration during a read', async () => {
    for (const identity of [{ ...actor(), id: 0 }, { ...actor(), authVersion: 'bad' }, { ...actor(), authVersion: md5('wrong') }, { ...actor(), expiresAt: 1 }]) {
      await expect(service.list(new URLSearchParams(), identity)).rejects.toThrow();
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 30;
    const dialect = new PgDialect();
    const transactionBefore = Object.getOwnPropertyDescriptor(fixture.db, 'transaction');
    // Intercept a separate client rather than replacing the fixture adapter's
    // transaction method. Its callback receives the adapted rows only once.
    const observedDb = new Proxy(fixture.db, { get(database, property) {
      const transactionOperation: unknown = Reflect.get(database, property);
      if (typeof transactionOperation !== 'function') return transactionOperation;
      if (property !== 'transaction') return transactionOperation.bind(database);
      return (callback: any, ...options: unknown[]) => Reflect.apply(transactionOperation, database, [(tx: any) => callback(new Proxy(tx, { get(transaction, key) {
        const operation: unknown = Reflect.get(transaction, key);
        if (typeof operation !== 'function') return operation;
        if (key !== 'execute') return operation.bind(transaction);
        return async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(operation, transaction, args);
          if (dialect.sqlToQuery(args[0] as any).sql.includes('SELECT id,store_id,admin_id')) vi.spyOn(Date, 'now').mockReturnValue((expiresAt + 1) * 1000);
          return result;
        };
      } })), ...options]);
    } });
    const observedService = new AdminLegacySystemLogService(createContainerFromDb(observedDb));
    try { await expect(observedService.list(new URLSearchParams(), { ...actor(), expiresAt })).rejects.toThrow('登录已过期'); }
    finally {
      vi.mocked(Date.now).mockRestore?.();
      expect(Object.getOwnPropertyDescriptor(fixture.db, 'transaction')).toEqual(transactionBefore);
    }
  });

  it('performs no cleanup or write and leaves even very old audit rows unchanged', async () => {
    const beforeLogs = await fixture.db.select().from(systemLog), beforeAdmins = await fixture.db.select().from(systemAdmin);
    await get(''); await get('', tokens.reader, '/search_admin');
    expect(await fixture.db.select().from(systemLog)).toEqual(beforeLogs);
    expect(await fixture.db.select().from(systemAdmin)).toEqual(beforeAdmins);
    expect((await service.list(new URLSearchParams({ path: '/slash' }), actor())).list[0].add_time).toBe(1);
    expect(requests).toEqual([]);
  });
});
