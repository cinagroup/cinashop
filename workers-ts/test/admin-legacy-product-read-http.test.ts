import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { storeProduct, storeProductAttrValue, systemRole, systemAdmin, systemForm } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { legacySaveFixture, legacySaveBody, legacySaveActor, legacySaveSku } from './helpers/adminLegacyProductSave';
import { oldEditorSaveBody } from './helpers/adminLegacyProductRead';
const wiring = vi.hoisted(() => ({ container: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.container, createAdminDatabaseSession: wiring.open }));
type Row = Record<string, unknown>;
type Envelope = { status: number; msg: string; data: { tempList: unknown[]; cateList: unknown[]; productInfo: Row } };
type Config = { method?: string; data?: string; headers: { toJSON(): Record<string, string> } };
type Legacy = { productInfoApi(id: string | number): Promise<Envelope>; productAddApi(body: Row): Promise<unknown>;
  request: { defaults: { adapter(config: Config): Promise<unknown> }; getUri(config: Config): string } };
const env = { APP_KEY: 'actual-old-product-info-fixture', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as unknown as Env;
describe('actual productInfoApi/request/Axios → authenticated legacy GET and full save roundtrip', () => {
  const app = createApp(), tokens: Record<number, string> = {}, calls: string[] = [];
  let f: Awaited<ReturnType<typeof legacySaveFixture>>, legacy: Legacy;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Old productInfo fixture forbids external I/O'));
    f = await legacySaveFixture(); wiring.container.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [1, 2, 3, 4]) tokens[id] = (await createToken(id, 'admin', md5('legacy-save-password'), env.APP_KEY)).token;
    Reflect.set(globalThis, '__editorReadToken', tokens[1]);
    const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: unknown) => values.set(key, String(value)), clear: () => values.clear() }; };
    vi.stubGlobal('localStorage', storage()); vi.stubGlobal('sessionStorage', storage()); vi.stubGlobal('window', { router: { replace: vi.fn() } });
    const source = resolve(import.meta.dirname, '../../../cinashop-php/view/admin/src');
    const require = createRequire(resolve(import.meta.dirname, '../../view/admin-ts/package.json'));
    const bundle = await build({ bundle: true, write: false, platform: 'node', format: 'cjs',
      stdin: { resolveDir: source, contents: `export {productInfoApi,productAddApi} from ${JSON.stringify(resolve(source, 'api/product.js'))};export {default as request} from ${JSON.stringify(resolve(source, 'plugins/request/index.js'))};` },
      plugins: [{ name: 'old-editor-read-hosts', setup(plugin) {
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: resolve(source, 'plugins/request/index.js') }));
        plugin.onResolve({ filter: /^axios$/ }, () => ({ path: require.resolve('axios') }));
        plugin.onResolve({ filter: /^(?:@\/store|@\/libs\/util|@\/setting|view-design)$/ }, args => ({ path: args.path, namespace: 'read-host' }));
        plugin.onLoad({ filter: /.*/, namespace: 'read-host' }, args => ({ contents: args.path === '@/store' ? 'export default {dispatch(){}}'
          : args.path === '@/libs/util' ? 'export default {cookies:{get(){return globalThis.__editorReadToken},kefuGet(){},remove(){}},log:{error(){}}}'
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
    await f.seed(); Reflect.set(globalThis, '__editorReadToken', tokens[1]); calls.length = 0;
    await f.db.insert(systemRole).values([{ id: 2, rules: '620' }, { id: 3, rules: 'order.view' }, { id: 4, rules: '105' }]);
    await f.db.insert(systemAdmin).values([2, 3, 4].map(id => ({ id, account: `legacy-info-${id}`, pwd: 'legacy-save-password', roles: String(id), level: 1 })));
    await f.service.save(0, legacySaveBody({ is_limit: 1, limit_type: 1, limit_num: 3 }), legacySaveActor());
  });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally {
    Reflect.deleteProperty(globalThis, '__editorReadToken'); vi.restoreAllMocks(); vi.unstubAllGlobals(); await f?.close();
  } });

  it('loads the genuine old GET shape and saves its transformed whole DTO through the genuine old POST', async () => {
    const before = await f.snapshot(), response = await legacy.productInfoApi(1);
    expect(calls).toEqual(['/adminapi/product/product/1']); expect(response.status).toBe(200);
    expect(response.data.productInfo).toMatchObject({ id: 1, store_name: '完整商品', items: [], attrs: [], is_limit: true,
      attr: { pic: '/uploads/sku.png', stock: 7, unique: expect.any(String) } });
    expect(await f.snapshot()).toEqual(before);
    await legacy.productAddApi({ ...oldEditorSaveBody(response.data.productInfo), store_name: '旧调用完整往返' });
    expect((await f.db.select().from(storeProduct))[0]).toMatchObject({ storeName: '旧调用完整往返', isLimit: 1, limitType: 1, limitNum: 3 });
    expect((await f.db.select().from(storeProductAttrValue))[0].unique).toBe((response.data.productInfo.attr as Row).unique);
  });

  it('admits seed620 read, refuses its write, denies unrelated/revoked identities and preserves no-store headers', async () => {
    Reflect.set(globalThis, '__editorReadToken', tokens[2]);
    expect((await legacy.productInfoApi(1)).data.productInfo.id).toBe(1);
    const before = await f.snapshot();
    await expect(legacy.productAddApi({ id: 1, ...legacySaveBody() })).rejects.toMatchObject({ status: 400011 });
    expect(await f.snapshot()).toEqual(before);
    const response = await app.request('https://editor.local/adminapi/product/product/1', { headers: { 'Authori-zation': `Bearer ${tokens[2]}` } }, env);
    expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('Pragma')).toBe('no-cache');
    Reflect.set(globalThis, '__editorReadToken', tokens[3]); await expect(legacy.productInfoApi(1)).rejects.toMatchObject({ status: 400011 });
    Reflect.set(globalThis, '__editorReadToken', tokens[2]); await f.db.update(systemRole).set({ rules: 'order.view' }).where(eq(systemRole.id, 2));
    await expect(legacy.productInfoApi(1)).rejects.toMatchObject({ status: 400011 });
    expect((await (await app.request('https://editor.local/adminapi/product/product/1', {}, env)).json<{ status: number }>()).status).toBe(410000);
  });

  it('returns old-Axios rejecting errors for missing/zero/path/query and classified repair refusal with no accidental mutation', async () => {
    const before = await f.snapshot();
    for (const id of [0, 999, '00', '-1', '2147483648', '1?copy=1']) await expect(legacy.productInfoApi(id)).rejects.toMatchObject({ status: 400 });
    expect(await f.snapshot()).toEqual(before);
    // Valid single dimensions cannot be silently treated as two active SKUs.
    await f.db.insert(storeProductAttrValue).values({ productId: 1, unique: 'extra001', suk: '额外', type: 0 });
    const ambiguous = await f.snapshot(); await expect(legacy.productInfoApi(1)).rejects.toMatchObject({ status: 400 });
    expect(await f.snapshot()).toEqual(ambiguous);
  });

  it('retains fixed-content edit values through actual old helper reads and saves', async () => {
    const saved = await f.service.save(0, legacySaveBody({ product_type: 1, attrs: [legacySaveSku({ stock: 2, disk_info: 'UNCHANGED-FIXED' })] }), legacySaveActor());
    const info = (await legacy.productInfoApi(saved.id)).data.productInfo;
    expect(info.attr).toMatchObject({ disk_info: 'UNCHANGED-FIXED', virtual_list: [] });
    await legacy.productAddApi(oldEditorSaveBody(info));
    expect((await legacy.productInfoApi(saved.id)).data.productInfo.attr).toMatchObject({ disk_info: 'UNCHANGED-FIXED', stock: 2 });
  });

  it('keeps a valid large Unicode description editable without echoing a duplicate preview into the bounded POST', async () => {
    const description = `<p>${'中'.repeat(180000)}</p>`;
    await f.service.save(1, legacySaveBody({ description }), legacySaveActor());
    const info = (await legacy.productInfoApi(1)).data.productInfo;
    expect(info.description).toBe(description); expect(info).not.toHaveProperty('description_preview');
    const body = oldEditorSaveBody(info);
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(1024 * 1024);
    await legacy.productAddApi(body);
    expect((await legacy.productInfoApi(1)).data.productInfo.description).toBe(description);
  });

  it('refuses a large duplicated live form before returning a whole DTO the old form cannot resubmit', async () => {
    await f.db.insert(systemForm).values({ id: 7, status: 1, value: JSON.stringify([{ name: 'texts', value: 'x'.repeat(500000) }]) });
    await legacy.productAddApi({ id: 1, ...legacySaveBody({ system_form_id: 7, custom_form: [], description: 'x'.repeat(100000) }) });
    const before = await f.snapshot();
    await expect(legacy.productInfoApi(1)).rejects.toMatchObject({ status: 400, msg: expect.stringContaining('768 KiB') });
    expect(await f.snapshot()).toEqual(before);
  });
});
