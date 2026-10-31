/** Independent Node RSA/AES -> production verifier/Hono -> real restricted
 * PG16 -> default recharge consumers. Only provider/Queue/KV transports are
 * local adapters; no real WeChat, Workers, browser or historical UID claim. */
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env, OrderMessage, PaymentCallbackMessage, PaymentReconciliationMessage } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { paymentCallbackEvent, paymentReconciliationCase, systemConfig, user, userRecharge, wechatUser } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE } from '@/migrations/routinePaymentAccountPolicy';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment, routinePaymentAccountAuthorizationOf,
  prepareRoutineApprovedUseTx, appendRoutineApprovedUseTx, type RoutineAccountPolicy, type RoutineAccountQueryPlan } from '@/services/payment/RoutineApprovedPaymentAccount';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { PaymentCallbackEventService, consumePaymentCallbackMessage, isPaymentCallbackMessage,
  type VerifiedPaymentCallback } from '@/services/payment/PaymentCallbackEventService';
import { PaymentReconciliationService, consumePaymentReconciliationMessage,
  isPaymentReconciliationMessage } from '@/services/payment/PaymentReconciliationService';
import type { PaymentProviderQuery, PaymentProviderQueryRequest } from '@/services/payment/PaymentProviderQuery';
import { prepareRoutineOriginalPaymentTx, appendRoutineOriginalPaymentTx, parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { routineProviderObservationOf } from '@/services/payment/RoutineProviderObservation';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { isOrderPaidOutboxMessage } from '@/services/order/OrderOutboxService';
import { wechatPayNotify } from '@/controllers/api/v1/WechatController';
import { alipayNotify } from '@/controllers/api/v1/PayController';
import { paymentNotify } from '@/controllers/api/v1/PaymentCallbackController';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';

const APP_ID = 'wx-local-query', MERCHANT = '1234567890', PAYER = 'phase28_actual_provider_payer';
const BUYER_BINDING = 'phase28_buyer_current_binding', OTHER_PAYER = 'phase28_conflicting_provider_payer';
const ACCOUNT='approved_old_account', REF='approved_merchant_ref', CURRENT_APP='wx_unrelated_current', CURRENT_MERCHANT='9876543210';
const APP_KEY = 'owned-phase28-original-authenticator', AES_KEY = 'a'.repeat(32);
const SUCCESS_TIME = '2026-09-19T12:00:00+08:00';
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer: infer P) => unknown ? P : never;
type SignedCallback = { body: string; headers: Record<string, string> };
let keys: ReturnType<typeof paymentQueryKeys>, currentKeys: ReturnType<typeof paymentQueryKeys>;

function callback(orderNo: string, transactionId: string, overrides: Record<string, unknown> = {}, eventId = randomUUID()): SignedCallback {
  const payload = { appid: APP_ID, mchid: MERCHANT, out_trade_no: orderNo, transaction_id: transactionId,
    trade_state: 'SUCCESS', trade_type: 'JSAPI', payer: { openid: PAYER }, success_time: SUCCESS_TIME,
    amount: { total: 1000, currency: 'CNY' }, ...overrides };
  const nonce = Buffer.from(randomBytes(6)).toString('hex'), associated = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(AES_KEY), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const body = JSON.stringify({ id: eventId, resource_type: 'encrypt-resource', resource: { algorithm: 'AEAD_AES_256_GCM',
    original_type: 'transaction', ciphertext, nonce, associated_data: associated } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { body, headers: { 'content-type': 'application/json', 'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce, 'wechatpay-serial': 'TEST_QUERY_PUBLIC_KEY',
    'wechatpay-signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), keys.privateKey)).toString('base64') } };
}
const request = (orderNo: string): PaymentProviderQueryRequest => ({ provider: 'wechat', profile: 'routine',
  orderDomain: 'recharge', orderNo, expectedAmountCents: 1000, currency: 'CNY' });
type Notify = Awaited<ReturnType<WechatPayService['verifyAndParseNotify']>>;
const minimized = (n: Notify): VerifiedPaymentCallback => ({ provider: 'wechat', profile: 'routine', providerEventId: n.eventId,
  orderNo: n.outTradeNo, transactionId: n.transactionId, tradeState: n.tradeState, amountCents: n.amountTotal,
  currency: 'CNY', providerEventTime: n.providerEventTime });

async function fixture(work: (c: Awaited<ReturnType<typeof context>>) => Promise<void>) {
  const f = await refundRuntimeFixture();
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Owned native PG16 and real independent LOGINs required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const c = await context(f, app, admin);
      await work(c);
      for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const)
        expect(await auditRuntimeBusinessPrivileges(peer.db, kind, c.target)).toMatchObject({ ready: true, failures: [] });
      expect(c.kv).not.toHaveBeenCalled();
    }));
  } finally { await f.close(); }
}

