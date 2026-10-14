import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { storeProductEnsure, systemAdmin, systemRole, systemLog } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { productEnsureFixture, seedEnsures, ensureBody } from './helpers/adminProductEnsures';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const env = { APP_KEY: 'ensure-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
type EnsureDTO = { id: number; type: number; relation_id: number; name: string; image: string;
  desc: string; sort: number; status: number; add_time: number | string; product_count?: number };
type Envelope = { status: number; msg: string; data: unknown };
type AdapterConfig = { method?: string; data?: BodyInit; headers: { toJSON(): Record<string, string> } };
type VueConsumer = {
  request: { defaults: Record<string, unknown>; getUri(config: AdapterConfig): string };
  apiProductEnsureList(params: { page?: number; limit?: number; name?: string }): Promise<{ list: EnsureDTO[]; count: number; page: number; limit: number }>;
  apiProductEnsureSave(id: number, body: { name: string; image: string; desc: string; sort: number; status: number }): Promise<{ id: number }>;
  apiProductEnsureStatus(id: number, status: number): Promise<null>;
  apiProductEnsureDelete(id: number): Promise<null>;
};

describe('actual ensure App routes, JWT and SQL with the production Vue Axios consumer', () => {
  const app = createApp(), tokens: Record<number, string> = {};
  let f: Awaited<ReturnType<typeof productEnsureFixture>>, consumer: VueConsumer;
  const consumerPaths: string[] = [];
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Ensure HTTP fixture forbids external I/O'));
    f = await productEnsureFixture();
    wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [100, 101, 102, 103, 104, 105, 106]) {
      tokens[id] = (await createToken(id, 'admin', md5('ensure-fixture-password'), env.APP_KEY)).token;
    }
    Reflect.set(globalThis, '__ensureHttpToken', tokens[101]);
    const adminRoot = resolve(import.meta.dirname, '../../view/admin-ts');
    const result = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', external: ['axios'],
      stdin: { contents: `export * from ${JSON.stringify(resolve(adminRoot, 'src/api/productMetadata.ts'))}; export {default as request} from ${JSON.stringify(resolve(adminRoot, 'src/utils/request.ts'))};`,
        resolveDir: adminRoot, sourcefile: 'ensure-http-consumer.ts' },
      define: { 'import.meta.env.DEV': 'false' }, plugins: [{ name: 'ensure-production-request-auth-fixture', setup(plugin) {
        plugin.onResolve({ filter: /^@\/utils\/request$/ }, () => ({ path: resolve(adminRoot, 'src/utils/request.ts') }));
        plugin.onResolve({ filter: /^@\/utils\/auth$/ }, () => ({ path: 'auth', namespace: 'ensure-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'ensure-fixture' }, () => ({ contents: 'export function getToken(){return globalThis.__ensureHttpToken;} export function clearAuth(){throw Error("Unexpected consumer authentication expiry");}', loader: 'js' }));
      } }] });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(resolve(adminRoot, 'package.json')), module, module.exports);
    consumer = module.exports as VueConsumer;
    consumer.request.defaults.adapter = async (config: AdapterConfig) => {
      const url = new URL(consumer.request.getUri(config), 'http://localhost');
      consumerPaths.push(url.pathname);
      const before = counters();
      const response = await app.request(url.pathname + url.search, { method: config.method?.toUpperCase(),
        headers: config.headers.toJSON(), body: config.data }, env);
      boundary(response, before);
      return { data: await response.json<Envelope>(), status: response.status, statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()), config, request: {} };
    };
  }, 30000);
  beforeEach(async () => {
    await f.reset(); await seedEnsures(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_ensure','id'),1000,false)");
    consumerPaths.length = 0;
  }, 30000);
  afterAll(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { Reflect.deleteProperty(globalThis, '__ensureHttpToken'); vi.restoreAllMocks(); await f?.close(); }
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
    const response = await app.request(path.startsWith('/') ? path : `/adminapi/${path}`, { method,
      headers: { ...(id ? { 'Authori-zation': `Bearer ${tokens[id]}` } : {}), 'Content-Type': 'application/json', ...headers }, body }, env);
    boundary(response, before); return response;
  }
  async function request(method: string, path: string, body?: unknown, id = 101) {
    const response = await raw(method, path, body === undefined ? undefined : JSON.stringify(body), id);
    return { response, body: await response.json<Envelope>() };
  }
  async function snapshot() {
    return { ensures: await f.db.select().from(storeProductEnsure).orderBy(storeProductEnsure.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }

  it('serves legacy selectors, list dates and forms while modern prefixes retain full numeric DTOs and pagination', async () => {
    expect((await request('GET', 'product/all_ensure')).body.data).toEqual([{ id: 10, name: '无忧退' }, { id: 12, name: '破损保障' }]);
    const legacy = (await request('GET', 'product/ensure?page=1&limit=1')).body.data;
    expect(legacy).toMatchObject({ list: [{ id: 11, add_time: '1970-01-01 08:00:00', product_count: 0 }], count: 3 });
    expect(legacy).not.toHaveProperty('page');
    expect((await request('GET', 'product/ensure/create')).body.data).toMatchObject({
      action: 'product/ensure', method: 'POST', rules: [{ field: 'name', props: { maxlength: 100 } },
        { field: 'desc' }, { field: 'image', type: 'frame' }, { field: 'sort' }],
    });
    expect((await request('GET', 'product/ensure/11/edit')).body.data).toMatchObject({
      action: 'product/ensure/11', method: 'PUT', rules: [
        { field: 'name', value: '隐藏保障' }, { field: 'desc', value: '已停用条款' },
        { field: 'image', value: 'https://shop.example/eleven.png' }, { field: 'sort', value: 9 },
      ],
    });
    expect((await request('GET', 'product/ensure/11')).body.data).toMatchObject({ id: 11, add_time: 0 });
    for (const prefix of ['/adminapi', '/api/admin/product']) {
      expect((await request('GET', `${prefix}/all_ensure`)).body.data).toMatchObject([{ id: 10, add_time: 1 }, { id: 12, add_time: 1700000000 }]);
      const modern = (await request('GET', `${prefix}/ensure?page=2&limit=1`)).body.data as { list: EnsureDTO[] };
      expect(modern).toMatchObject({ count: 3, page: 2, limit: 1, list: [{ id: 10, add_time: 1 }] });
      expect(modern.list[0]).not.toHaveProperty('product_count');
      expect((await request('GET', `${prefix}/ensure/11`)).body.data).toMatchObject({ add_time: 0 });
    }
  });

  it('executes all four PHP mutations with exact messages and empty-array responses, including populated list echoes', async () => {
    expect((await request('POST', 'product/ensure', ensureBody({ name: 'HTTP旧保障' }))).body)
      .toEqual({ status: 200, msg: '添加保障服务成功!', data: [] });
    const [created] = await f.db.select().from(storeProductEnsure).where(eq(storeProductEnsure.name, 'HTTP旧保障'));
    const list = (await request('GET', 'product/ensure?name=HTTP旧保障')).body.data as { list: EnsureDTO[] };
    expect((await request('PUT', `product/ensure/${created.id}`, { ...list.list[0], desc: '' })).body)
      .toEqual({ status: 200, msg: '修改成功!', data: [] });
    expect((await request('PUT', `product/ensure/set_show/${created.id}/0`)).body)
      .toEqual({ status: 200, msg: '设置成功', data: [] });
    expect((await request('DELETE', `product/ensure/${created.id}`)).body)
      .toEqual({ status: 200, msg: '删除成功!', data: [] });
    expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['POST', 'PUT', 'PUT', 'DELETE']);
    expect(await f.db.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, created.id))).toEqual([]);
  });

  it('keeps modern short and api/admin/product writers on explicit statuses, committed IDs and null mutations', async () => {
    for (const prefix of ['/adminapi', '/api/admin/product']) {
      const created = await request('POST', `${prefix}/ensure`, ensureBody({ name: `现代${prefix}`, status: 0 }));
      expect(created.body.status, created.body.msg).toBe(200);
      const id = (created.body.data as { id: number }).id;
      expect(id).toBeGreaterThan(0);
      const detail = (await request('GET', `${prefix}/ensure/${id}`)).body.data as EnsureDTO;
      expect(detail.status).toBe(0); expect(typeof detail.add_time).toBe('number');
      expect((await request('PUT', `${prefix}/ensure/${id}`, { ...detail, status: 1 })).body.data).toEqual({ id });
      expect((await request('PUT', `${prefix}/ensure/set_show/${id}/0`)).body.data).toBeNull();
      expect((await request('DELETE', `${prefix}/ensure/${id}`)).body).toMatchObject({ status: 200, data: null });
    }
  });

  it('uses the actual compiled Vue API and Axios /adminapi base URL to consume modern envelopes and writable status', async () => {
    const list = await consumer.apiProductEnsureList({ page: 2, limit: 1 });
    expect(list).toMatchObject({ page: 2, limit: 1, count: 3, list: [{ id: 10, add_time: 1 }] });
    const input = { name: 'Vue现代保障', image: 'https://shop.example/vue.png', desc: '现代保障说明', sort: 3, status: 0 };
    const before = await snapshot();
    await expect(consumer.apiProductEnsureSave(0, { ...input, desc: '' })).rejects.toThrow('请填写保障服务描述');
    expect(await snapshot()).toEqual(before);
    const created = await consumer.apiProductEnsureSave(0, input);
    expect(created.id).toBeGreaterThan(0);
    expect((await f.db.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, created.id)))[0].status).toBe(0);
    expect(await consumer.apiProductEnsureSave(created.id, { ...input, status: 1 })).toEqual(created);
    expect(await consumer.apiProductEnsureStatus(created.id, 0)).toBeNull();
    expect(await consumer.apiProductEnsureDelete(created.id)).toBeNull();
    expect(consumerPaths).toEqual(['/adminapi/ensure', '/adminapi/ensure', '/adminapi/ensure', `/adminapi/ensure/${created.id}`,
      `/adminapi/ensure/set_show/${created.id}/0`, `/adminapi/ensure/${created.id}`]);
  });

  it('preserves disabled rows through omitted and unchanged legacy status echoes and refuses legacy status injection', async () => {
    expect((await request('PUT', 'product/ensure/11', ensureBody({ name: '旧停用编辑' }))).body.status).toBe(200);
    const detail = (await request('GET', 'product/ensure/11')).body.data as EnsureDTO;
    expect(detail.status).toBe(0);
    expect((await request('PUT', 'product/ensure/11', { ...detail, desc: '旧完整回显' })).body.status).toBe(200);
    const before = await snapshot();
    expect((await request('PUT', 'product/ensure/11', { ...detail, status: 1 })).body.status).not.toBe(200);
    expect(await snapshot()).toEqual(before);
    expect((await request('PUT', 'ensure/11', { ...detail, status: 1 })).body.status).toBe(200);
    expect((await request('GET', 'ensure/11')).body.data).toMatchObject({ status: 1 });
  });

  it('admits exact page readers and numeric writers but rejects anonymous, unrelated, 1383 and read-only mutations', async () => {
    const before = await snapshot();
    for (const id of [102, 105]) {
      for (const path of ['product/all_ensure', 'product/ensure', 'product/ensure/create', 'product/ensure/11/edit', 'ensure']) {
        expect((await request('GET', path, undefined, id)).body.status).toBe(200);
      }
      for (const [method, path, body] of [['POST', 'product/ensure', ensureBody()],
        ['PUT', 'product/ensure/11', ensureBody()], ['PUT', 'ensure/set_show/11/1', undefined],
        ['DELETE', '/api/admin/product/ensure/11', undefined]] as const) {
        expect((await request(method, path, body, id)).body.status).toBe(400011);
      }
    }
    for (const id of [103, 106]) expect((await request('GET', 'product/ensure', undefined, id)).body.status).toBe(400011);
    const open = wiring.open.mock.calls.length;
    for (const [method, path] of [['GET', 'product/ensure'], ['GET', 'product/ensure/create'],
      ['GET', 'product/ensure/11/edit'], ['POST', 'product/ensure'], ['PUT', 'product/ensure/11'],
      ['PUT', 'product/ensure/set_show/11/1'], ['DELETE', 'ensure/11']]) {
      expect((await request(method, path, method === 'POST' || method === 'PUT' && !path.includes('set_show') ? ensureBody() : undefined, 0)).body)
        .toMatchObject({ status: 410000, data: null });
    }
    expect(wiring.open.mock.calls.length).toBe(open); expect(await snapshot()).toEqual(before);
    expect((await request('POST', 'product/ensure', ensureBody({ name: '数字菜单保障' }), 104)).body.status).toBe(200);
    const [created] = await f.db.select().from(storeProductEnsure).where(eq(storeProductEnsure.name, '数字菜单保障'));
    expect((await request('DELETE', `ensure/${created.id}`, undefined, 104)).body.status).toBe(200);
  });

  it('rejects cross-owner rows, immutable echoes, repeated parameters and malformed identity or status paths without effects', async () => {
    const before = await snapshot(), detail = (await request('GET', 'product/ensure/11')).body.data as EnsureDTO;
    for (const id of [20, 21, 22, 30, 999]) {
      expect((await request('GET', `product/ensure/${id}/edit`)).body.status).not.toBe(200);
      expect((await request('PUT', `product/ensure/${id}`, ensureBody())).body.status).not.toBe(200);
      expect((await request('DELETE', `product/ensure/${id}`)).body.status).not.toBe(200);
      expect((await request('PUT', `product/ensure/set_show/${id}/0`)).body.status).not.toBe(200);
    }
    for (const [method, path, body] of [['GET', 'product/ensure?page=1&page=2', undefined],
      ['GET', 'ensure?name=a&name=b', undefined], ['GET', 'product/ensure?owner_id=0', undefined],
      ['GET', 'product/ensure/create?id=0', undefined], ['GET', 'product/ensure/11/edit?id=11', undefined],
      ['GET', 'product/ensure/01', undefined], ['DELETE', 'ensure/2147483648', undefined],
      ['PUT', 'product/ensure/set_show/11/2', undefined], ['PUT', 'ensure/set_show/11/01', undefined],
      ['POST', 'product/ensure?id=0', ensureBody()], ['DELETE', 'ensure/11?id=11', undefined],
      ['PUT', 'product/ensure/11', { ...detail, id: 10 }], ['PUT', 'product/ensure/11', { ...detail, type: 2 }],
      ['PUT', 'product/ensure/11', { ...detail, add_time: 1 }], ['PUT', 'product/ensure/11', { ...detail, product_count: 1 }],
      ['POST', 'ensure', ensureBody({ unknown: true })]] as const) {
      expect((await request(method, path, body)).body.status, path).not.toBe(200);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('rejects invalid UTF8 and JSON and both declared and streaming bodies beyond 64 KiB with session cleanup', async () => {
    const before = await snapshot();
    for (const bytes of ['{', '', new Uint8Array([0xff])]) {
      expect(await (await raw('POST', 'product/ensure', bytes)).json()).toMatchObject({ status: 400 });
    }
    for (const body of [null, [], ensureBody({ image: '' }), ensureBody({ name: 'bad\u0000name' })]) {
      expect((await request('POST', 'ensure', body)).body.status).toBe(400);
    }
    expect(await (await raw('POST', 'ensure', '{}', 101, { 'Content-Length': '65537' })).json()).toMatchObject({ status: 400 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65537)); },
      cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const countersBefore = counters();
    const response = await app.request(new Request('http://localhost/adminapi/product/ensure', { method: 'POST',
      headers: { 'Authori-zation': `Bearer ${tokens[101]}`, 'Content-Type': 'application/json' },
      body: stream, duplex: 'half' } as RequestInit), undefined, env);
    boundary(response, countersBefore); expect(await response.json()).toMatchObject({ status: 400 }); expect(cancelled).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses live role revocation, changed credentials, foreign admin identity and expired tokens without effects', async () => {
    const before = await snapshot();
    await f.db.update(systemRole).set({ rules: 'user.view' }).where(eq(systemRole.id, 1));
    expect((await request('POST', 'product/ensure', ensureBody())).body.status).toBe(400011);
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 102));
    expect((await request('GET', 'ensure', undefined, 102)).body.status).not.toBe(200);
    await f.db.update(systemAdmin).set({ adminType: 4, relationId: 20 }).where(eq(systemAdmin.id, 100));
    expect((await request('GET', 'product/ensure', undefined, 100)).body.status).not.toBe(200);
    const expired = await createToken(105, 'admin', md5('ensure-fixture-password'), env.APP_KEY,
      'cinashop', Math.floor(Date.now() / 1000) - 7 * 24 * 3600 - 5);
    expect(await (await raw('GET', 'ensure', undefined, 105, { 'Authori-zation': `Bearer ${expired.token}` })).json())
      .toMatchObject({ status: 410001, data: null });
    expect(await snapshot()).toEqual(before);
  });

  it('reports failed audit receipts for every HTTP mutation and leaves no committed catalog change', async () => {
    const before = await snapshot();
    await f.exec("CREATE FUNCTION skip_ensure_http_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_ensure_http_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_ensure_http_audit()");
    for (const [method, path, body] of [['POST', 'product/ensure', ensureBody()], ['PUT', 'ensure/11', ensureBody()],
      ['PUT', 'product/ensure/set_show/11/1', undefined], ['DELETE', '/api/admin/product/ensure/11', undefined]] as const) {
      expect((await request(method, path, body)).body.status).not.toBe(200);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('serves HEAD through all legacy read contracts and modern list, selector and detail without response bodies', async () => {
    const before = await snapshot();
    for (const path of ['product/all_ensure', 'product/ensure', 'product/ensure/create', 'product/ensure/11',
      'product/ensure/11/edit', 'all_ensure', 'ensure', 'ensure/11', '/api/admin/product/ensure']) {
      const response = await raw('HEAD', path, undefined, 105);
      expect(response.status, path).toBe(200); expect(await response.text()).toBe('');
    }
    expect(await snapshot()).toEqual(before);
  });
});
