import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { memberShip, systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { ApiErrorCode } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, opened: 0, closed: 0 }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Missing owned member-package application fixture');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Missing owned member-package Admin fixture');
    wiring.opened++;
    return { container: wiring.container, close: async () => { wiring.closed++; } };
  },
}));

type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
type Package = { id: number; type: string; title: string; vip_day: number; price: string;
  pre_price: string; is_label: number; sort: number; is_del: number; add_time: number };
type Envelope = { status: number; msg: string; data: unknown };
type PackagePage = { list: Package[]; count: number };
const PASSWORD = 'owned-member-packages-password';
const PLAN_COLUMNS = ['id', 'type', 'title', 'vip_day', 'price', 'pre_price', 'is_label', 'sort', 'is_del', 'add_time'].sort();
// Fixture expectation deliberately includes ties, more than100 active plans and
// stopped plans. It is independent of the service's query/projection helpers.
const seeds = Array.from({ length: 125 }, (_, index) => ({
  id: 7001 + index, type: ['month', 'quarter', 'year', 'ever', 'free'][index % 5],
  title: `原生套餐 ${String(index + 1).padStart(3, '0')}`,
  vipDay: index % 5 === 3 ? -1 : 30 + index,
  price: index % 5 === 4 ? '0.00' : '29.00',
  prePrice: index % 5 === 4 ? '0.00' : '19.00',
  isLabel: index === 124 ? 1 : 0, sort: index % 7,
  isDel: index % 9 === 0 ? 1 : 0, addTime: 1_790_000_000 + index,
}));
const ordered = [...seeds].sort((a, b) => b.sort - a.sort || a.id - b.id);
const activeIds = ordered.filter(row => row.isDel === 0).map(row => row.id);
const allIds = ordered.map(row => row.id);

/** Real createApp registration, Admin JWT/account/password/live role middleware,
 * controller and SQL. Only the DI connections select this suite's owned database;
 * this is not an independent application/Admin PostgreSQL LOGIN-ACL proof.
 * Ordinary CI runs actual PGlite SQL; TEST_FINANCE_POSTGRES_URL opts into PG16.
 * No card issuance, redemption, membership purchase or payment is exercised. */
