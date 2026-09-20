import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { otherOrder, systemConfig, user, wechatUser } from '../src/models/schema';
import { offlineOrderPaymentSelection } from '../src/models/candidates/offline_order_payment_selection';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL } from '../src/migrations/offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL } from '../src/migrations/offlineOrderBalance';
import { admitOfflineOrder, type OfflineOrderAdmissionInput } from '../src/services/order/OfflineOrderAdmissionService';
import { payOfflineOrderBalance } from '../src/services/order/OfflineOrderBalanceService';
import { selectOfflineOrderExternalPayment, type OfflineExternalPaymentIdentity } from '../src/services/order/OfflineOrderPaymentSelectionService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

describe('offline payment path interlock on isolated native PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  type Runtime = SequenceRunnerPeer & { role: string };
  const wechat: OfflineExternalPaymentIdentity = { provider: 'wechat', profile: 'wechat', appId: 'local-wechat-app', merchantId: 'local-wechat-merchant' };
  const alipay: OfflineExternalPaymentIdentity = { provider: 'alipay', profile: 'alipay', appId: 'local-alipay-app', merchantId: 'local-alipay-merchant' };
  const input = (extra: Partial<OfflineOrderAdmissionInput> = {}): OfflineOrderAdmissionInput => ({ uid: 11,
    requestKey: crypto.randomUUID(), orderNo: 'xx' + crypto.randomUUID().replaceAll('-', '').slice(0, 30),
    money: '10.00', expectedPayPrice: '10.00', from: 'h5', ...extra });
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    ddl = await offlinePredecessorSchemaSql();
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    f = await sequenceRunnerDatabase();
    await f.db.transaction(async tx => {
      for (const statement of [ddl, OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_BALANCE_SQL]) await tx.execute(sql.raw(statement));
    });
    await f.db.insert(user).values([{ uid: 11, account: 'payment-selection-buyer', nowMoney: '100.00' }, { uid: 12, account: 'other-buyer' }]);
    await f.db.insert(systemConfig).values([{ menuName: 'balance_func_status', value: '1' }, { menuName: 'yue_pay_status', value: '1' }]);
  }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const runtime = <T>(work: (r: Runtime) => Promise<T>) => f.withRuntimeRole!(async r => {
    await f.exec(`GRANT SELECT ON "user",system_config,member_right,wechat_user,other_order,other_order_status,
      offline_order_admission,offline_order_payment_selection,offline_order_balance,user_money,user_bill,store_order_economize TO "${r.role}";
      GRANT UPDATE(uid,now_money,integral,is_promoter) ON "user" TO "${r.role}";
      GRANT UPDATE(id,paid,pay_type,pay_time) ON other_order TO "${r.role}";
      GRANT UPDATE(id) ON wechat_user TO "${r.role}";
      GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO "${r.role}";
      GRANT INSERT ON other_order,other_order_status,offline_order_admission,offline_order_payment_selection,offline_order_balance,
        user_money,user_bill,store_order_economize TO "${r.role}";
      GRANT USAGE ON SEQUENCE other_order_id_seq,user_money_id_seq,user_bill_id_seq,store_order_economize_id_seq TO "${r.role}"`);
    const [role] = await r.exec(`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return work(r);
  });
  const create = (r: Runtime, request = input()) => admitOfflineOrder(createContainerFromDb(r.db), request);
  const pay = (r: Runtime, orderNo: string) => payOfflineOrderBalance(createContainerFromDb(r.db), { uid: 11, orderNo });
  const select = (r: Runtime, orderNo: string, identity = wechat, uid = 11) => selectOfflineOrderExternalPayment(createContainerFromDb(r.db), { uid, orderNo, identity });
  const state = () => f.query(`SELECT
    (SELECT coalesce(json_agg(o ORDER BY id),'[]') FROM other_order o) AS orders,
    (SELECT coalesce(json_agg(p ORDER BY order_id),'[]') FROM offline_order_payment_selection p) AS selections,
    (SELECT coalesce(json_agg(b ORDER BY order_id),'[]') FROM offline_order_balance b) AS receipts,
    (SELECT row_to_json(u) FROM "user" u WHERE uid=11) AS account,
    (SELECT coalesce(json_agg(m ORDER BY id),'[]') FROM user_money m) AS money,
    (SELECT coalesce(json_agg(b ORDER BY id),'[]') FROM user_bill b) AS bills,
    (SELECT coalesce(json_agg(s ORDER BY oid,change_type),'[]') FROM other_order_status s) AS statuses`);

  it.each([wechat, alipay])('freezes $provider before dispatch and blocks wallet even without a provider transaction id', async identity => {
    await runtime(async r => {
      const order = await create(r), chosen = await select(r, order.order_id, identity);
      expect(chosen).toMatchObject({ replayed: false, selection: { uid: 11, orderId: order.id, orderNo: order.order_id,
        rail: identity.provider, appId: identity.appId, merchantId: identity.merchantId, payerId: '', currency: 'CNY', payPrice: '10.00' } });
      const before = await state();
      expect(await select(r, order.order_id, identity)).toEqual({ ...chosen, replayed: true });
      await expect(pay(r, order.order_id)).rejects.toMatchObject({ code: 409 });
      expect(await state()).toEqual(before);
      expect((await f.db.select().from(otherOrder))[0]).toMatchObject({ paid: 0, payType: '', tradeNo: '' });
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe('100.00');
    });
  });
  it('commits wallet selection with one debit, then rejects both external providers', async () => {
    await runtime(async r => {
      const order = await create(r); expect(await pay(r, order.order_id)).toMatchObject({ replayed: false, balance_after: '90.00' });
      const [choice] = await f.db.select().from(offlineOrderPaymentSelection);
      expect(choice).toMatchObject({ rail: 'yue', profile: '', transactionType: '', appId: '', merchantId: '', payerId: '' });
      const before = await state();
      expect(await pay(r, order.order_id)).toMatchObject({ replayed: true });
      await expect(select(r, order.order_id)).rejects.toMatchObject({ code: 409 });
      await expect(select(r, order.order_id, alipay)).rejects.toMatchObject({ code: 409 });
      expect(await state()).toEqual(before);
    });
  });
  it.each([
    { ...wechat, appId: 'another-app' }, { ...wechat, merchantId: 'another-merchant' },
    { ...wechat, profile: 'routine' as const }, alipay,
  ])('does not switch the frozen configuration to $provider/$profile/$appId/$merchantId', async replacement => {
    await runtime(async r => { const order = await create(r); await select(r, order.order_id); const before = await state();
      await expect(select(r, order.order_id, replacement)).rejects.toMatchObject({ code: 409 }); expect(await state()).toEqual(before); });
  });
  it.each(['wechat', 'routine'] as const)('freezes the authenticated %s binding and retains it during recovery after a binding change', async profile => {
    await f.db.insert(wechatUser).values({ uid: 11, userType: profile, openid: 'original-local-payer' });
    await runtime(async r => {
      const order = await create(r, input({ from: profile })), identity = { ...wechat, profile };
      const chosen = await select(r, order.order_id, identity);
      expect(chosen.selection).toMatchObject({ profile, transactionType: 'jsapi', payerId: 'original-local-payer' });
      await f.db.update(wechatUser).set({ openid: 'changed-local-payer', isDel: 1 });
      expect(await select(r, order.order_id, identity)).toEqual({ ...chosen, replayed: true });
    });
  });
  it.each(['missing', 'duplicate', 'deleted', 'other-user', 'other-profile'])('rejects a %s JSAPI binding without reserving a path', async scenario => {
    if (scenario !== 'missing') await f.db.insert(wechatUser).values({ uid: scenario === 'other-user' ? 12 : 11,
      userType: scenario === 'other-profile' ? 'routine' : 'wechat', openid: 'local-payer-a', isDel: scenario === 'deleted' ? 1 : 0 });
    if (scenario === 'duplicate') await f.db.insert(wechatUser).values({ uid: 11, userType: 'wechat', openid: 'local-payer-b' });
    await runtime(async r => { const order = await create(r, input({ from: 'wechat' })), before = await state();
      await expect(select(r, order.order_id)).rejects.toThrow('唯一'); expect(await state()).toEqual(before); });
  });
  it('rejects a merchant profile inconsistent with the original admission channel', async () => {
    await runtime(async r => { const order = await create(r, input({ from: 'routine' })), before = await state();
      await expect(select(r, order.order_id)).rejects.toThrow('原渠道'); expect(await state()).toEqual(before); });
  });
  it.each(['', 'contains space', 'a'.repeat(65)])('rejects malformed server merchant identity %s', async merchantId => {
    await runtime(async r => { const order = await create(r), before = await state();
      await expect(select(r, order.order_id, { ...wechat, merchantId })).rejects.toThrow('商户'); expect(await state()).toEqual(before); });
  });
  it('does not reserve for another customer or an unavailable account', async () => {
    await runtime(async r => {
      const order = await create(r), before = await state();
      await expect(select(r, order.order_id, wechat, 12)).rejects.toThrow('身份'); expect(await state()).toEqual(before);
      await f.db.update(user).set({ deleteTime: new Date() }).where(eq(user.uid, 11)); const deleted = await state();
      await expect(select(r, order.order_id)).rejects.toThrow('用户状态'); expect(await state()).toEqual(deleted);
    });
  });
  it.each(['21474836.47', '21474836.48'])('checks the existing int32-cent provider evidence limit for %s', async amount => {
    await runtime(async r => {
      const order = await create(r, input({ money: amount, expectedPayPrice: amount })), before = await state();
      if (amount === '21474836.47') expect((await select(r, order.order_id)).selection.payPrice).toBe(amount);
      else { await expect(select(r, order.order_id)).rejects.toThrow('证据范围'); expect(await state()).toEqual(before); }
    });
  });
  it('does not shrink the wallet amount range to the provider ledger limit', async () => {
    await f.db.update(user).set({ nowMoney: '9999999999.99' }).where(eq(user.uid, 11));
    await runtime(async r => { const order = await create(r, input({ money: '99999999.99', expectedPayPrice: '99999999.99' }));
      expect(await pay(r, order.order_id)).toMatchObject({ balance_after: '9900000000.00' }); });
  });
  it('cannot commit an orphan wallet reservation even through raw granted INSERT', async () => {
    await runtime(async r => {
      const order = await create(r), before = await state();
      await expect(r.db.insert(offlineOrderPaymentSelection).values({ orderId: order.id, uid: 11, orderNo: order.order_id,
        selectionKey: crypto.randomUUID(), rail: 'yue', profile: '', transactionType: '', appId: '', merchantId: '', payerId: '',
        payPrice: '10.00', createdAt: Math.floor(Date.now() / 1000) })).rejects.toThrow();
      expect(await state()).toEqual(before);
      expect((await select(r, order.order_id)).replayed).toBe(false);
    });
  });
  it('rolls back a late wallet failure including its path, allowing a subsequent external reservation', async () => {
    await runtime(async r => {
      const order = await create(r), before = await state();
      await f.exec(`REVOKE INSERT ON offline_order_balance FROM "${r.role}"`);
      await expect(pay(r, order.order_id)).rejects.toThrow(); expect(await state()).toEqual(before);
      expect((await select(r, order.order_id)).replayed).toBe(false);
    });
  });
  it('does not leave a path on a failed external INSERT, allowing a subsequent wallet payment', async () => {
    await runtime(async r => {
      const order = await create(r), before = await state();
      await f.exec(`REVOKE INSERT ON offline_order_payment_selection FROM "${r.role}"`);
      await expect(select(r, order.order_id)).rejects.toThrow(); expect(await state()).toEqual(before);
      await f.exec(`GRANT INSERT ON offline_order_payment_selection TO "${r.role}"`);
      expect(await pay(r, order.order_id)).toMatchObject({ balance_after: '90.00' });
    });
  });
  it('protects immutable choice and forbids payment on another rail despite accidental write grants', async () => {
    await runtime(async r => {
      const order = await create(r); await select(r, order.order_id); const before = await state();
      await f.exec(`GRANT UPDATE,DELETE,TRUNCATE ON offline_order_payment_selection TO "${r.role}"`);
      for (const statement of ["UPDATE offline_order_payment_selection SET merchant_id='changed'", 'DELETE FROM offline_order_payment_selection',
        'TRUNCATE offline_order_payment_selection CASCADE', `UPDATE other_order SET paid=1,pay_type='yue',pay_time=1900000000 WHERE id=${order.id}`,
        'SELECT public.oops_guard()', 'SELECT public.oops_wallet_commit()']) await expect(r.exec(statement)).rejects.toThrow();
      expect(await state()).toEqual(before);
    });
  });
  it('rechecks immutable identity on recovery instead of accepting maintenance-corrupted price', async () => {
    await runtime(async r => {
      const order = await create(r); await select(r, order.order_id);
      await f.exec('ALTER TABLE offline_order_payment_selection DISABLE TRIGGER oops_change_guard; UPDATE offline_order_payment_selection SET pay_price=9.00; ALTER TABLE offline_order_payment_selection ENABLE TRIGGER oops_change_guard');
      const before = await state(); await expect(select(r, order.order_id)).rejects.toThrow('凭据');
      await expect(pay(r, order.order_id)).rejects.toThrow('凭据'); expect(await state()).toEqual(before);
    });
  });
  it('needs no financial write privilege to reserve an external payment', async () => {
    await runtime(async r => {
      const order = await create(r);
      await f.exec(`REVOKE UPDATE ON "user",other_order FROM "${r.role}";
        REVOKE UPDATE(now_money,integral,is_promoter,uid) ON "user" FROM "${r.role}";
        REVOKE UPDATE(id,paid,pay_type,pay_time) ON other_order FROM "${r.role}";
        GRANT UPDATE(uid) ON "user" TO "${r.role}"; GRANT UPDATE(id) ON other_order TO "${r.role}"`);
      expect((await select(r, order.order_id)).replayed).toBe(false);
      await expect(r.exec('UPDATE "user" SET now_money=0 WHERE uid=11')).rejects.toMatchObject({ code: '42501' });
    });
  });
  it('fails closed for missing selection DDL without installing it or debiting', async () => {
    await runtime(async r => {
      const order = await create(r);
      await f.exec('ALTER TABLE offline_order_payment_selection RENAME TO offline_selection_missing_fixture');
      await expect(select(r, order.order_id)).rejects.toThrow(); await expect(pay(r, order.order_id)).rejects.toThrow();
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe('100.00');
      expect((await f.db.select().from(otherOrder))[0].paid).toBe(0);
      expect((await f.query("SELECT to_regclass('public.offline_order_payment_selection') AS relation")).rows).toEqual([{ relation: null }]);
    });
  });
  it('rejects a stale repeatable-read reservation', async () => {
    await runtime(async r => {
      const order = await create(r), before = await state(); await r.exec("SET default_transaction_isolation='repeatable read'");
      await expect(select(r, order.order_id)).rejects.toThrow('READ COMMITTED'); expect(await state()).toEqual(before);
    });
  });
  it('enforces the finite amount CHECK independently of the insert guard', async () => {
    await runtime(async r => {
      const order = await create(r), before = await state();
      await f.exec('ALTER TABLE offline_order_payment_selection DISABLE TRIGGER oops_insert_guard');
      try {
        await expect(r.exec(`INSERT INTO offline_order_payment_selection(order_id,selection_key,uid,order_no,rail,profile,
          transaction_type,app_id,merchant_id,payer_id,pay_price,created_at) VALUES(${order.id},'${crypto.randomUUID()}',11,
          '${order.order_id}','wechat','wechat','h5','local-app','local-merchant','','NaN',1900000000)`))
          .rejects.toMatchObject({ code: '23514', constraint_name: 'oops_price_ck' });
      } finally { await f.exec('ALTER TABLE offline_order_payment_selection ENABLE TRIGGER oops_insert_guard'); }
      expect(await state()).toEqual(before);
    });
  });
  it.each(['wallet-first', 'external-first', 'different-providers', 'same-provider'])('serializes independent contenders: %s', async scenario => {
    await runtime(async a => runtime(async b => f.withPeer!(async holder => {
      const order = await create(a); await holder.exec('BEGIN');
      await holder.exec(`SELECT id FROM other_order WHERE id=${order.id} FOR UPDATE`);
      const first = outcome<{ replayed: boolean }>(scenario === 'wallet-first' ? pay(a, order.order_id) : select(a, order.order_id));
      let second: Promise<unknown> | undefined, released = false;
      try {
        await waitForFinanceBlock(f.db, a.pid, holder.pid);
        const next = outcome<{ replayed: boolean }>(scenario === 'external-first' ? pay(b, order.order_id)
          : select(b, order.order_id, scenario === 'different-providers' ? alipay : wechat));
        second = next; await waitForFinanceBlock(f.db, b.pid, a.pid); await holder.exec('COMMIT'); released = true;
        const left = await first, right = await next;
        expect(left.ok).toBe(true);
        if (left.ok) expect(left.value.replayed).toBe(false);
        expect(right.ok).toBe(scenario === 'same-provider');
        if (right.ok) expect(right.value.replayed).toBe(true);
        else expect(right.error).toMatchObject({ code: 409 });
      } finally { if (!released) await holder.exec('ROLLBACK'); await first; await second; }
    })));
    expect(await f.db.select().from(offlineOrderPaymentSelection)).toHaveLength(1);
    expect((await f.db.select().from(offlineOrderPaymentSelection))[0].rail).toBe(scenario === 'wallet-first' ? 'yue' : 'wechat');
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe(scenario === 'wallet-first' ? '90.00' : '100.00');
  });
});
