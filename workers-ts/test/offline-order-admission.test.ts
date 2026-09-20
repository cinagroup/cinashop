import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createContainerFromDb } from '../src/lib/di';
import { memberRight, otherOrder, systemConfig, user } from '../src/models/schema';
import { offlineOrderAdmission } from '../src/models/candidates/offline_order_admission';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { admitOfflineOrder, type OfflineOrderAdmissionInput } from '../src/services/order/OfflineOrderAdmissionService';
import { findMembershipOrderByOrderId, applyMembershipPayment } from '../src/services/user/PaidMembershipService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

describe('offline order admission candidate on isolated native PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  const input = (overrides: Partial<OfflineOrderAdmissionInput> = {}): OfflineOrderAdmissionInput => ({
    uid: 11, requestKey: crypto.randomUUID(), money: '10.01', expectedPayPrice: '8.00', from: 'h5',
    orderNo: 'xx' + crypto.randomUUID().replaceAll('-', '').slice(0, 30), ...overrides,
  });
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    ddl = await offlinePredecessorSchemaSql();
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await sequenceRunnerDatabase();
    await f.db.transaction(async tx => { await tx.execute(sql.raw(ddl)); await tx.execute(sql.raw(OFFLINE_ORDER_ADMISSION_SQL)); });
    await f.db.insert(user).values({ uid: 11, account: 'offline-local-buyer', nowMoney: '100.00', integral: 50, isEverLevel: 1 });
    await f.db.insert(systemConfig).values({ id: 1, menuName: 'member_card_status', value: '1' });
    await f.db.insert(memberRight).values({ id: 1, rightType: 'offline', number: 80, status: 1 });
  }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  type Runtime = SequenceRunnerPeer & { role: string };
  const runtime = <T>(work: (r: Runtime) => Promise<T>, statusInsert = true) => f.withRuntimeRole!(async r => {
    await f.exec(`GRANT SELECT ON "user",system_config,member_right,other_order,other_order_status,offline_order_admission TO "${r.role}";
      GRANT UPDATE(uid) ON "user" TO "${r.role}";
      GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO "${r.role}";
      GRANT INSERT ON other_order,offline_order_admission TO "${r.role}";
      GRANT USAGE ON SEQUENCE other_order_id_seq TO "${r.role}";
      ${statusInsert ? `GRANT INSERT ON other_order_status TO "${r.role}";` : ''}`);
    const [identity] = await r.exec(`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`);
    expect(identity).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return work(r);
  });
  const admit = (r: Runtime, request = input()) => admitOfflineOrder(createContainerFromDb(r.db), request);
  const rows = async () => ({ orders: await f.db.select().from(otherOrder), receipts: await f.db.select().from(offlineOrderAdmission),
    statuses: (await f.query('SELECT * FROM other_order_status')).rows });
  const finances = () => f.query(`SELECT (SELECT row_to_json(u) FROM "user" u WHERE uid=11) AS account,
    (SELECT count(*) FROM user_bill) AS bills,(SELECT count(*) FROM store_order_economize) AS savings`);
  it('writes one unpaid type=3 order, status and immutable server-price evidence without charging or extending membership', async () => {
    const before = await finances();
    await runtime(async r => {
      const created = await admit(r);
      expect(created).toMatchObject({ paid: false, cancelled: false, replayed: false, pay_price: '8.00' });
      const state = await rows();
      expect(state.orders).toHaveLength(1); expect(state.receipts).toHaveLength(1); expect(state.statuses).toHaveLength(1);
      expect(state.orders[0]).toMatchObject({ type: 3, uid: 11, money: '10.01', payPrice: '8.00', memberPrice: '8.00',
        isFree: 0, isPermanent: 0, overdueTime: 0, vipDay: 0, paid: 0, payType: '', tradeNo: '' });
      expect(state.receipts[0]).toMatchObject({ orderId: created.id, orderNo: created.order_id, memberActive: true, discountPercent: 80 });
      expect(state.statuses[0]).toMatchObject({ oid: created.id, change_type: 'create_offline_scan_order', shop_type: 3 });
      expect(await findMembershipOrderByOrderId(createContainerFromDb(r.db), created.order_id)).toBeNull();
      // A membership callback must not grant membership to this distinct domain.
      await f.exec(`GRANT UPDATE(id) ON other_order TO "${r.role}"`);
      expect(await applyMembershipPayment(createContainerFromDb(r.db), { orderId: created.order_id, payType: 'weixin', expectedAmountCents: 800 }))
        .toMatchObject({ outcome: 'missing' });
    });
    expect(await finances()).toEqual(before);
  });
  it('replays the same normalized request after configuration and membership changes without a second order', async () => {
    await runtime(async r => {
      const request = input({ money: '10', expectedPayPrice: '8', from: 'weixin' });
      const first = await admit(r, request);
      await f.db.update(systemConfig).set({ value: '0' }); await f.db.update(user).set({ isEverLevel: 0 });
      const replay = await admit(r, { ...request, money: '10.00', expectedPayPrice: '8.00', from: 'wechat', orderNo: input().orderNo });
      expect(replay).toEqual({ ...first, replayed: true });
      expect((await rows()).orders).toHaveLength(1);
    });
  });
  it.each(['money', 'expectedPayPrice', 'from'] as const)('rejects conflicting request-key reuse for %s', async key => {
    await runtime(async r => {
      const request = input(); await admit(r, request); const before = await rows();
      await expect(admit(r, { ...request, [key]: key === 'from' ? 'routine' : '10.00' })).rejects.toMatchObject({ code: 409 });
      expect(await rows()).toEqual(before);
    });
  });
  it('returns changed authoritative price and writes nothing when confirmation is stale', async () => {
    await f.db.update(memberRight).set({ number: 90 });
    await runtime(async r => { await expect(admit(r)).rejects.toMatchObject({ code: 409, data: { pay_price: '9.00' } }); });
    expect(await rows()).toEqual({ orders: [], receipts: [], statuses: [] });
  });
  it('treats a missing member quote as the full amount, not a zero charge', async () => {
    await f.db.update(user).set({ isEverLevel: 0 });
    await runtime(async r => {
      await expect(admit(r, input({ expectedPayPrice: '0.00' }))).rejects.toMatchObject({ code: 400, message: expect.stringContaining('至少为0.01元') });
      expect(await admit(r, input({ expectedPayPrice: '10.01' }))).toMatchObject({ pay_price: '10.01', paid: false });
    });
    expect((await rows()).receipts[0]).toMatchObject({ discountPercent: 0, memberActive: false });
  });
  it('rejects both zero confirmation and client-rounded-up confirmation without any order or financial writes', async () => {
    const before = await finances();
    await runtime(async r => {
      for (const expectedPayPrice of ['0.00', '0.01']) {
        await expect(admit(r, input({ money: '0.01', expectedPayPrice }))).rejects.toMatchObject({ code: 400, message: expect.stringContaining('至少为0.01元') });
      }
    });
    expect(await rows()).toEqual({ orders: [], receipts: [], statuses: [] });
    expect(await finances()).toEqual(before);
  });
  it('admits the exact one-cent boundary, replays its frozen price, but rejects new orders after a sub-cent policy change', async () => {
    await runtime(async r => {
      const request = input({ money: '0.02', expectedPayPrice: '0.01' });
      const first = await admit(r, request);
      expect(first).toMatchObject({ pay_price: '0.01', paid: false });
      await f.db.update(memberRight).set({ number: 1 });
      expect(await admit(r, request)).toEqual({ ...first, replayed: true });
      const before = await rows(), financial = await finances();
      await expect(admit(r, input({ money: '0.02', expectedPayPrice: '0.01' }))).rejects.toThrow('至少为0.01元');
      expect(await rows()).toEqual(before); expect(await finances()).toEqual(financial);
    });
  });
  it('rejects malformed write identities and amounts before any SQL', async () => {
    await runtime(async r => {
      for (const bad of [input({ money: '1e1' }), input({ money: '100000000' }), input({ money: '10.001' }),
        input({ expectedPayPrice: '-1' }), input({ uid: 0 }), input({ requestKey: 'legacy-request' }),
        input({ orderNo: 'hy_membership' }), input({ from: 'app' }), input({ from: 'constructor' }), input({ from: '__proto__' })]) {
        await expect(admit(r, bad)).rejects.toMatchObject({ code: 400 });
      }
    });
    expect(await rows()).toEqual({ orders: [], receipts: [], statuses: [] });
  });
  it.each(['banned', 'deleted', 'deleted-time', 'missing'])('refuses an unavailable account: %s', async state => {
    if (state === 'missing') await f.db.delete(user); else await f.db.update(user).set(state === 'banned' ? { status: 0 }
      : state === 'deleted-time' ? { deleteTime: new Date() } : { isDel: 1 });
    await runtime(async r => { await expect(admit(r)).rejects.toMatchObject({ code: 410000 }); });
    expect((await rows()).orders).toHaveLength(0);
  });
  it('rolls back order and receipt on a late status-write permission failure; retry is safe', async () => {
    const request = input(); const before = await finances();
    await runtime(async r => { await expect(admit(r, request)).rejects.toThrow(); }, false);
    expect(await rows()).toEqual({ orders: [], receipts: [], statuses: [] }); expect(await finances()).toEqual(before);
    await runtime(async r => { expect(await admit(r, request)).toMatchObject({ replayed: false }); });
  });
  it('preserves cancelled and paid replay identity instead of creating a replacement', async () => {
    await runtime(async r => {
      const request = input(); const first = await admit(r, request);
      // Simulates future settlement state only; not a tested payment writer.
      await f.db.update(otherOrder).set({ paid: 1, payType: 'yue', isDel: 1 }).where(eq(otherOrder.id, first.id));
      expect(await admit(r, request)).toMatchObject({ id: first.id, replayed: true, paid: true, cancelled: true });
      expect((await rows()).orders).toHaveLength(1);
    });
  });
  it('enforces immutable receipts/pricing even when the test role is accidentally over-granted', async () => {
    await runtime(async r => {
      const created = await admit(r);
      await f.exec(`GRANT UPDATE,DELETE,TRUNCATE ON offline_order_admission TO "${r.role}"; GRANT UPDATE,DELETE ON other_order TO "${r.role}"`);
      for (const statement of [`DELETE FROM offline_order_admission`, `TRUNCATE offline_order_admission`,
        `UPDATE offline_order_admission SET request_hash=repeat('a',64)`,
        `UPDATE other_order SET pay_price='0.01' WHERE id=${created.id}`, `UPDATE other_order SET uid=99 WHERE id=${created.id}`,
        `UPDATE other_order SET type=1 WHERE id=${created.id}`, `DELETE FROM other_order WHERE id=${created.id}`]) {
        await expect(r.exec(statement)).rejects.toThrow(/immutable|cannot be deleted/);
      }
      expect((await rows()).orders[0]).toMatchObject({ payPrice: '8.00', uid: 11, type: 3 });
    });
  });
  it('does not suppress legacy other_order updates or deletes', async () => {
    const [legacy] = await f.db.insert(otherOrder).values({ uid: 11, type: 1, orderId: 'hy_local_legacy' }).returning();
    await f.db.update(otherOrder).set({ remarks: 'Local test' }).where(eq(otherOrder.id, legacy.id));
    expect(await f.db.delete(otherOrder).where(eq(otherOrder.id, legacy.id)).returning({ id: otherOrder.id })).toEqual([{ id: legacy.id }]);
  });
  it('grants only a fixed lock capability, not configuration writes or arbitrary definer execution', async () => {
    await runtime(async r => {
      await expect(r.exec("UPDATE system_config SET value='0'")).rejects.toThrow('permission denied');
      await expect(r.exec('UPDATE member_right SET number=1')).rejects.toThrow('permission denied');
      const [privileges] = await r.exec(`SELECT has_function_privilege(current_user,'public.ooa_guard()','EXECUTE') AS guard,
        has_function_privilege(current_user,'public.ooa_lock_pricing()','EXECUTE') AS lock`);
      expect(privileges).toMatchObject({ guard: false, lock: true });
      expect(await admit(r)).toMatchObject({ pay_price: '8.00' });
    });
  });
  it('keeps request keys scoped to the current buyer, not another account', async () => {
    await f.db.insert(user).values({ uid: 12, account: 'second-offline-buyer' });
    await runtime(async r => {
      const request = input(); const first = await admit(r, request);
      const second = await admit(r, { ...request, uid: 12, expectedPayPrice: '10.01', orderNo: input().orderNo });
      expect(second.id).not.toBe(first.id); expect(second.replayed).toBe(false);
      expect((await rows()).receipts.map(row => row.uid).sort()).toEqual([11, 12]);
    });
  });
  it('rejects a server order number already occupied by any legacy domain', async () => {
    const request = input(); await f.db.insert(otherOrder).values({ orderId: request.orderNo, uid: 11, type: 1 });
    await runtime(async r => { await expect(admit(r, request)).rejects.toThrow('已存在'); });
    expect((await rows()).receipts).toHaveLength(0); expect((await rows()).orders).toHaveLength(1);
  });
  it('rejects inserting an admission against a mismatched underlying order', async () => {
    await runtime(async r => {
      const request = input();
      const [wrong] = await f.db.insert(otherOrder).values({ orderId: request.orderNo, uid: 11, type: 1,
        payPrice: '8.00', money: '10.01', memberPrice: '8.00', channelType: 'h5', addTime: 100 }).returning();
      await expect(r.db.insert(offlineOrderAdmission).values({ uid: 11, requestKey: request.requestKey,
        requestHash: 'a'.repeat(64), orderId: wrong.id, orderNo: wrong.orderId, rawPrice: '10.01', payPrice: '8.00',
        memberActive: true, discountPercent: 80, channel: 'h5', createdAt: 100 })).rejects.toThrow();
      expect((await rows()).receipts).toHaveLength(0);
    });
  });
  it('fails closed when the candidate schema is missing, without runtime DDL', async () => {
    await runtime(async r => {
      await f.exec('DROP TABLE offline_order_admission'); // Empty table in this test-owned database only.
      await expect(admit(r)).rejects.toThrow();
      expect((await f.query("SELECT to_regclass('public.offline_order_admission') AS object")).rows).toEqual([{ object: null }]);
      expect(await f.db.select().from(otherOrder)).toHaveLength(0);
    });
  });
  it('rejects repeatable-read admission rather than using stale authority', async () => {
    await runtime(async r => {
      await r.exec("SET default_transaction_isolation='repeatable read'");
      await expect(admit(r)).rejects.toThrow('READ COMMITTED');
      expect((await rows()).orders).toHaveLength(0);
    });
  });
  it('rechecks membership after the exact user lock wait', async () => {
    await runtime(async r => f.withPeer!(async holder => {
      await holder.exec('BEGIN'); await holder.exec('UPDATE "user" SET is_ever_level=0 WHERE uid=11');
      const creating = outcome(admit(r));
      let committed = false;
      try {
        await waitForFinanceBlock(f.db, r.pid, holder.pid);
        await holder.exec('COMMIT'); committed = true;
        const result = await creating;
        expect(result.ok).toBe(false);
        if (result.ok) throw Error('Stale membership was admitted');
        expect(result.error).toMatchObject({ code: 409, data: { pay_price: '10.01' } });
      } finally { if (!committed) await holder.exec('ROLLBACK'); await creating; }
    }));
    expect((await rows()).orders).toHaveLength(0);
  });
  it('serializes simultaneous independent requests for the same absent key using the user lock', async () => {
    const request = input();
    await runtime(async a => runtime(async b => f.withPeer!(async holder => {
      await holder.exec('BEGIN'); await holder.exec('SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const first = outcome(admit(a, request));
      let second: Promise<unknown> | undefined, committed = false;
      try {
        await waitForFinanceBlock(f.db, a.pid, holder.pid);
        const next = outcome(admit(b, { ...request, orderNo: input().orderNo })); second = next;
        await waitForFinanceBlock(f.db, b.pid, a.pid);
        await holder.exec('COMMIT'); committed = true;
        const results = await Promise.all([first, next]);
        expect(results.every(result => result.ok)).toBe(true);
        if (!results[0].ok || !results[1].ok) throw Error('Admission unexpectedly failed');
        expect(results[0].value.order_id).toBe(results[1].value.order_id);
        expect(results.filter(result => result.ok && !result.value.replayed)).toHaveLength(1);
      } finally { if (!committed) await holder.exec('ROLLBACK'); await first; await second; }
    })));
    expect((await rows()).orders).toHaveLength(1); expect((await rows()).statuses).toHaveLength(1);
  });
  it('rejects a concurrent config editor and keeps all writes atomic', async () => {
    await runtime(async r => f.withPeer!(async writer => {
      await writer.exec('BEGIN');
      try {
        await writer.exec(`INSERT INTO system_config(id,menu_name,value,sort) VALUES(2,'member_card_status','0',99)`);
        await expect(admit(r)).rejects.toThrow('正在更新');
        expect((await rows()).orders).toHaveLength(0);
      } finally { await writer.exec('ROLLBACK'); }
    }));
  });
  it('holds pricing sources until commit while an independent editor waits', async () => {
    await runtime(async r => f.withPeer!(async writer => {
      let release = () => {}, reached = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { reached = resolve; });
      const original = PostgresJsSession.prototype.prepareQuery;
      const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
        const prepared = original.apply(this, args);
        if (args[0].sql.startsWith('insert into "offline_order_admission"')) {
          const execute = prepared.execute.bind(prepared);
          prepared.execute = async values => { const result = await execute(values); reached(); await gate; return result; };
        }
        return prepared;
      });
      const creating = outcome(admit(r)); let editing: Promise<unknown> | undefined;
      try {
        await Promise.race([ready, creating.then(result => { if (!result.ok) throw result.error; })]);
        editing = outcome(writer.exec('UPDATE member_right SET number=50 WHERE id=1'));
        await waitForFinanceBlock(f.db, writer.pid, r.pid);
        release(); expect((await creating).ok).toBe(true); await editing;
      } finally { release(); spy.mockRestore(); await creating; await editing; }
      expect((await rows()).receipts[0]).toMatchObject({ payPrice: '8.00', discountPercent: 80 });
      expect((await f.db.select().from(memberRight))[0].number).toBe(50);
    }));
  });
});
