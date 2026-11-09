/** Real five-LOGIN checkout, RSA/AES payment, buyer application, Admin request/query, App staging and Queue. Local transports only; no deployment or real provider I/O. */
import { runRefundSuccessNoticeUpgrade, refundSuccessNoticeCommissionedTx, REFUND_SUCCESS_NOTICE_SQL, REFUND_SUCCESS_NOTICE_PREDECESSORS } from '@/migrations/refundSuccessNotice';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { upgradeRoutineRefundActors } from '@/migrations/upgradeRoutineRefundActors';
import { PRODUCT_SAVE_EFFECTS_EVENTS } from '@/migrations/productSaveEffects';
import { finalizeStoreOrderRefund } from '@/services/order/StoreOrderRefundService';
import { assertRoutineNotificationContinuation } from './helpers/routineNotificationContinuationAssertions';
import { Buffer } from 'node:buffer';
import { randomUUID, sign, verify } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import { notificationTemplate, orderNotificationDelivery, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderRefund,
  systemConfig, systemMessage, systemNotification, user, wechatUser,
  type OrderRefundSuccessNoticeOutboxPayload, type WechatTemplateNotificationPayload } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { adminRefundOperationRoutes } from '@/routes/admin-refund-operations';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { appendRoutineRefundAccountPolicy } from '@/services/payment/RoutineRefundAccountPolicy';
import { routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment,
  routineSubscriptionScopeTx, type RoutineSubscriptionAccountPolicy } from '@/services/wechat/RoutineSubscriptionAccount';
import { parseRoutineSubscriptionRefundSuccessRequest } from '@/services/wechat/RoutineSubscriptionRefundSuccessRequest';
import { parseRoutineSubscriptionNoticeIntent } from '@/services/wechat/RoutineSubscriptionNoticeIntent';
import { createToken, md5 } from '@/utils/jwt';
import { managerAssignedFulfillmentFixture, ASSIGNED_APP, ASSIGNED_PAYER, ASSIGNED_MERCHANT,
  ASSIGNED_AES, ASSIGNED_PLATFORM } from './helpers/managerAssignedFulfillmentFixture';

const transport = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const set = vi.fn(async (key: string, value: unknown) => { values.set(key, value); return true; });
  const remove = vi.fn(async (key: string) => values.delete(key));
  const take = vi.fn(async (key: string) => { const value = values.get(key) ?? null; values.delete(key); return value; });
  const setIfAbsent = vi.fn(async (key: string, value: unknown) => { if (values.has(key)) return false; values.set(key, value); return true; });
  const redis = { eval: vi.fn(async () => 1), get, set: vi.fn(async (key: string, value: unknown) => { await set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => Number(await remove(key))) };
  return { values, get, set, remove, take, setIfAbsent, redis };
});
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(),
  getRedis: () => transport.redis, cacheGet: transport.get, cacheSet: transport.set,
  cacheTake: transport.take, cacheDelete: transport.remove, cacheSetIfAbsent: transport.setIfAbsent,
  setTokenBucket: vi.fn(async () => true), clearToken: vi.fn(async () => true) }));

