import { legacyAdminReferenceRoot } from './helpers/legacyAdminReference';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { adminProductModerationTime, normalizeAdminProductModerationInput } from '@/services/admin/AdminProductModerationInput';
import { storeProductAttrValue, systemAdmin, systemLog, systemMenus, systemRole } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { moderationActor, moderationBody, moderationFixture, moderationRows, moderationSnapshot, seedModeration } from './helpers/adminProductModeration';
import { resetStockSequences } from './helpers/adminProductStocks';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const env = { APP_KEY: 'moderation-http-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as unknown as Env;
type Envelope = { status: number; msg: string; data: unknown };

describe('Admin product review source contracts and complete SQL transaction', () => {
  let f: Awaited<ReturnType<typeof moderationFixture>>;
  beforeAll(async () => { f = await moderationFixture(); }, 30000);
  beforeEach(async () => { await f.reset(); await seedModeration(f.db); await resetStockSequences(f.exec); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Moderation contracts forbid remote I/O')); }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });

  it('returns exact ordinary-SKU warning, orphan/no-parent behavior and no data or audit changes', async () => {
    const before = await moderationSnapshot(f.db);
    expect(await f.service.getVerify(10, moderationActor(102))).toEqual({ verify: 1 });
    expect(await f.service.getVerify(999, moderationActor(102))).toEqual({ verify: 1 });
    expect(await f.service.getVerify(998, moderationActor(102))).toEqual({ verify: 0 });
    expect(await f.service.getVerify(50, moderationActor(102))).toEqual({ verify: 0 });
    expect(await moderationSnapshot(f.db)).toEqual(before);
    await f.db.update(storeProductAttrValue).set({ settlePrice: '12.00' }).where(eq(storeProductAttrValue.id, 11));
    // Retired ordinary equality is not a warning; the below-settlement type=1
    // row never participates, and parent/main prices are not compared.
    expect(await f.service.getVerify(10, moderationActor())).toEqual({ verify: 0 });
    await f.db.update(storeProductAttrValue).set({ settlePrice: '4.01' }).where(eq(storeProductAttrValue.id, 13));
    expect(await f.service.getVerify(10, moderationActor())).toEqual({ verify: 1 });
  });

  it('makes the conservative physical-row warning explicit for duplicate suk instead of unordered PHP key overwrite', async () => {
    await f.db.update(storeProductAttrValue).set({ suk: '相同规格', price: '12.00', settlePrice: '12.01' }).where(eq(storeProductAttrValue.id, 11));
    await f.db.update(storeProductAttrValue).set({ suk: '相同规格', price: '15.00', settlePrice: '1.00' }).where(eq(storeProductAttrValue.id, 12));
    const before = await moderationSnapshot(f.db);
    expect(await f.service.getVerify(10, moderationActor())).toEqual({ verify: 1 });
    expect(await moderationSnapshot(f.db)).toEqual(before);
  });

  it('builds both exact legacy form field/control/action contracts without requiring a current parent', async () => {
    const before = await moderationSnapshot(f.db), actor = moderationActor(102);
    const reason = (title: string, message: string) => ({ type: 'input', field: 'refusal', title, value: '', props: { type: 'textarea', placeholder: message, maxlength: 255 },
      validate: [{ type: 'string', trigger: 'change', message, required: true }] });
    expect(await f.service.form(998, 'verify', actor)).toEqual({ title: '商品审核', action: 'product/product/set_verify/998', method: 'POST', rules: [
      { type: 'radio', field: 'is_verify', title: '审核状态', value: 1, options: [{ value: 1, label: '通过' }, { value: -1, label: '拒绝' }],
        control: [{ value: -1, rule: [reason('拒绝原因', '请输入拒绝原因')] }] },
    ] });
    expect(await f.service.form(998, 'remove', actor)).toEqual({ title: '强制下架', action: 'product/product/set_verify/998', method: 'POST', rules: [
      { type: 'hidden', field: 'is_verify', value: '-2' }, reason('下架原因', '请输入下架原因'),
    ] });
    expect(await moderationSnapshot(f.db)).toEqual(before);
  });

  it('applies source defaults, ISO DatePicker and Shanghai forms while ignoring redundant body id and retaining unscheduled is_show2', async () => {
    expect(normalizeAdminProductModerationInput({ id: { any: 'discarded like PHP getMore' } })).toEqual({ isVerify: 1, refusal: '', isShow: 0, autoOnTime: 0 });
    const utc = '2026-11-01T04:30:00.123Z', local = '2026-11-01 12:30:00';
    expect(adminProductModerationTime(utc)).toBe(Date.UTC(2026, 10, 1, 4, 30) / 1000);
    expect(adminProductModerationTime(local)).toBe(adminProductModerationTime(utc));
    expect(adminProductModerationTime('2026-11-01 12:30')).toBe(adminProductModerationTime(utc));
    expect(normalizeAdminProductModerationInput({ is_verify: '-1', refusal: '保留原文本 ', is_show: '1', auto_on_time: local })).toEqual({ isVerify: -1, refusal: '保留原文本 ', isShow: 0, autoOnTime: adminProductModerationTime(utc) });
    expect(normalizeAdminProductModerationInput({ is_show: '2', auto_on_time: '' }).isShow).toBe(2);
    for (const zero of [undefined, null, '', 0, '0']) expect(adminProductModerationTime(zero)).toBe(0);
    const before = await moderationSnapshot(f.db);
    for (const body of [null, [], { is_verify: 0 }, { is_verify: '01' }, { is_verify: 2 }, { is_show: -1 }, { is_show: 3 }, { refusal: 2 }, { refusal: 'a'.repeat(256) },
      { refusal: '\u0000' }, { refusal: '\ud800' }, { is_verify: -1, refusal: ' \n ' }, { is_verify: -2, refusal: '' }, { auto_on_time: 'tomorrow' },
      { auto_on_time: '2026-02-29 12:00:00' }, { auto_on_time: '2026-11-01T04:30:00+00:00' }, { auto_on_time: '2039-01-01T00:00:00Z' },
      { auto_on_time: '1970-01-01 00:00:00' }, { auto_on_time: true }, { auto_on_time: 123 }, { extra: 1 }]) await expect(f.service.save(10, body, moderationActor())).rejects.toThrow();
    expect(await moderationSnapshot(f.db)).toEqual(before);
  });

  it('atomically writes precisely four fields, invalidates every status1 cart and preserves SKU/relation/child/order data plus prior full audit', async () => {
    const before = await moderationSnapshot(f.db), prior = (await moderationRows(f.db)).product;
    await f.service.save(10, moderationBody(1, 1), moderationActor());
    const after = await moderationSnapshot(f.db), rows = await moderationRows(f.db);
    expect(rows.product).toEqual({ ...prior, isVerify: 1, refusal: '', isShow: 1, autoOnTime: 0 });
    expect(rows.carts.map(row => [row.id, row.status])).toEqual([[201, 0], [202, 0], [203, 2], [205, 0]]);
    const allBefore = before.storeCart as Array<{ id: number; productId: number; status: number }>;
    expect(after.storeCart).toEqual(allBefore.map(row => row.productId === 10 && row.status === 1 ? { ...row, status: 0 } : row));
    expect((after.storeProduct as Array<{ id: number }>).filter(row => row.id !== 10)).toEqual((before.storeProduct as Array<{ id: number }>).filter(row => row.id !== 10));
    for (const key of Object.keys(before).filter(key => !['storeProduct', 'storeCart', 'systemLog'].includes(key))) expect(after[key]).toEqual(before[key]);
    const audits = await f.db.select().from(systemLog).orderBy(systemLog.id); expect(audits).toHaveLength(2); expect(audits[0]).toEqual((before.systemLog as unknown[])[0]);
    const audit = audits[1]; expect(Object.keys(audit)).toHaveLength(12);
    expect(audit).toEqual({ id: 1000, storeId: 0, merchantId: 0, adminName: '', ip: '', adminId: 101, path: 'product/product/set_verify/10', page: '商品审核', method: 'POST', type: 'product_moderation',
      action: JSON.stringify({ operation: 'set_verify', productId: 10, is_verify: 1, refusal: '', is_show: 1, auto_on_time: 0 }), addTime: expect.any(Number) });
  });

  it('retains refusal/is_show anomalies, all source owner/product/deletion states and timestamp-forced hide without rewriting descendants', async () => {
    await f.service.save(10, { is_verify: -1, refusal: '拒绝仍保留传入上架标志', is_show: 1 }, moderationActor());
    expect((await moderationRows(f.db)).product).toMatchObject({ isVerify: -1, isShow: 1, autoOnTime: 0 });
    await f.service.save(10, { is_verify: 1, is_show: 2, auto_on_time: '' }, moderationActor());
    expect((await moderationRows(f.db)).product).toMatchObject({ isVerify: 1, isShow: 2, autoOnTime: 0 });
    await f.service.save(10, { is_verify: 1, is_show: 1, auto_on_time: '2026-11-01T04:30:00Z' }, moderationActor());
    expect((await moderationRows(f.db)).product).toMatchObject({ isVerify: 1, isShow: 0, autoOnTime: Date.UTC(2026, 10, 1, 4, 30) / 1000, autoOffTime: 1700000123 });
    for (const id of [20, 30, 40, 50, 60]) {
      const prior = (await moderationRows(f.db, id)).product;
      await f.service.save(id, { is_verify: '-2', refusal: '强制下架源合同', id: 10 }, moderationActor());
      expect((await moderationRows(f.db, id)).product).toEqual({ ...prior, isVerify: -2, refusal: '强制下架源合同', isShow: 0, autoOnTime: 0 });
    }
    const beforeMissing = await moderationSnapshot(f.db);
    await expect(f.service.save(998, {}, moderationActor())).rejects.toThrow('商品不存在');
    expect(await moderationSnapshot(f.db)).toEqual(beforeMissing);
  });

  it('separates genuine view/manage and denies all unseeded numerical aliases in single/batch/opaque permission paths', async () => {
    const permission = new AdminPermissionService(f.container);
    const claims = await f.db.select().from(systemMenus).where(eq(systemMenus.authType, 2));
    for (const row of claims.filter(row => row.id >= 1001)) expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
    const single = await Promise.all([1001, 1002, 1003, 1004, 1005].map(id => permission.resolveRulePermissionKeys(String(id))));
    expect(single).toEqual([[], [], [], [], []]);
    expect(await permission.resolveManyRulePermissionKeys(['1001', '1002', '1003', '1004', '1005'])).toEqual(single);
    for (const name of ['verify', 'remove', 'get_verify']) { expect(requiredAdminPermission('GET', `/adminapi/product/product/${name}/10`)).toBe('product.view'); expect(requiredAdminPermission('POST', `/adminapi/product/product/${name}/10`)).toBeNull(); }
    expect(requiredAdminPermission('POST', '/adminapi/product/product/set_verify/10')).toBe('product.manage');
    expect(requiredAdminPermission('GET', '/adminapi/product/product/set_verify/10')).toBeNull();
    for (const name of ['verify', 'remove', 'get_verify', 'set_verify']) expect(requiredAdminPermission('POST', `/adminapi/product/product/${name}/01`)).toBeNull();
    const before = await moderationSnapshot(f.db);
    for (const actor of [103, 105, 109, 110, 111, 112, 113, 114]) await expect(f.service.getVerify(10, moderationActor(actor))).rejects.toThrow();
    expect(await f.service.getVerify(10, moderationActor(108))).toEqual({ verify: 1 });
    for (const actor of [102, 103, 104, 105, 107, 108, 109, 110, 111, 112, 113, 114]) await expect(f.service.save(10, moderationBody(), moderationActor(actor))).rejects.toThrow();
    expect(await moderationSnapshot(f.db)).toEqual(before);
    // Existing genuine editor seed105 already confers the modern manage
    // capability. This is not evidence of a numeric seed for set_verify.
    await f.service.save(10, {}, moderationActor(106));
  });

  it('refuses current revoked/foreign/expired/password-changed Admin authority without changes', async () => {
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1));
    const before = await moderationSnapshot(f.db); await expect(f.service.save(10, {}, moderationActor())).rejects.toThrow('权限'); expect(await moderationSnapshot(f.db)).toEqual(before);
    await f.db.update(systemRole).set({ rules: 'product.manage' }).where(eq(systemRole.id, 1));
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 101));
    const changed = await moderationSnapshot(f.db); await expect(f.service.getVerify(10, moderationActor())).rejects.toThrow('凭据'); await expect(f.service.save(10, {}, moderationActor())).rejects.toThrow('凭据');
    await expect(f.service.save(10, {}, { ...moderationActor(), expiresAt: Math.floor(Date.now() / 1000) - 1 })).rejects.toThrow('过期'); expect(await moderationSnapshot(f.db)).toEqual(changed);
  });

  it('rolls back complete product/cart/SKU/relation/audit suppression, rewrites, post-audit side effects and inserted target phantoms', async () => {
    const cases = [
      ['store_product', 'BEFORE UPDATE', 'RETURN NULL'],
      ['store_product', 'BEFORE UPDATE', 'NEW.stock:=NEW.stock+1; RETURN NEW'],
      ['store_cart', 'BEFORE UPDATE', 'RETURN NULL'],
      ['store_cart', 'BEFORE UPDATE', 'NEW.cart_num:=NEW.cart_num+1; RETURN NEW'],
      ['system_log', 'BEFORE INSERT', 'RETURN NULL'],
      ['system_log', 'BEFORE INSERT', "NEW.ip:='rewritten'; RETURN NEW"],
      ['system_log', 'AFTER INSERT', 'UPDATE store_product SET stock=99 WHERE id=10; RETURN NEW'],
      ['system_log', 'AFTER INSERT', 'UPDATE store_product_attr_value SET price=99 WHERE id=11; RETURN NEW'],
      ['system_log', 'AFTER INSERT', 'UPDATE store_cart SET cart_num=99 WHERE id=202; RETURN NEW'],
      ['system_log', 'AFTER INSERT', 'UPDATE store_product_relation SET status=0 WHERE id=201; RETURN NEW'],
      ['system_log', 'AFTER INSERT', "INSERT INTO store_product_attr_value(product_id,\"unique\") VALUES(10,'phantom1'); RETURN NEW"],
      ['system_log', 'AFTER INSERT', 'INSERT INTO store_cart(product_id,status) VALUES(10,1); RETURN NEW'],
      ['system_log', 'AFTER INSERT', "IF pg_trigger_depth()=1 THEN INSERT INTO system_log(path,action) VALUES(NEW.path,'extra'); END IF; RETURN NEW"],
      ['system_log', 'AFTER INSERT', "UPDATE system_role SET rules='product.view' WHERE id=1; RETURN NEW"],
    ];
    for (const [table, timing, action] of cases) {
      const before = await moderationSnapshot(f.db);
      await f.exec(`CREATE FUNCTION moderation_trigger_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${action}; END $$; CREATE TRIGGER moderation_trigger_fixture ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION moderation_trigger_fixture()`);
      try { await expect(f.service.save(10, moderationBody(), moderationActor())).rejects.toThrow(); expect(await moderationSnapshot(f.db)).toEqual(before); }
      finally { await f.exec(`DROP TRIGGER moderation_trigger_fixture ON ${table}; DROP FUNCTION moderation_trigger_fixture()`); }
    }
  }, 30000);

  it('bounds complete physical SKU/cart sets without partial changes instead of silently truncating source data', async () => {
    await f.exec("INSERT INTO store_product_attr_value(id,product_id,\"unique\") SELECT 20000+n,10,'cap'||n FROM generate_series(1,10001) n");
    const before = await moderationSnapshot(f.db);
    await expect(f.service.getVerify(10, moderationActor())).rejects.toThrow('10000');
    await expect(f.service.save(10, {}, moderationActor())).rejects.toThrow('10000');
    expect(await moderationSnapshot(f.db)).toEqual(before);
  }, 30000);
});

