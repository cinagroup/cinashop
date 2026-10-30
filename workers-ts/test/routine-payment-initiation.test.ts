import { sign, verify } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { systemConfig, user, wechatUser, storeOrder, paymentReconciliationCase, paymentReconciliationAction } from '@/models/schema';
import { ROUTINE_IDENTITY_WITNESS_SQL } from '@/migrations/routineIdentityWitness';
import { ROUTINE_PAYMENT_ATTEMPT_SQL, inspectRoutinePaymentAttempt } from '@/migrations/routinePaymentAttempt';
import { appendRoutineIdentityWitness } from '@/services/wechat/RoutineIdentityWitness';
import { readRoutineCredentials } from '@/services/wechat/RoutineRuntimeConfig';
import { issueRoutineIdentityObservation } from '@/services/wechat/RoutineIdentityObservation';
import { readPaymentPublicConfig } from '@/services/payment/PaymentPublicRuntimeConfig';
import { registerPaymentReconciliationIntent } from '@/services/payment/PaymentReconciliationRegistry';
import { PaymentReconciliationService } from '@/services/payment/PaymentReconciliationService';
import { readRoutinePaymentReplay, requireRoutinePaymentReady } from '@/services/payment/RoutinePaymentInitiation';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const APP = 'wxownedRoutine001', OTHER = 'wxotherRoutine002', MCH = '1900000109', SERIAL = 'OWNED_PLATFORM_KEY', V3 = 'r'.repeat(32);
const ORDER = 'owned_routine_order', PREPAY = 'owned_routine_prepay', PAYER = 'owned_routine_payer';
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const base = () => ({ routine_appId: APP, pay_weixin_mchid: MCH, pay_weixin_serial_no: 'ABCDEF123456',
  pay_weixin_open: '1', site_url: 'https://owned.example', ali_pay_status: '0', balance_func_status: '1', yue_pay_status: '1', offline_pay_status: '1' });

