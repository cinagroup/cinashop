import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { otherOrder, paymentReconciliationCase, systemConfig, user, wechatUser } from '../src/models/schema';
import { offlineOrderPaymentDispatch } from '../src/models/candidates/offline_order_payment_dispatch';
import { offlineOrderPaymentSelection } from '../src/models/candidates/offline_order_payment_selection';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL } from '../src/migrations/offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL } from '../src/migrations/offlineOrderBalance';
import { OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL } from '../src/migrations/offlineOrderExternalPayment';
import { OFFLINE_ORDER_CALLBACK_DOMAIN_SQL } from '../src/migrations/offlineOrderCallbackDomain';
import { OFFLINE_ORDER_PAYMENT_DISPATCH_SQL } from '../src/migrations/offlineOrderPaymentDispatch';
import { admitOfflineOrder } from '../src/services/order/OfflineOrderAdmissionService';
import { dispatchOfflineOrderPayment } from '../src/services/order/OfflineOrderPaymentDispatchService';
import { selectOfflineOrderExternalPayment } from '../src/services/order/OfflineOrderPaymentSelectionService';
import { payOfflineOrderBalance } from '../src/services/order/OfflineOrderBalanceService';
import { PaymentReconciliationService } from '../src/services/payment/PaymentReconciliationService';
import { PaymentCallbackEventService } from '../src/services/payment/PaymentCallbackEventService';
import { settleOfflineOrderExternalPayment } from '../src/services/order/OfflineOrderExternalPaymentService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

