import { legacyAdminReferenceRoot } from './helpers/legacyAdminReference';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { storeProductRule, systemAdmin, systemRole, systemLog } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { productRuleFixture, seedRules, ruleBody } from './helpers/adminProductRules';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const env = { APP_KEY: 'rule-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
type RuleDTO = { id: number; type: number; relation_id: number; rule_name: string; rule_value: unknown;
  spec?: Array<{ value: string; detail: string[] }>; attr_name?: string; attr_value?: string[] };
type Envelope = { status: number; msg: string; data?: unknown };
type AdapterConfig = { method?: string; data?: BodyInit; headers: { toJSON(): Record<string, string> } };
type VueConsumer = {
  request: { defaults: Record<string, unknown>; getUri(config: AdapterConfig): string };
  apiProductRuleList(params: { page?: number; limit?: number; rule_name?: string }): Promise<{ list: RuleDTO[]; count: number; page: number; limit: number }>;
  apiProductRuleDetail(id: number): Promise<RuleDTO>;
  apiProductRuleSave(id: number, body: { rule_name: string; spec: Array<{ value: string; detail: string[] }> }): Promise<{ id: number }>;
  apiProductRuleDelete(id: number): Promise<null>;
};
type LegacyConsumer = {
  modalSure: (this: unknown, config: unknown) => Promise<Envelope>;
  index: { methods: { del: (this: unknown, row: { id: number }, title: string, index: number) => void } };
  ruleInfoApi: (id: number) => Promise<{ data: { info: RuleDTO } }>;
  ruleAddApi: (data: RuleDTO, id: number) => Promise<Envelope>;
};

describe('actual rule App routes with JWT, SQL, old modal consumer and production Vue Axios', () => {
  const app = createApp(), tokens: Record<number, string> = {};
  let f: Awaited<ReturnType<typeof productRuleFixture>>, consumer: VueConsumer, legacy: LegacyConsumer;
  const modernPaths: string[] = [], oldRequests: Array<{ path: string; data: unknown }> = [];
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Rule HTTP fixture forbids external I/O'));
    f = await productRuleFixture();
    wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [100, 101, 102, 103, 104, 105, 106, 107]) {
      tokens[id] = (await createToken(id, 'admin', md5('rule-fixture-password'), env.APP_KEY)).token;
    }
    Reflect.set(globalThis, '__ruleHttpToken', tokens[101]);
    const adminRoot = resolve(import.meta.dirname, '../../view/admin-ts');
    const result = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', external: ['axios'],
      stdin: { contents: `export * from ${JSON.stringify(resolve(adminRoot, 'src/api/productMetadata.ts'))}; export {default as request} from ${JSON.stringify(resolve(adminRoot, 'src/utils/request.ts'))};`,
        resolveDir: adminRoot, sourcefile: 'rule-http-consumer.ts' },
      define: { 'import.meta.env.DEV': 'false' }, plugins: [{ name: 'rule-production-auth-fixture', setup(plugin) {
        plugin.onResolve({ filter: /^@\/utils\/request$/ }, () => ({ path: resolve(adminRoot, 'src/utils/request.ts') }));
        plugin.onResolve({ filter: /^@\/utils\/auth$/ }, () => ({ path: 'auth', namespace: 'rule-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'rule-fixture' }, () => ({ contents: 'export function getToken(){return globalThis.__ruleHttpToken;} export function clearAuth(){throw Error("Unexpected consumer authentication expiry");}', loader: 'js' }));
      } }] });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(resolve(adminRoot, 'package.json')), module, module.exports);
    consumer = module.exports as VueConsumer;
    consumer.request.defaults.adapter = async (config: AdapterConfig) => {
      const url = new URL(consumer.request.getUri(config), 'http://localhost');
      modernPaths.push(url.pathname); return dispatch(url, config);
    };

    // Execute the actual PHP-era page's del method, modalSure and tableDelApi.
    // Only Axios transport/auth and Vuex/component construction are fixture boundaries.
    const legacyRequest = createRequire(resolve(adminRoot, 'package.json'))('axios').create({
      baseURL: '/adminapi', headers: { 'Authori-zation': `Bearer ${tokens[101]}` },
    }) as { defaults: Record<string, unknown>; getUri(config: AdapterConfig): string;
      interceptors: { response: { use(callback: (response: { data: Envelope }) => unknown): void } } };
    legacyRequest.interceptors.response.use(response => {
      if (response.data.status !== 200) return Promise.reject(response.data);
      return response.data;
    });
    legacyRequest.defaults.adapter = async (config: AdapterConfig) => {
      const url = new URL(legacyRequest.getUri(config), 'http://localhost');
      oldRequests.push({ path: url.pathname, data: config.data });
      return dispatch(url, config as AdapterConfig);
    };
    Reflect.set(globalThis, '__ruleLegacyRequest', legacyRequest);
    const phpAdminRoot = legacyAdminReferenceRoot();
    const oldResult = await build({ bundle: true, write: false, platform: 'node', format: 'cjs',
      stdin: { contents: `export {modalSure} from ${JSON.stringify(resolve(phpAdminRoot, 'utils/public.js'))}; export {default as index} from ${JSON.stringify(resolve(phpAdminRoot, 'pages/product/productAttr/index.vue'))}; export {ruleInfoApi,ruleAddApi} from ${JSON.stringify(resolve(phpAdminRoot, 'api/product.js'))};`,
        resolveDir: phpAdminRoot, sourcefile: 'rule-old-consumer.js' },
      plugins: [{ name: 'rule-actual-old-consumer-fixtures', setup(plugin) {
        plugin.onResolve({ filter: /^@\/api\/(product|common)$/ }, args => ({ path: resolve(phpAdminRoot, `api/${args.path.split('/').at(-1)}.js`) }));
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: 'request', namespace: 'rule-old-fixture' }));
        plugin.onResolve({ filter: /^vuex$/ }, () => ({ path: 'vuex', namespace: 'rule-old-fixture' }));
        plugin.onResolve({ filter: /^\.\/addAttr$/ }, () => ({ path: 'component', namespace: 'rule-old-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'rule-old-fixture' }, args => ({ contents:
          args.path === 'request' ? 'export default globalThis.__ruleLegacyRequest;' : args.path === 'vuex' ? 'export const mapState=()=>({});' : 'export default {};', loader: 'js' }));
        plugin.onLoad({ filter: /\.vue$/ }, async args => {
          const source = await readFile(args.path, 'utf8'), script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
          if (!script) throw Error('Missing actual legacy rule page script');
          return { contents: script, loader: 'js', resolveDir: resolve(phpAdminRoot, 'pages/product/productAttr') };
        });
      } }] });
    const oldModule = { exports: {} };
    new Function('module', 'exports', oldResult.outputFiles[0].text)(oldModule, oldModule.exports);
    legacy = oldModule.exports as LegacyConsumer;
  }, 30000);
  beforeEach(async () => {
    await f.reset(); await seedRules(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_rule','id'),1000,false)");
    modernPaths.length = 0; oldRequests.length = 0;
  }, 30000);
  afterAll(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally {
      Reflect.deleteProperty(globalThis, '__ruleHttpToken'); Reflect.deleteProperty(globalThis, '__ruleLegacyRequest');
      vi.restoreAllMocks(); await f?.close();
    }
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
  async function dispatch(url: URL, config: AdapterConfig) {
    const before = counters(), response = await app.request(url.pathname + url.search,
      { method: config.method?.toUpperCase(), headers: config.headers.toJSON(), body: config.data }, env);
    boundary(response, before);
    return { data: await response.json<Envelope>(), status: response.status, statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()), config, request: {} };
  }
  async function raw(method: string, path: string, body?: BodyInit, id = 101, headers: Record<string, string> = {}) {
    const before = counters(), response = await app.request(path.startsWith('/') ? path : `/adminapi/${path}`,
      { method, headers: { ...(id ? { 'Authori-zation': `Bearer ${tokens[id]}` } : {}), 'Content-Type': 'application/json', ...headers }, body }, env);
    boundary(response, before); return response;
  }
  async function request(method: string, path: string, body?: unknown, id = 101) {
    const response = await raw(method, path, body === undefined ? undefined : JSON.stringify(body), id);
    return { response, body: await response.json<Envelope>() };
  }
  async function snapshot() {
    return { rules: await f.db.select().from(storeProductRule).orderBy(storeProductRule.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }

  it('serves five old contracts and both modern prefixes with their raw/parsed values and pagination differences', async () => {
    const rawValue = JSON.stringify(ruleBody().spec);
    expect((await request('GET', 'product/product/rule?page=2&limit=1')).body.data).toEqual({ count: 2,
      list: [{ id: 10, type: 0, relation_id: 0, rule_name: '服装', rule_value: rawValue,
        attr_name: '颜色,尺码', attr_value: ['红,蓝', 'S,M'] }] });
    const templates = (await request('GET', 'product/product/get_rule')).body.data as RuleDTO[];
    expect(templates.map(row => row.id)).toEqual([11, 10]);
    expect(templates[1].rule_value).toEqual(ruleBody().spec); expect(templates[1]).not.toHaveProperty('spec');
    expect((await request('GET', 'product/product/rule/10')).body.data).toEqual({ info: {
      id: 10, type: 0, relation_id: 0, rule_name: '服装', rule_value: rawValue, spec: ruleBody().spec,
    } });
    for (const prefix of ['/adminapi/product', '/api/admin/product']) {
      expect((await request('GET', `${prefix}/rule?page=2&limit=1`)).body.data).toMatchObject({
        count: 2, page: 2, limit: 1, list: [{ id: 10, spec: ruleBody().spec }],
      });
      expect((await request('GET', `${prefix}/rule/10`)).body.data).toMatchObject({ info: { spec: ruleBody().spec, attr_name: '颜色,尺码' } });
      expect((await request('GET', `${prefix}/get_rule`)).body.data).toMatchObject([
        { id: 11, rule_value: [{ value: '包装', detail: ['盒'] }] }, { id: 10, rule_value: ruleBody().spec },
      ]);
    }
  });

  it('executes old saves with exact omitted-data success and full original detail echo for mutable edits', async () => {
    expect((await request('POST', 'product/product/rule/0', ruleBody({ rule_name: 'HTTP旧规格' }))).body)
      .toEqual({ status: 200, msg: '保存成功!' });
    const [created] = await f.db.select().from(storeProductRule).where(eq(storeProductRule.ruleName, 'HTTP旧规格'));
    const echo = (await request('GET', `product/product/rule/${created.id}`)).body.data as { info: RuleDTO };
    expect((await request('POST', `product/product/rule/${created.id}`, { ...echo.info,
      spec: [{ value: '材质', detail: ['钢'] }] })).body).toEqual({ status: 200, msg: '保存成功!' });
    expect((await request('DELETE', `product/product/rule/delete/${created.id}`, { ids: '' })).body)
      .toEqual({ status: 200, msg: '删除成功!' });
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row => JSON.parse(row.action).operation))
      .toEqual(['create', 'update', 'delete']);
  });

  it('runs actual PHP-era rule APIs and the actual index del → modalSure → tableDelApi Axios empty-body chain', async () => {
    const detail = await legacy.ruleInfoApi(11);
    expect(detail.data.info).not.toHaveProperty('attr_name');
    expect(await legacy.ruleAddApi({ ...detail.data.info, rule_name: '旧编辑器回显', spec: [{ value: '袋', detail: ['纸'] }] }, 11))
      .toEqual({ status: 200, msg: '保存成功!' });
    const confirm = vi.fn((config: { onOk(): void }) => config.onOk()), remove = vi.fn(), reload = vi.fn();
    let complete!: (message: string) => void, fail!: (reason: unknown) => void;
    const finished = new Promise<string>((resolve, reject) => { complete = resolve; fail = reject; });
    const context = { $modalSure(config: unknown) { return legacy.modalSure.call({ $Modal: { confirm, remove } }, config); },
      $Message: { success: complete, error: fail }, getDataList: reload };
    legacy.index.methods.del.call(context, { id: 11 }, '删除规格', 0);
    expect(await finished).toBe('删除成功!');
    expect(confirm).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce(); expect(reload).toHaveBeenCalledOnce();
    expect(oldRequests.map(row => row.path)).toEqual(['/adminapi/product/product/rule/11',
      '/adminapi/product/product/rule/11', '/adminapi/product/product/rule/delete/11']);
    expect(oldRequests[2].data).toBe('');
    expect(await f.db.select().from(storeProductRule).where(eq(storeProductRule.id, 11))).toEqual([]);
  });

  it('executes actual compiled modern Vue APIs and request-layer Axios against IDs, expanded DTOs and null deletes', async () => {
    expect(await consumer.apiProductRuleList({ page: 2, limit: 1 })).toMatchObject({ count: 2,
      page: 2, limit: 1, list: [{ id: 10, spec: ruleBody().spec }] });
    const input = { rule_name: 'Vue现代规格', spec: [{ value: '材质', detail: ['钢', '木'] }] };
    const created = await consumer.apiProductRuleSave(0, input);
    expect(created.id).toBe(1000);
    expect(await consumer.apiProductRuleDetail(created.id)).toMatchObject({ ...input, id: created.id,
      attr_name: '材质', attr_value: ['钢,木'], rule_value: JSON.stringify(input.spec) });
    expect(await consumer.apiProductRuleSave(created.id, { ...input, rule_name: 'Vue现代编辑' })).toEqual(created);
    expect(await consumer.apiProductRuleDelete(created.id)).toBeNull();
    expect(modernPaths).toEqual(['/adminapi/product/rule', '/adminapi/product/rule/0',
      `/adminapi/product/rule/${created.id}`, `/adminapi/product/rule/${created.id}`, `/adminapi/product/rule/delete/${created.id}`]);
    for (const prefix of ['/adminapi/product', '/api/admin/product']) {
      const result = await request('POST', `${prefix}/rule/0`, ruleBody({ rule_name: `现代${prefix}` }));
      expect(result.body).toMatchObject({ status: 200, msg: '保存成功', data: { id: expect.any(Number) } });
      const id = (result.body.data as { id: number }).id;
      expect((await request('DELETE', `${prefix}/rule/delete/${id}`)).body).toEqual({ status: 200, msg: '删除成功', data: null });
    }
  });

  it('admits exact 99 and numeric read APIs while anonymous/unrelated/wildcard580/read-only mutations fail', async () => {
    const before = await snapshot();
    for (const id of [102, 105, 106]) {
      for (const path of ['product/product/rule', 'product/product/get_rule', 'product/product/rule/11',
        'product/rule', '/api/admin/product/rule/11']) expect((await request('GET', path, undefined, id)).body.status).toBe(200);
      expect((await request('POST', 'product/product/rule/0', ruleBody(), id)).body.status).toBe(400011);
      expect((await request('DELETE', 'product/rule/delete/11', undefined, id)).body.status).toBe(400011);
    }
    for (const id of [103, 107]) expect((await request('GET', 'product/product/rule', undefined, id)).body.status).toBe(400011);
    const opened = wiring.open.mock.calls.length;
    for (const [method, path, body] of [['GET', 'product/product/rule', undefined], ['GET', 'product/product/get_rule', undefined],
      ['GET', 'product/product/rule/11', undefined], ['POST', 'product/product/rule/0', ruleBody()],
      ['DELETE', 'product/product/rule/delete/11', undefined]] as const) {
      expect((await request(method, path, body, 0)).body).toMatchObject({ status: 410000, data: null });
    }
    expect(wiring.open.mock.calls.length).toBe(opened); expect(await snapshot()).toEqual(before);
    expect((await request('POST', 'product/product/rule/0', ruleBody({ rule_name: '数字菜单规格' }), 104)).body.status).toBe(200);
    expect((await request('DELETE', 'product/product/rule/delete/1000', undefined, 104)).body.status).toBe(200);
  });

  it('preserves the PHP falsy string-name refusal while the existing modern name contract accepts zero', async () => {
    const before = await snapshot();
    expect((await request('POST', 'product/product/rule/0', ruleBody({ rule_name: '0' }))).body)
      .toMatchObject({ status: 400, msg: '请输入分类名称' });
    expect(await snapshot()).toEqual(before);
    expect((await request('POST', 'product/rule/0', ruleBody({ rule_name: '0' }))).body)
      .toEqual({ status: 200, msg: '保存成功', data: { id: 1000 } });
    expect((await f.db.select().from(storeProductRule).where(eq(storeProductRule.id, 1000)))[0]?.ruleName).toBe('0');
  });

  it('rejects foreign rows, forged echoes, repeated/unknown queries and malformed canonical paths without effects', async () => {
    const before = await snapshot(), detail = (await request('GET', 'product/product/rule/11')).body.data as { info: RuleDTO };
    for (const id of [20, 21, 22, 30, 999]) {
      expect((await request('GET', `product/product/rule/${id}`)).body.status).not.toBe(200);
      expect((await request('POST', `product/rule/${id}`, ruleBody())).body.status).not.toBe(200);
      expect((await request('DELETE', `/api/admin/product/rule/delete/${id}`)).body.status).not.toBe(200);
    }
    for (const [method, path, body] of [['GET', 'product/product/rule?page=1&page=2', undefined],
      ['GET', 'product/rule?rule_name=a&rule_name=b', undefined], ['GET', 'product/rule?limit=101', undefined],
      ['GET', 'product/product/get_rule?page=1', undefined], ['GET', 'product/product/rule/11?id=11', undefined],
      ['GET', 'product/product/rule/01', undefined], ['GET', 'product/product/rule/0', undefined],
      ['POST', 'product/product/rule/2147483648', ruleBody()], ['POST', 'product/product/rule/0?id=0', ruleBody()],
      ['DELETE', 'product/rule/delete/11?id=11', undefined], ['GET', 'product/rule?type=0', undefined],
      ['POST', 'product/product/rule/11', { ...detail.info, id: 10 }],
      ['POST', 'product/product/rule/11', { ...detail.info, type: 2 }],
      ['POST', 'product/product/rule/11', { ...detail.info, rule_value: '[]' }],
      ['POST', 'product/rule/0', ruleBody({ unknown: true })]] as const) {
      expect((await request(method, path, body)).body.status, path).not.toBe(200);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('requires real empty deletion bodies, accepts only the legacy empty-ids compatibility and rejects malformed bodies', async () => {
    const before = await snapshot();
    for (const body of [null, {}, [], { ids: '11' }, { ids: '', unknown: true }]) {
      expect((await request('DELETE', 'product/product/rule/delete/11', body)).body.status).not.toBe(200);
    }
    for (const body of [null, {}, { ids: '' }]) expect((await request('DELETE', 'product/rule/delete/11', body)).body.status).not.toBe(200);
    expect(await (await raw('DELETE', 'product/product/rule/delete/11', '{')).json()).toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
    expect(await (await raw('DELETE', 'product/product/rule/delete/11', '')).json()).toEqual({ status: 200, msg: '删除成功!' });
  });

  it('rejects invalid UTF8/JSON and declared or streaming bodies above 64 KiB and closes each opened SQL session', async () => {
    const before = await snapshot();
    for (const bytes of ['{', '', new Uint8Array([0xff])]) {
      expect(await (await raw('POST', 'product/product/rule/0', bytes)).json()).toMatchObject({ status: 400 });
    }
    for (const body of [null, [], ruleBody({ rule_name: 'bad\u0000name' }),
      ruleBody({ spec: [{ value: '\ud800', detail: ['1'] }] })]) expect((await request('POST', 'product/rule/0', body)).body.status).toBe(400);
    expect(await (await raw('POST', 'product/rule/0', '{}', 101, { 'Content-Length': '65537' })).json()).toMatchObject({ status: 400 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65537)); },
      cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const beforeCounters = counters();
    const response = await app.request(new Request('http://localhost/adminapi/product/product/rule/0', { method: 'POST',
      headers: { 'Authori-zation': `Bearer ${tokens[101]}`, 'Content-Type': 'application/json' },
      body: stream, duplex: 'half' } as RequestInit), undefined, env);
    boundary(response, beforeCounters); expect(await response.json()).toMatchObject({ status: 400 }); expect(cancelled).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('revalidates revoked roles, changed credentials, foreign account identity and JWT expiry without catalog changes', async () => {
    const before = await snapshot();
    await f.db.update(systemRole).set({ rules: 'user.view' }).where(eq(systemRole.id, 1));
    expect((await request('POST', 'product/product/rule/0', ruleBody())).body.status).toBe(400011);
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 102));
    expect((await request('GET', 'product/rule', undefined, 102)).body.status).not.toBe(200);
    await f.db.update(systemAdmin).set({ adminType: 4, relationId: 20 }).where(eq(systemAdmin.id, 100));
    expect((await request('GET', 'product/product/get_rule', undefined, 100)).body.status).not.toBe(200);
    const expired = await createToken(105, 'admin', md5('rule-fixture-password'), env.APP_KEY,
      'cinashop', Math.floor(Date.now() / 1000) - 7 * 24 * 3600 - 5);
    expect(await (await raw('GET', 'product/rule', undefined, 105, { 'Authori-zation': `Bearer ${expired.token}` })).json())
      .toMatchObject({ status: 410001, data: null });
    expect(await snapshot()).toEqual(before);
  });

  it('does not report success for create/update/delete when SQL skips the audit receipt', async () => {
    const before = await snapshot();
    await f.exec("CREATE FUNCTION skip_rule_http_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_rule_http_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_rule_http_audit()");
    for (const [method, path, body] of [['POST', 'product/product/rule/0', ruleBody()],
      ['POST', 'product/rule/11', ruleBody()], ['DELETE', '/api/admin/product/rule/delete/11', undefined]] as const) {
      expect((await request(method, path, body)).body.status).not.toBe(200);
    }
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER skip_rule_http_audit ON system_log');
  });

  it('serves HEAD for legacy and both modern list/detail/selector contracts with no response body or effects', async () => {
    const before = await snapshot();
    for (const path of ['product/product/rule', 'product/product/get_rule', 'product/product/rule/11',
      'product/rule', 'product/get_rule', 'product/rule/11', '/api/admin/product/rule',
      '/api/admin/product/get_rule', '/api/admin/product/rule/11']) {
      const response = await raw('HEAD', path, undefined, 105);
      expect(response.status, path).toBe(200); expect(await response.text()).toBe('');
    }
    expect(await snapshot()).toEqual(before);
  });
});