describe('Mini AppID payer proof and at-most-once payment initiation on owned PG16', () => {
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

  const attempts = () => f.db.execute<{event_kind:string;payload:Record<string,unknown>;created_at:string;signature:string}>(sql`SELECT event_kind,payload,created_at::text,signature FROM public.routine_payment_attempt ORDER BY event_kind`);
  const cases = () => f.db.select().from(paymentReconciliationCase);
  async function corrupt(statement:string) {
    await f.exec('ALTER TABLE public.routine_payment_attempt DISABLE TRIGGER rpa_immutable_rows');
    try { await f.exec(statement); } finally { await f.exec('ALTER TABLE public.routine_payment_attempt ENABLE TRIGGER rpa_immutable_rows'); }
  }
  async function noWitness() {
    await f.exec('DROP TABLE public.routine_identity_witness');
    await f.exec('DROP FUNCTION public.routine_identity_witness_immutable_v1()');
    await f.exec(ROUTINE_IDENTITY_WITNESS_SQL);
  }
  it('records one complete signed local selection and original signed packet without claiming settlement', async () => {
    expect(await inspectRoutinePaymentAttempt(f.db)).toBe(true);
    const result=await create(),rows=await attempts();
    expect(rows).toHaveLength(2); expect(rows.map(row=>row.event_kind)).toEqual(['INITIATION','PREPAY']);
    expect(rows[0].payload).toMatchObject({purpose:'routine_payment_initiation',uid:7,orderId:7,orderDomain:'store_order',
      amountCents:1250,currency:'CNY',appId:APP,merchantId:MCH,payerId:PAYER,bindingId:7,
      witness:{uid:7,bindingId:7,observation:{appId:APP,openid:PAYER}}});
    const body=JSON.parse(String(network.mock.calls[0][1]?.body)); expect(rows[0].payload.providerBody).toEqual(body);
    expect(rows[1].payload).toMatchObject({purpose:'routine_payment_prepay_receipt',intentSignature:rows[0].signature,packet:result});
    expect(rows[1].payload.expiresAt).toBe(Number(rows[0].created_at)+300);
    const serialized=JSON.stringify(rows); for(const secret of ['owned-fixture-secret',V3,keys.privateKey,'session_key']) expect(serialized).not.toContain(secret);
    expect(await cases()).toMatchObject([{profile:'routine',status:'OPEN',providerStatus:'UNKNOWN',providerTransactionId:''}]);
    expect((await f.db.select().from(storeOrder))[0].paid).toBe(0); expect(network).toHaveBeenCalledTimes(1);
  });
  it('cannot promote an old bare binding to an AppID proof', async () => {
    const before=await f.db.select().from(wechatUser); await noWitness();
    await expect(create()).rejects.toThrow('尚未证明属于当前 AppID');
    expect(await attempts()).toEqual([]); expect(await cases()).toEqual([]); expect(await f.db.select().from(wechatUser)).toEqual(before); expect(network).not.toHaveBeenCalled();
  });
  it('cannot use an A observation for B or infer ownership from the current public source', async () => {
    const before=await f.db.select().from(wechatUser); await update('routine_appId',OTHER);
    await expect(create()).rejects.toThrow('尚未证明属于当前 AppID'); expect(await attempts()).toEqual([]);
    expect(await cases()).toEqual([]); expect(await f.db.select().from(wechatUser)).toEqual(before); expect(network).not.toHaveBeenCalled();
  });
  it('accepts the actual B observation without changing UID, rights or old binding facts', async () => {
    await update('routine_appId',OTHER); await f.db.insert(systemConfig).values({id:49,menuName:'routine_appsecret',value:'"new-owned-secret"'});
    const cfg=await readRoutineCredentials(container(),env),proof=issueRoutineIdentityObservation(env,{appId:OTHER,openid:PAYER,sourceStamp:cfg.stamp});
    await withTx(container(),tx=>appendRoutineIdentityWitness(tx,env,{uid:7,observation:proof}));
    await f.db.delete(systemConfig).where(eq(systemConfig.id,49)); const before=await f.db.select().from(user);
    network.mockImplementation(async (_input,init)=>{expect(depth).toBe(0); expect(JSON.parse(String(init?.body)).appid).toBe(OTHER);return response({prepay_id:PREPAY});});
    const result=await create(); expect((await attempts())[0].payload).toMatchObject({uid:7,appId:OTHER}); expect(await f.db.select().from(user)).toEqual(before);
    expect(verify('RSA-SHA256',Buffer.from(`${OTHER}\n${result.timeStamp}\n${result.nonceStr}\n${result.package}\n`),keys.publicKey,Buffer.from(String(result.paySign),'base64'))).toBe(true);
  });
  it.each(['duplicate','official-only','deleted','disabled-user','forged-observation'])('rejects %s payer evidence without durable claim or HTTP', async kind => {
    if(kind==='duplicate') await f.db.insert(wechatUser).values({id:8,uid:7,openid:'other-payer',userType:'routine'});
    if(kind==='official-only') await f.db.update(wechatUser).set({userType:'wechat'});
    if(kind==='deleted') await f.db.update(wechatUser).set({isDel:1});
    if(kind==='disabled-user') await f.db.update(user).set({status:0});
    if(kind==='forged-observation') {await f.exec('ALTER TABLE public.routine_identity_witness DISABLE TRIGGER riw_immutable_rows');
      await f.exec("UPDATE public.routine_identity_witness SET observation=jsonb_set(observation,'{openid}','\"other-payer\"')");
      await f.exec('ALTER TABLE public.routine_identity_witness ENABLE TRIGGER riw_immutable_rows');}
    await expect(create()).rejects.toThrow(); expect(await attempts()).toEqual([]); expect(await cases()).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it('replays the exact packet before reading current AppID, switches, bindings or merchant credentials', async () => {
    const first=await create(),before=await attempts();
    await f.db.delete(systemConfig); await f.db.delete(wechatUser);
    env.WECHAT_MCH_PRIVATE_KEY='unavailable-current-key'; env.WECHAT_PLATFORM_PUBLIC_KEY='unavailable-current-platform';
    expect(await create()).toEqual(first); expect(await attempts()).toEqual(before); expect(network).toHaveBeenCalledTimes(1);
  });
  it('does not re-sign or replace an old packet after a late AppID rotation', async () => {
    const old=network.getMockImplementation()!; network.mockImplementation(async (input,init)=>{const result=await old(input,init);await update('routine_appId',OTHER);return result;});
    const first=await create(); expect(await create()).toEqual(first); expect(network).toHaveBeenCalledTimes(1); expect((await attempts())[0].payload.appId).toBe(APP);
  });
  it('commits the intent before HTTP and a concurrent retry cannot send another request', async () => {
    let entered!:()=>void,release!:()=>void; const started=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
    network.mockImplementation(async ()=>{expect(depth).toBe(0);expect(await attempts()).toHaveLength(1);entered();await hold;return response({prepay_id:PREPAY});});
    const first=create(); await started;
    try {await expect(create()).rejects.toThrow('付款已发起'); expect(network).toHaveBeenCalledTimes(1);} finally {release();}
    expect(await first).toMatchObject({prepay_id:PREPAY}); expect(await attempts()).toHaveLength(2);
  });
  it.each(['network','bad-signature','bad-prepay','signed-rejection'])('a %s outcome keeps the original attempt and never automatically retries', async fault => {
    if(fault==='network') network.mockRejectedValue(Error('owned transport result unknown'));
    else {const value=response(fault==='signed-rejection'?{code:'SYSTEM_ERROR'}:{prepay_id:fault==='bad-prepay'?'bad\nprepay':PREPAY},fault==='signed-rejection'?500:200);
      if(fault==='bad-signature')value.headers.set('Wechatpay-Signature','broken');network.mockResolvedValue(value);}
    await expect(create()).rejects.toThrow(); const before=await attempts(); expect(before).toHaveLength(1); expect(await cases()).toMatchObject([{profile:'routine',providerStatus:'UNKNOWN'}]);
    await update('routine_appId',OTHER); await expect(create()).rejects.toThrow('付款已发起'); expect(await attempts()).toEqual(before); expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['amount','profile','domain','currency'])('persists an existing %s conflict, with no new payer selection or HTTP', async kind => {
    await registerPaymentReconciliationIntent(container(),{provider:'wechat',profile:kind==='profile'?'wechat':'routine',
      orderDomain:kind==='domain'?'recharge':'store_order',orderNo:ORDER,expectedAmountCents:kind==='amount'?1:1250});
    if(kind==='currency')await f.exec("UPDATE public.payment_reconciliation_case SET currency='USD'");
    await expect(create()).rejects.toThrow('不一致'); expect(await attempts()).toEqual([]); expect(await cases()).toMatchObject([{status:'CONFLICT'}]); expect(network).not.toHaveBeenCalled();
  });
  it.each(['initiated','transaction','callback','closed','conflict','other-rail'])('old %s evidence cannot be assigned a new local attempt', async kind => {
    await registerPaymentReconciliationIntent(container(),{provider:kind==='other-rail'?'alipay':'wechat',profile:kind==='other-rail'?'alipay':'routine',
      orderDomain:'store_order',orderNo:ORDER,expectedAmountCents:1250,initiated:kind==='initiated'||kind==='other-rail'});
    if(kind==='transaction')await f.db.update(paymentReconciliationCase).set({providerTransactionId:'old-provider-transaction'});
    if(kind==='callback')await f.db.update(paymentReconciliationCase).set({callbackEventId:7});
    if(kind==='closed')await f.db.update(paymentReconciliationCase).set({status:'CLOSED'});
    if(kind==='conflict')await f.db.update(paymentReconciliationCase).set({status:'CONFLICT'});
    const before=await cases(); await expect(create()).rejects.toThrow('付款已发起'); expect(await cases()).toEqual(before); expect(await attempts()).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it('uses a pristine exact existing case without interpreting it as original ownership', async () => {
    await registerPaymentReconciliationIntent(container(),{provider:'wechat',profile:'routine',orderDomain:'store_order',orderNo:ORDER,expectedAmountCents:1250});
    await create();expect(await cases()).toHaveLength(1);expect(await attempts()).toHaveLength(2);expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['wechat','alipay'] as const)('old %s query/event/lease history cannot become a fresh payment claim', async provider => {
    const fields={providerEventTime:7,attemptCount:1,lastQueryTime:7,leaseUntil:7,leaseToken:crypto.randomUUID(),resolvedTime:7,lastErrorCode:'old_unknown'};
    await registerPaymentReconciliationIntent(container(),{provider,profile:provider==='wechat'?'routine':'alipay',orderDomain:'store_order',orderNo:ORDER,expectedAmountCents:1250});
    for(const [field,value] of Object.entries(fields)) {
      await f.db.update(paymentReconciliationCase).set({[field]:value});
      const before=await cases();await expect(create()).rejects.toThrow('付款已发起');expect(await cases()).toEqual(before);expect(await attempts()).toEqual([]);expect(network).not.toHaveBeenCalled();
      await f.db.update(paymentReconciliationCase).set({[field]:typeof value==='number'?0:''});
    }
  });
  it('the actual manual retry of an old UNKNOWN case authorizes query only, never a new Mini POST', async () => {
    const row=await registerPaymentReconciliationIntent(container(),{provider:'wechat',profile:'routine',orderDomain:'store_order',orderNo:ORDER,expectedAmountCents:1250});
    const queriedAt=Math.floor(Date.now()/1000)-10;
    await f.db.update(paymentReconciliationCase).set({status:'UNKNOWN',attemptCount:2,lastQueryTime:queriedAt,lastErrorCode:'provider_query_unknown'});
    expect(await new PaymentReconciliationService(container(),env).decide({caseId:row.id,adminId:7,actionKey:crypto.randomUUID(),action:'retry',reasonCode:'retry_original_query'})).toEqual({status:'OPEN',duplicate:false});
    const before=await cases();expect(before).toMatchObject([{status:'OPEN',attemptCount:0,lastQueryTime:queriedAt,initiatedTime:0,lastErrorCode:''}]);
    await expect(create()).rejects.toThrow('付款已发起');expect(await cases()).toEqual(before);expect(await attempts()).toEqual([]);expect(network).not.toHaveBeenCalled();
    expect(await f.db.select().from(paymentReconciliationAction)).toMatchObject([{actionType:'RETRY',beforeStatus:'UNKNOWN',afterStatus:'OPEN'}]);
  });
  it.each(['wechat','alipay'] as const)('old %s queue UNKNOWN remains recovery after RETRY clears every mutable marker', async provider => {
    const row=await registerPaymentReconciliationIntent(container(),{provider,profile:provider==='wechat'?'routine':'alipay',orderDomain:'store_order',orderNo:ORDER,expectedAmountCents:1250});
    await f.db.update(paymentReconciliationCase).set({status:'UNKNOWN',lastErrorCode:'queue_dispatch_failed'});
    await new PaymentReconciliationService(container(),env).decide({caseId:row.id,adminId:7,actionKey:crypto.randomUUID(),action:'retry',reasonCode:'retry_original_query'});
    const before=await cases();expect(before).toMatchObject([{status:'OPEN',providerStatus:'UNKNOWN',initiatedTime:0,providerEventTime:0,
      attemptCount:0,lastQueryTime:0,leaseUntil:0,leaseToken:'',resolvedTime:0,lastErrorCode:''}]);
    await expect(create()).rejects.toThrow('付款已发起');expect(await cases()).toEqual(before);expect(await attempts()).toEqual([]);expect(network).not.toHaveBeenCalled();
  });
  it('rolls back selection and registry together if the source changes inside admission', async () => {
    let calls=0;
    await expect(create({routinePayer:{uid:7,orderId:7,orderDomain:'store_order',lockOrder:async bound=>{
      await bound.db.select().from(storeOrder).where(eq(storeOrder.id,7)).for('update');
      if(++calls===2)await bound.db.update(systemConfig).set({value:JSON.stringify(OTHER)}).where(eq(systemConfig.menuName,'routine_appId'));
    }}})).rejects.toThrow('配置已变化');
    expect((await current()).values.routine_appId).toBe(APP);expect(await attempts()).toEqual([]);expect(await cases()).toEqual([]);expect(network).not.toHaveBeenCalled();
  });
  it.each(['owner','physical-id','domain','amount','paid'])('a replay cannot retarget the original %s', async kind => {
    await create();const before=await attempts();
    if(kind==='paid')await f.db.update(storeOrder).set({paid:1});
    const routinePayer={uid:kind==='owner'?8:7,orderId:kind==='physical-id'?8:7,orderDomain:kind==='domain'?'recharge' as const:'store_order' as const,
      lockOrder:async(bound:ReturnType<typeof container>)=>{const [row]=await bound.db.select().from(storeOrder).where(eq(storeOrder.id,7)).for('update');if(row.paid!==0)throw Error('paid order');}};
    await expect(create({routinePayer,amount:kind==='amount'?1:12.5,attach:kind==='domain'?'user_recharge':'product'})).rejects.toThrow();
    expect(await attempts()).toEqual(before);expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['CONFLICT','CLOSED','CONFIRMED'] as const)('a %s registry transition prevents packet replay', async status => {
    await create();await f.db.update(paymentReconciliationCase).set({status});await expect(create()).rejects.toThrow('付款已发起');expect(network).toHaveBeenCalledTimes(1);
  });
  it('a malformed merchant key fails before the durable claim', async () => {
    env.WECHAT_MCH_PRIVATE_KEY='broken';await expect(create()).rejects.toThrow();expect(await attempts()).toEqual([]);expect(await cases()).toEqual([]);expect(network).not.toHaveBeenCalled();
  });
  it('rechecks absolute expiry at final return after the SQL admission has already completed', async () => {
    await create();
    const ready=await readRoutinePaymentReplay(container(),env,{orderNo:ORDER,amountCents:1250,
      admission:{uid:7,orderId:7,orderDomain:'store_order',lockOrder:async bound=>{await bound.db.select().from(storeOrder).where(eq(storeOrder.id,7)).for('update');}}});
    expect(ready.kind).toBe('ready'); if(ready.kind!=='ready')throw Error('fixture did not produce READY');
    expect(requireRoutinePaymentReady(ready)).toMatchObject({prepay_id:PREPAY});
    vi.spyOn(Date,'now').mockReturnValue(ready.expiresAt*1000);
    expect(()=>requireRoutinePaymentReady(ready)).toThrow('付款已发起');expect(network).toHaveBeenCalledTimes(1);
  });
  it.each([731669,731670])('maintenance gate %i prevents reservation without borrowing other locks', async gate => {
    await withFinancePeers(f.db,async([peer])=>{await peer.exec('BEGIN');try{await peer.exec(`SELECT pg_advisory_xact_lock(${gate},0)`);
      await expect(create()).rejects.toThrow('存储未完整就绪');expect(await attempts()).toEqual([]);expect(await cases()).toEqual([]);expect(network).not.toHaveBeenCalled();}finally{await peer.exec('ROLLBACK');}});
  });
  it.each(['UPDATE','DELETE','TRUNCATE'])('immutable storage rejects %s even for its owner', async operation => {
    await create();const before=await attempts();
    const statement=operation==='UPDATE'?"UPDATE public.routine_payment_attempt SET created_at=created_at+1":operation==='DELETE'?'DELETE FROM public.routine_payment_attempt':'TRUNCATE public.routine_payment_attempt';
    await expect(f.exec(statement)).rejects.toMatchObject({code:'42501'});expect(await attempts()).toEqual(before);
  });
  it.each(['signature','payload','receipt-link','orphan'])('detects %s corruption and never reissues provider HTTP', async kind => {
    await create();
    if(kind==='signature')await corrupt("UPDATE public.routine_payment_attempt SET signature=repeat('0',64) WHERE event_kind='INITIATION'");
    if(kind==='payload')await corrupt("UPDATE public.routine_payment_attempt SET payload=jsonb_set(payload,'{appId}','\"other-app\"') WHERE event_kind='INITIATION'");
    if(kind==='receipt-link')await corrupt("UPDATE public.routine_payment_attempt SET payload=jsonb_set(payload,'{intentSignature}',to_jsonb(repeat('0',64))) WHERE event_kind='PREPAY'");
    if(kind==='orphan')await corrupt("DELETE FROM public.routine_payment_attempt WHERE event_kind='INITIATION'");
    await expect(create()).rejects.toThrow();expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['constraint','trigger','extra-column','grant'])('fails closed on %s storage drift without provider HTTP', async drift => {
    if(drift==='constraint')await f.exec('ALTER TABLE public.routine_payment_attempt DROP CONSTRAINT rpa_payload_ck');
    if(drift==='trigger')await f.exec('ALTER TABLE public.routine_payment_attempt DISABLE TRIGGER rpa_immutable_truncate');
    if(drift==='extra-column')await f.exec('ALTER TABLE public.routine_payment_attempt ADD COLUMN unexpected integer');
    if(drift==='grant')await f.exec('GRANT SELECT ON public.routine_payment_attempt TO PUBLIC');
    expect(await inspectRoutinePaymentAttempt(f.db)).toBe(false);await expect(create()).rejects.toThrow('存储未完整就绪');expect(network).not.toHaveBeenCalled();
  });
});

