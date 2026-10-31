/** Independent Node RSA/AES -> production verifier/Hono -> real restricted
 * PG16 -> default recharge consumers. Only provider/Queue/KV transports are
 * local adapters; no real WeChat, Workers, browser or historical UID claim. */
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env, OrderMessage, PaymentCallbackMessage, PaymentReconciliationMessage } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { otherOrder, paymentCallbackEvent, paymentReconciliationCase, storeOrder, storeOrderOutbox, systemConfig, user, userRecharge, wechatUser } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { PaymentCallbackEventService, consumePaymentCallbackMessage, isPaymentCallbackMessage,
  type VerifiedPaymentCallback } from '@/services/payment/PaymentCallbackEventService';
import { PaymentReconciliationService, consumePaymentReconciliationMessage,
  isPaymentReconciliationMessage } from '@/services/payment/PaymentReconciliationService';
import type { PaymentProviderQuery, PaymentProviderQueryRequest } from '@/services/payment/PaymentProviderQuery';
import { prepareRoutineOriginalPaymentTx, appendRoutineOriginalPaymentTx, parseRoutineOriginalEvidence,
  assertRoutineOriginalReferenceTx } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { routineProviderObservationOf } from '@/services/payment/RoutineProviderObservation';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { decimalToCents } from '@/services/order/OrderBrokerageService';
import { OrderOutboxService, isOrderPaidOutboxMessage } from '@/services/order/OrderOutboxService';
import { consumeOrderPaidOutboxQueueMessage } from '@/services/order/OrderPaidOutboxQueueConsumer';
import { wechatPayNotify } from '@/controllers/api/v1/WechatController';
import { alipayNotify } from '@/controllers/api/v1/PayController';
import { paymentNotify } from '@/controllers/api/v1/PaymentCallbackController';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';

const APP_ID = 'wx-local-query', MERCHANT = '1234567890', PAYER = 'phase25_actual_provider_payer';
const BUYER_BINDING = 'phase25_buyer_current_binding', OTHER_PAYER = 'phase25_conflicting_provider_payer';
const APP_KEY = 'owned-phase25-original-authenticator', AES_KEY = 'a'.repeat(32);
const SUCCESS_TIME = '2026-09-19T12:00:00+08:00', EVENT_TIME = Date.parse(SUCCESS_TIME) / 1000;
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer: infer P) => unknown ? P : never;
type SignedCallback = { body: string; headers: Record<string, string> };
let keys: ReturnType<typeof paymentQueryKeys>;

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
  await f.db.insert(systemConfig).values(Object.entries({ routine_appId: APP_ID, routine_appsecret: '', pay_weixin_mchid: MERCHANT,
    pay_weixin_serial_no: 'ABCDEF123456', site_url: 'https://query.example', pay_weixin_open: 0 })
    .map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 9 })));
  await f.db.update(user).set({ nowMoney: '100.00' }).where(eq(user.uid, 11));
  await f.db.insert(wechatUser).values([{ uid: 11, userType: 'routine', openid: BUYER_BINDING },
    { uid: 22, userType: 'routine', openid: PAYER }]);
  await runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner });
  expect(await runRoutineOriginalPaymentEvidenceUpgrade(f.db, target)).toMatchObject({ applied: true });
  const container = createContainerFromDb(app.db), signer = await paymentQueryFixture(container, keys);
  const messages: OrderMessage[] = [], publicJson: string[] = [], pending: Promise<unknown>[] = [];
  const kv = vi.fn(async () => { throw Error('Cached config is not original payment authority'); });
  const env = { ...signer.env, APP_KEY, CONFIG_KV: { get: kv, put: async () => {}, delete: async () => {} },
    ORDER_QUEUE: { send: async (body: OrderMessage) => { messages.push(structuredClone(body)); },
      sendBatch: async (batch: Iterable<{ body: OrderMessage }>) => {
        for (const { body } of batch) {
          expect(Object.getOwnPropertySymbols(body)).toHaveLength(0);
          expect(isPaymentCallbackMessage(body) || isPaymentReconciliationMessage(body) || isOrderPaidOutboxMessage(body)).toBe(true);
          if (isPaymentCallbackMessage(body)) {
            expect(Object.keys(body).sort()).toEqual(['action', 'eventId', 'replayKey']);
            const [committed] = await f.db.execute(sql`SELECT e.trade_state,
              (SELECT count(*)::integer FROM public.routine_original_payment_evidence r WHERE r.source='callback' AND r.source_id=e.provider_event_id) AS originals
              FROM public.payment_callback_event e WHERE e.id=${body.eventId}`);
            expect(committed.originals).toBe(committed.trade_state === 'SUCCESS' ? 1 : 0);
          } else if (isPaymentReconciliationMessage(body)) expect(Object.keys(body).sort()).toEqual(['action', 'caseId', 'replayKey']);
          else expect(Object.keys(body).sort()).toEqual(['action', 'eventKey', 'outboxId']);
          messages.push(structuredClone(body));
        }
      } } } as unknown as Env;
  const pay = new WechatPayService(container, env), callbacks = new PaymentCallbackEventService(container, env);
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, props: {}, passThroughOnException: () => { throw Error('Unexpected origin fallback'); } };
  const post = async (signed: SignedCallback, db: DbClient = app.db) => {
    const h = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    h.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); });
    h.all('/api/pay/notify/:type', c => paymentNotify(c, { alipayNotify, wechatPayNotify }));
    const response = await h.request('/api/pay/notify/routine', { method: 'POST', body: signed.body, headers: signed.headers }, env, ctx);
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
  const queryCase = async (orderNo: string, query?: PaymentProviderQuery) => {
    const service = new PaymentReconciliationService(container, env, query);
    const registered = await service.registerIntent({ ...request(orderNo), initiatedAt: Math.floor(Date.now()/1000)-121 });
    await service.dispatchPage({ action: 'dispatchPaymentReconciliation', scheduledAt: Date.now(), cursor: 0 });
    const message = messages.filter(isPaymentReconciliationMessage).find(row => row.caseId === registered.id);
    if (!message) throw Error('Actual reconciliation dispatch did not publish the case');
    return { service, message, registered };
  };
  const signedQuery = (orderNo: string, transactionId: string, overrides: Record<string, unknown> = {}) => signer.wechatResponse(signer.wxBody({
    out_trade_no: orderNo, transaction_id: transactionId, payer: { openid: PAYER }, ...overrides }));
  return { f, app, admin, target, container, signer, env, pay, callbacks, messages, publicJson, kv, post, recharge, ledger, financial,
    wallet, caseRow, queryCase, signedQuery };
}
type Context = Awaited<ReturnType<typeof context>>;
async function consumeCallback(c: Context, message: PaymentCallbackMessage) {
  const ack = vi.fn(), retry = vi.fn();
  await consumePaymentCallbackMessage({ body: message, attempts: 1, ack, retry }, c.callbacks);
  return { ack, retry };
}
/** Advance only the Queue redelivery clock past the existing finite retry
 * availability; do not rewrite paid rows, immutable proof or outbox state. */
