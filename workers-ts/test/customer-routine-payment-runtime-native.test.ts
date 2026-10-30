import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../src/lib/di';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { paymentReconciliationAction, paymentReconciliationCase, storeOrder, user } from '../src/models/schema';
import { authorizeCustomerWorkActor } from '../src/services/customer-work/CustomerWorkScope';
import { financialRevisions } from '../src/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_VERSION } from '../src/services/customer-work/CustomerWorkFinancialProtocol';
import { PaymentReconciliationService } from '../src/services/payment/PaymentReconciliationService';
import { registerPaymentReconciliationTx } from '../src/services/payment/PaymentReconciliationRegistry';
import { runRoutinePaymentRuntimeInstallation } from '../src/migrations/routinePaymentRuntime';
import { customerWorkFinancialFixture } from './helpers/customerWorkFinancialFixture';
import { customerWorkWriteoffFixture } from './helpers/customerWorkWriteoffFixture';
import { customerCashierSecondCardFixture } from './helpers/customerCashierSecondCardFixture';
import { customerCashierOrdinaryFixture } from './helpers/customerCashierOrdinaryFixture';
import { supplierOfflinePaymentFixture } from './helpers/supplierOfflinePayment';
import { supplierOrderEditActor } from './helpers/supplierUnpaidOrderEdit';

/** Real business SQL and independent LOGINs on owned PG16. The exact raw
 * ledgers/grants come from the production installer, not test-only raw DDL.
 * No claim that these selected custom base profiles or deployment are fully
 * commissioned; the addon audit explicitly retains baseProfilesVerified=false.
 */
beforeAll(() => {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 is required');
});
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No real provider in routine runtime business fixture')); });
afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

const businessTables = ['store_order', 'store_order_cart_info', 'user', 'user_bill', 'user_brokerage',
  'supplier_flowing_water', 'supplier_transactions', 'store_order_outbox', 'store_order_status'] as const;
async function state(db: DbClient) {
  const rows: Record<string, unknown> = {};
  for (const table of businessTables) rows[table] = await db.execute(sql.raw(
    `SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`));
  return rows;
}
async function immutablePresence(db: DbClient, orderNo: string) {
  // Denial-only presence fixture. It is never accepted as a cryptographic
  // initiation, payer witness, actual provider result or historical authority.
  await db.execute(sql`INSERT INTO public.routine_payment_attempt(order_no,event_kind,payload,created_at,signature)
    VALUES(${orderNo},'INITIATION','{"fixture_presence_only":true}'::jsonb,1,${'a'.repeat(64)})`);
}
async function acl(db: DbClient) {
  const [row] = await db.execute(sql`SELECT current_user AS role,session_user AS session,
    has_table_privilege(current_user,'public.payment_reconciliation_case','UPDATE') AS direct_case_update,
    has_table_privilege(current_user,'public.routine_payment_attempt','SELECT') AS attempt_read,
    has_table_privilege(current_user,'public.routine_payment_attempt','INSERT,UPDATE,DELETE,TRUNCATE') AS attempt_write,
    has_table_privilege(current_user,'public.routine_identity_witness','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS witness,
    has_table_privilege(current_user,'public.payment_reconciliation_action','SELECT') AS action_read,
    to_regprocedure('public.local_payment_case_lock_v1(text)') IS NULL AS no_extra_definer`);
  return row;
}

