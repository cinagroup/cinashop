import { Buffer } from 'node:buffer';
import { createHmac, randomUUID, verify } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { paymentReconciliationAction, paymentReconciliationCase, storeOrder, systemConfig } from '@/models/schema';
import { ROUTINE_PAYMENT_ATTEMPT_SQL } from '@/migrations/routinePaymentAttempt';
import { LegacyOrderCompatibilityService } from '@/services/order/LegacyOrderCompatibilityService';
import { StoreOrderPayService } from '@/services/order/StoreOrderPayService';
import { registerPaymentReconciliationIntent } from '@/services/payment/PaymentReconciliationRegistry';
import { buildAlipaySignContent, signAlipayParams } from '@/utils/alipay';
import { financePostgres } from './helpers/financePostgres';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const UID = 7, PHYSICAL_ID = 11, ORDER = 'owned_alipay_key_order', AMOUNT = 1250;
const DOMAIN = 'cinashop.payment.alipay-redirect-capability.v2\0';
const CANCEL_KEYS = new Set(['cfg_order_activity_time', 'cfg_order_bargain_time', 'cfg_order_cancel_time',
  'cfg_order_pink_time', 'cfg_order_seckill_time', 'cfg_rebate_points_orders_time']);
const BAD_ORDER = ['owner', 'amount', 'paid', 'status', 'deleted', 'system-deleted', 'expired', 'physical-id'] as const;
const BAD_CASE = ['missing', 'replay-key', 'replacement', 'conflict', 'callback', 'transaction', 'not-initiated', 'amount', 'domain', 'manual-action'] as const;

