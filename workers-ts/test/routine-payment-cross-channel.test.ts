import { Buffer } from 'node:buffer';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sign, verify } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { otherOrder, paymentReconciliationAction, paymentReconciliationCase, storeOrder, systemConfig, user, userBill, userRecharge, wechatUser } from '@/models/schema';
import { ROUTINE_IDENTITY_WITNESS_SQL } from '@/migrations/routineIdentityWitness';
import { ROUTINE_PAYMENT_ATTEMPT_SQL } from '@/migrations/routinePaymentAttempt';
import { StoreOrderPayService, prepareStoreOrderPaymentAdmission } from '@/services/order/StoreOrderPayService';
import { registerPaymentReconciliationIntent } from '@/services/payment/PaymentReconciliationRegistry';
import { RechargePaymentService } from '@/services/payment/RechargePaymentService';
import { admitExternalPaymentInitiation, assertExternalPaymentReplay } from '@/services/payment/PaymentInitiationAdmission';
import { PaymentReconciliationService } from '@/services/payment/PaymentReconciliationService';
import { buildAlipaySignContent } from '@/utils/alipay';
import { withFinancePeers, outcome, waitForFinanceBlock } from './helpers/financePeers';
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

describe('shared cross-channel payment admission on owned PG16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let env: Env, keys: ReturnType<typeof paymentQueryKeys>, depth = 0;
  const transactionContext = new AsyncLocalStorage<boolean>();
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
          try { return await transactionContext.run(true, () => action(observe(tx))); } finally { depth--; }
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
      ali_pay_status: '1', pay_weixin_mchid: MCH, pay_weixin_serial_no: 'ABCDEF123456', pay_weixin_open: '1', site_url: 'https://callers.example',
    };
    await f.db.insert(systemConfig).values(Object.entries(config).map(([menuName, value], index) => ({
      id: index + 1, menuName, value: JSON.stringify(value), sort: 5,
    })));
    env = {
      APP_KEY: 'routine-callers-observation-and-ledger-key',
      ALIPAY_APP_ID: '2026102900000001', ALIPAY_SELLER_ID: MCH, ALIPAY_PRIVATE_KEY: keys.privateKey, ALIPAY_PUBLIC_KEY: keys.publicKey,
      ALIPAY_NOTIFY_URL: 'https://callers.example/api/pay/notify/alipay', ALIPAY_RETURN_URL: 'https://callers.example/pay/return',
      WECHAT_MCH_PRIVATE_KEY: keys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey,
      WECHAT_PLATFORM_PUBLIC_KEY_ID: PLATFORM_SERIAL, WECHAT_API_V3_KEY: 'c'.repeat(32),
      CONFIG_KV: {
        get: vi.fn(async (key: string) => {
          expect(transactionContext.getStore()).not.toBe(true);
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
      expect(transactionContext.getStore()).not.toBe(true);
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
      expect(transactionContext.getStore()).not.toBe(true);
      if (!env) return;
      const gets = vi.mocked(env.CONFIG_KV.get).mock.calls;
      for (const [key] of gets) expect(typeof key === 'string' && CANCELLATION_KEYS.has(key)).toBe(true);
      expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
      expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
    } finally { beforeNextTransaction = undefined; vi.restoreAllMocks(); }
  });

  const invokeOther = (domain:Domain,from:'weixin'|'h5'|'alipay') => {
    const c=container(),orderNo=ORDERS[domain].orderNo;
    if(domain==='store_order')return new StoreOrderPayService(c,env).pay(7,orderNo,from==='alipay'?'alipay':'weixin',from);
    if(domain==='recharge')return new RechargePaymentService(c,env).startWechatPayment(7,orderNo,from);
    return new PaidMembershipService(c,env).payOrder(7,{orderId:orderNo,payType:from==='alipay'?'alipay':'weixin',from});
  };
  function gateway() {
    network.mockImplementation(async (input,init)=>{
      expect(transactionContext.getStore()).not.toBe(true);const body=JSON.parse(String(init?.body));
      expect(body).toMatchObject({mchid:MCH,amount:{total:1250,currency:'CNY'}});
      const stored=await cases();expect(stored).toHaveLength(1);expect(stored[0].initiatedTime).toBeGreaterThan(0);
      const profile=body.appid===APP?'routine':'wechat';expect(stored[0].profile).toBe(profile);
      if(String(input).endsWith('/h5'))return signedResponse({h5_url:'https://wx.tenpay.com/owned_h5'});
      expect(body.appid).toBe(profile==='routine'?APP:OFFICIAL_APP);
      expect(body.payer.openid).toBe(profile==='routine'?PAYER:OFFICIAL_PAYER);
      return signedResponse({prepay_id:`prepay_${body.out_trade_no}`});
    });
  }
  function verifyAlipay(result:Record<string,unknown>) {
    const url=new URL(String(result.payUrl)),params=Object.fromEntries(url.searchParams);
    expect(url.origin).toBe('https://openapi.alipay.com');expect(params.app_id).toBe(env.ALIPAY_APP_ID);
    expect(verify('RSA-SHA256',Buffer.from(buildAlipaySignContent(params)),keys.publicKey,Buffer.from(params.sign,'base64'))).toBe(true);
  }
  it.each(DOMAINS.flatMap(domain=>(['weixin','h5'] as const).map(from=>({domain,from}))))('Mini→$from for $domain commits refusal before a second HTTP',async({domain,from})=>{
    await invoke(domain);const records=await attempts(),before=await state();
    await expect(invokeOther(domain,from)).rejects.toThrow('不一致');
    expect(network).toHaveBeenCalledTimes(1);expect(await attempts()).toEqual(records);expect(await state()).toEqual(before);
    expect(await cases()).toMatchObject([{profile:'routine',status:'CONFLICT'}]);
  });
  it.each(['store_order','membership'] as const)('Mini→Alipay for %s never delivers a signed URL or claims another rail',async domain=>{
    await invoke(domain);const records=await attempts(),registered=await cases(),before=await state();
    await expect(invokeOther(domain,'alipay')).rejects.toThrow('切换渠道前');
    expect(await cases()).toEqual(registered);expect(await attempts()).toEqual(records);expect(await state()).toEqual(before);expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(DOMAINS.flatMap(domain=>(['weixin','h5'] as const).map(from=>({domain,from}))))('$from→Mini for $domain cannot mint a second entrance',async({domain,from})=>{
    gateway();await invokeOther(domain,from);const before=await state();
    await expect(invoke(domain)).rejects.toThrow('不一致');
    expect(await attempts()).toEqual([]);expect(network).toHaveBeenCalledTimes(1);expect(await state()).toEqual(before);
    expect(await cases()).toMatchObject([{profile:'wechat',status:'CONFLICT'}]);
  });
  it.each(['store_order','membership'] as const)('Alipay→Mini for %s preserves the original signed URL and refuses new HTTP',async domain=>{
    const result=await invokeOther(domain,'alipay');verifyAlipay(result);const before=await state(),registered=await cases();
    await expect(invoke(domain)).rejects.toThrow('付款已发起');
    expect(await cases()).toEqual(registered);expect(await attempts()).toEqual([]);expect(await state()).toEqual(before);expect(network).not.toHaveBeenCalled();
  });
  it.each(DOMAINS)('%s checks the committed Mini intent while its HTTP is still pending',async domain=>{
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
    network.mockImplementation(async()=>{expect(transactionContext.getStore()).not.toBe(true);expect(await attempts()).toHaveLength(1);entered();await hold;return signedResponse({prepay_id:'paused_mini_prepay'});});
    const first=outcome(invoke(domain));await started;
    try {await expect(invokeOther(domain,domain==='recharge'?'h5':'alipay')).rejects.toThrow();expect(network).toHaveBeenCalledTimes(1);}
    finally{release();}
    const finished=await first;
    if(domain==='recharge')expect(finished.ok).toBe(false); // durable same-provider conflict needs reconciliation
    else expect(finished.ok).toBe(true);
    expect(await attempts()).toHaveLength(2);expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['store_order','membership'] as const)('concurrent Mini and Alipay for %s admit one rail on real transactions',async domain=>{
    const results=await Promise.all([outcome(invoke(domain)),outcome(invokeOther(domain,'alipay'))]);
    expect(results.filter(x=>x.ok)).toHaveLength(1);const registered=await cases();expect(registered).toHaveLength(1);
    if(results[0].ok){expect(registered[0].profile).toBe('routine');expect(network).toHaveBeenCalledTimes(1);expect(await attempts()).toHaveLength(2);}
    else{expect(registered[0].profile).toBe('alipay');expect(network).not.toHaveBeenCalled();expect(await attempts()).toEqual([]);}
  });
  it('never interprets a cleaned registry as proof that the immutable Mini attempt did not exist',async()=>{
    await invoke('store_order');await f.db.delete(paymentReconciliationCase);const saved=await attempts();
    await expect(invokeOther('store_order','alipay')).rejects.toThrow('切换渠道前');expect(await cases()).toEqual([]);expect(await attempts()).toEqual(saved);expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['UNKNOWN','NO_PAYMENT','CLOSED','CONFLICT'] as const)('foreign %s is recovery, never a switch or a fresh initiated case',async status=>{
    await registerPaymentReconciliationIntent(container(),{provider:'wechat',profile:'routine',orderDomain:'store_order',orderNo:ORDERS.store_order.orderNo,expectedAmountCents:1250});
    await f.db.update(paymentReconciliationCase).set({status});const before=await cases();
    await expect(invokeOther('store_order','alipay')).rejects.toThrow('切换渠道前');expect(await cases()).toEqual(before);expect(network).not.toHaveBeenCalled();
  });
  it('the actual manual query RETRY cannot reopen an old rail for Alipay capability delivery',async()=>{
    const row=await registerPaymentReconciliationIntent(container(),{provider:'wechat',profile:'routine',orderDomain:'store_order',orderNo:ORDERS.store_order.orderNo,expectedAmountCents:1250});
    await f.db.update(paymentReconciliationCase).set({status:'UNKNOWN',lastErrorCode:'queue_dispatch_failed'});
    await new PaymentReconciliationService(container(),env).decide({caseId:row.id,adminId:7,actionKey:crypto.randomUUID(),action:'retry',reasonCode:'retry_original_query'});
    const before=await cases();expect(before).toMatchObject([{status:'OPEN',initiatedTime:0,lastQueryTime:0}]);
    await expect(invokeOther('store_order','alipay')).rejects.toThrow('切换渠道前');expect(await cases()).toEqual(before);expect(network).not.toHaveBeenCalled();
  });
  it.each(['store_order','membership'] as const)('%s checks its own Alipay CONFLICT rather than returning freshly signed material',async domain=>{
    await registerPaymentReconciliationIntent(container(),{provider:'alipay',profile:'alipay',orderDomain:domain,orderNo:ORDERS[domain].orderNo,expectedAmountCents:100});
    await expect(invokeOther(domain,'alipay')).rejects.toThrow('不一致');expect(await cases()).toMatchObject([{status:'CONFLICT'}]);expect(network).not.toHaveBeenCalled();
  });
  it.each(['store-amount','store-staff','recharge-gift','membership-days'] as const)('rechecks %s inside the shared gate',async kind=>{
    gateway();const domain=kind.startsWith('store')?'store_order':kind.startsWith('recharge')?'recharge':'membership';
    beforeNextTransaction=async()=>{
      if(kind==='store-amount')await f.db.update(storeOrder).set({payPrice:'13.00'});
      if(kind==='store-staff')await f.db.update(storeOrder).set({staffId:8,isChannel:2});
      if(kind==='recharge-gift')await f.db.update(userRecharge).set({givePrice:'3.00'});
      if(kind==='membership-days')await f.db.update(otherOrder).set({vipDay:365});
    };
    await expect(invokeOther(domain,'h5')).rejects.toThrow('变化');expect(await cases()).toEqual([]);expect(network).not.toHaveBeenCalled();
  });
  it('an uncommissioned shared attempt table cannot be mistaken for no Mini history',async()=>{
    await f.exec('DROP TABLE public.routine_payment_attempt');await expect(invokeOther('store_order','alipay')).rejects.toThrow('存储未完整就绪');expect(await cases()).toEqual([]);expect(network).not.toHaveBeenCalled();
  });
  it('preserves existing same-channel non-Mini retry contracts without claiming total HTTP at-most-once',async()=>{
    gateway();await invokeOther('membership','h5');await invokeOther('membership','h5');expect(network).toHaveBeenCalledTimes(2);expect(await cases()).toHaveLength(1);expect(await attempts()).toEqual([]);
  });
  it('a row lock serializes independent rail admissions before either can see a fresh case',async()=>{
    const [order]=await f.db.select().from(storeOrder).where(eq(storeOrder.id,11));
    const admission=await prepareStoreOrderPaymentAdmission(container(),env,7,order);
    await withFinancePeers(f.db,async([holder,waiter,monitor])=>{
      await holder.exec('BEGIN');await holder.exec('SELECT id FROM public.store_order WHERE id=11 FOR UPDATE');
      const queued=outcome(admitExternalPaymentInitiation(createContainerFromDb(waiter.db),{provider:'alipay',profile:'alipay',orderNo:order.orderId,expectedAmountCents:1250,admission}));
      try{await waitForFinanceBlock(monitor.db,waiter.pid,holder.pid);
        await holder.db.execute(sql`INSERT INTO public.payment_reconciliation_case(replay_key,provider,profile,order_domain,order_no,expected_amount_cents,currency,status,initiated_time)
          VALUES(${crypto.randomUUID()},'wechat','routine','store_order',${order.orderId},1250,'CNY','OPEN',floor(extract(epoch FROM clock_timestamp()))::int)`);
      }finally{await holder.exec('COMMIT');}
      const result=await queued;expect(result.ok).toBe(false);expect(await cases()).toMatchObject([{profile:'routine'}]);expect(await attempts()).toEqual([]);expect(network).not.toHaveBeenCalled();
    });
  });
  it('cached capability validation never creates another initiated case',async()=>{
    await invokeOther('store_order','alipay');const before=await cases(),[order]=await f.db.select().from(storeOrder).where(eq(storeOrder.id,11));
    const replay=await assertExternalPaymentReplay(container(),{provider:'alipay',profile:'alipay',orderNo:order.orderId,expectedAmountCents:1250,
      admission:await prepareStoreOrderPaymentAdmission(container(),env,7,order)});
    expect(replay.id).toBe(before[0].id);expect(await cases()).toEqual(before);expect(network).not.toHaveBeenCalled();
  });
});

