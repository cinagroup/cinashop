import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { systemRole, systemAdmin, storeProduct, storeProductAttrValue, systemLog, storeOrderOutbox } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { legacySaveFixture, legacySaveBody } from './helpers/adminLegacyProductSave';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
type Envelope = { status: number; msg: string; data: unknown };
type Config = { method?: string; data?: string; headers: { toJSON(): Record<string, string> } };
type Legacy = { productAddApi(body: Record<string, unknown>): Promise<Envelope>;
  request: { defaults: { adapter: (config: Config) => Promise<unknown> }; getUri(config: Config): string } };
const queued: unknown[] = [];
const env = { APP_KEY: 'complete-product-save-http-local', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
  ORDER_QUEUE: { sendBatch: async (batch: unknown[]) => { queued.push(...batch); } } } as unknown as Env;

describe('genuine productAddApi/request/Axios → real App/JWT/complete-save SQL', () => {
  const app = createApp(), tokens: Record<number, string> = {}, calls: Array<{ path: string; body: unknown }> = [];
  let f: Awaited<ReturnType<typeof legacySaveFixture>>, legacy: Legacy;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No remote provider I/O in HTTP save fixture'));
    f = await legacySaveFixture(); wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [1, 2, 3, 4]) tokens[id] = (await createToken(id, 'admin', md5('legacy-save-password'), env.APP_KEY)).token;
    Reflect.set(globalThis, '__completeSaveToken', tokens[1]);
    const storage = () => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: unknown) => map.set(key, String(value)), clear: () => map.clear() }; };
    vi.stubGlobal('localStorage', storage()); vi.stubGlobal('sessionStorage', storage());
    vi.stubGlobal('window', { router: { replace: vi.fn() } });
    const php = resolve(import.meta.dirname, '../../../cinashop-php/view/admin/src');
    const require = createRequire(resolve(import.meta.dirname, '../../view/admin-ts/package.json'));
    const bundle = await build({ bundle: true, write: false, platform: 'node', format: 'cjs',
      stdin: { resolveDir: php, contents: `export {productAddApi} from ${JSON.stringify(resolve(php, 'api/product.js'))};export {default as request} from ${JSON.stringify(resolve(php, 'plugins/request/index.js'))};` },
      plugins: [{ name: 'actual-old-complete-save-hosts', setup(plugin) {
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: resolve(php, 'plugins/request/index.js') }));
        plugin.onResolve({ filter: /^axios$/ }, () => ({ path: require.resolve('axios') }));
        plugin.onResolve({ filter: /^(?:@\/store|@\/libs\/util|@\/setting|view-design)$/ }, args => ({ path: args.path, namespace: 'complete-save-host' }));
        plugin.onLoad({ filter: /.*/, namespace: 'complete-save-host' }, args => ({ contents:
          args.path === '@/store' ? 'export default {dispatch(){}}' : args.path === '@/libs/util'
            ? 'export default {cookies:{get(){return globalThis.__completeSaveToken},kefuGet(){},remove(){}},log:{error(){}}}'
            : args.path === '@/setting' ? 'export default {apiBaseURL:"https://save.local/adminapi",errorModalType:"Message",modalDuration:1}'
            : 'export const Message={error(){}},Notice={error(){}},LoadingBar={};' }));
      } }], logLevel: 'silent' });
    const module = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
    legacy = module.exports as Legacy;
    const { AxiosError } = require('axios') as { AxiosError: new (...args: unknown[]) => Error };
    legacy.request.defaults.adapter = async config => {
      const url = new URL(legacy.request.getUri(config)); calls.push({ path: url.pathname, body: JSON.parse(config.data!) });
      const response = await app.request(url.href, { method: config.method?.toUpperCase() ?? 'GET', headers: config.headers.toJSON(), body: config.data }, env);
      const value = { data: await response.json(), status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), config };
      if (response.status < 200 || response.status >= 300) throw new AxiosError('App rejected transport', 'ERR_BAD_RESPONSE', config, undefined, value);
      return value;
    };
  }, 30000);
  beforeEach(async () => {
    await f.seed(); calls.length = 0; queued.length = 0; Reflect.set(globalThis, '__completeSaveToken', tokens[1]);
    await f.db.insert(systemRole).values([{ id: 2, rules: 'product.view' }, { id: 3, rules: '105' }, { id: 4, rules: '620' }]);
    await f.db.insert(systemAdmin).values([2, 3, 4].map(id => ({ id, account: `save-reader-${id}`, pwd: 'legacy-save-password', level: 1, roles: String(id) })));
  });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally {
    Reflect.deleteProperty(globalThis, '__completeSaveToken'); vi.restoreAllMocks(); vi.unstubAllGlobals(); await f?.close();
  } });
  const raw = (id: number, suffix = '0', body = JSON.stringify(legacySaveBody()), method = 'POST') => app.request(`https://save.local/adminapi/product/product/${suffix}`,
    { method, headers: { ...(id ? { 'Authori-zation': `Bearer ${tokens[id]}` } : {}), 'Content-Type': 'application/json' }, body }, env);

  it('uses the genuine old helper id field as URL target, saves complete fields and consumes the exact source create/edit envelope', async () => {
    expect(await legacy.productAddApi({ id: 0, ...legacySaveBody({ is_limit: 1, limit_type: 2, limit_num: 4 }) }))
      .toEqual({ status: 200, msg: '添加商品成功!', data: [] });
    expect(calls[0]).toMatchObject({ path: '/adminapi/product/product/0', body: { id: 0, is_limit: 1, limit_num: 4 } });
    expect(await legacy.productAddApi({ id: 1, ...legacySaveBody({ store_name: '完整编辑', is_show: 0, is_limit: 1, limit_type: 1, limit_num: 2 }) }))
      .toEqual({ status: 200, msg: '保存商品信息成功', data: [] });
    expect((await f.db.select().from(storeProduct))[0]).toMatchObject({ id: 1, storeName: '完整编辑', isShow: 0, isLimit: 1, limitType: 1, limitNum: 2 });
    expect(await f.db.select().from(storeProductAttrValue)).toHaveLength(1);
    expect((await f.db.select().from(systemLog)).filter(row => row.type === 'product_save')).toHaveLength(2);
    expect((await f.db.select().from(storeOrderOutbox)).map(row => row.status)).toEqual(['ENQUEUED', 'ENQUEUED']);
    expect(queued).toHaveLength(2);
  });
  it('admits exact legacy105 and refuses view/620, unauthenticated and live-revoked identities without writes', async () => {
    Reflect.set(globalThis, '__completeSaveToken', tokens[3]);
    expect((await legacy.productAddApi({ id: 0, ...legacySaveBody() })).status).toBe(200);
    for (const actor of [0, 2, 4]) {
      const before = await f.snapshot(); expect((await (await raw(actor)).json<Envelope>()).status).not.toBe(200);
      expect(await f.snapshot()).toEqual(before);
    }
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 3));
    const revoked = await f.snapshot(); await expect(legacy.productAddApi({ id: 1, ...legacySaveBody() })).rejects.toMatchObject({ status: 400011 });
    expect(await f.snapshot()).toEqual(revoked);
  });
  it('rejects malformed and duplicate JSON, actual oversized UTF8, query and invalid path IDs without SQL changes', async () => {
    const before = await f.snapshot();
    for (const suffix of ['00', '-1', '2147483648', '0?copy=1']) expect((await (await raw(1, suffix)).json<Envelope>()).status).not.toBe(200);
    for (const body of ['{', '{"store_name":"one","store_name":"two"}', JSON.stringify({ description: '中'.repeat(350000) })])
      expect((await (await raw(1, '0', body)).json<Envelope>()).status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  });
  it('returns classified full rollback refusals in the old rejecting business envelope', async () => {
    await f.db.insert(storeProduct).values({ id: 1, isDel: 1, isShow: 0 });
    const before = await f.snapshot();
    await expect(legacy.productAddApi({ id: 1, ...legacySaveBody({ is_show: 1 }) })).rejects.toMatchObject({ status: 400 });
    expect(await f.snapshot()).toEqual(before);
    // No-provider scraped import is an explicit refusal before business writes.
    await expect(legacy.productAddApi({ id: 0, ...legacySaveBody({ type: -1 }) })).rejects.toMatchObject({ status: 400 });
    expect(await f.snapshot()).toEqual(before);
  });
});