describe('owned PG16 Alipay opaque-key live replay admission', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let keys: ReturnType<typeof paymentQueryKeys>, env: Env, values: Map<string, string>;
  let depth = 0, clock: number;
  let beforeNextTransaction: (() => Promise<void>) | undefined;
  let afterNextTransaction: (() => void) | undefined;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  // Only observe real SQL and transaction boundaries; never substitute a SQL
  // result or mock admission, HMAC, registry, order checks or RSA signing.
  const observe = (db: DbClient): DbClient => new Proxy(db, {
    get(target, key, receiver) {
      const method: unknown = Reflect.get(target, key, receiver);
      if (typeof method !== 'function') return method;
      if (key !== 'transaction') return method.bind(target);
      return async (action: (tx: DbClient) => Promise<unknown>, ...options: unknown[]) => {
        const before = beforeNextTransaction, after = afterNextTransaction;
        beforeNextTransaction = undefined; afterNextTransaction = undefined;
        await before?.();
        const result = await Reflect.apply(method, target, [async (tx: DbClient) => {
          depth++;
          try { return await action(observe(tx)); } finally { depth--; }
        }, ...options]);
        after?.(); return result;
      };
    },
  });
  const container = () => createContainerFromDb(observe(f.db));
  const compatibility = () => new LegacyOrderCompatibilityService(container(), env);
  const registry = () => f.db.select().from(paymentReconciliationCase).orderBy(paymentReconciliationCase.id);
  const state = async () => ({
    orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id), cases: await registry(),
    actions: await f.db.select().from(paymentReconciliationAction).orderBy(paymentReconciliationAction.id),
  });
  const issue = async (assisted = false) => {
    if (assisted) await f.db.update(storeOrder).set({ isChannel: 2, staffId: 91 }).where(eq(storeOrder.id, PHYSICAL_ID));
    const url = await new StoreOrderPayService(container(), env).alipayPay(UID, ORDER);
    const key = await compatibility().createAlipayKey(UID, ORDER, url);
    const raw = values.get(`pay:alipay:${key}`);
    if (!raw) throw Error('Missing actual capability');
    return { key, url, raw, payload: JSON.parse(raw) as Record<string, unknown> };
  };
  const rejectWithoutConsumption = async (key: string) => {
    const raw = values.get(`pay:alipay:${key}`), before = await state();
    await expect(compatibility().consumeAlipayKey(key)).rejects.toThrow();
    expect(values.get(`pay:alipay:${key}`)).toBe(raw);
    expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  };
  const signedGateway = async (amount = '12.50') => {
    const params = { app_id: String(env.ALIPAY_APP_ID), method: 'alipay.trade.wap.pay', charset: 'utf-8', sign_type: 'RSA2',
      timestamp: '2026-10-29 12:00:00', version: '1.0', notify_url: 'https://owned.example/alipay/notify', return_url: 'https://owned.example/return',
      biz_content: JSON.stringify({ out_trade_no: ORDER, total_amount: amount, subject: 'Owned fixture goods', product_code: 'QUICK_WAP_WAY' }) };
    return `https://openapi.alipay.com/gateway.do?${new URLSearchParams({ ...params, sign: await signAlipayParams(params, keys.privateKey) })}`;
  };
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Actual owned PostgreSQL16 required for Alipay capability replay');
    keys = paymentQueryKeys();
    f = await financePostgres([systemConfig, storeOrder, paymentReconciliationCase, paymentReconciliationAction], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX payment_key_case_uq ON public.payment_reconciliation_case(provider,order_no)');
    await f.exec('CREATE UNIQUE INDEX payment_key_order_uq ON public.store_order(order_id)');
  }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    depth = 0; beforeNextTransaction = undefined; afterNextTransaction = undefined;
    await f.exec('DROP TABLE IF EXISTS public.routine_payment_attempt');
    await f.exec('DROP FUNCTION IF EXISTS public.routine_payment_attempt_immutable_v1()');
    await f.reset(); await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL);
    clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    values = new Map();
    env = { APP_KEY: 'owned-alipay-capability-key-do-not-persist', ALIPAY_APP_ID: '2026102900000001',
      ALIPAY_PRIVATE_KEY: keys.privateKey, ALIPAY_NOTIFY_URL: 'https://owned.example/alipay/notify', ALIPAY_RETURN_URL: 'https://owned.example/return',
      CONFIG_KV: {
        get: vi.fn(async (key: string) => {
          expect(depth).toBe(0);
          if (CANCEL_KEYS.has(key)) return '24';
          if (key.startsWith('pay:alipay:')) return values.get(key) ?? null;
          throw Error('No current payment/account configuration may be read from KV');
        }),
        put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
          expect(depth).toBe(0); expect(options).toEqual({ expirationTtl: 300 }); values.set(key, value);
        }),
        delete: vi.fn(async (key: string) => { expect(depth).toBe(0); values.delete(key); }),
      },
    } as unknown as Env;
    await f.db.insert(storeOrder).values({ id: PHYSICAL_ID, uid: UID, orderId: ORDER, payPrice: '12.50', paid: 0,
      status: 0, isDel: 0, isSystemDel: 0, isChannel: 0, type: 0, addTime: Math.floor(clock / 1000), unique: 'owned-alipay-key' });
    network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('No provider HTTP is needed for Alipay capability replay'); });
  });
  afterEach(() => {
    try { expect(depth).toBe(0); expect(network).not.toHaveBeenCalled(); }
    finally { beforeNextTransaction = undefined; afterNextTransaction = undefined; vi.restoreAllMocks(); }
  });

  it.each([false, true])('returns the original real RSA URL after %s-assisted admission without another registration', async assisted => {
    const { key, url, raw, payload } = await issue(assisted), before = await state();
    const params = Object.fromEntries(new URL(url).searchParams), originalSignature = params.sign;
    expect(verify('RSA-SHA256', Buffer.from(buildAlipaySignContent(params)), keys.publicKey, Buffer.from(originalSignature, 'base64'))).toBe(true);
    const { signature, ...canonical } = payload;
    expect(signature).toBe(createHmac('sha256', env.APP_KEY).update(DOMAIN).update(JSON.stringify(canonical)).digest('hex'));
    expect(payload).toMatchObject({ version: 2, purpose: 'alipay_redirect_replay', key, uid: UID, orderNo: ORDER,
      orderId: PHYSICAL_ID, amountCents: AMOUNT, caseId: before.cases[0].id, replayKey: before.cases[0].replayKey,
      orderDomain: 'store_order', provider: 'alipay', profile: 'alipay', payUrl: url });
    expect(Number(payload.expiresAt) - Number(payload.issuedAt)).toBe(300);
    expect(raw).not.toContain(String(env.APP_KEY)); expect(raw).not.toContain(keys.privateKey);
    expect(await compatibility().consumeAlipayKey(key)).toEqual({ uid: UID, orderId: ORDER, payUrl: url });
    expect(await state()).toEqual(before); expect(await registry()).toHaveLength(1);
    expect(values.has(`pay:alipay:${key}`)).toBe(false);
    await expect(compatibility().consumeAlipayKey(key)).rejects.toThrow('该订单无法支付');
  });

  it('does not create a new initiated case just to mint a key for an unadmitted signed URL', async () => {
    const url = await signedGateway(), before = await state();
    await expect(compatibility().createAlipayKey(UID, ORDER, url)).rejects.toThrow();
    expect(await state()).toEqual(before); expect(values.size).toBe(0); expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
  });
  it('requires the URL amount to match the actual physical order even when RSA is valid', async () => {
    await issue(); const before = await state(), count = values.size;
    await expect(compatibility().createAlipayKey(UID, ORDER, await signedGateway('12.51'))).rejects.toThrow('支付宝支付地址无效');
    expect(await state()).toEqual(before); expect(values.size).toBe(count);
  });
  it('refuses key creation after a conflicting provider initiation', async () => {
    const { url } = await issue();
    await registerPaymentReconciliationIntent(container(), { provider: 'wechat', profile: 'wechat', orderDomain: 'store_order',
      orderNo: ORDER, expectedAmountCents: AMOUNT, initiated: true });
    const before = await state(), count = values.size;
    await expect(compatibility().createAlipayKey(UID, ORDER, url)).rejects.toThrow();
    expect(await state()).toEqual(before); expect(values.size).toBe(count);
  });
  it('preserves the original signed URL without reading today\'s provider credentials or re-signing', async () => {
    const { key, url } = await issue();
    env.ALIPAY_APP_ID = 'different-deployment'; env.ALIPAY_PRIVATE_KEY = 'not-a-private-key';
    expect(await compatibility().consumeAlipayKey(key)).toEqual({ uid: UID, orderId: ORDER, payUrl: url });
  });
  it.each(BAD_ORDER)('retains the key when live order %s no longer matches the original admission', async kind => {
    const { key } = await issue();
    if (kind === 'owner') await f.db.update(storeOrder).set({ uid: UID + 1 }).where(eq(storeOrder.id, PHYSICAL_ID));
    if (kind === 'amount') await f.db.update(storeOrder).set({ payPrice: '12.51' }).where(eq(storeOrder.id, PHYSICAL_ID));
    if (kind === 'paid') await f.db.update(storeOrder).set({ paid: 1 }).where(eq(storeOrder.id, PHYSICAL_ID));
    if (kind === 'status') await f.db.update(storeOrder).set({ status: -1 }).where(eq(storeOrder.id, PHYSICAL_ID));
    if (kind === 'deleted') await f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, PHYSICAL_ID));
    if (kind === 'system-deleted') await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, PHYSICAL_ID));
    if (kind === 'expired') await f.db.update(storeOrder).set({ addTime: Math.floor(clock / 1000) - 25 * 3600 }).where(eq(storeOrder.id, PHYSICAL_ID));
    if (kind === 'physical-id') {
      const [row] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, PHYSICAL_ID));
      await f.db.delete(storeOrder).where(eq(storeOrder.id, PHYSICAL_ID)); await f.db.insert(storeOrder).values({ ...row, id: 111 });
    }
    await rejectWithoutConsumption(key);
  });
  it.each(BAD_CASE)('retains the key when original registry %s has changed or requires recovery', async kind => {
    const { key } = await issue(), [original] = await registry();
    if (kind === 'missing' || kind === 'replacement') await f.db.delete(paymentReconciliationCase).where(eq(paymentReconciliationCase.id, original.id));
    if (kind === 'replacement') await registerPaymentReconciliationIntent(container(), { provider: 'alipay', profile: 'alipay', orderDomain: 'store_order',
      orderNo: ORDER, expectedAmountCents: AMOUNT, initiated: true });
    if (kind === 'replay-key') await f.db.update(paymentReconciliationCase).set({ replayKey: randomUUID() }).where(eq(paymentReconciliationCase.id, original.id));
    if (kind === 'conflict') await f.db.update(paymentReconciliationCase).set({ status: 'CONFLICT' }).where(eq(paymentReconciliationCase.id, original.id));
    if (kind === 'callback') await f.db.update(paymentReconciliationCase).set({ callbackEventId: 99 }).where(eq(paymentReconciliationCase.id, original.id));
    if (kind === 'transaction') await f.db.update(paymentReconciliationCase).set({ providerTransactionId: 'provider_already_observed' }).where(eq(paymentReconciliationCase.id, original.id));
    if (kind === 'not-initiated') await f.db.update(paymentReconciliationCase).set({ initiatedTime: 0 }).where(eq(paymentReconciliationCase.id, original.id));
    if (kind === 'amount') await f.db.update(paymentReconciliationCase).set({ expectedAmountCents: AMOUNT + 1 }).where(eq(paymentReconciliationCase.id, original.id));
    if (kind === 'domain') await f.db.update(paymentReconciliationCase).set({ orderDomain: 'membership' }).where(eq(paymentReconciliationCase.id, original.id));
    if (kind === 'manual-action') await f.db.insert(paymentReconciliationAction).values({ caseId: original.id, actionKey: randomUUID(),
      adminId: 91, actionType: 'RETRY', reasonCode: 'manual_retry', beforeStatus: 'UNKNOWN', afterStatus: 'OPEN', addTime: Math.floor(clock / 1000) });
    await rejectWithoutConsumption(key);
  });
  it('refuses cached Alipay delivery after Mini history remains even if its mutable registry was removed', async () => {
    const { key } = await issue();
    // An untrusted/minimal payload is deliberately only a refusal marker, not
    // proof of a Mini payer or provider success. The actual immutable table is
    // installed and inspected, and every query remains real PostgreSQL.
    await f.db.execute(sql`INSERT INTO public.routine_payment_attempt(order_no,event_kind,payload,created_at,signature)
      VALUES(${ORDER},'INITIATION','{}'::jsonb,${Math.floor(clock / 1000)},${'a'.repeat(64)})`);
    await rejectWithoutConsumption(key);
  });
  it('refuses a cached URL if another provider became initiated after its issuance', async () => {
    const { key } = await issue();
    await registerPaymentReconciliationIntent(container(), { provider: 'wechat', profile: 'wechat', orderDomain: 'store_order',
      orderNo: ORDER, expectedAmountCents: AMOUNT, initiated: true });
    await rejectWithoutConsumption(key);
  });
  it('fails closed without deleting a valid key when the shared Mini ledger is unavailable', async () => {
    const { key } = await issue(); await f.exec('ALTER TABLE public.routine_payment_attempt RENAME TO payment_key_hidden_attempt');
    try { await rejectWithoutConsumption(key); }
    finally { await f.exec('ALTER TABLE public.payment_key_hidden_attempt RENAME TO routine_payment_attempt'); }
  });
  it('rechecks a real order mutation between the initial read and the SQL replay gate', async () => {
    const { key } = await issue();
    beforeNextTransaction = async () => { await f.db.update(storeOrder).set({ paid: 1 }).where(eq(storeOrder.id, PHYSICAL_ID)); };
    const raw = values.get(`pay:alipay:${key}`);
    await expect(compatibility().consumeAlipayKey(key)).rejects.toThrow();
    expect(beforeNextTransaction).toBeUndefined(); expect(values.get(`pay:alipay:${key}`)).toBe(raw);
    expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
    const [current] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, PHYSICAL_ID)); expect(current.paid).toBe(1);
  });
  it('does not consume an expired authenticated key', async () => {
    const { key } = await issue(); clock += 300_000;
    await rejectWithoutConsumption(key);
  });
  it('does not delete or return a key that expires during the actual SQL replay', async () => {
    const { key } = await issue(); afterNextTransaction = () => { clock += 300_000; };
    await rejectWithoutConsumption(key); expect(afterNextTransaction).toBeUndefined();
  });
  it('refuses a URL expiring during KV deletion and leaves the successfully consumed key absent', async () => {
    const { key } = await issue(), before = await state();
    clock += 299_000;
    vi.mocked(env.CONFIG_KV.delete).mockImplementationOnce(async cacheKey => {
      expect(depth).toBe(0);
      expect(cacheKey).toBe(`pay:alipay:${key}`);
      values.delete(cacheKey);
      clock += 2_000;
    });
    await expect(compatibility().consumeAlipayKey(key)).rejects.toThrow('该订单无法支付');
    expect(env.CONFIG_KV.delete).toHaveBeenCalledOnce();
    expect(values.has(`pay:alipay:${key}`)).toBe(false);
    expect(await state()).toEqual(before);
    expect(env.CONFIG_KV.put).toHaveBeenCalledOnce();
    await expect(compatibility().consumeAlipayKey(key)).rejects.toThrow('该订单无法支付');
    expect(env.CONFIG_KV.delete).toHaveBeenCalledOnce();
  });
  it('leaves the key intact when KV GET fails before replay', async () => {
    const { key } = await issue(), before = await state();
    vi.mocked(env.CONFIG_KV.get).mockRejectedValueOnce(Error('controlled KV GET failure'));
    await expect(compatibility().consumeAlipayKey(key)).rejects.toThrow('controlled KV GET failure');
    expect(await state()).toEqual(before); expect(values.has(`pay:alipay:${key}`)).toBe(true); expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
  });
  it('does not report successful consumption when the final KV delete fails', async () => {
    const { key } = await issue(), before = await state();
    vi.mocked(env.CONFIG_KV.delete).mockRejectedValueOnce(Error('controlled KV delete failure'));
    await expect(compatibility().consumeAlipayKey(key)).rejects.toThrow('controlled KV delete failure');
    expect(await state()).toEqual(before); expect(values.has(`pay:alipay:${key}`)).toBe(true);
  });
});
