import { Buffer } from 'node:buffer';
import { sign, verify } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { otherOrder, paymentReconciliationAction, paymentReconciliationCase, storeOrder, systemConfig, user, userBill, userRecharge, wechatUser } from '@/models/schema';
import { ROUTINE_IDENTITY_WITNESS_SQL } from '@/migrations/routineIdentityWitness';
import { ROUTINE_PAYMENT_ATTEMPT_SQL } from '@/migrations/routinePaymentAttempt';
import { StoreOrderPayService } from '@/services/order/StoreOrderPayService';
import { registerPaymentReconciliationIntent } from '@/services/payment/PaymentReconciliationRegistry';
import { RechargePaymentService } from '@/services/payment/RechargePaymentService';
import { resolveWechatPaymentIdentity } from '@/services/payment/WechatPaymentIdentity';
import { PaidMembershipService } from '@/services/user/PaidMembershipService';
import { issueRoutineIdentityObservation } from '@/services/wechat/RoutineIdentityObservation';
import { appendRoutineIdentityWitness } from '@/services/wechat/RoutineIdentityWitness';
import { readRoutineCredentials } from '@/services/wechat/RoutineRuntimeConfig';
import { financePostgres } from './helpers/financePostgres';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const APP = 'wxRoutineCallers01', OFFICIAL_APP = 'wxOfficialCallers01';
const PAYER = 'routine_callers_payer', OFFICIAL_PAYER = 'official_callers_payer';
const MCH = '1900000109', PLATFORM_SERIAL = 'CALLERS_PLATFORM_PUBLIC_KEY';
const DOMAINS = ['store_order', 'recharge', 'membership'] as const;
type Domain = typeof DOMAINS[number];
const ORDERS = {
  store_order: { id: 11, orderNo: 'caller_store_order', attach: 'product' },
  recharge: { id: 12, orderNo: 'cz_caller_recharge', attach: 'user_recharge' },
  membership: { id: 13, orderNo: 'caller_membership', attach: 'member' },
} as const;
const CANCELLATION_KEYS = new Set([
  'cfg_order_activity_time', 'cfg_order_bargain_time', 'cfg_order_cancel_time',
  'cfg_order_pink_time', 'cfg_order_seckill_time', 'cfg_rebate_points_orders_time',
]);

