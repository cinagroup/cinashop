import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { seedHistoricalZeroOfflineOrder } from './helpers/offlineLegacyZeroFixture';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createContainerFromDb } from '../src/lib/di';
import { memberRight, otherOrder, systemConfig, user, userBill, userMoney } from '../src/models/schema';
import { offlineOrderBalance } from '../src/models/candidates/offline_order_balance';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL } from '../src/migrations/offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL } from '../src/migrations/offlineOrderBalance';
import { admitOfflineOrder, type OfflineOrderAdmissionInput } from '../src/services/order/OfflineOrderAdmissionService';
import { payOfflineOrderBalance } from '../src/services/order/OfflineOrderBalanceService';
import { V2UserCompatibilityService } from '../src/services/user/V2UserCompatibilityService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

describe('offline wallet settlement candidate on isolated native PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  type Runtime = SequenceRunnerPeer & { role: string };
  const input = (extra: Partial<OfflineOrderAdmissionInput> = {}): OfflineOrderAdmissionInput => ({ uid: 11,
    requestKey: crypto.randomUUID(), orderNo: 'xx' + crypto.randomUUID().replaceAll('-', '').slice(0, 30),
    money: '10.01', expectedPayPrice: '8.00', from: 'h5', ...extra });
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    ddl = await offlinePredecessorSchemaSql();
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await sequenceRunnerDatabase();
    await f.db.transaction(async tx => {
      await tx.execute(sql.raw(ddl)); await tx.execute(sql.raw(OFFLINE_ORDER_ADMISSION_SQL));
      await tx.execute(sql.raw(OFFLINE_ORDER_PAYMENT_SELECTION_SQL));
      await tx.execute(sql.raw(OFFLINE_ORDER_BALANCE_SQL));
    });
    await f.db.insert(user).values({ uid: 11, account: 'offline-wallet-buyer', nowMoney: '100.00', integral: 50, isEverLevel: 1 });
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'member_card_status', value: '1' }, { id: 2, menuName: 'balance_func_status', value: '1' },
      { id: 3, menuName: 'yue_pay_status', value: '1' }, { id: 4, menuName: 'order_give_integral', value: '1.234567' },
    ]);
    await f.db.insert(memberRight).values([
      { id: 1, rightType: 'offline', number: 80, status: 1 }, { id: 2, rightType: 'integral', number: 2, status: 1 },
    ]);
  }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const runtime = <T>(work: (r: Runtime) => Promise<T>) => f.withRuntimeRole!(async r => {
    await f.exec(`GRANT SELECT ON "user",system_config,member_right,other_order,other_order_status,
      offline_order_admission,offline_order_payment_selection,offline_order_balance,user_money,user_bill,store_order_economize TO "${r.role}";
      GRANT UPDATE(uid,now_money,integral,is_promoter) ON "user" TO "${r.role}";
      GRANT UPDATE(id,paid,pay_type,pay_time) ON other_order TO "${r.role}";
      GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO "${r.role}";
      GRANT INSERT ON other_order,other_order_status,offline_order_admission,offline_order_payment_selection,offline_order_balance,
        user_money,user_bill,store_order_economize TO "${r.role}";
      GRANT USAGE ON SEQUENCE other_order_id_seq,user_money_id_seq,user_bill_id_seq,store_order_economize_id_seq TO "${r.role}"`);
    const [role] = await r.exec(`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`);
    expect(role).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return work(r);
  });
  const create = (r: Runtime, request = input()) => admitOfflineOrder(createContainerFromDb(r.db), request);
  const pay = (r: Runtime, orderNo: string, uid = 11) => payOfflineOrderBalance(createContainerFromDb(r.db), { uid, orderNo });
  const config = (key: string, value: string) => f.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, key));
  const state = () => f.query(`SELECT
    (SELECT row_to_json(u) FROM "user" u WHERE uid=11) AS account,
    (SELECT coalesce(json_agg(o ORDER BY id),'[]') FROM other_order o) AS orders,
    (SELECT coalesce(json_agg(r ORDER BY order_id),'[]') FROM offline_order_balance r) AS receipts,
    (SELECT coalesce(json_agg(p ORDER BY order_id),'[]') FROM offline_order_payment_selection p) AS selections,
    (SELECT coalesce(json_agg(m ORDER BY id),'[]') FROM user_money m) AS money,
    (SELECT coalesce(json_agg(b ORDER BY id),'[]') FROM user_bill b) AS bills,
    (SELECT coalesce(json_agg(s ORDER BY id),'[]') FROM store_order_economize s) AS savings,
    (SELECT coalesce(json_agg(t ORDER BY oid,change_type),'[]') FROM other_order_status t) AS statuses`);
  const account = async () => (await f.db.select().from(user).where(eq(user.uid, 11)))[0];

  it('atomically charges the frozen price, writes visible cash history, adds—not multiplies—points and records savings', async () => {
    await runtime(async r => {
      const order = await create(r); const before = await account();
      expect(await pay(r, order.order_id)).toMatchObject({ paid: true, pay_type: 'yue', pay_price: '8.00',
        balance_after: '92.00', integral_reward: 11, replayed: false });
      const after = await account();
      expect(after).toEqual({ ...before, nowMoney: '92.00', integral: 61 });
      const [receipt] = await f.db.select().from(offlineOrderBalance);
      expect(receipt).toMatchObject({ orderId: order.id, balanceBefore: '100.00', balanceAfter: '92.00', integralRate: '1.234567',
        memberBonus: 2, integralBefore: 50, integralAfter: 61, integralReward: 11, promoted: false });
      expect((await f.query('SELECT * FROM store_order_economize')).rows).toEqual([expect.objectContaining({
        order_id: order.order_id, order_type: 2, offline_price: '2.01', pay_price: '8.00', status: 0,
      })]);
      const history = await new V2UserCompatibilityService(createContainerFromDb(r.db)).moneyList(11, 1, {});
      expect(history.count).toBe(1);
      expect(history.list[0]).toMatchObject({ link_id: order.order_id, type: 'offline_scan', type_name: '线下消费', number: '8.00', pm: 0 });
      expect((await f.db.select().from(userBill))).toEqual([expect.objectContaining({ category: 'integral', type: 'gain',
        eventKey: 'offline_order_give_integral', linkId: order.order_id, number: '11.00', balance: '61.00' })]);
      expect((await f.query("SELECT * FROM other_order_status WHERE change_type='pay_success'")).rows).toHaveLength(1);
    });
  });
  it('replays without debit or gift after later balance, membership, deletion and configuration changes', async () => {
    await runtime(async r => {
      const request = input(), order = await create(r, request); const first = await pay(r, order.order_id);
      await f.db.update(user).set({ nowMoney: '200.00', integral: 100, isEverLevel: 0 });
      await config('yue_pay_status', '0'); await config('order_give_integral', 'invalid');
      await f.db.update(otherOrder).set({ isDel: 1 }); const before = await state();
      expect(await pay(r, order.order_id)).toEqual({ ...first, replayed: true, cancelled: true });
      expect(await create(r, request)).toMatchObject({ id: order.id, paid: true, cancelled: true, replayed: true });
      expect(await state()).toEqual(before);
    });
  });
  it('does not reprice an admitted order when offline rights change before payment; points use current membership', async () => {
    await runtime(async r => {
      const order = await create(r);
      await f.db.update(memberRight).set({ number: 0 }).where(eq(memberRight.id, 1));
      await f.db.update(user).set({ isEverLevel: 0 });
      expect(await pay(r, order.order_id)).toMatchObject({ pay_price: '8.00', integral_reward: 9 });
      expect((await f.db.select().from(offlineOrderBalance))[0]).toMatchObject({ memberActive: false, memberBonus: 0 });
      expect((await f.query('SELECT offline_price FROM store_order_economize')).rows).toEqual([{ offline_price: '2.01' }]);
    });
  });
  it('allows the full NUMERIC(12,2) balance range without float conversion', async () => {
    await f.db.update(user).set({ nowMoney: '9999999999.99' });
    await runtime(async r => { const order = await create(r); expect(await pay(r, order.order_id)).toMatchObject({ balance_after: '9999999991.99' }); });
  });
  it('creates no points/savings entries for a nonmember with a zero reward policy', async () => {
    await f.db.update(user).set({ isEverLevel: 0 }); await config('order_give_integral', '0');
    await runtime(async r => {
      const order = await create(r, input({ expectedPayPrice: '10.01' }));
      expect(await pay(r, order.order_id)).toMatchObject({ integral_reward: 0, balance_after: '89.99' });
      expect(await pay(r, order.order_id)).toMatchObject({ replayed: true });
    });
    expect((await f.db.select().from(offlineOrderBalance))[0]).toMatchObject({ integralBillId: null, savingsId: null });
  });
  it('records a zero saving for an applied 100% member price, never an invented discount', async () => {
    await f.db.update(memberRight).set({ number: 100 }).where(eq(memberRight.id, 1));
    await runtime(async r => { const order = await create(r, input({ expectedPayPrice: '10.01' })); await pay(r, order.order_id); });
    expect((await f.query('SELECT offline_price FROM store_order_economize')).rows).toEqual([{ offline_price: '0.00' }]);
  });
  it('preserves historical zero-price admissions without debit, points, savings or payment selection', async () => {
    const order = await seedHistoricalZeroOfflineOrder(f.db);
    await runtime(async r => {
      const before = await state();
      await expect(pay(r, order.order_id)).rejects.toThrow('至少为0.01元'); expect(await state()).toEqual(before);
    });
  });
  it.each(['balance_func_status', 'yue_pay_status'])('checks SQL authority for the current %s switch', async key => {
    await runtime(async r => { const order = await create(r); await config(key, '0'); const before = await state();
      await expect(pay(r, order.order_id)).rejects.toThrow('未开启'); expect(await state()).toEqual(before); });
  });
  it('resolves duplicate global config by sort/id, ignoring store-specific overrides and accepting JSON scalar text', async () => {
    await f.db.insert(systemConfig).values([{ id: 5, menuName: 'order_give_integral', value: '"2.000000"', sort: 2 },
      { id: 6, menuName: 'order_give_integral', value: '3', sort: 1 },
      { id: 7, menuName: 'order_give_integral', value: '99', sort: 99, isStore: 1 }]);
    await runtime(async r => { const order = await create(r); expect(await pay(r, order.order_id)).toMatchObject({ integral_reward: 18 }); });
  });
  it('rejects an oversized policy value before performing any financial effects', async () => {
    await runtime(async r => {
      const order = await create(r); await config('order_give_integral', '1'.repeat(129)); const before = await state();
      await expect(pay(r, order.order_id)).rejects.toThrow('配置过长'); expect(await state()).toEqual(before);
    });
  });
  it.each(['insufficient', 'negative-balance', 'nan-balance', 'negative-points', 'points-overflow', 'malformed-rate', 'rate-overflow'])('rejects %s without any financial mutation', async failure => {
    await runtime(async r => {
      const order = await create(r);
      if (failure === 'insufficient') await f.db.update(user).set({ nowMoney: '7.99' });
      if (failure === 'negative-balance') await f.db.update(user).set({ nowMoney: '-1.00' });
      if (failure === 'nan-balance') await f.db.update(user).set({ nowMoney: 'NaN' });
      if (failure === 'negative-points') await f.db.update(user).set({ integral: -1 });
      if (failure === 'points-overflow') await f.db.update(user).set({ integral: 2147483647 });
      if (failure === 'malformed-rate') await config('order_give_integral', '1.1234567');
      if (failure === 'rate-overflow') { await config('order_give_integral', '99999999'); await f.db.update(memberRight).set({ number: 2147483647 }).where(eq(memberRight.id, 2)); }
      const before = await state(); await expect(pay(r, order.order_id)).rejects.toThrow(); expect(await state()).toEqual(before);
    });
  });
  it.each(['cancelled', 'paid-without-receipt', 'pending-provider', 'banned', 'soft-deleted', 'delete-time'])('rejects %s rather than inventing a payment receipt', async failure => {
    await runtime(async r => {
      const order = await create(r);
      if (failure === 'cancelled') await f.db.update(otherOrder).set({ isDel: 1 });
      if (failure === 'paid-without-receipt') await f.db.update(otherOrder).set({ paid: 1, payType: 'yue' });
      if (failure === 'pending-provider') await f.db.update(otherOrder).set({ tradeNo: 'provider-test-pending' });
      if (failure === 'banned') await f.db.update(user).set({ status: 0 });
      if (failure === 'soft-deleted') await f.db.update(user).set({ isDel: 1 });
      if (failure === 'delete-time') await f.db.update(user).set({ deleteTime: new Date() });
      const before = await state(); await expect(pay(r, order.order_id)).rejects.toThrow(); expect(await state()).toEqual(before);
    });
  });
  it('rejects wrong users, non-offline orders, missing admission and ambiguous order numbers', async () => {
    await runtime(async r => {
      const order = await create(r); const before = await state();
      await expect(pay(r, order.order_id, 12)).rejects.toThrow(); expect(await state()).toEqual(before);
      const bare = input(); await f.db.insert(otherOrder).values({ orderId: bare.orderNo, type: 3, uid: 11 });
      await expect(pay(r, bare.orderNo)).rejects.toThrow('凭据');
      await f.db.insert(otherOrder).values({ orderId: order.order_id, type: 1, uid: 11 });
      await expect(pay(r, order.order_id)).rejects.toThrow('身份异常');
      expect(await f.db.select().from(offlineOrderBalance)).toHaveLength(0);
    });
  });
  it.each(['offline_order_payment_selection', 'user_money', 'user_bill', 'store_order_economize', 'offline_order_balance', 'other_order_status'])('rolls back every effect when %s INSERT fails, then retries once', async table => {
    await runtime(async r => {
      const order = await create(r); const before = await state();
      await f.exec(`REVOKE INSERT ON ${table} FROM "${r.role}"`);
      await expect(pay(r, order.order_id)).rejects.toThrow(); expect(await state()).toEqual(before);
      await f.exec(`GRANT INSERT ON ${table} TO "${r.role}"`);
      expect(await pay(r, order.order_id)).toMatchObject({ replayed: false });
      expect(await pay(r, order.order_id)).toMatchObject({ replayed: true });
      expect((await account()).nowMoney).toBe('92.00');
    });
  });
  it('rejects unbound historical cash effects instead of appending or adopting them', async () => {
    await runtime(async r => {
      const order = await create(r);
      await f.db.insert(userMoney).values({ uid: 11, linkId: order.order_id, type: 'offline_scan', number: '8.00' });
      const before = await state(); await expect(pay(r, order.order_id)).rejects.toThrow('未绑定'); expect(await state()).toEqual(before);
    });
  });
  it.each([
    { table: 'user_money', field: 'number' }, { table: 'user_bill', field: 'number' },
    { table: 'store_order_economize', field: 'offline_price' },
  ])('rejects mismatched $table effects at the receipt boundary and rolls the debit back', async ({ table, field }) => {
    await runtime(async r => {
      const order = await create(r), before = await state();
      // Deliberately damaged INSERT in this owned fixture, not a production hook.
      await f.exec(`CREATE FUNCTION public.local_corrupt_effect() RETURNS trigger LANGUAGE plpgsql AS
        'BEGIN NEW.${field}=0; RETURN NEW; END';
        CREATE TRIGGER local_corrupt_effect BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.local_corrupt_effect()`);
      await expect(pay(r, order.order_id)).rejects.toThrow(); expect(await state()).toEqual(before);
    });
  });
  it('keeps points identity separate from mall orders with the same numeric id', async () => {
    await runtime(async r => {
      const order = await create(r);
      await f.db.insert(userBill).values({ uid: 11, linkId: String(order.id), category: 'integral', type: 'gain',
        eventKey: 'order_give_integral', number: '1.00', balance: '50.00', pm: 1 });
      await pay(r, order.order_id); expect(await f.db.select().from(userBill)).toHaveLength(2);
    });
  });
  it('applies the legacy paid-other-order promoter threshold without extending membership or incrementing pay_count', async () => {
    await f.db.insert(systemConfig).values([{ id: 5, menuName: 'brokerage_func_status', value: '1' },
      { id: 6, menuName: 'store_brokerage_statu', value: '3' }, { id: 7, menuName: 'store_brokerage_price', value: '10.00' }]);
    await f.db.insert(otherOrder).values({ orderId: 'hy_old_paid_local', uid: 11, type: 1, paid: 1, payPrice: '2.00' });
    await runtime(async r => { const order = await create(r); await pay(r, order.order_id); });
    expect(await account()).toMatchObject({ isPromoter: 1, payCount: 0, isEverLevel: 1 });
    expect((await f.db.select().from(offlineOrderBalance))[0]).toMatchObject({ promoted: true, policy: { paidTotal: '10.00' } });
  });
  it('protects paid state, receipt and linked effects even after accidental grants, without suppressing unrelated deletes', async () => {
    await runtime(async r => {
      const order = await create(r); await pay(r, order.order_id); const before = await state();
      await f.exec(`GRANT UPDATE,DELETE,TRUNCATE ON offline_order_balance,user_money,user_bill,store_order_economize TO "${r.role}"`);
      for (const statement of ['UPDATE offline_order_balance SET balance_after=0', 'DELETE FROM offline_order_balance',
        'TRUNCATE offline_order_balance', 'UPDATE user_money SET number=0', 'DELETE FROM user_bill',
        'UPDATE store_order_economize SET offline_price=0', 'TRUNCATE user_money CASCADE',
        `UPDATE other_order SET paid=0 WHERE id=${order.id}`]) await expect(r.exec(statement)).rejects.toThrow();
      expect(await state()).toEqual(before);
      const [unrelated] = await f.db.insert(userMoney).values({ uid: 11, type: 'local-unrelated' }).returning();
      expect(await r.db.delete(userMoney).where(eq(userMoney.id, unrelated.id)).returning({ id: userMoney.id })).toEqual([{ id: unrelated.id }]);
      await expect(r.exec("UPDATE system_config SET value='0'")).rejects.toThrow('permission denied');
      await expect(r.exec('SELECT public.oob_guard()')).rejects.toThrow('permission denied');
    });
  });
  it('fails closed for missing candidate DDL; application never installs it', async () => {
    await runtime(async r => { const order = await create(r); await f.exec('DROP TABLE offline_order_balance');
      await expect(pay(r, order.order_id)).rejects.toThrow(); expect((await account()).nowMoney).toBe('100.00');
      expect((await f.query("SELECT to_regclass('public.offline_order_balance') AS object")).rows).toEqual([{ object: null }]); });
  });
  it('detects corrupted linked evidence on replay instead of silently reporting success', async () => {
    await runtime(async r => {
      const order = await create(r); await pay(r, order.order_id);
      // Maintenance-only damage in this disposable fixture; runtime cannot disable triggers.
      await f.exec("ALTER TABLE user_money DISABLE TRIGGER oob_money_guard; UPDATE user_money SET balance=0; ALTER TABLE user_money ENABLE TRIGGER oob_money_guard");
      const before = await state(); await expect(pay(r, order.order_id)).rejects.toThrow('凭据不完整'); expect(await state()).toEqual(before);
    });
  });
  it('enforces finite receipt balances in CHECK constraints independently of the immutability trigger', async () => {
    await runtime(async r => {
      const order = await create(r); await pay(r, order.order_id); const before = await state();
      // Maintenance-only test of the CHECK itself; normal runtime cannot do this.
      await f.exec('ALTER TABLE offline_order_balance DISABLE TRIGGER oob_change_guard');
      try {
        await expect(f.exec("UPDATE offline_order_balance SET balance_before='NaN',balance_after='NaN'"))
          .rejects.toMatchObject({ code: '23514', constraint_name: 'oob_money_ck' });
      } finally { await f.exec('ALTER TABLE offline_order_balance ENABLE TRIGGER oob_change_guard'); }
      expect(await state()).toEqual(before);
    });
  });
  it('rejects repeatable-read settlement instead of using a stale configuration snapshot', async () => {
    await runtime(async r => { const order = await create(r); await r.exec("SET default_transaction_isolation='repeatable read'");
      const before = await state(); await expect(pay(r, order.order_id)).rejects.toThrow(); expect(await state()).toEqual(before); });
  });
  it('serializes independent payment attempts on the order and produces exactly one debit', async () => {
    await runtime(async a => runtime(async b => f.withPeer!(async holder => {
      const order = await create(a); await holder.exec('BEGIN');
      await holder.exec(`SELECT id FROM other_order WHERE id=${order.id} FOR UPDATE`);
      const first = outcome(pay(a, order.order_id)); let second: Promise<unknown> | undefined, released = false;
      try {
        await waitForFinanceBlock(f.db, a.pid, holder.pid);
        const next = outcome(pay(b, order.order_id)); second = next;
        await waitForFinanceBlock(f.db, b.pid, a.pid); await holder.exec('COMMIT'); released = true;
        const results = await Promise.all([first, next]);
        if (!results[0].ok || !results[1].ok) throw Error('Concurrent payment failed');
        expect(results.filter(row => row.ok && !row.value.replayed)).toHaveLength(1);
      } finally { if (!released) await holder.exec('ROLLBACK'); await first; await second; }
    })));
    expect((await account()).nowMoney).toBe('92.00'); expect(await f.db.select().from(offlineOrderBalance)).toHaveLength(1);
  });
  it('serializes different orders against one insufficient shared balance', async () => {
    await f.db.update(user).set({ nowMoney: '10.00' });
    await runtime(async a => runtime(async b => f.withPeer!(async holder => {
      const orderA = await create(a), orderB = await create(b); await holder.exec('BEGIN');
      await holder.exec('SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const first = outcome(pay(a, orderA.order_id)); let second: Promise<unknown> | undefined, released = false;
      try {
        await waitForFinanceBlock(f.db, a.pid, holder.pid);
        const next = outcome(pay(b, orderB.order_id)); second = next;
        await waitForFinanceBlock(f.db, b.pid, a.pid); await holder.exec('COMMIT'); released = true;
        const results = await Promise.all([first, next]);
        expect(results.filter(row => row.ok)).toHaveLength(1);
        expect(results.find(row => !row.ok)).toMatchObject({ error: { message: '余额不足' } });
      } finally { if (!released) await holder.exec('ROLLBACK'); await first; await second; }
    })));
    expect((await account()).nowMoney).toBe('2.00'); expect(await f.db.select().from(offlineOrderBalance)).toHaveLength(1);
  });
  it('rejects a concurrent configuration editor without partial effects', async () => {
    await runtime(async r => f.withPeer!(async editor => {
      const order = await create(r), before = await state(); await editor.exec('BEGIN');
      try { await editor.exec("UPDATE system_config SET value='0' WHERE menu_name='yue_pay_status'");
        await expect(pay(r, order.order_id)).rejects.toThrow(); expect(await state()).toEqual(before);
      } finally { await editor.exec('ROLLBACK'); }
    }));
  });
  it('rechecks membership after a real user-row lock wait before awarding points', async () => {
    await runtime(async r => f.withPeer!(async holder => {
      const order = await create(r); await holder.exec('BEGIN');
      await holder.exec('UPDATE "user" SET is_ever_level=0 WHERE uid=11');
      const paying = outcome(pay(r, order.order_id)); let released = false;
      try {
        await waitForFinanceBlock(f.db, r.pid, holder.pid); await holder.exec('COMMIT'); released = true;
        const result = await paying;
        expect(result).toMatchObject({ ok: true, value: { pay_price: '8.00', integral_reward: 9 } });
      } finally { if (!released) await holder.exec('ROLLBACK'); await paying; }
    }));
  });
  it('holds reward configuration through the actual last receipt insert until commit', async () => {
    await runtime(async r => f.withPeer!(async editor => {
      const order = await create(r); let release = () => {}, reached = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; });
      const original = PostgresJsSession.prototype.prepareQuery;
      const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
        const prepared = original.apply(this, args);
        if (args[0].sql.startsWith('insert into "offline_order_balance"')) {
          const execute = prepared.execute.bind(prepared);
          prepared.execute = async values => { const result = await execute(values); reached(); await gate; return result; };
        }
        return prepared;
      });
      const paying = outcome(pay(r, order.order_id)); let editing: Promise<unknown> | undefined;
      try {
        await Promise.race([ready, paying.then(row => { if (!row.ok) throw row.error; })]);
        editing = outcome(editor.exec("UPDATE system_config SET value='2' WHERE menu_name='order_give_integral'"));
        await waitForFinanceBlock(f.db, editor.pid, r.pid); release(); expect((await paying).ok).toBe(true); await editing;
      } finally { release(); spy.mockRestore(); await paying; await editing; }
      expect((await f.db.select().from(offlineOrderBalance))[0].integralReward).toBe(11);
    }));
  });
});
