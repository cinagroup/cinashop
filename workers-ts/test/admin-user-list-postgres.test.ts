import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type Container, type DbClient } from '../src/lib/di';
import { user, userGroup, userLabel, userLabelRelation, wechatUser, systemUserLevel, cityArea, systemAdmin, systemRole, systemMenus } from '../src/models/schema';
import { adminUserList } from '../src/controllers/api/v1/AdminCrudController';
import { ApiException } from '../src/utils/errors';
import { listAdminUsers, adminUserFilterOptions, adminUserFilterRegions, parseAdminUserListQuery, parseAdminUserOptionsQuery } from '../src/services/admin/AdminUserListService';
import { createApp } from '../src/app';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

type ListedUser = Record<string, unknown> & { uid: number };
type Reply = { status: number; msg: string; data: { list: ListedUser[]; count: number; page: number; limit: number } | null };
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
    expect(parseAdminUserListQuery({})).toEqual({ page: 1, limit: 10, uid: 0, status: -1, groupId: -1, nickname: '', phone: '', fieldKey: null, searchUid: 0, labels: [], sex: '', level: 0, member: '', promoter: '', timeType: '', range: null, payCount: '', country: '', province: '', city: '', source: '' });
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

// Only DI connection creation is adapted. Registered routes, the real Admin
// JWT/account/password/permission middleware, controller and SQL all execute.
// This is NOT an independent app/Admin PostgreSQL LOGIN privilege proof.
const directoryWiring = vi.hoisted(() => ({ container: undefined as Container | undefined, opened: 0, closed: 0 }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!directoryWiring.container) throw Error('Missing owned directory fixture'); return directoryWiring.container; },
  createAdminDatabaseSession: () => { if (!directoryWiring.container) throw Error('Missing owned Admin directory fixture'); directoryWiring.opened++;
    return { container: directoryWiring.container, close: async () => { directoryWiring.closed++; } }; },
}));