describe('actual Mini payment callers on owned PG16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let env: Env, keys: ReturnType<typeof paymentQueryKeys>, depth = 0;
  let beforeNextTransaction: (() => Promise<void>) | undefined;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

  // Observe the actual transaction boundary; all statements and return values
  // still come from PostgreSQL, including the optional independent SQL change.
  const observe = (db: DbClient): DbClient => new Proxy(db, {
    get(target, key, receiver) {
      const method: unknown = Reflect.get(target, key, receiver);
      if (typeof method !== 'function') return method;
      if (key !== 'transaction') return method.bind(target);
      return async (action: (tx: DbClient) => Promise<unknown>, ...args: unknown[]) => {
        const pending = beforeNextTransaction;
        beforeNextTransaction = undefined;
        await pending?.();
        return Reflect.apply(method, target, [async (tx: DbClient) => {
          depth++;
          try { return await action(observe(tx)); } finally { depth--; }
        }, ...args]);
      };
    },
  });
  const container = () => createContainerFromDb(observe(f.db));
  const invoke = (domain: Domain) => {
    const bound = container(), orderNo = ORDERS[domain].orderNo;
    if (domain === 'store_order') return new StoreOrderPayService(bound, env).pay(7, orderNo, 'weixin', 'routine');
    if (domain === 'recharge') return new RechargePaymentService(bound, env).startWechatPayment(7, orderNo, 'routine');
    return new PaidMembershipService(bound, env).payOrder(7, { orderId: orderNo, payType: 'weixin', from: 'routine' });
  };
  const attempts = () => f.db.execute<{
    order_no: string; event_kind: string; payload: Record<string, unknown>; created_at: string; signature: string;
  }>(sql`SELECT order_no,event_kind,payload,created_at::text,signature FROM public.routine_payment_attempt ORDER BY order_no,event_kind`);
  const cases = () => f.db.select().from(paymentReconciliationCase).orderBy(paymentReconciliationCase.id);
  const state = async () => ({
    users: await f.db.select().from(user).orderBy(user.uid),
    bindings: await f.db.select().from(wechatUser).orderBy(wechatUser.id),
    store: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
    recharge: await f.db.select().from(userRecharge).orderBy(userRecharge.id),
    membership: await f.db.select().from(otherOrder).orderBy(otherOrder.id),
    bills: await f.db.select().from(userBill),
  });
  const signedResponse = (value: unknown) => {
    const body = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'routine_callers_response';
    const signature = Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), keys.privateKey)).toString('base64');
    return new Response(body, { headers: {
      'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce,
      'Wechatpay-Serial': PLATFORM_SERIAL, 'Wechatpay-Signature': signature,
    } });
  };
  const removeWitnesses = async () => {
    await f.exec('DROP TABLE public.routine_identity_witness');
    await f.exec('DROP FUNCTION public.routine_identity_witness_immutable_v1()');
    await f.exec(ROUTINE_IDENTITY_WITNESS_SQL);
  };

  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Actual owned PG16 required for payment caller/source/witness tests');
    keys = paymentQueryKeys();
    f = await financePostgres([systemConfig, user, wechatUser, storeOrder, userRecharge, otherOrder, userBill, paymentReconciliationCase, paymentReconciliationAction], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX routine_callers_case_uq ON public.payment_reconciliation_case(provider,order_no)');
    await f.exec('CREATE UNIQUE INDEX routine_callers_store_order_uq ON public.store_order(order_id)');
    await f.exec('CREATE UNIQUE INDEX routine_callers_recharge_order_uq ON public.user_recharge(order_id)');
  }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    depth = 0; beforeNextTransaction = undefined;
    await f.exec('DROP TABLE IF EXISTS public.routine_payment_attempt');
    await f.exec('DROP FUNCTION IF EXISTS public.routine_payment_attempt_immutable_v1()');
    await f.exec('DROP TABLE IF EXISTS public.routine_identity_witness');
    await f.exec('DROP FUNCTION IF EXISTS public.routine_identity_witness_immutable_v1()');
    await f.reset();
    await f.exec(ROUTINE_IDENTITY_WITNESS_SQL);
    await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL);
    const config = {
      routine_appId: APP, routine_appsecret: 'caller-fixture-oauth-secret', wechat_appid: OFFICIAL_APP,
      pay_weixin_mchid: MCH, pay_weixin_serial_no: 'ABCDEF123456', pay_weixin_open: '1', site_url: 'https://callers.example',
    };
    await f.db.insert(systemConfig).values(Object.entries(config).map(([menuName, value], index) => ({
      id: index + 1, menuName, value: JSON.stringify(value), sort: 5,
    })));
    env = {
      APP_KEY: 'routine-callers-observation-and-ledger-key',
      WECHAT_MCH_PRIVATE_KEY: keys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey,
      WECHAT_PLATFORM_PUBLIC_KEY_ID: PLATFORM_SERIAL, WECHAT_API_V3_KEY: 'c'.repeat(32),
      CONFIG_KV: {
        get: vi.fn(async (key: string) => {
          expect(depth).toBe(0);
          if (!CANCELLATION_KEYS.has(key)) throw Error('Payment public configuration and OAuth credentials must not read KV');
          return '24';
        }),
        put: vi.fn(async () => {}), delete: vi.fn(async () => {}),
      },
    } as unknown as Env;
    await f.db.insert(user).values({ uid: 7, account: 'routine-callers-user', status: 1, nowMoney: '88.00', integral: 21, isMoneyLevel: 0, isEverLevel: 0 });
    await f.db.insert(wechatUser).values([
      { id: 7, uid: 7, openid: PAYER, userType: 'routine' },
      { id: 8, uid: 7, openid: OFFICIAL_PAYER, userType: 'wechat' },
    ]);
    const now = Math.floor(Date.now() / 1000);
    await f.db.insert(storeOrder).values({ id: ORDERS.store_order.id, uid: 7, orderId: ORDERS.store_order.orderNo,
      payPrice: '12.50', paid: 0, status: 0, type: 0, addTime: now, mark: 'Fixture goods', unique: 'routine-callers-store' });
    await f.db.insert(userRecharge).values({ id: ORDERS.recharge.id, uid: 7, orderId: ORDERS.recharge.orderNo,
      price: '12.50', givePrice: '2.00', paid: 0, addTime: now });
    await f.db.insert(otherOrder).values({ id: ORDERS.membership.id, uid: 7, orderId: ORDERS.membership.orderNo,
      type: 1, memberType: 'monthly', payPrice: '12.50', paid: 0, isFree: 0, isPermanent: 0, vipDay: 30, channelType: 'routine', addTime: now });
    const credentials = await readRoutineCredentials(container(), env);
    const observation = issueRoutineIdentityObservation(env, { appId: credentials.appId, openid: PAYER, sourceStamp: credentials.stamp });
    await withTx(container(), tx => appendRoutineIdentityWitness(tx, env, { uid: 7, observation }));
    // Public payments must work after the OAuth Secret is unavailable.
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'routine_appsecret'));
    network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(depth).toBe(0);
      expect(String(input)).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
      expect(init?.method).toBe('POST');
      const raw = String(init?.body), body = JSON.parse(raw) as { out_trade_no: string };
      expect(body).toMatchObject({ appid: APP, mchid: MCH, payer: { openid: PAYER }, amount: { total: 1250, currency: 'CNY' } });
      expect(await attempts()).toMatchObject([{ order_no: body.out_trade_no, event_kind: 'INITIATION' }]);
      const auth = new Headers(init?.headers).get('Authorization') ?? '';
      const fields = Object.fromEntries([...auth.matchAll(/(\w+)="([^"]+)"/gu)].map(match => [match[1], match[2]]));
      expect(fields.mchid).toBe(MCH); expect(fields.serial_no).toBe('ABCDEF123456');
      expect(verify('RSA-SHA256', Buffer.from(`POST\n/v3/pay/transactions/jsapi\n${fields.timestamp}\n${fields.nonce_str}\n${raw}\n`),
        keys.publicKey, Buffer.from(fields.signature, 'base64'))).toBe(true);
      return signedResponse({ prepay_id: `prepay_${body.out_trade_no}` });
    });
  });
  afterEach(() => {
    try {
      expect(depth).toBe(0);
      if (!env) return;
      const gets = vi.mocked(env.CONFIG_KV.get).mock.calls;
      for (const [key] of gets) expect(typeof key === 'string' && CANCELLATION_KEYS.has(key)).toBe(true);
      expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
      expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
    } finally { beforeNextTransaction = undefined; vi.restoreAllMocks(); }
  });

  it.each(DOMAINS)('%s actual service uses its AppID witness, preserves financial state and replays one packet', async domain => {
    const before = await state(), result = await invoke(domain), packet = result.jsConfig as Record<string, unknown>;
    expect(result).toMatchObject({ order_id: ORDERS[domain].orderNo, paid: false, pay_type: 'weixin', pay_mode: 'jsapi' });
    expect(packet).toMatchObject({ prepay_id: `prepay_${ORDERS[domain].orderNo}`, signType: 'RSA' });
    expect(verify('RSA-SHA256', Buffer.from(`${APP}\n${packet.timeStamp}\n${packet.nonceStr}\n${packet.package}\n`),
      keys.publicKey, Buffer.from(String(packet.paySign), 'base64'))).toBe(true);
    const recorded = await attempts();
    expect(recorded.map(row => row.event_kind)).toEqual(['INITIATION', 'PREPAY']);
    expect(recorded[0].payload).toMatchObject({ uid: 7, orderId: ORDERS[domain].id, orderDomain: domain, amountCents: 1250,
      appId: APP, merchantId: MCH, payerId: PAYER, witness: { uid: 7, bindingId: 7, observation: { appId: APP, openid: PAYER } } });
    expect(recorded[0].payload.providerBody).toEqual(JSON.parse(String(network.mock.calls[0][1]?.body)));
    expect(recorded[0].payload.providerBody).toMatchObject({ attach: ORDERS[domain].attach });
    expect(await cases()).toMatchObject([{ profile: 'routine', orderDomain: domain, status: 'OPEN', providerStatus: 'UNKNOWN', providerTransactionId: '' }]);
    expect(await invoke(domain)).toEqual(result);
    expect(await attempts()).toEqual(recorded); expect(network).toHaveBeenCalledTimes(1); expect(await state()).toEqual(before);
    expect(JSON.stringify(recorded)).not.toContain('caller-fixture-oauth-secret');
  });

  it.each(DOMAINS)('%s cannot promote its bare routine binding when no AppID witness exists', async domain => {
    await removeWitnesses(); const before = await state();
    await expect(invoke(domain)).rejects.toThrow('尚未证明属于当前 AppID');
    expect(await attempts()).toEqual([]); expect(await cases()).toEqual([]); expect(network).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });

  it.each(DOMAINS)('%s refuses an old initiated case without assigning a new account or sending HTTP', async domain => {
    await registerPaymentReconciliationIntent(container(), { provider: 'wechat', profile: 'routine', orderDomain: domain,
      orderNo: ORDERS[domain].orderNo, expectedAmountCents: 1250, initiated: true });
    const before = await state(), registryBefore = await cases();
    await expect(invoke(domain)).rejects.toThrow('付款已发起');
    expect(await cases()).toEqual(registryBefore); expect(await attempts()).toEqual([]);
    expect(network).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });

  it.each(DOMAINS)('%s cannot replay a packet after the same order number is assigned a new physical row', async domain => {
    await invoke(domain); const before = await attempts();
    if (domain === 'store_order') {
      const [row] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, ORDERS[domain].id));
      await f.db.delete(storeOrder).where(eq(storeOrder.id, row.id)); await f.db.insert(storeOrder).values({ ...row, id: 101 });
    } else if (domain === 'recharge') {
      const [row] = await f.db.select().from(userRecharge).where(eq(userRecharge.id, ORDERS[domain].id));
      await f.db.delete(userRecharge).where(eq(userRecharge.id, row.id)); await f.db.insert(userRecharge).values({ ...row, id: 102 });
    } else {
      const [row] = await f.db.select().from(otherOrder).where(eq(otherOrder.id, ORDERS[domain].id));
      await f.db.delete(otherOrder).where(eq(otherOrder.id, row.id)); await f.db.insert(otherOrder).values({ ...row, id: 103 });
    }
    await expect(invoke(domain)).rejects.toThrow('付款已发起'); expect(await attempts()).toEqual(before); expect(network).toHaveBeenCalledTimes(1);
  });

  it.each(['store-amount', 'store-assisted-actor', 'recharge-gift', 'membership-days'] as const)('%s changed before admission is rechecked by the real caller transaction', async kind => {
    const domain: Domain = kind.startsWith('store-') ? 'store_order' : kind === 'recharge-gift' ? 'recharge' : 'membership';
    beforeNextTransaction = async () => {
      if (kind === 'store-amount') await f.db.update(storeOrder).set({ payPrice: '13.00' }).where(eq(storeOrder.id, 11));
      if (kind === 'store-assisted-actor') await f.db.update(storeOrder).set({ isChannel: 2, staffId: 99 }).where(eq(storeOrder.id, 11));
      if (kind === 'recharge-gift') await f.db.update(userRecharge).set({ givePrice: '3.00' }).where(eq(userRecharge.id, 12));
      if (kind === 'membership-days') await f.db.update(otherOrder).set({ vipDay: 31 }).where(eq(otherOrder.id, 13));
    };
    await expect(invoke(domain)).rejects.toThrow('已变化');
    expect(beforeNextTransaction).toBeUndefined(); expect(await attempts()).toEqual([]); expect(await cases()).toEqual([]); expect(network).not.toHaveBeenCalled();
  });

  it('rejects an external zero-argument provider hook for Mini before any claim or HTTP', async () => {
    let called = false;
    await expect(new StoreOrderPayService(container(), env).pay(7, ORDERS.store_order.orderNo, 'weixin', 'routine', undefined,
      async () => { called = true; })).rejects.toThrow('不支持外部付款准入回调');
    expect(called).toBe(false); expect(await attempts()).toEqual([]); expect(await cases()).toEqual([]); expect(network).not.toHaveBeenCalled();
  });

  it('the Mini resolver returns only channel/profile/type even when the bare binding table is unavailable', async () => {
    await f.exec('ALTER TABLE public.wechat_user RENAME TO routine_callers_hidden_binding');
    try {
      expect(await resolveWechatPaymentIdentity(container(), 7, 'routine')).toEqual({ channel: 'routine', profile: 'routine', type: 'jsapi' });
    } finally { await f.exec('ALTER TABLE public.routine_callers_hidden_binding RENAME TO wechat_user'); }
    expect(network).not.toHaveBeenCalled(); expect(await attempts()).toEqual([]);
  });

  it('the official resolver keeps its exact official openid and never substitutes the Mini binding', async () => {
    expect(await resolveWechatPaymentIdentity(container(), 7, 'weixin')).toEqual({ channel: 'weixin', profile: 'wechat', type: 'jsapi', openid: OFFICIAL_PAYER });
    await f.db.insert(wechatUser).values({ id: 9, uid: 7, openid: 'second_official_payer', userType: 'wechat' });
    await expect(resolveWechatPaymentIdentity(container(), 7, 'weixin')).rejects.toThrow('唯一的微信身份绑定');
    expect(network).not.toHaveBeenCalled(); expect(await attempts()).toEqual([]);
  });
});
