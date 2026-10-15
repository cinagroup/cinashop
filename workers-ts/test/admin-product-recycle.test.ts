import { legacyAdminReferenceRoot } from './helpers/legacyAdminReference';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { storeCart, storeOrderOutbox, storeProduct, systemAdmin, systemLog, systemMenus, systemRole } from '@/models/schema';
import { AdminProductRecycleService, adminProductRecycleId } from '@/services/admin/AdminProductRecycleService';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { createToken, md5 } from '@/utils/jwt';
import { recycleActor, recycleFixture, recycleSnapshot, seedRecycle } from './helpers/adminProductRecycle';
import { resetStockSequences } from './helpers/adminProductStocks';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const env = { APP_KEY: 'recycle-http-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as unknown as Env;
type Envelope = { status: number; msg: string; data?: unknown };
const toggle = { mode: 'toggle' as const };

describe('Admin reversible product deletion with complete business and receipt verification', () => {
  let f: Awaited<ReturnType<typeof recycleFixture>>;
  beforeAll(async () => { f = await recycleFixture(); }, 30000);
  beforeEach(async () => { await f.reset(); await seedRecycle(f.db); await resetStockSequences(f.exec); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Recycle forbids remote I/O')); }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });

  it('recycles/restores all direct children, invalidates every parent cart status and preserves full SKU/relation/grandchild/order data', async () => {
    const before = await recycleSnapshot(f.db), products = before.storeProduct as Array<typeof storeProduct.$inferSelect>;
    const result = await f.service.change(10, recycleActor(), toggle);
    expect(result).toEqual({ message: '成功移到回收站', outboxId: 1000 });
    const after = await recycleSnapshot(f.db);
    expect(after.storeProduct).toEqual(products.map(row => row.id === 10 ? { ...row, isDel: 1, isShow: 0 } : row.pid === 10 ? { ...row, isDel: 1 } : row));
    expect(after.storeCart).toEqual((before.storeCart as Array<typeof storeCart.$inferSelect>).map(row => row.productId === 10 ? { ...row, status: 0 } : row));
    for (const name of Object.keys(before).filter(name => !['storeProduct', 'storeCart', 'systemLog', 'storeOrderOutbox'].includes(name))) expect(after[name]).toEqual(before[name]);
    const audits = await f.db.select().from(systemLog).orderBy(systemLog.id), audit = audits.at(-1)!;
    expect(audits.slice(0, -1)).toEqual([...(before.systemLog as Array<typeof systemLog.$inferSelect>)].sort((a, b) => a.id - b.id));
    expect(audit).toEqual({ id: 1000, storeId: 0, merchantId: 0, adminName: '', ip: '', adminId: 101, path: 'product/product/10', page: '商品回收站', method: 'DELETE', type: 'product_recycle', action: JSON.stringify({ operation: 'recycle', productId: 10, affectedProductIds: [10, 100, 102] }), addTime: expect.any(Number) });
    const outbox = await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id);
    expect(outbox[0]).toEqual((before.storeOrderOutbox as Array<unknown>)[0]);
    expect(outbox[1]).toEqual({ id: 1000, eventKey: expect.stringMatching(/^product\.recycle\.effects:10:[a-f0-9-]{36}$/), aggregateType: 'product', aggregateId: 10, eventType: 'product.recycle.effects', payload: { productId: 10, auditId: 1000, affectedProductIds: [10, 100, 102] }, status: 'PENDING', dispatchCount: 0, attemptCount: 0, replayCount: 0, availableTime: audit.addTime, leaseUntil: 0, leaseToken: '', lastError: '', enqueuedTime: 0, processedTime: 0, addTime: audit.addTime, updateTime: audit.addTime });
    await f.db.update(storeProduct).set({ isShow: 2 }).where(eq(storeProduct.id, 10));
    await f.db.update(storeCart).set({ status: 6 }).where(eq(storeCart.id, 203));
    const beforeRestore = await recycleSnapshot(f.db);
    expect(await f.service.change(10, recycleActor(), { ...toggle, expectedIsDel: 1 })).toEqual({ message: '成功恢复商品', outboxId: 1001 });
    const restored = await recycleSnapshot(f.db);
    expect(restored.storeProduct).toEqual((beforeRestore.storeProduct as Array<typeof storeProduct.$inferSelect>).map(row => row.id === 10 || row.pid === 10 ? { ...row, isDel: 0 } : row));
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10)))[0].isShow).toBe(2);
    expect((await f.db.select().from(storeCart).where(eq(storeCart.id, 203)))[0].status).toBe(0);
    expect(JSON.parse((await f.db.select().from(systemLog).where(eq(systemLog.id, 1001)))[0].action)).toEqual({ operation: 'restore', productId: 10, affectedProductIds: [10, 100, 102] });
  });

  it('honors all source owner/card/deleted/review flags and declared-schema type1 verify0 without querying or requiring a store', async () => {
    for (const id of [20, 30, 40, 50, 60, 110, 111]) {
      const [before] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, id));
      const restore = before.isDel === 1;
      await f.service.change(id, recycleActor(), toggle);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0]).toEqual({ ...before, isDel: restore ? 0 : 1, ...(!restore ? { isShow: 0 } : {}), ...(before.type === 1 ? { isVerify: 0 } : {}) });
      if (before.type === 1) {
        await f.db.update(storeProduct).set({ isVerify: 1, isShow: 2 }).where(eq(storeProduct.id, id));
        await f.service.change(id, recycleActor(), toggle);
        expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0]).toMatchObject({ isDel: 0, isShow: 2, isVerify: 0 });
      }
    }
    // Source treats any stored is_del other than 1 as a recycle operation.
    await f.db.update(storeProduct).set({ isDel: 7 }).where(eq(storeProduct.id, 60));
    expect((await f.service.change(60, recycleActor(), toggle)).message).toBe('成功移到回收站');
    // A self pid must not duplicate its audit target or erase parent fields.
    await f.db.update(storeProduct).set({ pid: 10 }).where(eq(storeProduct.id, 10));
    await f.service.change(10, recycleActor(), toggle);
    expect(JSON.parse((await f.db.select().from(systemLog).where(eq(systemLog.path, 'product/product/10')).orderBy(systemLog.id)).at(-1)!.action).affectedProductIds).toEqual([10, 100, 102]);
  });

  it('keeps one-way aliases idempotent, rejects stale explicit intent and reports postcommit dispatch failure as durable success', async () => {
    const dispatch = vi.fn(async () => { throw Error('Queue transport outcome unknown'); });
    const service = new AdminProductRecycleService(f.container, { dispatch });
    expect(await service.change(10, recycleActor(), { mode: 'recycle' })).toEqual({ message: '成功移到回收站', outboxId: 1000 });
    expect(dispatch).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledWith(1000);
    const before = await recycleSnapshot(f.db);
    expect(await service.change(10, recycleActor(), { mode: 'recycle' })).toEqual({ message: '删除成功' });
    expect(await recycleSnapshot(f.db)).toEqual(before); expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(service.change(10, recycleActor(), { ...toggle, expectedIsDel: 0 })).rejects.toMatchObject({ httpStatus: 409 });
    expect(await recycleSnapshot(f.db)).toEqual(before);
    await expect(service.change(998, recycleActor(), toggle)).rejects.toThrow('商品数据不存在');
    for (const id of [0, -1, 1.1, 2147483648, '01', '1e1', ' 10']) expect(() => adminProductRecycleId(id)).toThrow();
    expect(await recycleSnapshot(f.db)).toEqual(before);
  });

  it('uses only exact source169/105/620 grants and fences single/batch/opaque copied DELETE and misleading GET metadata', async () => {
    const p = new AdminPermissionService(f.container), rules = ['169', '105', '620', '1510', '1511', '1512', '1513', '1514'];
    const results = await Promise.all(rules.map(rule => p.resolveRulePermissionKeys(rule)));
    expect(results.map(keys => keys.sort())).toEqual([['product.manage', 'product.view'], ['product.manage', 'product.view'], ['product.view'], [], [], [], [], []]);
    expect((await p.resolveManyRulePermissionKeys(rules)).map(keys => keys.sort())).toEqual(results.map(keys => keys.sort()));
    for (const row of await f.db.select().from(systemMenus)) if ([169, 620, 1510, 1511, 1512, 1513, 1514].includes(row.id)) expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
    for (const method of ['DELETE', 'POST']) expect(requiredAdminPermission(method, '/adminapi/product/product/10')).toBe('product.manage');
    expect(requiredAdminPermission('GET', '/adminapi/product/product/10')).toBe('product.view');
    for (const id of ['01', '0', '-1', '2147483648', 'x']) expect(requiredAdminPermission('DELETE', `/adminapi/product/product/${id}`)).toBeNull();
    for (const changes of [{ methods: 'GET', uniqueAuth: 'product.manage' }, { methods: 'DELETE,GET' }, { apiUrl: '/adminapi/product/product/<id>' }, { menuPath: '/product' }, { type: 2 }, { authType: 1 }]) {
      await f.db.update(systemMenus).set({ type: 1, authType: 2, apiUrl: 'product/product/<id>', methods: 'DELETE', menuPath: '', uniqueAuth: '', ...changes }).where(eq(systemMenus.id, 169));
      expect(await p.resolveRulePermissionKeys('169')).toEqual([]); expect(await p.resolveManyRulePermissionKeys(['169'])).toEqual([[]]);
    }
  });

  it('refuses revoked/password/foreign/expired and real read-only authorities before any business change', async () => {
    const before = await recycleSnapshot(f.db);
    for (const id of [102, 103, 104, 105, 107, 108, 109, 201, 202, 203, 204, 205, 206]) await expect(f.service.change(10, recycleActor(id), toggle)).rejects.toThrow();
    expect(await recycleSnapshot(f.db)).toEqual(before);
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1));
    const revoked = await recycleSnapshot(f.db); await expect(f.service.change(10, recycleActor(), toggle)).rejects.toThrow('权限'); expect(await recycleSnapshot(f.db)).toEqual(revoked);
    await f.db.update(systemRole).set({ rules: 'product.manage' }).where(eq(systemRole.id, 1));
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 101));
    const changed = await recycleSnapshot(f.db); await expect(f.service.change(10, recycleActor(), toggle)).rejects.toThrow('凭据');
    await expect(f.service.change(10, { ...recycleActor(), expiresAt: Math.floor(Date.now() / 1000) - 1 }, toggle)).rejects.toThrow('过期'); expect(await recycleSnapshot(f.db)).toEqual(changed);
    await f.service.change(10, recycleActor(200), toggle);
  });

  it('rolls back suppressed/rewritten parent, child, cart, full audit/outbox and post-audit/intent trigger changes or phantoms', async () => {
    const cases = [
      ['store_product', 'BEFORE UPDATE', 'RETURN NULL'],
      ['store_product', 'BEFORE UPDATE', 'NEW.stock:=NEW.stock+1; RETURN NEW'],
      ['store_product', 'BEFORE UPDATE', 'IF OLD.id=100 THEN NEW.is_show:=0; END IF; RETURN NEW'],
      ['store_cart', 'BEFORE UPDATE', 'RETURN NULL'],
      ['store_cart', 'BEFORE UPDATE', 'NEW.cart_num:=NEW.cart_num+1; RETURN NEW'],
      ['system_log', 'BEFORE INSERT', 'RETURN NULL'],
      ['system_log', 'BEFORE INSERT', "NEW.ip:='rewritten'; RETURN NEW"],
      ['system_log', 'AFTER INSERT', 'UPDATE store_product SET stock=99 WHERE id=100; RETURN NEW'],
      ['system_log', 'AFTER INSERT', 'UPDATE store_product_attr_value SET price=99 WHERE id=401; RETURN NEW'],
      ['system_log', 'AFTER INSERT', 'UPDATE store_cart SET status=0 WHERE id=206; RETURN NEW'],
      ['system_log', 'AFTER INSERT', 'UPDATE store_product_relation SET status=0 WHERE id=203; RETURN NEW'],
      ['system_log', 'AFTER INSERT', 'INSERT INTO store_product(id,pid) VALUES(990,10); RETURN NEW'],
      ['system_log', 'AFTER INSERT', "INSERT INTO store_product_attr_value(product_id,\"unique\") VALUES(10,'phantom1'); RETURN NEW"],
      ['system_log', 'AFTER INSERT', 'INSERT INTO store_cart(product_id,status) VALUES(100,1); RETURN NEW'],
      ['system_log', 'AFTER INSERT', 'INSERT INTO store_product_relation(product_id) VALUES(100); RETURN NEW'],
      ['system_log', 'AFTER INSERT', "IF pg_trigger_depth()=1 THEN INSERT INTO system_log(path,action) VALUES(NEW.path,'extra'); END IF; RETURN NEW"],
      ['system_log', 'AFTER INSERT', "UPDATE system_role SET rules='product.view' WHERE id=1; RETURN NEW"],
      ['store_order_outbox', 'BEFORE INSERT', 'RETURN NULL'],
      ['store_order_outbox', 'BEFORE INSERT', "NEW.last_error:='rewritten'; RETURN NEW"],
      ['store_order_outbox', 'AFTER INSERT', 'UPDATE store_product SET is_show=1 WHERE id=10; RETURN NEW'],
      ['store_order_outbox', 'AFTER INSERT', "IF pg_trigger_depth()=1 THEN INSERT INTO store_order_outbox(event_key,aggregate_type,aggregate_id,event_type,payload) VALUES('extra-intent','product',10,'product.recycle.effects',NEW.payload); END IF; RETURN NEW"],
    ];
    for (const [table, timing, body] of cases) {
      const before = await recycleSnapshot(f.db);
      await f.exec(`CREATE FUNCTION recycle_fixture_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body}; END $$; CREATE TRIGGER recycle_fixture_trigger ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION recycle_fixture_trigger()`);
      try { await expect(f.service.change(10, recycleActor(), toggle), `${table}: ${body}`).rejects.toThrow(); expect(await recycleSnapshot(f.db)).toEqual(before); }
      finally { await f.exec(`DROP TRIGGER recycle_fixture_trigger ON ${table}; DROP FUNCTION recycle_fixture_trigger()`); }
    }
  }, 60000);

  it('refuses an over-capacity complete family before mutation', async () => {
    await f.exec("INSERT INTO store_product(id,pid) SELECT 20000+n,10 FROM generate_series(1,10001) n");
    const before = await recycleSnapshot(f.db); await expect(f.service.change(10, recycleActor(), toggle)).rejects.toThrow('10000'); expect(await recycleSnapshot(f.db)).toEqual(before);
  }, 30000);
});

