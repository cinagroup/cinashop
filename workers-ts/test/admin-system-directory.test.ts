import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono, type Handler } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import {
  adminSystemAdminDirectory, adminSystemAdminList,
  adminSystemRoleDirectory, adminSystemRoleList,
} from '@/controllers/api/v1/AdminCrudController';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { ApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

type Kind = 'system_admin' | 'system_role';
type Reply = { status: number; msg: string; data: any };
const handlers: Record<Kind, Handler<{ Bindings: Env; Variables: AppVariables }>> = {
  system_admin: adminSystemAdminDirectory, system_role: adminSystemRoleDirectory,
};

describe('platform Admin and role directories', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let tokens: { reader: string; unrelated: string; manager: string };
  const env = { APP_KEY: 'admin-directory-local-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;

  function application(target = container, authenticated = true) {
    const result = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    result.use('*', async (c, next) => { c.set('container', target); await next(); });
    result.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const kind of Object.keys(handlers) as Kind[]) {
        if (authenticated) result.get(`${prefix}/${kind}/directory`, adminAuthMiddleware(), handlers[kind]);
        else result.get(`${prefix}/${kind}/directory`, handlers[kind]);
      }
      result.get(`${prefix}/system_admin/list`, adminAuthMiddleware(), adminSystemAdminList);
      result.get(`${prefix}/system_role/list`, adminAuthMiddleware(), adminSystemRoleList);
    }
    return result;
  }

  beforeAll(async () => {
    // This suite must remain local memory even on hosts configured for native PG.
    if (process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Directory unit tests require local memory only');
    fixture = await financePostgres([systemAdmin, systemRole, systemMenus]);
    container = createContainerFromDb(fixture.db);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: '目录只读', rules: 'system.view' },
      { id: 2, roleName: '其他权限', rules: 'product.view' },
      { id: 3, roleName: '目录管理', rules: 'system.manage' },
      { id: 4, roleName: '历史平台角色', type: 1, rules: '900' },
      { id: 5, roleName: '停用角色', status: 0, rules: 'system.view' },
      { id: 6, roleName: 'percent%role', rules: 'system.view' },
      { id: 7, roleName: 'under_score', rules: '' },
      { id: 8, roleName: 'slash\\role', rules: '' },
      { id: 9, roleName: '已删除角色', status: -1 },
      { id: 10, roleName: '供应商角色', type: 4, relationId: 9 },
      { id: 11, roleName: '门店角色', type: 2, relationId: 0 },
      { id: 12, roleName: '关系隔离角色', type: 0, relationId: 9 },
    ]);
    await fixture.db.insert(systemMenus).values({ id: 900, type: 1, authType: 2,
      apiUrl: 'system_admin/list', methods: 'GET', menuName: '旧目录权限' });
    await fixture.db.insert(systemAdmin).values(Array.from({ length: 125 }, (_, index) => {
      const id = index + 1;
      const account = id === 1 ? 'Percent%Account' : id === 2 ? 'under_score' : id === 3 ? 'slash\\name'
        : id === 4 ? "quoted'o" : `directory-${id}`;
      return { id, account, realName: id === 1 ? '阿甲' : id === 2 ? '王乙' : `管理员 ${id}`,
        phone: id === 1 ? '13800123000' : `139${String(id).padStart(8, '0')}`,
        pwd: `private-hash-${id}`, status: id % 2, roles: '1', lastTime: id * 10 };
    }));
    await fixture.db.insert(systemAdmin).values([126, 127, 128].map((id, index) => ({
      id, account: `fixture-reader-${index}`, pwd: 'fixture-password', level: 1, roles: String(index + 1),
    })));
    await fixture.db.insert(systemAdmin).values([
      { id: 200, account: 'hidden-supplier', adminType: 4 },
      { id: 201, account: 'hidden-deleted', isDel: 1 },
      { id: 202, account: 'hidden-negative', status: -1 },
      { id: 203, account: 'hidden-store', adminType: 2 },
    ]);
    const signed = await Promise.all([126, 127, 128].map(async id =>
      (await createToken(id, 'admin', md5('fixture-password'), env.APP_KEY)).token));
    tokens = { reader: signed[0], unrelated: signed[1], manager: signed[2] };
    app = application();
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  async function get(kind: Kind, query = '', token = tokens.reader, prefix = '/adminapi', target = app) {
    const response = await target.request(`${prefix}/${kind}/directory${query}`, {
      headers: token ? { 'Authori-zation': `Bearer ${token}` } : {},
    }, env);
    return { response, body: await response.json<Reply>() };
  }

  it('paginates platform administrators with a safe projection and stable descending IDs', async () => {
    const { response, body } = await get('system_admin');
    expect(body.status).toBe(200);
    expect(body.data).toMatchObject({ total: 128, page: 1, limit: 20 });
    expect(body.data.list.map((row: any) => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => 128 - i));
    expect(Object.keys(body.data.list[0]).sort()).toEqual(['account', 'id', 'lastTime', 'level', 'phone', 'realName', 'roles', 'status'].sort());
    expect(JSON.stringify(body)).not.toContain('private-hash');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    const second = await get('system_admin', '?page=2&limit=2');
    expect(second.body.data.list.map((row: any) => row.id)).toEqual([126, 125]);
    expect(second.body.data.total).toBe(128);
    const beyond = await get('system_admin', '?page=500&limit=20');
    expect(beyond.body.data).toEqual({ list: [], total: 128, page: 500, limit: 20 });
    expect((await get('system_admin', '?page=101&limit=100')).body.data)
      .toEqual({ list: [], total: 128, page: 101, limit: 100 });
  });

  it('searches administrator account, name and phone with case-insensitive literal text', async () => {
    for (const [keyword, expected] of [['percent%account', [1]], ['王乙', [2]], ['13800123', [1]],
      ['_', [2]], ['\\', [3]], ["quoted'o", [4]], [' hidden ', []]] as const) {
      const { body } = await get('system_admin', `?${new URLSearchParams({ keyword })}`);
      expect(body.status, keyword).toBe(200);
      expect(body.data.list.map((row: any) => row.id), keyword).toEqual(expected);
      expect(body.data.total, keyword).toBe(expected.length);
    }
    expect((await get('system_admin', '?keyword=%20%20')).body.data.total).toBe(128);
  });

  it('filters both administrator states and combines state with the same count predicate', async () => {
    const active = (await get('system_admin', '?status=1&limit=100')).body.data;
    const disabled = (await get('system_admin', '?status=0&limit=100')).body.data;
    expect(active.total).toBe(66); expect(disabled.total).toBe(62);
    expect(active.list.every((row: any) => row.status === 1)).toBe(true);
    expect(disabled.list.every((row: any) => row.status === 0)).toBe(true);
    expect((await get('system_admin', '?keyword=Percent&status=0')).body.data.total).toBe(0);
    expect((await get('system_admin', '?status=')).body.data.total).toBe(128);
  });

  it('retains platform role types 0 and legacy 1, resolves permissions and excludes tenant roles', async () => {
    const { body } = await get('system_role', '?limit=100');
    expect(body.status).toBe(200);
    expect(body.data).toMatchObject({ total: 8, page: 1, limit: 100 });
    expect(body.data.list.map((row: any) => row.id)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(body.data.list.find((row: any) => row.id === 4)).toMatchObject({ roleName: '历史平台角色', permissionKeys: ['system.view'] });
    expect(Object.keys(body.data.list[0]).sort()).toEqual(['id', 'roleName', 'rules', 'level', 'status', 'permissionKeys'].sort());
    expect(body.data.list.find((row: any) => row.id === 3).permissionKeys.sort()).toEqual(['system.manage', 'system.view']);
    const page = (await get('system_role', '?page=2&limit=3')).body.data;
    expect(page.list.map((row: any) => row.id)).toEqual([5, 4, 3]); expect(page.total).toBe(8);
  });

  it('filters role names, literal metacharacters and enabled/disabled states', async () => {
    for (const [keyword, expected] of [['PERCENT%', [6]], ['_', [7]], ['\\', [8]], ['平台', [4]], ['供应商', []]] as const) {
      const { body } = await get('system_role', `?${new URLSearchParams({ keyword })}`);
      expect(body.data.list.map((row: any) => row.id), keyword).toEqual(expected);
      expect(body.data.total).toBe(expected.length);
    }
    expect((await get('system_role', '?status=0')).body.data.list.map((row: any) => row.id)).toEqual([5]);
    expect((await get('system_role', '?status=1&limit=100')).body.data.total).toBe(7);
    expect((await get('system_role', '?keyword=停用&status=1')).body.data.total).toBe(0);
  });

  it.each(['system_admin', 'system_role'] as Kind[])('rejects malformed %s queries before opening a transaction', async kind => {
    const transaction = vi.fn(() => { throw Error('Invalid query reached SQL'); });
    const target = application({ ...container, db: { transaction } as unknown as DbClient }, false);
    const invalid = ['page=', 'page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=01', 'page=%201', 'page=501', 'page=102&limit=100',
      'limit=', 'limit=0', 'limit=101', 'limit=01', 'page=2&page=2', 'limit=20&limit=20',
      'keyword=a&keyword=b', 'status=0&status=1', 'status=2', 'status=-1', 'status=01', 'status=true',
      'keyword=%00', 'keyword=%0a', 'keyword=%7f', `keyword=${'a'.repeat(65)}`, 'unknown=1'];
    for (const query of invalid) {
      const { response, body } = await get(kind, `?${query}`, '', '/adminapi', target);
      expect(body.status, query).toBe(400);
      expect(response.headers.get('cache-control'), query).toContain('no-store');
    }
    expect(transaction).not.toHaveBeenCalled();
    expect((await get(kind, `?keyword=${'字'.repeat(64)}`)).body.status).toBe(200);
  });

  it.each(['system_admin', 'system_role'] as Kind[])('uses one bounded read-only snapshot for %s and keeps rows unchanged', async kind => {
    const before = await Promise.all([fixture.db.select().from(systemAdmin), fixture.db.select().from(systemRole)]);
    let transactions = 0, selections = 0;
    const observedDb = new Proxy(fixture.db, {
      get(target, property) {
        if (property === 'select') throw Error('Directory selected outside its snapshot');
        if (property === 'transaction') return async (callback: (db: DbClient) => Promise<unknown>) => {
          transactions++;
          return target.transaction(async tx => {
            const observedTx = new Proxy(tx, {
              get(inner, method) {
                if (['insert', 'update', 'delete'].includes(String(method))) throw Error('Directory attempted a write');
                const value = Reflect.get(inner, method);
                if (method === 'select') return (...args: unknown[]) => { selections++; return Reflect.apply(value, inner, args); };
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            }) as unknown as DbClient;
            const result = await callback(observedTx);
            const settings = await observedTx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS statement,
              current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle`);
            expect(settings[0]).toEqual({ isolation: 'repeatable read', readonly: 'on', statement: '5s', lock: '2s', idle: '5s' });
            return result;
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { body } = await get(kind, '', '', '/adminapi', application({ ...container, db: observedDb }, false));
    expect(body.status).toBe(200);
    expect(transactions).toBe(1); expect(selections).toBe(kind === 'system_role' ? 3 : 2);
    expect(await Promise.all([fixture.db.select().from(systemAdmin), fixture.db.select().from(systemRole)])).toEqual(before);
    const settings = await fixture.db.execute(sql`SELECT current_setting('statement_timeout') AS timeout`);
    expect(settings[0].timeout).toBe('0');
  });

  it.each(['/adminapi', '/api/admin'])('requires live system.view authorization on %s for both directories', async prefix => {
    for (const kind of Object.keys(handlers) as Kind[]) {
      expect(requiredAdminPermission('GET', `${prefix}/${kind}/directory`)).toBe('system.view');
      expect(requiredAdminPermission('POST', `${prefix}/${kind}/save`)).toBe('system.manage');
      expect((await get(kind, '', tokens.reader, prefix)).body.status).toBe(200);
      expect((await get(kind, '', tokens.manager, prefix)).body.status).toBe(200);
      expect((await get(kind, '', tokens.unrelated, prefix)).body.status).toBe(400011);
      expect((await get(kind, '', '', prefix)).body.status).toBe(410000);
    }
  });

  it('keeps existing list responses as arrays and registers both directory surfaces behind adminAuth', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) for (const kind of Object.keys(handlers) as Kind[]) {
      const response = await app.request(`${prefix}/${kind}/list`, { headers: { 'Authori-zation': `Bearer ${tokens.reader}` } }, env);
      const body = await response.json<Reply>();
      expect(body.status).toBe(200); expect(Array.isArray(body.data)).toBe(true);
      if (kind === 'system_admin') expect(body.data).toHaveLength(100);
    }
    for (const [file, variable, prefix] of [['src/routes/adminapi.ts', 'adminapiRoutes', ''], ['src/routes/v1/index.ts', 'v1Routes', '/admin']]) {
      const source = readFileSync(file, 'utf8');
      for (const [kind, handler] of [['system_admin', 'adminSystemAdminDirectory'], ['system_role', 'adminSystemRoleDirectory']]) {
        expect(source).toContain(`${variable}.get("${prefix}/${kind}/directory", adminAuth, AdminCrud.${handler});`);
      }
    }
  });
});
