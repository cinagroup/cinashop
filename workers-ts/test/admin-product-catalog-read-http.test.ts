import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { systemRole, systemAdmin, storeProduct, systemAttachment } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { catalogReadFixture, seedCatalogReads, catalogReadSnapshot, seedCatalogPrivatePictures } from './helpers/adminProductCatalogReads';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=', 'base64'));
// Asset route/HMAC/metadata are real. Object bytes are an explicit R2 fixture,
// never evidence that the remote provider or an uploaded production file exists.
const bucket = { get: vi.fn(async (key: string) => /^(?:attachments\/admin\/1\/2026\/10\/fictitious-31|attachments\/supplier\/20\/2026\/10\/catalog-41)\.png$/.test(key) ? {
  body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png); controller.close(); } }), size: png.byteLength,
  etag: 'catalogue-r2-fixture', httpEtag: '"catalogue-r2-fixture"', httpMetadata: { contentType: 'image/png' },
  writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'image/png'); },
} : null) };
const env = { APP_KEY: 'catalogue-http-jwt-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ASSETS_BUCKET: bucket } as unknown as Env;
type Envelope = { status: number; msg: string; data?: unknown };
type Data = { count: number; list: Array<Record<string, unknown> & { id: number; image: string }> };
type Config = { method?: string; data?: BodyInit; headers: { toJSON(): Record<string, string> } };
type Header = { type: number; name: string; count: number };
type Legacy = { getGoods(query: Record<string, unknown>): Promise<Envelope>; getGoodHeade(query: Record<string, unknown>): Promise<Envelope>;
  page: { data(): { artFrom: Record<string, unknown> }; methods: { getDataList(this: unknown): void; goodHeade(this: unknown): void } } };
type Modern = { request: { defaults: Record<string, unknown>; getUri(config: Config): string };
  apiAdminProductList(query: Record<string, unknown>): Promise<Data>; apiAdminProductTypeHeader(query: Record<string, unknown>): Promise<Header[]> };

describe('main catalogue actual old SPA/Axios and modern API → App/JWT/SQL source read contract', () => {
  const app = createApp(), tokens: Record<number, string> = {};
  let f: Awaited<ReturnType<typeof catalogReadFixture>>, legacy: Legacy, modern: Modern;
  const calls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Catalogue HTTP fixture forbids remote I/O'));
    f = await catalogReadFixture(); wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [100, ...Array.from({ length: 11 }, (_, index) => 120 + index)])
      tokens[id] = (await createToken(id, 'admin', md5('reply-fixture-password'), env.APP_KEY)).token;
    const admin = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(admin, 'package.json'));
    const request = require('axios').create({ baseURL: '/adminapi', headers: { 'Authori-zation': `Bearer ${tokens[120]}` } });
    request.interceptors.response.use((response: { data: Envelope }) => response.data.status === 200 ? response.data : Promise.reject(response.data));
    request.defaults.adapter = adapter(request); Reflect.set(globalThis, '__catalogLegacyRequest', request);
    const php = resolve(import.meta.dirname, '../../../cinashop-php/view/admin/src'), pagePath = resolve(php, 'pages/product/productList/index.vue');
    const script = (await readFile(pagePath, 'utf8')).match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw Error('Actual old productList script missing');
    const imports = new Map<string, Set<string>>();
    for (const match of script.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
      const names = new Set<string>();
      const named = match[1].match(/\{([\s\S]*?)\}/)?.[1];
      if (named) for (const entry of named.split(',')) { const name = entry.trim().split(/\s+as\s+/)[0]; if (name) names.add(name); }
      imports.set(match[2], names);
    }
    const old = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', stdin: { resolveDir: php,
      contents: `export {getGoods,getGoodHeade} from ${JSON.stringify(resolve(php, 'api/product.js'))}; export {default as page} from ${JSON.stringify(pagePath)};` },
      plugins: [{ name: 'catalogue-actual-legacy-read-consumers', setup(plugin) {
        plugin.onResolve({ filter: /^@\/api\/product$/ }, () => ({ path: resolve(php, 'api/product.js') }));
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: 'request', namespace: 'catalogue-old-fixture' }));
        plugin.onResolve({ filter: /.*/ }, args => imports.has(args.path) && args.path !== '@/api/product'
          ? { path: args.path, namespace: 'catalogue-old-fixture' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'catalogue-old-fixture' }, args => ({ contents: args.path === 'request'
          ? 'export default globalThis.__catalogLegacyRequest;' : `export default {apiBaseURL:"/adminapi"}; ${[...(imports.get(args.path) ?? [])].map(name =>
            name === 'mapState' ? 'export const mapState=()=>({});' : `export function ${name}(){throw Error("Unrelated old catalogue dependency");}`).join('\n')}`, loader: 'js' }));
        plugin.onLoad({ filter: /productList\/index\.vue$/ }, () => ({ contents: script, loader: 'js', resolveDir: php }));
      } }] });
    const module = { exports: {} }; new Function('module', 'exports', old.outputFiles[0].text)(module, module.exports); legacy = module.exports as Legacy;
    Reflect.set(globalThis, '__catalogModernToken', tokens[120]);
    const current = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', external: ['axios'], define: { 'import.meta.env.DEV': 'false' },
      stdin: { contents: `export * from ${JSON.stringify(resolve(admin, 'src/api/product.ts'))}; export {default as request} from ${JSON.stringify(resolve(admin, 'src/utils/request.ts'))};`, resolveDir: admin },
      plugins: [{ name: 'catalogue-modern-auth-fixture', setup(plugin) {
        plugin.onResolve({ filter: /^@\/utils\/request$/ }, () => ({ path: resolve(admin, 'src/utils/request.ts') }));
        plugin.onResolve({ filter: /^@\/utils\/auth$/ }, () => ({ path: 'auth', namespace: 'catalogue-modern-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'catalogue-modern-fixture' }, () => ({ contents:
          'export function getToken(){return globalThis.__catalogModernToken;} export function clearAuth(){throw Error("Unexpected catalogue consumer expiry");}', loader: 'js' }));
      } }] });
    const currentModule = { exports: {} }; new Function('require', 'module', 'exports', current.outputFiles[0].text)(require, currentModule, currentModule.exports);
    modern = currentModule.exports as Modern; modern.request.defaults.adapter = adapter(modern.request);
  }, 30000);
  beforeEach(async () => { await f.reset(); await seedCatalogReads(f.db); calls.length = 0; bucket.get.mockClear();
    Reflect.set(globalThis, '__catalogModernToken', tokens[120]); }, 30000);
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { Reflect.deleteProperty(globalThis, '__catalogLegacyRequest'); Reflect.deleteProperty(globalThis, '__catalogModernToken');
      vi.restoreAllMocks(); await f?.close(); } }, 30000);
  function adapter(request: { getUri(config: Config): string }) { return async (config: Config) => {
    const url = new URL(request.getUri(config), 'http://localhost'); calls.push({ method: config.method?.toUpperCase() ?? 'GET', path: url.pathname, query: url.searchParams });
    const response = await raw(config.method?.toUpperCase() ?? 'GET', url.pathname + url.search, 0, config.headers.toJSON());
    return { data: await response.json<Envelope>(), status: response.status, statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()), config, request: {} };
  }; }
  async function raw(method: string, path: string, id = 120, headers: Record<string, string> = {}) {
    const opened = wiring.open.mock.calls.length, closed = wiring.close.mock.calls.length;
    const response = await app.request(path.startsWith('/') ? path : `/adminapi/${path}`, { method,
      headers: { ...(id ? { 'Authori-zation': `Bearer ${tokens[id]}` } : {}), ...headers } }, env);
    expect(response.headers.get('cache-control')).toContain('private'); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(wiring.close.mock.calls.length - closed).toBe(wiring.open.mock.calls.length - opened); return response;
  }
  const get = async (path: string, id = 120) => (await raw('GET', path, id)).json<Envelope>();

  it('executes actual old productList.data and getDataList/goodHeade with its complete untouched artFrom through real Axios, App, JWT and SQL', async () => {
    const before = await catalogReadSnapshot(f.db), artFrom = legacy.page.data().artFrom;
    expect(artFrom).toEqual({ page: 1, limit: 15, cate_id: '', type: '1', store_name: '', excel: 0,
      supplier_id: '', store_id: '', brand_id: [], store_label_id: [] });
    let done!: () => void, reject!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, fail) => { done = resolve; reject = fail; });
    const selection = vi.fn(), context = { artFrom, loading: false, tableList: [] as Data['list'], total: 0,
      headeNum: [] as Header[], isAll: 0, checkUidList: [], $Message: { error: reject },
      $refs: { xTable: { getCheckboxReserveRecords: () => [], setAllCheckboxRow: selection } },
      $nextTick(callback: () => void) { callback.call(this); done(); } };
    legacy.page.methods.getDataList.call(context); await finished;
    expect(context.total).toBe(9); expect(context.tableList[0]).toMatchObject({ id: 10, stock: 11,
      cate_name: '根分类/子分类', plate_name: '平台', collect: 2, visitor: 2 });
    expect(context.loading).toBe(false); expect(selection).toHaveBeenCalledWith(false);
    let headed!: () => void; const ready = new Promise<void>(resolve => { headed = resolve; });
    const headContext = new Proxy(context, { set(target, key, value) { Reflect.set(target, key, value); if (key === 'headeNum') headed(); return true; } });
    legacy.page.methods.goodHeade.call(headContext); await ready;
    expect(context.headeNum.map(row => row.type)).toEqual([1, 2, 4, 5, 6, 0, -1, -2]);
    expect(context.headeNum.map(row => row.count)).toEqual([9, 1, 2, 1, 3, 1, 1, 1]);
    expect(calls.map(row => row.path)).toEqual(['/adminapi/product/product', '/adminapi/product/product/type_header']);
    expect(calls[0].query.get('excel')).toBe('0'); expect(calls[0].query.get('type')).toBe('1');
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
  });

  it('uses actual old Axios bracket arrays and string-zero states, preserves category count anomalies and source page fallback', async () => {
    const before = await catalogReadSnapshot(f.db), base = legacy.page.data().artFrom;
    const pending = await legacy.getGoods({ ...base, type: '0' }); expect(pending.data).toMatchObject({ count: 1, list: [{ id: 15 }] });
    const selected = await legacy.getGoods({ ...base, cate_id: [0, 2, 2], store_name: 'missing',
      supplier_id: 20, brand_id: [5], store_label_id: [6] });
    expect(selected.data).toEqual({ list: [], count: 4 });
    expect(calls[1].query.getAll('cate_id[]')).toEqual(['0', '2', '2']);
    expect(calls[1].query.getAll('brand_id[]')).toEqual(['5']);
    const page = await legacy.getGoods({ ...base, page: 2, limit: 1, store_name: '20' });
    expect(page.data).toMatchObject({ count: 1, list: [{ id: 20 }] });
    const head = await legacy.getGoodHeade({ ...base, type: '0', cate_id: [2], store_id: 30, supplier_id: 20 });
    expect((head.data as { list: Header[] }).list.map(row => row.count)).toEqual([4, 0, 0, 0, 0, 1, 0, 0]);
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
  });

  it('executes the actual modern main-list/count and type-header Axios API without using the commodity selector', async () => {
    const before = await catalogReadSnapshot(f.db), list = await modern.apiAdminProductList({ page: 1, limit: 15, type: '1' });
    expect(list.count).toBe(9); expect(list.list.some(row => row.id === 30)).toBe(true);
    expect((await modern.apiAdminProductTypeHeader({ type: '0' })).map(row => row.type)).toEqual([1, 2, 4, 5, 6, 0, -1, -2]);
    expect(calls.map(row => row.path)).toEqual(['/adminapi/product/product', '/adminapi/product/product/type_header']);
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
  });

  it('keeps actual GET and HEAD read-only, source response envelopes/count and caller role grants with private no-store close lifecycle', async () => {
    const before = await catalogReadSnapshot(f.db);
    for (const id of [100, 120, 121, 122, 128, 129]) for (const path of ['product/product', 'product/product/type_header']) {
      expect((await get(path, id)).status).toBe(200);
      const head = await raw('HEAD', path, id); expect(head.status).toBe(200); expect(await head.text()).toBe('');
    }
    for (const id of [0, 123, 124, 125, 126, 127, 130]) for (const path of ['product/product', 'product/product/type_header']) {
      expect((await get(path, id)).status).not.toBe(200);
      const head = await raw('HEAD', path, id); expect(await head.text()).toBe('');
    }
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
  });

  it('rejects malformed, unknown/duplicated read query identities while preserving full business and audit rows', async () => {
    const before = await catalogReadSnapshot(f.db);
    for (const value of ['uid=1', 'status=0', 'pid=0', 'ids=10', 'type=-0', 'type=01', 'type=8',
      'supplier_id=020', 'page=1&page=2', 'limit=10&limit=10', 'cate_id=2&cate_id[]=2',
      'cate_id[0]=2&cate_id[0]=3', 'cate_id[2]=2', 'store_name=%00']) {
      for (const path of ['product/product', 'product/product/type_header']) expect((await get(`${path}?${value}`)).status).not.toBe(200);
    }
    expect(await catalogReadSnapshot(f.db)).toEqual(before);
  });

  it('rechecks actual JWT expiration/password and live role authority before either source catalogue endpoint without issuing business DML', async () => {
    const before = await catalogReadSnapshot(f.db), expired = await createToken(120, 'admin', md5('reply-fixture-password'), env.APP_KEY,
      'cinashop', Math.floor(Date.now() / 1000) - 8 * 86400);
    for (const path of ['product/product', 'product/product/type_header']) {
      const response = await raw('GET', path, 0, { 'Authori-zation': `Bearer ${expired.token}` });
      expect((await response.json<Envelope>()).status).not.toBe(200);
    }
    await f.db.update(systemRole).set({ rules: 'reply.view' }).where(eq(systemRole.id, 20));
    expect((await get('product/product')).status).not.toBe(200); expect((await get('product/product/type_header')).status).not.toBe(200);
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 20));
    await f.db.update(systemAdmin).set({ pwd: 'new-password' }).where(eq(systemAdmin.id, 120));
    const changed = await catalogReadSnapshot(f.db);
    expect((await get('product/product')).status).not.toBe(200); expect((await get('product/product/type_header')).status).not.toBe(200);
    expect(await catalogReadSnapshot(f.db)).toEqual(changed); expect(changed.systemLog).toEqual(before.systemLog);
  });

  it('passes actual signed catalogue images through the real asset HMAC route and SQL metadata checks with explicit fixture R2 bytes, while foreign/tampered/current-revoked references never read R2', async () => {
    await seedCatalogPrivatePictures(f.db); const before = await catalogReadSnapshot(f.db), data = await modern.apiAdminProductList({ type: '1' });
    const rows = [10, 20, 30].map(id => data.list.find(row => row.id === id)!);
    for (const row of rows) {
      expect(row.image).toMatch(/^\/api\/assets\/(?:31|41)\?expires=\d+&signature=[a-zA-Z0-9_-]+$/);
      const image = await app.request(row.image, {}, env);
      expect(image.status).toBe(200); expect(image.headers.get('content-type')).toBe('image/png');
      expect(image.headers.get('cache-control')).toContain('private'); expect(image.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    }
    expect(bucket.get).toHaveBeenCalledTimes(3);
    const tampered = new URL(rows[0].image, 'http://localhost'); tampered.searchParams.set('signature', 'a'.repeat(43));
    expect((await app.request(tampered.pathname + tampered.search, {}, env)).status).toBe(404);
    expect((await app.request('/api/assets/31', {}, env)).status).toBe(404);
    expect(bucket.get).toHaveBeenCalledTimes(3); expect(await catalogReadSnapshot(f.db)).toEqual(before);
    await f.db.update(storeProduct).set({ image: '/api/assets/33' }).where(eq(storeProduct.id, 10));
    const foreign = await modern.apiAdminProductList({ type: '1' }); expect(foreign.list.find(row => row.id === 10)?.image).toBe('');
    await f.db.update(systemAttachment).set({ relationId: 20 }).where(eq(systemAttachment.attId, 31));
    const fresh = await modern.apiAdminProductList({ type: '1' }); expect(fresh.list.find(row => row.id === 30)?.image).toBe('');
    expect(bucket.get).toHaveBeenCalledTimes(3); expect(fetch).not.toHaveBeenCalled();
  });
});
