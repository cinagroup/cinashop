import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { createCipheriv, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env, OrderMessage, PaymentCallbackMessage } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { memberRight, otherOrder, paymentCallbackEvent, paymentReconciliationCase, systemConfig, user, wechatUser } from '../src/models/schema';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL } from '../src/migrations/offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL } from '../src/migrations/offlineOrderBalance';
import { OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL } from '../src/migrations/offlineOrderExternalPayment';
import { OFFLINE_ORDER_CALLBACK_DOMAIN_SQL } from '../src/migrations/offlineOrderCallbackDomain';
import { OFFLINE_ORDER_PAYMENT_DISPATCH_SQL } from '../src/migrations/offlineOrderPaymentDispatch';
import { offlineRuntimeGrantPlan } from '../src/migrations/offlineOrderRuntimeContract';
import { auditOfflineOrderRuntimePermissions } from '../src/migrations/auditOfflineOrderRuntimePermissions';
import { admitOfflineOrder } from '../src/services/order/OfflineOrderAdmissionService';
import { selectOfflineOrderExternalPayment } from '../src/services/order/OfflineOrderPaymentSelectionService';
import { settleOfflineOrderExternalPayment } from '../src/services/order/OfflineOrderExternalPaymentService';
import { PaymentCallbackEventService, isPaymentCallbackMessage, type PaymentCallbackSettler } from '../src/services/payment/PaymentCallbackEventService';
import { PaymentReconciliationService } from '../src/services/payment/PaymentReconciliationService';
import { alipayNotify } from '../src/controllers/api/v1/PayController';
import { wechatPayNotify } from '../src/controllers/api/v1/WechatController';
import { paymentNotify } from '../src/controllers/api/v1/PaymentCallbackController';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

