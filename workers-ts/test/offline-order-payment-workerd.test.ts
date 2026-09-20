import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { randomUUID, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type V4FetchHandler } from 'miniflare';
import { sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { memberRight, otherOrder, paymentReconciliationCase, systemConfig, user, wechatUser } from '../src/models/schema';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL } from '../src/migrations/offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL } from '../src/migrations/offlineOrderBalance';
import { OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL } from '../src/migrations/offlineOrderExternalPayment';
import { OFFLINE_ORDER_CALLBACK_DOMAIN_SQL } from '../src/migrations/offlineOrderCallbackDomain';
import { OFFLINE_ORDER_PAYMENT_DISPATCH_SQL } from '../src/migrations/offlineOrderPaymentDispatch';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';
import { offlineRuntimeGrantPlan } from '../src/migrations/offlineOrderRuntimeContract';

type Channel = 'h5' | 'wechat' | 'routine' | 'alipay';
type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };

describe('workerd → local Hyperdrive → native PG16 offline payment', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string, script: string;
  let keys: ReturnType<typeof paymentQueryKeys>;
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required; no production or PGlite fallback');
    ddl = await offlinePredecessorSchemaSql();
    keys = paymentQueryKeys();
    const result = await build({ entryPoints: [resolve(import.meta.dirname, 'integration/OfflinePaymentWorkerdScenario.ts')],
      bundle: true, write: false, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'],
      external: ['node:*', 'cloudflare:*'], target: 'es2022', tsconfig: resolve(import.meta.dirname, '../tsconfig.json') });
    script = result.outputFiles[0].text;
  }, 60_000);
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    await f.db.transaction(async tx => {
      for (const source of [ddl, OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_BALANCE_SQL,
        OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL, OFFLINE_ORDER_CALLBACK_DOMAIN_SQL, OFFLINE_ORDER_PAYMENT_DISPATCH_SQL]) await tx.execute(sql.raw(source));
    });
    await f.db.insert(user).values({ uid: 11, account: 'workerd-local-buyer', nowMoney: '100.00', integral: 50, isEverLevel: 1 });
    await f.db.insert(systemConfig).values([{ menuName: 'member_card_status', value: '1' }, { menuName: 'order_give_integral', value: '1.234567' }]);
    await f.db.insert(memberRight).values([{ rightType: 'offline', number: 80, status: 1 }, { rightType: 'integral', number: 2, status: 1 }]);
  }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);

  async function grants(r: Runtime) {
    await f.exec(offlineRuntimeGrantPlan(r.role));
  }
  async function scenario<T>(channel: Channel, work: (t: {
    call: (operation: string, expectedStatus?: number) => Promise<unknown>;
    r: Runtime; orderNo: string; calls: string[]; failures: unknown[];
    setMode: (mode: 'success' | 'lost' | 'invalid-query') => void;
  }) => Promise<T>) {
    return f.withRuntimeRole!(async r => {
      await grants(r);
      if (channel === 'wechat' || channel === 'routine') await f.db.insert(wechatUser).values({
        uid: 11, openid: 'frozen-local-payer', userType: channel,
      });
      const api = await paymentQueryFixture(createContainerFromDb(r.db), keys);
      await f.db.insert(systemConfig).values(Object.entries({...api.config,cfg_pay_weixin_open:'1',cfg_ali_pay_status:'1'})
        .map(([name,value])=>({menuName:name.slice(4),value})));
      const orderNo = 'xx' + randomUUID().replaceAll('-', '').slice(0, 30), token = randomUUID();
      const calls: string[] = [], failures: unknown[] = [];
      let mode: 'success' | 'lost' | 'invalid-query' = 'success';
      const outbound: V4FetchHandler = async request => {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        try {
          const active = await f.query(`SELECT pid FROM pg_stat_activity WHERE usename='${r.role}' AND xact_start IS NOT NULL`);
          expect(active.rows).toEqual([]); // External I/O never holds a financial transaction.
          const u = new URL(request.url), body = await request.text();
          if (u.origin === 'https://api.mch.weixin.qq.com' && request.method === 'POST') {
            expect(u.pathname).toBe(`/v3/pay/transactions/${channel === 'h5' ? 'h5' : 'jsapi'}`);
            expect(JSON.parse(body)).toMatchObject({ appid: 'wx-local-query', mchid: '1234567890', out_trade_no: orderNo,
              attach: 'offline_order', amount: { total: 1000, currency: 'CNY' },
              ...(channel === 'h5' ? { scene_info: { payer_client_ip: '203.0.113.42' } } : { payer: { openid: 'frozen-local-payer' } }) });
            const fields = Object.fromEntries([...(request.headers.get('Authorization') ?? '').matchAll(/(\w+)="([^"]+)"/g)].map(m => [m[1], m[2]]));
            expect(fields).toMatchObject({ mchid: '1234567890', serial_no: 'ABCDEF123456' });
            expect(verify('RSA-SHA256', Buffer.from(`POST\n${u.pathname}\n${fields.timestamp}\n${fields.nonce_str}\n${body}\n`),
              keys.publicKey, Buffer.from(fields.signature, 'base64'))).toBe(true);
            expect((await f.query('SELECT state FROM offline_order_payment_dispatch')).rows).toEqual([{ state: 'ISSUING' }]);
            if (mode === 'lost') return new LocalResponse('simulated unsigned failure', { status: 502 });
            const response = api.wechatResponse(channel === 'h5'
              ? { h5_url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=local' } : { prepay_id: 'workerd-local' });
            return new LocalResponse(await response.text(), { headers: Object.fromEntries(response.headers) });
          }
          expect(api.verifyRequest(request.url, { method: request.method, body, headers: Object.fromEntries(request.headers) })).toBe(true);
          if (channel === 'alipay') {
            expect(u.href).toBe('https://openapi.alipay.com/gateway.do');
            expect(JSON.parse(new URLSearchParams(body).get('biz_content') ?? '{}')).toMatchObject({ out_trade_no: orderNo });
          } else expect(u.pathname).toBe(`/v3/pay/transactions/out-trade-no/${orderNo}`);
          const response = channel === 'alipay'
            ? api.alipayResponse(api.aliBody({ out_trade_no: orderNo, send_pay_date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') }))
            : api.wechatResponse(api.wxBody({ out_trade_no: orderNo, trade_type: channel === 'h5' ? 'MWEB' : 'JSAPI', success_time: new Date().toISOString() }));
          return new LocalResponse(await response.text(), { headers: mode === 'invalid-query' ? {} : Object.fromEntries(response.headers) });
        } catch (error) { failures.push(error); return new LocalResponse('local gateway assertion failed', { status: 503 }); }
      };
      const { CONFIG_KV: _ignoredFakeKv, ...bindings } = api.bindings;
      // Same supported V4→V5 conversion used by this repository's Workers pool.
      const mf = new Miniflare(convertV4MiniflareOptions({ script, modules: true, compatibilityDate: '2026-08-09', compatibilityFlags: ['nodejs_compat'],
        host: '127.0.0.1', port: 0, kvNamespaces: ['CONFIG_KV'], hyperdrives: { HYPERDRIVE: r.connectionString },
        bindings: { ...bindings, APP_KEY: token, ALIPAY_NOTIFY_URL: 'https://query.example/api/pay/notify/alipay',
          ALIPAY_RETURN_URL: 'https://shop.example/payment' }, outboundService: outbound }));
      try {
        const kv = await mf.getKVNamespace('CONFIG_KV');
        for (const [key, value] of Object.entries({ ...api.config, cfg_pay_weixin_open: '1', cfg_ali_pay_status: '1' })) await kv.put(key, value);
        const denied = await mf.dispatchFetch('http://localhost/identity'); expect(denied.status).toBe(403);
        const identity = await mf.dispatchFetch('http://localhost/identity', { headers: { Authorization: `Bearer ${token}` } });
        expect(identity.status).toBe(200);
        const actual = await identity.json();
        expect(actual).toMatchObject({ role: r.role, database: new URL(r.connectionString).pathname.slice(1), login: true,
          owner: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
        expect(actual).not.toMatchObject({ pid: r.pid }); // Not the harness's postgres.js backend.
        const beforeAudit = await counts();
        const deniedAudit = await mf.dispatchFetch('http://localhost/audit'); expect(deniedAudit.status).toBe(403);
        const auditResponse = await mf.dispatchFetch('http://localhost/audit', { headers: { Authorization: `Bearer ${token}` } });
        expect(auditResponse.status).toBe(200);
        const report = await auditResponse.json();
        expect(report).toMatchObject({scope:'offline-cashier-collection-v1',ready:true,readOnly:true,
          completeApplicationVerified:false,businessDataVerified:false,failures:[]});
        expect(JSON.stringify(report)).not.toContain(r.role);
        expect(await counts()).toEqual(beforeAudit); expect(calls).toEqual([]);
        const call = async (operation: string, expectedStatus = 200) => {
          const response = await mf.dispatchFetch(`http://localhost/${operation}/${orderNo}/${channel}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
          });
          const result = await response.json(); expect({ status: response.status, result }).toMatchObject({ status: expectedStatus });
          return result;
        };
        expect(await call('admit')).toMatchObject({ order_id: orderNo, pay_price: '10.00', paid: false });
        return await work({ call, r, orderNo, calls, failures, setMode: value => { mode = value; } });
      } finally { await mf.dispose(); }
    });
  }
  const counts = async () => (await f.query(`SELECT
    (SELECT count(*)::integer FROM offline_order_payment_selection) AS selections,
    (SELECT count(*)::integer FROM offline_order_payment_dispatch) AS dispatches,
    (SELECT count(*)::integer FROM offline_order_query_evidence) AS queries,
    (SELECT count(*)::integer FROM offline_order_external_payment) AS receipts,
    (SELECT count(*)::integer FROM user_money) AS money,
    (SELECT count(*)::integer FROM user_bill) AS bills,
    (SELECT count(*)::integer FROM store_order_economize) AS savings`)).rows[0];
  const assertPaid = async () => {
    expect(await counts()).toEqual({ selections: 1, dispatches: 1, queries: 1, receipts: 1, money: 0, bills: 1, savings: 1 });
    expect((await f.db.select().from(user))[0]).toMatchObject({ nowMoney: '100.00', integral: 64, isEverLevel: 1, overdueTime: 0 });
    expect((await f.db.select().from(otherOrder))[0]).toMatchObject({ type: 3, paid: 1, payPrice: '10.00' });
  };
  it.each(['h5', 'wechat', 'routine', 'alipay'] as const)('%s prepares, replays and settles once through signed query', async channel => {
    await scenario(channel, async t => {
      const first = await t.call('dispatch'); expect(first).toMatchObject({ status: 'READY', replayed: false });
      if (!first || typeof first !== 'object') throw Error('Missing dispatch object');
      expect(await t.call('dispatch')).toEqual({ ...first, replayed: true });
      expect(t.calls).toHaveLength(channel === 'alipay' ? 0 : 1);
      expect(await counts()).toMatchObject({ receipts: 0, bills: 0, money: 0 });
      await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0 });
      expect(await t.call('recover')).toEqual({ result: 'settled' });
      expect(await t.call('dispatch')).toEqual({ status: 'PAID', replayed: true });
      await t.call('recover'); await assertPaid();
      expect(t.calls).toHaveLength(channel === 'alipay' ? 1 : 2); expect(t.failures).toEqual([]);
    });
  }, 60_000);
  it('lost initiation cannot reissue; unsigned query cannot pay; valid recovery pays once', async () => {
    await scenario('h5', async t => {
      t.setMode('lost'); expect(await t.call('dispatch')).toEqual({ status: 'RECOVERY_REQUIRED', replayed: false });
      expect(await t.call('dispatch')).toEqual({ status: 'RECOVERY_REQUIRED', replayed: true });
      expect(t.calls).toHaveLength(1);
      t.setMode('invalid-query'); await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0 });
      await t.call('recover'); expect(await counts()).toMatchObject({ receipts: 0, queries: 0, bills: 0, savings: 0 });
      t.setMode('success'); await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0 });
      expect(await t.call('recover')).toEqual({ result: 'settled' });
      expect(await t.call('dispatch')).toEqual({ status: 'PAID', replayed: true });
      await assertPaid(); expect(t.calls).toHaveLength(3); expect(t.failures).toEqual([]);
    });
  }, 60_000);
  it('denied initial intent insert rolls back before gateway I/O', async () => {
    await scenario('h5', async t => {
      await f.exec(`REVOKE INSERT ON offline_order_payment_dispatch FROM "${t.r.role}"`);
      expect(await t.call('dispatch', 500)).toEqual({ error: '42501' });
      expect(t.calls).toEqual([]); expect(t.failures).toEqual([]);
      expect(await counts()).toEqual({ selections: 0, dispatches: 0, queries: 0, receipts: 0, bills: 0, savings: 0, money: 0 });
      expect((await f.db.select().from(paymentReconciliationCase))).toEqual([]);
    });
  }, 60_000);
  it('denied reward write rolls financial settlement back, then durable evidence retries without query', async () => {
    await scenario('h5', async t => {
      await t.call('dispatch'); await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0 });
      await f.exec(`REVOKE INSERT ON user_bill FROM "${t.r.role}"`);
      await t.call('recover');
      expect(await counts()).toMatchObject({ queries: 1, receipts: 0, bills: 0, savings: 0, money: 0 });
      expect((await f.db.select().from(user))[0]).toMatchObject({ integral: 50, nowMoney: '100.00' });
      expect((await f.db.select().from(otherOrder))[0].paid).toBe(0);
      await f.exec(`GRANT INSERT ON user_bill TO "${t.r.role}"`);
      await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0 });
      expect(await t.call('recover')).toEqual({ result: 'settled' }); await assertPaid();
      expect(t.calls).toHaveLength(2); expect(t.failures).toEqual([]);
    });
  }, 60_000);
});