describe.sequential('customer financial actual installer binding and guarded offline settlement', () => {
  let f: Awaited<ReturnType<typeof customerWorkFinancialFixture>>, sequence = 0;
  beforeAll(async () => {
    f = await customerWorkFinancialFixture();
    // This focused base fixture defers these indexes until realPurchase().
    // The real reconciliation registrar needs its canonical ON CONFLICT key.
    const migration = await import('drizzle-kit/api');
    const statements = await migration.generateMigration(migration.generateDrizzleJson({}),
      migration.generateDrizzleJson({ paymentReconciliationCase, paymentReconciliationAction }));
    for (const statement of statements) if (/^CREATE (?:UNIQUE )?INDEX/.test(statement.trim())) await f.exec(statement);
  }, 180000);
  beforeEach(async () => {
    await f.maintenanceDb.delete(paymentReconciliationAction);
    await f.maintenanceDb.delete(paymentReconciliationCase);
    await f.reset();
    await f.maintenanceDb.update(storeOrder).set({ paid: 0, orderId: 'routine-financial-' + (++sequence) }).where(eq(storeOrder.id, 1));
  });
  afterAll(async () => { await f?.close(); }, 30000);
  async function input() {
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 1));
    const scope = await authorizeCustomerWorkActor(f.db, f.actor()), revisions = await financialRevisions(f.db, order);
    return { version: CUSTOMER_FINANCIAL_VERSION, scope_key: scope.scope_key, order_id: 1,
      expected_order_revision: revisions.order_revision, expected_financial_revision: revisions.financial_revision, payload: {} };
  }
  const context = () => ({ actor: f.actor(), request_key: randomUUID() });

  it('audits the actual local LOGIN with separate companions and retains approved direct case locking', async () => {
    const target = f.routineRuntime.target;
    expect(target.local).toEqual([f.role]); expect(new Set([target.app, target.admin, f.role]).size).toBe(3);
    expect(f.routineRuntime.fullCustomProfileVerified).toBe(false);
    expect(await f.routineRuntime.auditLocal(f.db)).toMatchObject({ ready: true, realLogin: true, baseProfilesVerified: false });
    expect(await acl(f.db)).toEqual({ role: f.role, session: f.role, direct_case_update: true, attempt_read: true,
      attempt_write: false, witness: false, action_read: true, no_extra_definer: true });
    await expect(f.db.execute(sql`INSERT INTO public.routine_payment_attempt VALUES('forbidden_local','INITIATION','{}',1,${'b'.repeat(64)})`))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });
  it('settles through the actual financial service and replays the exact original receipt without another effect', async () => {
    const body = await input(), ctx = context(), service = f.service();
    const result = await service.offline(ctx, body);
    expect(result.receipt).toMatchObject({ kind: 'confirm_offline', outcome: 'offline-paid', actor_uid: 101 });
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, 1)))[0]).toMatchObject({ paid: 1, payType: 'offline' });
    const after = await state(f.db);
    expect(await service.offline(ctx, body)).toMatchObject({ receipt: result.receipt, replayed: true });
    expect(await state(f.db)).toEqual(after);
    const events = await f.db.execute(sql`SELECT id,event_key FROM public.store_order_outbox`);
    expect(events).toHaveLength(1); expect(events[0].id).toBe(result.receipt!.evidence.outbox_id);
  });
  it.each(['initiated', 'retry-action', 'immutable-after-case-delete'] as const)(
    'preserves all money and paid-event facts when actual %s history refuses new offline settlement', async history => {
      const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 1));
      const candidate = await withTx(createContainerFromDb(f.maintenanceDb), tx => registerPaymentReconciliationTx(tx, {
        provider: 'wechat', profile: 'routine', orderDomain: 'store_order', orderNo: order.orderId,
        expectedAmountCents: 1000, initiated: history === 'initiated' }));
      if (history === 'retry-action') {
        await f.maintenanceDb.update(paymentReconciliationCase).set({ status: 'UNKNOWN' }).where(eq(paymentReconciliationCase.id, candidate.id));
        await new PaymentReconciliationService(createContainerFromDb(f.maintenanceDb), f.env).decide({
          caseId: candidate.id, adminId: 91, actionKey: randomUUID(), action: 'retry', reasonCode: 'runtime_fixture_retry' });
        expect(await f.maintenanceDb.select().from(paymentReconciliationAction)).toMatchObject([{ actionType: 'RETRY', afterStatus: 'OPEN' }]);
      } else if (history === 'immutable-after-case-delete') {
        await immutablePresence(f.maintenanceDb, order.orderId);
        await f.maintenanceDb.delete(paymentReconciliationCase).where(eq(paymentReconciliationCase.id, candidate.id));
      }
      const before = await state(f.db), result = await f.service().offline(context(), await input());
      expect(result.receipt?.outcome).toBe('rollback-rejected');
      expect(await state(f.db)).toEqual(before);
      expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, 1)))[0].paid).toBe(0);
    });
  it('replays the original exact installer binding without rewriting retained immutable rows', async () => {
    await immutablePresence(f.maintenanceDb, 'retained_runtime_row');
    const before = await f.db.execute(sql`SELECT * FROM public.routine_payment_attempt ORDER BY order_no,event_kind`);
    expect(await f.routineRuntime.replayInstallation()).toMatchObject({ applied: false, after: { ready: true } });
    expect(await f.db.execute(sql`SELECT * FROM public.routine_payment_attempt ORDER BY order_no,event_kind`)).toEqual(before);
  });
  it('does not infer an additional temporary local LOGIN or expand installed ledger ACLs', async () => {
    const role = 'routine_unbound_' + randomUUID().replaceAll('-', '');
    await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    try {
      const before = await f.maintenanceDb.execute(sql`SELECT relname,relacl::text FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relname IN('routine_identity_witness','routine_payment_attempt') ORDER BY relname`);
      await expect(runRoutinePaymentRuntimeInstallation(f.maintenanceDb, { ...f.routineRuntime.target, local: [f.role, role] }))
        .rejects.toThrow('partial grants');
      expect(await f.maintenanceDb.execute(sql`SELECT relname,relacl::text FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relname IN('routine_identity_witness','routine_payment_attempt') ORDER BY relname`)).toEqual(before);
    } finally { await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); }
  });
});