// Actual Hono controllers, independent Node RSA/AES signer -> production Web
// Crypto verification -> native PG16 -> default queue settler. KV and Queue
// transport only are local doubles. No real provider, Workers or Hyperdrive claim.
describe('signed offline callback and recovery pipeline on isolated native PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  let keys: { privateKey: string; publicKey: string }, aesKey: string;
  type Runtime = SequenceRunnerPeer & { role: string };
  type Rail = 'wechat' | 'alipay';
  const appId = 'wx-local-pipeline', aliApp = 'local-ali-app', merchantId = '1234567890', payer = 'original-local-payer';
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    ddl = await offlinePredecessorSchemaSql();
    keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
    aesKey = Buffer.from(randomBytes(16)).toString('hex');
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await sequenceRunnerDatabase();
    await f.db.transaction(async tx => {
      for (const source of [ddl, OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_BALANCE_SQL,
        OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL, OFFLINE_ORDER_CALLBACK_DOMAIN_SQL, OFFLINE_ORDER_PAYMENT_DISPATCH_SQL]) await tx.execute(sql.raw(source));
    });
    await f.db.insert(user).values({ uid: 11, account: 'signed-offline-buyer', nowMoney: '100.00', integral: 50, isEverLevel: 1 });
    await f.db.insert(systemConfig).values([{ id: 1, menuName: 'member_card_status', value: '1' },
      { id: 2, menuName: 'order_give_integral', value: '1.234567' }]);
    await f.db.insert(memberRight).values([{ id: 1, rightType: 'offline', number: 80, status: 1 },
      { id: 2, rightType: 'integral', number: 2, status: 1 }]);
  }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const runtime = <T>(work: (r: Runtime) => Promise<T>) => f.withRuntimeRole!(async r => {
    await f.exec(offlineRuntimeGrantPlan(r.role));
    expect(await auditOfflineOrderRuntimePermissions(r.db)).toMatchObject({ready:true,failures:[]});
    const [role] = await r.exec('SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(role).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return work(r);
  });
  const create = async (r: Runtime, rail: Rail = 'wechat', from = 'h5') => {
    if (['wechat', 'routine'].includes(from)) await f.db.insert(wechatUser).values({ uid: 11, userType: from, openid: payer });
    const order = await admitOfflineOrder(createContainerFromDb(r.db), { uid: 11, requestKey: crypto.randomUUID(),
      orderNo: 'xx' + crypto.randomUUID().replaceAll('-', '').slice(0, 30), money: '10.01', expectedPayPrice: '8.00', from });
    await selectOfflineOrderExternalPayment(createContainerFromDb(r.db), { uid: 11, orderNo: order.order_id,
      identity: { provider: rail, profile: rail === 'alipay' ? 'alipay' : from === 'routine' ? 'routine' : 'wechat',
        appId: rail === 'alipay' ? aliApp : appId, merchantId } });
    return order;
  };
  const evidence = () => f.query(`SELECT
    (SELECT count(*)::int FROM payment_callback_event) AS events,
    (SELECT count(*)::int FROM payment_callback_outbox) AS outboxes,
    (SELECT count(*)::int FROM payment_reconciliation_case) AS cases,
    (SELECT count(*)::int FROM offline_order_callback_binding) AS bindings,
    (SELECT count(*)::int FROM offline_order_external_payment) AS receipts,
    (SELECT count(*)::int FROM user_money) AS money,
    (SELECT count(*)::int FROM user_bill) AS bills,
    (SELECT count(*)::int FROM store_order_economize) AS savings`);
  const zero = { events: 0, outboxes: 0, cases: 0, bindings: 0, receipts: 0, money: 0, bills: 0, savings: 0 };
  const alipay = (orderNo: string, overrides: Record<string, string> = {}) => {
    const params = { app_id: aliApp, seller_id: merchantId, out_trade_no: orderNo, trade_no: 'test-' + crypto.randomUUID(),
      notify_id: crypto.randomUUID(), trade_status: 'TRADE_SUCCESS', total_amount: '8.00', gmt_payment: '2026-09-19 12:00:00', sign_type: 'RSA2', ...overrides };
    const content = Object.keys(params).sort().map(key => `${key}=${params[key as keyof typeof params]}`).join('&');
    return new URLSearchParams({ ...params, sign: Buffer.from(sign('RSA-SHA256', Buffer.from(content), keys.privateKey)).toString('base64') }).toString();
  };
  const wechat = (orderNo: string, overrides: Record<string, unknown> = {}, eventId = crypto.randomUUID()) => {
    const payload = { appid: appId, mchid: merchantId, out_trade_no: orderNo, transaction_id: 'test-' + crypto.randomUUID(),
      trade_state: 'SUCCESS', success_time: '2026-09-19T12:00:00+08:00', amount: { total: 800, currency: 'CNY' }, payer: { openid: payer }, ...overrides };
    const nonce = Buffer.from(randomBytes(6)).toString('hex'), associated = 'transaction';
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(aesKey), Buffer.from(nonce)); cipher.setAAD(Buffer.from(associated));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const body = JSON.stringify({ id: eventId, resource_type: 'encrypt-resource', resource: { algorithm: 'AEAD_AES_256_GCM',
      original_type: 'transaction', ciphertext, nonce, associated_data: associated } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    return { body, headers: { 'content-type': 'application/json', 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
      'wechatpay-serial': 'LOCAL_PLATFORM_KEY',
      'wechatpay-signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), keys.privateKey)).toString('base64') } };
  };
  const pipeline = async (r: Runtime) => {
    const container = createContainerFromDb(r.db), app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    const messages: PaymentCallbackMessage[] = [], pending: Promise<unknown>[] = [];
    const config: Record<string, string> = { cfg_wechat_appid: appId, cfg_routine_appId: appId, cfg_wechat_app_appid: appId,
      cfg_pay_weixin_mchid: merchantId, cfg_pay_weixin_serial_no: 'ABCDEF123456', cfg_site_url: 'https://local.example' };
    const control = { failQueue: false };
    const env = { ALIPAY_PUBLIC_KEY: keys.publicKey, ALIPAY_APP_ID: aliApp, ALIPAY_SELLER_ID: merchantId,
      WECHAT_MCH_PRIVATE_KEY: keys.privateKey, WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey,
      WECHAT_API_V3_KEY: aesKey, WECHAT_PLATFORM_PUBLIC_KEY_ID: 'LOCAL_PLATFORM_KEY',
      CONFIG_KV: { get: async (key: string) => config[key] ?? null, put: async () => {}, delete: async () => {} },
      ORDER_QUEUE: { sendBatch: async (batch: Iterable<{ body: OrderMessage }>) => {
        if (control.failQueue) throw Error('local_transport_failure');
        for (const item of batch) {
          if (!isPaymentCallbackMessage(item.body)) throw Error('Unexpected test message');
          // Separate maintenance connection sees the binding before publication.
          const proof = await f.query(`SELECT e.order_domain,b.event_id::integer AS event_id FROM payment_callback_event e
            JOIN offline_order_callback_binding b ON b.event_id=e.id WHERE e.id=${item.body.eventId}`);
          expect(proof.rows).toEqual([{ order_domain: 'offline_order', event_id: item.body.eventId }]);
          expect(Object.keys(item.body).sort()).toEqual(['action', 'eventId', 'replayKey']); messages.push(item.body);
        }
      } },
    };
    let callback: PaymentCallbackEventService | undefined, reconciliation: PaymentReconciliationService | undefined;
    let custom: ((settler: PaymentCallbackSettler) => PaymentCallbackEventService) | undefined;
    const query = vi.fn(async () => { throw Error('Offline recovery must not query current provider identity'); });
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.get('/init', c => {
      callback = new PaymentCallbackEventService(container, c.env);
      reconciliation = new PaymentReconciliationService(container, c.env, query);
      custom = settler => new PaymentCallbackEventService(container, c.env, settler);
      return c.body(null, 204);
    });
    app.all('/api/pay/notify/:type', c => paymentNotify(c, { alipayNotify, wechatPayNotify }));
    const ctx = { waitUntil: (work: Promise<unknown>) => { pending.push(work); }, props: {},
      passThroughOnException: () => { throw Error('Unexpected origin fallback'); } };
    await app.request('/init', {}, env, ctx);
    if (!callback || !reconciliation || !custom) throw Error('Test service initialization failed');
    return { callback, reconciliation, custom, query, messages, config, env, control,
      post: async (path: string, init: RequestInit) => {
        try { return await app.request(path, { method: 'POST', ...init }, env, ctx); }
        finally { await Promise.all(pending.splice(0)); }
      },
    };
  };
  const assertPaid = async () => {
    const [buyer] = await f.db.select().from(user);
    expect(buyer).toMatchObject({ nowMoney: '100.00', integral: 61, isEverLevel: 1, overdueTime: 0 });
    expect((await evidence()).rows[0]).toMatchObject({ receipts: 1, money: 0, bills: 1, savings: 1 });
    expect((await f.db.select().from(otherOrder))[0]).toMatchObject({ paid: 1, type: 3 });
  };
  it.each(['wechat', 'alipay', 'routine'] as const)('%s signed ingress commits identity with outbox and default queue settles exactly once', async rail => {
    await runtime(async r => {
      const order = await create(r, rail === 'alipay' ? 'alipay' : 'wechat', rail === 'routine' ? 'routine' : 'h5');
      const api = await pipeline(r);
      const request = rail === 'alipay' ? { body: alipay(order.order_id), headers: { 'content-type': 'application/x-www-form-urlencoded' } } : wechat(order.order_id);
      expect((await api.post('/api/pay/notify/' + rail, request)).status).toBe(200);
      expect((await f.db.select().from(otherOrder))[0].paid).toBe(0);
      expect((await evidence()).rows[0]).toEqual({ ...zero, events: 1, outboxes: 1, cases: 1, bindings: 1 });
      expect(await api.callback.processMessage(api.messages[0])).toBe('completed'); await assertPaid();
      expect(await api.callback.processMessage(api.messages[0])).toBe('already-completed');
      expect((await api.post('/api/pay/notify/' + rail, request)).status).toBe(200); await assertPaid();
      expect((await f.db.select().from(paymentCallbackEvent))[0]).toMatchObject({ status: 'COMPLETED', orderDomain: 'offline_order' });
      expect((await f.db.select().from(paymentReconciliationCase))[0]).toMatchObject({ status: 'CONFIRMED', orderDomain: 'offline_order' });
      expect(api.query).not.toHaveBeenCalled();
    });
  });
  it.each(['signature', 'app', 'merchant', 'amount', 'original-app', 'original-merchant', 'payer', 'missing-payer'] as const)('rejects WeChat %s without committing any canonical or financial evidence', async failure => {
    await runtime(async r => {
      const order = await create(r, 'wechat', 'wechat'), api = await pipeline(r);
      const payload: Record<string, unknown> = {};
      if (failure === 'app' || failure === 'original-app') payload.appid = 'wrong-app';
      if (failure === 'merchant' || failure === 'original-merchant') payload.mchid = '9876543210';
      if (failure === 'amount') payload.amount = { total: 801, currency: 'CNY' };
      if (failure === 'payer') payload.payer = { openid: 'wrong-payer' };
      if (failure === 'missing-payer') payload.payer = {};
      if (failure === 'original-app') api.config.cfg_wechat_appid = 'wrong-app';
      if (failure === 'original-merchant') api.config.cfg_pay_weixin_mchid = '9876543210';
      const request = wechat(order.order_id, payload);
      if (failure === 'signature') request.body += ' ';
      expect((await api.post('/api/pay/notify/wechat', request)).status).toBe(400);
      expect(api.messages).toEqual([]); expect((await evidence()).rows[0]).toEqual(zero);
    });
  });
  it.each(['signature', 'seller', 'original-app'] as const)('rejects Alipay %s before acknowledgement', async failure => {
    await runtime(async r => {
      const order = await create(r, 'alipay'), api = await pipeline(r);
      if (failure === 'original-app') api.env.ALIPAY_APP_ID = 'changed-local-app';
      let body = alipay(order.order_id, failure === 'seller' ? { seller_id: '9876543210' }
        : failure === 'original-app' ? { app_id: 'changed-local-app' } : {});
      if (failure === 'signature') body = body.replace('8.00', '9.00');
      expect((await api.post('/api/pay/notify/alipay', { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).not.toBe(200);
      expect((await evidence()).rows[0]).toEqual(zero);
    });
  });
  it.each(['serial', 'expired', 'decrypt', 'currency'])('rejects WeChat %s evidence before database persistence', async failure => {
    await runtime(async r => {
      const order = await create(r), api = await pipeline(r);
      const request = wechat(order.order_id, failure === 'currency' ? { amount: { total: 800, currency: 'USD' } } : {});
      if (failure === 'serial') request.headers['wechatpay-serial'] = 'OTHER_PLATFORM_KEY';
      if (failure === 'expired') request.headers['wechatpay-timestamp'] = '100';
      if (failure === 'decrypt') api.env.WECHAT_API_V3_KEY = 'x'.repeat(32);
      expect((await api.post('/api/pay/notify/wechat', request)).status).toBe(400);
      expect((await evidence()).rows[0]).toEqual(zero);
    });
  });
  it.each(['no-order', 'recharge-ambiguity'])('does not use the reserved prefix as authority: %s', async failure => {
    await runtime(async r => {
      const order = await create(r), api = await pipeline(r);
      if (failure === 'recharge-ambiguity') await f.exec(`INSERT INTO user_recharge(uid,order_id) VALUES (11,'${order.order_id}')`);
      const number = failure === 'no-order' ? 'xx' + '0'.repeat(30) : order.order_id;
      expect((await api.post('/api/pay/notify/wechat', wechat(number))).status).toBe(400);
      expect((await evidence()).rows[0]).toEqual(zero);
    });
  });
  it.each(['offline_order_callback_binding', 'payment_callback_outbox', 'domain-ddl'] as const)('rolls canonical event/case/outbox/binding back on %s failure', async failure => {
    await runtime(async r => {
      const order = await create(r), api = await pipeline(r), request = wechat(order.order_id);
      if (failure === 'domain-ddl') await f.exec(`ALTER TABLE payment_callback_event DROP CONSTRAINT pce_order_domain_ck;
        ALTER TABLE payment_callback_event ADD CONSTRAINT pce_order_domain_ck CHECK(order_domain IN ('','store_order','recharge','membership'))`);
      else await f.exec(`REVOKE INSERT ON ${failure} FROM "${r.role}"`);
      expect((await api.post('/api/pay/notify/wechat', request)).status).toBe(400);
      expect((await evidence()).rows[0]).toEqual(zero); expect(api.messages).toEqual([]);
      if (failure === 'domain-ddl') await f.exec(OFFLINE_ORDER_CALLBACK_DOMAIN_SQL);
      else await f.exec(`GRANT INSERT ON ${failure} TO "${r.role}"`);
      expect((await api.post('/api/pay/notify/wechat', request)).status).toBe(200);
      expect(await api.callback.processMessage(api.messages[0])).toBe('completed'); await assertPaid();
    });
  });
  it('does not publish an uncommitted canonical event before identity binding commits', async () => {
    await runtime(async a => runtime(async b => f.withPeer!(async holder => {
      const order = await create(a), api = await pipeline(a), observer = await pipeline(b);
      await f.exec(`CREATE FUNCTION local_binding_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(8675309); RETURN NEW; END $$;
        CREATE TRIGGER local_binding_barrier BEFORE INSERT ON offline_order_callback_binding FOR EACH ROW EXECUTE FUNCTION local_binding_barrier()`);
      await holder.exec('BEGIN'); await holder.exec('SELECT pg_advisory_xact_lock(8675309)');
      const pending = outcome(api.post('/api/pay/notify/wechat', wechat(order.order_id))); let released = false;
      try {
        await waitForFinanceBlock(f.db, a.pid, holder.pid);
        expect((await evidence()).rows[0]).toEqual(zero);
        expect(await observer.callback.dispatchPending()).toEqual({ claimed: 0, enqueued: 0 });
        await holder.exec('COMMIT'); released = true;
        const result = await pending; expect(result.ok && result.value.status).toBe(200);
        expect(api.messages).toHaveLength(1); expect(await api.callback.processMessage(api.messages[0])).toBe('completed');
      } finally { if (!released) await holder.exec('ROLLBACK'); await pending; }
    })));
  });
  it('retains a committed callback when Queue publication fails and redispatches from durable outbox', async () => {
    await runtime(async r => {
      const order = await create(r), api = await pipeline(r); api.control.failQueue = true;
      expect((await api.post('/api/pay/notify/wechat', wechat(order.order_id))).status).toBe(200);
      expect((await evidence()).rows[0]).toEqual({ ...zero, events: 1, outboxes: 1, cases: 1, bindings: 1 });
      api.control.failQueue = false; await f.exec('UPDATE payment_callback_outbox SET available_time=0');
      expect(await api.callback.dispatchPending()).toEqual({ claimed: 1, enqueued: 1 });
      expect(await api.callback.processMessage(api.messages[0])).toBe('completed'); await assertPaid();
    });
  });
  it('replays original receipt after a crash between financial commit and callback finish', async () => {
    await runtime(async r => {
      const order = await create(r), api = await pipeline(r);
      await api.post('/api/pay/notify/wechat', wechat(order.order_id));
      const crash = api.custom(async ref => { await settleOfflineOrderExternalPayment(createContainerFromDb(r.db), ref); throw Error('local_post_commit_crash'); });
      await expect(crash.processMessage(api.messages[0])).rejects.toThrow('local_post_commit_crash'); await assertPaid();
      await f.exec('UPDATE payment_callback_outbox SET available_time=0');
      expect(await api.callback.processMessage(api.messages[0])).toBe('completed'); await assertPaid();
    });
  });
  it('preserves a later signed transaction conflict when the first callback finishes', async () => {
    await runtime(async r => {
      const order = await create(r), api = await pipeline(r);
      await api.post('/api/pay/notify/wechat', wechat(order.order_id));
      const concurrent = api.custom(async ref => {
        await settleOfflineOrderExternalPayment(createContainerFromDb(r.db), ref);
        expect((await api.post('/api/pay/notify/wechat', wechat(order.order_id))).status).toBe(200);
        return { status: 'completed', domain: 'offline_order', errorCode: '' };
      });
      expect(await concurrent.processMessage(api.messages[0])).toBe('completed'); await assertPaid();
      expect((await evidence()).rows[0]).toMatchObject({ events: 2, bindings: 1, receipts: 1 });
      expect((await f.db.select().from(paymentReconciliationCase))[0].status).toBe('CONFLICT');
      expect(api.messages).toHaveLength(1);
    });
  });
  it('retains the offline domain when queue business validation fails', async () => {
    await runtime(async r => {
      const order = await create(r), api = await pipeline(r); await api.post('/api/pay/notify/wechat', wechat(order.order_id));
      await f.db.update(user).set({ integral: 2147483647 }).where(eq(user.uid, 11));
      expect(await api.callback.processMessage(api.messages[0])).toBe('unknown');
      expect((await f.db.select().from(paymentCallbackEvent))[0]).toMatchObject({ status: 'UNKNOWN', orderDomain: 'offline_order' });
      expect((await f.db.select().from(paymentReconciliationCase))[0]).toMatchObject({ status: 'CONFLICT', orderDomain: 'offline_order' });
      expect((await evidence()).rows[0]).toMatchObject({ receipts: 0, bills: 0, savings: 0 });
    });
  });
  it.each([false, true])('recovers a verified callback without current-provider I/O (already financially committed=%s)', async paid => {
    await runtime(async r => {
      const order = await create(r), api = await pipeline(r); await api.post('/api/pay/notify/wechat', wechat(order.order_id));
      if (paid) await settleOfflineOrderExternalPayment(createContainerFromDb(r.db), api.messages[0]);
      api.config.cfg_pay_weixin_mchid = 'changed-after-collection';
      await f.exec('UPDATE payment_reconciliation_case SET next_check_time=0');
      const [row] = await f.db.select().from(paymentReconciliationCase);
      const message = { action: 'processPaymentReconciliation' as const, caseId: row.id, replayKey: row.replayKey };
      expect(await api.reconciliation.processMessage(message)).toBe(paid ? 'confirmed' : 'settled');
      expect(await api.reconciliation.processMessage(message)).toBe('already-terminal');
      expect(await api.callback.processMessage(api.messages[0])).toBe('completed'); await assertPaid();
      expect(api.query).not.toHaveBeenCalled();
    });
  });
  it('never queries a new merchant or claims no-payment when the offline callback reference is absent', async () => {
    await runtime(async r => {
      const order = await create(r), api = await pipeline(r);
      const row = await api.reconciliation.registerIntent({ provider: 'wechat', profile: 'wechat', orderNo: order.order_id,
        orderDomain: 'offline_order', expectedAmountCents: 800, currency: 'CNY' });
      // Query is now available, but never with a rotated merchant identity.
      api.config.cfg_pay_weixin_mchid = '9999999999';
      await f.exec('UPDATE payment_reconciliation_case SET next_check_time=0');
      expect(await api.reconciliation.processMessage({ action: 'processPaymentReconciliation', caseId: row.id, replayKey: row.replayKey })).toBe('unknown');
      expect(api.query).not.toHaveBeenCalled(); expect((await evidence()).rows[0]).toEqual({ ...zero, cases: 1 });
    });
  });
  it('refuses a recovery case linked to an event from another offline order without provider I/O', async () => {
    await runtime(async r => {
      const first = await create(r), second = await create(r), api = await pipeline(r);
      await api.post('/api/pay/notify/wechat', wechat(first.order_id));
      await api.post('/api/pay/notify/wechat', wechat(second.order_id));
      const cases = await f.db.select().from(paymentReconciliationCase);
      const row = cases.find(item => item.orderNo === first.order_id)!;
      const other = cases.find(item => item.orderNo === second.order_id)!;
      await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0, callbackEventId: other.callbackEventId })
        .where(eq(paymentReconciliationCase.id, row.id));
      expect(await api.reconciliation.processMessage({ action: 'processPaymentReconciliation', caseId: row.id, replayKey: row.replayKey })).toBe('unknown');
      expect(api.query).not.toHaveBeenCalled(); expect((await evidence()).rows[0]).toMatchObject({ receipts: 0, bills: 0, savings: 0 });
    });
  });
});