describe('actual legacy tableDelApi and all product recycle HTTP aliases through App/JWT/SQL', () => {
  const app = createApp(), tokens: Record<number, string> = {}, calls: Array<{ method: string; path: string; data: unknown }> = [];
  let f: Awaited<ReturnType<typeof recycleFixture>>, old: { tableDelApi(data: { url: string; method: string; ids: string }): Promise<Envelope> };
  beforeAll(async () => {
    f = await recycleFixture(); wiring.application.mockImplementation(() => f.container); wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [100, 101, 102, 106, 109, 200, 201, 202, 203, 204, 205, 206]) tokens[id] = (await createToken(id, 'admin', md5('stock-fixture-password'), env.APP_KEY)).token;
    const require = createRequire(resolve(import.meta.dirname, '../../view/admin-ts/package.json'));
    const php = legacyAdminReferenceRoot();
    Reflect.set(globalThis, '__recycleLegacyToken', tokens[200]);
    const compiled = await build({ bundle: true, write: false, platform: 'node', format: 'cjs', external: ['axios'],
      define: { 'process.env.NODE_ENV': '"test"' },
      stdin: { resolveDir: php, contents: `export {tableDelApi} from ${JSON.stringify(resolve(php, 'api/common.js'))};export {default as request} from ${JSON.stringify(resolve(php, 'plugins/request/index.js'))};` },
      plugins: [{ name: 'actual-old-delete-api-and-interceptors', setup(plugin) {
        plugin.onResolve({ filter: /^@\/plugins\/request$/ }, () => ({ path: resolve(php,'plugins/request/index.js') }));
        plugin.onResolve({ filter: /^(?:@\/(?:store|libs\/util|setting)|view-design)$/ }, args => ({ path: args.path, namespace: 'recycle-legacy-host' }));
        plugin.onLoad({ filter: /.*/, namespace: 'recycle-legacy-host' }, args => ({ loader: 'js', contents: args.path === '@/store' ? 'export default {dispatch:async()=>{}};'
          : args.path === '@/libs/util' ? 'export default {cookies:{get:()=>globalThis.__recycleLegacyToken,kefuGet:()=>null,remove(){}},log:{error(){}}};'
          : args.path === '@/setting' ? `export default {apiBaseURL:'/adminapi',errorModalType:'Message',modalDuration:1};`
          : 'export const Message={error(){}},Notice={error(){}},LoadingBar={};' }));
      } }] });
    const module = { exports: {} };new Function('require','module','exports',compiled.outputFiles[0].text)(require,module,module.exports);
    const loaded=module.exports as typeof old & {request:ReturnType<typeof require>};old=loaded;
    const request=loaded.request;
    request.defaults.adapter = async (config: { url: string; method: string; data?: string; headers: { toJSON(): Record<string, string> } }) => {
      const url = new URL(request.getUri(config), 'http://localhost'), method = config.method.toUpperCase(); calls.push({ method, path: url.pathname, data: config.data });
      const response = await app.request(url.pathname + url.search, { method, headers: config.headers.toJSON(), ...(config.data ? { body: config.data } : {}) }, env);
      const result={ data: await response.json(), status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), config, request: {} };
      if(response.status<200||response.status>=300) throw new (require('axios').AxiosError)('HTTP fixture refusal','ERR_BAD_RESPONSE',config,{},result);
      return result;
    };
  }, 30000);
  beforeEach(async () => { await f.reset(); await seedRecycle(f.db); await resetStockSequences(f.exec); calls.length = 0; wiring.close.mockClear(); vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem(){},clear(){}});vi.stubGlobal('localStorage',{clear(){}});vi.stubGlobal('window',{router:{replace(){}}});vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Recycle HTTP forbids remote I/O')); }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { Reflect.deleteProperty(globalThis, '__recycleLegacyToken'); await f?.close(); });
  async function raw(path: string, id: number | null = 101, body?: string | Uint8Array, method = 'DELETE') {
    return app.request(path, { method, headers: { ...(id === null ? {} : { 'Authori-zation': `Bearer ${tokens[id]}` }) }, ...(body === undefined ? {} : { body }) }, env);
  }
  async function envelope(path: string, id: number | null = 101, body?: string | Uint8Array) {
    const response = await raw(path, id, body); expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('pragma')).toBe('no-cache'); return response.json<Envelope>();
  }
  it('executes genuine old ids empty-string delete/restore twice and exposes source Chinese messages', async () => {
    expect(await old.tableDelApi({ url: 'product/product/10', method: 'DELETE', ids: '' })).toEqual({ status: 200, msg: '成功移到回收站', data: [] });
    expect(await old.tableDelApi({ url: 'product/product/10', method: 'DELETE', ids: '' })).toEqual({ status: 200, msg: '成功恢复商品', data: [] });
    expect(calls).toEqual([{ method: 'DELETE', path: '/adminapi/product/product/10', data: '' }, { method: 'DELETE', path: '/adminapi/product/product/10', data: '' }]);
    await expect(old.tableDelApi({ url: 'product/product/998', method: 'DELETE', ids: '' })).rejects.toMatchObject({ status:400,msg: '商品数据不存在' });
  });
  it('lets the genuine old interceptor reject definite rolled-back conflicts while modern guarded requests keep HTTP409/503',async()=>{
    for(const [body,status] of [["NEW.stock:=NEW.stock+1;RETURN NEW",409],["RAISE EXCEPTION 'fixture permission refusal' USING ERRCODE='42501';RETURN NEW",503]] as const){
      const before=await recycleSnapshot(f.db);
      await f.exec(`CREATE FUNCTION recycle_wire_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body}; END $$; CREATE TRIGGER recycle_wire_trigger BEFORE UPDATE ON store_product FOR EACH ROW EXECUTE FUNCTION recycle_wire_trigger()`);
      try{
        await expect(old.tableDelApi({url:'product/product/10',method:'DELETE',ids:''})).rejects.toMatchObject({status:400,msg:expect.any(String)});
        const response=await raw('/adminapi/product/product/10?expected_is_del=0',200);expect(response.status).toBe(status);expect(await response.json()).toMatchObject({status});
        expect(await recycleSnapshot(f.db)).toEqual(before);
      }finally{await f.exec('DROP TRIGGER recycle_wire_trigger ON store_product;DROP FUNCTION recycle_wire_trigger()');}
    }
  });
  it('enforces live real auth and exact source permissions on canonical plus both runtime aliases with private failures', async () => {
    for (const path of ['/adminapi/product/product/10', '/adminapi/product/del/10', '/api/admin/product/del/10']) {
      const before = await recycleSnapshot(f.db);
      for (const id of [null, 102, 109, 201, 202, 203, 204, 205, 206]) expect((await envelope(path, id)).status).not.toBe(200);
      expect(await recycleSnapshot(f.db)).toEqual(before);
    }
    expect(await envelope('/adminapi/product/product/10?expected_is_del=0', 200)).toMatchObject({ status: 200, msg: '成功移到回收站', data: [] });
    expect(await envelope('/adminapi/product/product/10?expected_is_del=0', 200)).toMatchObject({ status: 409 });
    expect(await envelope('/adminapi/product/product/10?expected_is_del=1', 106)).toMatchObject({ status: 200, msg: '成功恢复商品' });
    expect(await envelope('/adminapi/product/del/10')).toMatchObject({ status: 200, msg: '删除成功', data: null });
    const before = await recycleSnapshot(f.db);
    expect(await envelope('/api/admin/product/del/10')).toMatchObject({ status: 200, msg: '删除成功', data: null });
    expect(await recycleSnapshot(f.db)).toEqual(before);
    await f.db.update(systemAdmin).set({ pwd: 'revoked' }).where(eq(systemAdmin.id, 101));
    expect(await envelope('/adminapi/product/product/20')).toMatchObject({ status: 410001 });
  });
  it('rejects ambiguous/unknown query, any nonempty body, invalid UTF8, invalid ID and declared/streamed overflow without mutations', async () => {
    const before = await recycleSnapshot(f.db);
    for (const query of ['?expected_is_del=0&expected_is_del=0', '?expected_is_del=2', '?expected_is_del=01', '?expected_is_del=', '?expected_is_del=0&x=1', '?x=1']) expect(await envelope(`/adminapi/product/product/10${query}`)).toMatchObject({ status: 400 });
    for (const path of ['/adminapi/product/del/10', '/api/admin/product/del/10']) expect(await envelope(`${path}?expected_is_del=0`)).toMatchObject({ status: 400 });
    for (const body of [' ', '{}', '""', '{"id":20}', new Uint8Array([0xff]), '中'.repeat(342)]) expect(await envelope('/adminapi/product/product/10', 101, body)).toMatchObject({ status: 400 });
    for (const id of ['0', '01', '-1', '2147483648']) expect((await envelope(`/adminapi/product/product/${id}`)).status).not.toBe(200);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const request = new Request('http://localhost/adminapi/product/product/10', { method: 'DELETE', headers: { 'Authori-zation': `Bearer ${tokens[101]}` }, body: stream, duplex: 'half' } as RequestInit);
    expect(await (await app.request(request, undefined, env)).json()).toMatchObject({ status: 400 }); expect(cancelled).toBe(true);
    const declared = new Request('http://localhost/adminapi/product/product/10', { method: 'DELETE', headers: { 'Authori-zation': `Bearer ${tokens[101]}`, 'Content-Length': '1025' }, body: '' });
    expect(await (await app.request(declared, undefined, env)).json()).toMatchObject({ status: 400 });
    expect(await recycleSnapshot(f.db)).toEqual(before); expect(wiring.close).toHaveBeenCalled();
  });
});