describe.sequential('inherited cashier runtime binding with actual cash consumer', () => {
  let f: Awaited<ReturnType<typeof customerCashierSecondCardFixture>>;
  beforeAll(async () => { f = await customerCashierSecondCardFixture(); }, 180000);
  afterAll(async () => { await f?.close(); }, 30000);
  it.each(['7.00', '0.00'])('preserves real cash/zero payment and its original paid consumer at %s', async price => {
    await f.reset(price); const { order } = await f.create(), result = await f.cash(order);
    expect(result.replayed).toBe(false); expect(result.outbox).not.toBeNull();
    expect(await f.processPaid(result.outbox!)).toBe('completed');
    expect((await f.actual(order.id)).order).toMatchObject({ paid: 1, payType: 'cash' });
    expect(await f.routineRuntime.auditLocal(f.db)).toMatchObject({ ready: true, baseProfilesVerified: false });
  });
  it('refuses immutable initiation presence after mutable cases disappear before cashier cash', async () => {
    await f.reset(); const { order } = await f.create(); await immutablePresence(f.maintenanceDb, order.orderId);
    const before = await state(f.db);
    await expect(f.cash(order)).rejects.toThrow('外部支付已发起');
    expect(await state(f.db)).toEqual(before);
    expect(await f.db.execute(sql`SELECT * FROM public.cashier_second_card_payment_v1`)).toHaveLength(0);
  });
});

describe.sequential('writeoff descendant reuses the same installed local principal', () => {
  let f: Awaited<ReturnType<typeof customerWorkWriteoffFixture>>;
  beforeAll(async () => { f = await customerWorkWriteoffFixture(); }, 180000);
  beforeEach(async () => { await f.reset(); });
  afterAll(async () => { await f?.close(); }, 30000);
  it('executes genuine balance checkout through the inherited approved case writer', async () => {
    const order = await f.ordinary(); expect(order).toMatchObject({ paid: 1, payType: 'yue' });
    expect(f.routineRuntime.target.local).toEqual([f.role]);
    expect(await f.routineRuntime.auditLocal(f.db)).toMatchObject({ ready: true });
  });
  it('executes its actual cashier and paid consumer without another raw-ledger installation', async () => {
    const result = await f.cashier(); expect(result.order).toMatchObject({ paid: 1, payType: 'cash' });
    expect(await f.routineRuntime.replayInstallation()).toMatchObject({ applied: false });
    expect(f.routineRuntime.fullCustomProfileVerified).toBe(false);
  });
});

