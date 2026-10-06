import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type Container, type DbClient } from '../src/lib/di';
import { storeBargain, storeCombination, storeIntegral, storeSeckill, systemAdmin, systemRole } from '../src/models/schema';
import { adminBargainList, adminCombinationList, adminIntegralList, adminSeckillList } from '../src/controllers/api/v1/AdminCrudController';
import { listAdminActivities, parseAdminActivityListQuery } from '../src/services/admin/AdminActivityListService';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { adminAuthMiddleware } from '../src/middleware/admin-auth';
import { ApiException } from '../src/utils/errors';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const tables = { seckill: storeSeckill, combination: storeCombination, bargain: storeBargain, integral: storeIntegral };
const handlers = { seckill: adminSeckillList, combination: adminCombinationList, bargain: adminBargainList, integral: adminIntegralList };
type Activity = keyof typeof tables;
type Reply = { status: number; msg: string; data: any };

describe('Admin activity lists share bounded pagination, filtering and authorization', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let tokens: { reader: string; unrelated: string; manager: string };
  const env = { APP_KEY: 'activity-list-fixture-signing-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
  const types = Object.keys(tables) as Activity[];
  const expectedIds = [1, ...Array.from({ length: 123 }, (_, index) => 124 - index)];

  beforeAll(async () => {
    fixture = await financePostgres([...Object.values(tables), systemAdmin, systemRole]);
    container = createContainerFromDb(fixture.db);
    for (const type of types) {
      const rows = Array.from({ length: 125 }, (_, index) => {
        const id = index + 1;
        const name = id === 1 ? '折扣%商品' : id === 2 ? 'under_score' : id === 3 ? 'slash\\name' : `活动 ${id}`;
        return { id, storeName: type === 'bargain' ? `源商品 ${id}` : name,
          title: name, sort: id === 1 ? 50 : Math.floor(id / 10), status: id % 2,
          isDel: id === 125 ? 1 : 0, productId: 70, price: '12.50', stock: 9, quota: 20, quotaShow: 8,
          timeId: '7,8', people: 3, integral: 120, rule: '保留砍价规则', customForm: '{"fixture":true}' };
      });
      await fixture.db.insert(tables[type]).values(rows);
    }
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: '只读活动', rules: 'activity.view' },
      { id: 2, roleName: '其他权限', rules: 'product.view' },
      { id: 3, roleName: '仅活动写权限', rules: 'activity.manage' },
    ]);
    await fixture.db.insert(systemAdmin).values([1, 2, 3].map(id => ({
      id, account: `activity-fixture-${id}`, pwd: 'fixture-password', level: 1, roles: String(id), adminType: 1,
    })));
    const signed = await Promise.all([1, 2, 3].map(async id => (await createToken(id, 'admin', md5('fixture-password'), env.APP_KEY)).token));
    tokens = { reader: signed[0], unrelated: signed[1], manager: signed[2] };
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    const auth = adminAuthMiddleware();
    for (const type of types) {
      app.get(`/adminapi/activity/${type}`, auth, handlers[type]);
      app.get(`/api/admin/activity/${type}`, auth, handlers[type]);
    }
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  async function get(type: Activity, query = '', token = tokens.reader, prefix = '/adminapi') {
    const response = await app.request(`${prefix}/activity/${type}${query}`, {
      headers: token ? { 'Authori-zation': `Bearer ${token}` } : {},
    }, env);
    return { response, body: await response.json<Reply>() };
  }

  it.each(types)('%s exposes all 124 live records across pages in stable sort/id order', async type => {
    const ids: number[] = [];
    for (let page = 1; page <= 7; page++) {
      const { response, body } = await get(type, `?page=${page}&limit=20`);
      expect(body.status).toBe(200);
      expect(body.data).toMatchObject({ count: 124, page, limit: 20 });
      expect(body.data.list.length).toBe(page === 7 ? 4 : 20);
      expect(response.headers.get('cache-control')).toContain('private');
      expect(response.headers.get('cache-control')).toContain('no-store');
      ids.push(...body.data.list.map((row: { id: number }) => row.id));
    }
    expect(ids).toEqual(expectedIds);
    expect(new Set(ids).size).toBe(124);
    expect((await get(type, '?page=1&limit=20')).body.data.list.map((row: { id: number }) => row.id)).toEqual(ids.slice(0, 20));
  });

  it.each(types)('%s preserves capped legacy arrays and the complete editor row fields', async type => {
    const legacy = (await get(type)).body;
    expect(legacy.status).toBe(200);
    expect(Array.isArray(legacy.data)).toBe(true);
    expect(legacy.data).toHaveLength(100);
    expect(legacy.data.map((row: { id: number }) => row.id)).toEqual(expectedIds.slice(0, 100));
    expect(legacy.data[0]).toMatchObject({ id: 1, productId: 70, price: '12.50', stock: 9, quota: 20, quotaShow: 8, customForm: '{"fixture":true}' });
    if (type === 'seckill') expect(legacy.data[0].timeId).toBe('7,8');
    if (type === 'combination') expect(legacy.data[0].people).toBe(3);
    if (type === 'integral') expect(legacy.data[0].integral).toBe(120);
    if (type === 'bargain') expect(legacy.data[0]).toMatchObject({ title: '折扣%商品', rule: '保留砍价规则' });
    const pageOnly = (await get(type, '?page=2')).body.data;
    expect(pageOnly).toMatchObject({ page: 2, limit: 20, count: 124 });
    expect(pageOnly.list.map((row: { id: number }) => row.id)).toEqual(expectedIds.slice(20, 40));
    expect((await get(type, '?limit=3')).body.data).toMatchObject({ page: 1, limit: 3, count: 124 });
  });

  it.each(types)('%s applies identical keyword/status/soft-delete predicates to count and rows', async type => {
    for (const [keyword, id] of [['%', 1], ['_', 2], ['\\', 3]] as const) {
      const data = (await get(type, `?page=1&limit=1&keyword=${encodeURIComponent(keyword)}`)).body.data;
      expect(data).toMatchObject({ count: 1, page: 1, limit: 1 });
      expect(data.list.map((row: { id: number }) => row.id)).toEqual([id]);
    }
    const enabled = (await get(type, '?page=1&limit=100&status=1')).body.data;
    expect(enabled.count).toBe(62);
    expect(enabled.list.map((row: { id: number }) => row.id)).toEqual(expectedIds.filter(id => id % 2 === 1));
    const disabled = (await get(type, '?page=1&limit=100&status=0')).body.data;
    expect(disabled.count).toBe(62);
    expect(disabled.list.every((row: { status: number }) => row.status === 0)).toBe(true);
    expect((await get(type, '?page=1&keyword=%25&status=0')).body.data).toMatchObject({ list: [], count: 0 });
    expect((await get(type, '?page=1&keyword=125')).body.data).toMatchObject({ list: [], count: 0 });
    expect((await get(type, '?keyword=%20%25%20')).body.data.map((row: { id: number }) => row.id)).toEqual([1]);
    expect((await get(type, '?page=101&limit=100')).body.data).toEqual({ list: [], count: 124, page: 101, limit: 100 });
  });

  it('searches migrated bargain storeName as well as the editor title', async () => {
    const data = (await get('bargain', `?page=1&keyword=${encodeURIComponent('源商品 124')}`)).body.data;
    expect(data.count).toBe(1);
    expect(data.list[0].id).toBe(124);
  });

  it.each(types)('%s retains activity.view on both authenticated route families', async type => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(requiredAdminPermission('GET', `${prefix}/activity/${type}`)).toBe('activity.view');
      expect((await get(type, '?page=1', tokens.reader, prefix)).body.status).toBe(200);
      // The existing permission expansion grants view to activity.manage.
      expect((await get(type, '?page=1', tokens.manager, prefix)).body.status).toBe(200);
      for (const token of ['', tokens.unrelated]) {
        expect((await get(type, '?page=1', token, prefix)).body.status).not.toBe(200);
      }
    }
  });

  it.each(types)('%s rejects bad or ambiguous queries before any list transaction', async type => {
    const invalid = ['page=', 'page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=01', 'page=%201', 'page=10002',
      'limit=', 'limit=0', 'limit=101', 'page=102&limit=100', 'page=2&page=1', 'limit=2&limit=2',
      'keyword=a&keyword=b', 'status=0&status=1', 'status=', 'status=2', 'status=01', 'keyword=%00', 'keyword=%0a',
      `keyword=${'a'.repeat(101)}`, 'unknown=1'];
    for (const query of invalid) {
      const { response, body } = await get(type, `?${query}`);
      expect(body.status, query).toBe(400);
      expect(response.headers.get('cache-control'), query).toContain('no-store');
    }
  });

  it('uses one read-only repeatable-read transaction for rows and count with a local timeout', async () => {
    let transactions = 0, selections = 0;
    const observedDb = new Proxy(fixture.db, {
      get(target, property) {
        if (property === 'select') throw new Error('Activity list queried outside the snapshot');
        if (property === 'transaction') return async (callback: (db: DbClient) => Promise<unknown>) => {
          transactions++;
          return target.transaction(async tx => {
            const observedTx = new Proxy(tx, {
              get(inner, method) {
                const value = Reflect.get(inner, method);
                if (method === 'select') return (...args: unknown[]) => { selections++; return Reflect.apply(value, inner, args); };
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            }) as unknown as DbClient;
            const result = await callback(observedTx);
            const settings = await observedTx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout`);
            expect(settings[0]).toMatchObject({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' });
            return result;
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await listAdminActivities({ ...container, db: observedDb }, 'seckill', new URLSearchParams('page=1&limit=20'));
    expect(transactions).toBe(1);
    expect(selections).toBe(2);
    const settings = await fixture.db.execute(sql`SELECT current_setting('statement_timeout') AS timeout`);
    expect(settings[0].timeout).toBe('0');
  });
});

describe('Admin activity query bounds', () => {
  it('accepts the inclusive maximum offset and bounded Unicode text', () => {
    expect(parseAdminActivityListQuery(new URLSearchParams('page=10001&limit=1'))).toMatchObject({ offset: 10000 });
    expect(parseAdminActivityListQuery(new URLSearchParams({ keyword: '😀'.repeat(100) }))).toMatchObject({ keyword: '😀'.repeat(100) });
  });
});
