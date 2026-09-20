import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type V4FetchHandler } from 'miniflare';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createContainerFromDb } from '../src/lib/di';
import { memberRight, otherOrder, paymentReconciliationCase, systemAdmin, systemConfig, systemRole, user } from '../src/models/schema';
import { runOfflineOrderSchema } from '../src/migrations/runOfflineOrder';
import { OFFLINE_RUNTIME_READ_TABLES } from '../src/migrations/offlineOrderRuntimeContract';
import { admitOfflineOrder } from '../src/services/order/OfflineOrderAdmissionService';
import { payOfflineOrderBalance } from '../src/services/order/OfflineOrderBalanceService';
import { dispatchOfflineOrderPayment } from '../src/services/order/OfflineOrderPaymentDispatchService';
import { listAdminOfflineOrders, readAdminOfflineOrder } from '../src/services/admin/AdminOfflineOrderReadService';
import { PaymentReconciliationService } from '../src/services/payment/PaymentReconciliationService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { seedHistoricalZeroOfflineOrder } from './helpers/offlineLegacyZeroFixture';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';
import { createToken, md5 } from '../src/utils/jwt';
import { ApiErrorCode } from '../src/utils/errors';
import { parseOfflineDetail, parseOfflineList } from '../../view/admin-ts/src/utils/offlineOrderRead';
import { parseOfflineScan } from '../../view/admin-ts/src/utils/offlineScan';