async function context(f: Fixture, app: Peer, admin: Peer) {
  const [identity] = await f.db.execute<{ database: string; maintenance: string }>(sql`SELECT current_database() AS database,current_user AS maintenance`);
  const target = { ...identity, app: app.role, admin: admin.role };
  await f.db.delete(systemConfig).where(inArray(systemConfig.menuName,
    ['routine_appId', 'routine_appsecret', 'pay_weixin_mchid', 'pay_weixin_serial_no', 'site_url', 'pay_weixin_open']));
  await f.db.insert(systemConfig).values(Object.entries({ routine_appId: CURRENT_APP, routine_appsecret: '', pay_weixin_mchid: CURRENT_MERCHANT,
    pay_weixin_serial_no: 'FEDCBA654321', site_url: 'https://query.example', pay_weixin_open: 0 })
    .map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 9 })));
  await f.db.update(user).set({ nowMoney: '100.00', integral:81, level:2, levelStatus:1, isMoneyLevel:1, isEverLevel:1, overdueTime:1999999999 }).where(eq(user.uid, 11));
  await f.db.insert(wechatUser).values([{ uid: 11, userType: 'routine', openid: BUYER_BINDING },
    { uid: 22, userType: 'routine', openid: PAYER }]);
  await runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner });
  expect(await runRoutineOriginalPaymentEvidenceUpgrade(f.db, target)).toMatchObject({ applied: true });
  expect(await runRoutinePaymentAccountPolicyUpgrade(f.db,target)).toMatchObject({applied:true});
  await f.db.insert(userRecharge).values({uid:11,orderId:'czapproved_preserved_history',price:'12.34',paid:1,payTime:1700000000,rechargeType:'weixin',tradeNo:'approved_preserved_paid_tx'});
  const container = createContainerFromDb(app.db), signer = await paymentQueryFixture(container, keys);
  const messages: OrderMessage[] = [], publicJson: string[] = [], pending: Promise<unknown>[] = [];
  const kv = vi.fn(async () => { throw Error('Cached config is not original payment authority'); });
  const materials={ref:REF,version:1,appId:APP_ID,merchantId:MERCHANT,serialNo:'ABCDEF123456',apiV3Key:AES_KEY,privateKey:keys.privateKey,platformPublicKey:keys.publicKey,platformPublicKeyId:'TEST_QUERY_PUBLIC_KEY'};
  const registry=JSON.stringify({format:1,credentials:[materials]});
  const env = { ...signer.env, APP_KEY, ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:registry, WECHAT_MCH_PRIVATE_KEY:currentKeys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY:currentKeys.publicKey, WECHAT_API_V3_KEY:'z'.repeat(32), CONFIG_KV: { get: kv, put: async () => {}, delete: async () => {} },
    ORDER_QUEUE: { send: async (body: OrderMessage) => { messages.push(structuredClone(body)); },
      sendBatch: async (batch: Iterable<{ body: OrderMessage }>) => {
        for (const { body } of batch) {
          expect(Object.getOwnPropertySymbols(body)).toHaveLength(0);
          expect(isPaymentCallbackMessage(body) || isPaymentReconciliationMessage(body) || isOrderPaidOutboxMessage(body)).toBe(true);
          if (isPaymentCallbackMessage(body)) {
            expect(Object.keys(body).sort()).toEqual(['action', 'eventId', 'replayKey']);
            const [committed] = await f.db.execute(sql`SELECT e.trade_state,
              (SELECT count(*)::integer FROM public.routine_original_payment_evidence r WHERE r.source='callback' AND r.source_id=e.provider_event_id) AS originals,
              (SELECT count(*)::integer FROM public.routine_payment_account_use u JOIN public.routine_original_payment_evidence r ON r.evidence_id=u.evidence_id
                WHERE r.source='callback' AND r.source_id=e.provider_event_id) AS uses
              FROM public.payment_callback_event e WHERE e.id=${body.eventId}`);
            expect(committed.originals).toBe(committed.trade_state === 'SUCCESS' ? 1 : 0);
            expect(committed.uses).toBe(committed.trade_state === 'SUCCESS' ? 1 : 0);
          } else if (isPaymentReconciliationMessage(body)) expect(Object.keys(body).sort()).toEqual(['action', 'caseId', 'replayKey']);
          else expect(Object.keys(body).sort()).toEqual(['action', 'eventKey', 'outboxId']);
          messages.push(structuredClone(body));
        }
      } } } as unknown as Env;
  const pay = new WechatPayService(container, env), callbacks = new PaymentCallbackEventService(container, env);
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, props: {}, passThroughOnException: () => { throw Error('Unexpected origin fallback'); } };
  const post = async (signed: SignedCallback, accountId=ACCOUNT, db: DbClient = app.db) => {
    const h = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    h.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); });
    h.all('/api/pay/notify/:type', c => paymentNotify(c, { alipayNotify, wechatPayNotify }));
    h.post('/api/pay/notify/routine-account/:accountId',c=>wechatPayNotify(c,'routine',c.req.param('accountId')));
    const response = await h.request('/api/pay/notify/routine-account/'+encodeURIComponent(accountId), { method: 'POST', body: signed.body, headers: signed.headers }, env, ctx);
    await Promise.all(pending.splice(0));
    const raw = await response.text(); publicJson.push(raw);
    return { status: response.status, body: JSON.parse(raw) as { code: string; message: string } };
  };
  const recharge = async (orderNo: string, values: Partial<typeof userRecharge.$inferInsert> = {}) => {
    const [row] = await f.db.insert(userRecharge).values({ uid: 11, orderId: orderNo, price: '10.00', givePrice: '1.50', ...values }).returning();
    return row;
  };
  const ledger = async () => Array.from(await f.db.execute<{ row: unknown; version: string }>(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version
    FROM public.routine_original_payment_evidence t ORDER BY evidence_id`), r => ({ row: parseRoutineOriginalEvidence(env, r.row), version: r.version }));
  const financial = async () => {
    const [row] = await f.db.execute(sql`SELECT jsonb_build_object(
      'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY uid) FROM public."user" t),
      'wechat',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.wechat_user t),
      'orders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_recharge t),
      'bills',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_bill t)) AS value`);
    return row.value;
  };
  const wallet = async () => (await f.db.select({ balance: user.nowMoney }).from(user).where(eq(user.uid, 11)))[0].balance;
  const caseRow = async (orderNo: string) => (await f.db.select().from(paymentReconciliationCase).where(eq(paymentReconciliationCase.orderNo, orderNo)))[0];
  const queryCase = async (orderNo: string, query?: PaymentProviderQuery, orderDomain: PaymentProviderQueryRequest['orderDomain']='recharge') => {
    const service = new PaymentReconciliationService(container, env, query);
    const registered = await service.registerIntent({ ...request(orderNo), orderDomain, initiatedAt: Math.floor(Date.now()/1000)-121 });
    await service.dispatchPage({ action: 'dispatchPaymentReconciliation', scheduledAt: Date.now(), cursor: 0 });
    const message = messages.filter(isPaymentReconciliationMessage).find(row => row.caseId === registered.id);
    if (!message) throw Error('Actual reconciliation dispatch did not publish the case');
    return { service, message, registered };
  };
  const signedQuery = (orderNo: string, transactionId: string, overrides: Record<string, unknown> = {}) => signer.wechatResponse(signer.wxBody({
    out_trade_no: orderNo, transaction_id: transactionId, payer: { openid: PAYER }, ...overrides }));
  let accountRevision=0;
  const plans=new Map<string,number>();
  const accountData=(patch:Partial<RoutineAccountPolicy>={}):RoutineAccountPolicy=>{
    const now=Math.floor(Date.now()/1000),commitment=routinePaymentCredentialCommitment(env,REF,1);
    return {accountId:ACCOUNT,state:'active',appId:APP_ID,merchantId:MERCHANT,credentialRef:REF,credentialVersion:1,
      credentialStamp:commitment.credentialStamp,purposes:['query','notify'],validFrom:now-60,validUntil:now+3600,...patch};
  };
  const approve=async(patch:Partial<RoutineAccountPolicy>={})=>{
    const data=accountData(patch),receipt=await appendRoutinePaymentAccountPolicy(f.db,env,target,
      {operationId:randomUUID(),expectedRevision:accountRevision,kind:'account',data});
    accountRevision=receipt.revision;return {data,...receipt};
  };
  const plan=async(req:PaymentProviderQueryRequest,patch:Partial<RoutineAccountQueryPlan>={})=>{
    const now=Math.floor(Date.now()/1000),data:RoutineAccountQueryPlan={state:'active',accountId:ACCOUNT,accountRevision,
      request:{...req},validFrom:now-60,validUntil:now+1800,...patch};
    const receipt=await appendRoutinePaymentAccountPolicy(f.db,env,target,
      {operationId:randomUUID(),expectedRevision:plans.get(req.orderNo)??0,kind:'query',data});
    plans.set(req.orderNo,receipt.revision);return {data,...receipt};
  };
  const uses=async()=>Array.from(await f.db.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version
    FROM public.routine_payment_account_use t ORDER BY use_id`));
  const policies=async()=>Array.from(await f.db.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version
    FROM public.routine_payment_account_policy t ORDER BY record_id`));
  const clearCurrent=async()=>{
    await f.db.update(systemConfig).set({value:JSON.stringify('')}).where(inArray(systemConfig.menuName,
      ['routine_appId','pay_weixin_mchid','pay_weixin_serial_no','site_url']));
  };
  return { f,app,admin,target,container,signer,env,pay,callbacks,messages,publicJson,kv,post,recharge,ledger,financial,
    wallet,caseRow,queryCase,signedQuery,approve,plan,accountData,uses,policies,clearCurrent,registry,materials };
}
type Context = Awaited<ReturnType<typeof context>>;
async function consumeCallback(c: Context, message: PaymentCallbackMessage) {
  const ack = vi.fn(), retry = vi.fn();
  await consumePaymentCallbackMessage({ body: message, attempts: 1, ack, retry }, c.callbacks);
  return { ack, retry };
}
async function consumeQuery(service: PaymentReconciliationService, message: PaymentReconciliationMessage) {
  const ack = vi.fn(), retry = vi.fn();
  await consumePaymentReconciliationMessage({ body: message, attempts: 1, ack, retry }, service);
  return { ack, retry };
}
const noPayer = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [PAYER, BUYER_BINDING, OTHER_PAYER, APP_KEY, AES_KEY, 'BEGIN PRIVATE KEY']) expect(text).not.toContain(secret);
};

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('approved historical Routine accounts through real PG16 and provider crypto',()=>{
  beforeAll(()=>{keys=paymentQueryKeys();currentKeys=paymentQueryKeys();});
  beforeEach(()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unstubbed external I/O forbidden'));
    vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});
  });
  afterEach(()=>{
    try{noPayer([vi.mocked(console.log).mock.calls,vi.mocked(console.warn).mock.calls,vi.mocked(console.error).mock.calls]);}
    finally{vi.restoreAllMocks();}
  });

  it('queries the explicitly planned original account with current B and with cleared current config, without reassigning old users',async()=>fixture(async c=>{
    const bindings=await c.f.db.select().from(wechatUser),[payer]=await c.f.db.select().from(user).where(eq(user.uid,22));
    const [history]=await c.f.db.select().from(userRecharge).where(eq(userRecharge.orderId,'czapproved_preserved_history'));
    await c.approve();
    for(const [index,number] of ['czapproved_current_b','czapproved_current_clear'].entries()){
      if(index)await c.clearCurrent();
      const order=await c.recharge(number);await c.plan(request(number));
      vi.mocked(fetch).mockImplementation(async(url,init)=>{
        expect(typeof url).toBe('string');expect(c.signer.verifyRequest(String(url),init!)).toBe(true);
        expect(new URL(String(url)).searchParams.get('mchid')).toBe(MERCHANT);
        const [idle]=await c.f.db.execute(sql`SELECT state,xact_start IS NULL AS ended FROM pg_catalog.pg_stat_activity WHERE pid=${c.app.pid}`);
        expect(idle).toEqual({state:'idle',ended:true});
        if(!c.f.withPeer)throw Error('Independent peer required');
        await c.f.withPeer(peer=>peer.db.transaction(tx=>tx.execute(sql`SELECT id FROM public.user_recharge WHERE id=${order.id} FOR UPDATE NOWAIT`)));
        return c.signedQuery(number,'approved_query_'+index);
      });
      const query=await c.queryCase(number),done=await consumeQuery(query.service,query.message);
      expect(done.ack).toHaveBeenCalledOnce();expect(done.retry).not.toHaveBeenCalled();
      expect(await c.caseRow(number)).toMatchObject({status:'SETTLED',orderDomain:'recharge'});
      expect((await c.f.db.select().from(userRecharge).where(eq(userRecharge.id,order.id)))[0])
        .toMatchObject({uid:11,paid:1,tradeNo:'approved_query_'+index});
    }
    expect(fetch).toHaveBeenCalledTimes(2);expect(await c.wallet()).toBe('123.00');
    expect(await c.uses()).toHaveLength(2);expect(await c.ledger()).toHaveLength(2);
    expect(await c.f.db.select().from(wechatUser)).toEqual(bindings);
    expect((await c.f.db.select().from(user).where(eq(user.uid,22)))[0]).toEqual(payer);
    expect((await c.f.db.select().from(userRecharge).where(eq(userRecharge.id,history.id)))[0]).toEqual(history);
    const [buyer]=await c.f.db.select().from(user).where(eq(user.uid,11));
    expect(buyer).toMatchObject({integral:81,level:2,isMoneyLevel:1,isEverLevel:1});noPayer(c.messages);noPayer(c.publicJson);
  }),180000);

  it('accepts the opaque Hono callback route, commits its sidecar with the event and replays original rows without changing xmin',async()=>fixture(async c=>{
    await c.approve();const order=await c.recharge('czapproved_callback'),signed=callback(order.orderId,'approved_callback_tx');
    expect(await c.post(signed)).toEqual({status:200,body:{code:'SUCCESS',message:'成功'}});
    const original=await c.ledger(),uses=await c.uses();expect(original).toHaveLength(1);expect(uses).toHaveLength(1);
    expect(uses[0].row).toMatchObject({evidence_id:original[0].row.evidence_id,payload:{evidenceSignature:original[0].row.signature,
      scopeMatches:true,authorization:{account:{subject_id:ACCOUNT,revision:1},query:null,
        observation:{facts:{appId:APP_ID,merchantId:MERCHANT,payerId:PAYER}}}}});
    expect(await c.wallet()).toBe('100.00');
    const message=c.messages.filter(isPaymentCallbackMessage)[0];expect(message).toBeDefined();
    const done=await consumeCallback(c,message);expect(done.ack).toHaveBeenCalledOnce();expect(done.retry).not.toHaveBeenCalled();
    expect(await c.wallet()).toBe('111.50');const paid=await c.financial();
    expect((await c.post(signed)).status).toBe(200);
    expect(await c.callbacks.processMessage(message)).toBe('already-completed');
    expect(await c.ledger()).toEqual(original);expect(await c.uses()).toEqual(uses);expect(await c.financial()).toEqual(paid);
    expect(fetch).not.toHaveBeenCalled();noPayer(c.messages);noPayer(c.publicJson);
  }),180000);

  it('refuses missing approval or registry, changed material commitments, wrong refs and revoked purposes without provider HTTP',async()=>fixture(async c=>{
    const order=await c.recharge('czapproved_denied'),signed=callback(order.orderId,'approved_denied_tx'),before=await c.financial();
    await expect(c.pay.verifyAndParseNotify(signed.headers,signed.body,'routine',ACCOUNT)).rejects.toMatchObject({code:503});
    expect((await c.post(signed)).status).toBe(400);
    const empty=await c.policies();
    for(const patch of [{credentialStamp:'0'.repeat(64)},{credentialRef:'unprovisioned_ref'}])
      await expect(c.approve(patch)).rejects.toMatchObject({code:503});
    expect(await c.policies()).toEqual(empty);
    await c.approve();await c.plan(request(order.orderId));
    for(const registry of [undefined,JSON.stringify({format:1,credentials:[]}),
      JSON.stringify({format:1,credentials:[{...c.materials,privateKey:currentKeys.privateKey}]})]){
      c.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;
      await expect(c.pay.queryOrder(request(order.orderId))).rejects.toMatchObject({code:503});
      await expect(c.pay.verifyAndParseNotify(signed.headers,signed.body,'routine',ACCOUNT)).rejects.toMatchObject({code:503});
    }
    c.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=c.registry;
    const policies=await c.policies();
    await expect(new WechatPayService(createContainerFromDb(c.admin.db),c.env).queryOrder(request(order.orderId))).rejects.toMatchObject({code:503});
    expect((await c.post(signed,ACCOUNT,c.admin.db)).status).toBe(400);
    await expect(appendRoutinePaymentAccountPolicy(c.admin.db,c.env,c.target,
      {operationId:randomUUID(),expectedRevision:0,kind:'account',data:c.accountData()})).rejects.toMatchObject({code:503});
    expect(await c.policies()).toEqual(policies);
    await c.approve({purposes:['query']});
    await expect(c.pay.verifyAndParseNotify(signed.headers,signed.body,'routine',ACCOUNT)).rejects.toMatchObject({code:503});
    await expect(c.pay.queryOrder(request(order.orderId))).rejects.toMatchObject({code:503}); // latest revision invalidates old pinned plan
    await c.approve({state:'revoked'});
    await expect(c.pay.verifyAndParseNotify(signed.headers,signed.body,'routine',ACCOUNT)).rejects.toMatchObject({code:503});
    await expect(c.pay.queryOrder(request(order.orderId))).rejects.toMatchObject({code:503});
    expect(fetch).not.toHaveBeenCalled();expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);
    expect(await c.financial()).toEqual(before);expect(c.messages).toEqual([]);
  }),180000);

  it('uses only the latest exact query plan and never falls back from a revoked, mismatched or not-yet-valid plan',async()=>fixture(async c=>{
    await c.approve();const first=await c.recharge('czapproved_plan_revoked'),second=await c.recharge('czapproved_plan_future');
    await c.plan(request(first.orderId));await c.plan(request(first.orderId),{state:'revoked'});
    await c.plan(request(second.orderId),{validFrom:Math.floor(Date.now()/1000)+600,validUntil:Math.floor(Date.now()/1000)+1200});
    const before=await c.financial();
    await expect(c.pay.queryOrder(request(first.orderId))).rejects.toMatchObject({code:503});
    await expect(c.pay.queryOrder(request(second.orderId))).rejects.toMatchObject({code:503});
    const third=await c.recharge('czapproved_plan_amount');await c.plan(request(third.orderId));
    await expect(c.pay.queryOrder({...request(third.orderId),expectedAmountCents:999})).rejects.toMatchObject({code:503});
    await expect(c.pay.queryOrder({...request(third.orderId),orderDomain:'membership'})).rejects.toMatchObject({code:503});
    expect(fetch).not.toHaveBeenCalled();expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);
    // The only additional business row is the deliberately seeded third unpaid order.
    const after=await c.financial();expect((after as {users:unknown}).users).toEqual((before as {users:unknown}).users);
  }),180000);

  it('rejects an approval revoked while the real query is in flight, with no order lock held during HTTP or scalar pollution',async()=>fixture(async c=>{
    await c.approve();const order=await c.recharge('czapproved_network_revoke');await c.plan(request(order.orderId));
    const before=await c.financial();let revoked=false;
    vi.mocked(fetch).mockImplementation(async(url,init)=>{
      expect(c.signer.verifyRequest(String(url),init!)).toBe(true);
      if(!c.f.withPeer)throw Error('Independent peer required');
      await c.f.withPeer(peer=>peer.db.transaction(tx=>tx.execute(sql`SELECT id FROM public.user_recharge WHERE id=${order.id} FOR UPDATE NOWAIT`)));
      await c.approve({state:'revoked'});revoked=true;return c.signedQuery(order.orderId,'approved_revoked_during_http_tx');
    });
    const query=await c.queryCase(order.orderId);await consumeQuery(query.service,query.message);
    expect(revoked).toBe(true);expect(fetch).toHaveBeenCalledOnce();
    expect(await c.caseRow(order.orderId)).toMatchObject({providerTransactionId:'',providerEventTime:0});
    expect((await c.caseRow(order.orderId)).status).not.toBe('SETTLED');
    expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);expect(await c.financial()).toEqual(before);
  }),180000);

  it('rechecks a captured genuine callback authorization before entering physical order locks',async()=>fixture(async c=>{
    await c.approve();const order=await c.recharge('czapproved_capture_revoke'),signed=callback(order.orderId,'approved_capture_revoke_tx');
    const decoded=await c.pay.verifyAndParseNotify(signed.headers,signed.body,'routine',ACCOUNT),before=await c.financial();
    await c.approve({state:'revoked'});
    await expect(c.callbacks.receive(minimized(decoded),{appId:APP_ID,merchantId:MERCHANT,payerId:PAYER},
      routineProviderObservationOf(decoded),routinePaymentAccountAuthorizationOf(decoded))).rejects.toMatchObject({code:503});
    expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);expect(await c.financial()).toEqual(before);
    expect(await c.f.db.select().from(paymentCallbackEvent)).toEqual([]);expect(fetch).not.toHaveBeenCalled();
  }),180000);

  it('rolls use, original, event and outbox back together and then accepts the same real signed callback',async()=>fixture(async c=>{
    await c.approve();const order=await c.recharge('czapproved_atomic'),signed=callback(order.orderId,'approved_atomic_tx');
    const before=await c.financial(),role=pricingIdentifier(c.app.role);
    await c.f.exec(`REVOKE INSERT ON public.payment_callback_outbox FROM ${role}`);
    try{
      expect((await c.post(signed)).status).toBe(400);
      expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);expect(c.messages).toEqual([]);
      for(const table of ['payment_callback_event','payment_callback_outbox','payment_reconciliation_case'])
        expect(await c.f.db.execute(sql.raw(`SELECT * FROM public.${table}`))).toEqual([]);
      expect(await c.financial()).toEqual(before);
    }finally{await c.f.exec(`GRANT INSERT ON public.payment_callback_outbox TO ${role}`);}
    const decoded=await c.pay.verifyAndParseNotify(signed.headers,signed.body,'routine',ACCOUNT),abort=Error('Owned approved-use transaction abort');
    await expect(withTx(c.container,async tx=>{
      const accountUse=await prepareRoutineApprovedUseTx(tx,c.env,routinePaymentAccountAuthorizationOf(decoded),routineProviderObservationOf(decoded));
      const prepared=await prepareRoutineOriginalPaymentTx(tx,c.env,routineProviderObservationOf(decoded),{source:'callback',...minimized(decoded)});
      if(!prepared || !accountUse)throw Error('Actual commissioned preparations required');
      const original=await appendRoutineOriginalPaymentTx(tx,c.env,prepared);await appendRoutineApprovedUseTx(tx,c.env,accountUse,original.row);
      expect(await tx.execute(sql`SELECT * FROM public.routine_payment_account_use`)).toHaveLength(1);throw abort;
    })).rejects.toBe(abort);
    expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);expect(await c.financial()).toEqual(before);
    expect((await c.post(signed)).status).toBe(200);await consumeCallback(c,c.messages.filter(isPaymentCallbackMessage)[0]);
    expect(await c.wallet()).toBe('111.50');expect(await c.ledger()).toHaveLength(1);expect(await c.uses()).toHaveLength(1);
  }),180000);

  it('keeps pending responses out of the paid original and authorization-use ledgers',async()=>fixture(async c=>{
    await c.approve();const order=await c.recharge('czapproved_pending_callback'),before=await c.financial();
    const pending=callback(order.orderId,'approved_pending_tx',{trade_state:'NOTPAY',payer:{},success_time:undefined});
    expect((await c.post(pending)).status).toBe(200);await consumeCallback(c,c.messages.filter(isPaymentCallbackMessage)[0]);
    expect(await c.financial()).toEqual(before);expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);
    const queryOrder=await c.recharge('czapproved_pending_query');await c.plan(request(queryOrder.orderId));
    vi.mocked(fetch).mockResolvedValue(c.signedQuery(queryOrder.orderId,'unused_pending_query_tx',{trade_state:'NOTPAY',payer:{}}));
    const query=await c.queryCase(queryOrder.orderId);await consumeQuery(query.service,query.message);
    expect(await c.caseRow(queryOrder.orderId)).toMatchObject({status:'WAITING',providerStatus:'PENDING'});
    expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);expect(await c.wallet()).toBe('100.00');
  }),180000);

  it('requires the actual approved pair and platform serial even when RSA and AES contents are otherwise genuine',async()=>fixture(async c=>{
    await c.approve();const order=await c.recharge('czapproved_bad_pair');await c.plan(request(order.orderId));const before=await c.financial();
    vi.mocked(fetch).mockImplementation(async()=>c.signedQuery(order.orderId,'approved_wrong_pair_tx',{appid:CURRENT_APP}));
    expect((await c.pay.queryOrder(request(order.orderId))).status).toBe('UNKNOWN');
    vi.mocked(fetch).mockImplementation(async()=>{
      const r=c.signedQuery(order.orderId,'approved_wrong_serial_tx');r.headers.set('Wechatpay-Serial','UNAPPROVED_PLATFORM_KEY');return r;
    });
    await expect(c.pay.queryOrder(request(order.orderId))).rejects.toThrow();
    expect((await c.post(callback(order.orderId,'approved_callback_wrong_pair',{appid:CURRENT_APP}))).status).toBe(400);
    const wrongSerial=callback(order.orderId,'approved_callback_wrong_serial');wrongSerial.headers['wechatpay-serial']='UNAPPROVED_PLATFORM_KEY';
    expect((await c.post(wrongSerial)).status).toBe(400);
    expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);expect(await c.financial()).toEqual(before);
  }),180000);

  it('cannot spend one genuine account-qualified query capability on another order or query domain',async()=>fixture(async c=>{
    await c.approve();const a=await c.recharge('czapproved_scope_a'),b=await c.recharge('czapproved_scope_b');
    await c.plan(request(a.orderId));await c.plan(request(b.orderId));
    vi.mocked(fetch).mockImplementation(async()=>c.signedQuery(a.orderId,'approved_scope_a_tx'));
    const genuine=await c.pay.queryOrder(request(a.orderId));expect(routinePaymentAccountAuthorizationOf(genuine)).toBeDefined();noPayer(genuine);
    const before=await c.financial(),wrong=await c.queryCase(b.orderId,async()=>genuine);await consumeQuery(wrong.service,wrong.message);
    expect(await c.caseRow(b.orderId)).toMatchObject({providerTransactionId:'',providerEventTime:0});
    expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);expect(await c.financial()).toEqual(before);
    const domain=await c.recharge('czapproved_scope_domain'),storeRequest={...request(domain.orderId),orderDomain:'store_order' as const};
    await c.plan(storeRequest);vi.mocked(fetch).mockImplementation(async()=>c.signedQuery(domain.orderId,'approved_scope_domain_tx'));
    const storeCapability=await c.pay.queryOrder(storeRequest),cross=await c.queryCase(domain.orderId,async()=>storeCapability);
    await consumeQuery(cross.service,cross.message);
    expect(await c.caseRow(domain.orderId)).toMatchObject({providerTransactionId:'',providerEventTime:0});
    expect(await c.ledger()).toEqual([]);expect(await c.uses()).toEqual([]);expect(await c.wallet()).toBe('100.00');
    const right=await c.queryCase(a.orderId,async()=>genuine);await consumeQuery(right.service,right.message);
    expect(await c.caseRow(a.orderId)).toMatchObject({status:'SETTLED'});expect(await c.wallet()).toBe('111.50');
    expect(await c.ledger()).toHaveLength(1);expect(await c.uses()).toHaveLength(1);noPayer(c.messages);
  }),180000);

  it('retains genuine provider facts and a non-authorizing sidecar when the approved domain does not identify the physical order',async()=>fixture(async c=>{
    await c.approve();const physical=await c.recharge('czapproved_physical_domain');
    const planned={...request(physical.orderId),orderDomain:'store_order' as const};await c.plan(planned);const before=await c.financial();
    vi.mocked(fetch).mockImplementation(async()=>c.signedQuery(physical.orderId,'approved_wrong_physical_tx'));
    const query=await c.queryCase(physical.orderId,undefined,'store_order');await consumeQuery(query.service,query.message);
    const ledger=await c.ledger();expect(ledger).toHaveLength(1);expect(ledger[0].row.payload.observation.facts)
      .toMatchObject({orderNo:physical.orderId,appId:APP_ID,merchantId:MERCHANT,transactionId:'approved_wrong_physical_tx'});
    const uses=await c.uses();expect(uses).toHaveLength(1);expect(uses[0].row).toMatchObject({payload:{scopeMatches:false}});
    expect(await c.caseRow(physical.orderId)).toMatchObject({status:'CONFLICT'});expect(await c.financial()).toEqual(before);
  }),180000);

  it('preserves an accepted SUCCESS after revocation and settles while a peer holds the exclusive account gate',async()=>fixture(async c=>{
    await c.approve();const order=await c.recharge('czapproved_durable'),signed=callback(order.orderId,'approved_durable_tx');
    expect((await c.post(signed)).status).toBe(200);const originals=await c.ledger(),uses=await c.uses();
    await c.approve({state:'revoked'});if(!c.f.withPeer)throw Error('Independent peer required');
    await c.f.withPeer(peer=>peer.db.transaction(async tx=>{
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE[0]},${ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE[1]})`);
      const done=await consumeCallback(c,c.messages.filter(isPaymentCallbackMessage)[0]);
      expect(done.ack).toHaveBeenCalledOnce();expect(done.retry).not.toHaveBeenCalled();expect(await c.wallet()).toBe('111.50');
    }));
    expect(await c.ledger()).toEqual(originals);expect(await c.uses()).toEqual(uses);
    expect(await c.caseRow(order.orderId)).toMatchObject({status:'CONFIRMED'});expect(fetch).not.toHaveBeenCalled();
  }),180000);

  it('captures maintenance declarations and callback authorization before real transaction awaits without changing the authenticated role',async()=>fixture(async c=>{
    const data=c.accountData(),replayData=structuredClone(data),operationId=randomUUID(),input={operationId,expectedRevision:0,kind:'account' as const,data},target={...c.target};
    let maintenanceMutated=false;
    const delayed=(db:DbClient,mutate:()=>void):DbClient=>new Proxy(db,{get(object,key,receiver){
      const method:unknown=Reflect.get(object,key,receiver);if(typeof method!=='function')return method;
      if(key!=='transaction')return method.bind(object);
      return (...args:unknown[])=>Reflect.apply(method,object,[async(tx:DbClient)=>{await Promise.resolve();mutate();
        return (args[0] as (tx:DbClient)=>Promise<unknown>)(tx);},...args.slice(1)]);
    }});
    const receipt=await appendRoutinePaymentAccountPolicy(delayed(c.f.db,()=>{
      maintenanceMutated=true;input.data.appId=CURRENT_APP;input.data.purposes.splice(0);input.expectedRevision=63;target.app=c.admin.role;
    }),c.env,target,input);
    expect(maintenanceMutated).toBe(true);expect(receipt).toMatchObject({recordId:operationId,revision:1});
    expect((await c.policies())[0].row).toMatchObject({payload:{data:{appId:APP_ID,purposes:['notify','query']}}});
    const policies=await c.policies();c.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=undefined;
    try{
      expect(await appendRoutinePaymentAccountPolicy(c.f.db,c.env,c.target,
        {operationId,expectedRevision:0,kind:'account',data:replayData})).toEqual({recordId:operationId,revision:1,replayed:true});
      expect(await c.policies()).toEqual(policies);
    }finally{c.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=c.registry;}
    const coercion=vi.fn(()=>'recharge'),invalidRequest=request('czapproved_nonprimitive');
    Reflect.set(invalidRequest,'orderDomain',{toString:coercion,toJSON:coercion});
    const now=Math.floor(Date.now()/1000);
    await expect(appendRoutinePaymentAccountPolicy(c.f.db,c.env,c.target,{operationId:randomUUID(),expectedRevision:0,kind:'query',
      data:{state:'active',accountId:ACCOUNT,accountRevision:1,request:invalidRequest,validFrom:now-60,validUntil:now+1800}})).rejects.toMatchObject({code:503});
    expect(coercion).not.toHaveBeenCalled();expect(await c.policies()).toEqual(policies);
    const order=await c.recharge('czapproved_snapshot'),signed=callback(order.orderId,'approved_snapshot_tx');
    const decoded=await c.pay.verifyAndParseNotify(signed.headers,signed.body,'routine',ACCOUNT),callbackInput=minimized(decoded);
    const raw=structuredClone(routinePaymentAccountAuthorizationOf(decoded)) as {signature:string};let callbackMutated=false;
    const service=new PaymentCallbackEventService(createContainerFromDb(delayed(c.app.db,()=>{
      if(callbackMutated)return;callbackMutated=true;callbackInput.orderNo='czmutated_unrelated';raw.signature='0'.repeat(64);
    })),c.env);
    const received=await service.receive(callbackInput,{appId:APP_ID,merchantId:MERCHANT,payerId:PAYER},routineProviderObservationOf(decoded),raw);
    expect(callbackMutated).toBe(true);expect((await c.ledger())[0].row.order_no).toBe(order.orderId);expect(await c.uses()).toHaveLength(1);
    await service.dispatchById(received.outboxId);await consumeCallback(c,c.messages.filter(isPaymentCallbackMessage)[0]);
    expect(await c.wallet()).toBe('111.50');expect(await c.caseRow('czmutated_unrelated')).toBeUndefined();
    expect((await c.f.db.select().from(paymentCallbackEvent))[0].orderNo).toBe(order.orderId);
  }),180000);
});