describe.sequential('ordinary cashier descendant keeps the installed direct-lock writer', () => {
  let f: Awaited<ReturnType<typeof customerCashierOrdinaryFixture>>;
  beforeAll(async () => { f = await customerCashierOrdinaryFixture(); }, 180000);
  beforeEach(async () => { await f.reset(); });
  afterAll(async () => { await f?.close(); }, 30000);
  it('executes actual ordinary draft, quote, checkout, cash and the paid consumer', async () => {
    const { order } = await f.create(), paid = await f.cash(order);
    expect(paid.receipt.evidence.outcome).toBe('cash-paid');
    expect(await f.processPaid(order.id)).toBe('completed');
    expect((await f.actual(order.id)).order).toMatchObject({ paid: 1, payType: 'cash' });
    expect(await f.routineRuntime.auditLocal(f.db)).toMatchObject({ ready: true, baseProfilesVerified: false });
  });
  it('keeps the complete ordinary checkout facts unchanged when immutable initiation blocks cash', async () => {
    const { order } = await f.create(); await immutablePresence(f.maintenanceDb, order.orderId);
    const before = await state(f.db);
    await expect(f.cash(order)).rejects.toThrow('外部支付已发起');
    expect(await state(f.db)).toEqual(before);
  });
});

describe.sequential('supplier stable existing writer uses the production addon installer', () => {
  let f: Awaited<ReturnType<typeof supplierOfflinePaymentFixture>>, order: typeof storeOrder.$inferSelect;
  beforeEach(async () => { f = await supplierOfflinePaymentFixture(); order = await f.createOffline(); }, 60000);
  afterEach(async () => { await f?.close(); }, 30000);
  it('reuses one real local LOGIN instead of incrementally expanding ledger ACLs', async () => {
    const first = await f.withPaymentRuntime(async runtime => runtime.role);
    const second = await f.withPaymentRuntime(async runtime => {
      expect(await acl(runtime.db)).toMatchObject({ direct_case_update: true, attempt_read: true, attempt_write: false, witness: false });
      expect(await f.routineRuntime.auditLocal(runtime.db)).toMatchObject({ ready: true, realLogin: true, baseProfilesVerified: false });
      return runtime.role;
    });
    expect(first).toBe(second); expect(f.routineRuntime.target.local).toEqual([first]);
    expect(first).not.toBe(f.routineRuntime.target.app); expect(first).not.toBe(f.routineRuntime.target.admin);
    await f.withPaymentRuntime(async outer => {
      await outer.db.transaction(async tx => {
        await tx.select().from(storeOrder).where(eq(storeOrder.id, order.id)).for('update');
        await f.withPaymentRuntime(async inner => {
          expect(inner.role).toBe(outer.role); expect(inner.pid).not.toBe(outer.pid);
          await expect(inner.db.transaction(peer => peer.select().from(storeOrder)
            .where(eq(storeOrder.id, order.id)).for('update', { noWait: true })))
            .rejects.toMatchObject({ cause: { code: '55P03' } });
        });
      });
    });
  });
  it('commits Supplier cash, replays its original receipt and runs the independent paid consumer', async () => {
    const [buyer] = await f.db.select().from(user).where(eq(user.uid, order.uid));
    await f.withPaymentRuntime(async (_runtime, payment) => {
      const body = await f.paymentBody(order.id, payment), result = await payment.pay(order.id, body, supplierOrderEditActor());
      expect(result).toMatchObject({ state: 'committed', result: { paid: 1, pay_type: 'offline' } });
      const after = await f.paymentState();
      expect(await payment.pay(order.id, body, supplierOrderEditActor())).toEqual(result);
      expect(await f.paymentState()).toEqual(after);
    });
    await f.consumePaid(order.id);
    expect((await f.db.select().from(user).where(eq(user.uid, order.uid)))[0].nowMoney).toBe(buyer.nowMoney);
    expect((await f.editState(order.id)).order).toMatchObject({ paid: 1, payType: 'offline' });
  });
  it('refuses immutable prior initiation through the real Supplier request without money or receipt mutation', async () => {
    await f.withPaymentRuntime(async (_runtime, payment) => {
      const body = await f.paymentBody(order.id, payment); await immutablePresence(f.db, order.orderId);
      const before = await f.paymentState();
      await expect(payment.pay(order.id, body, supplierOrderEditActor())).rejects.toThrow('外部支付已发起');
      expect(await f.paymentState()).toEqual(before);
    });
  });
});
