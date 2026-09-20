import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type V4FetchHandler } from 'miniflare';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { memberRight, otherOrder, paymentReconciliationCase, systemConfig, user, wechatUser } from '../src/models/schema';
import { runOfflineOrder, runOfflineOrderSchema } from '../src/migrations/runOfflineOrder';
import { offlineRuntimeGrantPlan } from '../src/migrations/offlineOrderRuntimeContract';
import { auditOfflineOrderRuntimePermissions } from '../src/migrations/auditOfflineOrderRuntimePermissions';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { seedHistoricalZeroOfflineOrder } from './helpers/offlineLegacyZeroFixture';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';
import { createToken, md5 } from '../src/utils/jwt';
import { PaymentReconciliationService } from '../src/services/payment/PaymentReconciliationService';

type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected JSON object');
  return Object.fromEntries(Object.entries(value));
}
describe('offline cashier HTTP on actual Workers/auth/isolated PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, script: string, ddl: string, secret: string;
  let keys: ReturnType<typeof paymentQueryKeys>, tokens: string[];
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    const kit = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(schema))).join('\n');
    const bundle = await build({ entryPoints: [resolve(import.meta.dirname, 'integration/OfflineOrderHttpWorker.ts')], bundle: true,
      write: false, platform: 'browser', format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'],
      external: ['node:*', 'cloudflare:*'], tsconfig: resolve(import.meta.dirname, '../tsconfig.json') });
    script = bundle.outputFiles[0].text; keys = paymentQueryKeys(); secret = randomUUID();
    tokens = await Promise.all([11, 12].map(async id => (await createToken(id, 'api', md5('local-http-password'), secret)).token));
  }, 60_000);
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    await f.db.transaction(tx => tx.execute(sql.raw(ddl)));
    await runOfflineOrderSchema(f.db, true);
    await f.db.insert(user).values([11, 12].map(uid => ({ uid, account: `http-buyer-${uid}`, pwd: 'local-http-password',
      nowMoney: '100.00', integral: 50, isEverLevel: 1 })));
    await f.db.insert(systemConfig).values([{ menuName: 'member_card_status', value: '1' }, { menuName: 'order_give_integral', value: '1.234567' },
      { menuName: 'balance_func_status', value: '1' }, { menuName: 'yue_pay_status', value: '1' }]);
    await f.db.insert(memberRight).values([{ rightType: 'offline', number: 80, status: 1 }, { rightType: 'integral', number: 2, status: 1 }]);
  }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  async function grants(r: Runtime) {
    await runOfflineOrder(f.db, r.role);
    await f.exec(offlineRuntimeGrantPlan(r.role));
    expect(await auditOfflineOrderRuntimePermissions(r.db)).toMatchObject({ready:true,failures:[]});
  }
  const fixture = <T>(work: (t: {
    request: (path: string, body?: unknown, options?: { token?: string; headers?: Record<string, string>; raw?: string }) => Promise<{ http: number; status: unknown; data: unknown }>;
    create: (extra?: Record<string, unknown>) => Promise<string>;
    r: Runtime; calls: string[]; unsigned: (value: boolean) => void;
    api: Awaited<ReturnType<typeof paymentQueryFixture>>;
    cache: { get(key:string):Promise<string|null>; delete(key:string):Promise<void> };
  }) => Promise<T>, production = false) => f.withRuntimeRole!(async r => {
    await grants(r);
    const [identity] = await r.exec('SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(identity).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    const api = await paymentQueryFixture(createContainerFromDb(r.db), keys), calls: string[] = [];
    await f.db.insert(systemConfig).values(Object.entries({...api.config,cfg_pay_weixin_open:'1',cfg_ali_pay_status:'1'})
      .map(([name,value])=>({menuName:name.slice(4),value})));
    let unsigned = false;
    const outbound: V4FetchHandler = async request => {
      calls.push(request.url);
      if (request.url !== 'https://api.mch.weixin.qq.com/v3/pay/transactions/h5' || request.method !== 'POST') return new LocalResponse(null, { status: 503 });
      const body = JSON.parse(await request.text());
      expect(body.scene_info.payer_client_ip).toBe('203.0.113.42');
      expect(body.amount.total).toBe(1000);
      const response = api.wechatResponse({ h5_url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=http-local' });
      return new LocalResponse(await response.text(), { headers: unsigned ? {} : Object.fromEntries(response.headers) });
    };
    const { CONFIG_KV: _fakeKv, ...paymentBindings } = api.bindings;
    const mf = new Miniflare(convertV4MiniflareOptions({ script, modules: true, compatibilityDate: '2026-08-09', compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1', port: 0, hyperdrives: { HYPERDRIVE: r.connectionString }, kvNamespaces: ['CONFIG_KV'], outboundService: outbound,
      bindings: { ...paymentBindings, APP_KEY: secret, NODE_ENV: production ? 'production' : 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
        ALIPAY_NOTIFY_URL: 'https://query.example/api/pay/notify/alipay', ALIPAY_RETURN_URL: 'https://shop.example/payment' } }));
    try {
      const kv = await mf.getKVNamespace('CONFIG_KV');
      for (const [key, value] of Object.entries({ ...api.config, cfg_pay_weixin_open: '1', cfg_ali_pay_status: '1' })) await kv.put(key, value);
      const request = async (path: string, body?: unknown, options: { token?: string; headers?: Record<string, string>; raw?: string } = {}) => {
        const response = await mf.dispatchFetch(`http://localhost/api/order/offline/${path}`, {
          method: body === undefined && options.raw === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${options.token ?? tokens[0]}`, 'Content-Type': 'application/json', ...options.headers },
          ...(body !== undefined || options.raw !== undefined ? { body: options.raw ?? JSON.stringify(body) } : {}),
        });
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        const result = record(await response.json());
        return { http: response.status, status: result.status, data: result.data };
      };
      const create = async (extra: Record<string, unknown> = {}) => {
        const response = await request('create', { money: '12.50', expected_pay_price: '10.00', from: 'h5', request_key: randomUUID(), ...extra });
        expect(response.status).toBe(200); const data = record(response.data);
        if (typeof data.order_id !== 'string') throw Error('Missing server order id'); return data.order_id;
      };
      return await work({ request, create, r, calls, unsigned: value => { unsigned = value; }, api, cache:kv });
    } finally { await mf.dispose(); }
  });
  const counts = async () => record((await f.query(`SELECT
    (SELECT count(*)::int FROM other_order) AS orders,(SELECT count(*)::int FROM offline_order_admission) AS admissions,
    (SELECT count(*)::int FROM offline_order_payment_selection) AS selections,(SELECT count(*)::int FROM user_money) AS money,
    (SELECT count(*)::int FROM user_bill) AS bills,(SELECT count(*)::int FROM store_order_economize) AS savings`)).rows[0]);
  it('history keyset pages only owned admissions, survives new inserts and exposes no payment claims or request keys',async()=>{
    await fixture(async t=>{
      const own:string[]=[];for(let i=0;i<23;i++)own.push(await t.create());
      const foreign=record((await t.request('create',{money:'12.50',expected_pay_price:'10.00',from:'h5',request_key:randomUUID()},{token:tokens[1]})).data).order_id;
      const before=await counts();const first=record((await t.request('history')).data),items=first.items as Record<string,unknown>[];
      expect(items).toHaveLength(20);expect(items.map(item=>item.order_id)).toEqual([...own].reverse().slice(0,20));
      for(const item of items)expect(Object.keys(item).sort()).toEqual(['order_id','money','pay_price','channel','created_at','hidden'].sort());
      expect(first.next_cursor).toBe(own[3]);expect(JSON.stringify(first)).not.toMatch(/request_key|request_hash|paid|ticket|uid/);
      expect(await counts()).toEqual(before);await t.create();
      const second=record((await t.request('history?cursor='+first.next_cursor)).data);
      expect((second.items as Record<string,unknown>[]).map(item=>item.order_id)).toEqual(own.slice(0,3).reverse());expect(second.next_cursor).toBe('');
      expect(await t.request('history?order_id='+foreign)).toMatchObject({status:200,data:{items:[],next_cursor:''}});
      expect(await t.request('history?cursor='+foreign)).toMatchObject({status:400});
      await f.db.update(otherOrder).set({isDel:1}).where(eq(otherOrder.orderId,own[0]));
      const hidden=record((await t.request('history?order_id='+own[0])).data);expect(hidden.items).toEqual([expect.objectContaining({order_id:own[0],hidden:true})]);
      expect(await t.request('detail/'+own[0])).toMatchObject({status:200,data:{state:'UNAVAILABLE',paid:false}});expect(t.calls).toEqual([]);
    });
  },90_000);
  it('history rejects query/auth overrides and is readable with only SELECT permissions',async()=>{
    await fixture(async t=>{
      const id=await t.create(),before=await counts();
      for(const suffix of ['?uid=12','?paid=1','?limit=1000','?order_id=','?cursor=','?cursor=x','?order_id='+id+'&cursor='+id,'?order_id='+id+'&order_id='+id,'?q='+('x'.repeat(200))])
        expect(await t.request('history'+suffix)).toMatchObject({status:400});
      const wrongActor=(await createToken(11,'admin',md5('local-http-password'),secret)).token;
      for(const token of ['',wrongActor])expect((await t.request('history',undefined,{token})).status).not.toBe(200);
      await f.exec(`REVOKE INSERT,UPDATE ON ALL TABLES IN SCHEMA public FROM "${t.r.role}";
        REVOKE UPDATE(uid,now_money,integral,is_promoter) ON "user" FROM "${t.r.role}";
        REVOKE UPDATE(id,paid,pay_type,pay_time,trade_no) ON other_order FROM "${t.r.role}";
        REVOKE UPDATE(id) ON wechat_user FROM "${t.r.role}";
        REVOKE UPDATE(state,ticket_payload,ticket_hash,finished_at,display_until) ON offline_order_payment_dispatch FROM "${t.r.role}";
        REVOKE EXECUTE ON FUNCTION public.ooa_lock_pricing() FROM "${t.r.role}";
        ALTER ROLE "${t.r.role}" SET default_transaction_read_only=on`);
      expect(await t.r.exec(`SELECT has_any_column_privilege(current_user,'public.user','UPDATE')
        OR has_any_column_privilege(current_user,'public.other_order','UPDATE') AS writable`)).toEqual([{writable:false}]);
      expect(await t.request('history')).toMatchObject({status:200,data:{items:[{order_id:id}]}});
      expect(await counts()).toEqual(before);expect(t.calls).toEqual([]);
      await f.exec(`REVOKE SELECT ON offline_order_admission FROM "${t.r.role}"`);
      expect(await t.request('history')).toEqual({http:503,status:503,data:null});
    });
  },60_000);
  it('history fails on missing candidate installation or revoked account, and cannot present a forged paid flag as receipt',async()=>{
    await fixture(async t=>{
      const id=await t.create();
      // Fixture maintenance only: corrupt the legacy flag while leaving immutable admission intact.
      await f.exec(`ALTER TABLE other_order DISABLE TRIGGER USER; UPDATE other_order SET paid=1 WHERE order_id='${id}'; ALTER TABLE other_order ENABLE TRIGGER USER`);
      const found=record((await t.request('history')).data);expect(found.items).toEqual([expect.objectContaining({order_id:id})]);
      expect(JSON.stringify(found)).not.toContain('paid');expect((await t.request('detail/'+id)).status).not.toBe(200);
      await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,11));expect((await t.request('history')).status).not.toBe(200);
      await f.db.update(user).set({deleteTime:null}).where(eq(user.uid,11));
      await f.exec('ALTER TABLE offline_order_admission RENAME TO hidden_history_admission');
      expect(await t.request('history')).toEqual({http:503,status:503,data:null});
      expect((await f.query("SELECT to_regclass('public.offline_order_admission') IS NULL AS missing")).rows).toEqual([{missing:true}]);expect(t.calls).toEqual([]);
    });
  },60_000);
  it('payment discovery keeps legacy wallet flag, authenticates, projects only public data and never creates or backfills KV',async()=>{
    await fixture(async t=>{
      const order=await t.create(); const before=await counts();
      await f.db.insert(systemConfig).values({menuName:'site_name',value:'"本地收银"'});await t.cache.delete('cfg_site_name');
      const found=await t.request(`pay/type?order_id=${order}`);
      expect(found).toMatchObject({status:200,data:{order_id:order,channel:'h5',pay_price:'10.00',site_name:'本地收银',now_money:'100.00',
        offline_pay_status:true,yue_pay_status:1,pay_weixin_open:1,ali_pay_status:1,methods:{yue:'available',weixin:'available',alipay:'available'}}});
      expect(Object.keys(record(found.data)).sort()).toEqual(['order_id','channel','pay_price','site_name','now_money','offline_pay_status','yue_pay_status','pay_weixin_open','ali_pay_status','methods'].sort());
      expect(await t.request('pay/type')).toMatchObject({status:200,data:{yue_pay_status:1,now_money:'100.00'}});
      expect(record((await t.request('pay/type')).data)).not.toHaveProperty('order_id');
      for(const token of ['',tokens[1]])expect((await t.request(`pay/type?order_id=${order}`,undefined,{token})).status).not.toBe(200);
      for(const suffix of ['?uid=11','?from=routine','?paid=1','?order_id=','?order_id=xx','?order_id='+order+'&order_id='+order])
        expect(await t.request('pay/type'+suffix)).toMatchObject({status:400,data:null});
      expect(await t.cache.get('cfg_site_name')).toBeNull();expect(await counts()).toEqual(before);expect(t.calls).toEqual([]);
    });
  },60_000);
  it('current DB switches and balance supersede stale cache and reject first dispatch after revocation',async()=>{
    await fixture(async t=>{
      const order=await t.create();
      await f.db.insert(systemConfig).values([{menuName:'pay_weixin_open',value:'"0"',sort:99,status:0},
        {menuName:'pay_weixin_open',value:'1',sort:100,isStore:1},{menuName:'yue_pay_status',value:'0',sort:99}]);
      expect(await t.request(`pay/type?order_id=${order}`)).toMatchObject({data:{pay_weixin_open:0,yue_pay_status:0,methods:{weixin:'disabled',yue:'disabled'}}});
      expect(await t.request('pay',{order_id:order,pay_type:'weixin'},{headers:{'CF-Connecting-IP':'203.0.113.42'}})).toMatchObject({status:400});
      await f.db.update(systemConfig).set({value:'1'}).where(eq(systemConfig.menuName,'yue_pay_status'));
      await f.db.update(user).set({nowMoney:'9.99'}).where(eq(user.uid,11));
      expect(await t.request(`pay/type?order_id=${order}`)).toMatchObject({data:{now_money:'9.99',yue_pay_status:0,methods:{yue:'insufficient_balance'}}});
      expect(await counts()).toMatchObject({orders:1,selections:0,money:0,bills:0});expect(t.calls).toEqual([]);
    });
  },60_000);
  it('missing/invalid configuration is unavailable without leaking keys or triggering a payment',async()=>{
    await fixture(async t=>{
      const order=await t.create();
      await f.db.delete(systemConfig).where(eq(systemConfig.menuName,'ali_pay_status'));
      await f.db.update(systemConfig).set({value:'bad-merchant'}).where(eq(systemConfig.menuName,'pay_weixin_mchid'));
      expect(await t.request(`pay/type?order_id=${order}`)).toMatchObject({data:{ali_pay_status:0,pay_weixin_open:0,methods:{alipay:'disabled',weixin:'not_configured'}}});
      await f.db.update(systemConfig).set({value:'x'.repeat(3000)}).where(eq(systemConfig.menuName,'pay_weixin_open'));
      const result=await t.request(`pay/type?order_id=${order}`);expect(result).toMatchObject({data:{methods:{weixin:'not_configured'}}});
      expect(JSON.stringify(result)).not.toMatch(/bad-merchant|KEY|oversized|frozen-local|private|secret/);
      expect(await counts()).toMatchObject({selections:0,money:0,bills:0});expect(t.calls).toEqual([]);
    });
  },60_000);
  it('routine uses its own unique payer, rejects Alipay WAP, and existing paths never advertise another rail',async()=>{
    await fixture(async t=>{
      const order=await t.create({from:'routine'});
      expect(await t.request(`pay/type?order_id=${order}`)).toMatchObject({data:{channel:'routine',methods:{weixin:'identity_required',alipay:'channel_unsupported'}}});
      await f.db.insert(wechatUser).values({uid:11,userType:'wechat',openid:'wrong-profile'});
      expect(await t.request(`pay/type?order_id=${order}`)).toMatchObject({data:{methods:{weixin:'identity_required'}}});
      await f.db.insert(wechatUser).values({uid:11,userType:'routine',openid:'local-payer'});
      expect(await t.request(`pay/type?order_id=${order}`)).toMatchObject({data:{methods:{weixin:'available'}}});
      await f.db.insert(wechatUser).values({uid:11,userType:'routine',openid:'duplicate-payer'});
      expect(await t.request(`pay/type?order_id=${order}`)).toMatchObject({data:{methods:{weixin:'identity_required'}}});
      expect(await t.request('pay',{order_id:order,pay_type:'alipay'})).toMatchObject({status:400});
      expect(await t.request('pay',{order_id:order,pay_type:'yue'})).toMatchObject({status:200});
      expect(await t.request(`pay/type?order_id=${order}`)).toMatchObject({data:{methods:{weixin:'read_original',alipay:'read_original',yue:'read_original'}}});
      expect(t.calls).toEqual([]);
    });
  },60_000);
  it('read-only LOGIN can discover, while missing permission and account deletion fail closed',async()=>{
    await fixture(async t=>{
      const order=await t.create();
      await f.exec(`REVOKE INSERT,UPDATE ON ALL TABLES IN SCHEMA public FROM "${t.r.role}";
        REVOKE UPDATE(uid,now_money,integral,is_promoter) ON "user" FROM "${t.r.role}";
        REVOKE UPDATE(id,paid,pay_type,pay_time,trade_no) ON other_order FROM "${t.r.role}";
        REVOKE UPDATE(id) ON wechat_user FROM "${t.r.role}";
        REVOKE UPDATE(state,ticket_payload,ticket_hash,finished_at,display_until) ON offline_order_payment_dispatch FROM "${t.r.role}";
        REVOKE EXECUTE ON FUNCTION public.ooa_lock_pricing() FROM "${t.r.role}";
        ALTER ROLE "${t.r.role}" SET default_transaction_read_only=on`);
      expect(await t.r.exec(`SELECT has_any_column_privilege(current_user,'public.user','UPDATE') OR has_table_privilege(current_user,'public.offline_order_payment_dispatch','INSERT') AS writable`)).toEqual([{writable:false}]);
      expect(await t.request(`pay/type?order_id=${order}`)).toMatchObject({status:200});
      await f.exec(`REVOKE SELECT ON system_config FROM "${t.r.role}"`);
      expect(await t.request(`pay/type?order_id=${order}`)).toEqual({http:503,status:503,data:null});
      await f.exec(`GRANT SELECT ON system_config TO "${t.r.role}"`);
      await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,11));
      expect((await t.request(`pay/type?order_id=${order}`)).status).not.toBe(200);expect(t.calls).toEqual([]);
    });
  },60_000);
  it('create/retry reuses the server order; wallet payment/replay and read-only detail show one financial effect', async () => {
    await fixture(async t => {
      const request_key = randomUUID(), order = await t.create({ request_key });
      expect(await t.create({ request_key })).toBe(order);
      expect(await t.request('create', { request_key, money: '20', expected_pay_price: '16', from: 'h5' })).toMatchObject({ status: 409 });
      expect(await t.request(`detail/${order}`)).toMatchObject({ status: 200, data: { paid: false, state: 'UNSELECTED', money: '12.50', pay_price: '10.00' } });
      for (let i = 0; i < 2; i++) expect(await t.request('pay', { order_id: order, pay_type: 'yue' })).toMatchObject({ status: 200, data: { paid: true, state: 'PAID', replayed: i === 1 } });
      await f.exec(`REVOKE INSERT,UPDATE ON ALL TABLES IN SCHEMA public FROM "${t.r.role}";
        REVOKE UPDATE(uid,now_money,integral,is_promoter) ON "user" FROM "${t.r.role}";
        REVOKE UPDATE(id,paid,pay_type,pay_time,trade_no) ON other_order FROM "${t.r.role}";
        REVOKE UPDATE(id) ON wechat_user FROM "${t.r.role}";
        REVOKE UPDATE(state,ticket_payload,ticket_hash,finished_at,display_until) ON offline_order_payment_dispatch FROM "${t.r.role}";
        REVOKE EXECUTE ON FUNCTION public.ooa_lock_pricing() FROM "${t.r.role}";
        ALTER ROLE "${t.r.role}" SET default_transaction_read_only=on`);
      expect(await t.r.exec(`SELECT has_any_column_privilege(current_user,'public.user','UPDATE')
        OR has_any_column_privilege(current_user,'public.other_order','UPDATE')
        OR has_table_privilege(current_user,'public.user_money','INSERT') AS writable`)).toEqual([{ writable: false }]);
      const detail = await t.request(`detail/${order}`); expect(detail).toMatchObject({ status: 200, data: { paid: true, state: 'PAID' } });
      expect(Object.keys(record(detail.data)).sort()).toEqual(['channel','created_at','hidden','money','order_id','paid','paid_at','pay_price','pay_type','state'].sort());
      expect(await counts()).toEqual({ orders: 1, admissions: 1, selections: 1, money: 1, bills: 1, savings: 1 });
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ nowMoney: '90.00', integral: 64, isEverLevel: 1 });
      expect(t.calls).toEqual([]);
    });
  }, 60_000);
  it('auth, ownership and DTO failures cannot create or pay on behalf of another user', async () => {
    await fixture(async t => {
      const body = { money: '12.50', expected_pay_price: '10.00', from: 'h5', request_key: randomUUID() };
      const wrongActor = (await createToken(11, 'admin', md5('local-http-password'), secret)).token;
      for (const token of ['', 'invalid', wrongActor]) expect(Number((await t.request('create', body, { token })).status)).toBeGreaterThanOrEqual(410000);
      for (const key of ['uid','order_id','type','member_type','price','pay_type','quitUrl','payer','merchant','__proto__']) {
        expect(await t.request('create', { ...body, [key]: 'override' })).toMatchObject({ status: 400 });
      }
      for (const raw of ['null', '[]', '{', '{}', JSON.stringify({ ...body, money: 12.5 }), JSON.stringify({ ...body, request_key: 'x'.repeat(1200) })]) {
        expect(await t.request('create', undefined, { raw })).toMatchObject({ status: 400 });
      }
      expect((await counts()).orders).toBe(0);
      const order = await t.create();
      expect(await t.request(`detail/${order}`, undefined, { token: tokens[1] })).toMatchObject({ status: 404 });
      expect(await t.request('pay', { order_id: order, pay_type: 'yue' }, { token: tokens[1] })).toMatchObject({ status: 400 });
      expect(await t.request(`detail/${order}?uid=12&paid=1`)).toMatchObject({ status: 400 });
      for (const key of ['uid','pay_price','from','payer','merchant','quitUrl','client_ip','paid']) expect(await t.request('pay', { order_id: order, pay_type: 'yue', [key]: 1 })).toMatchObject({ status: 400 });
      expect(await counts()).toMatchObject({ orders: 1, money: 0, bills: 0, selections: 0 }); expect(t.calls).toEqual([]);
    });
  }, 60_000);
  it('missing candidate schema returns 503, never installs itself or admits an order', async () => {
    await fixture(async t => {
      await f.exec('ALTER TABLE offline_order_payment_dispatch RENAME TO hidden_test_dispatch');
      // Admission alone uses its own candidate; simulate its absence independently.
      await f.exec('ALTER TABLE offline_order_admission RENAME TO hidden_test_admission');
      expect(await t.request('create', { money: '12.50', expected_pay_price: '10.00', from: 'h5', request_key: randomUUID() })).toEqual({ http: 503, status: 503, data: null });
      expect((await f.query('SELECT count(*)::int AS n FROM other_order')).rows).toEqual([{ n: 0 }]);
      expect((await f.query("SELECT to_regclass('public.offline_order_admission') IS NULL AS missing")).rows).toEqual([{ missing: true }]);
      expect(t.calls).toEqual([]);
    });
  }, 60_000);
  it('production auth still refuses a JWT when token storage is unavailable', async () => {
    await fixture(async t => {
      expect(await t.request('create', { money: '12.50', expected_pay_price: '10.00', from: 'h5', request_key: randomUUID() })).toEqual({ http: 503, status: 503, data: null });
      expect((await counts()).orders).toBe(0); expect(t.calls).toEqual([]);
    }, true);
  }, 60_000);
  it('H5 uses only the edge IP and detail/replay never initiates a second provider call', async () => {
    await fixture(async t => {
      const order = await t.create();
      expect(await t.request('pay', { order_id: order, pay_type: 'weixin' }, { headers: { 'X-Forwarded-For': '203.0.113.42', 'CF-Connecting-IP': '' } })).toMatchObject({ status: 400 });
      expect(t.calls).toHaveLength(0);
      const first = await t.request('pay', { order_id: order, pay_type: 'weixin', return_client:'h5' }, { headers: { 'CF-Connecting-IP': '203.0.113.42', 'X-Forwarded-For': '198.51.100.55', Origin:'https://attacker.example', Referer:'https://attacker.example/fake' } });
      expect(first).toMatchObject({ status: 200, data: { paid: false, state: 'READY', replayed: false, ticket: { kind: 'wechat-h5' } } });
      const ticket=record(record(first.data).ticket);
      expect(new URL(String(ticket.url)).searchParams.get('redirect_url')).toBe(`https://h5.example/offline-payment-return?orderId=${order}`);
      expect(await t.request(`detail/${order}`)).toMatchObject({ status: 200, data: { paid: false, state: 'READY', ticket: record(first.data).ticket } });
      expect(await t.request('pay', { order_id: order, pay_type: 'weixin', return_client:'pc' })).toMatchObject({ status: 200, data: { state: 'READY', replayed: true, ticket } });
      expect(await t.request('pay', { order_id: order, pay_type: 'yue' })).toMatchObject({ status: 409 });
      expect(t.calls).toHaveLength(1);
      expect(JSON.stringify(first.data)).not.toMatch(/frozen-local-payer|selection_key|attempt_key|case_id|private|PUBLIC KEY/);
      expect(await counts()).toMatchObject({ orders: 1, money: 0, bills: 0, selections: 1 });
    });
  }, 60_000);
  it('return client is a bounded enum in discovery and pay; arbitrary navigation inputs do not reserve or send',async()=>{
    await fixture(async t=>{
      const order=await t.create(),before=await counts();
      for(const value of ['',null,'native','https://attacker.example',{},['h5']])expect(await t.request('pay',{order_id:order,pay_type:'weixin',return_client:value})).toMatchObject({status:400,data:null});
      for(const name of ['return_url','redirect_url','quitUrl'])expect(await t.request('pay',{order_id:order,pay_type:'weixin',[name]:'https://attacker.example'})).toMatchObject({status:400,data:null});
      for(const suffix of ['return_client=','return_client=native','return_client=h5&return_client=pc','return_url=https://attacker.example'])
        expect(await t.request(`pay/type?order_id=${order}&${suffix}`)).toMatchObject({status:400,data:null});
      for(const client of ['pc','h5'])expect(await t.request(`pay/type?order_id=${order}&return_client=${client}`)).toMatchObject({status:200,data:{methods:{weixin:'available',alipay:'available'}}});
      expect(await counts()).toEqual(before);expect(t.calls).toEqual([]);
      const first=await t.request('pay',{order_id:order,pay_type:'alipay'});
      expect(first).toMatchObject({status:200,data:{state:'READY',paid:false}});
      const ticket=record(record(first.data).ticket);
      expect(new URL(String(ticket.url)).searchParams.get('return_url')).toBe(`https://shop.example/offline-payment-return?orderId=${order}`);
      expect(await t.request('pay',{order_id:order,pay_type:'alipay',return_client:'h5'})).toMatchObject({status:200,data:{ticket,replayed:true}});
      expect(t.calls).toEqual([]);
    });
  },60_000);
  it('unsigned provider response remains recoverable and GET never polls or settles the provider', async () => {
    await fixture(async t => {
      const order = await t.create(); t.unsigned(true);
      expect(await t.request('pay', { order_id: order, pay_type: 'weixin' }, { headers: { 'CF-Connecting-IP': '203.0.113.42' } })).toMatchObject({ status: 200, data: { paid: false, state: 'RECOVERY_REQUIRED' } });
      for (let i = 0; i < 3; i++) expect(await t.request(`detail/${order}`)).toMatchObject({ status: 200, data: { paid: false, state: 'RECOVERY_REQUIRED' } });
      expect(t.calls).toHaveLength(1); expect(await counts()).toMatchObject({ money: 0, bills: 0, savings: 0 });
    });
  }, 60_000);
  it('late wallet permission failure rolls back selection and payment; same order succeeds after repair', async () => {
    await fixture(async t => {
      const order = await t.create(); await f.exec(`REVOKE INSERT ON user_bill FROM "${t.r.role}"`);
      expect(await t.request('pay', { order_id: order, pay_type: 'yue' })).toEqual({ http: 503, status: 503, data: null });
      expect(await counts()).toMatchObject({ money: 0, bills: 0, selections: 0, savings: 0 });
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe('100.00');
      await f.exec(`GRANT INSERT ON user_bill TO "${t.r.role}"`);
      expect(await t.request('pay', { order_id: order, pay_type: 'yue' })).toMatchObject({ status: 200, data: { paid: true, state: 'PAID' } });
      expect(await counts()).toMatchObject({ money: 1, bills: 1, selections: 1, savings: 1 });
    });
  }, 60_000);
  it('a forged paid column or damaged receipt cannot produce a successful paid detail', async () => {
    await fixture(async t => {
      const order = await t.create();
      await f.db.update(otherOrder).set({ paid: 1, payType: 'yue' }).where(eq(otherOrder.orderId, order));
      expect(await t.request(`detail/${order}`)).toMatchObject({ status: 400, data: null });
      await f.db.update(otherOrder).set({ paid: 0, payType: '' }).where(eq(otherOrder.orderId, order));
      expect(await t.request('pay', { order_id: order, pay_type: 'yue' })).toMatchObject({ status: 200 });
      await f.db.transaction(tx => tx.execute(sql.raw('ALTER TABLE user_money DISABLE TRIGGER USER; UPDATE user_money SET number=1; ALTER TABLE user_money ENABLE TRIGGER USER')));
      expect(await t.request(`detail/${order}`)).toMatchObject({ status: 400, data: null });
      expect(t.calls).toEqual([]);
    });
  }, 60_000);
  it('account changes invalidate old JWTs and hidden/zero-price orders are never presented as payable', async () => {
    await fixture(async t => {
      const zero = (await seedHistoricalZeroOfflineOrder(f.db)).order_id;
      expect(await t.request(`detail/${zero}`)).toMatchObject({ status: 200, data: { state: 'UNAVAILABLE', paid: false } });
      const order = await t.create(); await f.db.update(otherOrder).set({ isDel: 1 }).where(eq(otherOrder.orderId, order));
      expect(await t.request(`detail/${order}`)).toMatchObject({ status: 200, data: { state: 'UNAVAILABLE', hidden: true, paid: false } });
      await f.db.update(user).set({ pwd: 'changed-http-password' }).where(eq(user.uid, 11));
      expect(Number((await t.request(`detail/${order}`)).status)).toBeGreaterThanOrEqual(410000);
      expect(t.calls).toEqual([]);
    });
  }, 60_000);
  it('enforces minimum payable across every channel and payment rail, preserving historical zero records without provider I/O', async () => {
    await fixture(async t => {
      for (const from of ['h5', 'wechat', 'weixinh5', 'routine']) {
        const before = await counts();
        expect(await t.request('check/price', { pay_price: '0.01' })).toMatchObject({ status: 400, data: null });
        for (const expected_pay_price of ['0.00', '0.01']) expect(await t.request('create', {
          money: '0.01', expected_pay_price, from, request_key: randomUUID(),
        })).toMatchObject({ status: 400, data: null });
        expect(await counts()).toEqual(before);
        const zero = (await seedHistoricalZeroOfflineOrder(f.db, from)).order_id;
        expect(await t.request(`detail/${zero}`)).toMatchObject({ status: 200, data: { state: 'UNAVAILABLE', paid: false, pay_price: '0.00' } });
        expect(await t.request(`pay/type?order_id=${zero}`)).toMatchObject({ status: 200, data: {
          methods: { yue: 'read_original', weixin: 'read_original', alipay: 'read_original' },
        } });
        const afterHistory = await counts();
        for (const pay_type of ['yue', 'weixin', 'alipay']) expect(await t.request('pay', { order_id: zero, pay_type })).toMatchObject({ status: 400, data: null });
        expect(await counts()).toEqual(afterHistory);
      }
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ nowMoney: '100.00', integral: 50 });
      expect(t.calls).toEqual([]);
      expect(await t.request('check/price', { pay_price: '0.02' })).toMatchObject({ status: 200, data: { pay_price: '0.01' } });
      const minimum = await t.create({ money: '0.02', expected_pay_price: '0.01' });
      for (let i = 0; i < 2; i++) expect(await t.request('pay', { order_id: minimum, pay_type: 'yue' })).toMatchObject({ status: 200, data: { paid: true, pay_price: '0.01' } });
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ nowMoney: '99.99', integral: 52 });
      expect(await counts()).toMatchObject({ money: 1, bills: 1, savings: 1, selections: 1 });
      expect(t.calls).toEqual([]);
    });
  }, 60_000);
  it('external paid details require the actual immutable receipt and source evidence, not provider return URLs', async () => {
    await fixture(async t => {
      const order = await t.create();
      expect(await t.request('pay', { order_id: order, pay_type: 'alipay' })).toMatchObject({ status: 200, data: { paid: false, state: 'READY', ticket: { kind: 'alipay-wap' } } });
      await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0 });
      const [row] = await f.db.select().from(paymentReconciliationCase);
      // Query transport runs in the already-tested Node recovery core here;
      // customer reads still run in workerd. Do not call this a callback E2E.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => t.api.alipayResponse(t.api.aliBody({ out_trade_no: order,
        send_pay_date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') }));
      try { expect(await new PaymentReconciliationService(createContainerFromDb(t.r.db), t.api.env).processMessage({ action: 'processPaymentReconciliation', caseId: row.id, replayKey: row.replayKey })).toBe('settled'); }
      finally { globalThis.fetch = originalFetch; }
      expect(await t.request(`detail/${order}`)).toMatchObject({ status: 200, data: { paid: true, state: 'PAID', pay_type: 'alipay' } });
      await f.db.transaction(tx => tx.execute(sql.raw('ALTER TABLE offline_order_query_evidence DISABLE TRIGGER USER; UPDATE offline_order_query_evidence SET evidence_hash=repeat(\'0\',64); ALTER TABLE offline_order_query_evidence ENABLE TRIGGER USER')));
      expect(await t.request(`detail/${order}`)).toMatchObject({ status: 400, data: null });
      expect(t.calls).toEqual([]); expect(await counts()).toMatchObject({ money: 0, bills: 1, savings: 1 });
    });
  }, 60_000);
});
