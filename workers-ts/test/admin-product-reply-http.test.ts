import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { storeProductReply, storeProductReplyComment, systemAdmin, systemMenus, systemRole, systemLog } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { productReplyFixture, seedReplies } from './helpers/adminProductReplies';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const env = { APP_KEY: 'reply-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
type Envelope = { status: number; msg: string; data?: unknown };
type Config = { method?: string; data?: BodyInit; headers: { toJSON(): Record<string, string> } };
type Consumer = {
  request: { defaults: Record<string, unknown>; getUri(config: Config): string };
  apiAdminProductReplyList(query: Record<string, string | number>): Promise<{ list: Array<{ id: number; replyComment: unknown }>; count: number }>;
  apiAdminProductReplySet(id: number, content: string): Promise<void>;
  apiAdminProductReplyGet(id: number): Promise<{ content: string }>;
  apiAdminProductReplyComments(id: number, query: Record<string, string | number>): Promise<{ list: Array<{ id: number }>; count: number }>;
  apiAdminProductReplySaveComment(replyId: number, id: number, content: string): Promise<void>;
  apiAdminProductReplyDeleteComment(id: number): Promise<void>;
  apiAdminProductReplyDelete(id: number): Promise<void>;
  apiAdminReplyStatus(id: number, status: number): Promise<null>;
};
type Legacy = { replyListApi(query: Record<string, string | number>): Promise<Envelope>;
  setReplyApi(body: { content: string }, id: number): Promise<Envelope>;
  productReplycomment(query: Record<string, string | number>, id: number): Promise<Envelope>;
  productReplySave(body: { content: string }, replyId: number, id: number): Promise<Envelope>;
  modalSure: (this: unknown, config: unknown) => Promise<Envelope>;
  index: { methods: { del: (this: unknown, row: { id: number }, title: string, index: number) => void } } };

describe('actual Admin review App JWT/SQL and compiled old and modern Axios consumers', () => {
  const app = createApp(), tokens: Record<number, string> = {};
  let f: Awaited<ReturnType<typeof productReplyFixture>>, consumer: Consumer, legacy: Legacy;
  const paths: string[] = [], oldCalls: Array<{ path: string; data: unknown }> = [];
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Review HTTP fixture forbids external I/O'));
    f = await productReplyFixture(); wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [100, 101, 102, 103, 104, 105, 106, 107, 108]) tokens[id] = (await createToken(id, 'admin', md5('reply-fixture-password'), env.APP_KEY)).token;
    Reflect.set(globalThis, '__replyHttpToken', tokens[101]);
    const admin = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(admin, 'package.json'));
    const result = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', external: ['axios'],
      stdin: { contents: `export * from ${JSON.stringify(resolve(admin, 'src/api/reply.ts'))}; export {default as request} from ${JSON.stringify(resolve(admin, 'src/utils/request.ts'))};`, resolveDir: admin },
      define: { 'import.meta.env.DEV': 'false' }, plugins: [{ name: 'reply-production-auth-fixture', setup(plugin) {
        plugin.onResolve({ filter: /^@\/utils\/request$/ }, () => ({ path: resolve(admin, 'src/utils/request.ts') }));
        plugin.onResolve({ filter: /^@\/utils\/auth$/ }, () => ({ path: 'auth', namespace: 'reply-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'reply-fixture' }, () => ({ contents: 'export function getToken(){return globalThis.__replyHttpToken;} export function clearAuth(){throw Error("Unexpected review consumer expiry");}', loader: 'js' }));
      } }] });
    const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
    consumer = module.exports as Consumer;
    consumer.request.defaults.adapter = async (config: Config) => { const url = new URL(consumer.request.getUri(config), 'http://localhost'); paths.push(url.pathname); return dispatch(url, config); };
    const request = require('axios').create({ baseURL: '/adminapi', headers: { 'Authori-zation': `Bearer ${tokens[101]}` } });
    request.interceptors.response.use((response: { data: Envelope }) => response.data.status === 200 ? response.data : Promise.reject(response.data));
    request.defaults.adapter = async (config: Config) => { const url = new URL(request.getUri(config), 'http://localhost'); oldCalls.push({ path: url.pathname, data: config.data }); return dispatch(url, config); };
    Reflect.set(globalThis, '__replyLegacyRequest', request);
    const php = resolve(import.meta.dirname, '../../../cinashop-php/view/admin/src');
    const old = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', stdin: { resolveDir: php,
      contents: `export {replyListApi,setReplyApi,productReplycomment,productReplySave} from ${JSON.stringify(resolve(php, 'api/product.js'))}; export {modalSure} from ${JSON.stringify(resolve(php, 'utils/public.js'))}; export {default as index} from ${JSON.stringify(resolve(php, 'pages/product/productReply/index.vue'))};` },
      plugins: [{ name: 'reply-actual-old-consumer', setup(plugin) {
        plugin.onResolve({ filter: /^@\/api\/(product|common)$/ }, args => ({ path: resolve(php, `api/${args.path.split('/').at(-1)}.js`) }));
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: 'request', namespace: 'reply-old-fixture' }));
        plugin.onResolve({ filter: /^vuex$|^@\/api\/marketing$|^@\/components\/|^@\/utils\/timeOptions$|^\.\.\/components\// }, args => ({ path: args.path, namespace: 'reply-old-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'reply-old-fixture' }, args => ({ contents: args.path === 'request' ? 'export default globalThis.__replyLegacyRequest;'
          : args.path === 'vuex' ? 'export const mapState=()=>({});' : args.path === '@/api/marketing' ? 'export function productAttrsApi(){throw Error("Unrelated fictitious workflow");}' : 'export default {};', loader: 'js' }));
        plugin.onLoad({ filter: /\.vue$/ }, async args => { const source = await readFile(args.path, 'utf8'), script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
          if (!script) throw Error('Missing actual old review page script'); return { contents: script, loader: 'js', resolveDir: resolve(php, 'pages/product/productReply') }; });
      } }] });
    const oldModule = { exports: {} }; new Function('module', 'exports', old.outputFiles[0].text)(oldModule, oldModule.exports); legacy = oldModule.exports as Legacy;
  }, 30000);
  beforeEach(async () => { await f.reset(); await seedReplies(f.db); await f.exec("SELECT setval(pg_get_serial_sequence('store_product_reply_comment','id'),1000,false)"); paths.length = 0; oldCalls.length = 0; }, 30000);
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { Reflect.deleteProperty(globalThis, '__replyHttpToken'); Reflect.deleteProperty(globalThis, '__replyLegacyRequest'); vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function dispatch(url: URL, config: Config) { const response = await raw(config.method?.toUpperCase() ?? 'GET', url.pathname + url.search, config.data, 0, config.headers.toJSON());
    return { data: await response.json<Envelope>(), status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), config, request: {} }; }
  async function raw(method: string, path: string, body?: BodyInit, id = 101, headers: Record<string, string> = {}) {
    const opened = wiring.open.mock.calls.length, closed = wiring.close.mock.calls.length;
    const response = await app.request(path.startsWith('/') ? path : `/adminapi/${path}`, { method, body,
      headers: { ...(id ? { 'Authori-zation': `Bearer ${tokens[id]}` } : {}), 'Content-Type': 'application/json', ...headers } }, env);
    expect(response.headers.get('cache-control')).toContain('private'); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(wiring.close.mock.calls.length - closed).toBe(wiring.open.mock.calls.length - opened); return response;
  }
  async function call(method: string, path: string, body?: unknown, id = 101) { return (await raw(method, path, body === undefined ? undefined : JSON.stringify(body), id)).json<Envelope>(); }
  async function snapshot() { return { reviews: await f.db.select().from(storeProductReply).orderBy(storeProductReply.id), comments: await f.db.select().from(storeProductReplyComment).orderBy(storeProductReplyComment.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id) }; }

  it('serves seven old contracts, exact omitted-data messages and the existing modern surfaces', async () => {
    for (const [raw, pics] of [['{}', []], ['{"0":"a","1":"b"}', ['a', 'b']],
      ['{"1":"b","0":"a"}', { 1: 'b', 0: 'a' }], ['{"0":"a","2":"c"}', { 0: 'a', 2: 'c' }],
      ['[{}, {"0":"a","1":"b"}]', [[], ['a', 'b']]], ['["\\ud800"]', null]] as const) {
      await f.db.update(storeProductReply).set({ pics: raw }).where(eq(storeProductReply.id, 20));
      const data = (await call('GET', 'product/reply?product_id=20')).data as { list: Array<{ pics: unknown }> };
      expect(data.list[0].pics).toEqual(pics);
    }
    await f.db.update(storeProductReply).set({ pics: '[9007199254740993]' }).where(eq(storeProductReply.id, 20));
    expect((await call('GET', 'product/reply?product_id=20')).status).toBe(503);
    await f.db.update(storeProductReply).set({ pics: '[]' }).where(eq(storeProductReply.id, 20));
    expect((await call('GET', 'product/reply?product_id=20')).data).toMatchObject({ count: 1, list: [{ id: 20, type: 2, replyComment: null, score: '5' }] });
    expect((await call('GET', 'product/reply/get_reply/20')).data).toEqual({ content: '' });
    expect(await call('PUT', 'product/reply/set_reply/20', { content: '平台回复供应商' })).toEqual({ status: 200, msg: '回复成功!' });
    expect((await call('GET', 'product/reply/get_reply/20')).data).toMatchObject({ type: 0, relation_id: 0, uid: 0, pid: 0, content: '平台回复供应商' });
    expect((await call('GET', 'product/reply/comment/20')).data).toMatchObject({ count: 1, list: [{ id: 120, children: null, is_praise: false }] });
    expect(await call('POST', 'product/reply/save_comment/20/120', { content: '平台二级回复' })).toEqual({ status: 200, msg: '保存成功' });
    expect(await call('DELETE', 'product/reply/delete_comment/120')).toEqual({ status: 200, msg: '删除成功' });
    expect(await call('DELETE', 'product/reply/20', { ids: '' })).toEqual({ status: 200, msg: '删除成功!' });
    for (const prefix of ['/adminapi/reply', '/api/admin/reply']) {
      expect((await call('GET', `${prefix}/list?page=1&limit=1`)).data).toMatchObject([{ id: 40, productId: 404, addTime: expect.any(Number) }]);
      expect(await call('POST', `${prefix}/status/10`, { status: 1 })).toEqual({ status: 200, msg: '操作成功', data: null });
    }
    expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 20)))[0]).toMatchObject({ isDel: 1, isReply: 0, comment: '供应商客户评价' });
  });
  it('executes actual modern API/request Axios all seven contracts and status against JWT and SQL', async () => {
    expect(await consumer.apiAdminProductReplyList({ product_id: 20, page: 1, limit: 15 })).toMatchObject({ count: 1, list: [{ id: 20 }] });
    await consumer.apiAdminProductReplySet(20, '现代一级'); expect(await consumer.apiAdminProductReplyGet(20)).toMatchObject({ content: '现代一级' });
    expect(await consumer.apiAdminProductReplyComments(20, { time: '', page: 1, limit: 15 })).toMatchObject({ count: 1, list: [{ id: 120 }] });
    await consumer.apiAdminProductReplySaveComment(20, 120, '现代二级'); await consumer.apiAdminProductReplyDeleteComment(120);
    expect(await consumer.apiAdminReplyStatus(20, 0)).toBeNull(); await consumer.apiAdminProductReplyDelete(20);
    expect(paths).toEqual(['/adminapi/product/reply', '/adminapi/product/reply/set_reply/20', '/adminapi/product/reply/get_reply/20', '/adminapi/product/reply/comment/20', '/adminapi/product/reply/save_comment/20/120', '/adminapi/product/reply/delete_comment/120', '/adminapi/reply/status/20', '/adminapi/product/reply/20']);
  });
  it('executes actual PHP APIs and old page del → modalSure → tableDelApi with empty HTTP body', async () => {
    expect((await legacy.replyListApi({ product_id: 20 })).data).toMatchObject({ count: 1 });
    expect(await legacy.setReplyApi({ content: '旧一级' }, 20)).toEqual({ status: 200, msg: '回复成功!' });
    expect((await legacy.productReplycomment({ page: 1, limit: 15 }, 20)).data).toMatchObject({ count: 1 });
    expect(await legacy.productReplySave({ content: '旧二级' }, 20, 120)).toEqual({ status: 200, msg: '保存成功' });
    let complete!: (value: string) => void, fail!: (error: unknown) => void;
    const finished = new Promise<string>((resolve, reject) => { complete = resolve; fail = reject; });
    const reload = vi.fn(), confirm = vi.fn((config: { onOk(): void }) => config.onOk()), remove = vi.fn();
    legacy.index.methods.del.call({ $modalSure(config: unknown) { return legacy.modalSure.call({ $Modal: { confirm, remove } }, config); }, $Message: { success: complete, error: fail }, tableList: [{ id: 20 }], formValidate: { page: 1 }, getList: reload }, { id: 20 }, '删除评论', 0);
    expect(await finished).toBe('删除成功!'); expect(reload).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce();
    expect(oldCalls.at(-1)).toEqual({ path: '/adminapi/product/reply/20', data: '' });
  });
  it('admits exact page/API read grants and rejects anonymous, product-only, unrelated and wildcard mutations', async () => {
    const before = await snapshot();
    for (const id of [102, 106, 107]) for (const path of ['product/reply', 'product/reply/comment/20', 'product/reply/get_reply/20', '/api/admin/reply/list']) expect((await call('GET', path, undefined, id)).status).toBe(200);
    for (const id of [0, 102, 103, 104, 106, 107, 108]) {
      expect((await call('PUT', 'product/reply/set_reply/20', { content: '拒绝' }, id)).status).not.toBe(200);
      expect((await call('DELETE', '/api/admin/reply/del/20', undefined, id)).status).not.toBe(200);
    }
    expect(await snapshot()).toEqual(before);
    expect((await call('PUT', 'product/reply/set_reply/20', { content: '真实189写入' }, 105)).status).toBe(200);
  });
  it('rejects forged seed page/action tuples consistently in single and bulk resolution', async () => {
    const permission = await import('@/services/admin/AdminPermissionService'); const service = new permission.AdminPermissionService(f.container);
    for (const id of [6, 188, 189, 190, 580]) {
      await f.db.update(systemMenus).set({ authType: 2, apiUrl: 'reply/status/<id>', methods: 'POST', menuPath: '', uniqueAuth: '' }).where(eq(systemMenus.id, id));
      expect(await service.resolveRulePermissionKeys(String(id))).toEqual([]);
      expect(await service.resolveManyRulePermissionKeys([String(id)])).toEqual([[]]);
    }
    expect((await call('POST', 'reply/status/20', { status: 0 }, 107)).status).not.toBe(200);
  });
  it('rejects malformed IDs, duplicate/unknown queries, ambiguous bodies, oversized payloads and cross-parent saves without side effects', async () => {
    const before = await snapshot();
    for (const path of ['product/reply?page=0', 'product/reply?page=1&page=2', 'product/reply?uid=1', 'product/reply/get_reply/020', 'product/reply/get_reply/20?x=1', 'product/reply/comment/20?time=2026/08/03-2026/08/02']) expect((await call('GET', path)).status).not.toBe(200);
    for (const body of [null, {}, { content: 'x', uid: 0 }, { content: '😀'.repeat(1001) }, { content: '\ud800' }]) expect((await call('PUT', 'product/reply/set_reply/20', body)).status).not.toBe(200);
    expect((await call('POST', 'product/reply/save_comment/20/100', { content: '错父' })).status).not.toBe(200);
    expect((await call('POST', 'reply/status/20', { status: '0' })).status).not.toBe(200);
    expect((await call('DELETE', 'product/reply/20', { ids: '20' })).status).not.toBe(200);
    expect((await (await raw('PUT', '/adminapi/product/reply/set_reply/20', '{broken')).json<Envelope>()).status).not.toBe(200);
    expect((await (await raw('PUT', '/adminapi/product/reply/set_reply/20', JSON.stringify({ content: 'a'.repeat(65536) }))).json<Envelope>()).status).not.toBe(200);
    expect(await snapshot()).toEqual(before);
  });
  it('revalidates password, current platform identity and revoked numeric roles for both modern and old writes', async () => {
    const before = await snapshot();
    await f.db.update(systemRole).set({ rules: 'product.manage' }).where(eq(systemRole.id, 1));
    expect((await call('PUT', 'product/reply/set_reply/20', { content: '撤权' })).status).not.toBe(200);
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 101));
    expect((await call('GET', 'product/reply')).status).not.toBe(200);
    const after = await snapshot(); expect(after).toEqual(before);
  });
});
