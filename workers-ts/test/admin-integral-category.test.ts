import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { legacyCategory } from '../src/models/schema';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { integralCategoryFixture, categoryInput } from './helpers/integralCategoryFixture';

describe('Admin integral range categories on SQL', () => {
  let f: Awaited<ReturnType<typeof integralCategoryFixture>>;
  beforeEach(async () => { f = await integralCategoryFixture(); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const createBody = (overrides: Record<string, unknown> = {}) => ({ ...categoryInput, request_id: crypto.randomUUID(), ...overrides });

  it('returns stable group-5 pages, exact public fields and literal name/ID filtering', async () => {
    await f.db.insert(legacyCategory).values(Array.from({ length: 31 }, (_, index) => ({ id: index + 200,
      group: 5, name: index === 0 ? '100%积分' : index === 1 ? 'under_score' : index === 2 ? 'back\\slash' : `分类${index}`,
      integralMin: 1000 + index * 20, integralMax: 1010 + index * 20, sort: 3, isShow: index % 2 })));
    const ids: number[] = [];
    for (const page of [1, 2, 3]) {
      const { body, response } = await f.request(`?page=${page}`);
      expect(body.status, body.msg).toBe(200); expect(body.data).toMatchObject({ count: 33, page, limit: 15 });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      ids.push(...body.data.list.map((row: { id: number }) => row.id));
    }
    expect(ids).toEqual([...Array.from({ length: 31 }, (_, i) => 230 - i), 101, 102]);
    for (const [name, id] of [['%', 200], ['_', 201], ['\\', 202], ['101', 101]] as const) {
      const data = (await f.request(`?name=${encodeURIComponent(name)}`)).body.data;
      expect(data.count).toBe(1); expect(data.list[0].id).toBe(id);
    }
    const detail = (await f.request('/101')).body.data;
    expect(detail).toEqual({ id: 101, name: '低积分', integral_min: 0, integral_max: 100, sort: 2, is_show: 1,
      add_time: '2023-11-14 22:13:20', revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await f.request('?is_show=0&limit=100')).body.data.count).toBe(17);
    expect((await f.request('?is_show=')).body.data).toEqual((await f.request('?is_show=all')).body.data);
    expect((await f.request('?page=101&limit=100')).body.data).toMatchObject({ list: [], count: 33 });
  });

  it('rejects malformed and ambiguous queries and restricts detail to this category domain', async () => {
    for (const query of ['page=0', 'page=', 'page=01', 'page=1.5', 'limit=101', 'page=102&limit=100',
      'is_show=2', 'is_show=01', 'is_show=0&is_show=1', 'page=1&page=1', 'name=x&name=y', 'name=%00', 'name=%0a',
      `name=${'x'.repeat(101)}`, 'group=1']) expect((await f.request(`?${query}`)).body.status, query).toBe(400);
    for (const path of ['/103', '/999']) expect((await f.request(path)).body.status).not.toBe(200);
    for (const path of ['/0101', '/101?extra=1']) expect((await f.request(path)).body.status).toBe(400);
  });

  it('separates integral-category ACL from ordinary category management on both route families', async () => {
    const service = new AdminPermissionService(f.container);
    expect(service.buildMenus(new Set(['integral_category.view']))).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/marketing/integral-categories' })]));
    const revision = await f.revision();
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(requiredAdminPermission('GET', `${prefix}/marketing/integral-categories`)).toBe('integral_category.view');
      expect(requiredAdminPermission('PUT', `${prefix}/marketing/integral-categories/101/status`)).toBe('integral_category.manage');
      expect((await f.request('', { prefix, token: f.tokens.reader })).body.status).toBe(200);
      expect((await f.request('/101', { prefix, token: f.tokens.reader })).body.status).toBe(200);
      for (const token of ['', f.tokens.other]) expect((await f.request('', { prefix, token })).body.status).not.toBe(200);
      for (const token of ['', f.tokens.reader, f.tokens.other]) {
        for (const [path, method] of [['', 'POST'], ['/101', 'PUT'], ['/101/status', 'PUT'], ['/101', 'DELETE']]) {
          expect((await f.request(path, { prefix, token, method, body: { ...createBody(), revision } })).body.status).not.toBe(200);
        }
      }
    }
    expect((await f.snapshot()).logs).toHaveLength(0);
  });

  it('creates only a flat group-5 row and immediately serves the existing public label/range contract', async () => {
    const before = await f.snapshot(), input = createBody();
    const { response, body } = await f.request('', { method: 'POST', body: input });
    expect(body.status, body.msg).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    const after = await f.snapshot();
    expect(after.categories.at(-1)).toMatchObject({ id: body.data.id, group: 5, type: 0, relationId: 0, ownerId: 0, pid: 0,
      name: categoryInput.name, integralMin: 201, integralMax: 300 });
    expect(after.logs).toHaveLength(1); expect(after.logs[0]).toMatchObject({ adminId: 2, type: 'integral_category', adminName: '', ip: '', method: 'POST' });
    expect(JSON.stringify(after.logs)).not.toContain(categoryInput.name);
    expect(after.products).toEqual(before.products); expect(after.ordinary).toEqual(before.ordinary);
    expect(await f.publicCategories()).toEqual([{ label: categoryInput.name, value: '201-300' }, { label: '低积分', value: '0-100' }]);
    expect((await f.request('', { method: 'POST', body: input })).body.data).toEqual(body.data);
    expect(await f.snapshot()).toEqual(after);
  });

  it('binds idempotency keys to administrator, operation, target, version and normalized payload', async () => {
    const input = createBody();
    const created = (await f.request('', { method: 'POST', body: input })).body.data;
    expect((await f.request('', { method: 'POST', body: { ...input, name: '不同内容' } })).body.status).toBe(400);
    expect((await f.request('/101/status', { method: 'PUT', body: { request_id: input.request_id, revision: await f.revision(), is_show: 0 } })).body.status).toBe(400);
    const second = await f.request('', { method: 'POST', token: f.tokens.second,
      body: { ...input, name: '第二管理员', integral_min: 301, integral_max: 400 } });
    expect(second.body.status, second.body.msg).toBe(200); expect(second.body.data.id).not.toBe(created.id);
    const revision = await f.revision(created.id);
    expect((await f.request(`/${created.id}`, { method: 'DELETE', body: { request_id: crypto.randomUUID(), revision } })).body.status).toBe(200);
    const after = await f.snapshot();
    expect((await f.request('', { method: 'POST', body: input })).body.data).toEqual(created);
    expect(await f.snapshot()).toEqual(after); // replay never recreates a subsequently deleted row
  });

  it('requires bounded exact numeric input and never accepts category scope fields', async () => {
    const before = await f.snapshot();
    const bad = [{ name: '' }, { name: '  ' }, { name: 'x'.repeat(31) }, { name: 'a\u0000' }, { name: 1 },
      { integral_min: -1 }, { integral_min: '201' }, { integral_max: 2_147_483_648 }, { integral_max: 201 },
      { integral_max: 1.5 }, { sort: -1 }, { sort: '0' }, { is_show: 2 }, { is_show: '1' },
      { group: 1 }, { type: 1 }, { owner_id: 12 }, { relation_id: 12 }, { pid: 101 },
      { request_id: null }, { request_id: 'invalid' }];
    for (const invalid of bad) expect((await f.request('', { method: 'POST', body: createBody(invalid) })).body.status, JSON.stringify(invalid)).toBe(400);
    expect((await f.request('?extra=1', { method: 'POST', body: createBody() })).body.status).toBe(400);
    expect((await f.request('', { method: 'POST', body: createBody({ name: 'x'.repeat(5000) }) })).body.status).toBe(400);
    expect(await f.snapshot()).toEqual(before);
  });

  it('rejects enclosing, enclosed, endpoint-touching and hidden range overlaps', async () => {
    const before = await f.snapshot();
    for (const [minimum, maximum] of [[50, 90], [0, 250], [100, 101], [50, 150], [150, 199]]) {
      const result = await f.request('', { method: 'POST', body: createBody({ integral_min: minimum, integral_max: maximum, is_show: 0 }) });
      expect(result.body).toMatchObject({ status: 400, msg: '积分分类范围不可重叠' });
    }
    expect(await f.snapshot()).toEqual(before);
    expect((await f.request('', { method: 'POST', body: createBody() })).body.status).toBe(200);
  });

  it('rejects case-insensitive duplicate names, including hidden categories', async () => {
    expect((await f.request('', { method: 'POST', body: createBody({ name: 'ABC', is_show: 0 }) })).body.status).toBe(200);
    expect((await f.request('', { method: 'POST', body: createBody({ name: 'abc', integral_min: 301, integral_max: 400 }) })).body)
      .toMatchObject({ status: 400, msg: '积分分类名称已存在' });
    expect((await f.request('', { method: 'POST', body: createBody({ name: '隐藏积分' }) })).body.status).toBe(400);
  });

  it('updates with fresh revision and prevents stale save, status and delete confirmations', async () => {
    const revision = await f.revision(), input = { ...categoryInput, name: '更新低积分', integral_min: 0, integral_max: 99, revision, request_id: crypto.randomUUID() };
    expect((await f.request('/101', { method: 'PUT', body: input })).body.status).toBe(200);
    const after = await f.snapshot();
    for (const [path, method, body] of [['/101', 'PUT', { ...input, request_id: crypto.randomUUID() }],
      ['/101/status', 'PUT', { is_show: 0, revision, request_id: crypto.randomUUID() }],
      ['/101', 'DELETE', { revision, request_id: crypto.randomUUID() }]] as const) {
      expect((await f.request(path, { method, body })).body).toMatchObject({ status: 400, msg: '分类已更新，请刷新后重新确认' });
    }
    expect((await f.request('/101', { method: 'PUT', body: input })).body.status).toBe(200);
    expect(await f.snapshot()).toEqual(after);
    expect(after.categories[0]).toMatchObject({ name: '更新低积分', addTime: 1_700_000_000 });
  });

  it('rejects foreign-group read/write/status/delete and preserves all category scope fields', async () => {
    const before = await f.snapshot(), revision = 'a'.repeat(64);
    for (const [path, method, body] of [['/103', 'PUT', { ...createBody(), revision }],
      ['/103/status', 'PUT', { is_show: 0, revision, request_id: crypto.randomUUID() }],
      ['/103', 'DELETE', { revision, request_id: crypto.randomUUID() }]] as const) {
      expect((await f.request(path, { method, body })).body.status).not.toBe(200);
    }
    expect(await f.snapshot()).toEqual(before);
  });

  it('changes public visibility without touching products and hard-deletes with retry-safe audit', async () => {
    const before = await f.snapshot();
    const hide = { request_id: crypto.randomUUID(), revision: await f.revision(), is_show: 0 };
    expect((await f.request('/101/status', { method: 'PUT', body: hide })).body.status).toBe(200);
    expect(await f.publicCategories()).toEqual([]);
    expect((await f.request('/101/status', { method: 'PUT', body: hide })).body.status).toBe(200);
    const deletion = { request_id: crypto.randomUUID(), revision: await f.revision() };
    expect((await f.request('/101', { method: 'DELETE', body: deletion })).body.status).toBe(200);
    expect((await f.request('/101', { method: 'DELETE', body: deletion })).body.status).toBe(200);
    const after = await f.snapshot();
    expect(after.categories.map(row => row.id)).toEqual([102, 103]); expect(after.logs).toHaveLength(2);
    expect(after.products).toEqual(before.products); expect(after.ordinary).toEqual(before.ordinary);
  });

  it('rolls back every mutation if the audit insertion fails', async () => {
    await f.exec("CREATE FUNCTION reject_category_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_category_log BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_category_log()");
    const before = await f.snapshot(), revision = await f.revision();
    for (const [path, method, body] of [['', 'POST', createBody()], ['/101', 'PUT', { ...createBody({ integral_min: 0, integral_max: 99 }), revision }],
      ['/101/status', 'PUT', { request_id: crypto.randomUUID(), revision, is_show: 0 }],
      ['/101', 'DELETE', { request_id: crypto.randomUUID(), revision }]] as const) {
      expect((await f.request(path, { method, body })).body.status).not.toBe(200);
      expect(await f.snapshot()).toEqual(before);
    }
  });

  it('bounds public visibility at 1000 and permits hiding/deletion to restore capacity', async () => {
    await f.db.insert(legacyCategory).values(Array.from({ length: 999 }, (_, n) => ({ id: 1000 + n, group: 5,
      name: `容量${n}`, integralMin: 1000 + n * 20, integralMax: 1010 + n * 20, isShow: 1 })));
    expect(await f.publicCategories()).toHaveLength(1000);
    const create = createBody({ integral_min: 100_000, integral_max: 100_010 });
    expect((await f.request('', { method: 'POST', body: create })).body.msg).toContain('最多显示1000');
    expect((await f.request('/102/status', { method: 'PUT', body: { request_id: crypto.randomUUID(), revision: await f.revision(102), is_show: 1 } })).body.msg).toContain('最多显示1000');
    expect((await f.request('', { method: 'POST', body: { ...create, is_show: 0 } })).body.status).toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { request_id: crypto.randomUUID(), revision: await f.revision(), is_show: 0 } })).body.status).toBe(200);
    expect((await f.request('/102/status', { method: 'PUT', body: { request_id: crypto.randomUUID(), revision: await f.revision(102), is_show: 1 } })).body.status).toBe(200);
    expect(await f.publicCategories()).toHaveLength(1000);
  });

  it('allows cleanup of malformed legacy ranges but refuses to expose them', async () => {
    await f.db.update(legacyCategory).set({ integralMin: 500, integralMax: 400 }).where(eq(legacyCategory.id, 102));
    expect((await f.request('/102/status', { method: 'PUT', body: { request_id: crypto.randomUUID(), revision: await f.revision(102), is_show: 1 } })).body.status).toBe(400);
    expect((await f.request('/102', { method: 'DELETE', body: { request_id: crypto.randomUUID(), revision: await f.revision(102) } })).body.status).toBe(200);
    expect(await f.publicCategories()).toEqual([{ label: '低积分', value: '0-100' }]);
  });

  it('uses a read-only repeatable-read list snapshot with transaction-local deadlines', async () => {
    const run = f.container.db.transaction.bind(f.container.db); let selects = 0;
    const spy = vi.spyOn(f.container.db, 'transaction').mockImplementation(async callback => run(async tx => {
      const select = tx.select.bind(tx);
      tx.select = ((...args: unknown[]) => { selects++; return Reflect.apply(select, tx, args); }) as typeof tx.select;
      const result = await callback(tx);
      const settings = await (tx as any).execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout`);
      expect(settings[0]).toMatchObject({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' });
      return result;
    }));
    expect((await f.request()).body.status).toBe(200); expect(spy).toHaveBeenCalledTimes(1); expect(selects).toBe(2);
    spy.mockRestore();
    const settings = await f.db.execute(sql`SELECT current_setting('statement_timeout') AS timeout`);
    expect(settings[0].timeout).toBe('0');
  });
});
