import { createCipheriv, sign, verify } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { systemConfig, user, wechatUser, storeOrder, paymentReconciliationCase, paymentReconciliationAction } from '@/models/schema';
import { ROUTINE_IDENTITY_WITNESS_SQL } from '@/migrations/routineIdentityWitness';
import { ROUTINE_PAYMENT_ATTEMPT_SQL } from '@/migrations/routinePaymentAttempt';
import { appendRoutineIdentityWitness } from '@/services/wechat/RoutineIdentityWitness';
import { readRoutineCredentials } from '@/services/wechat/RoutineRuntimeConfig';
import { issueRoutineIdentityObservation } from '@/services/wechat/RoutineIdentityObservation';
import { readPaymentPublicConfig, readPaymentPublicConfigInTx, withRoutinePaymentPublicSource } from '@/services/payment/PaymentPublicRuntimeConfig';
import { getPaymentReadinessSnapshot, assertWechatPaymentProfileAvailable } from '@/services/payment/PaymentReadinessService';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const APP = 'wxownedRoutine001', OTHER = 'wxotherRoutine002', MCH = '1900000109', SERIAL = 'OWNED_PLATFORM_KEY', V3 = 'r'.repeat(32);
const ORDER = 'owned_routine_order', PREPAY = 'owned_routine_prepay', PAYER = 'owned_routine_payer';
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const base = () => ({ routine_appId: APP, pay_weixin_mchid: MCH, pay_weixin_serial_no: 'ABCDEF123456',
  pay_weixin_open: '1', site_url: 'https://owned.example', ali_pay_status: '0', balance_func_status: '1', yue_pay_status: '1', offline_pay_status: '1' });

