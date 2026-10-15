import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { systemAdmin, systemRole } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { AdminProductCatalogReadService } from '@/services/admin/AdminProductCatalogReadService';
import { HttpApiException, ServiceUnavailableException } from '@/utils/errors';
import { seedSupplierOptions, supplierOptionsExpected, supplierOptionsFixture, supplierOptionsPassword,
  supplierOptionsSnapshot } from './helpers/adminProductSupplierOptions';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
type Envelope = { status: number; msg: string; data: unknown };
type AxiosConfig = { method?: string; headers: { toJSON(): Record<string, string> } };
type Legacy = { getSupplierList(query?: Record<string, unknown>): Promise<Envelope>;
  request: { defaults: { adapter: (config: AxiosConfig) => Promise<unknown> }; getUri(config: AxiosConfig): string } };
const env = { APP_KEY: 'supplier-selector-real-app-fixture', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as unknown as Env;

describe('genuine old supplier.js/request/Axios selector → real App/JWT/SQL', () => {
  const app = createApp(), tokens: Record<number, string> = {}, calls: URL[] = [];
  let f: Awaited<ReturnType<typeof supplierOptionsFixture>>, legacy: Legacy;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Supplier selector HTTP fixture forbids remote I/O'));
    f = await supplierOptionsFixture(); wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (let id = 100; id <= 111; id++) tokens[id] = (await createToken(id, 'admin', md5(supplierOptionsPassword), env.APP_KEY)).token;
    Reflect.set(globalThis, '__supplierSelectorToken', tokens[101]);
    const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: unknown) => values.set(key, String(value)), clear: () => values.clear() }; };
    vi.stubGlobal('sessionStorage', storage()); vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('window', { router: { replace: vi.fn() } });
    const php = resolve(import.meta.dirname, '../../../cinashop-php/view/admin/src');
    const require = createRequire(resolve(import.meta.dirname, '../../view/admin-ts/package.json'));
    const result = await build({ bundle: true, write: false, platform: 'node', format: 'cjs',
      stdin: { resolveDir: php, contents: `export {getSupplierList} from ${JSON.stringify(resolve(php, 'api/supplier.js'))}; export {default as request} from ${JSON.stringify(resolve(php, 'plugins/request/index.js'))};` },
      plugins: [{ name: 'supplier-selector-actual-old-transport-hosts', setup(plugin) {
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: resolve(php, 'plugins/request/index.js') }));
        plugin.onResolve({ filter: /^axios$/ }, () => ({ path: require.resolve('axios') }));
        plugin.onResolve({ filter: /^(?:@\/store|@\/libs\/util|@\/setting|view-design)$/ }, args => ({ path: args.path, namespace: 'supplier-selector-host' }));
        plugin.onLoad({ filter: /.*/, namespace: 'supplier-selector-host' }, args => ({ contents:
          args.path === '@/store' ? 'export default {dispatch(){}}' : args.path === '@/libs/util'
            ? 'export default {cookies:{get(){return globalThis.__supplierSelectorToken},kefuGet(){},remove(){}},log:{error(){}}}'
            : args.path === '@/setting' ? 'export default {apiBaseURL:"https://selector.local/adminapi",errorModalType:"Message",modalDuration:1}'
            : 'export const Message={error(){}},Notice={error(){}},LoadingBar={};' }));
      } }], logLevel: 'silent' });
    const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
    legacy = module.exports as Legacy;
    const { AxiosError } = require('axios') as { AxiosError: new (message: string, code: string, config: AxiosConfig, request: unknown, response: unknown) => Error };
    legacy.request.defaults.adapter = async config => {
      const url = new URL(legacy.request.getUri(config)), headers = config.headers.toJSON(); calls.push(url);
      const response = await app.request(url.href, { method: config.method?.toUpperCase() ?? 'GET', headers }, env);
      const value = { data: await response.json(), status: response.status, statusText: response.statusText,
        headers: Object.fromEntries(response.headers), config };
      if (response.status < 200 || response.status >= 300) throw new AxiosError('fixture App rejected transport', 'ERR_BAD_RESPONSE', config, undefined, value);
      return value;
    };
  }, 30000);
  beforeEach(async () => { await f.reset(); await seedSupplierOptions(f.db); calls.length = 0; Reflect.set(globalThis, '__supplierSelectorToken', tokens[101]); });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally {
    Reflect.deleteProperty(globalThis, '__supplierSelectorToken'); vi.unstubAllGlobals(); vi.restoreAllMocks(); await f?.close();
  } });
  const direct = (id = 101, query = '', method = 'GET') => app.request(`https://selector.local/adminapi/supplier/list${query ? `?${query}` : ''}`,
    { method, headers: { 'Authori-zation': `Bearer ${tokens[id]}` } }, env);

  it('executes the genuine old parameterless selector and consumes the exact unpaginated source envelope', async () => {
    const before = await supplierOptionsSnapshot(f.db), result = await legacy.getSupplierList();
    expect(result).toEqual({ status: 200, msg: 'ok', data: supplierOptionsExpected });
    expect(calls).toHaveLength(1); expect(calls[0].pathname).toBe('/adminapi/supplier/list'); expect(calls[0].search).toBe('');
    expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
    const response = await direct(); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await (await direct(101, 'page=2&limit=1&is_show=1&keywords=missing&page=999')).json()).toMatchObject({ data: supplierOptionsExpected });
  });

  it('admits only live product readers through App auth, retaining the old Axios permission rejection', async () => {
    for (const id of [100, 101, 102, 103, 108, 109]) expect(await (await direct(id)).json()).toMatchObject({ status: 200, data: supplierOptionsExpected });
    for (const id of [104, 105, 106, 107, 110, 111]) expect((await (await direct(id)).json() as Envelope).status).not.toBe(200);
    Reflect.set(globalThis, '__supplierSelectorToken', tokens[104]);
    await expect(legacy.getSupplierList()).rejects.toMatchObject({ status: 400011 });
    const response = await app.request('https://selector.local/adminapi/supplier/list', {}, env);
    expect(await response.json()).toMatchObject({ status: 410000 });
  });

  it('rechecks real JWT password and role status, rejects oversized ignored query and exposes no write route or new alias', async () => {
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 1));
    expect(await (await direct()).json()).toMatchObject({ status: 400011 });
    await f.db.update(systemRole).set({ status: 1 }).where(eq(systemRole.id, 1));
    await f.db.update(systemAdmin).set({ pwd: 'rotated-password' }).where(eq(systemAdmin.id, 101));
    expect(await (await direct()).json()).toMatchObject({ status: 410001 });
    expect(await (await direct(103, `x=${'x'.repeat(257)}`)).json()).toMatchObject({ status: 400 });
    const before = await supplierOptionsSnapshot(f.db);
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await (await direct(103, '', method)).json() as Envelope).status).not.toBe(200);
    const alias = await app.request('https://selector.local/api/admin/supplier/list', { headers: { 'Authori-zation': `Bearer ${tokens[103]}` } }, env);
    expect((await alias.json() as Envelope).status).not.toBe(200);
    expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
  });

  it('rejects an actual 10001-option SQL result through the genuine old Axios interceptor with its readable capacity message', async () => {
    await f.exec("INSERT INTO system_supplier(id,admin_id,supplier_name) SELECT n,n+100000,'容量候选' FROM generate_series(100,10098) n");
    const before = await supplierOptionsSnapshot(f.db);
    await expect(legacy.getSupplierList()).rejects.toMatchObject({ status: 400, msg: '供应商完整选项超过10000项容量' });
    const response = await direct(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 400, data: null });
    expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
  }, 30000);

  it('keeps classified read conflicts and unavailable failures consumable by the old interceptor without swallowing unknown failures', async () => {
    const before = await supplierOptionsSnapshot(f.db);
    // Only the service failure is injected here. Native tests independently
    // exercise real revoked SELECT; App/JWT and the legacy transport stay real.
    const classified = vi.spyOn(AdminProductCatalogReadService.prototype, 'supplierOptions');
    try {
      for (const error of [new HttpApiException('受控读取冲突', 409, 409), new ServiceUnavailableException('受控读取权限不足')]) {
        classified.mockRejectedValueOnce(error);
        await expect(legacy.getSupplierList()).rejects.toMatchObject({ status: 400, msg: error.message });
      }
      classified.mockRejectedValueOnce(Error('unknown controlled read failure'));
      const response = await direct(); expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 500 });
    } finally { classified.mockRestore(); }
    expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
  });
});
