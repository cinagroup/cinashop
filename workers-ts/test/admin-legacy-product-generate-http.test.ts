import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { storeProductAttrValue, systemRole, systemAdmin, systemMenus, storeProductVirtual } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { legacySaveFixture, legacySaveBody, legacySaveActor, legacySaveSku } from './helpers/adminLegacyProductSave';
import { oldEditorSaveBody } from './helpers/adminLegacyProductRead';
const wiring = vi.hoisted(() => ({ container: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.container, createAdminDatabaseSession: wiring.open }));
type Row = Record<string, unknown>;
type Envelope = { status: number; msg: string; data: { info: { attr: unknown[]; value: Row[]; header: Array<{slot: string}>; product_type: number }; productInfo: Row } };
type Config = { method?: string; data?: string; headers: { toJSON(): Record<string, string> } };
type Legacy = { generateAttrApi(body: Row, id: number | string, mode: number | string): Promise<Envelope>; productInfoApi(id: string | number): Promise<Envelope>; productAddApi(body: Row): Promise<unknown>;
  request: { defaults: { adapter(config: Config): Promise<unknown> }; getUri(config: Config): string } };
const env = { APP_KEY: 'actual-old-product-generator-fixture', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as unknown as Env;
describe('actual generateAttrApi/request/Axios → readonly POST and stable save roundtrip', () => {
  const app = createApp(), tokens: Record<number, string> = {}, calls: string[] = [];
  let f: Awaited<ReturnType<typeof legacySaveFixture>>, legacy: Legacy;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Old productInfo fixture forbids external I/O'));
    f = await legacySaveFixture(); wiring.container.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [1, 2, 3, 4]) tokens[id] = (await createToken(id, 'admin', md5('legacy-save-password'), env.APP_KEY)).token;
    Reflect.set(globalThis, '__editorGenerateToken', tokens[1]);
    const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: unknown) => values.set(key, String(value)), clear: () => values.clear() }; };
    vi.stubGlobal('localStorage', storage()); vi.stubGlobal('sessionStorage', storage()); vi.stubGlobal('window', { router: { replace: vi.fn() } });
    const source = resolve(import.meta.dirname, '../../../cinashop-php/view/admin/src');
    const require = createRequire(resolve(import.meta.dirname, '../../view/admin-ts/package.json'));
    const bundle = await build({ bundle: true, write: false, platform: 'node', format: 'cjs',
      stdin: { resolveDir: source, contents: `export {productInfoApi,productAddApi,generateAttrApi} from ${JSON.stringify(resolve(source, 'api/product.js'))};export {default as request} from ${JSON.stringify(resolve(source, 'plugins/request/index.js'))};` },
      plugins: [{ name: 'old-editor-read-hosts', setup(plugin) {
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: resolve(source, 'plugins/request/index.js') }));
        plugin.onResolve({ filter: /^axios$/ }, () => ({ path: require.resolve('axios') }));
        plugin.onResolve({ filter: /^(?:@\/store|@\/libs\/util|@\/setting|view-design)$/ }, args => ({ path: args.path, namespace: 'read-host' }));
        plugin.onLoad({ filter: /.*/, namespace: 'read-host' }, args => ({ contents: args.path === '@/store' ? 'export default {dispatch(){}}'
          : args.path === '@/libs/util' ? 'export default {cookies:{get(){return globalThis.__editorGenerateToken},kefuGet(){},remove(){}},log:{error(){}}}'
          : args.path === '@/setting' ? 'export default {apiBaseURL:"https://editor.local/adminapi",errorModalType:"Message",modalDuration:1}'
          : 'export const Message={error(){}},Notice={error(){}},LoadingBar={};' }));
      } }], logLevel: 'silent' });
    const module = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
    legacy = module.exports as Legacy;
    const { AxiosError } = require('axios') as { AxiosError: new (...args: unknown[]) => Error };
    legacy.request.defaults.adapter = async config => {
      const url = new URL(legacy.request.getUri(config)); calls.push(url.pathname);
      const response = await app.request(url.href, { method: config.method?.toUpperCase() ?? 'GET', headers: config.headers.toJSON(),
        ...(config.data ? { body: config.data } : {}) }, env);
      const value = { data: await response.json(), status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), config };
      if (response.status < 200 || response.status >= 300) throw new AxiosError('Actual GET transport rejected', 'ERR_BAD_RESPONSE', config, undefined, value);
      return value;
    };
  }, 30000);
  beforeEach(async () => {
    await f.seed(); Reflect.set(globalThis, '__editorGenerateToken', tokens[1]); calls.length = 0;
    await f.db.insert(systemRole).values([{ id: 2, rules: '191' }, { id: 3, rules: '620' }, { id: 4, rules: '105' }]);
    await f.db.insert(systemAdmin).values([2, 3, 4].map(id => ({ id, account: `legacy-info-${id}`, pwd: 'legacy-save-password', roles: String(id), level: 1 })));
    await f.db.insert(systemMenus).values({ id: 191, authType: 2, apiUrl: 'product/generate_attr/<id>/<type>', methods: 'POST', menuPath: '/adminproduct/generate_attr/<id>', uniqueAuth: '' });
    await f.service.save(0, legacySaveBody({ is_limit: 1, limit_type: 1, limit_num: 3 }), legacySaveActor());
  });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally {
    Reflect.deleteProperty(globalThis, '__editorGenerateToken'); vi.restoreAllMocks(); vi.unstubAllGlobals(); await f?.close();
  } });

  const attrs = [{ value: '规格', detail: ['默认'] }];
  it('uses genuine old generator helper and generated rows in genuine whole-form POST while retaining stable persisted SKU identity', async () => {
    const [sku] = await f.db.select().from(storeProductAttrValue), before = await f.snapshot();
    const result = await legacy.generateAttrApi({ attrs }, 1, 0);
    expect(calls).toEqual(['/adminapi/product/generate_attr/1/0']); expect(result.status).toBe(200);
    expect(result.data.info.value[0]).toMatchObject({ values: '默认', price: 12.5, stock: 7, detail: { 规格: '默认' } });
    expect(result.data.info.value[0]).not.toHaveProperty('unique'); expect(await f.snapshot()).toEqual(before);
    const info = (await legacy.productInfoApi(1)).data.productInfo;
    await legacy.productAddApi({ ...oldEditorSaveBody(info), attrs: [{ ...result.data.info.value[0], stock: 9 }] });
    expect((await f.db.select().from(storeProductAttrValue))[0]).toMatchObject({ id: sku.id, unique: sku.unique, stock: 9 });
  });

  it('keeps actual existing mode0 and refill mode1/2 behavior and parent authority through the real helper', async () => {
    await f.db.update(storeProductAttrValue).set({ suk: '白' });
    const dimensions = [{ value: '颜色', detail: ['白', '黑'] }], before = await f.snapshot();
    const edit = await legacy.generateAttrApi({ attrs: dimensions, product_type: 1, items: [{ price: 900, stock: 99 }] }, 1, 0);
    expect(edit.data.info.value.map(row => row.values)).toEqual(['白']); expect(edit.data.info.product_type).toBe(0);
    for (const mode of [1, 2]) {
      const result = await legacy.generateAttrApi({ attrs: dimensions }, 1, mode);
      expect(result.data.info.value.map(row => row.values)).toEqual(['白', '黑']); expect(result.data.info.value[1]).toMatchObject({ price: 0, stock: 0 });
    }
    expect((await legacy.generateAttrApi({ attrs: dimensions, product_type: 3 }, 0, 1)).data.info.product_type).toBe(3);
    expect((await legacy.generateAttrApi({ attrs: [] }, 0, 0)).data.info.value).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  });

  it('separates exact191 from detail620 and save105 while rejecting live revocation and protecting no-store on denied calls', async () => {
    Reflect.set(globalThis, '__editorGenerateToken', tokens[2]);
    const before = await f.snapshot(); expect((await legacy.generateAttrApi({ attrs }, 1, 0)).data.info.value).toHaveLength(1);
    await expect(legacy.productInfoApi(1)).rejects.toMatchObject({ status: 400011 });
    await expect(legacy.productAddApi({ id: 1, ...legacySaveBody() })).rejects.toMatchObject({ status: 400011 });
    Reflect.set(globalThis, '__editorGenerateToken', tokens[3]); await expect(legacy.generateAttrApi({ attrs }, 1, 0)).rejects.toMatchObject({ status: 400011 });
    const denied = await app.request('https://editor.local/adminapi/product/generate_attr/1/0', { method: 'POST',
      headers: { 'Authori-zation': `Bearer ${tokens[3]}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ attrs }) }, env);
    expect(denied.headers.get('Cache-Control')).toContain('no-store'); expect(await f.snapshot()).toEqual(before);
    Reflect.set(globalThis, '__editorGenerateToken', tokens[4]); expect((await legacy.generateAttrApi({ attrs }, 1, 0)).data.info.value).toHaveLength(1);
    Reflect.set(globalThis, '__editorGenerateToken', tokens[2]); await f.db.update(systemRole).set({ rules: '620' }).where(eq(systemRole.id, 2));
    await expect(legacy.generateAttrApi({ attrs }, 1, 0)).rejects.toMatchObject({ status: 400011 });
  });

  it('rejects malformed canonical paths, queries, duplicate JSON and actual UTF8 over-cap bodies through the real App', async () => {
    const before = await f.snapshot();
    for (const [id, mode] of [['00', '0'], ['-1', '0'], ['2147483648', '0'], ['1', '03'], ['1', '3'], ['1', '0?copy=1'], ['999', '1']])
      await expect(legacy.generateAttrApi({ attrs }, id, mode)).rejects.toMatchObject({ status: 400 });
    for (const body of ['{"attrs":[],"attrs":[]}', JSON.stringify({ attrs, unused: '中'.repeat(22000) })]) {
      const response = await app.request('https://editor.local/adminapi/product/generate_attr/1/0', { method: 'POST',
        headers: { 'Authori-zation': `Bearer ${tokens[1]}`, 'Content-Type': 'application/json' }, body }, env);
      expect((await response.json<{ status: number }>()).status).toBe(400);
    }
    expect(await f.snapshot()).toEqual(before);
  });

  it('shows fixed edit content and aggregate counts without historical card credentials, excluding delivery fields in refill modes', async () => {
    const saved = await f.service.save(0, legacySaveBody({ product_type: 1, attrs: [legacySaveSku({ disk_info: 'GENERATOR-FIXED' })] }), legacySaveActor());
    const [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, saved.id));
    await f.db.insert(storeProductVirtual).values({ productId: saved.id, attrUnique: sku.unique, cardNo: 'GENERATOR-CARD', cardPwd: 'GENERATOR-PASSWORD', uid: 0 });
    const before = await f.snapshot(), info = (await legacy.generateAttrApi({ attrs }, saved.id, 0)).data.info;
    expect(info.value[0]).toMatchObject({ disk_info: 'GENERATOR-FIXED', virtual_list: [], virtual_available: 1, virtual_total: 1 });
    expect(JSON.stringify(info)).not.toMatch(/GENERATOR-CARD|GENERATOR-PASSWORD/);
    for (const mode of [1, 2]) expect((await legacy.generateAttrApi({ attrs }, saved.id, mode)).data.info.value[0]).not.toHaveProperty('disk_info');
    expect(await f.snapshot()).toEqual(before);
  });

  it('makes SQL capacity refusal reject in the actual old Axios consumer with no business mutation', async () => {
    await f.exec("UPDATE store_product_attr_value SET disk_info=repeat('x',1048577)"); const before = await f.snapshot();
    await expect(legacy.generateAttrApi({ attrs }, 1, 0)).rejects.toMatchObject({ status: 400, msg: expect.stringContaining('容量') });
    expect(await f.snapshot()).toEqual(before);
  });
});