describe('Mini payment fresh public SQL source and real merchant cryptography', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env, depth = 0, keys: ReturnType<typeof paymentQueryKeys>;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const observe = (db: DbClient): DbClient => new Proxy(db, { get(target, key, receiver) {
    const method = Reflect.get(target, key, receiver) as unknown;
    if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (action: (tx: DbClient) => Promise<unknown>, ...args: unknown[]) => Reflect.apply(method, target, [async (tx: DbClient) => {
      depth++; try { return await action(observe(tx)); } finally { depth--; }
    }, ...args]);
  } });
  const container = () => createContainerFromDb(observe(f.db));
  const current = () => readPaymentPublicConfig(container(), 'routine');
  const rows = () => f.db.select().from(systemConfig).orderBy(systemConfig.id);
  const update = (key: string, value: string) => f.db.update(systemConfig).set({ value: JSON.stringify(value) }).where(eq(systemConfig.menuName, key));
  const source = () => new WechatPayService(container(), env);
  const create = (extra: Partial<Parameters<WechatPayService['createOrder']>[0]> = {}) => source().createOrder({ profile: 'routine', type: 'jsapi',
    outTradeNo: ORDER, description: 'Owned Mini payment', amount: 12.50, attach: 'product', routinePayer: { uid: 7, orderId: 7, orderDomain: 'store_order', lockOrder: async bound => {
      const [row] = await bound.db.select().from(storeOrder).where(eq(storeOrder.id, 7)).for('update');
      if (!row || row.uid !== 7 || row.orderId !== ORDER || row.paid !== 0 || row.payPrice !== '12.50') throw Error('Owned order changed');
    } }, ...extra });
  const signature = (raw: string) => Buffer.from(sign('RSA-SHA256', Buffer.from(raw), keys.privateKey)).toString('base64');
  const response = (value: unknown, status = 200) => {
    const raw = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'owned_payment_response';
    return new Response(raw, { status, headers: { 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce, 'Wechatpay-Serial': SERIAL,
      'Wechatpay-Signature': signature(`${timestamp}\n${nonce}\n${raw}\n`) } });
  };
  const facts = () => ({ appid: APP, mchid: MCH, out_trade_no: ORDER, transaction_id: 'owned_routine_transaction', trade_state: 'SUCCESS', trade_type: 'JSAPI',
    payer: { openid: PAYER }, amount: { total: 1250, currency: 'CNY' }, success_time: '2026-10-29T12:00:00+08:00' });
  const notification = () => {
    const nonce = 'routine_nonce', aad = 'transaction', cipher = createCipheriv('aes-256-gcm', Buffer.from(V3), Buffer.from(nonce)); cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(facts())), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const raw = JSON.stringify({ id: 'owned_mini_payment_event', resource_type: 'encrypt-resource', resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', nonce, associated_data: aad, ciphertext } });
    const timestamp = String(Math.floor(Date.now() / 1000)), outerNonce = 'owned_callback_nonce';
    return { raw, headers: { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': outerNonce, 'wechatpay-serial': SERIAL,
      'wechatpay-signature': signature(`${timestamp}\n${outerNonce}\n${raw}\n`) } };
  };
  beforeAll(async () => {
    if (!native) throw Error('Actual owned PG16 required for payment/witness/catalog locking');
    keys = paymentQueryKeys(); f = await financePostgres([systemConfig, user, wechatUser, storeOrder, paymentReconciliationCase, paymentReconciliationAction], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX routine_payment_fixture_case_uq ON public.payment_reconciliation_case(provider,order_no)');
  }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    depth = 0;
    await f.exec('DROP TABLE IF EXISTS public.routine_payment_attempt'); await f.exec('DROP FUNCTION IF EXISTS public.routine_payment_attempt_immutable_v1()');
    await f.exec('DROP TABLE IF EXISTS public.routine_identity_witness'); await f.exec('DROP FUNCTION IF EXISTS public.routine_identity_witness_immutable_v1()');
    await f.reset(); await f.exec(ROUTINE_IDENTITY_WITNESS_SQL); await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL); await f.db.insert(systemConfig).values(Object.entries(base()).map(([menuName, value], i) => ({ id: i + 1, menuName, value: JSON.stringify(value), sort: 5 })));
    env = { APP_KEY: 'owned-payment-identity-witness-key', WECHAT_MCH_PRIVATE_KEY: keys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey, WECHAT_PLATFORM_PUBLIC_KEY_ID: SERIAL,
      WECHAT_API_V3_KEY: V3, CONFIG_KV: { get: vi.fn(async () => { throw Error('Payment public cfg KV forbidden'); }), put: vi.fn(), delete: vi.fn() } } as unknown as Env;
    await f.db.insert(user).values({ uid: 7, account: 'owned-payment-user', status: 1 });
    await f.db.insert(wechatUser).values({ id: 7, uid: 7, openid: PAYER, userType: 'routine' });
    await f.db.insert(storeOrder).values({ id: 7, uid: 7, orderId: ORDER, payPrice: '12.50', paid: 0 });
    await f.db.insert(systemConfig).values({ id: 49, menuName: 'routine_appsecret', value: '"owned-fixture-secret"' });
    const credentials = await readRoutineCredentials(container(), env);
    const proof = issueRoutineIdentityObservation(env, { appId: APP, openid: PAYER, sourceStamp: credentials.stamp });
    await withTx(container(), tx => appendRoutineIdentityWitness(tx, env, { uid: 7, observation: proof }));
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 49));
    network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(depth).toBe(0); expect(String(input)).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
      const body = JSON.parse(String(init?.body)); expect(body).toMatchObject({ appid: APP, mchid: MCH, out_trade_no: ORDER, payer: { openid: PAYER }, amount: { total: 1250, currency: 'CNY' } });
      return response({ prepay_id: PREPAY });
    });
  });
  afterEach(() => { expect(depth).toBe(0); expect(env.CONFIG_KV.get).not.toHaveBeenCalled(); expect(env.CONFIG_KV.put).not.toHaveBeenCalled(); expect(env.CONFIG_KV.delete).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

  it('reads the whole public pair in one SQL snapshot without OAuth Secret, APP_KEY, KV or writes', async () => {
    const before = await rows(), snap = await current(); expect(snap.values).toEqual({ pay_weixin_mchid: MCH, pay_weixin_serial_no: 'ABCDEF123456', site_url: 'https://owned.example', routine_appId: APP, pay_weixin_open: '1' });
    expect(snap.stamp).toMatch(/^[a-f0-9]{64}$/u); expect(Object.isFrozen(snap)).toBe(true); expect(Object.isFrozen(snap.values)).toBe(true); expect(await rows()).toEqual(before); expect(network).not.toHaveBeenCalled();
  });
  it('uses platform sort/id winners and stamps every public shadow while ignoring tenant rows', async () => {
    await f.db.insert(systemConfig).values([{ id: 50, menuName: 'routine_appId', value: '"shadow"', sort: -1 },
      { id: 51, menuName: 'routine_appId', value: JSON.stringify(OTHER), sort: 5 }, { id: 52, menuName: 'pay_weixin_mchid', value: '"9999999999"', sort: 999, isStore: 1 }]);
    const first = await current(); expect(first.values.routine_appId).toBe(OTHER); expect(first.values.pay_weixin_mchid).toBe(MCH);
    await f.db.update(systemConfig).set({ info: 'changed shadow metadata' }).where(eq(systemConfig.id, 50)); expect((await current()).stamp).not.toBe(first.stamp);
  });
  it('OAuth Secret, name and other realms cannot revoke the public payment source', async () => {
    const first = await current(); await f.db.insert(systemConfig).values([{ id: 50, menuName: 'routine_appsecret', value: '"changed-oauth-secret"' },
      { id: 51, menuName: 'routine_name', value: '"changed name"' }, { id: 52, menuName: 'wechat_appid', value: '"other-realm"' }]);
    expect(await current()).toEqual(first); await create(); expect(network).toHaveBeenCalledTimes(1);
  });
  it('A-B-A public changes cannot resurrect an earlier source stamp', async () => {
    const first = await current(); await update('routine_appId', OTHER); const second = await current(); await update('routine_appId', APP); const third = await current();
    expect(third.values).toEqual(first.values); expect(new Set([first.stamp, second.stamp, third.stamp]).size).toBe(3);
  });
  it('accepts64 complete source rows and refuses65 instead of truncating the public winner', async () => {
    await f.db.insert(systemConfig).values(Array.from({ length: 59 }, (_, i) => ({ id: 100 + i, menuName: 'routine_appId', value: '"shadow"', sort: -1 })));
    expect((await current()).values.routine_appId).toBe(APP); await f.db.insert(systemConfig).values({ id: 200, menuName: 'routine_appId', value: '"overflow"', sort: -1 });
    await expect(current()).rejects.toThrow('完整读取容量'); await expect(create()).rejects.toThrow('完整读取容量'); expect(network).not.toHaveBeenCalled();
  });
  it('rejects an oversized complete UTF8 source without exposing configuration or using KV', async () => {
    await f.db.insert(systemConfig).values(Array.from({ length: 56 }, (_, i) => ({ id: 100 + i, menuName: 'routine_appId', value: '𠮷'.repeat(5000), sort: -1 })));
    await expect(current()).rejects.toThrow('完整读取容量');
  });
  it('uses the same fresh SQL source for readiness and actual Mini signing without optional App authority', async () => {
    const ready = await getPaymentReadinessSnapshot(container(), env); expect(ready.wechatProfiles.routine).toEqual({ enabled: true, reason: '' }); expect(ready.wechatProfiles.app.enabled).toBe(false);
    const result = await create(); expect(result).toMatchObject({ prepay_id: PREPAY, package: 'prepay_id=' + PREPAY, signType: 'RSA' });
    expect(verify('RSA-SHA256', Buffer.from(`${APP}\n${result.timeStamp}\n${result.nonceStr}\n${result.package}\n`), keys.publicKey, Buffer.from(String(result.paySign), 'base64'))).toBe(true);
  });
  it.each(['balance_func_status', 'yue_pay_status', 'offline_pay_status'])('checkout readiness honors committed SQL %s changes instead of stale cache', async key => {
    const method = key === 'offline_pay_status' ? 'offline' : 'yue';
    expect((await getPaymentReadinessSnapshot(container(), env)).methods[method].enabled).toBe(true);
    await update(key, '0'); expect((await getPaymentReadinessSnapshot(container(), env)).methods[method].enabled).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });
  it('Alipay checkout readiness reads its committed SQL switch while retaining deployment-key requirements', async () => {
    env.ALIPAY_APP_ID = '2026102900000001'; env.ALIPAY_SELLER_ID = MCH; env.ALIPAY_PRIVATE_KEY = keys.privateKey; env.ALIPAY_PUBLIC_KEY = keys.publicKey;
    env.ALIPAY_NOTIFY_URL = 'https://owned.example/api/pay/notify/alipay'; env.ALIPAY_RETURN_URL = 'https://owned.example/payment-return';
    await update('ali_pay_status', '1'); expect((await getPaymentReadinessSnapshot(container(), env)).methods.alipay.enabled).toBe(true);
    await update('ali_pay_status', '0'); expect((await getPaymentReadinessSnapshot(container(), env)).methods.alipay.enabled).toBe(false); expect(network).not.toHaveBeenCalled();
  });
  it.each(['routine_appId', 'pay_weixin_mchid', 'pay_weixin_serial_no', 'site_url', 'pay_weixin_open'])('%s fresh SQL invalidation disables readiness and prevents provider POST', async key => {
    await update(key, key === 'pay_weixin_open' ? '0' : '');
    const ready = await getPaymentReadinessSnapshot(container(), env); expect(ready.wechatProfiles.routine.enabled).toBe(false); await expect(create()).rejects.toThrow(); expect(network).not.toHaveBeenCalled();
  });
  it.each(['{}', 'bad\nappid', 'x'.repeat(33)])('invalid Mini AppID %j cannot become ready or sign a payment', async appId => {
    await update('routine_appId', appId); await expect(assertWechatPaymentProfileAvailable(container(), env, 'routine')).rejects.toThrow(); await expect(create()).rejects.toThrow(); expect(network).not.toHaveBeenCalled();
  });
  it.each([{ type: 'h5' }, { type: 'native' }, { type: 'app' }, { openid: '' }, { openid: 'bad\npayer' }, { openid: 'x'.repeat(101) }] as const)('rejects invalid Mini initiation shape %# before provider', async extra => {
    await expect(create(extra)).rejects.toThrow(); expect(network).not.toHaveBeenCalled();
  });
  it.each(['AppID', 'merchant', 'serial', 'switch', 'site', 'ABA', 'shadow'] as const)('Mini rejects a legacy unbound %s hook before executing it or contacting provider', async kind => {
    const legacy = vi.fn(async () => {
      expect(depth).toBe(0);
      if (kind === 'shadow') await f.db.insert(systemConfig).values({ id: 50, menuName: 'routine_appId', value: '"shadow"', sort: -1 });
      else if (kind === 'ABA') { await update('routine_appId', OTHER); await update('routine_appId', APP); }
      else await update(({ AppID: 'routine_appId', merchant: 'pay_weixin_mchid', serial: 'pay_weixin_serial_no', switch: 'pay_weixin_open', site: 'site_url' } as const)[kind], 'changed');
    });
    await expect(create({ beforeProviderRequest: legacy })).rejects.toThrow('付款准入'); expect(legacy).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it('accepts the signed old-account prepay response without switching credentials after a late configuration change', async () => {
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => { const result = await original(input, init); await update('routine_appId', OTHER); return result; });
    expect(await create()).toMatchObject({ prepay_id: PREPAY }); expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['signature', 'serial', 'prepay-shape', 'prepay-empty'])('a signed provider %s fault cannot return client payment parameters', async failure => {
    const result = response({ prepay_id: failure === 'prepay-shape' ? 'bad\nprepay' : failure === 'prepay-empty' ? '' : PREPAY });
    if (failure === 'signature') result.headers.set('Wechatpay-Signature', 'broken'); if (failure === 'serial') result.headers.set('Wechatpay-Serial', 'other-key');
    network.mockResolvedValue(result); await expect(create()).rejects.toThrow(); expect(network).toHaveBeenCalledTimes(1);
  });
  it('requires real signature verification even for a non-success Mini provider response', async () => {
    const result = response({ code: 'ORDERPAID', message: 'claimed rejection' }, 400); result.headers.set('Wechatpay-Signature', 'broken'); network.mockResolvedValue(result);
    await expect(create()).rejects.toThrow('验签失败'); expect(network).toHaveBeenCalledTimes(1);
  });
  it('query and real RSA/AES callback verification remain independent of the new-payment switch and OAuth Secret', async () => {
    await update('pay_weixin_open', '0'); network.mockResolvedValue(response(facts()));
    const result = await source().queryOrder({ provider: 'wechat', profile: 'routine', orderDomain: 'store_order', orderNo: ORDER, expectedAmountCents: 1250, currency: 'CNY' });
    expect(result).toMatchObject({ status: 'SUCCESS', transactionId: 'owned_routine_transaction' });
    const incoming = notification(); expect(await source().verifyAndParseNotify(incoming.headers, incoming.raw, 'routine')).toMatchObject({ appId: APP, merchantId: MCH, payerId: PAYER, amountTotal: 1250 });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('merchant-only recovery configuration needs no client AppID, OAuth Secret or new-payment flags', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'routine_appId')); await update('pay_weixin_open', '0');
    const merchant = await Reflect.get(source(), 'getRefundConfig').call(source()); expect(merchant.mchId).toBe(MCH); expect(merchant).not.toHaveProperty('appId'); expect(network).not.toHaveBeenCalled();
  });
  it('same-source SQL actions roll back if they mutate the captured public source', async () => {
    const expected = await current(), before = await rows(); await expect(withRoutinePaymentPublicSource(container(), expected, async bound => {
      await bound.db.update(systemConfig).set({ value: JSON.stringify(OTHER) }).where(eq(systemConfig.menuName, 'routine_appId'));
    })).rejects.toThrow('配置已变化'); expect(await rows()).toEqual(before);
  });
  it.skipIf(!native)('one actual PG16 MVCC snapshot keeps AppID and merchant paired across atomic peer rotation', async () => {
    await withFinancePeers(f.db, async ([peer]) => {
      await withTx(container(), async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const before = await readPaymentPublicConfigInTx(tx, 'routine');
        await peer.db.transaction(async other => { await other.update(systemConfig).set({ value: JSON.stringify(OTHER) }).where(eq(systemConfig.menuName, 'routine_appId'));
          await other.update(systemConfig).set({ value: '"1900000209"' }).where(eq(systemConfig.menuName, 'pay_weixin_mchid')); });
        expect(await readPaymentPublicConfigInTx(tx, 'routine')).toEqual(before);
      });
      expect((await current()).values).toMatchObject({ routine_appId: OTHER, pay_weixin_mchid: '1900000209' });
    });
  });
  it.each([731664, 731666])('PG16 independent maintenance gate %i prevents new Mini HTTP without holding HTTP inside SQL', async gate => {
    if (!native) throw Error('This maintenance concurrency suite must run on owned PG16');
    await withFinancePeers(f.db, async ([owner]) => { await owner.exec('BEGIN');
      try { await owner.exec(`SELECT pg_advisory_xact_lock(${gate},0)`); await expect(create()).rejects.toThrow('正在维护'); expect(network).not.toHaveBeenCalled(); }
      finally { await owner.exec('ROLLBACK'); }
    });
  });
});