describe('Admin member-package active/all pagination and reversible state on registered HTTP', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env, app: ReturnType<typeof createApp>;
  let tables: string[], sequences: string[];
  const tokens = new Map<number, string>();
  const objects = new Map([['owned-member-packages-sentinel', { type: 'image/png', bytes: [137, 80, 78, 71] }]]);
  const forbiddenResource = async () => { throw Error('Member-package route attempted resource I/O'); };
  const bucket = { get: vi.fn(forbiddenResource), head: vi.fn(forbiddenResource), list: vi.fn(forbiddenResource),
    put: vi.fn(forbiddenResource), delete: vi.fn(forbiddenResource) };
  const queue = { send: vi.fn(forbiddenResource), sendBatch: vi.fn(forbiddenResource) };

  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Member-package fixture forbids external I/O'));
    // All columns/defaults come from the current ORM through the existing owned
    // fixture. No shared fixture, production migration or hand-built route.
    f = await financePostgres([memberShip, systemAdmin, systemRole, systemMenus], { namespace: 'public' });
    await f.db.insert(memberShip).values(seeds);
    await f.db.insert(systemRole).values([
      { id: 1, roleName: '套餐管理', rules: 'paid_membership.manage', status: 1 },
      { id: 2, roleName: '套餐只读', rules: 'paid_membership.view', status: 1 },
      { id: 3, roleName: '其他业务', rules: 'user.manage', status: 1 },
    ]);
    await f.db.insert(systemAdmin).values([
      { id: 100, account: 'packages-super', pwd: PASSWORD, level: 0, adminType: 1, status: 1 },
      { id: 101, account: 'packages-manager', pwd: PASSWORD, roles: '1', level: 1, adminType: 1, status: 1 },
      { id: 102, account: 'packages-reader', pwd: PASSWORD, roles: '2', level: 1, adminType: 1, status: 1 },
      { id: 103, account: 'packages-unrelated', pwd: PASSWORD, roles: '3', level: 1, adminType: 1, status: 1 },
      { id: 104, account: 'packages-disabled', pwd: PASSWORD, roles: '1', level: 1, adminType: 1, status: 0 },
      { id: 105, account: 'packages-deleted', pwd: PASSWORD, roles: '1', level: 1, adminType: 1, status: 1, isDel: 1 },
      { id: 106, account: 'packages-supplier-realm', pwd: PASSWORD, roles: '1', level: 1, adminType: 2, status: 1 },
      { id: 107, account: 'packages-password-changed', pwd: 'different-current-password', roles: '1', level: 1, adminType: 1, status: 1 },
    ]);
    env = { APP_KEY: 'owned-member-packages-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      ASSETS_BUCKET: bucket, ORDER_QUEUE: queue } as unknown as Env;
    for (const id of [100, 101, 102, 103, 104, 105, 106, 107]) {
      tokens.set(id, (await createToken(id, 'admin', md5(PASSWORD), env.APP_KEY)).token);
    }
    tokens.set(108, (await createToken(101, 'api', md5(PASSWORD), env.APP_KEY)).token);
    wiring.container = createContainerFromDb(f.db); wiring.opened = wiring.closed = 0; app = createApp();
    tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    expect(tables).toEqual(['member_ship', 'system_admin', 'system_menus', 'system_role']);
    expect(sequences).toEqual(['member_ship_id_seq', 'system_admin_id_seq', 'system_menus_id_seq', 'system_role_id_seq']);
  }, 30_000);
  afterAll(async () => {
    try {
      expect(fetch).not.toHaveBeenCalled(); expect(wiring.closed).toBe(wiring.opened);
      for (const operation of [...Object.values(bucket), ...Object.values(queue)]) expect(operation).not.toHaveBeenCalled();
    } finally { wiring.container = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  async function snapshot(): Promise<Snapshot> {
    const state: Snapshot = {};
    for (const table of tables) state[table] = (await f.db.execute<{ row: Row }>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t ORDER BY to_jsonb(t)::text`)).map(row => row.row);
    state.__sequences = await f.db.execute<Row>(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
    return state;
  }
  const resources = () => ({ objects: [...objects].map(([key, value]) => ({ key, type: value.type, bytes: [...value.bytes] })),
    bucket: Object.fromEntries(Object.entries(bucket).map(([name, operation]) => [name, operation.mock.calls.length])),
    queue: Object.fromEntries(Object.entries(queue).map(([name, operation]) => [name, operation.mock.calls.length])) });
  async function request(method: 'GET' | 'POST', path: string, actor = 102, input?: Row) {
    const opened = wiring.opened, closed = wiring.closed;
    const response = await app.request('/adminapi/' + path, { method,
      headers: { ...(actor ? { Authorization: 'Bearer ' + tokens.get(actor) } : {}),
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) }, env);
    const raw = await response.text(), diagnostic = JSON.stringify({ method, path, actor, http: response.status, raw });
    expect(response.status, diagnostic).toBe(200);
    expect(response.headers.get('content-type'), diagnostic).toContain('application/json');
    expect(response.headers.get('cache-control'), diagnostic).toBe('private, no-store, max-age=0');
    expect(wiring.closed - closed).toBe(wiring.opened - opened);
    const body: unknown = JSON.parse(raw);
    expect(body, diagnostic).toMatchObject({ status: expect.any(Number), msg: expect.any(String) });
    return body as Envelope;
  }
  async function read(query = '', actor = 102): Promise<PackagePage> {
    const before = await snapshot(), resourceBefore = resources();
    const body = await request('GET', 'member/ship' + (query ? '?' + query : ''), actor);
    expect(await snapshot()).toEqual(before); expect(resources()).toEqual(resourceBefore);
    expect(body.status, body.msg).toBe(200);
    expect(body.data).toMatchObject({ list: expect.any(Array), count: expect.any(Number) });
    const page = body.data as PackagePage;
    for (const row of page.list) expect(Object.keys(row).sort()).toEqual(PLAN_COLUMNS);
    return page;
  }
  async function refuse(method: 'GET' | 'POST', path: string, actor: number, status: number, input?: Row) {
    const before = await snapshot(), resourceBefore = resources(), opened = wiring.opened;
    const body = await request(method, path, actor, input);
    expect(body).toMatchObject({ status, data: null });
    expect(wiring.opened).toBe(opened);
    expect(await snapshot()).toEqual(before); expect(resources()).toEqual(resourceBefore);
  }
  async function statusOnly(id: number, flag: number, actor = 101): Promise<void> {
    const before = await snapshot(), resourceBefore = resources();
    const row = before.member_ship.find(value => value.id === id); expect(row).toBeDefined();
    const body = await request('POST', 'member_ship/set_ship_status', actor, { id, is_del: flag });
    expect(body).toEqual({ status: 200, msg: '修改成功', data: { id } });
    const expected: Snapshot = { ...before, member_ship: before.member_ship.map(value => value.id === id ? { ...value, is_del: flag } : value) };
    // Comparing maps by ID avoids treating a real row-serialization reorder as
    // a business change while retaining EVERY column, table and sequence value.
    const after = await snapshot();
    expect(new Map(after.member_ship.map(value => [value.id, value]))).toEqual(new Map(expected.member_ship.map(value => [value.id, value])));
    expect({ ...after, member_ship: [] }).toEqual({ ...before, member_ship: [] });
    expect(resources()).toEqual(resourceBefore);
  }

  it('preserves default active-only reads and admits active plan101 on the real second page', async () => {
    expect(activeIds).toHaveLength(111);
    const first = await read('page=1&limit=100'), second = await read('page=2&limit=100'), end = await read('page=3&limit=100');
    expect([first.count, second.count, end.count]).toEqual([111, 111, 111]);
    expect([first.list.length, second.list.length, end.list.length]).toEqual([100, 11, 0]);
    expect([...first.list, ...second.list].map(row => row.id)).toEqual(activeIds);
    expect([...first.list, ...second.list].every(row => row.is_del === 0)).toBe(true);
    expect((await read('include_deleted=0&limit=100')).list).toEqual(first.list);
    const normal = await read(); expect(normal.count).toBe(111); expect(normal.list.map(row => row.id)).toEqual(activeIds.slice(0, 50));
  });

  it('pages the explicit complete directory with stable sort ties, exact counts and no missing or duplicated IDs', async () => {
    const pages: PackagePage[] = [];
    for (let page = 1; page <= 10; page++) pages.push(await read(`include_deleted=1&page=${page}&limit=15`));
    expect(pages.map(page => page.count)).toEqual(Array(10).fill(125));
    expect(pages.map(page => page.list.length)).toEqual([15, 15, 15, 15, 15, 15, 15, 15, 5, 0]);
    const rows = pages.flatMap(page => page.list);
    expect(rows.map(row => row.id)).toEqual(allIds); expect(new Set(rows.map(row => row.id)).size).toBe(125);
    expect(rows.filter(row => row.is_del === 1)).toHaveLength(14);
    expect((await read('include_deleted=1&page=2&limit=15')).list).toEqual(pages[1].list);
    expect(rows.find(row => row.id === 7004)).toMatchObject({ type: 'ever', vip_day: -1 });
    expect(rows.find(row => row.id === 7005)).toMatchObject({ type: 'free', price: '0.00', pre_price: '0.00' });
  });

  it('disables an active plan, re-reads the stopped row through a fresh full-directory request, then persistently re-enables it', async () => {
    const baseline = await snapshot(), id = 7002;
    await statusOnly(id, 1);
    const stopped = (await read('include_deleted=1&limit=100')).list.find(row => row.id === id);
    // Fetch its actual later page if the chosen tied sort is outside page one.
    const stoppedLater = stopped ?? (await read('include_deleted=1&page=2&limit=100')).list.find(row => row.id === id);
    expect(stoppedLater).toMatchObject({ id, is_del: 1, title: '原生套餐 002', price: '29.00', pre_price: '19.00' });
    const active = [...(await read('limit=100')).list, ...(await read('page=2&limit=100')).list];
    expect(active.some(row => row.id === id)).toBe(false); expect((await read('limit=100')).count).toBe(110);
    await statusOnly(id, 0);
    const restored = [...(await read('limit=100')).list, ...(await read('page=2&limit=100')).list];
    expect(restored.find(row => row.id === id)).toMatchObject({ id, is_del: 0 });
    expect((await read('include_deleted=1&limit=100')).count).toBe(125);
    expect(await snapshot()).toEqual(baseline);
  });

  it('allows a live manager and super administrator to enable a previously stopped plan without touching price/type or any other table', async () => {
    const baseline = await snapshot(), id = 7001;
    await statusOnly(id, 0, 101);
    expect((await read('limit=100', 101)).count).toBe(112);
    await statusOnly(id, 1, 100);
    expect((await read('include_deleted=1&limit=100', 100)).count).toBe(125);
    expect(await snapshot()).toEqual(baseline);
  });

  it('gives readers the complete directory but enforces actual server-side write ACL for POST and the legacy GET writer', async () => {
    expect((await read('include_deleted=1&limit=15', 102)).count).toBe(125);
    await refuse('POST', 'member_ship/set_ship_status', 102, ApiErrorCode.ERR_AUTH, { id: 7002, is_del: 1 });
    await refuse('GET', 'member_ship/set_ship_status?id=7002&is_del=1', 102, ApiErrorCode.ERR_AUTH);
    await refuse('POST', 'member_ship/save/7002', 102, ApiErrorCode.ERR_AUTH, { title: '读者不能改套餐' });
    for (const path of ['member/ship', 'member/ship?include_deleted=1']) await refuse('GET', path, 103, ApiErrorCode.ERR_AUTH);
    await refuse('POST', 'member_ship/set_ship_status', 103, ApiErrorCode.ERR_AUTH, { id: 7002, is_del: 1 });
  });

  it('rejects guest, wrong token realm, disabled/deleted/nonplatform accounts and stale password claims before opening Admin SQL', async () => {
    const actors = [[0, ApiErrorCode.ERR_LOGIN], [104, ApiErrorCode.ERR_BANNED], [105, ApiErrorCode.ERR_BANNED],
      [106, ApiErrorCode.ERR_BANNED], [107, ApiErrorCode.ERR_EXPIRED], [108, ApiErrorCode.ERR_BANNED]] as const;
    for (const [actor, status] of actors) {
      await refuse('GET', 'member/ship?include_deleted=1', actor, status);
      await refuse('POST', 'member_ship/set_ship_status', actor, status, { id: 7002, is_del: 1 });
    }
  });

  it('refuses malformed flags and missing plan IDs without partial mutations or consuming sequence values', async () => {
    for (const [input, expectedStatus] of [
      [{ id: 7002, is_del: -1 }, 400], [{ id: 7002, is_del: 2 }, 400],
      [{ id: 7002, is_del: 0.5 }, 400], [{ id: 0, is_del: 1 }, 400],
      [{ id: 999999, is_del: 1 }, 404],
    ] as const) {
      const before = await snapshot(), resourceBefore = resources();
      const body = await request('POST', 'member_ship/set_ship_status', 101, input);
      expect(body.status, body.msg).toBe(expectedStatus); expect(body.data).toBeNull();
      expect(await snapshot()).toEqual(before); expect(resources()).toEqual(resourceBefore);
    }
  });
});