type Fixture = Awaited<ReturnType<typeof managerAssignedFulfillmentFixture>>;
type Event = typeof storeOrderOutbox.$inferSelect;
type Delivery = typeof orderNotificationDelivery.$inferSelect;
type Source = { orderId: number; refundId: number; event: Event };
type Staged = Source & { delivery: Delivery };
const CURRENT_B = 'wx_assigned_current_B', TARGET = 'refusal_owned_buyer_a_not_payer', BARE_B = 'refusal_latest_bare_b_same_uid';
const TEMPLATE = 'refusal_original_template_a', GLOBAL_B = 'refusal_global_template_b', REF = 'refusal_original_secret_a';
const SECRET = 'synthetic-refusal-original-secret-a', PHONE = '13800000011', MARK = 'order_refund';
const ADMIN_PROTOCOL = 'admin-refund-operation-v1';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const message = (event: Event) => ({ action: 'processOrderNotificationOutbox' as const, outboxId: event.id, eventKey: event.eventKey });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual original-account refund-success notification chain', () => {
  let legacyNew: Source;
  let missingOwner: Source, oldSource: {orderId: number; refundId: number};
  let refundPolicy: import('@/services/payment/RoutineRefundAccountPolicy').RoutineRefundAccountPolicy;
  let refundRevision=1;
  let f: Fixture, network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>, policy: RoutineSubscriptionAccountPolicy, revision = 0;

  const app = () => createContainerFromDb(f.appRuntime.db);
  const outbox = () => new OrderOutboxService(app(), f.env);
  const consumer = () => new OrderNotificationDeliveryService(app(), f.env);
  const named = () => ({ database: f.target.database, maintenance: f.target.maintenance, app: f.target.app, admin: f.target.admin });
  const approve = async (patch: Partial<RoutineSubscriptionAccountPolicy> = {}) => {
    const result = await appendRoutineSubscriptionAccountPolicy(f.maintenanceDb, f.env, named(),
      { operationId: randomUUID(), expectedRevision: revision, data: { ...policy, ...patch } }); revision = result.revision; return result;
  };
  const refund = async (id: number) => (await f.maintenanceDb.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, id)))[0]!;
  async function eventFor(id: number) {
    const rows = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, 'order.refund.success.notice:' + id));
    expect(rows).toHaveLength(1); return rows[0];
  }
  const routine = (source: Source) => f.maintenanceDb.select().from(orderNotificationDelivery).where(and(
    eq(orderNotificationDelivery.eventKey, source.event.eventKey), eq(orderNotificationDelivery.channel, 'wechat_routine')));
  async function effects(source: Source) {
    return { sms: await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(
      eq(orderNotificationDelivery.eventKey, source.event.eventKey), eq(orderNotificationDelivery.channel, 'sms'))),
    inbox: await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey, source.event.eventKey)) };
  }
  async function currentB(empty = false) {
    await f.configure(true);
    await f.maintenanceDb.update(systemConfig).set({ value: JSON.stringify(0) }).where(eq(systemConfig.menuName, 'order_shipping_open'));
    if (empty) await f.maintenanceDb.update(systemConfig).set({ value: JSON.stringify('') }).where(eq(systemConfig.menuName, 'routine_appId'));
    await f.maintenanceDb.delete(wechatUser).where(eq(wechatUser.openid, BARE_B));
    await f.maintenanceDb.insert(wechatUser).values({ uid: 11, userType: 'routine', openid: BARE_B });
  }
  async function application() {
    const order = await f.paid(1, 0);
    const response = await f.http('/order/refund/apply/' + order.orderId,
      { refundReason: '真实买家申请', refundExplain: '真实A付款后的原申请', applyType: 1 }, { uid: 11 });
    expect(response.body.status, response.body.msg).toBe(200);
    const id = response.body.data.refundId as number, row = await refund(id);
    expect(row).toMatchObject({ id, storeOrderId: order.id, uid: 11, storeId: 0, supplierId: 0, applyType: 1, refundType: 0, refundNum: 1 });
    const carts = await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(carts).toHaveLength(1); expect(carts[0].refundNum).toBe(1);
    return { order, row };
  }
  function adminApp() {
    const h = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    h.use('*', async (c, next) => { c.set('container', app()); await next(); }); h.onError(errorHandler);
    h.route('/adminapi/refund/operations', adminRefundOperationRoutes); return h;
  }
  async function adminRequest(path: string, key: string, body: unknown) {
    const token = (await createToken(1, 'admin', md5('offline-native-admin-password'), f.env.APP_KEY)).token;
    const response = await adminApp().request('/adminapi/refund/operations/' + path, { method: 'POST', headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Refund-Operation-Scope': 'v1:admin:1',
    }, body: JSON.stringify(body) }, f.env);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    return { response, body: await response.json() as { status: number; msg: string; data: any } };
  }
  async function completed(): Promise<Source>;
  async function completed(beforeSuccess: () => Promise<void>, expectEvent: false): Promise<{orderId: number; refundId: number}>;
  async function completed(beforeSuccess?: () => Promise<void>, expectEvent = true) {
    const { order, row } = await application(); await currentB();
    const key = randomUUID(), body = { version: ADMIN_PROTOCOL, action: 'refund', review: {
      uid: row.uid, storeOrderId: order.id, storeId: row.storeId, supplierId: row.supplierId, orderId: row.orderId, refundPrice: row.refundPrice,
    }, decision: { applyType: row.applyType, refundType: row.refundType, received: false } };
    network.mockImplementation(async (input, init) => {
      const u = new URL(String(input)); expect(u.origin).toBe('https://api.mch.weixin.qq.com');
      const auth = new Headers(init?.headers).get('Authorization') ?? '';
      const fields = Object.fromEntries([...auth.matchAll(/(\w+)="([^"]+)"/gu)].map(m => [m[1],m[2]]));
      expect(fields.mchid).toBe(ASSIGNED_MERCHANT);
      expect(verify('RSA-SHA256',Buffer.from(`${init?.method}\n${u.pathname}${u.search}\n${fields.timestamp}\n${fields.nonce_str}\n${typeof init?.body==='string'?init.body:''}\n`),
        f.env.WECHAT_PLATFORM_PUBLIC_KEY!,Buffer.from(fields.signature,'base64'))).toBe(true);
      const [d] = await f.maintenanceDb.execute<any>(sql`SELECT * FROM public.routine_refund_dispatch WHERE refund_id=${row.id}`);
      const facts = d.payload.request;
      if (init?.method === 'POST') expect(JSON.parse(String(init.body))).toMatchObject({ out_refund_no: 'CNSR'+row.id,
        transaction_id: order.tradeNo, amount: { refund: 500,total: 500,currency:'CNY' } });
      const status = init?.method === 'POST' ? 'PROCESSING' : 'SUCCESS';
      const raw = JSON.stringify({out_trade_no:facts.outTradeNo,transaction_id:facts.transactionId,out_refund_no:d.out_refund_no,
        refund_id:'provider_'+d.out_refund_no,status,...(status==='SUCCESS'?{success_time:new Date().toISOString()}:{}),
        amount:{refund:facts.refundAmount,total:facts.totalAmount,currency:'CNY'}});
      const timestamp=String(Math.floor(Date.now()/1000)),nonce='success-response-'+randomUUID();
      return new Response(raw,{status:200,headers:{'Content-Type':'application/json','Wechatpay-Timestamp':timestamp,
        'Wechatpay-Nonce':nonce,'Wechatpay-Serial':ASSIGNED_PLATFORM,'Wechatpay-Signature':Buffer.from(sign('RSA-SHA256',
          Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),f.env.WECHAT_MCH_PRIVATE_KEY!)).toString('base64')}});
    });
    const first=await adminRequest('execute/'+row.id,key,body);
    expect(first.body.status,first.body.msg).toBe(200);expect(first.body.data.execution).toMatchObject({status:'PROCESSING',completed:false});
    expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,'order.refund.success.notice:'+row.id))).toHaveLength(0);
    await beforeSuccess?.();
    const done=await adminRequest('execute/'+row.id,key,body);
    expect(done.body.status,done.body.msg).toBe(200);expect(done.body.data.execution).toMatchObject({status:'SUCCESS',completed:true});
    if (!expectEvent) {
      expect(await refund(row.id)).toMatchObject({refundType:6,refundedPrice:'5.00'});
      expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,'order.refund.success.notice:'+row.id))).toHaveLength(0);
      const replay=await adminRequest('execute/'+row.id,key,body);expect(replay.body.status,replay.body.msg).toBe(200);
      expect(replay.body.data.receipt).toEqual(done.body.data.receipt);
      network.mockReset().mockRejectedValue(Error('Unexpected provider transport'));return {orderId:order.id,refundId:row.id};
    }
    const event=await eventFor(row.id),saved=clone(event),receipt=done.body.data.receipt;
    expect(await refund(row.id)).toMatchObject({refundType:6,refundedPrice:'5.00',refundedTime:event.addTime});
    const replay=await adminRequest('execute/'+row.id,key,body);
    expect(replay.body.status,replay.body.msg).toBe(200);expect(replay.body.data.receipt).toEqual(receipt);expect(await eventFor(row.id)).toEqual(saved);
    network.mockReset().mockRejectedValue(Error('Unexpected provider transport'));return {orderId:order.id,refundId:row.id,event};
  }
  async function retry(source: Source) {
    // Scheduler projection only. Source/request/intent and attempt counters stay intact.
    await f.maintenanceDb.update(storeOrderOutbox).set({ availableTime: 0 }).where(eq(storeOrderOutbox.id, source.event.id));
    return outbox().processMessage(message(source.event));
  }
  async function signed(source: Source, role = f.adminRuntime.role) {
    const payload = source.event.payload as OrderRefundSuccessNoticeOutboxPayload;
    expect(payload).not.toHaveProperty('routineAppId');
    const request = parseRoutineSubscriptionRefundSuccessRequest(f.env, payload.routineSubscriptionRequest, await routineSubscriptionScopeTx(f.maintenanceDb));
    expect(request).toMatchObject({ format: 5, actor: { role }, aggregateId: source.orderId, eventKey: source.event.eventKey,
      eventTime: source.event.addTime, body: { orderId: source.orderId, refundId: source.refundId, userId: 11, payPrice: '5.00' },
      decision: { refundType: 6, refundAmount: '5.00', refundedTime: source.event.addTime } });
    const [identity] = await f.maintenanceDb.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${role}`);
    expect(request.actor.roleOid).toBe(identity.oid); return request;
  }
  async function staged(source: Source): Promise<Staged> {
    expect(await retry(source)).toBe('completed'); const rows = await routine(source); expect(rows).toHaveLength(1); const delivery = rows[0];
    expect(delivery).toMatchObject({ status: 'PENDING', target: TARGET, templateCode: TEMPLATE, payload: {
      kind: 'wechat_routine', routineAppId: ASSIGNED_APP, routineSubscriptionIntent: { format: 5, outboxId: source.event.id,
        deliveryId: delivery.id, eventKey: source.event.eventKey, source: { appId: ASSIGNED_APP, buyerUid: 11, templateMark: '1451' } },
    } });
    const intent = (delivery.payload as WechatTemplateNotificationPayload).routineSubscriptionIntent;
    expect(parseRoutineSubscriptionNoticeIntent(f.env, intent, await routineSubscriptionScopeTx(f.maintenanceDb))).toEqual(intent);
    return { ...source, delivery };
  }
  async function queued(source: Staged) {
    const before = f.messages.length; expect((await consumer().dispatchPending(30, source.event.eventKey)).enqueued).toBeGreaterThan(0);
    const messages = f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m => m.deliveryId === source.delivery.id);
    expect(messages).toHaveLength(1); return messages[0];
  }
  function provider(lost = false) {
    for (const key of transport.values.keys()) if (key.startsWith('routine:subscription:')) transport.values.delete(key);
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.weixin.qq.com'); expect(init?.redirect).toBe('manual');
      const [idle] = await f.maintenanceDb.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
        WHERE usename IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role}) AND state='idle in transaction'`);
      expect(idle.n).toBe(0);
      if (url.pathname === '/cgi-bin/token') {
        expect(init?.method).toBe('GET'); expect(url.searchParams.get('appid')).toBe(ASSIGNED_APP); expect(url.searchParams.get('secret')).toBe(SECRET);
        return Response.json({ access_token: 'synthetic-refusal-token-a', expires_in: 7200 });
      }
      expect(url.pathname).toBe('/cgi-bin/message/subscribe/send'); expect(init?.method).toBe('POST');
      expect(url.searchParams.get('access_token')).toBe('synthetic-refusal-token-a');
      expect(JSON.parse(String(init?.body))).toMatchObject({ touser: TARGET, template_id: TEMPLATE, data: {
        thing1: { value: '已成功退款' }, amount3: { value: '5.00' },
      } });
      expect(String(init?.body)).not.toContain(ASSIGNED_PAYER); expect(String(init?.body)).not.toContain(BARE_B);
      if (lost) throw Error('Controlled lost response after actual local POST'); return Response.json({ errcode: 0 });
    });
  }
  const posts = () => network.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/cgi-bin/message/subscribe/send');
  const attempts = (source: Staged) => f.maintenanceDb.execute<any>(sql`SELECT * FROM public.routine_subscribe_attempt WHERE delivery_id=${source.delivery.id} ORDER BY attempt_no`);
  const results = (source: Staged) => f.maintenanceDb.execute<any>(sql`SELECT r.* FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${source.delivery.id}`);
  async function ownerA() {
    await f.configure(); await f.maintenanceDb.update(user).set({ phone: PHONE }).where(eq(user.uid, 11));
    await f.maintenanceDb.insert(wechatUser).values({ uid: 11, userType: 'routine', openid: TARGET });
    network.mockImplementation(async input => {
      const url = new URL(String(input)); expect(url.pathname).toBe('/sns/jscode2session'); expect(url.searchParams.get('appid')).toBe(ASSIGNED_APP);
      return Response.json({ openid: TARGET, session_key: Buffer.from('0123456789abcdef').toString('base64') });
    });
    const auth = new WechatAuthService(app(), f.env), ticket = await auth.beginMiniProgramLogin({ code: randomUUID(), ip: '127.0.0.1' });
    const pending = transport.values.get('routine_login:' + ticket.key) as { identity: VerifiedSocialIdentity };
    expect(pending.identity.routineObservation).toMatchObject({ appId: ASSIGNED_APP, openid: TARGET });
    // Explicit server-verified phone continuity input, not a real SMS login.
    expect(await auth.reconcileVerifiedIdentity({ ...pending.identity, phone: PHONE })).toBe(11);
    await currentB(); network.mockReset().mockRejectedValue(Error('Unexpected provider transport'));
  }
  beforeAll(async () => {
    network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unexpected provider transport'));
    f=await managerAssignedFulfillmentFixture();
    await f.maintenanceDb.update(user).set({pwd:'owned-financial-password'}).where(eq(user.uid,11));
    await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await runRoutineSubscriptionUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await runRoutineRefundUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    const finance=await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,f.target,{routineRefund:{routineRefund:true},
      manualRefund:f.manual,originalPaymentReaders:f.readers},f.peers,f.appReaders);
    const actorUpgrade=await upgradeRoutineRefundActors(f.maintenanceDb,f.target,{actors:{admin:true,manager:true}},
      {...finance.peers,routineRefundActors:{admin:true,manager:true}},f.appReaders);
    const ref='success_original_refund_materials',now=Math.floor(Date.now()/1000);
    f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=JSON.stringify({format:1,credentials:[{ref,version:1,
      appId:ASSIGNED_APP,merchantId:ASSIGNED_MERCHANT,serialNo:'A1B2C3D4',apiV3Key:ASSIGNED_AES,
      privateKey:f.env.WECHAT_MCH_PRIVATE_KEY,platformPublicKey:f.env.WECHAT_PLATFORM_PUBLIC_KEY,platformPublicKeyId:ASSIGNED_PLATFORM}]});
    f.env.ROUTINE_REFUND_NOTIFY_ORIGIN='https://refund-local.invalid';
    refundPolicy={accountId:'success_original_refund_account',state:'active',appId:ASSIGNED_APP,merchantId:ASSIGNED_MERCHANT,
      credentialRef:ref,credentialVersion:1,credentialStamp:routinePaymentCredentialCommitment(f.env,ref,1).credentialStamp,
      purposes:['refund_request','refund_query','refund_notify'],validFrom:now-60,validUntil:now+3600};
    await appendRoutineRefundAccountPolicy(f.maintenanceDb,f.env,named(),{operationId:randomUUID(),expectedRevision:0,data:refundPolicy});
    Object.assign(f.env,{ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,
      credentials:[{ref:REF,version:1,appId:ASSIGNED_APP,secret:SECRET}]})});
    policy={accountId:routineSubscriptionAccountId(f.env,ASSIGNED_APP),state:'active',appId:ASSIGNED_APP,
      credentialRef:REF,credentialVersion:1,credentialStamp:routineSubscriptionCredentialCommitment(f.env,REF,1).credentialStamp,
      purposes:['subscription_send'],templates:[{mark:'1451',templateId:TEMPLATE}],validFrom:now-60,validUntil:now+3600};await approve();
    await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark,MARK));
    await f.maintenanceDb.insert(systemNotification).values({mark:MARK,isRoutine:1,isSms:1,isSystem:1,smsId:'synthetic_success_sms',
      systemTitle:'退款成功 {order_id}',systemText:'{store_name} 退款 {refund_price}'});
    await f.maintenanceDb.delete(notificationTemplate).where(and(eq(notificationTemplate.mark,'1451'),eq(notificationTemplate.legacyType,0)));
    await f.maintenanceDb.insert(notificationTemplate).values({mark:'1451',legacyType:0,status:1,tempid:GLOBAL_B});
    expect(await withTx(app(),refundSuccessNoticeCommissionedTx)).toBe(false);
    const [prior]=await f.maintenanceDb.execute<{definition:string}>(sql`SELECT pg_get_constraintdef(oid,false) AS definition FROM pg_constraint
      WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
    const generation=REFUND_SUCCESS_NOTICE_PREDECESSORS.indexOf(prior.definition);
    expect(generation, 'Actual source must be a closed 0198 predecessor before the old-stage specimen').toBeGreaterThanOrEqual(0);
    try {
      oldSource=await completed(async()=>{
        // Exact published 0091 whitelist only, a catalog compatibility specimen.
        // All payment/application/provider SUCCESS rows are still real authors.
        await f.maintenanceDb.execute(sql`ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck`);
        await f.maintenanceDb.execute(sql`ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck
          CHECK(event_type IN('order.paid','order.delivery.notice','order.refund.refused.notice'))`);
      },false);
    } finally {
      await f.maintenanceDb.execute(sql`ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck`);
      // Reinstall the published IN-list DDL, not a deparsed expression: parsing
      // the explicit deparser casts can change its catalog representation.
      const events=[...PRODUCT_SAVE_EFFECTS_EVENTS,...(generation%2===1?['order.price.revision']:[]),
        ...(generation>=2?['recharge.paid.shipping','membership.paid.shipping']:[])];
      await f.maintenanceDb.execute(sql.raw('ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type IN ('
        +events.map(e=>"'"+e+"'").join(',')+'))'));
      const [restored]=await f.maintenanceDb.execute<{definition:string}>(sql`SELECT pg_get_constraintdef(oid,false) AS definition FROM pg_constraint
        WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
      expect(restored.definition).toBe(prior.definition);
    }
    await runRefundSuccessNoticeUpgrade(f.maintenanceDb);await runRefundSuccessNoticeUpgrade(f.maintenanceDb);
    expect(await withTx(app(),refundSuccessNoticeCommissionedTx)).toBe(true);
    legacyNew=await completed();
    expect(legacyNew.event.payload).toHaveProperty('routineAppId',CURRENT_B);
    expect(legacyNew.event.payload).not.toHaveProperty('routineSubscriptionRequest');
    expect(await retry(legacyNew)).toBe('completed');expect(await routine(legacyNew)).toHaveLength(0);
    const legacyEffects=await effects(legacyNew);expect(legacyEffects.sms).toHaveLength(1);expect(legacyEffects.inbox).toHaveLength(1);
    // Explicit negative SQL specimen: the real new author never creates this
    // generic Mini row. No protocol means even this injected queue row cannot POST.
    const [negative]=await f.maintenanceDb.insert(orderNotificationDelivery).values({outboxId:legacyNew.event.id,eventKey:legacyNew.event.eventKey,
      orderId:legacyNew.orderId,userId:11,noticeMark:MARK,channel:'wechat_routine',target:BARE_B,templateCode:GLOBAL_B,
      payload:{kind:'wechat_routine',routineAppId:CURRENT_B,data:{thing1:'已成功退款'},url:''},status:'ENQUEUED'}).returning();
    try {
      await expect(consumer().processMessage({action:'processOrderNotificationDelivery',deliveryId:negative.id,eventKey:negative.eventKey,channel:'wechat_routine'},network))
        .rejects.toThrow('退款成功小程序通知的原账号协议尚未就绪');
      expect((await routine(legacyNew))[0]).toEqual(negative);expect(network).not.toHaveBeenCalled();
    } finally {await f.maintenanceDb.delete(orderNotificationDelivery).where(eq(orderNotificationDelivery.id,negative.id));}
    await runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb,f.target,actorUpgrade.peers,f.appReaders);
    missingOwner=await completed();await signed(missingOwner);
    expect(await retry(missingOwner)).toBe('deferred');expect(await routine(missingOwner)).toHaveLength(0);
    await ownerA();
  },300000);
  afterEach(()=>network.mockReset().mockRejectedValue(Error('Unexpected provider transport')));
  afterAll(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);

  it('settles a real v1 full refund on the exact old 0091 whitelist without activating or backfilling the new notice',async()=>{
    expect(await refund(oldSource.refundId)).toMatchObject({refundType:6,refundedPrice:'5.00'});
    expect(await finalizeStoreOrderRefund(app(),oldSource.refundId,undefined,undefined,f.env)).toBe('already-completed');
    expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,'order.refund.success.notice:'+oldSource.refundId))).toHaveLength(0);
    expect(network).not.toHaveBeenCalled();
  },90000);
  it('keeps pre-protocol success SMS/inbox without current-B Mini fallback or later adoption',async()=>{
    const before=await effects(legacyNew),event=clone(await eventFor(legacyNew.refundId));
    expect(before.sms).toHaveLength(1);expect(before.inbox).toHaveLength(1);expect(await routine(legacyNew)).toHaveLength(0);
    expect(await retry(legacyNew)).toBe('already-completed');expect(await eventFor(legacyNew.refundId)).toEqual(event);
    expect(await effects(legacyNew)).toEqual(before);expect(await routine(legacyNew)).toHaveLength(0);expect(network).not.toHaveBeenCalled();
  },90000);
  it('recovers missing ownership through the actual verified identity writer without duplicating SMS/inbox',async()=>{
    const before=await effects(missingOwner);expect(before.sms).toHaveLength(1);expect(before.inbox).toHaveLength(1);
    const source=await staged(missingOwner);expect(source.delivery.target).toBe(TARGET);expect(await effects(source)).toEqual(before);
    expect(network).not.toHaveBeenCalled();
  },90000);
  it('rejects an unrecognized whitelist before changing the commissioned catalog',async()=>{
    const [before]=await f.maintenanceDb.execute<any>(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
    await expect(f.maintenanceDb.$client!.begin(async tx=>{
      await tx.unsafe('ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck');
      await tx.unsafe("ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type<>'')");
      await tx.unsafe(REFUND_SUCCESS_NOTICE_SQL);
    })).rejects.toThrow('predecessor drift');
    const [after]=await f.maintenanceDb.execute<any>(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
    expect(after).toEqual(before);expect(await withTx(app(),refundSuccessNoticeCommissionedTx)).toBe(true);
  },30000);
  it('completes real Admin query SUCCESS, emits request5, stages and sends to A1451 despite current and bare B',async()=>{
    const source=await completed();await signed(source);
    const r=await refund(source.refundId);expect(source.event.payload).toMatchObject({orderNo:r.orderId,payPrice:'5.00'});
    const stagedSource=await staged(source),saved=await effects(source);expect(saved.sms).toHaveLength(1);expect(saved.inbox).toHaveLength(1);
    const [order]=await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id,source.orderId));
    expect(saved.sms[0].payload).toMatchObject({params:{order_id:order.orderId,refund_price:'5.00'}});
    expect(stagedSource.delivery.payload).toMatchObject({url:'/pages/goods/order_after_details/index?order_id='+r.orderId+'&isReturen=1',
      data:{thing1:'已成功退款',amount3:'5.00',character_string6:r.orderId}});
    provider();const queue=await queued(stagedSource);expect(await consumer().processMessage(queue,network)).toBe('sent');expect(posts()).toHaveLength(1);
    const [attempt]=await attempts(stagedSource),[result]=await results(stagedSource);
    expect(attempt.payload).toMatchObject({facts:{appId:ASSIGNED_APP,templateMark:'1451'},request:{touser:TARGET,template_id:TEMPLATE}});
    expect(result).toMatchObject({attempt_id:attempt.attempt_id,payload:{result:{code:0}}});
    expect(await consumer().processMessage(queue,network)).toBe('already-sent');expect(posts()).toHaveLength(1);
    const event=clone(await eventFor(source.refundId));expect(await finalizeStoreOrderRefund(app(),source.refundId,undefined,undefined,f.env)).toBe('already-completed');
    expect(await eventFor(source.refundId)).toEqual(event);
  },120000);
  it('defers Mini with no independent 1451 approval but commits SMS and inbox exactly once',async()=>{
    const source=await completed();await approve({templates:[{mark:'1458',templateId:'unrelated_success_template'}]});
    try{expect(await retry(source)).toBe('deferred');expect(await routine(source)).toHaveLength(0);
      const saved=await effects(source);expect(saved.sms).toHaveLength(1);expect(saved.inbox).toHaveLength(1);
      await approve();await staged(source);expect(await effects(source)).toEqual(saved);
    }finally{await approve();}
    expect(network).not.toHaveBeenCalled();
  },120000);
  it('requires authenticated provider SUCCESS after signing and does not trust a changed mutable projection',async()=>{
    const source=await completed(),st=await staged(source);
    const [old]=await f.maintenanceDb.execute<any>(sql`SELECT * FROM public.store_order_refund_payment WHERE refund_id=${source.refundId}`);
    await f.maintenanceDb.execute(sql`UPDATE public.store_order_refund_payment SET provider_refund_id='corrupted_success_projection' WHERE refund_id=${source.refundId}`);
    try{provider();expect(await consumer().processMessage(await queued(st),network)).toBe('dead');
      expect(await attempts(st)).toHaveLength(0);expect(posts()).toHaveLength(0);
    }finally{await f.maintenanceDb.execute(sql`UPDATE public.store_order_refund_payment SET provider_refund_id=${old.provider_refund_id} WHERE refund_id=${source.refundId}`);}
  },120000);
  it('rechecks the physical whole-order quantity before creating an attempt',async()=>{
    const source=await staged(await completed());
    await f.maintenanceDb.update(storeOrder).set({totalNum:2}).where(eq(storeOrder.id,source.orderId));
    try{provider();expect(await consumer().processMessage(await queued(source),network)).toBe('dead');
      expect(await attempts(source)).toHaveLength(0);expect(posts()).toHaveLength(0);
    }finally{await f.maintenanceDb.update(storeOrder).set({totalNum:1}).where(eq(storeOrder.id,source.orderId));}
  },120000);
  it('keeps accepted refund proof after refund approval retirement and materials removal while using independent subscription approval',async()=>{
    const source=await completed(),materials=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
    const append=async(state:'active'|'revoked')=>{const r=await appendRoutineRefundAccountPolicy(f.maintenanceDb,f.env,named(),
      {operationId:randomUUID(),expectedRevision:refundRevision,data:{...refundPolicy,state}});refundRevision=r.revision;};
    await append('revoked');f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=undefined;
    try{const row=await staged(source);provider();expect(await consumer().processMessage(await queued(row),network)).toBe('sent');expect(posts()).toHaveLength(1);}
    finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=materials;await append('active');}
  },120000);
  it('does not repeat a POST with an UNKNOWN outcome',async()=>{
    const source=await staged(await completed());provider(true);const queue=await queued(source);
    expect(await consumer().processMessage(queue,network)).toBe('unknown');const saved=clone(await attempts(source));
    expect(saved).toHaveLength(1);expect(await results(source)).toHaveLength(0);expect(posts()).toHaveLength(1);
    expect(await consumer().processMessage(queue,network)).toBe('unknown');expect(await attempts(source)).toEqual(saved);expect(posts()).toHaveLength(1);
  },120000);
  it('classifies actual format5 history without granting send or changing rows',async()=>{
    await assertRoutineNotificationContinuation(f,5,()=>[network.mock.calls.length,transport.get.mock.calls.length,transport.set.mock.calls.length,
      transport.remove.mock.calls.length,transport.take.mock.calls.length,transport.setIfAbsent.mock.calls.length,f.messages.length],[CURRENT_B,TARGET,BARE_B,PHONE,SECRET,TEMPLATE],false);
  },90000);
});
