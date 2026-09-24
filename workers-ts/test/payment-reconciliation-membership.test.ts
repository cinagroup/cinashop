import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { otherOrder, paymentReconciliationAction, paymentReconciliationCase, storeOrder, user, userRecharge,
  type PaymentCallbackOrderDomain } from '../src/models/schema';
import { PaymentReconciliationService } from '../src/services/payment/PaymentReconciliationService';
import type { PaymentProviderQuery } from '../src/services/payment/PaymentProviderQuery';
import { ValidateException } from '../src/utils/errors';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

describe('membership reconciliation evidence on isolated native PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  const orderNo = 'membership-evidence-test';
  type Runtime = SequenceRunnerPeer & { role: string };
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 required');
    f = await sequenceRunnerDatabase();
    const kit = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
    await f.exec((await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(schema))).join('\n'));
    await f.db.insert(user).values({ uid: 11, account: 'reconciliation-evidence', nowMoney: '100.00', integral: 50 });
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    await f.db.delete(paymentReconciliationAction); await f.db.delete(paymentReconciliationCase);
    await f.db.delete(otherOrder); await f.db.delete(storeOrder); await f.db.delete(userRecharge);
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  afterAll(async () => { await f?.close(); });
  const runtime = <T>(work: (r: Runtime) => Promise<T>) => f.withRuntimeRole!(async r => {
    await f.exec(`GRANT SELECT ON other_order,store_order,user_recharge,payment_reconciliation_case,payment_reconciliation_action TO "${r.role}";
      GRANT UPDATE(id) ON other_order,store_order,user_recharge TO "${r.role}";
      GRANT UPDATE ON payment_reconciliation_case TO "${r.role}";
      GRANT INSERT ON payment_reconciliation_action TO "${r.role}";
      GRANT USAGE ON SEQUENCE payment_reconciliation_action_id_seq TO "${r.role}"`);
    const [identity] = await r.exec(`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`);
    expect(identity).toMatchObject({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return work(r);
  });
  // Hono accepts partial bindings in test requests. This is only a typed service
  // construction boundary, NOT a production route/auth or Workers runtime test.
  // Query I/O is injected; the actual reconciliation state machine and SQL run.
  const service = async (r: Runtime, query: PaymentProviderQuery = async () => { throw Error('Unexpected provider query'); }) => {
    let instance: PaymentReconciliationService | undefined;
    const app = new Hono<{ Bindings: Env }>();
    app.get('/', c => { instance = new PaymentReconciliationService(createContainerFromDb(r.db), c.env, query); return c.body(null, 204); });
    expect((await app.request('/', {}, {})).status).toBe(204);
    if (!instance) throw Error('Service construction failed');
    return instance;
  };
  const seedOrder = (type: number, paid = 1) => f.db.insert(otherOrder).values({
    uid: 11, orderId: orderNo, type, paid, payPrice: '1.00', payType: type === 3 ? 'yue' : '',
  });
  const seedCase = async (domain: PaymentCallbackOrderDomain = 'membership', automated = false) => {
    const now = Math.floor(Date.now() / 1000);
    const [row] = await f.db.insert(paymentReconciliationCase).values({
      replayKey: crypto.randomUUID(), provider: 'wechat', profile: 'wechat', orderDomain: domain,
      orderNo, expectedAmountCents: 100, currency: 'CNY', status: automated ? 'OPEN' : 'CONFLICT',
      initiatedTime: now - 3600, addTime: now - 3600, retainUntil: now + 3600,
    }).returning();
    return row;
  };
  const decide = (s: PaymentReconciliationService, caseId: number, actionKey = crypto.randomUUID()) => s.decide({
    caseId, adminId: 1, actionKey, action: 'accept_local', reasonCode: 'reviewed_local_payment',
  });
  const state = () => f.query(`SELECT
    (SELECT coalesce(json_agg(o ORDER BY id),'[]') FROM other_order o) AS orders,
    (SELECT coalesce(json_agg(c ORDER BY id),'[]') FROM payment_reconciliation_case c) AS cases,
    (SELECT coalesce(json_agg(a ORDER BY id),'[]') FROM payment_reconciliation_action a) AS actions,
    (SELECT row_to_json(u) FROM "user" u WHERE uid=11) AS account,
    (SELECT count(*)::int FROM user_money) AS money,
    (SELECT count(*)::int FROM user_bill) AS bills`);

  it.each([2, 3, -1, 4])('rejects paid other_order type=%s as membership without any mutation', async type => {
    await seedOrder(type); const row = await seedCase(); const before = await state();
    await runtime(async r => { await expect(decide(await service(r), row.id)).rejects.toThrow(ValidateException); });
    expect(await state()).toEqual(before);
  });
  it.each([0, 1])('accepts paid membership type=%s once, retaining manual override semantics', async type => {
    await seedOrder(type); const row = await seedCase(); const key = crypto.randomUUID();
    const beforeOrder = await f.db.select().from(otherOrder), beforeUser = await f.db.select().from(user);
    await runtime(async r => {
      const s = await service(r);
      expect(await decide(s, row.id, key)).toEqual({ status: 'CONFIRMED', duplicate: false });
      expect(await decide(s, row.id, key)).toEqual({ status: 'CONFIRMED', duplicate: true });
    });
    expect(await f.db.select().from(otherOrder)).toEqual(beforeOrder);
    expect(await f.db.select().from(user)).toEqual(beforeUser);
    expect(await f.db.select().from(paymentReconciliationAction)).toEqual([expect.objectContaining({
      caseId: row.id, actionKey: key, actionType: 'ACCEPT_LOCAL', beforeStatus: 'CONFLICT', afterStatus: 'CONFIRMED',
    })]);
  });
  it.each([0, 1])('rejects unpaid membership type=%s without recording an action', async type => {
    await seedOrder(type, 0); const row = await seedCase(); const before = await state();
    await runtime(async r => { await expect(decide(await service(r), row.id)).rejects.toThrow(ValidateException); });
    expect(await state()).toEqual(before);
  });
  it.each([[0, 0], [0, 1], [0, 3], [3, 0]])('does not filter away duplicate order numbers with types %s/%s', async (first, second) => {
    await seedOrder(first); await seedOrder(second); const row = await seedCase(); const before = await state();
    await runtime(async r => { await expect(decide(await service(r), row.id)).rejects.toThrow(ValidateException); });
    expect(await state()).toEqual(before);
  });
  it('requires an explicitly resolved domain for manual acceptance', async () => {
    await seedOrder(0); const row = await seedCase(''); const before = await state();
    await runtime(async r => { await expect(decide(await service(r), row.id)).rejects.toThrow(ValidateException); });
    expect(await state()).toEqual(before);
  });
  it('rejects missing membership evidence', async () => {
    const row = await seedCase(); const before = await state();
    await runtime(async r => { await expect(decide(await service(r), row.id)).rejects.toThrow(ValidateException); });
    expect(await state()).toEqual(before);
  });
  it.each(['store_order', 'recharge'] as const)('preserves the existing %s manual acceptance path', async domain => {
    if (domain === 'store_order') await f.db.insert(storeOrder).values({ orderId: orderNo, uid: 11, paid: 1, payPrice: '1.00' });
    else await f.db.insert(userRecharge).values({ orderId: orderNo, uid: 11, paid: 1, price: '1.00' });
    const row = await seedCase(domain);
    await runtime(async r => { expect(await decide(await service(r), row.id)).toEqual({ status: 'CONFIRMED', duplicate: false }); });
  });
  for (const domain of ['membership', ''] as const) {
    it.each([0, 1, 2, 3])(`uses the same membership type boundary during active query (domain=${domain || 'unresolved'}, type=%s)`, async type => {
      await seedOrder(type); const row = await seedCase(domain, true);
      const query = vi.fn<PaymentProviderQuery>(async request => ({ status: 'PENDING', providerTradeState: 'NOTPAY',
        orderNo: request.orderNo, transactionId: '', amountCents: 0, currency: 'CNY', providerEventTime: 0, errorCode: '' }));
      const valid = type === 0 || type === 1;
      await runtime(async r => {
        const s = await service(r, query);
        expect(await s.processMessage({ action: 'processPaymentReconciliation', caseId: row.id, replayKey: row.replayKey }))
          .toBe(valid ? 'conflict' : 'waiting');
      });
      expect(query).toHaveBeenCalledOnce();
      const [current] = await f.db.select().from(paymentReconciliationCase);
      expect(current).toMatchObject({ status: valid ? 'CONFLICT' : 'WAITING', attemptCount: 1, leaseToken: '', leaseUntil: 0,
        lastErrorCode: valid ? 'local_paid_provider_not_success' : '' });
      expect(await f.db.select().from(paymentReconciliationAction)).toEqual([]);
      expect((await f.db.select().from(otherOrder))[0]).toMatchObject({ type, paid: 1 });
    });
  }
  it.each([2, 3])('does not settle unsupported type=%s after a successful provider query', async type => {
    await seedOrder(type); const row = await seedCase('membership', true);
    const query: PaymentProviderQuery = async request => ({ status: 'SUCCESS', providerTradeState: 'SUCCESS',
      orderNo: request.orderNo, transactionId: 'test-provider-transaction', amountCents: 100, currency: 'CNY',
      providerEventTime: Math.floor(Date.now() / 1000), errorCode: '' });
    const beforeOrder = await f.db.select().from(otherOrder), beforeUser = await f.db.select().from(user);
    await runtime(async r => {
      expect(await (await service(r, query)).processMessage({ action: 'processPaymentReconciliation', caseId: row.id, replayKey: row.replayKey }))
        .toBe('conflict');
    });
    expect((await f.db.select().from(paymentReconciliationCase))[0]).toMatchObject({ status: 'CONFLICT', lastErrorCode: 'order_missing' });
    expect(await f.db.select().from(otherOrder)).toEqual(beforeOrder); expect(await f.db.select().from(user)).toEqual(beforeUser);
  });
  it.each(['membership', ''] as const)('retains mixed-type ambiguity during active query (domain=%s)', async domain => {
    await seedOrder(0); await seedOrder(3); const row = await seedCase(domain, true);
    await runtime(async r => {
      const s = await service(r, async request => ({ status: 'PENDING', providerTradeState: 'NOTPAY',
        orderNo: request.orderNo, transactionId: '', amountCents: 0, currency: 'CNY', providerEventTime: 0, errorCode: '' }));
      expect(await s.processMessage({ action: 'processPaymentReconciliation', caseId: row.id, replayKey: row.replayKey })).toBe('waiting');
    });
    expect((await f.db.select().from(paymentReconciliationCase))[0]).toMatchObject({ status: 'WAITING', lastErrorCode: '' });
    expect(await f.db.select().from(paymentReconciliationAction)).toEqual([]);
  });
  it('commits the query claim before calling the provider adapter', async () => {
    await seedOrder(0, 0); const row = await seedCase('membership', true);
    await runtime(async r => {
      const s = await service(r, async request => {
        const { rows } = await f.query(`SELECT state,xact_start FROM pg_stat_activity WHERE pid=${r.pid}`);
        expect(rows).toEqual([expect.objectContaining({ state: 'idle', xact_start: null })]);
        expect((await f.db.select().from(paymentReconciliationCase))[0].status).toBe('QUERYING');
        return { status: 'PENDING', providerTradeState: 'NOTPAY', orderNo: request.orderNo,
          transactionId: '', amountCents: 0, currency: 'CNY', providerEventTime: 0, errorCode: '' };
      });
      expect(await s.processMessage({ action: 'processPaymentReconciliation', caseId: row.id, replayKey: row.replayKey })).toBe('waiting');
    });
  });
  it('does not wait backwards from a case lock to a locked membership order', async () => {
    await seedOrder(0); const row = await seedCase();
    await runtime(async r => f.withPeer!(async peer => {
      const s = await service(r);
      await peer.exec('BEGIN');
      let open = true;
      try {
        await peer.exec("UPDATE other_order SET type=3 WHERE order_id='membership-evidence-test'");
        await expect(Promise.race([decide(s, row.id),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(Error('ACCEPT_LOCAL waited on membership')), 3000))]))
          .rejects.toThrow('订单正在更新');
        await peer.exec('COMMIT');
        open = false;
        await expect(decide(s, row.id)).rejects.toThrow(ValidateException);
      } finally { if (open) await peer.exec('ROLLBACK'); }
    }));
    expect((await f.db.select().from(paymentReconciliationCase))[0].status).toBe('CONFLICT');
    expect(await f.db.select().from(paymentReconciliationAction)).toEqual([]);
  }, 15_000);
  it.each(['store_order', 'recharge'] as const)(
    'does not wait backwards from a case lock to a locked %s order', async domain => {
    if (domain === 'store_order') await f.db.insert(storeOrder).values({ orderId: orderNo, uid: 11, paid: 1, payPrice: '1.00' });
    else await f.db.insert(userRecharge).values({ orderId: orderNo, uid: 11, paid: 1, price: '1.00' });
    const row = await seedCase(domain), table = domain === 'store_order' ? 'store_order' : 'user_recharge';
    await runtime(async r => f.withPeer!(async peer => {
      const s = await service(r), key = crypto.randomUUID();
      await peer.exec('BEGIN');
      let open = true;
      try {
        await peer.exec(`UPDATE ${table} SET paid=paid WHERE order_id='membership-evidence-test'`);
        await expect(Promise.race([decide(s, row.id, key),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(Error('ACCEPT_LOCAL waited on order')), 3000))]))
          .rejects.toThrow('订单正在更新');
        expect(await f.db.select().from(paymentReconciliationAction)).toEqual([]);
        await peer.exec('COMMIT'); open = false;
        expect(await decide(s, row.id, key)).toEqual({ status: 'CONFIRMED', duplicate: false });
      } finally { if (open) await peer.exec('ROLLBACK'); }
    }));
  }, 15_000);
  it('rolls back the action and case together if action persistence is denied', async () => {
    await seedOrder(0); const row = await seedCase(); const before = await state();
    await runtime(async r => {
      await f.exec(`REVOKE INSERT ON payment_reconciliation_action FROM "${r.role}"`);
      await expect(decide(await service(r), row.id)).rejects.toThrow();
    });
    expect(await state()).toEqual(before);
  });
  it('rolls back an inserted action when the later case update is denied', async () => {
    await seedOrder(0); const row = await seedCase(); const before = await state();
    await runtime(async r => {
      await f.exec(`REVOKE UPDATE ON payment_reconciliation_case FROM "${r.role}";
        GRANT UPDATE(id) ON payment_reconciliation_case TO "${r.role}"`);
      await expect(decide(await service(r), row.id)).rejects.toThrow();
    });
    expect(await state()).toEqual(before);
  });
  it('does not give the reconciliation test role financial or order-payment write authority', async () => {
    await seedOrder(0); const before = await state();
    await runtime(async r => {
      await expect(r.exec('UPDATE other_order SET paid=0')).rejects.toMatchObject({ code: '42501' });
      await expect(r.exec('UPDATE "user" SET now_money=0 WHERE uid=11')).rejects.toMatchObject({ code: '42501' });
    });
    expect(await state()).toEqual(before);
  });
});