const start = Date.parse('2026-09-30T16:00:00Z') / 1000;
const end = Date.parse('2026-10-02T16:00:00Z') / 1000;
const filterTables = [user, userGroup, userLabel, userLabelRelation, wechatUser, systemUserLevel, cityArea, systemAdmin, systemRole, systemMenus];
const fixtureTables = ['user', 'user_group', 'user_label', 'user_label_relation', 'wechat_user', 'system_user_level', 'city_area', 'system_admin', 'system_role', 'system_menus'];
describe('complete read-only Admin user directory filters and narrow option catalogs', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, container: Container, env: Env;
  const app = createApp(), tokens = new Map<number, string>();
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Directory forbids external I/O'));
    f = await financePostgres(filterTables);
    await f.db.insert(user).values([
      { uid: 101, account: 'fixture101', nickname: '用户 Alice', phone: '13800000101', groupId: 7, level: 1, sex: 1, userType: 'h5', isMoneyLevel: 1, overdueTime: 1, isPromoter: 1, payCount: 2, provincials: '浙江省 杭州市', addres: '杭州', lastTime: start + 1, addTime: start + 1, pwd: 'NEVER_DIRECTORY_PASSWORD' },
      { uid: 102, nickname: '百分%_\\用户', phone: '13800000102', groupId: 7, level: 2, sex: 2, userType: 'wechat', isMoneyLevel: 2, isEverLevel: 1, isPromoter: 0, payCount: 0, addres: '海外地址', lastTime: end - 1, addTime: end - 1 },
      { uid: 103, nickname: '边界开始', phone: '13800000103', groupId: 0, level: 1, sex: 0, userType: 'pc', isMoneyLevel: 0, overdueTime: 2147483647, isPromoter: 1, payCount: 1, addres: '浙江省 杭州市', lastTime: start, addTime: start },
      { uid: 104, nickname: '边界结束', groupId: 9, level: 3, sex: 1, userType: 'routine', isPromoter: 0, payCount: 5, addres: '', lastTime: end, addTime: end },
      { uid: 105, nickname: '前一天', groupId: 7, level: 2, sex: 2, userType: 'app', isMoneyLevel: 3, isPromoter: 1, payCount: 4, addres: '纽约', lastTime: start - 1, addTime: start - 1 },
      { uid: 106, nickname: '后一天', groupId: 9, level: 0, sex: 0, userType: 'h5', payCount: 0, addres: '', lastTime: end + 1, addTime: end + 1 },
      { uid: 107, nickname: '删除标记', isDel: 1 }, { uid: 108, nickname: '删除时间', deleteTime: new Date(0) },
    ]);
    await f.db.insert(userGroup).values([{ id: 7, groupName: 'VIP%_\\分组' }, { id: 9, groupName: '老用户' }]);
    await f.db.insert(userLabel).values([{ id: 7, name: '标签七' }, { id: 8, name: '标签八' }, { id: 9, name: '停用标签', status: 0 }, { id: 10, name: '供应商标签', type: 1, relationId: 77 }, { id: 11, name: '别域标签', type: 0, relationId: 77 }]);
    await f.db.insert(userLabelRelation).values([
      { uid: 101, labelId: 7 }, { uid: 102, labelId: 8 }, { uid: 103, labelId: 7 }, { uid: 103, labelId: 8 },
      { uid: 104, labelId: 7, type: 1, relationId: 77 }, { uid: 105, labelId: 7, type: 0, relationId: 77 }, { uid: 106, labelId: 9 },
    ]);
    await f.db.insert(wechatUser).values([
      { uid: 101, openid: 'fixture101a', country: 'China', province: '江苏', city: '南京' },
      { uid: 101, openid: 'fixture101b', country: '中国', province: '江苏', city: '南京' },
      { uid: 102, openid: 'fixture102', country: 'US', province: '浙江', city: '杭州' },
      { uid: 104, openid: 'fixture104', country: '中国', province: '福建', city: '厦门' },
      { uid: 105, openid: 'fixture105', country: 'US', province: '江苏', city: '南京' },
    ]);
    await f.db.insert(systemUserLevel).values([{ id: 1, name: '一级', isShow: 1 }, { id: 2, name: '二级', isShow: 1 }, { id: 3, name: '隐藏等级', isShow: 0 }, { id: 4, name: '已删除等级', isShow: 1, isDel: 1 }]);
    await f.db.insert(cityArea).values([{ id: 1, parentId: 0, level: 1, name: '浙江省' }, { id: 2, parentId: 0, level: 1, name: '江苏省' }, { id: 11, parentId: 1, level: 2, name: '杭州市' }, { id: 12, parentId: 1, level: 2, name: '宁波市' }, { id: 21, parentId: 2, level: 2, name: '南京市' }, { id: 111, parentId: 11, level: 3, name: '上城区' }]);
    const rules = ['user.view', 'product.manage', 'level.view', 'supplier.manage', 'user.manage'];
    await f.db.insert(systemRole).values(rules.map((rules, i) => ({ id: i + 1, roleName: 'directory-' + i, rules, type: 1, status: 1 })));
    await f.db.insert(systemAdmin).values([...rules.map((_rules, i) => ({ id: i + 1, account: 'directory-' + i, pwd: 'owned-directory-password', level: 1, roles: String(i + 1), adminType: 1 })), { id: 10, account: 'directory-super', pwd: 'owned-directory-password', level: 0, adminType: 1 }]);
    env = { APP_KEY: 'owned-directory-test-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
    for (const id of [1, 2, 3, 4, 5, 10]) tokens.set(id, (await createToken(id, 'admin', md5('owned-directory-password'), env.APP_KEY)).token);
    container = createContainerFromDb(f.db); directoryWiring.container = container; directoryWiring.opened = 0; directoryWiring.closed = 0;
  }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); expect(directoryWiring.closed).toBe(directoryWiring.opened); } finally { tokens.clear(); directoryWiring.container = undefined; vi.restoreAllMocks(); await f?.close(); } });
  const read = (query: Record<string, unknown> = {}) => listAdminUsers(container, query);
  async function idsFor(query: Record<string, unknown>, expected: number[]) {
    const result = await read({ limit: 100, ...query }); expect(result.list.map(r => r.uid)).toEqual(expected); expect(result.count).toBe(expected.length); return result;
  }
  async function state() {
    const rows: Record<string, unknown> = {};
    for (const table of fixtureTables) rows[table] = Array.from(await f.db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)));
    rows.__sequences = [];
    for (const table of fixtureTables) (rows.__sequences as unknown[]).push(...Array.from(await f.db.execute(sql.raw(`SELECT '${table}' AS name,last_value::text,is_called FROM "${table}_${table === 'user' ? 'uid' : 'id'}_seq"`))));
    return rows;
  }
  async function request(prefix: string, route: string, actor: number | null = 1, method = 'GET') {
    const response = await app.request(prefix + '/user/' + route, { method, headers: actor === null ? {} : { Authorization: 'Bearer ' + tokens.get(actor) } }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  it('counts the exact unique UID set and paginates the same conditions without join fanout', async () => {
    const before = await state();
    const a = await read({ country: 'domestic', limit: 1 }); const b = await read({ country: 'domestic', limit: 1, page: 2 }); const c = await read({ country: 'domestic', limit: 1, page: 3 });
    expect(a).toMatchObject({ count: 2, page: 1, limit: 1 }); expect(a.list.map(r => r.uid)).toEqual([104]); expect(b.list.map(r => r.uid)).toEqual([101]); expect(c).toMatchObject({ count: 2, page: 3, list: [] });
    expect(await state()).toEqual(before);
  });
  it('retains exact legacy direct UID/phone, group0/status0 and picker numeric semantics', async () => {
    await idsFor({ uid: '101' }, [101]); await idsFor({ phone: '13800000101' }, [101]); await idsFor({ phone: '138' }, []);
    await idsFor({ group_id: '0' }, [103]); await idsFor({ status: '0' }, []);
    await idsFor({ nickname: '01' }, [103, 102, 101]); // exact numeric UID1 absent; literal phone matches remain unchanged.
    await idsFor({ nickname: '104' }, [104]); await idsFor({ nickname: '4' }, []);
    const values = await read({ uid: 101 }); expect(Object.keys(values.list[0]).sort()).toEqual(columns); expect(JSON.stringify(values)).not.toContain('NEVER_DIRECTORY_PASSWORD');
  });
  it('implements explicit all/UID/phone/nickname modes without changing old picker behavior', async () => {
    await idsFor({ field_key: 'all', nickname: '4' }, [104]); await idsFor({ field_key: '', nickname: '4' }, [104]);
    await idsFor({ field_key: 'uid', nickname: '00104' }, [104]); await idsFor({ field_key: 'phone', nickname: '1380000010' }, [103, 102, 101]);
    await idsFor({ field_key: 'nickname', nickname: 'alice' }, [101]); await idsFor({ field_key: 'nickname', nickname: '101' }, []);
    await idsFor({ field_key: 'uid', nickname: '101', uid: '102' }, []);
  });
  it('keeps bound wildcard, backslash, quote and control grammar strict across search and options', async () => {
    for (const keyword of ['%', '_', '\\', '%_\\']) await idsFor({ field_key: 'all', nickname: keyword }, [102]);
    await idsFor({ field_key: 'all', nickname: "' OR 1=1 --" }, []);
    expect(await adminUserFilterOptions(container, { kind: 'groups', keyword: '%_\\' })).toMatchObject({ count: 1, list: [{ id: 7, name: 'VIP%_\\分组' }] });
  });
  it('keeps complete labels ANY including a second-only tag and prevents other tenant relation matches', async () => {
    await idsFor({ label_ids: '7,8' }, [103, 102, 101]); await idsFor({ label_id: '8' }, [103, 102]);
    await idsFor({ label_ids: '7' }, [103, 101]); await idsFor({ label_ids: '9' }, [106]);
    await idsFor({ label_ids: '7,8', group_id: '7', isMember: '1', user_type: 'wechat', pay_count: '-1' }, [102]);
    await idsFor({ label_ids: '7,8', group_id: '7', isMember: '1', user_type: 'h5', pay_count: '1' }, [101]);
  });
  it('uses user sex/source/promoter/level and stored paid-member marker rather than expiry or WeChat identity', async () => {
    await idsFor({ sex: '0' }, [106, 103]); await idsFor({ sex: '2' }, [105, 102]);
    await idsFor({ level: '1' }, [103, 101]); await idsFor({ level: '0' }, [106, 105, 104, 103, 102, 101]);
    await idsFor({ isMember: '1' }, [105, 102, 101]); await idsFor({ isMember: '0' }, [106, 104, 103]);
    await idsFor({ is_promoter: '0' }, [106, 104, 102]); await idsFor({ is_promoter: '1' }, [105, 103, 101]);
    for (const [source, ids] of [['h5', [106, 101]], ['wechat', [102]], ['routine', [104]], ['pc', [103]], ['app', [105]]] as const) await idsFor({ user_type: source }, [...ids]);
  });
  it.each([['-1', [106, 102]], ['0', [105, 104, 103, 101]], ['1', [105, 104, 101]], ['2', [105, 104]], ['3', [105, 104]], ['4', [104]]] as const)('preserves PHP order-count threshold %s', async (pay_count, values) => { await idsFor({ pay_count }, [...values]); });
  it('ANDs the complete parenthesized geo OR group against other filters, retaining no-WeChat address matches', async () => {
    await idsFor({ country: 'domestic' }, [104, 101]); await idsFor({ country: 'abroad' }, [106, 104]);
    await idsFor({ country: 'domestic', province: '浙江' }, [104, 103, 102, 101]);
    await idsFor({ province: '浙江', city: '南京' }, [105, 103, 102, 101]);
    await idsFor({ province: '浙江', city: '南京', group_id: 9 }, []);
    await idsFor({ country: 'domestic', province: '浙江', group_id: 7 }, [102, 101]);
    await idsFor({ province: '%' }, []);
  });
  it('uses Asia/Shanghai calendar dates and preserves all strict visit/add/unvisited endpoints', async () => {
    const user_time = '2026/10/01-2026/10/02';
    expect(parseAdminUserListQuery({ user_time, user_time_type: 'visit' }).range).toEqual({ start, end });
    await idsFor({ user_time, user_time_type: 'visit' }, [102, 101]); await idsFor({ user_time, user_time_type: 'add_time' }, [102, 101]);
    await idsFor({ user_time, user_time_type: 'visitno' }, [106, 105]);
    await idsFor({ user_time, user_time_type: 'visitno', group_id: 7 }, [105]);
  });
  it('returns bounded paged option names and resolves chosen IDs independently of keyword/page without dropping unavailable filters', async () => {
    await f.db.insert(userGroup).values(Array.from({ length: 103 }, (_, i) => ({ id: 100 + i, groupName: '分页分组' + i })));
    const result = await adminUserFilterOptions(container, { kind: 'groups', limit: '100', selected_ids: '9,999,7' });
    expect(result).toMatchObject({ count: 105, page: 1, limit: 100, selected: [{ id: 9, name: '老用户' }, { id: 7, name: 'VIP%_\\分组' }], missing_ids: [999] }); expect(result.list).toHaveLength(100);
    expect(await adminUserFilterOptions(container, { kind: 'groups', page: '2', limit: '100' })).toMatchObject({ count: 105, page: 2, limit: 100 });
    const searched = await adminUserFilterOptions(container, { kind: 'labels', keyword: '七', page: '2', limit: 1, selected_ids: '8,9,10,11,999' });
    expect(searched).toEqual({ list: [], count: 1, page: 2, limit: 1, selected: [{ id: 8, name: '标签八' }], missing_ids: [9, 10, 11, 999] });
    expect(await adminUserFilterOptions(container, { kind: 'levels', selected_ids: '1,3,4' })).toMatchObject({ list: [{ id: 1, name: '一级' }, { id: 2, name: '二级' }], count: 2, selected: [{ id: 1, name: '一级' }], missing_ids: [3, 4] });
    await idsFor({ label_ids: '9' }, [106]); // unavailable chip is explicit; active imported filter is not erased.
  });
  it('adapts the same lazy city_area labels, never exposes district/street or an unbounded tree', async () => {
    expect(await adminUserFilterRegions(container, env, {})).toEqual([{ id: 1, name: '浙江省', children: [] }, { id: 2, name: '江苏省', children: [] }]);
    expect(await adminUserFilterRegions(container, env, { pid: '1' })).toEqual([{ id: 11, name: '杭州市' }, { id: 12, name: '宁波市' }]);
    for (const pid of ['11', '111', '999', '-1', '2147483648']) await expect(adminUserFilterRegions(container, env, { pid })).rejects.toThrow();
    await f.db.insert(cityArea).values(Array.from({ length: 1001 }, (_, i) => ({ id: 1000 + i, parentId: 2, level: 2, name: '超额市' + i })));
    await expect(adminUserFilterRegions(container, env, { pid: '2' })).rejects.toThrow('安全上限');
  });
  it.each(['/adminapi', '/api/admin'])('executes both registered aliases with real JWT, exact DTO/no-store and complete DB/sequence zero writes at %s', async prefix => {
    const before = await state();
    for (const route of ['list?label_ids=7,8&limit=1', 'filter_options?kind=groups&selected_ids=7,99', 'filter_options?kind=labels', 'filter_options?kind=levels', 'filter_regions', 'filter_regions?pid=1']) {
      const result = await request(prefix, route); expect(result.body.status, result.body.msg).toBe(200); expect(result.response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(result.response.headers.get('pragma')).toBe('no-cache');
    }
    expect(await state()).toEqual(before);
  });
  it('enforces user.view only and checks auth before opening the Admin SQL session, including live revocation', async () => {
    const before = await state();
    for (const prefix of ['/adminapi', '/api/admin']) for (const route of ['list', 'filter_options?kind=groups', 'filter_regions']) {
      expect((await request(prefix, route, null)).body.status).toBe(410000);
      for (const actor of [2, 3, 4]) expect((await request(prefix, route, actor)).body.status).toBe(400011);
      expect(directoryWiring.opened).toBe(0);
      expect((await request(prefix, route, 1)).body.status).toBe(200); directoryWiring.opened = directoryWiring.closed = 0;
      expect((await request(prefix, route, 5)).body.status).toBe(200); directoryWiring.opened = directoryWiring.closed = 0;
      expect((await request(prefix, route, 10)).body.status).toBe(200); directoryWiring.opened = directoryWiring.closed = 0;
    }
    expect(await state()).toEqual(before);
    await f.db.update(systemRole).set({ rules: 'level.view' }).where(eq(systemRole.id, 1));
    for (const route of ['list', 'filter_options?kind=labels', 'filter_regions']) expect((await request('/adminapi', route)).body.status).toBe(400011);
    expect(directoryWiring.opened).toBe(0);
    for (const prefix of ['/adminapi', '/api/admin']) for (const route of ['filter_options', 'filter_regions']) {
      expect(requiredAdminPermission('GET', prefix + '/user/' + route)).toBe('user.view');
      for (const method of ['POST', 'PUT', 'DELETE']) { expect(requiredAdminPermission(method, prefix + '/user/' + route)).toBeNull(); expect((await request(prefix, route, 10, method)).body.status).not.toBe(200); }
    }
  });
  it('rejects malformed/duplicate/unknown bounded filter and option grammar before any business transaction', async () => {
    const transaction = vi.spyOn(f.db, 'transaction');
    const bad = ['field_key=account', 'field_key=uid&nickname=abc', 'field_key=uid&nickname=2147483648', 'label_ids=7,7', 'label_ids=0', 'label_ids=7,,8', 'label_ids=7.1', 'label_ids=7&label_id=8', 'label_ids=' + Array.from({ length: 101 }, (_, i) => i + 1).join(','), 'sex=3', 'isMember=true', 'is_promoter=2', 'pay_count=5', 'pay_count=-2', 'user_type=supplier', 'country=US', 'province=%00', 'user_time_type=visit', 'user_time=2026/10/01-2026/10/02', 'user_time_type=all', 'user_time_type=visit&user_time=2026/02/30-2026/03/01', 'user_time_type=visit&user_time=2026/10/02-2026/10/01', 'user_time_type=visit&user_time=2026-10-01,2026-10-02', 'sex=0&sex=1', 'label_ids[]=7', 'supplier_id=1'];
    for (const query of bad) expect((await request('/adminapi', 'list?' + query)).body.status, query).toBe(400);
    for (const query of ['kind=unknown', 'kind=labels&selected_ids=7,7', 'kind=labels&selected_ids=0', 'kind=labels&selected_ids=2147483648', 'kind=labels&owner_id=1', 'kind=groups&page=1&page=2', 'kind=labels&selected_ids=7&selected_ids=8', 'kind=levels&keyword=%00']) expect((await request('/adminapi', 'filter_options?' + query)).body.status, query).toBe(400);
    for (const query of ['pid=1&pid=2', 'pid=-1', 'pid=2147483648', 'keyword=x']) expect((await request('/api/admin', 'filter_regions?' + query)).body.status, query).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
    for (const raw of [{ selected_ids: [7] }, { kind: true }, { kind: 'labels', selected_ids: '01' }, { kind: 'groups', keyword: 1 }]) expect(() => parseAdminUserOptionsQuery(raw)).toThrow();
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('keeps count and page from the same native RR snapshot across an actual concurrent commit', async () => {
    const original = f.db.transaction.bind(f.db); let intervened = false;
    const decorate = (builder: object): object => new Proxy(builder, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'then') return (yes: (v: unknown) => unknown, no: (e: unknown) => unknown) => Reflect.apply(value, target, [async (rows: unknown) => {
        if (!intervened) { intervened = true; await f.exec(`INSERT INTO "user"(uid,nickname) VALUES(199,'concurrent directory insert')`); }
        return yes(rows);
      }, no]);
      return typeof value === 'function' ? (...args: unknown[]) => { const next = Reflect.apply(value, target, args); return next && typeof next === 'object' ? decorate(next) : next; } : value;
    } });
    const db = new Proxy(f.db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return (callback: (tx: DbClient) => Promise<unknown>, config: unknown) => original(async tx => callback(new Proxy(tx, { get(t, k, r) {
        const value = Reflect.get(t, k, r); if (k !== 'select') return value;
        return (fields: Record<string, unknown>) => { const query = Reflect.apply(value, t, [fields]); if (!query || typeof query !== 'object') throw Error('Expected actual query builder'); return Object.hasOwn(fields, 'count') ? decorate(query) : query; };
      } }) as unknown as DbClient), config as Parameters<typeof original>[1]);
    } });
    const first = await listAdminUsers({ ...container, db }, { limit: 100 });
    expect(intervened).toBe(true); expect(first.count).toBe(6); expect(first.list.map(row => row.uid)).toEqual([106, 105, 104, 103, 102, 101]);
    const next = await read({ limit: 100 }); expect(next.count).toBe(7); expect(next.list[0].uid).toBe(199);
  });
});