describe('offline first dispatch on isolated native PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string, keys: ReturnType<typeof paymentQueryKeys>;
  type Runtime = SequenceRunnerPeer & { role: string };
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    ddl = await offlinePredecessorSchemaSql(); keys = paymentQueryKeys();
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unstubbed external request forbidden'));
    f = await sequenceRunnerDatabase();
    await f.db.transaction(async tx => {
      for (const source of [ddl, OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_BALANCE_SQL,
        OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL, OFFLINE_ORDER_CALLBACK_DOMAIN_SQL, OFFLINE_ORDER_PAYMENT_DISPATCH_SQL]) await tx.execute(sql.raw(source));
    });
    await f.db.insert(user).values([{ uid: 11, account: 'dispatch-buyer', nowMoney: '100.00' }, { uid: 12, account: 'other-buyer' }]);
    await f.db.insert(systemConfig).values([{ menuName: 'balance_func_status', value: '1' }, { menuName: 'yue_pay_status', value: '1' }]);
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const runtime = <T>(work: (r: Runtime) => Promise<T>) => f.withRuntimeRole!(async r => {
    await f.exec(`GRANT SELECT ON "user",system_config,member_right,wechat_user,other_order,other_order_status,
      offline_order_admission,offline_order_payment_selection,offline_order_payment_dispatch,offline_order_balance,
      payment_reconciliation_case TO "${r.role}";
      GRANT UPDATE(uid) ON "user" TO "${r.role}"; GRANT UPDATE(id) ON other_order,wechat_user TO "${r.role}";
      GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO "${r.role}";
      GRANT INSERT ON other_order,other_order_status,offline_order_admission,offline_order_payment_selection,
        offline_order_payment_dispatch,payment_reconciliation_case TO "${r.role}";
      GRANT UPDATE(state,ticket_payload,ticket_hash,finished_at,display_until) ON offline_order_payment_dispatch TO "${r.role}";
      GRANT UPDATE ON payment_reconciliation_case TO "${r.role}";
      GRANT USAGE ON SEQUENCE other_order_id_seq,payment_reconciliation_case_id_seq TO "${r.role}"`);
    const [role] = await r.exec(`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return work(r);
  });
  const finance = (r: Runtime) => f.exec(`GRANT SELECT ON offline_order_external_payment,offline_order_callback_binding,
    offline_order_query_evidence,store_order,user_recharge,user_money,user_bill,store_order_economize,
    payment_callback_event,payment_callback_outbox TO "${r.role}";
    GRANT UPDATE(integral,is_promoter) ON "user" TO "${r.role}";
    GRANT UPDATE(paid,pay_type,pay_time,trade_no) ON other_order TO "${r.role}";
    GRANT INSERT ON offline_order_external_payment,offline_order_callback_binding,offline_order_query_evidence,user_bill,store_order_economize TO "${r.role}";
    GRANT INSERT,UPDATE ON payment_callback_event,payment_callback_outbox TO "${r.role}";
    GRANT USAGE ON SEQUENCE user_bill_id_seq,store_order_economize_id_seq,payment_callback_event_id_seq,payment_callback_outbox_id_seq TO "${r.role}"`);
  const create = async (r: Runtime, from: 'h5' | 'wechat' | 'routine' = 'h5', provider: 'wechat' | 'alipay' = 'wechat') => {
    const container = createContainerFromDb(r.db), api = await paymentQueryFixture(container, keys);
    api.config.cfg_pay_weixin_open = '1'; api.config.cfg_ali_pay_status = '1';
    await f.db.insert(systemConfig).values(Object.entries(api.config).map(([name,value])=>({menuName:name.slice(4),value})));
    api.env.ALIPAY_NOTIFY_URL = 'https://query.example/api/pay/notify/alipay'; api.env.ALIPAY_RETURN_URL = 'https://shop.example/payment';
    const orderNo = 'xx' + crypto.randomUUID().replaceAll('-', '').slice(0, 30);
    await admitOfflineOrder(container, { uid: 11, requestKey: crypto.randomUUID(), orderNo, money: '10.00', expectedPayPrice: '10.00', from });
    if (from !== 'h5') await f.db.insert(wechatUser).values({ uid: 11, openid: api.identity().payerId, userType: from });
    const input = { uid: 11, orderNo, provider, clientIp: '203.0.113.42' };
    const send = () => dispatchOfflineOrderPayment(container, api.env, input);
    const response = () => api.wechatResponse(from === 'h5' ? { h5_url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=local&package=test' }
      : { prepay_id: 'local-prepay' });
    return { container, api, input, send, response };
  };
  const counts = async () => (await f.query(`SELECT
    (SELECT count(*)::integer FROM offline_order_payment_selection) AS selections,
    (SELECT count(*)::integer FROM offline_order_payment_dispatch) AS dispatches,
    (SELECT count(*)::integer FROM payment_reconciliation_case) AS cases,
    (SELECT count(*)::integer FROM user_money) AS money,
    (SELECT count(*)::integer FROM user_bill) AS bills,
    (SELECT count(*)::integer FROM offline_order_external_payment) AS receipts`)).rows[0];
  const assertPost = (url: string, init: RequestInit, orderNo: string, channel: string) => {
    const u = new URL(url), body = JSON.parse(String(init.body));
    expect(u.origin).toBe('https://api.mch.weixin.qq.com'); expect(init.method).toBe('POST');
    expect(u.pathname).toBe(`/v3/pay/transactions/${channel === 'h5' ? 'h5' : 'jsapi'}`);
    expect(body).toMatchObject({ appid: 'wx-local-query', mchid: '1234567890', out_trade_no: orderNo,
      amount: { total: 1000, currency: 'CNY' }, attach: 'offline_order' });
    if (channel === 'h5') expect(body.scene_info.payer_client_ip).toBe('203.0.113.42');
    else expect(body.payer.openid).toBe('frozen-local-payer');
    const auth = new Headers(init.headers).get('Authorization') ?? '';
    const fields = Object.fromEntries([...auth.matchAll(/(\w+)="([^"]+)"/g)].map(m => [m[1], m[2]]));
    expect(fields).toMatchObject({ mchid: '1234567890', serial_no: 'ABCDEF123456' });
    expect(verify('RSA-SHA256', Buffer.from(`POST\n${u.pathname}\n${fields.timestamp}\n${fields.nonce_str}\n${init.body}\n`),
      keys.publicKey, Buffer.from(fields.signature, 'base64'))).toBe(true);
  };
  it.each(['h5', 'wechat', 'routine', 'alipay'] as const)('%s persists before I/O and replays the same signed entrance without money writes', async channel => {
    await runtime(async r => {
      const t = await create(r, channel === 'alipay' ? 'h5' : channel, channel === 'alipay' ? 'alipay' : 'wechat');
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (typeof url !== 'string' || !init) throw Error('Unexpected transport'); assertPost(url, init, t.input.orderNo, channel);
        expect((await f.query(`SELECT state,xact_start IS NULL AS ended FROM pg_stat_activity WHERE pid=${r.pid}`)).rows)
          .toEqual([{ state: 'idle', ended: true }]);
        expect(await counts()).toEqual({ selections: 1, dispatches: 1, cases: 1, money: 0, bills: 0, receipts: 0 });
        expect((await f.db.select().from(offlineOrderPaymentDispatch))[0].state).toBe('ISSUING');
        // Mutate current configuration while the original request is in flight.
        t.api.env.WECHAT_PLATFORM_PUBLIC_KEY = 'invalid'; t.api.config.cfg_pay_weixin_mchid = '9999999999';
        return t.response();
      });
      const first = await t.send(); expect(first).toMatchObject({ status: 'READY', replayed: false });
      if (first.status !== 'READY') throw Error('Missing entrance');
      if (first.ticket.kind === 'wechat-jsapi') {
        const p = first.ticket;
        expect(verify('RSA-SHA256', Buffer.from(`${p.appId}\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`), keys.publicKey, Buffer.from(p.paySign, 'base64'))).toBe(true);
      }
      if (first.ticket.kind === 'alipay-wap') {
        const p = new URL(first.ticket.url).searchParams, sig = p.get('sign') ?? ''; p.delete('sign');
        expect(verify('RSA-SHA256', Buffer.from([...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')),
          keys.publicKey, Buffer.from(sig, 'base64'))).toBe(true);
        const returnUrl = `https://shop.example/offline-payment-return?orderId=${t.input.orderNo}`;
        expect(p.getAll('return_url')).toEqual([returnUrl]);
        expect(JSON.parse(p.get('biz_content') ?? '{}')).toEqual({ out_trade_no: t.input.orderNo, total_amount: '10.00', subject: 'CinaShop线下消费',
          product_code: 'QUICK_WAP_WAY', passback_params: 'offline_order', quit_url: returnUrl });
        expect(p.has('seller_id')).toBe(false); expect(p.has('app_auth_token')).toBe(false);
      }
      t.api.config.cfg_pay_weixin_open = '0'; t.api.env.ALIPAY_PRIVATE_KEY = 'invalid';
      if (channel === 'wechat' || channel === 'routine') await f.db.update(wechatUser).set({ openid: 'new-binding' });
      expect(await t.send()).toEqual({ ...first, replayed: true });
      expect(fetch).toHaveBeenCalledTimes(channel === 'alipay' ? 0 : 1);
      expect(await counts()).toEqual({ selections: 1, dispatches: 1, cases: 1, money: 0, bills: 0, receipts: 0 });
      expect((await f.db.select().from(otherOrder))[0]).toMatchObject({ paid: 0, payType: '', tradeNo: '' });
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe('100.00');
      expect(JSON.stringify(first)).not.toContain('frozen-local-payer');
    });
  });
  it.each(['network', 'unsigned', 'host'] as const)('%s failure remains unknown and cannot be resent or switched', async failure => {
    await runtime(async r => {
      const t = await create(r);
      vi.mocked(fetch).mockImplementation(async () => {
        if (failure === 'network') throw Error('secret-provider-body');
        return failure === 'unsigned' ? new Response('{"h5_url":"https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?a=b"}')
          : t.api.wechatResponse({ h5_url: 'https://attacker.example/pay' });
      });
      expect(await t.send()).toEqual({ status: 'RECOVERY_REQUIRED', replayed: false });
      expect(await t.send()).toEqual({ status: 'RECOVERY_REQUIRED', replayed: true });
      await expect(dispatchOfflineOrderPayment(t.container, t.api.env, { ...t.input, provider: 'alipay' })).rejects.toMatchObject({ code: 409 });
      await expect(payOfflineOrderBalance(t.container, t.input)).rejects.toMatchObject({ code: 409 });
      expect((await f.db.select().from(offlineOrderPaymentDispatch))[0]).toMatchObject({ state: 'UNKNOWN', ticketPayload: '', ticketHash: '' });
      expect(fetch).toHaveBeenCalledOnce(); expect(await counts()).toMatchObject({ money: 0, bills: 0, receipts: 0 });
    });
  });
  it.each(['switch', 'private-key', 'public-key', 'ip', 'owner'] as const)('%s preflight failure commits no selection or intent', async failure => {
    await runtime(async r => {
      const t = await create(r);
      if (failure === 'switch') await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,'pay_weixin_open'));
      if (failure === 'private-key') t.api.env.WECHAT_MCH_PRIVATE_KEY = 'invalid';
      if (failure === 'public-key') t.api.env.WECHAT_PLATFORM_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----garbage-----END PUBLIC KEY-----';
      if (failure === 'ip') t.input.clientIp = '::ffff:127.0.0.1';
      if (failure === 'owner') t.input.uid = 12;
      await expect(t.send()).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
      expect(await counts()).toEqual({ selections: 0, dispatches: 0, cases: 0, money: 0, bills: 0, receipts: 0 });
    });
  });
  it('pre-existing standalone reservation is not proof that dispatch never happened', async () => {
    await runtime(async r => {
      const t = await create(r); await selectOfflineOrderExternalPayment(t.container, { ...t.input, identity: { provider: 'wechat', profile: 'wechat',
        appId: t.api.identity().appId, merchantId: t.api.identity().merchantId } });
      expect(await t.send()).toEqual({ status: 'RECOVERY_REQUIRED', replayed: true }); expect(fetch).not.toHaveBeenCalled();
      expect(await counts()).toMatchObject({ selections: 1, dispatches: 0, cases: 0 });
    });
  });
  it('missing dispatch insert permission rolls the whole reservation back before network I/O', async () => {
    await runtime(async r => {
      const t = await create(r); await f.exec(`REVOKE INSERT ON offline_order_payment_dispatch FROM "${r.role}"`);
      await expect(t.send()).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
      expect(await counts()).toMatchObject({ selections: 0, dispatches: 0, cases: 0 });
    });
  });
  it('lost completion leaves ISSUING durable and a retry never repeats the outgoing request', async () => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockImplementation(async () => {
        await f.exec(`REVOKE UPDATE(state,ticket_payload,ticket_hash,finished_at,display_until) ON offline_order_payment_dispatch FROM "${r.role}"`);
        return t.response();
      });
      await expect(t.send()).rejects.toThrow();
      expect((await f.db.select().from(offlineOrderPaymentDispatch))[0].state).toBe('ISSUING');
      await f.exec(`GRANT UPDATE(state,ticket_payload,ticket_hash,finished_at,display_until) ON offline_order_payment_dispatch TO "${r.role}"`);
      expect(await t.send()).toEqual({ status: 'RECOVERY_REQUIRED', replayed: true }); expect(fetch).toHaveBeenCalledOnce();
    });
  });
  it('a second backend during provider I/O sees ISSUING and does not send again', async () => {
    await runtime(async a => runtime(async b => {
      const t = await create(a); let release!: () => void, entered!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      vi.mocked(fetch).mockImplementation(async () => { entered(); await gate; return t.response(); });
      const first = outcome(t.send());
      try {
        await enteredPromise;
        expect(await dispatchOfflineOrderPayment(createContainerFromDb(b.db), t.api.env, t.input)).toEqual({ status: 'RECOVERY_REQUIRED', replayed: true });
      } finally { release(); }
      expect(await first).toMatchObject({ ok: true, value: { status: 'READY' } }); expect(fetch).toHaveBeenCalledOnce();
    }));
  });
  it('simultaneous first calls serialize on independent backend order locks', async () => {
    await runtime(async a => runtime(async b => f.withPeer!(async holder => {
      const t = await create(a); vi.mocked(fetch).mockImplementation(async () => t.response());
      await holder.exec('BEGIN'); await holder.exec('SELECT id FROM other_order FOR UPDATE');
      const first = outcome(t.send()); let second: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, a.pid, holder.pid);
        second = outcome(dispatchOfflineOrderPayment(createContainerFromDb(b.db), t.api.env, t.input));
        await waitForFinanceBlock(f.db, b.pid, a.pid);
      } finally { await holder.exec('ROLLBACK'); }
      expect(await first).toMatchObject({ ok: true }); expect(await second).toMatchObject({ ok: true });
      expect(fetch).toHaveBeenCalledOnce(); expect(await counts()).toMatchObject({ selections: 1, dispatches: 1, cases: 1 });
    })));
  });
  it('UNKNOWN initiation recovers through actual signed query and one financial receipt', async () => {
    await runtime(async r => {
      const t = await create(r); await finance(r);
      expect(await t.send()).toMatchObject({ status: 'RECOVERY_REQUIRED' });
      await f.db.update(paymentReconciliationCase).set({ nextCheckTime: 0 });
      const [row] = await f.db.select().from(paymentReconciliationCase);
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (typeof url !== 'string' || !init) throw Error('Unexpected query'); expect(t.api.verifyRequest(url, init)).toBe(true);
        return t.api.wechatResponse(t.api.wxBody({ out_trade_no: t.input.orderNo, trade_type: 'MWEB', success_time: new Date().toISOString() }));
      });
      expect(await new PaymentReconciliationService(t.container, t.api.env).processMessage({ action: 'processPaymentReconciliation', caseId: row.id, replayKey: row.replayKey })).toBe('settled');
      expect(await t.send()).toEqual({ status: 'PAID', replayed: true }); expect(fetch).toHaveBeenCalledTimes(2);
      expect(await counts()).toMatchObject({ money: 0, receipts: 1 });
    });
  });
  it.each(['paid', 'conflict', 'closed'] as const)('%s during I/O is not overwritten by late entrance completion', async action => {
    await runtime(async r => {
      const t = await create(r); await finance(r);
      vi.mocked(fetch).mockImplementation(async () => {
        if (action === 'paid') {
          const callback = new PaymentCallbackEventService(t.container, t.api.env);
          const ref = await callback.receive({ provider: 'wechat', profile: 'wechat', providerEventId: crypto.randomUUID(), orderNo: t.input.orderNo,
            transactionId: 'dispatch-paid', tradeState: 'SUCCESS', amountCents: 1000, currency: 'CNY', providerEventTime: Math.floor(Date.now() / 1000) },
          { appId: t.api.identity().appId, merchantId: t.api.identity().merchantId });
          await settleOfflineOrderExternalPayment(t.container, ref);
          // Emulate queue completion separately from the financial transaction.
          await f.db.update(paymentReconciliationCase).set({ status: 'CONFIRMED' });
        } else await f.db.update(paymentReconciliationCase).set({ status: action === 'conflict' ? 'CONFLICT' : 'CLOSED' });
        return t.response();
      });
      expect(await t.send()).toEqual({ status: action === 'paid' ? 'PAID' : 'RECOVERY_REQUIRED', replayed: false });
      expect((await f.db.select().from(paymentReconciliationCase))[0].status).toBe(action === 'paid' ? 'CONFIRMED' : action.toUpperCase());
      expect(await t.send()).toMatchObject({ status: action === 'paid' ? 'PAID' : 'RECOVERY_REQUIRED', replayed: true }); expect(fetch).toHaveBeenCalledOnce();
    });
  });
  it('database guards prohibit redelivery, identity changes and removal even with maintenance DML grants', async () => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockImplementation(async () => t.response()); await t.send();
      await f.exec(`GRANT UPDATE,DELETE,TRUNCATE ON offline_order_payment_dispatch TO "${r.role}"`);
      for (const statement of ["UPDATE offline_order_payment_dispatch SET state='ISSUING',ticket_payload='',ticket_hash='',finished_at=0,display_until=0",
        "UPDATE offline_order_payment_dispatch SET attempt_key=gen_random_uuid()", 'DELETE FROM offline_order_payment_dispatch', 'TRUNCATE offline_order_payment_dispatch']) {
        await expect(r.exec(statement)).rejects.toThrow();
      }
      expect((await f.db.select().from(offlineOrderPaymentDispatch))[0].state).toBe('READY');
    });
  });
  it('elapsed display horizon suppresses the ticket without declaring NO_PAYMENT or reissuing', async () => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockImplementation(async () => t.response()); await t.send();
      // Owned maintenance fixture only: move the complete immutable timeline
      // back together to model elapsed wall time without a five-minute sleep.
      await f.exec(`BEGIN;
        ALTER TABLE other_order DISABLE TRIGGER USER;
        ALTER TABLE offline_order_admission DISABLE TRIGGER USER;
        ALTER TABLE offline_order_payment_selection DISABLE TRIGGER USER;
        ALTER TABLE offline_order_payment_dispatch DISABLE TRIGGER USER;
        UPDATE other_order SET add_time=add_time-301;
        UPDATE offline_order_admission SET created_at=created_at-301;
        UPDATE offline_order_payment_selection SET created_at=created_at-301;
        UPDATE offline_order_payment_dispatch SET created_at=created_at-301,finished_at=finished_at-301,display_until=display_until-301;
        UPDATE payment_reconciliation_case SET initiated_time=initiated_time-301;
        ALTER TABLE other_order ENABLE TRIGGER USER;
        ALTER TABLE offline_order_admission ENABLE TRIGGER USER;
        ALTER TABLE offline_order_payment_selection ENABLE TRIGGER USER;
        ALTER TABLE offline_order_payment_dispatch ENABLE TRIGGER USER; COMMIT;`);
      expect(await t.send()).toEqual({ status: 'RECOVERY_REQUIRED', replayed: true }); expect(fetch).toHaveBeenCalledOnce();
      expect((await f.db.select().from(paymentReconciliationCase))[0]).toMatchObject({ status: 'OPEN', providerStatus: 'UNKNOWN' });
      expect((await f.db.select().from(otherOrder))[0].paid).toBe(0);
      expect((await f.db.select().from(offlineOrderPaymentSelection))[0].rail).toBe('wechat');
    });
  });
  it('corrupted ticket bytes fail digest verification without a resend', async () => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockImplementation(async () => t.response()); await t.send();
      await f.exec(`BEGIN; ALTER TABLE offline_order_payment_dispatch DISABLE TRIGGER USER;
        UPDATE offline_order_payment_dispatch SET ticket_payload='{}';
        ALTER TABLE offline_order_payment_dispatch ENABLE TRIGGER USER; COMMIT;`);
      await expect(t.send()).rejects.toThrow('摘要'); expect(fetch).toHaveBeenCalledOnce();
    });
  });
  it('recovery linkage corruption rejects before replaying a previously valid ticket', async () => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockImplementation(async () => t.response()); await t.send();
      await f.db.update(paymentReconciliationCase).set({ initiatedTime: 0 });
      await expect(t.send()).rejects.toThrow('凭据不一致'); expect(fetch).toHaveBeenCalledOnce();
    });
  });
  it('account ban during I/O preserves outcome but does not return a usable ticket', async () => {
    await runtime(async r => {
      const t = await create(r); vi.mocked(fetch).mockImplementation(async () => {
        await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11)); return t.response();
      });
      expect(await t.send()).toEqual({ status: 'RECOVERY_REQUIRED', replayed: false });
      expect((await f.db.select().from(offlineOrderPaymentDispatch))[0].state).toBe('READY');
      await expect(t.send()).rejects.toThrow('用户状态'); expect(fetch).toHaveBeenCalledOnce();
    });
  });
  it('pre-existing recovery intent is preserved without a new reservation or provider request', async () => {
    await runtime(async r => {
      const t = await create(r), recovery = new PaymentReconciliationService(t.container, t.api.env);
      await recovery.registerIntent({ ...t.api.request(), orderNo: t.input.orderNo });
      const before = await f.db.select().from(paymentReconciliationCase);
      expect(await t.send()).toEqual({ status: 'RECOVERY_REQUIRED', replayed: true }); expect(fetch).not.toHaveBeenCalled();
      expect(await f.db.select().from(paymentReconciliationCase)).toEqual(before);
      expect(await counts()).toMatchObject({ selections: 0, dispatches: 0, cases: 1 });
    });
  });
});