async function retryCallbackAfterDelay(c: Context, message: PaymentCallbackMessage) {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000), ack = vi.fn(), retry = vi.fn();
  try {
    await consumePaymentCallbackMessage({ body: message, attempts: 2, ack, retry }, c.callbacks);
    return { ack, retry };
  } finally { clock.mockRestore(); }
}
async function consumeQuery(service: PaymentReconciliationService, message: PaymentReconciliationMessage) {
  const ack = vi.fn(), retry = vi.fn();
  await consumePaymentReconciliationMessage({ body: message, attempts: 1, ack, retry }, service);
  return { ack, retry };
}
const noPayer = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [PAYER, BUYER_BINDING, OTHER_PAYER, APP_KEY]) expect(text).not.toContain(secret);
};

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine original provider evidence and real PG16 consumers', () => {
  beforeAll(() => { keys = paymentQueryKeys(); });
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unstubbed external I/O forbidden'));
    vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    try { noPayer([vi.mocked(console.log).mock.calls, vi.mocked(console.warn).mock.calls, vi.mocked(console.error).mock.calls]); }
    finally { vi.restoreAllMocks(); }
  });

  it('accepts real RSA/AES callback, credits only the local buyer once, and preserves immutable evidence on replay', async () => fixture(async c => {
    const order = await c.recharge('czphase25_callback'), signed = callback(order.orderId, 'phase25_callback_tx');
    const bindings = await c.f.db.select().from(wechatUser), payerBefore = (await c.f.db.select().from(user).where(eq(user.uid, 22)))[0];
    expect(await c.post(signed)).toEqual({ status: 200, body: { code: 'SUCCESS', message: '成功' } });
    expect(await c.wallet()).toBe('100.00');
    const stored = await c.ledger(); expect(stored).toHaveLength(1);
    expect(stored[0].row).toMatchObject({ source: 'callback', order_no: order.orderId, transaction_id: 'phase25_callback_tx',
      payload: { binding: { state: 'bound', local: { domain: 'recharge', orderId: order.id, buyerUid: 11, paid: 0 } },
        observation: { facts: { appId: APP_ID, merchantId: MERCHANT, payerId: PAYER, tradeType: 'JSAPI', amountCents: 1000, providerEventTime: EVENT_TIME } } } });
    const message = c.messages.filter(isPaymentCallbackMessage)[0]; expect(message).toBeDefined();
    const consumed = await consumeCallback(c, message); expect(consumed.ack).toHaveBeenCalledOnce(); expect(consumed.retry).not.toHaveBeenCalled();
    expect(await c.wallet()).toBe('111.50');
    expect(await c.f.db.select().from(wechatUser)).toEqual(bindings);
    expect((await c.f.db.select().from(user).where(eq(user.uid, 22)))[0]).toEqual(payerBefore);
    expect((await c.f.db.select().from(userRecharge).where(eq(userRecharge.id, order.id)))[0])
      .toMatchObject({ uid: 11, paid: 1, rechargeType: 'weixin', tradeNo: 'phase25_callback_tx' });
    const paid = await c.financial();
    expect(await c.callbacks.processMessage(message)).toBe('already-completed');
    expect((await c.post(signed)).status).toBe(200);
    expect(await c.ledger()).toEqual(stored); expect(await c.financial()).toEqual(paid);
    expect(await c.caseRow(order.orderId)).toMatchObject({ status: 'CONFIRMED', orderDomain: 'recharge' });
    noPayer(c.publicJson); noPayer(c.messages); expect(fetch).not.toHaveBeenCalled();
  }), 180000);

  it('uses a real signed query outside SQL, settles by default, and keeps its proof out of JSON and Queue', async () => fixture(async c => {
    const order = await c.recharge('czphase25_query'), transaction = 'phase25_query_tx';
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (typeof url !== 'string' || !init) throw Error('Unexpected query transport');
      expect(c.signer.verifyRequest(url, init)).toBe(true);
      const [idle] = await c.f.db.execute(sql`SELECT state,xact_start IS NULL AS ended FROM pg_catalog.pg_stat_activity WHERE pid=${c.app.pid}`);
      expect(idle).toEqual({ state: 'idle', ended: true });
      if (!c.f.withPeer) throw Error('Independent provider I/O lock probe required');
      await c.f.withPeer(peer => peer.db.transaction(tx => tx.execute(sql`SELECT id FROM public.user_recharge WHERE id=${order.id} FOR UPDATE NOWAIT`)));
      return c.signedQuery(order.orderId, transaction);
    });
    const result = await c.pay.queryOrder(request(order.orderId));
    expect(result.status).toBe('SUCCESS'); expect(routineProviderObservationOf(result)).toBeDefined();
    expect(routineProviderObservationOf({ ...result })).toBeUndefined(); noPayer(result);
    const query = await c.queryCase(order.orderId), done = await consumeQuery(query.service, query.message);
    expect(done.ack).toHaveBeenCalledOnce(); expect(done.retry).not.toHaveBeenCalled();
    expect(await c.wallet()).toBe('111.50'); expect(await c.caseRow(order.orderId)).toMatchObject({ status: 'SETTLED', orderDomain: 'recharge' });
    const stored = await c.ledger(); expect(stored).toHaveLength(1); expect(stored[0].row.source).toBe('signed_query');
    const paid = await c.financial();
    await c.app.db.transaction(async tx => {
      const prepared = await prepareRoutineOriginalPaymentTx(tx as unknown as DbClient, c.env, routineProviderObservationOf(result),
        { source: 'signed_query', ...result });
      if (!prepared) throw Error('Commissioned original proof required');
      expect(await appendRoutineOriginalPaymentTx(tx as unknown as DbClient, c.env, prepared)).toMatchObject({ replayed: true, conflict: false });
    });
    expect(await query.service.processMessage(query.message)).toBe('already-terminal');
    expect(await c.ledger()).toEqual(stored); expect(await c.financial()).toEqual(paid); noPayer(c.messages);
    expect(fetch).toHaveBeenCalledTimes(2);
  }), 180000);

  it('binds a genuine signed-query capability to its own case without recording or reserving another order transaction', async () => fixture(async c => {
    const orderA = await c.recharge('czphase25_scope_a'), rewrittenA = await c.recharge('czphase25_scope_rewrite');
    const orderB = await c.recharge('czphase25_scope_b'), transactionB = 'phase25_scope_b_tx', before = await c.financial();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (typeof url !== 'string' || !init) throw Error('Unexpected query transport');
      expect(c.signer.verifyRequest(url, init)).toBe(true);
      expect(new URL(url).pathname).toBe('/v3/pay/transactions/out-trade-no/' + orderB.orderId);
      return c.signedQuery(orderB.orderId, transactionB);
    });
    // This is the production adapter's actual RSA-verified result, retaining
    // its non-enumerable capability. No scalar identity label or forged proof
    // is used to manufacture the cross-case input.
    const genuineB = await c.pay.queryOrder(request(orderB.orderId));
    expect(genuineB).toMatchObject({ status: 'SUCCESS', orderNo: orderB.orderId, transactionId: transactionB });
    const proofB = routineProviderObservationOf(genuineB); expect(proofB).toBeDefined();
    expect(proofB).toMatchObject({ facts: { orderNo: orderB.orderId, transactionId: transactionB } });
    const seen: string[] = [];
    const wrongCase = await c.queryCase(orderA.orderId, async claimed => { seen.push(claimed.orderNo); return genuineB; });
    const rejected = await consumeQuery(wrongCase.service, wrongCase.message);
    expect(rejected.ack).toHaveBeenCalledOnce(); expect(rejected.retry).not.toHaveBeenCalled();
    expect(await c.caseRow(orderA.orderId)).toMatchObject({ status: 'UNKNOWN', providerStatus: 'UNKNOWN',
      providerTransactionId: '', providerEventTime: 0, lastErrorCode: 'error' });
    expect(await c.ledger()).toEqual([]); expect(await c.financial()).toEqual(before);
    expect(await c.f.db.select().from(paymentCallbackEvent)).toHaveLength(0);
    expect(routineProviderObservationOf(genuineB)).toBe(proofB);

    // Rewriting the enumerable order number must not retarget the retained
    // genuine capability. Failed capture must not reserve its scalar tx/time
    // on either unrelated case, even when the visible order matches the claim.
    genuineB.orderNo = rewrittenA.orderId;
    try {
      const rewritten = await c.queryCase(rewrittenA.orderId, async claimed => { seen.push(claimed.orderNo); return genuineB; });
      const denied = await consumeQuery(rewritten.service, rewritten.message);
      expect(denied.ack).toHaveBeenCalledOnce(); expect(denied.retry).not.toHaveBeenCalled();
      expect(await c.caseRow(rewrittenA.orderId)).toMatchObject({ status: 'UNKNOWN', providerStatus: 'UNKNOWN',
        providerTransactionId: '', providerEventTime: 0, lastErrorCode: 'error' });
      expect(await c.ledger()).toEqual([]); expect(await c.financial()).toEqual(before);
      expect(routineProviderObservationOf(genuineB)).toBe(proofB);
    } finally { genuineB.orderNo = orderB.orderId; }
    expect(seen).toEqual([orderA.orderId, rewrittenA.orderId]);

    // Rejection must also leave B's transaction available to its actual case:
    // persisting B's transaction ID on A would poison the existing foreign-
    // transaction fence even if no original-evidence row were appended.
    const rightCase = await c.queryCase(orderB.orderId, async claimed => {
      expect(claimed.orderNo).toBe(orderB.orderId); return genuineB;
    });
    const accepted = await consumeQuery(rightCase.service, rightCase.message);
    expect(accepted.ack).toHaveBeenCalledOnce(); expect(accepted.retry).not.toHaveBeenCalled();
    expect(await c.caseRow(orderB.orderId)).toMatchObject({ status: 'SETTLED', providerTransactionId: transactionB });
    for (const rejectedOrder of [orderA, rewrittenA]) {
      expect(await c.caseRow(rejectedOrder.orderId)).toMatchObject({ status: 'UNKNOWN', providerTransactionId: '', providerEventTime: 0 });
      expect((await c.f.db.select().from(userRecharge).where(eq(userRecharge.id, rejectedOrder.id)))[0]).toMatchObject({ paid: 0, tradeNo: '' });
    }
    expect(await c.wallet()).toBe('111.50');
    expect((await c.f.db.select().from(userRecharge).where(eq(userRecharge.id, orderB.id)))[0]).toMatchObject({ paid: 1, tradeNo: transactionB });
    const stored = await c.ledger(); expect(stored).toHaveLength(1);
    expect(stored[0].row).toMatchObject({ source: 'signed_query', order_no: orderB.orderId, transaction_id: transactionB,
      payload: { binding: { state: 'bound', local: { domain: 'recharge', orderId: orderB.id, buyerUid: 11 } } } });
    expect(fetch).toHaveBeenCalledOnce(); noPayer(genuineB); noPayer(c.messages); noPayer(c.publicJson);
  }), 180000);

  it('rejects plain scalar/identityEvidence SUCCESS, JSON-cloned captures and the wrong real SQL principal', async () => fixture(async c => {
    const order = await c.recharge('czphase25_injected'), transaction = 'phase25_injected_tx';
    const signed = callback(order.orderId, transaction), decoded = await c.pay.verifyAndParseNotify(signed.headers, signed.body, 'routine');
    const plain = minimized(decoded), before = await c.financial();
    await expect(c.callbacks.receive(plain, { appId: APP_ID, merchantId: MERCHANT, payerId: PAYER })).rejects.toThrow('routine_provider_observation_invalid');
    expect(await c.ledger()).toEqual([]); expect(await c.f.db.select().from(paymentCallbackEvent)).toHaveLength(0);
    expect((await c.post(signed, c.admin.db)).status).toBe(400);
    await expect(c.admin.db.transaction(tx => prepareRoutineOriginalPaymentTx(tx as unknown as DbClient, c.env,
      routineProviderObservationOf(decoded), { source: 'callback', ...plain }))).rejects.toMatchObject({ code: 503 });
    vi.mocked(fetch).mockResolvedValue(c.signedQuery(order.orderId, transaction));
    const genuine = await c.pay.queryOrder(request(order.orderId));
    const copied = JSON.parse(JSON.stringify(genuine));
    copied.identityEvidence = { source: 'wechat-signed-query', appId: APP_ID, merchantId: MERCHANT, payerId: PAYER };
    const query = await c.queryCase(order.orderId, async () => copied), done = await consumeQuery(query.service, query.message);
    expect(done.ack).toHaveBeenCalledOnce(); expect(done.retry).not.toHaveBeenCalled();
    expect(await c.caseRow(order.orderId)).toMatchObject({ status: 'UNKNOWN', lastErrorCode: 'error', providerTransactionId: '', providerEventTime: 0 });
    expect(await c.ledger()).toEqual([]); expect(await c.financial()).toEqual(before); noPayer(c.publicJson); noPayer(c.messages);
  }), 180000);

  it('retains genuine callbacks with missing, ambiguous, invalid or amount-conflicting local facts without dispatch or payment', async () => fixture(async c => {
    const missing = 'czphase25_missing', ambiguous = await c.recharge('czphase25_ambiguous');
    await c.f.db.insert(otherOrder).values({ uid: 11, orderId: ambiguous.orderId, type: 0, payPrice: '10.00' });
    const amount = await c.recharge('czphase25_amount', { price: '9.99' });
    const invalid = await c.recharge('czphase25_invalid', { uid: 0 });
    const before = await c.financial();
    for (const [number, reason] of [[missing, 'order_missing'], [ambiguous.orderId, 'order_ambiguous'],
      [invalid.orderId, 'local_order_invalid'], [amount.orderId, null]] as const) {
      expect((await c.post(callback(number, 'tx_' + number))).status).toBe(200);
      const row = (await c.ledger()).find(row => row.row.order_no === number)!.row;
      expect(row.payload.observation.facts).toMatchObject({ payerId: PAYER, amountCents: 1000, tradeState: 'SUCCESS' });
      if (reason) expect(row.payload.binding).toEqual({ state: 'unresolved', reason });
      else expect(row.payload.binding).toMatchObject({ state: 'bound', local: { amountCents: 999 } });
      expect(await c.caseRow(number)).toMatchObject({ status: 'CONFLICT', lastErrorCode: 'routine_original_evidence_conflict' });
    }
    expect(c.messages).toEqual([]); expect(await c.financial()).toEqual(before);
    expect(await c.f.db.select().from(paymentCallbackEvent)).toHaveLength(4);
    noPayer(c.publicJson); expect(fetch).not.toHaveBeenCalled();
  }), 180000);

  it('preserves two genuine payer observations, blocks a previously queued callback, and never rewrites a current binding', async () => fixture(async c => {
    const order = await c.recharge('czphase25_payerconflict'), transaction = 'phase25_payer_conflict_tx';
    const before = await c.financial();
    expect((await c.post(callback(order.orderId, transaction))).status).toBe(200);
    const message = c.messages.filter(isPaymentCallbackMessage)[0];
    expect((await c.post(callback(order.orderId, transaction, { payer: { openid: OTHER_PAYER } }))).status).toBe(200);
    const rows = await c.ledger(); expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.row.payload.observation.facts.payerId))).toEqual(new Set([PAYER, OTHER_PAYER]));
    expect(c.messages.filter(isPaymentCallbackMessage)).toHaveLength(1);
    const done = await consumeCallback(c, message); expect(done.ack).not.toHaveBeenCalled(); expect(done.retry).toHaveBeenCalledOnce();
    expect(await c.caseRow(order.orderId)).toMatchObject({ status: 'CONFLICT' });
    expect(await c.ledger()).toEqual(rows); expect(await c.financial()).toEqual(before); noPayer(c.publicJson); noPayer(c.messages);
  }), 180000);

  it('does not collect paid originals for genuine pending results or accept incomplete/tampered provider messages', async () => fixture(async c => {
    const order = await c.recharge('czphase25_pending'), before = await c.financial();
    const pending = callback(order.orderId, 'phase25_pending_tx', { trade_state: 'NOTPAY', payer: {}, trade_type: undefined, success_time: undefined });
    expect((await c.post(pending)).status).toBe(200);
    const done = await consumeCallback(c, c.messages.filter(isPaymentCallbackMessage)[0]); expect(done.ack).toHaveBeenCalledOnce();
    expect(await c.ledger()).toEqual([]); expect(await c.financial()).toEqual(before);
    const pendingQuery = await c.recharge('czphase25_pendingquery');
    vi.mocked(fetch).mockResolvedValue(c.signedQuery(pendingQuery.orderId, 'unused_pending_tx', { trade_state: 'NOTPAY', payer: {}, trade_type: undefined }));
    const query = await c.queryCase(pendingQuery.orderId); await consumeQuery(query.service, query.message);
    expect(await c.caseRow(pendingQuery.orderId)).toMatchObject({ status: 'WAITING', providerStatus: 'PENDING' });
    expect(await c.ledger()).toEqual([]);
    for (const overrides of [{ payer: {} }, { trade_type: 'MWEB' }]) expect((await c.post(callback(order.orderId, 'invalid_facts_tx', overrides))).status).toBe(400);
    const tampered = callback(order.orderId, 'invalid_signature_tx'); tampered.body += ' ';
    expect((await c.post(tampered)).status).toBe(400);
    expect(await c.ledger()).toEqual([]); expect(await c.wallet()).toBe('100.00'); noPayer(c.publicJson); noPayer(c.messages);
  }), 180000);

  it('rolls original/event/outbox/case writes back together before acknowledgement, then accepts the same real signed package', async () => fixture(async c => {
    const order = await c.recharge('czphase25_rollback'), signed = callback(order.orderId, 'phase25_rollback_tx');
    const before = await c.financial(), role = pricingIdentifier(c.app.role);
    await c.f.exec(`REVOKE INSERT ON public.payment_callback_outbox FROM ${role}`);
    try {
      expect((await c.post(signed)).status).toBe(400);
      expect(await c.ledger()).toEqual([]); expect(c.messages).toEqual([]);
      for (const table of ['payment_callback_event', 'payment_callback_outbox', 'payment_reconciliation_case'])
        expect(await c.f.db.execute(sql.raw(`SELECT * FROM public.${table}`))).toHaveLength(0);
      expect(await c.financial()).toEqual(before);
    } finally { await c.f.exec(`GRANT INSERT ON public.payment_callback_outbox TO ${role}`); }
    const decoded = await c.pay.verifyAndParseNotify(signed.headers, signed.body, 'routine'), abort = Error('Owned caller rollback');
    await expect(c.app.db.transaction(async tx => {
      const prepared = await prepareRoutineOriginalPaymentTx(tx as unknown as DbClient, c.env, routineProviderObservationOf(decoded),
        { source: 'callback', ...minimized(decoded) });
      if (!prepared) throw Error('Original addon unexpectedly absent');
      await appendRoutineOriginalPaymentTx(tx as unknown as DbClient, c.env, prepared);
      throw abort;
    })).rejects.toBe(abort);
    expect(await c.ledger()).toEqual([]); expect(await c.financial()).toEqual(before);
    expect((await c.post(signed)).status).toBe(200);
    await consumeCallback(c, c.messages.filter(isPaymentCallbackMessage)[0]); expect(await c.wallet()).toBe('111.50');
    expect(await c.ledger()).toHaveLength(1); noPayer(c.publicJson); noPayer(c.messages);
  }), 180000);

  it('retains genuine query amount conflicts and missing local facts without treating signed SUCCESS as payment authority', async () => fixture(async c => {
    const amount = await c.recharge('czphase25_queryamount'), missing = 'czphase25_querymissing';
    const before = await c.financial();
    vi.mocked(fetch).mockImplementation(async url => {
      const number = new URL(String(url)).pathname.split('/').at(-1)!;
      return c.signedQuery(number, 'tx_' + number, number === amount.orderId ? { amount: { total: 999, currency: 'CNY' } } : {});
    });
    for (const number of [amount.orderId, missing]) {
      const query = await c.queryCase(number); await consumeQuery(query.service, query.message);
      expect(await c.caseRow(number)).toMatchObject({ status: 'CONFLICT', lastErrorCode: 'routine_original_evidence_conflict' });
    }
    const rows = await c.ledger(); expect(rows).toHaveLength(2);
    expect(rows.find(row => row.row.order_no === amount.orderId)?.row.payload.observation.facts.amountCents).toBe(999);
    expect(rows.find(row => row.row.order_no === missing)?.row.payload.binding).toEqual({ state: 'unresolved', reason: 'order_missing' });
    expect(await c.financial()).toEqual(before); noPayer(c.messages);
  }), 180000);

  it('rejects changed local price at the locked authorization boundary and recovers only through explicit retry plus genuine query', async () => fixture(async c => {
    const order = await c.recharge('czphase25_pricechange'), transaction = 'phase25_price_change_tx';
    const signed = callback(order.orderId, transaction), decoded = await c.pay.verifyAndParseNotify(signed.headers, signed.body, 'routine');
    expect((await c.post(signed)).status).toBe(200);
    const original = await c.ledger(), message = c.messages.filter(isPaymentCallbackMessage)[0];
    await c.f.db.update(userRecharge).set({ price: '9.99' }).where(eq(userRecharge.id, order.id));
    await expect(c.app.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM public.user_recharge WHERE id=${order.id} FOR UPDATE`);
      await assertRoutineOriginalReferenceTx(tx as unknown as DbClient, c.env, decoded.eventId,
        { source: 'callback', ...minimized(decoded) }, 'recharge');
    })).rejects.toThrow('routine_original_local_payment_changed');
    const stopped = await consumeCallback(c, message);
    expect(stopped.ack).toHaveBeenCalledOnce(); expect(stopped.retry).not.toHaveBeenCalled();
    expect(await c.wallet()).toBe('100.00'); expect(await c.caseRow(order.orderId)).toMatchObject({ status: 'CONFLICT' });
    expect(await c.ledger()).toEqual(original);
    await c.f.db.update(userRecharge).set({ price: '10.00' }).where(eq(userRecharge.id, order.id));
    const current = await c.caseRow(order.orderId);
    await new PaymentReconciliationService(createContainerFromDb(c.admin.db), c.env).decide({ caseId: current.id, adminId: 1,
      actionKey: randomUUID(), action: 'retry', reasonCode: 'original_price_restored' });
    vi.mocked(fetch).mockResolvedValue(c.signedQuery(order.orderId, transaction));
    const recovery = new PaymentReconciliationService(c.container, c.env);
    await recovery.dispatchPage({ action: 'dispatchPaymentReconciliation', scheduledAt: Date.now(), cursor: 0 });
    const queued = c.messages.filter(isPaymentReconciliationMessage).find(row => row.caseId === current.id);
    if (!queued) throw Error('Explicit recovery was not dispatched');
    const resumed = await consumeQuery(recovery, queued); expect(resumed.ack).toHaveBeenCalledOnce(); expect(resumed.retry).not.toHaveBeenCalled();
    expect(await c.wallet()).toBe('111.50'); expect(await c.caseRow(order.orderId)).toMatchObject({ status: 'SETTLED' });
    expect((await c.ledger()).find(row => row.row.source === 'callback')).toEqual(original[0]);
    expect(await c.callbacks.processMessage(message)).toBe('already-completed'); noPayer(c.publicJson); noPayer(c.messages);
  }), 180000);

  it('locks the real checkout root before the original guard, retries transient read loss, and runs the genuine paid outbox once', async () => fixture(async c => {
    // Actual checkout freezes stock, pricing, cart and integral evidence. No
    // paid flag, paid root, supplier receipt or post-payment result is seeded.
    const created = await c.f.operationsFor(c.app).checkout({ key: 'phase25_store_original', orderId: 'phase25_store_original' });
    const [order] = await c.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(order).toMatchObject({ uid: 11, paid: 0 });
    const amountCents = decimalToCents(order.payPrice);
    expect((await c.post(callback(order.orderId, 'phase25_store_tx', { amount: { total: amountCents, currency: 'CNY' } }))).status).toBe(200);
    const original = await c.ledger(), before = await c.f.state(), message = c.messages.filter(isPaymentCallbackMessage)[0];
    expect(original[0].row.payload.binding).toMatchObject({ state: 'bound', local: { domain: 'store_order', orderId: order.id, buyerUid: 11, amountCents } });
    const role = pricingIdentifier(c.app.role);
    await c.f.exec(`REVOKE SELECT ON public.routine_original_payment_evidence FROM ${role}`);
    try {
      const stopped = await consumeCallback(c, message);
      expect(stopped.ack).not.toHaveBeenCalled(); expect(stopped.retry).toHaveBeenCalledOnce();
      expect(await c.f.state()).toEqual(before); expect(await c.ledger()).toEqual(original);
      expect((await c.f.db.select().from(paymentCallbackEvent))[0]).toMatchObject({ status: 'FAILED' });
      expect(c.messages.filter(isOrderPaidOutboxMessage)).toHaveLength(0);
    } finally { await c.f.exec(`GRANT SELECT ON public.routine_original_payment_evidence TO ${role}`); }
    const resumed = await retryCallbackAfterDelay(c, message);
    expect(resumed.ack).toHaveBeenCalledOnce(); expect(resumed.retry).not.toHaveBeenCalled();
    expect((await c.f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0])
      .toMatchObject({ uid: 11, paid: 1, payType: 'weixin', tradeNo: 'phase25_store_tx' });
    const paidMessage = c.messages.filter(isOrderPaidOutboxMessage)[0]; expect(paidMessage).toBeDefined();
    expect(Object.keys(paidMessage).sort()).toEqual(['action', 'eventKey', 'outboxId']);
    const paid = new OrderOutboxService(c.container, c.env), ack = vi.fn(), retry = vi.fn();
    const [accountBefore] = await c.f.db.select({ payCount: user.payCount }).from(user).where(eq(user.uid, 11));
    await consumeOrderPaidOutboxQueueMessage({ body: paidMessage, attempts: 1, ack, retry }, paid);
    expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    expect((await c.f.db.select({ payCount: user.payCount }).from(user).where(eq(user.uid, 11)))[0].payCount).toBe(accountBefore.payCount + 1);
    expect((await c.f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, paidMessage.outboxId)))[0]).toMatchObject({ status: 'COMPLETED' });
    const [supplier] = await c.f.db.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM public.supplier_transactions`);
    expect(supplier.count).toBeGreaterThan(0);
    const done = await c.f.state();
    expect(await paid.processMessage(paidMessage)).toBe('already-completed');
    expect(await c.callbacks.processMessage(message)).toBe('already-completed');
    expect(await c.f.state()).toEqual(done); expect(await c.ledger()).toEqual(original);
    noPayer(c.publicJson); noPayer(c.messages); expect(fetch).not.toHaveBeenCalled();
  }), 180000);

  it('retries the membership original guard before granting thirty days, then preserves rights and original proof on replay', async () => fixture(async c => {
    const [order] = await c.f.db.insert(otherOrder).values({ uid: 11, orderId: 'phase25_member_original', type: 1,
      isFree: 0, vipDay: 30, isPermanent: 0, payPrice: '10.00', memberPrice: '10.00', channelType: 'routine' }).returning();
    expect((await c.post(callback(order.orderId, 'phase25_member_tx'))).status).toBe(200);
    const original = await c.ledger(), before = await c.f.state();
    const membership = async () => Array.from(await c.f.db.execute(sql`SELECT jsonb_build_object(
      'orders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.other_order t),
      'status',(SELECT jsonb_agg(to_jsonb(t) ORDER BY oid,change_time) FROM public.other_order_status t)) AS value`));
    const rightsBefore = await membership(), message = c.messages.filter(isPaymentCallbackMessage)[0], role = pricingIdentifier(c.app.role);
    expect(original[0].row.payload.binding).toMatchObject({ state: 'bound', local: { domain: 'membership', orderId: order.id, buyerUid: 11, amountCents: 1000 } });
    await c.f.exec(`REVOKE SELECT ON public.routine_original_payment_evidence FROM ${role}`);
    try {
      const stopped = await consumeCallback(c, message);
      expect(stopped.ack).not.toHaveBeenCalled(); expect(stopped.retry).toHaveBeenCalledOnce();
      expect(await c.f.state()).toEqual(before); expect(await membership()).toEqual(rightsBefore); expect(await c.ledger()).toEqual(original);
    } finally { await c.f.exec(`GRANT SELECT ON public.routine_original_payment_evidence TO ${role}`); }
    const resumed = await retryCallbackAfterDelay(c, message);
    expect(resumed.ack).toHaveBeenCalledOnce(); expect(resumed.retry).not.toHaveBeenCalled();
    const [paid] = await c.f.db.select().from(otherOrder).where(eq(otherOrder.id, order.id));
    expect(paid).toMatchObject({ uid: 11, type: 1, paid: 1, payType: 'weixin', tradeNo: 'phase25_member_tx' });
    expect(paid.overdueTime).toBe(paid.payTime + 30 * 86400);
    expect((await c.f.db.select().from(user).where(eq(user.uid, 11)))[0])
      .toMatchObject({ isMoneyLevel: 1, isEverLevel: 0, overdueTime: paid.overdueTime, nowMoney: '100.00' });
    const state = await c.f.state(), rights = await membership();
    expect(await c.callbacks.processMessage(message)).toBe('already-completed');
    expect(await c.f.state()).toEqual(state); expect(await membership()).toEqual(rights); expect(await c.ledger()).toEqual(original);
    noPayer(c.publicJson); noPayer(c.messages); expect(fetch).not.toHaveBeenCalled();
  }), 180000);

  it('rejects real temporary order shadowing even with public current_schema, then accepts the same signed ingress after cleanup', async () => fixture(async c => {
    const order = await c.recharge('czphase25_temp_shadow'), signed = callback(order.orderId, 'phase25_shadow_tx');
    const before = await c.financial(), [settings] = await c.app.db.execute<{ path: string }>(sql`SELECT current_setting('search_path') AS path`);
    let created = false;
    try {
      // Omitting explicit pg_temp makes its relation lookup implicit and first,
      // while current_schema() still names public. The OID check must close it.
      await c.app.exec('SET search_path=public');
      await c.app.exec('CREATE TEMP TABLE user_recharge(id integer)'); created = true;
      const [resolution] = await c.app.db.execute(sql`SELECT current_schema()='public' AS public_schema,
        to_regclass('user_recharge')=to_regclass('public.user_recharge') AS same_relation`);
      expect(resolution).toEqual({ public_schema: true, same_relation: false });
      expect((await c.post(signed)).status).toBe(400);
      expect(await c.ledger()).toEqual([]); expect(await c.f.db.select().from(paymentCallbackEvent)).toHaveLength(0);
      expect(await c.financial()).toEqual(before); expect(c.messages).toEqual([]);
    } finally {
      if (created) await c.app.exec('DROP TABLE pg_temp.user_recharge');
      await c.app.db.execute(sql`SELECT set_config('search_path',${settings.path},false)`);
    }
    expect((await c.post(signed)).status).toBe(200);
    const done = await consumeCallback(c, c.messages.filter(isPaymentCallbackMessage)[0]);
    expect(done.ack).toHaveBeenCalledOnce(); expect(done.retry).not.toHaveBeenCalled();
    expect(await c.wallet()).toBe('111.50'); expect(await c.ledger()).toHaveLength(1);
    noPayer(c.publicJson); noPayer(c.messages);
  }), 180000);
});