describe('four genuine product review routes through actual App/JWT/SQL and old Axios API', () => {
  const app = createApp(), tokens: Record<number, string> = {}, calls: Array<{ method: string; path: string; body: unknown }> = [];
  let f: Awaited<ReturnType<typeof moderationFixture>>, old: { productGetVerifyApi(id: number): Promise<{ data: { verify: number } }>; productReviewApi(id: number, body: unknown): Promise<unknown>; forcedRemovalApi(id: number): Promise<{ data: { action: string } }> };
  beforeAll(async () => {
    f = await moderationFixture(); wiring.application.mockImplementation(() => f.container); wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (let id = 100; id <= 114; id++) tokens[id] = (await createToken(id, 'admin', md5('stock-fixture-password'), env.APP_KEY)).token;
    const require = createRequire(resolve(import.meta.dirname, '../../view/admin-ts/package.json'));
    const request = require('axios').create({ baseURL: '/adminapi', headers: { 'Authori-zation': `Bearer ${tokens[101]}` } });
    request.interceptors.response.use((response: { data: Envelope }) => response.data.status === 200 ? response.data : Promise.reject(response.data));
    request.defaults.adapter = async (config: { url: string; method: string; data?: string; headers: { toJSON(): Record<string, string> } }) => {
      const url = new URL(request.getUri(config), 'http://localhost'), method = config.method.toUpperCase();
      calls.push({ method, path: url.pathname, body: config.data ? JSON.parse(config.data) : undefined });
      const response = await app.request(url.pathname + url.search, { method, headers: config.headers.toJSON(), ...(config.data ? { body: config.data } : {}) }, env);
      return { data: await response.json(), status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), config, request: {} };
    };
    Reflect.set(globalThis, '__moderationLegacyRequest', request);
    const php = legacyAdminReferenceRoot();
    const compiled = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', stdin: { resolveDir: php,
      contents: `export {productGetVerifyApi,productReviewApi,forcedRemovalApi} from ${JSON.stringify(resolve(php, 'api/product.js'))};` },
      plugins: [{ name: 'actual-old-product-api', setup(plugin) {
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: 'request', namespace: 'moderation-source-transport' }));
        plugin.onLoad({ filter: /.*/, namespace: 'moderation-source-transport' }, () => ({ contents: 'export default globalThis.__moderationLegacyRequest;', loader: 'js' }));
      } }] });
    const module = { exports: {} }; new Function('module', 'exports', compiled.outputFiles[0].text)(module, module.exports); old = module.exports as typeof old;
  }, 30000);
  beforeEach(async () => { await f.reset(); await seedModeration(f.db); await resetStockSequences(f.exec); calls.length = 0; wiring.close.mockClear(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Moderation HTTP forbids remote transport')); }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { Reflect.deleteProperty(globalThis, '__moderationLegacyRequest'); await f?.close(); });
  async function raw(method: string, path: string, id = 101, body?: string | Uint8Array) {
    return app.request(path, { method, headers: { 'Authori-zation': `Bearer ${tokens[id]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }) }, env);
  }
  async function envelope(method: string, path: string, id = 101, body?: string) {
    const response = await raw(method, path, id, body); expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('pragma')).toBe('no-cache'); return response.json<Envelope>();
  }

  it('executes unchanged old preflight/confirm wire and forced-removal form action with path-authoritative redundant id', async () => {
    expect(await old.productGetVerifyApi(10)).toMatchObject({ status: 200, data: { verify: 1 } });
    const sourceBody = { id: 20, is_verify: 1, refusal: '', is_show: 2, auto_on_time: new Date('2026-11-01T04:30:00Z') };
    await old.productReviewApi(10, sourceBody);
    expect(calls).toEqual([{ method: 'GET', path: '/adminapi/product/product/get_verify/10', body: undefined },
      { method: 'POST', path: '/adminapi/product/product/set_verify/10', body: { ...sourceBody, auto_on_time: '2026-11-01T04:30:00.000Z' } }]);
    expect((await moderationRows(f.db)).product).toMatchObject({ isVerify: 1, isShow: 0, autoOnTime: Date.UTC(2026, 10, 1, 4, 30) / 1000 });
    expect((await moderationRows(f.db, 20)).product).toMatchObject({ isVerify: 1, isShow: 1 });
    const removal = await old.forcedRemovalApi(10); expect(removal.data.action).toBe('product/product/set_verify/10');
    expect(await envelope('POST', `/adminapi/${removal.data.action}`, 101, JSON.stringify({ is_verify: '-2', refusal: '下架原因' }))).toMatchObject({ status: 200, msg: '审核成功', data: [] });
    expect((await moderationRows(f.db)).product).toMatchObject({ isVerify: -2, isShow: 0, autoOnTime: 0 });
  });

  it('returns all three read contracts under true view and rejects absent/unproved writers with real live account/role/password checks', async () => {
    for (const id of [100, 101, 102, 104, 106, 107, 108]) for (const name of ['verify', 'remove', 'get_verify']) expect(await envelope('GET', `/adminapi/product/product/${name}/998`, id)).toMatchObject({ status: 200 });
    const before = await moderationSnapshot(f.db);
    for (const id of [102, 103, 104, 105, 107, 108, 109, 110, 111, 112, 113, 114]) expect(await envelope('POST', '/adminapi/product/product/set_verify/10', id, '{}')).not.toMatchObject({ status: 200 });
    expect(await moderationSnapshot(f.db)).toEqual(before);
    await f.db.update(systemAdmin).set({ pwd: 'revoked-password' }).where(eq(systemAdmin.id, 101));
    expect(await envelope('GET', '/adminapi/product/product/get_verify/10')).toMatchObject({ status: 410001 });
    await f.db.update(systemAdmin).set({ pwd: 'stock-fixture-password' }).where(eq(systemAdmin.id, 101));
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1));
    expect(await envelope('POST', '/adminapi/product/product/set_verify/10', 101, '{}')).toMatchObject({ status: 400011 });
  });

  it('rejects malformed paths, unsupported verbs, queries, invalid UTF8/JSON and declared/streamed bodies beyond 8KiB without changes', async () => {
    const before = await moderationSnapshot(f.db);
    for (const path of ['0', '01', '-1', '2147483648']) for (const name of ['verify', 'remove', 'get_verify']) expect(await envelope('GET', `/adminapi/product/product/${name}/${path}`)).not.toMatchObject({ status: 200 });
    for (const method of ['GET', 'PUT', 'DELETE']) expect((await (await raw(method, '/adminapi/product/product/set_verify/10', 101, method === 'GET' ? undefined : '{}')).json<Envelope>()).status).not.toBe(200);
    for (const [method, path, body] of [['GET', '/adminapi/product/product/get_verify/10?x=1', undefined], ['GET', '/adminapi/product/product/verify/10?x=1', undefined], ['GET', '/adminapi/product/product/remove/10?x=1', undefined], ['POST', '/adminapi/product/product/set_verify/10?x=1', '{}']] as const) expect(await envelope(method, path, 101, body)).toMatchObject({ status: 400 });
    for (const body of ['', '{', new Uint8Array([0xff]), ' '.repeat(8193)]) expect(await (await raw('POST', '/adminapi/product/product/set_verify/10', 101, body)).json()).toMatchObject({ status: 400 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const request = new Request('http://localhost/adminapi/product/product/set_verify/10', { method: 'POST', headers: { 'Authori-zation': `Bearer ${tokens[101]}`, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(await (await app.request(request, undefined, env)).json()).toMatchObject({ status: 400 }); expect(cancelled).toBe(true);
    expect(await moderationSnapshot(f.db)).toEqual(before); expect(wiring.close).toHaveBeenCalled();
  });
});