type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected JSON object');
  return Object.fromEntries(Object.entries(value));
}
const rows = (value: unknown): Json[] => {
  if (!Array.isArray(value)) throw Error('Expected rows');
  return value.map(object);
};
describe('admin offline collection reads on native PG16 and real workerd authorization', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string, script: string, secret: string;
  let tokens: string[], customerToken: string, expiredToken: string, keys: ReturnType<typeof paymentQueryKeys>;
  const password = 'synthetic-admin-offline-password';
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    const kit = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(schema))).join('\n');
    const bundle = await build({ entryPoints: [resolve(import.meta.dirname, 'integration/AdminOfflineOrderHttpWorker.ts')],
      bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'],
      external: ['node:*', 'cloudflare:*'], tsconfig: resolve(import.meta.dirname, '../tsconfig.json') });
    script = bundle.outputFiles[0].text; secret = randomUUID(); keys = paymentQueryKeys();
    tokens = await Promise.all([1, 2, 3, 4].map(async id => (await createToken(id, 'admin', md5(password), secret)).token));
    customerToken = (await createToken(11, 'api', md5(password), secret)).token;
    expiredToken = (await createToken(1, 'admin', md5(password), secret, 'cinashop', Math.floor(Date.now()/1000)-8*86400)).token;
  }, 60_000);
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    await f.db.transaction(tx => tx.execute(sql.raw(ddl)));
    await runOfflineOrderSchema(f.db, true);
    await f.db.insert(user).values([11, 12].map(uid => ({ uid, account: `local-buyer-${uid}`, pwd: password,
      nickname: uid === 11 ? '本地_会员%\\甲' : '本地乙', phone: `138000000${uid}`, nowMoney: '100.00', integral: 50, isEverLevel: 1 })));
    await f.db.insert(systemConfig).values([{ menuName: 'member_card_status', value: '1' }, { menuName: 'order_give_integral', value: '1.234567' },
      { menuName: 'balance_func_status', value: '1' }, { menuName: 'yue_pay_status', value: '1' }]);
    await f.db.insert(memberRight).values([{ rightType: 'offline', number: 80, status: 1 }, { rightType: 'integral', number: 2, status: 1 }]);
    await f.db.insert(systemAdmin).values([1, 2, 3, 4].map(id => ({ id, account: `local-admin-${id}`, pwd: password,
      level: id === 1 ? 0 : 1, roles: id === 3 ? '2' : '1', adminType: id === 4 ? 2 : 1 })));
    await f.db.insert(systemRole).values([{ id: 1, roleName: 'read orders', rules: 'order.view' }, { id: 2, roleName: 'products only', rules: 'product.view' }]);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected external I/O'));
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);
  const actor = (id = 2) => ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now()/1000)+600 });
  const create = (uid = 11) => admitOfflineOrder(createContainerFromDb(f.db), { uid, requestKey: randomUUID(),
    orderNo: 'xx'+randomUUID().replaceAll('-', '').slice(0, 30), money: '12.50', expectedPayPrice: '10.00', from: 'h5' });
  const pay = (orderNo: string, uid = 11) => payOfflineOrderBalance(createContainerFromDb(f.db), { uid, orderNo });
  const state = async () => {
    // Complete row content, not just counts: reads must not change financial state.
    const result: Record<string, unknown> = {};
    for (const table of OFFLINE_RUNTIME_READ_TABLES) result[table] = (await f.query(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM public."${table}" t`)).rows;
    return result;
  };
  const readonly = <T>(work: (r: Runtime) => Promise<T>) => f.withRuntimeRole!(async r => {
    const names = [...OFFLINE_RUNTIME_READ_TABLES, 'system_admin', 'system_role', 'system_menus'];
    await f.exec(`GRANT SELECT ON ${names.map(name => `public."${name}"`).join(',')} TO "${r.role}";
      ALTER ROLE "${r.role}" SET default_transaction_read_only=on`);
    await r.exec('SET default_transaction_read_only=on');
    expect(await r.exec(`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
      current_setting('default_transaction_read_only') AS readonly FROM pg_roles WHERE rolname=current_user`))
      .toEqual([expect.objectContaining({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, readonly: 'on' })]);
    expect(await r.exec(`SELECT bool_or(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE')
      OR has_any_column_privilege(current_user,c.oid,'UPDATE') OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS writable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`)).toEqual([{ writable: false }]);
    return work(r);
  });
  type Request = (suffix?: string, token?: string, customerPath?: boolean) => Promise<{ http: number; status: unknown; data: Json | null }>;
  const http = <T>(work: (request: Request, r: Runtime) => Promise<T>, options: {
    provider?: V4FetchHandler; expectedCalls?: number; origin?: string;
  } = {}) => readonly(async r => {
    const calls: string[] = [];
    const outbound: V4FetchHandler = async (request, ...args) => {
      calls.push(request.url); return options.provider ? options.provider(request, ...args) : new LocalResponse(null, { status: 503 });
    };
    const mf = new Miniflare(convertV4MiniflareOptions({ script, modules: true, compatibilityDate: '2026-08-09', compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1', port: 0, hyperdrives: { HYPERDRIVE: r.connectionString }, outboundService: outbound, kvNamespaces: ['CONFIG_KV'],
      bindings: { APP_KEY: secret, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
        OFFLINE_H5_RETURN_ORIGIN: options.origin ?? 'https://cinashop-h5.pages.dev' } }));
    try {
      const request: Request = async (suffix = 'scan_list', token = tokens[1], customerPath = false) => {
        const response = await mf.dispatchFetch('http://localhost/'+(customerPath ? 'api/order/offline/' : 'adminapi/order/')+suffix,
          { headers: { Authorization: `Bearer ${token}` } });
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        const body = object(await response.json());
        if (body.status === 200 && !customerPath) {
          // The shipped frontend decoder must accept the actual workerd/SQL
          // projection, not only the independent browser's synthetic fixtures.
          const url = new URL('http://localhost/'+suffix);
          if (url.pathname === '/scan_list') parseOfflineList(body.data, {
            ...Object.fromEntries(url.searchParams), limit: Number(url.searchParams.get('limit') ?? 20),
          });
          else if (url.pathname === '/offline_scan') {
            parseOfflineScan(body.data, url.searchParams.get('type') === '0' ? 0 : 1);
            expect(object(body.data)).toMatchObject({ version: 'admin-offline-scan-v1', type: Number(url.searchParams.get('type') ?? 1),
              wechat_url: 'https://cinashop-h5.pages.dev/#/pages/annex/offline_pay/index' });
            expect(Object.keys(object(body.data)).sort()).toEqual(['version','type','wechat','wechat_url','routine','routine_status'].sort());
          } else parseOfflineDetail(body.data, url.pathname.split('/').at(-1)!);
        }
        return { http: response.status, status: body.status, data: body.data === null ? null : object(body.data) };
      };
      return await work(request, r);
    } finally { await mf.dispose(); expect.soft(calls).toHaveLength(options.expectedCalls ?? 0); }
  });

  it('scan entry is fixed, authenticated, readonly and explicitly reports absent mini-program configuration', async () => {
    await create(); const before = await state();
    await http(async request => {
      for (const token of ['', 'invalid', customerToken, tokens[2], tokens[3], expiredToken])
        expect((await request('offline_scan', token)).status).not.toBe(200);
      for (const query of ['', '?type=0', '?type=1']) {
        const data = (await request('offline_scan'+query)).data!;
        expect(data).toMatchObject({ routine: '', routine_status: 'not_configured' });
        expect(String(data.wechat)).toMatch(/^data:image\/svg\+xml;base64,/);
      }
      for (const query of ['type=2','type=0&type=1','url=https://evil.test','uid=11','amount=1'])
        expect(await request('offline_scan?'+query)).toMatchObject({status:400,data:null});
      await f.db.update(systemRole).set({rules:'product.view'}).where(eq(systemRole.id,1));
      expect((await request('offline_scan')).status).toBe(ApiErrorCode.ERR_AUTH);
    });
    expect(await state()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  }, 60_000);

  it('missing fixed H5 origin fails closed without using request host or database site_url', async () => {
    await f.db.insert(systemConfig).values({menuName:'site_url',value:'https://wrong.test'});
    await http(async request => { expect(await request('offline_scan')).toMatchObject({status:400,data:null}); }, {origin:''});
  }, 60_000);

  const miniConfig = () => f.db.insert(systemConfig).values([
    {menuName:'routine_appId',value:'synthetic-offline-app'}, {menuName:'routine_appsecret',value:'synthetic-offline-secret'},
  ]);
  const codePng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
  it('mini-program code uses only the fixed published cashier page and refreshes an invalid token once', async () => {
    await miniConfig(); const before = await state(); let tokensIssued=0, codes=0;
    await http(async request => {
      const result = await request('offline_scan?type=0');
      expect(result).toMatchObject({status:200,data:{routine_status:'ready'}});
      expect(result.data?.routine).toBe('data:image/png;base64,'+Buffer.from(codePng).toString('base64'));
    }, {expectedCalls:4, provider: async request => {
      const url = new URL(request.url); expect(url.origin).toBe('https://api.weixin.qq.com');
      if (url.pathname === '/cgi-bin/token') {
        expect(url.searchParams.get('appid')).toBe('synthetic-offline-app');
        expect(url.searchParams.get('secret')).toBe('synthetic-offline-secret');
        return LocalResponse.json({access_token:`token-${++tokensIssued}`,expires_in:7200});
      }
      expect(url.pathname).toBe('/wxa/getwxacode'); expect(request.method).toBe('POST');
      expect(await request.json()).toEqual({path:'pages/annex/offline_pay/index',check_path:true,env_version:'release',width:430});
      if (++codes === 1) return LocalResponse.json({errcode:40001,errmsg:'synthetic expired token'});
      return new LocalResponse(codePng,{headers:{'Content-Type':'image/png'}});
    }});
    expect(tokensIssued).toBe(2); expect(codes).toBe(2); expect(await state()).toEqual(before);
  }, 60_000);

  it('upstream redirect or active SVG is unavailable, without losing the independently rendered H5 entry', async () => {
    await miniConfig(); const before = await state();
    for (const bad of ['redirect','svg']) await http(async request => {
      expect(await request('offline_scan')).toMatchObject({status:200,data:{routine:'',routine_status:'unavailable'}});
    }, {expectedCalls:2, provider: async request => {
      if (new URL(request.url).pathname === '/cgi-bin/token') return LocalResponse.json({access_token:'token',expires_in:7200});
      return bad === 'redirect' ? new LocalResponse(null,{status:302,headers:{Location:'https://evil.test/leak'}})
        : new LocalResponse('<svg onload="alert(1)"/>',{headers:{'Content-Type':'image/svg+xml'}});
    }});
    expect(await state()).toEqual(before);
  }, 60_000);

  it('a role revoked while the provider is pending cannot receive a delayed code', async () => {
    await miniConfig();
    await http(async request => { expect((await request('offline_scan')).status).toBe(ApiErrorCode.ERR_AUTH); }, {
      expectedCalls:2, provider: async request => {
        if (new URL(request.url).pathname === '/cgi-bin/token') return LocalResponse.json({access_token:'token',expires_in:7200});
        await f.db.update(systemRole).set({rules:'product.view'}).where(eq(systemRole.id,1));
        return new LocalResponse(codePng,{headers:{'Content-Type':'image/png'}});
      },
    });
  }, 60_000);

  it('only actual wallet evidence yields PAID; unpaid, legacy zero and unadmitted records stay visible without payment capabilities', async () => {
    const paid = await create(), unpaid = await create(), zero = await seedHistoricalZeroOfflineOrder(f.db);
    await pay(paid.order_id);
    await f.db.insert(otherOrder).values({ uid: 11, orderId: 'legacy-paid-flag', type: 3, paid: 1, money: '5.00', payPrice: '5.00' });
    const before = await state();
    await http(async request => {
      const response = await request(); expect(response.status).toBe(200);
      expect(response.data).toMatchObject({ version: 'admin-offline-read-v1', limit: 20, next_cursor: '' });
      const list = rows(response.data?.list); expect(list).toHaveLength(4);
      expect(list.find(row => row.order_id === paid.order_id)).toMatchObject({ state: 'PAID', paid: true, recorded_paid: 1, pay_type: 'yue', money: '12.50', pay_price: '10.00', true_price: '2.50' });
      expect(list.find(row => row.order_id === unpaid.order_id)).toMatchObject({ state: 'UNPAID', paid: false });
      expect(list.find(row => row.order_id === zero.order_id)).toMatchObject({ state: 'UNAVAILABLE', paid: false, pay_price: '0.00' });
      expect(list.find(row => row.order_id === 'legacy-paid-flag')).toMatchObject({ state: 'UNVERIFIED', paid: null, recorded_paid: 1, pay_type: null, paid_at: null, reason: 'MISSING_ADMISSION' });
      for (const row of list) expect(Object.keys(row).sort()).toEqual(['id','order_id','uid','nickname','phone','account_available',
        'money','pay_price','true_price','add_time','hidden','recorded_paid','channel','paid','pay_type','paid_at','state','reason'].sort());
      expect(await request(`scan_detail/${paid.id}`)).toMatchObject({ status: 200, data: { record: list.find(row => row.id === paid.id) } });
    });
    expect(await state()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  }, 60_000);

  it('staff can inspect disabled customer history without letting that customer or another owner read it', async () => {
    const paid = await create(); await pay(paid.order_id);
    await f.db.update(otherOrder).set({ isDel: 1 }).where(eq(otherOrder.id, paid.id));
    await f.db.update(user).set({ status: 0, isDel: 1, deleteTime: new Date() }).where(eq(user.uid, 11));
    const before = await state();
    await http(async request => {
      expect(await request(`scan_detail/${paid.id}`)).toMatchObject({ status: 200, data: { record: { paid: true, state: 'PAID', hidden: true, account_available: false } } });
      expect((await request(`detail/${paid.order_id}`, customerToken, true)).status).not.toBe(200);
      const other = (await createToken(12, 'api', md5(password), secret)).token;
      expect((await request(`detail/${paid.order_id}`, other, true)).status).not.toBe(200);
    });
    expect(await state()).toEqual(before);
  }, 60_000);

  it('forged flags and damaged wallet evidence return UNVERIFIED, never a successful collection claim', async () => {
    const forged = await create(), damaged = await create(); await pay(damaged.order_id);
    await f.db.update(otherOrder).set({ paid: 1, payType: 'yue' }).where(eq(otherOrder.id, forged.id));
    // Explicit fault injection in this owned disposable database only.
    await f.db.transaction(tx => tx.execute(sql.raw('ALTER TABLE user_money DISABLE TRIGGER USER; UPDATE user_money SET number=1; ALTER TABLE user_money ENABLE TRIGGER USER')));
    const before = await state();
    await http(async request => {
      for (const id of [forged.id, damaged.id]) expect(await request(`scan_detail/${id}`)).toMatchObject({ status: 200,
        data: { record: { state: 'UNVERIFIED', paid: null, pay_type: null, paid_at: null, reason: 'EVIDENCE_MISMATCH' } } });
      expect(rows((await request('scan_list?recorded_paid=1')).data?.list).every(row => row.paid === null)).toBe(true);
    });
    expect(await state()).toEqual(before);
  }, 60_000);

  it('exact identifiers, literal nickname/phone searches and half-open dates never broaden no-match filters', async () => {
    const a = await create(), b = await create(12);
    await f.db.insert(otherOrder).values([{ uid: 11, orderId: 'membership-not-offline', type: 1 }, { uid: 11, orderId: 'recharge-not-offline', type: 0 }]);
    const [source] = await f.db.select().from(otherOrder).where(eq(otherOrder.id, a.id));
    await http(async request => {
      for (const term of ['_', '%', '\\', '13800000011']) {
        expect(rows((await request('scan_list?name='+encodeURIComponent(term))).data?.list).map(row => row.id)).toEqual([a.id]);
      }
      for (const query of ['name=absent-user', 'uid=13', 'order_id=absent-order', `from=${source.addTime+1}&to=${source.addTime+2}`])
        expect(await request('scan_list?'+query)).toMatchObject({ status: 200, data: { list: [], next_cursor: '' } });
      expect(rows((await request('scan_list?uid=12')).data?.list).map(row => row.id)).toEqual([b.id]);
      expect(rows((await request(`scan_list?order_id=${a.order_id}&from=${source.addTime}&to=${source.addTime+1}`)).data?.list).map(row => row.id)).toEqual([a.id]);
      expect(rows((await request()).data?.list).map(row => row.id)).toEqual([b.id, a.id]);
      const [foreign] = await f.db.select().from(otherOrder).where(eq(otherOrder.orderId, 'membership-not-offline'));
      expect((await request(`scan_detail/${foreign.id}`)).status).toBe(404);
    });
  }, 60_000);

  it('bounded keyset pagination has no duplicate/skip when a new record arrives between pages', async () => {
    const created: Awaited<ReturnType<typeof create>>[] = []; for (let i=0; i<23; i++) created.push(await create());
    await http(async request => {
      const first = (await request()).data!;
      expect(rows(first.list).map(row => row.id)).toEqual(created.slice(3).reverse().map(row => row.id));
      expect(first.next_cursor).toBe(String(created[3].id));
      const added = await create(); const before = await state();
      const second = (await request('scan_list?before='+first.next_cursor)).data!;
      expect(rows(second.list).map(row => row.id)).toEqual(created.slice(0,3).reverse().map(row => row.id));
      expect(second.next_cursor).toBe(''); expect(rows(second.list).some(row => row.id === added.id)).toBe(false);
      expect(await state()).toEqual(before);
    });
  }, 90_000);

  it('real JWT/role authorization rejects anonymous, customer, shop, unrelated, expired and revoked accounts', async () => {
    await create();
    await http(async request => {
      for (const token of ['', 'invalid', customerToken, tokens[2], tokens[3], expiredToken]) expect((await request('scan_list', token)).status).not.toBe(200);
      expect((await request('scan_list', tokens[0])).status).toBe(200);
      expect((await request()).status).toBe(200);
      await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 1));
      expect((await request()).status).toBe(ApiErrorCode.ERR_AUTH);
      await f.db.update(systemRole).set({ status: 1, rules: 'product.view' }).where(eq(systemRole.id, 1));
      expect((await request()).status).toBe(ApiErrorCode.ERR_AUTH);
      await f.db.update(systemRole).set({ rules: 'order.view' }).where(eq(systemRole.id, 1));
      for (const change of [{ status: 0 }, { status: 2 }, { isDel: 1 }, { pwd: 'changed-local-password' }]) {
        await f.db.update(systemAdmin).set({ status: 1, isDel: 0, pwd: password, ...change }).where(eq(systemAdmin.id, 2));
        expect((await request()).status).not.toBe(200);
      }
    });
  }, 60_000);

  it('service independently reloads actor credentials and role authority inside its read-only transaction', async () => {
    const order = await create();
    await readonly(async r => {
      const container = createContainerFromDb(r.db);
      expect(await readAdminOfflineOrder(container, actor(), order.id)).toMatchObject({ record: { state: 'UNPAID' } });
      for (const invalid of [{ id: 2147483648 }, { authVersion: '0'.repeat(32) }, { expiresAt: 1 }])
        await expect(listAdminOfflineOrders(container, { ...actor(), ...invalid }, {})).rejects.toThrow();
      await f.db.update(systemAdmin).set({ roles: '2' }).where(eq(systemAdmin.id, 2));
      await expect(listAdminOfflineOrders(container, actor(), {})).rejects.toThrow();
      await f.db.update(systemAdmin).set({ roles: '1', status: 0 }).where(eq(systemAdmin.id, 2));
      await expect(listAdminOfflineOrders(container, actor(), {})).rejects.toThrow();
    });
  }, 60_000);

  it('rejects legacy pagination, unknown/repeated parameters and noncanonical IDs instead of changing query meaning', async () => {
    const order = await create(), before = await state();
    await http(async request => {
      for (const query of ['page=1', 'add_time=today', 'limit=21', 'limit=0', 'limit=01', 'before=-1', 'before=2147483648',
        'uid=1.5', 'name=', 'name=%0A', 'from=1', 'to=2', 'from=2&to=1', 'recorded_paid=true', 'paid=1', 'order_id=',
        'order_id=abc%20def', 'limit=1&limit=2', 'name='+('a'.repeat(1201))])
        expect(await request('scan_list?'+query)).toMatchObject({ status: 400, data: null });
      for (const suffix of ['0','01','2147483648','1.5',`${order.id}?uid=12`])
        expect(await request('scan_detail/'+suffix)).toMatchObject({ status: 400, data: null });
    });
    expect(await state()).toEqual(before);
  }, 60_000);

  it.each(['permission', 'installation'])('missing %s fails as unavailable, not an empty or unverified success', async failure => {
    const order = await create();
    await http(async (request, r) => {
      if (failure === 'permission') await f.exec(`REVOKE SELECT ON offline_order_admission FROM "${r.role}"`);
      else await f.exec('ALTER TABLE offline_order_admission RENAME TO hidden_admin_read_admission');
      for (const suffix of ['scan_list', `scan_detail/${order.id}`]) expect(await request(suffix)).toEqual({ http: 503, status: 503, data: null });
    });
  }, 60_000);

  it('schema lock contention returns unavailable without a partial list or financial effects', async () => {
    await create(); const before = await state();
    await http(async request => f.withPeer!(async peer => {
      await peer.exec('BEGIN; LOCK TABLE offline_order_admission IN ACCESS EXCLUSIVE MODE');
      try { expect(await request()).toEqual({ http: 503, status: 503, data: null }); }
      finally { await peer.exec('ROLLBACK'); }
    }));
    expect(await state()).toEqual(before);
  }, 60_000);

  it('duplicate identity and orphan legacy rows remain visible while the admission FK prevents customer removal', async () => {
    const duplicate = await create(), protectedOrder = await create(12);
    await f.db.insert(otherOrder).values({ uid: 11, orderId: duplicate.order_id, type: 3, paid: 1 });
    await expect(f.db.delete(user).where(eq(user.uid, 12))).rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ooa_user_fk' } });
    const [orphan] = await f.db.insert(otherOrder).values({ uid: 999, orderId: 'orphan-legacy-row', type: 3, paid: 1 }).returning();
    await http(async request => {
      expect(await request(`scan_detail/${duplicate.id}`)).toMatchObject({ status: 200, data: { record: { paid: null, state: 'UNVERIFIED', reason: 'EVIDENCE_MISMATCH' } } });
      expect(await request(`scan_detail/${orphan.id}`)).toMatchObject({ status: 200, data: { record: { paid: null, state: 'UNVERIFIED', reason: 'MISSING_ADMISSION', account_available: false } } });
      expect(await request(`scan_detail/${protectedOrder.id}`)).toMatchObject({ status: 200, data: { record: { paid: false, state: 'UNPAID', account_available: true } } });
      expect(rows((await request()).data?.list)).toHaveLength(4);
    });
  }, 60_000);

  it('transaction-local read-only isolation and tighter timeout are preserved without leaking settings', async () => {
    const order = await create();
    await readonly(async r => {
      for (const [initial, effective] of [['0', '5s'], ['750ms', '750ms']]) {
        await r.exec(`SET statement_timeout='${initial}'`);
        const original = PostgresJsSession.prototype.prepareQuery;
        let observed = false;
        const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
          const prepared = original.apply(this, args);
          if (!observed && args[0].sql.includes('from "offline_order_admission"')) {
            const execute = prepared.execute.bind(prepared);
            prepared.execute = async (...params) => {
              observed = true;
              const [settings] = await this.client.unsafe("SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation, current_setting('statement_timeout') AS timeout");
              expect(settings).toEqual({ readonly: 'on', isolation: 'repeatable read', timeout: effective });
              return execute(...params);
            };
          }
          return prepared;
        });
        try {
          expect(await readAdminOfflineOrder(createContainerFromDb(r.db), actor(), order.id)).toMatchObject({ record: { state: 'UNPAID' } });
          expect(observed).toBe(true);
        } finally { spy.mockRestore(); }
        expect(await r.exec("SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_isolation') AS isolation"))
          .toEqual([{ timeout: initial, isolation: 'read committed' }]);
      }
    });
  }, 60_000);

  it('external pending never discloses a payment ticket; paid requires real signed query evidence and damage is visible', async () => {
    const order = await create(), container = createContainerFromDb(f.db), api = await paymentQueryFixture(container, keys);
    await f.db.insert(systemConfig).values(Object.entries({ ...api.config, cfg_ali_pay_status: '1' }).map(([name,value]) => ({ menuName: name.slice(4), value })));
    api.env.ALIPAY_NOTIFY_URL = 'https://query.example/api/pay/notify/alipay';
    api.env.ALIPAY_RETURN_URL = 'https://shop.example/payment';
    expect(await dispatchOfflineOrderPayment(container, api.env, { uid: 11, orderNo: order.order_id, provider: 'alipay', clientIp: '203.0.113.42' })).toMatchObject({ status: 'READY' });
    expect(fetch).not.toHaveBeenCalled();
    await http(async request => {
      const before = await state();
      const pending = await request(`scan_detail/${order.id}`);
      expect(pending).toMatchObject({ status: 200, data: { record: { paid: false, state: 'PENDING', pay_type: 'alipay' } } });
      expect(JSON.stringify(pending)).not.toMatch(/ticket|display_until|payer|transaction|request_key|sign|KEY|gateway/);
      expect(await state()).toEqual(before);
      await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0 });
      const [recovery] = await f.db.select().from(paymentReconciliationCase);
      // Real query validation/settlement in Node with a local synthetic RSA
      // response; staff reads below still use actual workerd and SELECT-only SQL.
      vi.mocked(fetch).mockImplementation(async () => api.alipayResponse(api.aliBody({ out_trade_no: order.order_id,
        send_pay_date: new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace('T',' ') })));
      expect(await new PaymentReconciliationService(container, api.env).processMessage({ action: 'processPaymentReconciliation', caseId: recovery.id, replayKey: recovery.replayKey })).toBe('settled');
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.mocked(fetch).mockRejectedValue(Error('Unexpected external I/O'));
      const settled = await state();
      expect(await request(`scan_detail/${order.id}`)).toMatchObject({ status: 200, data: { record: { paid: true, state: 'PAID', pay_type: 'alipay' } } });
      expect(await state()).toEqual(settled);
      await f.db.transaction(tx => tx.execute(sql.raw("ALTER TABLE offline_order_query_evidence DISABLE TRIGGER USER; UPDATE offline_order_query_evidence SET evidence_hash=repeat('0',64); ALTER TABLE offline_order_query_evidence ENABLE TRIGGER USER")));
      expect(await request(`scan_detail/${order.id}`)).toMatchObject({ status: 200, data: { record: { paid: null, state: 'UNVERIFIED', reason: 'EVIDENCE_MISMATCH' } } });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it('a real concurrent settlement cannot mix newly-paid rows into the existing read-only snapshot', async () => {
    const order = await create();
    await readonly(async r => {
      const original = PostgresJsSession.prototype.prepareQuery;
      let changed = false;
      const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
        const prepared = original.apply(this, args);
        if (!changed && args[0].sql.includes('from "offline_order_admission"')) {
          const execute = prepared.execute.bind(prepared);
          prepared.execute = async (...params) => {
            if (!changed) { changed = true; await pay(order.order_id); }
            return execute(...params);
          };
        }
        return prepared;
      });
      try {
        expect(await readAdminOfflineOrder(createContainerFromDb(r.db), actor(), order.id)).toMatchObject({ record: { paid: false, state: 'UNPAID' } });
        expect(changed).toBe(true);
      } finally { spy.mockRestore(); }
      expect(await readAdminOfflineOrder(createContainerFromDb(r.db), actor(), order.id)).toMatchObject({ record: { paid: true, state: 'PAID' } });
    });
  }, 60_000);
});
