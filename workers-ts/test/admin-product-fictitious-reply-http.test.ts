import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { storeProductReply, storeProduct, storeProductAttrValue, storeOrder, storeOrderCartInfo,
  systemLog, systemAdmin, systemRole, systemAttachment } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { fictitiousReplyFixture, seedFictitiousReplies, resetFictitiousSequences, fictitiousBody, fictitiousPrivateMediaBody } from './helpers/adminProductFictitiousReplies';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const pngBytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=', 'base64'));
const bucket = { get: vi.fn(async (key: string) => key === 'attachments/admin/1/2026/10/fictitious-31.png' ? {
  body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(pngBytes); controller.close(); } }),
  size: pngBytes.byteLength, etag: 'fixture-private-r2', httpEtag: '"fixture-private-r2"',
  httpMetadata: { contentType: 'image/png' }, writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'image/png'); },
} : null) };
const env = { APP_KEY: 'virtual-reply-http-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ASSETS_BUCKET: bucket } as unknown as Env;
type Envelope = { status: number; msg: string; data?: unknown };
type Config = { method?: string; data?: BodyInit; headers: { toJSON(): Record<string, string> } };
type Product = { id: number; image: string; attrValue: Array<{ unique: string; suk: string; product_id: number; image: string }> };
type Legacy = {
  fictitiousReply(id: number): Promise<Envelope>;
  saveFictitiousReply(body: unknown): Promise<Envelope>;
  changeListApi(query: Record<string, unknown>): Promise<Envelope>;
  addReply: { methods: { onOk(this: unknown): void } };
  goodsList: { methods: { getList(this: unknown): void } };
};
type Modern = {
  request: { defaults: Record<string, unknown>; getUri(config: Config): string };
  apiAdminProductReplyFictitiousForm(id: number): Promise<{ rules: Array<{ field: string; value?: unknown }> }>;
  apiAdminProductReplySaveFictitious(body: unknown): Promise<void>;
  apiAdminReplyProductSelector(query: Record<string, unknown>): Promise<{ count: number; list: Product[] }>;
  apiAdminProductReplyList(query: Record<string, unknown>): Promise<{ count: number; list: Array<{ id: number; avatar: string; pics: unknown }> }>;
};

describe('virtual review actual App JWT/SQL and actual old form/addReply/goodsList Axios consumer chain', () => {
  const app = createApp(), tokens: Record<number, string> = {};
  let f: Awaited<ReturnType<typeof fictitiousReplyFixture>>, legacy: Legacy, modern: Modern, customerToken: string;
  const calls: Array<{ method: string; path: string; query: string; data: unknown }> = [];
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Virtual review HTTP fixture forbids remote I/O'));
    f = await fictitiousReplyFixture(); wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (let id = 100; id <= 117; id++) tokens[id] = (await createToken(id, 'admin', md5('reply-fixture-password'), env.APP_KEY)).token;
    customerToken = (await createToken(2, 'api', md5(''), env.APP_KEY)).token;
    const admin = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(admin, 'package.json'));
    const request = require('axios').create({ baseURL: '/adminapi', headers: { 'Authori-zation': `Bearer ${tokens[115]}` } });
    request.interceptors.response.use((response: { data: Envelope }) => response.data.status === 200 ? response.data : Promise.reject(response.data));
    request.defaults.adapter = async (config: Config) => {
      const url = new URL(request.getUri(config), 'http://localhost');
      calls.push({ method: config.method?.toUpperCase() ?? 'GET', path: url.pathname, query: url.search, data: config.data });
      const response = await raw(config.method?.toUpperCase() ?? 'GET', url.pathname + url.search, config.data, 0, config.headers.toJSON());
      return { data: await response.json<Envelope>(), status: response.status, statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()), config, request: {} };
    };
    Reflect.set(globalThis, '__fictitiousLegacyRequest', request);
    const php = resolve(import.meta.dirname, '../../../cinashop-php/view/admin/src');
    const old = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', stdin: { resolveDir: php,
      contents: `export {fictitiousReply,saveFictitiousReply,changeListApi} from ${JSON.stringify(resolve(php, 'api/product.js'))}; export {default as addReply} from ${JSON.stringify(resolve(php, 'pages/product/components/addReply.vue'))}; export {default as goodsList} from ${JSON.stringify(resolve(php, 'components/goodsList/index.vue'))};` },
      plugins: [{ name: 'fictitious-actual-php-consumers', setup(plugin) {
        plugin.onResolve({ filter: /^@\/api\/product$/ }, () => ({ path: resolve(php, 'api/product.js') }));
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: 'request', namespace: 'fictitious-old-fixture' }));
        plugin.onResolve({ filter: /^vuex$|^@\/api\/live$/ }, args => ({ path: args.path, namespace: 'fictitious-old-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'fictitious-old-fixture' }, args => ({ contents: args.path === 'request'
          ? 'export default globalThis.__fictitiousLegacyRequest;' : args.path === 'vuex' ? 'export const mapState=()=>({});'
          : 'export function liveGoods(){throw Error("Unrelated live goods request");}', loader: 'js' }));
        plugin.onLoad({ filter: /\.vue$/ }, async args => {
          const script = (await readFile(args.path, 'utf8')).match(/<script>([\s\S]*?)<\/script>/)?.[1];
          if (!script) throw Error('Actual PHP component script missing'); return { contents: script, loader: 'js', resolveDir: dirname(args.path) };
        });
      } }] });
    const module = { exports: {} }; new Function('module', 'exports', old.outputFiles[0].text)(module, module.exports);
    legacy = module.exports as Legacy;
    Reflect.set(globalThis, '__fictitiousModernToken', tokens[115]);
    const current = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', external: ['axios'],
      stdin: { contents: `export * from ${JSON.stringify(resolve(admin, 'src/api/reply.ts'))}; export {default as request} from ${JSON.stringify(resolve(admin, 'src/utils/request.ts'))};`, resolveDir: admin },
      define: { 'import.meta.env.DEV': 'false' }, plugins: [{ name: 'fictitious-modern-auth-fixture', setup(plugin) {
        plugin.onResolve({ filter: /^@\/utils\/request$/ }, () => ({ path: resolve(admin, 'src/utils/request.ts') }));
        plugin.onResolve({ filter: /^@\/utils\/auth$/ }, () => ({ path: 'auth', namespace: 'fictitious-modern-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'fictitious-modern-fixture' }, () => ({ contents:
          'export function getToken(){return globalThis.__fictitiousModernToken;} export function clearAuth(){throw Error("Unexpected virtual consumer expiry");}', loader: 'js' }));
      } }] });
    const currentModule = { exports: {} }; new Function('require', 'module', 'exports', current.outputFiles[0].text)(require, currentModule, currentModule.exports);
    modern = currentModule.exports as Modern;
    modern.request.defaults.adapter = async (config: Config) => {
      const url = new URL(modern.request.getUri(config), 'http://localhost');
      calls.push({ method: config.method?.toUpperCase() ?? 'GET', path: url.pathname, query: url.search, data: config.data });
      const response = await raw(config.method?.toUpperCase() ?? 'GET', url.pathname + url.search, config.data, 0, config.headers.toJSON());
      return { data: await response.json<Envelope>(), status: response.status, statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()), config, request: {} };
    };
  }, 30000);
  beforeEach(async () => { await f.reset(); await seedFictitiousReplies(f.db); await resetFictitiousSequences(f.exec); calls.length = 0;
    bucket.get.mockClear(); Reflect.set(globalThis, '__fictitiousModernToken', tokens[115]); }, 30000);
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { Reflect.deleteProperty(globalThis, '__fictitiousLegacyRequest'); Reflect.deleteProperty(globalThis, '__fictitiousModernToken'); vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function raw(method: string, path: string, body?: BodyInit, id = 115, headers: Record<string, string> = {}) {
    const opened = wiring.open.mock.calls.length, closed = wiring.close.mock.calls.length;
    const response = await app.request(path.startsWith('/') ? path : `/adminapi/${path}`, { method, body,
      headers: { ...(id ? { 'Authori-zation': `Bearer ${tokens[id]}` } : {}), 'Content-Type': 'application/json', ...headers } }, env);
    expect(response.headers.get('cache-control')).toContain('private'); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(wiring.close.mock.calls.length - closed).toBe(wiring.open.mock.calls.length - opened); return response;
  }
  const call = async (method: string, path: string, body?: unknown, id = 115) =>
    (await raw(method, path, body === undefined ? undefined : JSON.stringify(body), id)).json<Envelope>();
  async function snapshot() { return { reviews: await f.db.select().from(storeProductReply).orderBy(storeProductReply.id),
    products: await f.db.select().from(storeProduct).orderBy(storeProduct.id), skus: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
    orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id), carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
    logs: await f.db.select().from(systemLog).orderBy(systemLog.id), attachments: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId) }; }
  function assertLegacyForm(value: unknown, productId: number) {
    expect(value).toMatchObject({ title: '添加虚拟评论', action: 'product/reply/save_fictitious_reply', method: 'POST' });
    const form = value as { rules: Array<{ field: string; type: string; value: unknown; props?: Record<string, unknown> }> };
    expect(form.rules.map(rule => rule.field)).toEqual([productId ? 'product_id' : 'image',
      'avatar', 'nickname', 'comment', 'product_score', 'service_score', 'pics', 'add_time']);
    expect(form.rules).toMatchObject([
      productId ? { type: 'hidden', field: 'product_id', value: productId }
        : { type: 'frame', field: 'image', value: '', props: { type: 'image', maxLength: 1,
          src: 'admin/store.StoreProduct/index?fodder=image', srcKey: 'image', width: '960px', height: '560px' } },
      { type: 'frame', field: 'avatar', value: '', props: { type: 'image', maxLength: 1,
        src: 'admin/widget.images/index?fodder=avatar', width: '960px', height: '505px' } },
      { type: 'input', field: 'nickname', value: '' },
      { type: 'input', field: 'comment', value: '', props: { type: 'textarea' } },
      { type: 'rate', field: 'product_score', value: 0, props: { allowHalf: false } },
      { type: 'rate', field: 'service_score', value: 0, props: { allowHalf: false } },
      { type: 'frame', field: 'pics', value: [], props: { type: 'image', maxLength: 8,
        src: 'admin/widget.images/index?fodder=pics&type=many&maxLength=8', closeBtn: false, okBtn: false } },
      { type: 'datePicker', field: 'add_time', value: '', props: { type: 'datetime', editable: false,
        placeholder: '请选择评论时间(不选择默认当前添加时间)' } },
    ]);
  }

  it('serves exact old form path zero and positive ID, real selector count/attrValue and omitted-data creation success', async () => {
    assertLegacyForm((await call('GET', 'product/reply/fictitious_reply/0', undefined, 109)).data, 0);
    assertLegacyForm((await call('GET', 'product/reply/fictitious_reply/20', undefined, 107)).data, 20);
    expect((await call('GET', 'product/product/list?page=1&limit=10&store_name=20', undefined, 114)).data)
      .toMatchObject({ count: 1, list: [{ id: 20, attrValue: [{ unique: 'supplysk', suk: '供应商蓝色' }] }] });
    expect(await call('POST', 'product/reply/save_fictitious_reply', fictitiousBody(), 110)).toEqual({ status: 200, msg: '添加成功!' });
    expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 1000)))[0])
      .toMatchObject({ uid: 0, oid: 0, orderCartInfoId: null, productId: 10, type: 0, relationId: 0, skuUnique: 'replysku' });
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10)))[0].star).toBe('3.4');
  });

  it('runs actual old GET helpers and goodsList.getList → canonical SKU → addReply.onOk through Axios JWT and SQL', async () => {
    assertLegacyForm((await legacy.fictitiousReply(20)).data, 20);
    let done!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, fail) => { done = resolve; reject = fail; });
    const context = { liveStatus: false, isLive: false, goodsType: 0, cateIds: [], loading: false,
      formValidate: { page: 1, limit: 10, cate_id: '', store_name: '20', is_new: '', store_label_id: '', is_integral: 1 },
      tableList: [] as Product[], total: 0, async sortData() { done(); }, $Message: { error: reject } };
    legacy.goodsList.methods.getList.call(context); await ready;
    expect(context.total).toBe(1); expect(context.tableList[0].id).toBe(20);
    const goods = context.tableList[0], attr = goods.attrValue[0];
    expect(attr.unique).toBe('supplysk');
    let success!: (message: string) => void;
    const emitted = vi.fn(), finished = new Promise<string>((resolve, fail) => { success = resolve; reject = fail; });
    legacy.addReply.methods.onOk.call({ goods, attr, avatar: { att_dir: '/uploads/old-avatar.png' },
      formData: { nickname: '旧运营自评', comment: '真实旧组件构造的正文' }, product_score: 3,
      service_score: 4, delivery_score: 2, reply_score: '2', pics: ['/uploads/old-pic.png'], add_time: '2026-08-03 12:00:00',
      $Message: { success, error: reject }, $emit: emitted });
    expect(await finished).toBe('添加成功!'); expect(emitted).toHaveBeenCalledWith('update:visible', false);
    expect(calls.map(row => row.path)).toEqual(['/adminapi/product/reply/fictitious_reply/20', '/adminapi/product/product/list', '/adminapi/product/reply/save_fictitious_reply']);
    const sent = JSON.parse(calls.at(-1)!.data as string);
    expect(sent).toMatchObject({ image: { product_id: 20 }, unique: 'supplysk', reply_score: '2' });
    expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 1000)))[0])
      .toMatchObject({ productId: 20, sku: '供应商蓝色', type: 0, relationId: 0, uid: 0, oid: 0, orderCartInfoId: null, deliveryScore: 2, logisticsScore: 2 });
  });

  it('executes the actual modern API/request Axios form, selector and self-review creation against live JWT and SQL', async () => {
    expect((await modern.apiAdminProductReplyFictitiousForm(10)).rules[0]).toMatchObject({ field: 'product_id', value: 10 });
    const data = await modern.apiAdminReplyProductSelector({ page: 1, limit: 10, store_name: '10', is_integral: 1 });
    expect(data.count).toBe(1); expect(data.list[0].attrValue[0].unique).toBe('replysku');
    await modern.apiAdminProductReplySaveFictitious(fictitiousBody());
    expect(calls.map(row => row.path)).toEqual(['/adminapi/product/reply/fictitious_reply/10', '/adminapi/product/product/list', '/adminapi/product/reply/save_fictitious_reply']);
    expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 1000)))[0]).toMatchObject({ uid: 0, oid: 0, orderCartInfoId: null });
  });

  it('publishes authorized canonical platform R2 selections through actual Axios/JWT/SQL and renders usable signed media in Admin and public review consumers', async () => {
    await f.db.update(storeProduct).set({ image: '/api/assets/31' }).where(eq(storeProduct.id, 10));
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/31' }).where(eq(storeProductAttrValue.id, 72));
    let selectorReady!: () => void, selectorFailed!: (error: unknown) => void;
    const selected = new Promise<void>((resolve, reject) => { selectorReady = resolve; selectorFailed = reject; });
    const picker = { liveStatus: false, isLive: false, goodsType: 0, cateIds: [], loading: false,
      formValidate: { page: 1, limit: 10, cate_id: '', store_name: '10', is_new: '', store_label_id: '', is_integral: 1 },
      tableList: [] as Product[], total: 0, async sortData() { selectorReady(); }, $Message: { error: selectorFailed } };
    legacy.goodsList.methods.getList.call(picker); await selected;
    expect(picker.total).toBe(1); expect(picker.tableList[0].id).toBe(10);
    expect(picker.tableList[0].image).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=[a-zA-Z0-9_-]+$/);
    expect(picker.tableList[0].attrValue[0]).toMatchObject({ unique: 'replysku', product_id: 10 });
    expect(picker.tableList[0].attrValue[0].image).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=[a-zA-Z0-9_-]+$/);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10)))[0].image).toBe('/api/assets/31');
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 72)))[0].image).toBe('/api/assets/31');
    const before = await snapshot();
    expect((await call('POST', 'product/reply/save_fictitious_reply', fictitiousPrivateMediaBody(), 115)).status).not.toBe(200);
    for (const avatar of ['/api/assets/32', '/api/assets/33', '/api/assets/999'])
      expect((await call('POST', 'product/reply/save_fictitious_reply', fictitiousBody({ avatar, pics: [avatar] }), 116)).status).not.toBe(200);
    expect(await snapshot()).toEqual(before);
    Reflect.set(globalThis, '__fictitiousModernToken', tokens[116]);
    await modern.apiAdminProductReplySaveFictitious(fictitiousPrivateMediaBody());
    const [stored] = await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 1000));
    expect(stored).toMatchObject({ uid: 0, oid: 0, type: 0, relationId: 0, orderCartInfoId: null,
      avatar: '/api/assets/31', pics: '["/api/assets/31"]' });
    const admin = (await modern.apiAdminProductReplyList({ product_id: 10, limit: 100 })).list.find(row => row.id === 1000)!;
    const listResponse = await app.request('/api/reply/list/10?limit=100', {}, env);
    const publicList = await listResponse.json<Envelope>(); expect(publicList.status).toBe(200);
    const publicRow = (publicList.data as Array<{ id: number; avatar: string; pics: unknown }>).find(row => row.id === 1000)!;
    const detailResponse = await app.request('/api/reply/info/1000', { headers: { 'Authori-zation': `Bearer ${customerToken}` } }, env);
    const detail = await detailResponse.json<Envelope>(); expect(detail.status).toBe(200);
    const publicDetail = (detail.data as { reply: { avatar: string; pics: unknown } }).reply;
    expect((detail.data as { product: { image: string } }).product.image).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=[a-zA-Z0-9_-]+$/);
    for (const projected of [admin, publicRow, publicDetail]) {
      expect(projected.avatar).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=[a-zA-Z0-9_-]+$/);
      expect(projected.pics).toEqual([projected.avatar]);
      const asset = await app.request(projected.avatar, {}, env);
      expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toBe('image/png');
      expect(asset.headers.get('cache-control')).toContain('private'); expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await asset.arrayBuffer())).toEqual(pngBytes);
    }
    expect(bucket.get).toHaveBeenCalledTimes(3);
    expect(bucket.get.mock.calls.every(([key]) => key === 'attachments/admin/1/2026/10/fictitious-31.png')).toBe(true);
    const wrong = new URL(admin.avatar, 'http://localhost'); wrong.searchParams.set('signature', 'a'.repeat(43));
    expect((await app.request(wrong.pathname + wrong.search, {}, env)).status).toBe(404);
    expect((await app.request('/api/assets/31', {}, env)).status).toBe(404);
    expect(bucket.get).toHaveBeenCalledTimes(3);
    const [fresh] = await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 1000));
    expect(fresh.avatar).toBe('/api/assets/31'); expect(fresh.pics).toBe('["/api/assets/31"]');
    expect(fresh.viewsNum).toBe(1); expect((await snapshot()).attachments).toEqual(before.attachments);
    // Imported customer rows cannot turn a private Admin object into a public
    // preview merely by containing its canonical path. Raw external positions
    // remain unchanged rather than being removed from the historical array.
    await f.db.update(storeProductReply).set({ avatar: '/api/assets/31', pics: '["/api/assets/31","https://fixture.invalid/public.jpg"]' }).where(eq(storeProductReply.id, 11));
    const historic = (await modern.apiAdminProductReplyList({ product_id: 10, limit: 100 })).list.find(row => row.id === 11)!;
    expect(historic).toMatchObject({ avatar: '', pics: ['', 'https://fixture.invalid/public.jpg'] });
    await f.db.update(systemAttachment).set({ relationId: 20 }).where(eq(systemAttachment.attId, 31));
    const unavailable = (await modern.apiAdminProductReplyList({ product_id: 10, limit: 100 })).list.find(row => row.id === 1000)!;
    expect(unavailable).toMatchObject({ avatar: '', pics: [''] });
    const complex = { image: '/api/assets/31', raw: 'https://fixture.invalid/raw.png' };
    await f.db.update(storeProductReply).set({ avatar: 'https://external.invalid/api/assets/31', pics: JSON.stringify(complex) }).where(eq(storeProductReply.id, 1000));
    const complexPage = (await call('GET', 'product/reply?product_id=10&limit=100', undefined, 116)).data as { list: Array<{ id: number; avatar: string; pics: unknown }> };
    expect(complexPage.list.find(row => row.id === 1000)).toMatchObject({ avatar: 'https://external.invalid/api/assets/31', pics: complex });
    expect(bucket.get).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists a signed historical pre-epoch self-review and filters it through the actual old Shanghai date query', async () => {
    expect(await call('POST', 'product/reply/save_fictitious_reply', fictitiousBody({ add_time: '1969-12-31 12:00:00' })))
      .toEqual({ status: 200, msg: '添加成功!' });
    const [saved] = await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 1000));
    expect(saved.addTime).toBe(-72000);
    const response = await call('GET', `product/reply?product_id=10&data=${encodeURIComponent('1969/12/31 - 1969/12/31')}`);
    expect(response.status).toBe(200); expect(response.data).toMatchObject({ count: 1, list: [{ id: 1000,
      create_time: '1969-12-31 12:00:00', add_time: '1969-12-31 12:00:00' }] });
  });

  it('separates genuine184/view/page6 form readers, genuine185 create, independent193 catalogue and wildcard/copied authority', async () => {
    const before = await snapshot();
    for (const id of [102, 107, 109]) {
      expect((await call('GET', 'product/reply/fictitious_reply/0', undefined, id)).status).toBe(200);
      expect((await call('GET', 'product/product/list', undefined, id)).status).not.toBe(200);
      expect((await call('POST', 'product/reply/save_fictitious_reply', fictitiousBody(), id)).status).not.toBe(200);
    }
    for (const id of [113, 114]) {
      expect((await call('GET', 'product/product/list', undefined, id)).status).toBe(200);
      expect((await call('POST', 'product/reply/save_fictitious_reply', fictitiousBody(), id)).status).not.toBe(200);
    }
    for (const id of [0, 103, 104, 108, 111, 112]) {
      expect((await call('GET', 'product/reply/fictitious_reply/0', undefined, id)).status).not.toBe(200);
      expect((await call('POST', 'product/reply/save_fictitious_reply', fictitiousBody(), id)).status).not.toBe(200);
    }
    expect((await call('GET', 'product/product/list', undefined, 110)).status).not.toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects noncanonical IDs, unknown/duplicate query/body identities and malformed or oversized streamed JSON without business writes', async () => {
    const before = await snapshot();
    for (const path of ['product/reply/fictitious_reply/020', 'product/reply/fictitious_reply/-1',
      'product/reply/fictitious_reply/20?product_id=30', 'product/reply/fictitious_reply/20?product_id=20&product_id=30',
      'product/product/list?page=1&page=2', 'product/product/list?uid=1']) expect((await call('GET', path)).status).not.toBe(200);
    for (const body of [null, {}, fictitiousBody({ uid: 1 }), fictitiousBody({ order_cart_info_id: 71 }),
      fictitiousBody({ product_id: 20 }), fictitiousBody({ nickname: '😀'.repeat(65) }), fictitiousBody({ pics: Array(9).fill('/a.png') })])
      expect((await call('POST', 'product/reply/save_fictitious_reply', body)).status).not.toBe(200);
    for (const body of ['{broken', JSON.stringify(fictitiousBody({ comment: 'a'.repeat(65536) }))])
      expect((await (await raw('POST', 'product/reply/save_fictitious_reply', body)).json<Envelope>()).status).not.toBe(200);
    const payload = JSON.stringify(fictitiousBody({ comment: 'b'.repeat(65536) }));
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      const bytes = new TextEncoder().encode(payload); for (let offset = 0; offset < bytes.length; offset += 8192) controller.enqueue(bytes.slice(offset, offset + 8192)); controller.close();
    } });
    const response = await app.request('/adminapi/product/reply/save_fictitious_reply', {
      method: 'POST', headers: { 'Authori-zation': `Bearer ${tokens[115]}`, 'Content-Type': 'application/json' }, body: stream,
      duplex: 'half',
    } as RequestInit, env);
    expect((await response.json<Envelope>()).status).not.toBe(200); expect(await snapshot()).toEqual(before);
  });

  it('revalidates actual JWT expiration, password and current roles before source reads or virtual inserts', async () => {
    const before = await snapshot();
    const expired = await createToken(115, 'admin', md5('reply-fixture-password'), env.APP_KEY, 'cinashop', Math.floor(Date.now() / 1000) - 8 * 86400);
    expect((await (await raw('POST', 'product/reply/save_fictitious_reply', JSON.stringify(fictitiousBody()), 0,
      { 'Authori-zation': `Bearer ${expired.token}` })).json<Envelope>()).status).not.toBe(200);
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 15));
    expect((await call('POST', 'product/reply/save_fictitious_reply', fictitiousBody())).status).not.toBe(200);
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 115));
    expect((await call('GET', 'product/product/list')).status).not.toBe(200);
    expect(await snapshot()).toEqual(before);
  });
});
