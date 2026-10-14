import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { legacyCategory, storeProductSpecs, systemAdmin, systemLog, systemRole } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { productSpecsFixture, seedProductSpecs, specsBody } from './helpers/adminProductSpecs';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const env = { APP_KEY: 'specs-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
type ChildDTO = { id: number; type: number; relation_id: number; temp_id: number; name: string;
  value: string; sort: number; status: number; add_time: number | string };
type ParentDTO = { id: number; type: number; relation_id: number; owner_id: number; name: string;
  group: number; sort: number; add_time: number | string; specs: ChildDTO[] };
type Envelope = { status: number; msg: string; data: unknown };

describe('registered PHP specs routes and modern aliases through actual App, JWT and SQL', () => {
  const app = createApp(), tokens: Record<number, string> = {};
  let f: Awaited<ReturnType<typeof productSpecsFixture>>;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Specs HTTP fixture forbids external I/O'));
    f = await productSpecsFixture();
    wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [100, 101, 102, 103, 104, 105, 106]) {
      tokens[id] = (await createToken(id, 'admin', md5('specs-fixture-password'), env.APP_KEY)).token;
    }
  }, 30000);
  beforeEach(async () => {
    await f.reset(); await seedProductSpecs(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('category','id'),1000,false), setval(pg_get_serial_sequence('store_product_specs','id'),1000,false)");
  }, 30000);
  afterAll(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  const counters = () => ({ application: wiring.application.mock.calls.length,
    open: wiring.open.mock.calls.length, close: wiring.close.mock.calls.length });
  function boundary(response: Response, before: ReturnType<typeof counters>) {
    const cache = new Set(response.headers.get('cache-control')?.split(',').map(value => value.trim()));
    expect(cache.has('private')).toBe(true); expect(cache.has('no-store')).toBe(true);
    if (response.headers.has('pragma')) expect(response.headers.get('pragma')).toBe('no-cache');
    else expect(cache.has('max-age=0')).toBe(true);
    expect(wiring.application.mock.calls.length - before.application).toBe(1);
    const opened = wiring.open.mock.calls.length - before.open;
    expect(opened).toBeGreaterThanOrEqual(0); expect(opened).toBeLessThanOrEqual(1);
    expect(wiring.close.mock.calls.length - before.close).toBe(opened);
  }
  async function raw(method: string, path: string, body?: BodyInit, id = 101,
    headers: Record<string, string> = {}) {
    const before = counters();
    const response = await app.request(path.startsWith('/') ? path : `/adminapi/${path}`, {
      method, headers: { ...(id ? { 'Authori-zation': `Bearer ${tokens[id]}` } : {}),
        'Content-Type': 'application/json', ...headers }, body }, env);
    boundary(response, before); return response;
  }
  async function request(method: string, path: string, body?: unknown, id = 101) {
    const response = await raw(method, path, body === undefined ? undefined : JSON.stringify(body), id);
    return { response, body: await response.json<Envelope>() };
  }
  async function snapshot() {
    return { parents: await f.db.select().from(legacyCategory).orderBy(legacyCategory.id),
      children: await f.db.select().from(storeProductSpecs).orderBy(storeProductSpecs.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }

  it('serves all nine old and modern read contracts with deliberate date and pagination projections', async () => {
    await f.db.insert(storeProductSpecs).values({ id: 103, tempId: 12, name: '零时间参数', value: '旧行', addTime: 0 });
    const before = await snapshot();
    for (const path of ['product/all_specs', 'product/specs', 'product/specs/10',
      'all_specs', 'specs', 'specs/10', '/api/admin/all_specs', '/api/admin/specs', '/api/admin/specs/10']) {
      expect((await request('GET', path)).body.status, path).toBe(200);
    }
    const legacyList = (await request('GET', 'product/specs?page=2&limit=1')).body.data as { list: ParentDTO[]; count: number };
    expect(Object.keys(legacyList).sort()).toEqual(['count', 'list']);
    expect(legacyList).toMatchObject({ count: 3, list: [{ id: 10, add_time: '1970-01-01 08:00:01' }] });
    expect(legacyList.list[0]).not.toHaveProperty('specs');
    const legacyDetail = (await request('GET', 'product/specs/10')).body.data as ParentDTO;
    expect(legacyDetail).toMatchObject({ add_time: 1, specs: [
      { id: 100, add_time: '1970-01-01 08:00:01' }, { id: 101, add_time: '1970-01-01 08:00:02' },
    ] });
    expect((await request('GET', 'product/specs/12')).body.data).toMatchObject({
      specs: [{ id: 103, add_time: '1970-01-01 08:00:00' }],
    });
    const legacyAll = (await request('GET', 'product/all_specs')).body.data as ParentDTO[];
    expect(legacyAll.find(row => row.id === 12)?.specs).toMatchObject([{ id: 103, add_time: '1970-01-01 08:00:00' }]);
    for (const prefix of ['/adminapi', '/api/admin']) {
      const modern = (await request('GET', `${prefix}/specs?page=2&limit=1`)).body.data;
      expect(modern).toMatchObject({ count: 3, page: 2, limit: 1,
        list: [{ id: 10, add_time: 1, specs: [{ id: 100, add_time: 1 }, { id: 101, add_time: 2 }] }] });
      expect((await request('GET', `${prefix}/specs/10`)).body.data).toMatchObject({ add_time: 1,
        specs: [{ id: 100, add_time: 1 }, { id: 101, add_time: 2 }] });
      const modernAll = (await request('GET', `${prefix}/all_specs`)).body.data as ParentDTO[];
      expect(modernAll.find(row => row.id === 12)?.specs).toMatchObject([{ id: 103, add_time: 0 }]);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('creates, edits by complete returned DTO and deletes through PHP endpoints with exact response envelopes', async () => {
    expect((await request('POST', 'product/specs/0', specsBody({ name: 'HTTP旧模板' }))).body)
      .toEqual({ status: 200, msg: '保存成功', data: [] });
    const [created] = await f.db.select().from(legacyCategory).where(eq(legacyCategory.name, 'HTTP旧模板'));
    const detail = (await request('GET', `product/specs/${created.id}`)).body.data as ParentDTO;
    expect((await request('POST', `product/specs/${created.id}`, { ...detail, name: 'HTTP旧编辑',
      specs: detail.specs.map(row => ({ ...row, value: '已编辑' })) })).body)
      .toEqual({ status: 200, msg: '编辑成功', data: [] });
    expect((await request('DELETE', `product/specs/${created.id}`)).body)
      .toEqual({ status: 200, msg: '删除成功', data: [] });
    expect(await f.db.select().from(legacyCategory).where(eq(legacyCategory.id, created.id))).toEqual([]);
    expect(await f.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, created.id))).toEqual([]);
    expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['POST', 'POST', 'DELETE']);
  });

  it('keeps both modern prefixes on the same authority, numeric DTOs and committed write results', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      const created = await request('POST', `${prefix}/specs/0`, specsBody({ name: `现代${prefix}` }));
      expect(created.body.status, created.body.msg).toBe(200);
      const id = (created.body.data as { id: number }).id;
      expect(id).toBeGreaterThan(0);
      const detail = (await request('GET', `${prefix}/specs/${id}`)).body.data as ParentDTO;
      expect(typeof detail.add_time).toBe('number');
      expect(typeof detail.specs[0].add_time).toBe('number');
      expect((await request('POST', `${prefix}/specs/${id}`, { ...detail, sort: 10 })).body.data).toEqual({ id });
      expect((await request('DELETE', `${prefix}/specs/${id}`)).body).toMatchObject({ status: 200, data: null });
    }
    expect((await snapshot()).parents.map(row => row.id)).toEqual([10, 11, 12, 20, 21, 22, 30, 40]);
    expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['POST', 'POST', 'DELETE', 'POST', 'POST', 'DELETE']);
  });

  it('admits exact 1381 readers and numeric API writers but rejects 1383 and unrelated or read-only writer aliases', async () => {
    const before = await snapshot();
    for (const actor of [102, 105]) {
      for (const path of ['product/specs', 'product/all_specs', 'product/specs/11', 'specs', '/api/admin/specs']) {
        expect((await request('GET', path, undefined, actor)).body.status).toBe(200);
      }
      for (const path of ['product/specs/0', 'specs/0', '/api/admin/specs/0']) {
        expect((await request('POST', path, specsBody(), actor)).body).toMatchObject({ status: 400011, data: null });
      }
      for (const path of ['product/specs/11', 'specs/11', '/api/admin/specs/11']) {
        expect((await request('DELETE', path, undefined, actor)).body).toMatchObject({ status: 400011, data: null });
      }
    }
    for (const actor of [103, 106]) {
      expect((await request('GET', 'product/specs', undefined, actor)).body.status).toBe(400011);
      expect((await request('POST', 'product/specs/0', specsBody(), actor)).body.status).toBe(400011);
    }
    expect(await snapshot()).toEqual(before);
    expect((await request('POST', 'product/specs/0', specsBody({ name: '数字菜单创建' }), 104)).body.status).toBe(200);
    const [created] = await f.db.select().from(legacyCategory).where(eq(legacyCategory.name, '数字菜单创建'));
    expect((await request('DELETE', `/api/admin/specs/${created.id}`, undefined, 104)).body.status).toBe(200);
  });

  it('refuses anonymous requests before opening transaction sessions and closes every admitted request session', async () => {
    const before = await snapshot(), open = wiring.open.mock.calls.length;
    for (const [method, path] of [['GET', 'product/specs'], ['GET', 'product/all_specs'],
      ['GET', 'product/specs/10'], ['POST', 'product/specs/0'], ['DELETE', 'product/specs/11'],
      ['GET', 'specs'], ['POST', '/api/admin/specs/0'], ['DELETE', '/api/admin/specs/11']]) {
      expect((await request(method, path, method === 'POST' ? specsBody() : undefined, 0)).body)
        .toMatchObject({ status: 410000, data: null });
    }
    expect(wiring.open.mock.calls.length).toBe(open);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses cross-owner templates, changed echo identities, malformed paths and repeated queries without effects', async () => {
    const before = await snapshot(), detail = (await request('GET', 'product/specs/11')).body.data as ParentDTO;
    for (const id of [20, 21, 22, 30, 40, 999]) {
      expect((await request('GET', `product/specs/${id}`)).body.status).not.toBe(200);
      expect((await request('POST', `product/specs/${id}`, specsBody())).body.status).not.toBe(200);
      expect((await request('DELETE', `product/specs/${id}`)).body.status).not.toBe(200);
    }
    for (const [method, path, body] of [
      ['GET', 'product/specs/01', undefined], ['GET', 'specs/0', undefined],
      ['DELETE', 'product/specs/2147483648', undefined],
      ['GET', 'product/specs?page=1&page=2', undefined], ['GET', 'specs?name=x&name=y', undefined],
      ['GET', 'all_specs?type=0', undefined], ['GET', 'product/specs/11?id=11', undefined],
      ['POST', 'product/specs/0?id=0', specsBody()], ['DELETE', 'specs/11?id=11', undefined],
      ['POST', 'product/specs/11', { ...detail, id: 10 }],
      ['POST', 'specs/11', { ...detail, owner_id: 77 }],
      ['POST', 'specs/11', { ...detail, specs: [{ ...detail.specs[0], id: 110 }] }],
      ['POST', 'specs/0', specsBody({ type: 2, relation_id: 20 })],
      ['POST', 'specs/0', specsBody({ unexpected: true })],
    ] as const) expect((await request(method, path, body)).body.status, path).not.toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects invalid JSON or UTF8 and content lengths and streaming bodies beyond 64 KiB without mutations', async () => {
    const before = await snapshot();
    for (const bytes of ['{', '', new Uint8Array([0xff])]) {
      expect(await (await raw('POST', 'product/specs/0', bytes)).json()).toMatchObject({ status: 400 });
    }
    for (const body of [null, [], specsBody({ name: 'bad\u0000name' }), specsBody({ specs: [{ name: '项', value: '' }] })]) {
      expect((await request('POST', 'product/specs/0', body)).body.status).toBe(400);
    }
    expect(await (await raw('POST', 'specs/0', '{}', 101, { 'Content-Length': '65537' })).json())
      .toMatchObject({ status: 400 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(65537)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const countersBefore = counters();
    const response = await app.request(new Request('http://localhost/adminapi/product/specs/0', {
      method: 'POST', headers: { 'Authori-zation': `Bearer ${tokens[101]}`, 'Content-Type': 'application/json' },
      body: stream, duplex: 'half',
    } as RequestInit), undefined, env);
    boundary(response, countersBefore);
    expect(await response.json()).toMatchObject({ status: 400 }); expect(cancelled).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('uses live authorization and credentials and strict expiry despite middleware token tolerance', async () => {
    const before = await snapshot();
    await f.db.update(systemRole).set({ rules: 'user.view' }).where(eq(systemRole.id, 1));
    expect((await request('POST', 'product/specs/0', specsBody())).body.status).toBe(400011);
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 102));
    expect((await request('GET', 'specs', undefined, 102)).body.status).not.toBe(200);
    await f.db.update(systemAdmin).set({ adminType: 4, relationId: 20 }).where(eq(systemAdmin.id, 100));
    expect((await request('GET', 'product/specs', undefined, 100)).body.status).not.toBe(200);
    const expired = await createToken(105, 'admin', md5('specs-fixture-password'), env.APP_KEY,
      'cinashop', Math.floor(Date.now() / 1000) - 7 * 24 * 3600 - 5);
    expect(await (await raw('GET', 'specs', undefined, 105, { 'Authori-zation': `Bearer ${expired.token}` })).json())
      .toMatchObject({ status: 410001, data: null });
    expect(await snapshot()).toEqual(before);
  });

  it('runs HEAD through all three read variants without bodies or catalog and audit changes', async () => {
    const before = await snapshot();
    for (const path of ['product/all_specs', 'product/specs', 'product/specs/11',
      'all_specs', 'specs', 'specs/11', '/api/admin/all_specs', '/api/admin/specs', '/api/admin/specs/11']) {
      const response = await raw('HEAD', path, undefined, 105);
      expect(response.status, path).toBe(200); expect(await response.text()).toBe('');
    }
    expect(await snapshot()).toEqual(before);
  });
});
