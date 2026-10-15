import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createToken, md5 } from '@/utils/jwt';
import { storeProductAttrValue, storeProductStockRecord, systemRole, systemAttachment } from '@/models/schema';
import { stockFixture, seedStocks, resetStockSequences, stockRows, stockSnapshot } from './helpers/adminProductStocks';
import { fictitiousAttachment } from './helpers/adminProductFictitiousReplies';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=', 'base64'));
const bucket = { get: vi.fn(async () => ({ body: new ReadableStream({ start(c) { c.enqueue(png); c.close(); } }), size: png.byteLength,
  etag: 'stock-fixture', httpEtag: '"stock-fixture"', httpMetadata: { contentType: 'image/png' }, writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'image/png'); } })) };
const env = { APP_KEY: 'stock-http-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ASSETS_BUCKET: bucket } as unknown as Env;
type Envelope = { status: number; msg: string; data?: any };
type AxiosRequest = { defaults: any; getUri(config: any): string };

describe('genuine stock old modal and modern Axios through actual App/JWT/SQL', () => {
  const app = createApp(), tokens: Record<number, string> = {}, calls: Array<{ method: string; path: string; body: any }> = [];
  let f: Awaited<ReturnType<typeof stockFixture>>, old: any, modern: any;
  const storage = new Map<string, string>();
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Stock HTTP forbids external transport'));
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, String(value)), removeItem: (key: string) => storage.delete(key) });
    f = await stockFixture(); wiring.application.mockImplementation(() => f.container); wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/product', search: '', href: '' } }));
    for (let id = 100; id <= 109; id++) tokens[id] = (await createToken(id, 'admin', md5('stock-fixture-password'), env.APP_KEY)).token;
    const admin = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(admin, 'package.json'));
    const request = require('axios').create({ baseURL: '/adminapi', headers: { 'Authori-zation': `Bearer ${tokens[101]}` } });
    request.interceptors.response.use((response: { data: Envelope }) => response.data.status === 200 ? response.data : Promise.reject(response.data));
    request.defaults.adapter = adapter(request); Reflect.set(globalThis, '__stockLegacyRequest', request);
    const php = resolve(import.meta.dirname, '../../../cinashop-php/view/admin/src'), modal = resolve(php, 'pages/product/components/stockEdit.vue');
    const script = (await readFile(modal, 'utf8')).match(/<script>([\s\S]*?)<\/script>/)?.[1]; if (!script) throw Error('Actual stockEdit script missing');
    const compiled = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', stdin: { resolveDir: php,
      contents: `export {productAttrsApi,productSaveStocksApi} from ${JSON.stringify(resolve(php, 'api/product.js'))};export {default as modal} from ${JSON.stringify(modal)};` },
      plugins: [{ name: 'stock-actual-source-modal', setup(plugin) {
        plugin.onResolve({ filter: /^@\/api\/product\.js$/ }, () => ({ path: resolve(php, 'api/product.js') }));
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: 'request', namespace: 'source-stock-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'source-stock-fixture' }, () => ({ contents: 'export default globalThis.__stockLegacyRequest;', loader: 'js' }));
        plugin.onLoad({ filter: /stockEdit\.vue$/ }, () => ({ contents: script, loader: 'js', resolveDir: php }));
      } }] });
    const module = { exports: {} }; new Function('module', 'exports', compiled.outputFiles[0].text)(module, module.exports); old = module.exports;
    const current = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', external: ['axios'], alias: { '@': resolve(admin, 'src') }, define: { 'import.meta.env.DEV': 'false' },
      stdin: { contents: `export * from './src/api/productStock';export {default as request} from './src/utils/request';`, resolveDir: admin } });
    const currentModule = { exports: {} }; new Function('require', 'module', 'exports', current.outputFiles[0].text)(require, currentModule, currentModule.exports); modern = currentModule.exports; modern.request.defaults.adapter = adapter(modern.request);
  }, 30000);
  beforeEach(async () => { await f.reset(); await seedStocks(f.db); await resetStockSequences(f.exec); storage.clear(); storage.set('admin_token', tokens[101]); storage.set('admin_session', JSON.stringify({ userInfo: { id: 101, account: 'stock-101', level: 1 }, menus: [], uniqueAuth: ['product.view', 'product.manage'] })); calls.length = 0; bucket.get.mockClear(); });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { Reflect.deleteProperty(globalThis, '__stockLegacyRequest'); vi.restoreAllMocks(); vi.unstubAllGlobals(); await f?.close(); } });
  function adapter(request: AxiosRequest) { return async (config: any) => {
    const url = new URL(request.getUri(config), 'http://localhost'), method = config.method.toUpperCase();
    calls.push({ method, path: url.pathname, body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data });
    const response = await raw(method, url.pathname + url.search, 0, config.data, config.headers.toJSON());
    return { data: await response.json(), status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), config, request: {} };
  }; }
  async function raw(method: string, path: string, actor = 101, body?: string, headers: Record<string, string> = {}) {
    const response = await app.request(path, { method, headers: { ...(actor ? { 'Authori-zation': `Bearer ${tokens[actor]}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body }) }, env);
    expect(response.headers.get('cache-control')).toContain('no-store'); return response;
  }
  it('executes the actual untouched old modal GET/individual preview/PUT/all-zero rows and parent stockChange consumer over real JWT and SQL', async () => {
    let loaded!: () => void, failed!: (value: unknown) => void, saved!: () => void;
    const read = new Promise<void>((resolve, reject) => { loaded = resolve; failed = reject; }), write = new Promise<void>(resolve => { saved = resolve; });
    const context = new Proxy({ ...old.modal.data(), ...old.modal.methods, $Message: { success: vi.fn(), error: failed }, $emit: vi.fn((type, value) => { expect(type).toBe('stockChange'); expect(value).toBe('13'); saved(); }) },
      { set(target, key, value) { Reflect.set(target, key, value); if (key === 'stockData') loaded(); return true; } });
    old.modal.methods.productAttrs.call(context, { id: 10, spec_type: 1 }); await read;
    expect(context.stockData.map((row: any) => [row.id, row.changeNum, row.pm])).toEqual([[11, 0, 1], [12, 0, 1], [13, 0, 1]]);
    context.stockData[0].changeNum = '3'; old.modal.methods.countStock.call(context, context.stockData[0]); expect(context.stockData[0].resultNum).toBe(13);
    old.modal.methods.productSaveStocks.call(context); await write;
    expect(calls.map(row => [row.method, row.path])).toEqual([['GET', '/adminapi/product/product/attrs/10'], ['PUT', '/adminapi/product/product/saveStocks/10']]);
    expect(calls[1].body).toEqual({ attrs: [{ unique: 'stock001', pm: 1, stock: '3' }, { unique: 'stock002', pm: 1, stock: 0 }, { unique: 'old00001', pm: 1, stock: 0 }] });
    expect((await stockRows(f.db)).parent?.stock).toBe(13); expect(await f.db.select().from(storeProductStockRecord)).toHaveLength(4); expect(context.modals).toBe(false);
  });
  it('uses the actual modern Axios full stock DTO and exact relative API, preserving pm0/zero and positive-string/zero response wire', async () => {
    const rows = await modern.apiAdminProductStockAttrs(10); expect(rows).toHaveLength(3); expect(rows[0]).toMatchObject({ bar_code: 'SKU条码', code: 'SKU编码', disk_info: null });
    expect(await modern.apiAdminProductSaveStocks(10, [{ unique: 'stock001', pm: 0, stock: 0 }])).toEqual({ stock: '10' });
    expect(await modern.apiAdminProductSaveStocks(10, [{ unique: 'stock001', pm: 0, stock: 99 }])).toEqual({ stock: 0 });
    expect(calls.filter(row => row.method === 'PUT').map(row => row.body.attrs[0].pm)).toEqual([0, 0]);
    expect(modern.hasUnconfirmedStock(10)).toBe(false);
  });
  it('keeps source missing-parent GET empty/full orphan behavior but separates real view and manage actor capabilities', async () => {
    expect((await (await raw('GET', '/adminapi/product/product/attrs/998', 102)).json<Envelope>()).data).toEqual([]);
    expect((await (await raw('GET', '/adminapi/product/product/attrs/999', 102)).json<Envelope>()).data).toMatchObject([{ id: 91, image: '', disk_info: null }]);
    const before = await stockSnapshot(f.db);
    for (const actor of [102, 103, 104, 105, 107, 108, 109]) expect((await (await raw('PUT', '/adminapi/product/product/saveStocks/10', actor, JSON.stringify({ attrs: [{ unique: 'stock001', pm: 1, stock: 3 }] }))).json<Envelope>()).status).not.toBe(200);
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1));
    expect((await (await raw('PUT', '/adminapi/product/product/saveStocks/10', 101, JSON.stringify({ attrs: [{ unique: 'stock001', pm: 1, stock: 3 }] }))).json<Envelope>()).status).not.toBe(200);
    const after = await stockSnapshot(f.db); expect(after.storeProduct).toEqual(before.storeProduct); expect(after.storeProductAttrValue).toEqual(before.storeProductAttrValue); expect(after.storeOrderOutbox).toEqual([]);
  });
  it('rejects invalid paths, queries, methods, malformed JSON and bounded stream bodies without DML', async () => {
    const before = await stockSnapshot(f.db);
    for (const path of ['0', '01', '2147483648']) expect((await (await raw('GET', `/adminapi/product/product/attrs/${path}`)).json<Envelope>()).status).not.toBe(200);
    for (const [method, path, body] of [['GET', '/adminapi/product/product/attrs/10?where=x', undefined], ['PUT', '/adminapi/product/product/saveStocks/10?x=1', '{}'], ['PUT', '/adminapi/product/product/saveStocks/10', '{'], ['PUT', '/adminapi/product/product/saveStocks/10', '{"attrs":' + ' '.repeat(1024 * 1024) + '[]}']] as const) expect((await (await raw(method, path, 101, body)).json<Envelope>()).status).not.toBe(200);
    expect((await (await raw('POST', '/adminapi/product/product/saveStocks/10', 101, '{}')).json<Envelope>()).status).toBe(501);
    expect(await stockSnapshot(f.db)).toEqual(before);
  });
  it('passes actual signed SKU previews through real asset HMAC/SQL authorization with explicit local R2 bytes, never exposing card data or foreign metadata', async () => {
    await f.db.insert(systemAttachment).values([fictitiousAttachment(), { ...fictitiousAttachment(32), type: 4, relationId: 20, name: 'attachments/supplier/20/2026/10/foreign.png' }]);
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/31' }).where(eq(storeProductAttrValue.id, 11));
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/32' }).where(eq(storeProductAttrValue.id, 12));
    const result = (await (await raw('GET', '/adminapi/product/product/attrs/10')).json<Envelope>()).data;
    expect(result[0].image).toMatch(/^\/api\/assets\/31\?/); expect(result[1].image).toBe(''); expect(result[0].disk_info).toBeNull();
    expect(bucket.get).not.toHaveBeenCalled(); const response = await app.request(result[0].image, {}, env); expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(png); expect(bucket.get).toHaveBeenCalledTimes(1);
    await f.db.update(systemAttachment).set({ type: 4, relationId: 20 }).where(eq(systemAttachment.attId, 31));
    const fresh = (await (await raw('GET', '/adminapi/product/product/attrs/10')).json<Envelope>()).data;
    expect(fresh[0].image).toBe(''); // The DTO stops issuing links after an owner change.
    // Existing signed assets are bearer capabilities until expiry; this stock
    // slice does not introduce owner-revocation semantics to the asset reader.
    const tampered = new URL(result[0].image, 'http://localhost'); tampered.searchParams.set('signature', 'a'.repeat(43));
    expect((await app.request(tampered.pathname + tampered.search, {}, env)).status).toBe(404); expect(bucket.get).toHaveBeenCalledTimes(1);
  });
});
