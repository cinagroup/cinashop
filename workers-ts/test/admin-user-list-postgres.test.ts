import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { user } from '../src/models/schema/user';
import { adminUserList } from '../src/controllers/api/v1/AdminCrudController';
import { ApiException } from '../src/utils/errors';
import { parseAdminUserListQuery } from '../src/services/admin/AdminUserListService';
import { financePostgres } from './helpers/financePostgres';

type ListedUser = Record<string, unknown> & { uid: number };
type Reply = { status: number; msg: string; data: { list: ListedUser[]; page: number; limit: number } | null };
const columns = ['uid', 'account', 'nickname', 'phone', 'avatar', 'integral', 'level', 'status',
  'nowMoney', 'addTime', 'spreadUid', 'groupId', 'now_money', 'add_time', 'spread_uid', 'group_id'].sort();

// Controller + real SQL with no auth middleware on this isolated test app.
// Real authentication/LOGINs are exercised separately in the runtime suite.
describe('bounded Admin user-list read contract', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await financePostgres([user]);
    await f.db.insert(user).values([
      { uid: 11, account: 'local-eleven', nickname: '测试 Alice', phone: '00000000011', nowMoney: '12.34', integral: 50,
        addTime: 123, spreadUid: 22, groupId: 7, pwd: 'LOCAL_PASSWORD_SENTINEL', cardId: 'LOCAL_CARD_SENTINEL',
        addIp: '127.0.0.1', lastIp: '127.0.0.2', uniqid: 'LOCAL_UNIQ_SENTINEL', barCode: 'LOCAL_BAR_SENTINEL',
        randCode: 123456, extendInfo: 'LOCAL_EXTEND_SENTINEL', levelExtendInfo: 'LOCAL_LEVEL_SENTINEL' },
      { uid: 22, account: 'local-twenty-two', nickname: '百分%_\\样本', phone: '00000000022', status: 0 },
      { uid: 33, nickname: '测试 删除', isDel: 1 },
      { uid: 44, nickname: '测试 删除时间', deleteTime: new Date(0) },
    ]);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', createContainerFromDb(f.db)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    app.get('/api/admin/user/list', adminUserList);
    app.get('/adminapi/user/list', adminUserList);
  }, 30_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  });
  async function read(query = '', prefix = '/api/admin') {
    const response = await app.request(prefix + '/user/list' + query);
    return { response, body: await response.json<Reply>() };
  }
  const state = () => f.db.select().from(user).orderBy(user.uid);

  it.each(['/api/admin', '/adminapi'])('projects only list fields before serialization at %s', async prefix => {
    const before = await state();
    const { response, body } = await read('?uid=11', prefix);
    expect(body.status, body.msg).toBe(200);
    expect(Object.keys(body.data!.list[0]).sort()).toEqual(columns);
    expect(JSON.stringify(body)).not.toContain('SENTINEL');
    expect(body.data).toMatchObject({ page: 1, limit: 10, list: [{ uid: 11, nowMoney: '12.34', now_money: '12.34',
      addTime: 123, add_time: 123, spreadUid: 22, spread_uid: 22, groupId: 7, group_id: 7, integral: 50 }] });
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(await state()).toEqual(before);
  });

  it('keeps deterministic pages and excludes both deletion markers without hiding disabled users', async () => {
    const before = await state();
    for (const [page, ids] of [[1, [22]], [2, [11]], [3, []]] as const) {
      const { body } = await read(`?page=${page}&limit=1`);
      expect(body.status, body.msg).toBe(200);
      expect(body.data!.list.map(row => row.uid)).toEqual(ids);
    }
    expect((await read('?status=0')).body.data!.list.map(row => row.uid)).toEqual([22]);
    expect((await read('?status=1')).body.data!.list.map(row => row.uid)).toEqual([11]);
    expect(await state()).toEqual(before);
  });

  it('searches the legacy nickname field by nickname/phone or exact UID and intersects precise filters', async () => {
    for (const keyword of ['alice', '测试', '00000000011', '11']) {
      const { body } = await read('?nickname=' + encodeURIComponent(keyword));
      expect(body.status, body.msg).toBe(200);
      expect(body.data!.list.map(row => row.uid)).toEqual([11]);
    }
    for (const query of ['?uid=11&group_id=7', '?phone=00000000011', '?nickname=alice&status=1']) {
      expect((await read(query)).body.data!.list.map(row => row.uid)).toEqual([11]);
    }
    for (const query of ['?uid=11&group_id=0', '?uid=11&nickname=absent', '?phone=0000', '?uid=33', '?uid=44']) {
      expect((await read(query)).body.data!.list).toEqual([]);
    }
  });

  it('treats wildcard metacharacters and quotes as literal bound search text', async () => {
    for (const keyword of ['%', '_', '\\', '%_\\']) {
      const { body } = await read('?nickname=' + encodeURIComponent(keyword));
      expect(body.status, body.msg).toBe(200);
      expect(body.data!.list.map(row => row.uid)).toEqual([22]);
    }
    const { body } = await read('?nickname=' + encodeURIComponent("' OR 1=1 --"));
    expect(body.status, body.msg).toBe(200); expect(body.data!.list).toEqual([]);
  });

  it('rejects malformed, duplicate and unsupported filters before a business SELECT', async () => {
    const select = vi.spyOn(f.db, 'select');
    const before = await state(); select.mockClear();
    const transaction = vi.spyOn(f.db, 'transaction');
    const invalid = ['page=0', 'limit=0', 'page=-1', 'limit=-1', 'page=1.5', 'page=1e2', 'page=0x10',
      'page=10001', 'limit=101', 'limit=Infinity', 'page=NaN', 'uid=0', 'uid=2147483648', 'uid=-1',
      'uid=1,2', 'group_id=-1', 'status=2', 'status=false', 'page=1&page=2', 'nickname=x&nickname=y',
      'phone=' + '0'.repeat(16), 'nickname=' + 'x'.repeat(101), 'nickname=%00', 'nickname=%0A', 'is_del=1', 'uid[]=11'];
    for (const query of invalid) {
      const { response, body } = await read('?' + query);
      expect(body.status, query + ': ' + body.msg).toBe(400); expect(body.data).toBeNull();
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect(select).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  it('caps the maximum page size and returns only the requested offset, never an unbounded list', async () => {
    await f.db.insert(user).values(Array.from({ length: 105 }, (_, i) => ({ uid: 100 + i, nickname: `Local ${i}` })));
    const first = (await read('?limit=100')).body;
    const second = (await read('?page=2&limit=100')).body;
    expect(first.data!.list).toHaveLength(100); expect(second.data!.list).toHaveLength(7);
    expect(new Set([...first.data!.list, ...second.data!.list].map(row => row.uid)).size).toBe(107);
  });

  it('restores transaction-local settings after reading', async () => {
    const settings = async () => Array.from(await f.db.execute(sql`SELECT current_setting('statement_timeout') AS timeout,
      current_setting('transaction_read_only') AS readonly`));
    const before = await settings();
    expect((await read()).body.status).toBe(200);
    expect(await settings()).toEqual(before);
  });

  it.each([0, 250])('enforces read-only SQL and preserves a stricter %i ms timeout', async timeout => {
    const before = await state();
    await f.db.execute(sql`SELECT set_config('statement_timeout', ${String(timeout)}, false)`);
    const transaction = f.db.transaction.bind(f.db);
    const observed: unknown[] = [];
    const observe: typeof f.db.transaction = (callback, config) => transaction(async tx => {
      const result = await callback(tx);
      observed.push(...Array.from(await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
        (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS timeout`)));
      // Savepoint isolates the expected SQL error; no test write may commit.
      await expect(tx.transaction(nested => nested.execute(sql`UPDATE ${user} SET integral=999 WHERE uid=11`)))
        .rejects.toMatchObject({ cause: { code: '25006' } });
      return result;
    }, config);
    // Do not spy on the PGlite row-array adapter's underlying transaction:
    // that wraps execute results twice. Intercept only this container boundary.
    f.db = new Proxy(f.db, { get: (target, key, receiver) => key === 'transaction'
      ? observe : Reflect.get(target, key, receiver) });
    const { body } = await read();
    expect(body.status, body.msg).toBe(200);
    expect(observed).toEqual([{ readonly: 'on', timeout: timeout || 5000 }]);
    expect(Array.from(await f.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
      (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS timeout`)))
      .toEqual([{ readonly: 'off', timeout }]);
    expect(await state()).toEqual(before);
  });
});

describe('Admin user-list input types', () => {
  it('defaults only missing/empty filters, preserving explicit zero status and group', () => {
    expect(parseAdminUserListQuery({})).toEqual({ page: 1, limit: 10, uid: 0, status: -1, groupId: -1, nickname: '', phone: '' });
    expect(parseAdminUserListQuery({ page: 2, limit: 100, status: '0', group_id: '0', nickname: '  Alice  ' }))
      .toMatchObject({ page: 2, limit: 100, status: 0, groupId: 0, nickname: 'Alice' });
  });
  it.each([null, true, [], {}, 1.5, 'Infinity'])('rejects invalid numeric values without coercion: %j', value => {
    expect(() => parseAdminUserListQuery({ page: value })).toThrow();
  });
  it.each([null, true, [], {}, 123])('rejects non-string nickname values: %j', nickname => {
    expect(() => parseAdminUserListQuery({ nickname })).toThrow();
  });
});
