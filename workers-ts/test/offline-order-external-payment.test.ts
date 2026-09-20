import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { memberRight, otherOrder, paymentCallbackEvent, systemConfig, user, userBill, userMoney, wechatUser } from '../src/models/schema';
import { offlineOrderExternalPayment, offlineOrderCallbackBinding } from '../src/models/candidates/offline_order_external_payment';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL } from '../src/migrations/offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL } from '../src/migrations/offlineOrderBalance';
import { OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL } from '../src/migrations/offlineOrderExternalPayment';
import { admitOfflineOrder } from '../src/services/order/OfflineOrderAdmissionService';
import { selectOfflineOrderExternalPayment } from '../src/services/order/OfflineOrderPaymentSelectionService';
import { bindOfflineOrderCallback, settleOfflineOrderExternalPayment, type OfflineCallbackReference } from '../src/services/order/OfflineOrderExternalPaymentService';
import { persistVerifiedPaymentCallbackTx, type VerifiedPaymentCallback } from '../src/services/payment/PaymentCallbackPersistence';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

// Trusted decoded fixtures, NOT provider signature verification or Workers/HTTP
// acceptance. Canonical persistence primitive intentionally creates unbound
// historical fixtures; signed HTTP + atomic ingress are tested in the pipeline suite.
describe('offline external collection candidate on isolated native PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  type Runtime = SequenceRunnerPeer & { role: string };
  const identity = { provider: 'wechat' as const, profile: 'wechat' as const, appId: 'local-test-app', merchantId: 'local-test-merchant' };
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    ddl = await offlinePredecessorSchemaSql();
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await sequenceRunnerDatabase();
    await f.db.transaction(async tx => {
      for (const source of [ddl, OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_BALANCE_SQL, OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL]) {
        await tx.execute(sql.raw(source));
      }
    });
    await f.db.insert(user).values({ uid: 11, account: 'offline-external-buyer', nowMoney: '100.00', integral: 50, isEverLevel: 1 });
    await f.db.insert(systemConfig).values([{ id: 1, menuName: 'member_card_status', value: '1' },
      { id: 2, menuName: 'balance_func_status', value: 'invalid-wallet-switch' },
      { id: 3, menuName: 'yue_pay_status', value: '0' }, { id: 4, menuName: 'order_give_integral', value: '1.234567' }]);
    await f.db.insert(memberRight).values([{ id: 1, rightType: 'offline', number: 80, status: 1 },
      { id: 2, rightType: 'integral', number: 2, status: 1 }]);
  }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const runtime = <T>(work: (r: Runtime) => Promise<T>) => f.withRuntimeRole!(async r => {
    await f.exec(`GRANT SELECT ON "user",system_config,member_right,other_order,other_order_status,wechat_user,
      store_order,user_recharge,offline_order_admission,offline_order_payment_selection,offline_order_external_payment,
      offline_order_query_evidence,offline_order_callback_binding,user_money,user_bill,store_order_economize,payment_callback_event,payment_callback_outbox,payment_reconciliation_case TO "${r.role}";
      GRANT UPDATE(uid,integral,is_promoter) ON "user" TO "${r.role}";
      GRANT UPDATE(id,paid,pay_type,pay_time,trade_no) ON other_order TO "${r.role}";
      GRANT UPDATE(id) ON wechat_user TO "${r.role}";
      GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO "${r.role}";
      GRANT INSERT ON other_order,other_order_status,offline_order_admission,offline_order_payment_selection,offline_order_external_payment,
        offline_order_callback_binding,user_bill,store_order_economize TO "${r.role}";
      GRANT INSERT,UPDATE ON payment_callback_event,payment_callback_outbox,payment_reconciliation_case TO "${r.role}";
      GRANT USAGE ON SEQUENCE other_order_id_seq,user_bill_id_seq,store_order_economize_id_seq,
        payment_callback_event_id_seq,payment_callback_outbox_id_seq,payment_reconciliation_case_id_seq TO "${r.role}"`);
    const [role] = await r.exec('SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(role).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return work(r);
  });
  const create = async (r: Runtime, provider: 'wechat' | 'alipay' = 'wechat', from = 'h5', expected = '8.00') => {
    const order = await admitOfflineOrder(createContainerFromDb(r.db), { uid: 11, requestKey: crypto.randomUUID(),
      orderNo: 'xx' + crypto.randomUUID().replaceAll('-', '').slice(0, 30), money: '10.01', expectedPayPrice: expected, from });
    const profile = provider === 'alipay' ? 'alipay' as const : from === 'routine' ? 'routine' as const : 'wechat' as const;
    await selectOfflineOrderExternalPayment(createContainerFromDb(r.db), { uid: 11, orderNo: order.order_id, identity: { ...identity, provider, profile } });
    return order;
  };
  const callback = (orderNo: string, extra: Partial<VerifiedPaymentCallback> = {}): VerifiedPaymentCallback => ({
    provider: 'wechat', profile: 'wechat', providerEventId: crypto.randomUUID(), orderNo, transactionId: 'local-trade-' + crypto.randomUUID(),
    tradeState: 'SUCCESS', amountCents: 800, currency: 'CNY', providerEventTime: 100, ...extra });
  const receive = (r: Runtime, event: VerifiedPaymentCallback) =>
    withTx(createContainerFromDb(r.db), tx => persistVerifiedPaymentCallbackTx(tx, event));
  const bind = (r: Runtime, ref: OfflineCallbackReference, extra: Partial<{ appId: string; merchantId: string; payerId: string }> = {}) =>
    bindOfflineOrderCallback(createContainerFromDb(r.db), { ...ref, appId: identity.appId, merchantId: identity.merchantId, ...extra });
  const settle = (r: Runtime, ref: OfflineCallbackReference) => settleOfflineOrderExternalPayment(createContainerFromDb(r.db), ref);
  const prepared = async (r: Runtime) => {
    const order = await create(r), event = callback(order.order_id), ref = await receive(r, event);
    await bind(r, ref); return { order, event, ref };
  };
  const account = async () => (await f.db.select().from(user))[0];
  const state = () => f.query(`SELECT (SELECT row_to_json(u) FROM "user" u WHERE uid=11) AS account,
    (SELECT coalesce(json_agg(o ORDER BY id),'[]') FROM other_order o) AS orders,
    (SELECT coalesce(json_agg(r ORDER BY order_id),'[]') FROM offline_order_external_payment r) AS receipts,
    (SELECT coalesce(json_agg(c ORDER BY event_id),'[]') FROM offline_order_callback_binding c) AS bindings,
    (SELECT coalesce(json_agg(e ORDER BY id),'[]') FROM payment_callback_event e) AS callbacks,
    (SELECT coalesce(json_agg(m ORDER BY id),'[]') FROM user_money m) AS money,
    (SELECT coalesce(json_agg(b ORDER BY id),'[]') FROM user_bill b) AS bills,
    (SELECT coalesce(json_agg(s ORDER BY id),'[]') FROM store_order_economize s) AS savings,
    (SELECT coalesce(json_agg(t ORDER BY oid,change_type),'[]') FROM other_order_status t) AS statuses`);

  it.each(['wechat', 'alipay'] as const)('settles %s once with no wallet debit or membership extension, even with wallet switches disabled', async provider => {
    await runtime(async r => {
      const order = await create(r, provider), before = await account();
      const event = callback(order.order_id, { provider, profile: provider, tradeState: provider === 'wechat' ? 'SUCCESS' : 'TRADE_SUCCESS' });
      const ref = await receive(r, event); await bind(r, ref);
      expect(await settle(r, ref)).toMatchObject({ paid: true, pay_type: provider === 'wechat' ? 'weixin' : 'alipay', pay_price: '8.00', integral_reward: 11, replayed: false });
      expect(await account()).toEqual({ ...before, integral: 61 });
      expect(await f.db.select().from(userMoney)).toEqual([]);
      expect((await f.db.select().from(userBill))).toEqual([expect.objectContaining({ eventKey: 'offline_order_give_integral', number: '11.00', balance: '61.00' })]);
      expect((await f.query('SELECT offline_price FROM store_order_economize')).rows).toEqual([{ offline_price: '2.01' }]);
      expect((await f.db.select().from(paymentCallbackEvent))[0]).toMatchObject({ status: 'RECEIVED', orderDomain: '' });
      const snapshot = await state(); expect(await settle(r, ref)).toMatchObject({ replayed: true }); expect(await state()).toEqual(snapshot);
      await expect(r.exec('UPDATE "user" SET now_money=0')).rejects.toThrow('permission denied');
      await expect(r.exec("INSERT INTO user_money(uid) VALUES (11)")).rejects.toThrow('permission denied');
    });
  });
  it('requires a persisted identity binding and checks the opaque replay key', async () => {
    await runtime(async r => {
      const order = await create(r), ref = await receive(r, callback(order.order_id)), before = await state();
      await expect(settle(r, ref)).rejects.toThrow('可信回调绑定');
      await expect(bind(r, { ...ref, replayKey: crypto.randomUUID() })).rejects.toThrow('引用不存在');
      expect(await state()).toEqual(before); await bind(r, ref);
      expect(await bind(r, ref)).toMatchObject({ replayed: true }); await settle(r, ref);
    });
  });
  it.each(['appId', 'merchantId'] as const)('rejects a different trusted %s without writing a binding', async field => {
    await runtime(async r => { const order = await create(r), ref = await receive(r, callback(order.order_id)), before = await state();
      await expect(bind(r, ref, { [field]: 'wrong-local-identity' })).rejects.toThrow('不匹配'); expect(await state()).toEqual(before); });
  });
  it.each(['wechat', 'routine'])('requires the frozen %s JSAPI payer rather than a later account binding', async from => {
    await f.db.insert(wechatUser).values({ uid: 11, userType: from, openid: 'local-original-payer' });
    await runtime(async r => {
      const order = await create(r, 'wechat', from), ref = await receive(r, callback(order.order_id, { profile: from === 'routine' ? 'routine' : 'wechat' }));
      await f.db.update(wechatUser).set({ openid: 'local-rebound-payer' });
      await expect(bind(r, ref)).rejects.toThrow('不匹配');
      await expect(bind(r, ref, { payerId: 'local-rebound-payer' })).rejects.toThrow('不匹配');
      await bind(r, ref, { payerId: 'local-original-payer' }); await settle(r, ref);
      const binding = (await f.db.select().from(offlineOrderCallbackBinding))[0];
      expect(JSON.stringify(binding)).not.toContain('local-original-payer');
    });
  });
  it.each(['amount', 'profile', 'pending', 'long-trade', 'digest', 'other-domain'])('rejects %s evidence before any payment effect', async failure => {
    await runtime(async r => {
      const order = await create(r), event = callback(order.order_id);
      if (failure === 'amount') event.amountCents = 801;
      if (failure === 'profile') event.profile = 'routine';
      if (failure === 'pending') event.tradeState = 'NOTPAY';
      if (failure === 'long-trade') event.transactionId = 'x'.repeat(51);
      const ref = await receive(r, event);
      if (failure === 'digest') await f.db.update(paymentCallbackEvent).set({ payloadHash: 'a'.repeat(64) });
      if (failure === 'other-domain') await f.db.update(paymentCallbackEvent).set({ orderDomain: 'membership' });
      const before = await state(); await expect(bind(r, ref)).rejects.toThrow(); expect(await state()).toEqual(before);
    });
  });
  it('replays original rewards after account/config changes and accepts a second verified notification for the same transaction', async () => {
    await runtime(async r => {
      const { ref, event } = await prepared(r); await settle(r, ref);
      const first = (await f.db.select().from(offlineOrderExternalPayment))[0];
      await f.db.update(user).set({ integral: 100, nowMoney: '200.00', isEverLevel: 0, status: 0 });
      await f.db.update(systemConfig).set({ value: 'invalid' }); await f.db.update(otherOrder).set({ isDel: 1 });
      const second = await receive(r, { ...event, providerEventId: crypto.randomUUID(), providerEventTime: 200 });
      await bind(r, second); const before = await state();
      expect(await settle(r, second)).toMatchObject({ replayed: true, cancelled: true, integral_reward: 11 });
      expect(await state()).toEqual(before); expect((await f.db.select().from(offlineOrderExternalPayment))[0]).toEqual(first);
    });
  });
  it('retains collected money after account ban/deletion and order hiding without reactivating either', async () => {
    await runtime(async r => {
      const { ref } = await prepared(r);
      await f.db.update(user).set({ status: 0, isDel: 1, deleteTime: new Date(), nowMoney: '0.00' });
      await f.db.update(otherOrder).set({ isDel: 1 }); const before = await account();
      expect(await settle(r, ref)).toMatchObject({ paid: true, cancelled: true });
      expect(await account()).toEqual({ ...before, integral: 61 });
    });
  });
  it('detects conflicting transaction evidence even when the original binding predates the conflict', async () => {
    await runtime(async r => {
      const { ref, event } = await prepared(r), other = await create(r);
      const conflict = await receive(r, { ...event, orderNo: other.order_id, providerEventId: crypto.randomUUID() });
      expect(conflict.terminalConflict).toBe(true); const before = await state();
      await expect(settle(r, ref)).rejects.toThrow('冲突'); await expect(bind(r, conflict)).rejects.toThrow();
      expect(await state()).toEqual(before);
    });
  });
  it('does not ignore a recovery case conflicted by two successful transaction IDs for the same order', async () => {
    await runtime(async r => {
      const { ref, event } = await prepared(r);
      const other = await receive(r, { ...event, providerEventId: crypto.randomUUID(), transactionId: 'another-local-trade' });
      const before = await state();
      await expect(settle(r, ref)).rejects.toThrow('恢复凭据缺失或冲突');
      await expect(bind(r, other)).rejects.toThrow('恢复凭据缺失或冲突'); expect(await state()).toEqual(before);
    });
  });
  it('rejects a same-number recharge ambiguity rather than using type=3 as a routing shortcut', async () => {
    await runtime(async r => {
      const { order, ref } = await prepared(r);
      await f.exec(`INSERT INTO user_recharge(uid,order_id) VALUES (11,'${order.order_id}')`);
      const before = await state(); await expect(settle(r, ref)).rejects.toThrow('跨域歧义'); expect(await state()).toEqual(before);
    });
  });
  it('prevents direct paid-state commit without a matching receipt even when the caller can update payment columns', async () => {
    await runtime(async r => {
      const { order } = await prepared(r), before = await state();
      await expect(r.exec(`UPDATE other_order SET paid=1,pay_type='weixin',trade_no='local-forged',
        pay_time=floor(extract(epoch FROM statement_timestamp()))::integer WHERE id=${order.id}`)).rejects.toThrow('requires committed receipt');
      expect(await state()).toEqual(before);
    });
  });
  it.each(['user_bill', 'store_order_economize', 'offline_order_external_payment', 'other_order_status'])('rolls all financial effects back when %s INSERT fails, then retries once', async table => {
    await runtime(async r => {
      const { ref } = await prepared(r), before = await state(); await f.exec(`REVOKE INSERT ON ${table} FROM "${r.role}"`);
      await expect(settle(r, ref)).rejects.toThrow(); expect(await state()).toEqual(before);
      await f.exec(`GRANT INSERT ON ${table} TO "${r.role}"`);
      expect(await settle(r, ref)).toMatchObject({ replayed: false }); expect(await settle(r, ref)).toMatchObject({ replayed: true });
    });
  });
  it('does not adopt stray historical effects', async () => {
    await runtime(async r => { const { order, ref } = await prepared(r);
      await f.db.insert(userMoney).values({ uid: 11, linkId: order.order_id, type: 'offline_scan', number: '8.00' });
      const before = await state(); await expect(settle(r, ref)).rejects.toThrow('未绑定'); expect(await state()).toEqual(before); });
  });
  it('preserves the canonical callback and binding after an integral overflow', async () => {
    await runtime(async r => { const { ref } = await prepared(r); await f.db.update(user).set({ integral: 2147483647 });
      const before = await state(); await expect(settle(r, ref)).rejects.toThrow('超出范围'); expect(await state()).toEqual(before); });
  });
  it('supports zero reward and no discount without creating invented effects', async () => {
    await f.db.update(user).set({ isEverLevel: 0 }); await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'order_give_integral'));
    await runtime(async r => { const order = await create(r, 'wechat', 'h5', '10.01'), ref = await receive(r, callback(order.order_id, { amountCents: 1001 }));
      await bind(r, ref); await settle(r, ref); expect(await settle(r, ref)).toMatchObject({ replayed: true, integral_reward: 0 }); });
    expect((await f.db.select().from(offlineOrderExternalPayment))[0]).toMatchObject({ integralBillId: null, savingsId: null });
  });
  it('protects binding, receipt, evidence and effects after accidental grants while leaving operational status editable', async () => {
    await runtime(async r => {
      const { ref } = await prepared(r); await settle(r, ref); const before = await state();
      await f.exec(`GRANT UPDATE,DELETE,TRUNCATE ON offline_order_callback_binding,offline_order_external_payment,user_bill,store_order_economize TO "${r.role}"`);
      for (const statement of ["UPDATE offline_order_callback_binding SET identity_hash=repeat('a',64)", 'DELETE FROM offline_order_callback_binding',
        'TRUNCATE offline_order_callback_binding CASCADE', 'DELETE FROM offline_order_external_payment', 'TRUNCATE offline_order_external_payment',
        'UPDATE payment_callback_event SET amount_cents=801', 'UPDATE user_bill SET number=0', 'DELETE FROM store_order_economize',
        'TRUNCATE user_bill CASCADE', 'UPDATE other_order SET paid=0']) await expect(r.exec(statement)).rejects.toThrow();
      expect(await state()).toEqual(before);
      await r.db.update(paymentCallbackEvent).set({ status: 'PROCESSING', attemptCount: 1 });
      expect(await settle(r, ref)).toMatchObject({ replayed: true });
      const [unrelated] = await f.db.insert(userBill).values({ uid: 11, eventKey: 'unrelated' }).returning();
      expect(await r.db.delete(userBill).where(eq(userBill.id, unrelated.id)).returning({ id: userBill.id })).toEqual([{ id: unrelated.id }]);
      await expect(r.exec('SELECT public.ooep_guard()')).rejects.toThrow('permission denied');
    });
  });
  it('detects maintenance-corrupted reward evidence on replay', async () => {
    await runtime(async r => {
      const { ref } = await prepared(r); await settle(r, ref);
      await f.exec('ALTER TABLE user_bill DISABLE TRIGGER ooep_bill_guard; UPDATE user_bill SET number=0; ALTER TABLE user_bill ENABLE TRIGGER ooep_bill_guard');
      const before = await state(); await expect(settle(r, ref)).rejects.toThrow('凭据不完整'); expect(await state()).toEqual(before);
    });
  });
  it('rejects a repeatable-read transaction and does not install missing DDL at runtime', async () => {
    await runtime(async r => {
      const { ref } = await prepared(r), before = await state();
      await r.exec("SET default_transaction_isolation='repeatable read'");
      await expect(settle(r, ref)).rejects.toThrow('READ COMMITTED'); expect(await state()).toEqual(before);
      await r.exec("SET default_transaction_isolation='read committed'");
      await f.exec('DROP TABLE offline_order_external_payment');
      await expect(settle(r, ref)).rejects.toThrow(); expect((await account()).integral).toBe(50);
      expect((await f.query("SELECT to_regclass('public.offline_order_external_payment') AS object")).rows).toEqual([{ object: null }]);
    });
  });
  it('serializes independent replays on the same provider transaction and awards points only once', async () => {
    await runtime(async a => runtime(async b => f.withPeer!(async holder => {
      const { order, ref } = await prepared(a); await holder.exec('BEGIN'); await holder.exec(`SELECT id FROM other_order WHERE id=${order.id} FOR UPDATE`);
      const first = outcome(settle(a, ref)); let second: Promise<unknown> | undefined, released = false;
      try {
        await waitForFinanceBlock(f.db, a.pid, holder.pid); const next = outcome(settle(b, ref)); second = next;
        await waitForFinanceBlock(f.db, b.pid, a.pid); await holder.exec('COMMIT'); released = true;
        const results = await Promise.all([first, next]); expect(results.every(row => row.ok)).toBe(true);
        expect(results.filter(row => row.ok && !row.value.replayed)).toHaveLength(1);
      } finally { if (!released) await holder.exec('ROLLBACK'); await first; await second; }
    })));
    expect((await account()).integral).toBe(61); expect(await f.db.select().from(offlineOrderExternalPayment)).toHaveLength(1);
  });
  it('rechecks membership after waiting on the real account lock', async () => {
    await runtime(async r => f.withPeer!(async holder => {
      const { ref } = await prepared(r); await holder.exec('BEGIN'); await holder.exec('UPDATE "user" SET is_ever_level=0 WHERE uid=11');
      const pending = outcome(settle(r, ref)); let released = false;
      try { await waitForFinanceBlock(f.db, r.pid, holder.pid); await holder.exec('COMMIT'); released = true;
        expect(await pending).toMatchObject({ ok: true, value: { integral_reward: 9 } });
      } finally { if (!released) await holder.exec('ROLLBACK'); await pending; }
    }));
  });
});
