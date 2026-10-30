import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { createContainerFromDb, createDbFromConnectionString, withTx, type DbClient } from '../src/lib/di';
import { paymentReconciliationAction, storeOrder, storeOrderOutbox, storeOrderStatus, systemConfig, systemStoreStaff, user } from '../src/models/schema';
import { MANAGER_RUNTIME_ROLE } from '../src/migrations/managerRuntimePrivilegePlan';
import { auditManagerRuntimePrivileges, inspectManagerRuntimePrivileges } from '../src/migrations/auditManagerRuntimePrivileges';
import { provisionManagerRuntime } from '../src/migrations/provisionManagerRuntime';
import { inspectRoutinePaymentRuntime, runRoutinePaymentRuntimeInstallation, type RoutinePaymentRuntimeTarget } from '../src/migrations/routinePaymentRuntime';
import { inspectLocalPaymentCaseLock } from '../src/migrations/localPaymentCaseLock';
import { installManagerRoutinePaymentInTransaction, managerRoutinePaymentSuccessor, runManagerRoutinePaymentForward, type ManagerRoutinePaymentForward } from '../src/migrations/managerRoutinePaymentRuntime';
import { StoreManagerFinancialService } from '../src/services/store/StoreManagerFinancialService';
import { MANAGER_OPERATION_VERSION } from '../src/services/store/ManagerOrderOperationRequest';
import { merchantOrderRevision, requireStoreManagerScope } from '../src/services/store/StoreManagerScope';
import { registerPaymentReconciliationTx } from '../src/services/payment/PaymentReconciliationRegistry';
import { md5 } from '../src/utils/jwt';
import { managerRuntimePrivilegeFixture } from './helpers/managerRuntimePrivilegeFixture';
import { validateFinanceFixtureUrl } from './helpers/financePostgres';

describe.sequential('complete fixed Manager profile with explicit Mini payment forward on owned PG16', () => {
  let f: Awaited<ReturnType<typeof managerRuntimePrivilegeFixture>>, manager: DbClient;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const owners: string[] = [];
  const actor = () => ({ uid: 33, authVersion: md5('manager-owned-fixture'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const env = { APP_KEY: 'manager-routine-owned-fixture' } as Env;
  beforeEach(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider calls in local commissioning'));
    f = await managerRuntimePrivilegeFixture();
    const password = Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');
    await provisionManagerRuntime(f.db, password, { database: f.database, maintenanceRole: 'finance_test' });
    await f.markManagerRoleOwned();
    const url = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
    url.pathname = '/' + f.database; url.username = MANAGER_RUNTIME_ROLE; url.password = password;
    manager = createDbFromConnectionString(url.href, 1);
    expect(await auditManagerRuntimePrivileges(manager)).toMatchObject({ ready: true, failures: [] });
    await f.db.insert(user).values([{ uid: 11, account: 'owned-buyer', nowMoney: '100.00', integral: 20 },
      { uid: 33, account: 'owned-manager', pwd: 'manager-owned-fixture', status: 1 }]);
    // The fixed manager base also supports the canonical pre-city-delivery
    // schema. ORM inserts enumerate optional addon columns even when omitted.
    await f.db.execute(sql`INSERT INTO public.system_store(id,name,is_store,is_show,is_del) VALUES(9,'Owned manager store',1,1,0)`);
    await f.db.insert(systemStoreStaff).values({ id: 9, storeId: 9, uid: 33, status: 1, isManager: 1, orderStatus: 1 });
    await f.db.insert(systemConfig).values({ menuName: 'offline_pay_status', value: '1' });
  }, 180000);
  afterEach(async () => {
    try { expect(network).not.toHaveBeenCalled(); }
    finally {
      vi.restoreAllMocks();
      await manager?.$client.end({ timeout: 2 });
      for (const owner of owners.splice(0)) await f.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`);
      await f?.close();
    }
  }, 30000);
  const withBinding = async (work: (input: ManagerRoutinePaymentForward, target: RoutinePaymentRuntimeTarget) => Promise<void>, existingCap = false) => {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const owner = 'manager_case_' + randomUUID().replaceAll('-', '');
      await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      owners.push(owner);
      const prior = { database: f.database, maintenance: 'finance_test', app: app.role, admin: admin.role };
      const run = async (previous: RoutinePaymentRuntimeTarget) => {
        await runRoutinePaymentRuntimeInstallation(f.db, previous);
        const input = { previous, caseLockOwner: owner };
        await work(input, managerRoutinePaymentSuccessor(input));
      };
      if (existingCap) await f.withRuntimeRole!(async local => {
        await f.exec(`GRANT SELECT ON public.payment_reconciliation_case TO "${local.role}"`);
        await run({ ...prior, local: [local.role], caseLock: { owner, runtimeRoles: [local.role] } });
      });
      else await run(prior);
    }));
  };
  const newOrder = async (suffix: string) => {
    const [order] = await f.db.insert(storeOrder).values({ orderId: 'mgr_' + suffix, unique: suffix, uid: 11, storeId: 9,
      payPrice: '10.00', totalPrice: '10.00', totalNum: 1, type: 0, pid: 0 }).returning();
    return order;
  };
  const inputFor = async (id: number) => {
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, id));
    const scope = await requireStoreManagerScope(f.db, 33, 9);
    return { version: MANAGER_OPERATION_VERSION, store_id: 9, scope_key: scope.scope_key, order_id: id,
      expected_order_revision: await merchantOrderRevision(order), payload: {} };
  };
  const business = async () => ({
    users: await f.db.select().from(user).orderBy(user.uid), orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
    outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id), statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
  });
  const receipts = () => f.db.execute(sql`SELECT actor_uid,request_key,kind,outcome,evidence FROM public.manager_order_operation_request ORDER BY request_key`);
  const acl = () => f.db.execute(sql`SELECT c.relname,c.relacl::text,ARRAY(SELECT attacl::text FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 ORDER BY attnum) AS columns
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.relname`);

  it('audits the full fixed LOGIN, commits a real offline receipt and recovers it after manager withdrawal', async () => {
    await withBinding(async (forward, target) => {
      expect((await auditManagerRuntimePrivileges(manager)).failures).toContain('manager_routine_payment_unbound');
      await expect(runRoutinePaymentRuntimeInstallation(f.db, target)).rejects.toThrow('partial grants');
      const [credential] = await f.db.execute(sql`SELECT oid::text AS oid,rolpassword AS password FROM pg_authid WHERE rolname=${MANAGER_RUNTIME_ROLE}`);
      const legacy = await newOrder('preserved_legacy');
      await f.db.update(storeOrder).set({ paid: 1, payType: 'offline', payTime: 123 }).where(eq(storeOrder.id, legacy.id));
      await f.db.execute(sql`INSERT INTO public.routine_payment_attempt VALUES(${legacy.orderId},'INITIATION','{"old_fixture_presence_only":true}',1,${'b'.repeat(64)})`);
      const historicalAttempts = await f.db.execute(sql`SELECT * FROM public.routine_payment_attempt ORDER BY order_no,event_kind`);
      const before = await business();
      expect(await runManagerRoutinePaymentForward(f.db, forward)).toMatchObject({ applied: true, audit: { ready: true, profileReady: true }, historicalRowsReassigned: false });
      expect(await business()).toEqual(before);
      expect(await f.db.execute(sql`SELECT * FROM public.routine_payment_attempt ORDER BY order_no,event_kind`)).toEqual(historicalAttempts);
      expect(await auditManagerRuntimePrivileges(manager, target)).toMatchObject({ ready: true, failures: [], completeServiceCoverageVerified: false });
      expect((await f.db.execute(sql`SELECT oid::text AS oid,rolpassword AS password FROM pg_authid WHERE rolname=${MANAGER_RUNTIME_ROLE}`))[0]).toEqual(credential);
      expect(await runManagerRoutinePaymentForward(f.db, forward)).toMatchObject({ applied: false });
      const [rights] = await manager.execute(sql`SELECT current_user AS role,session_user AS session,
        has_any_column_privilege(current_user,'public.payment_reconciliation_case','UPDATE') AS case_update,
        has_table_privilege(current_user,'public.routine_payment_attempt','INSERT') AS attempt_insert,
        has_table_privilege(current_user,'public.routine_identity_witness','SELECT,INSERT') AS witness,
        has_function_privilege(current_user,'public.local_payment_case_lock_v1(text)','EXECUTE') AS case_lock`);
      expect(rights).toEqual({ role: MANAGER_RUNTIME_ROLE, session: MANAGER_RUNTIME_ROLE, case_update: false, attempt_insert: false, witness: false, case_lock: true });
      for (const statement of ['UPDATE public.payment_reconciliation_case SET id=id', 'INSERT INTO public.routine_payment_attempt DEFAULT VALUES',
        'SELECT * FROM public.routine_identity_witness', 'INSERT INTO public.payment_reconciliation_action DEFAULT VALUES'])
        await expect(manager.execute(sql.raw(statement))).rejects.toMatchObject({ cause: { code: '42501' } });
      const order = await newOrder('clean');
      await withTx(createContainerFromDb(f.db), tx => registerPaymentReconciliationTx(tx, { provider: 'alipay', profile: 'alipay',
        orderDomain: 'store_order', orderNo: order.orderId, expectedAmountCents: 1000 }));
      const service = new StoreManagerFinancialService(createContainerFromDb(manager), env);
      const body = await inputFor(order.id), context = { actor: actor(), request_key: randomUUID() };
      const result = await service.offline(context, body);
      expect(result).toMatchObject({ replayed: false, receipt: { kind: 'confirm_offline', outcome: 'offline-paid' } });
      expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0]).toMatchObject({ paid: 1, payType: 'offline', tradeNo: '' });
      expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
      expect((await f.db.select().from(storeOrderStatus)).filter(row => row.changeType === 'manager_order_offline')).toHaveLength(1);
      expect((await business()).users).toEqual(before.users);
      await f.db.update(systemStoreStaff).set({ isManager: 0 }).where(eq(systemStoreStaff.id, 9));
      const paidState = await business(), paidReceipts = await receipts();
      expect(await service.offline(context, body)).toEqual({ receipt: result.receipt, replayed: true });
      expect(await service.receipt(actor(), context.request_key)).toEqual(result.receipt);
      expect(await business()).toEqual(paidState); expect(await receipts()).toEqual(paidReceipts);
      expect(await auditManagerRuntimePrivileges(manager, target)).toMatchObject({ ready: true });
    });
  }, 60000);

  it.each(['attempt', 'retry', 'missing-capability'] as const)('refuses %s without paid/funds/outbox/audit writes under the actual fixed LOGIN', async reason => {
    await withBinding(async (forward, target) => {
      await runManagerRoutinePaymentForward(f.db, forward);
      const order = await newOrder(reason);
      const candidate = await withTx(createContainerFromDb(f.db), tx => registerPaymentReconciliationTx(tx, { provider: 'alipay', profile: 'alipay',
        orderDomain: 'store_order', orderNo: order.orderId, expectedAmountCents: 1000 }));
      if (reason === 'attempt') await f.db.execute(sql`INSERT INTO public.routine_payment_attempt VALUES(${order.orderId},'INITIATION','{"fixture_presence_only":true}',1,${'a'.repeat(64)})`);
      if (reason === 'retry') await f.db.insert(paymentReconciliationAction).values({ caseId: candidate.id, actionKey: randomUUID(), adminId: 1,
        actionType: 'RETRY', reasonCode: 'owned_manager_retry', beforeStatus: 'UNKNOWN', afterStatus: 'OPEN' });
      if (reason === 'missing-capability') await f.exec(`REVOKE EXECUTE ON FUNCTION public.local_payment_case_lock_v1(text) FROM "${MANAGER_RUNTIME_ROLE}"`);
      const before = await business(), service = new StoreManagerFinancialService(createContainerFromDb(manager), env);
      const body = await inputFor(order.id), context = { actor: actor(), request_key: randomUUID() };
      if (reason === 'missing-capability') {
        await expect(service.offline(context, body)).rejects.toThrow('权限未完整验收');
        expect(await receipts()).toEqual([]);
        expect((await auditManagerRuntimePrivileges(manager, target)).ready).toBe(false);
      } else {
        const result = await service.offline(context, body);
        expect(result).toMatchObject({ receipt: { outcome: 'rollback-rejected' }, replayed: false });
        expect(await service.offline(context, body)).toEqual({ receipt: result.receipt, replayed: true });
        expect(await receipts()).toHaveLength(1);
      }
      expect(await business()).toEqual(before);
    });
  }, 60000);

  it('extends an exact existing capability without replacing its body, owner or prior grantee', async () => {
    await withBinding(async (forward, target) => {
      const cap = await inspectLocalPaymentCaseLock(f.db);
      expect(cap.grantees).toEqual(forward.previous.caseLock!.runtimeRoles);
      expect(await runManagerRoutinePaymentForward(f.db, forward)).toMatchObject({ applied: true });
      expect(await inspectLocalPaymentCaseLock(f.db)).toMatchObject({ ready: true, functionOid: cap.functionOid, ownerOid: cap.ownerOid, grantees: target.caseLock!.runtimeRoles });
      expect(await auditManagerRuntimePrivileges(manager, target)).toMatchObject({ ready: true });
    }, true);
  }, 60000);

  it('rolls back the whole forward with its caller and retains tighter transaction timeouts', async () => {
    await withBinding(async (forward, target) => {
      const before = await acl();
      await expect(f.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout='4500ms'; SET LOCAL lock_timeout='700ms'; SET LOCAL idle_in_transaction_session_timeout='4500ms'`);
        await installManagerRoutinePaymentInTransaction(tx, forward);
        const [caps] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
        expect(caps).toEqual({ statement: '4500ms', lock: '700ms', idle: '4500ms' });
        throw Error('caller rollback');
      }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toThrow('caller rollback');
      expect(await acl()).toEqual(before);
      expect((await inspectLocalPaymentCaseLock(f.db)).absent).toBe(true);
      expect((await inspectRoutinePaymentRuntime(f.db, forward.previous)).ready).toBe(true);
      expect((await inspectManagerRuntimePrivileges(f.db, { requireLogin: true, routine: { target: forward.previous, stage: 'before-manager' } }))).toMatchObject({ ready: false, profileReady: true });
      expect((await auditManagerRuntimePrivileges(manager, target)).ready).toBe(false);
    });
  }, 60000);

  it.each(['manager-case-update', 'manager-attempt-insert', 'prior-app-update'] as const)('refuses %s drift without repairing grants or changing credentials', async drift => {
    await withBinding(async forward => {
      if (drift === 'manager-case-update') await f.exec(`GRANT UPDATE(id) ON public.payment_reconciliation_case TO "${MANAGER_RUNTIME_ROLE}"`);
      if (drift === 'manager-attempt-insert') await f.exec(`GRANT INSERT ON public.routine_payment_attempt TO "${MANAGER_RUNTIME_ROLE}"`);
      if (drift === 'prior-app-update') await f.exec(`GRANT UPDATE ON public.routine_payment_attempt TO "${forward.previous.app}"`);
      const before = await acl(), state = await business();
      await expect(runManagerRoutinePaymentForward(f.db, forward)).rejects.toThrow(/refused|requires/);
      expect(await acl()).toEqual(before); expect(await business()).toEqual(state);
      expect((await inspectLocalPaymentCaseLock(f.db)).absent).toBe(true);
    });
  }, 60000);

  it('binds maintenance DB, transaction, actual LOGIN and canonical gates before mutations', async () => {
    await withBinding(async (forward, target) => {
      const before = await acl();
      await expect(installManagerRoutinePaymentInTransaction(f.db, forward)).rejects.toThrow('caller-owned');
      await expect(runManagerRoutinePaymentForward(f.db, { ...forward, previous: { ...forward.previous, database: 'wrong_database' } })).rejects.toThrow('target refused');
      await expect(runManagerRoutinePaymentForward(manager, forward)).rejects.toThrow('target refused');
      await expect(f.db.transaction(tx => installManagerRoutinePaymentInTransaction(tx, forward), { isolationLevel: 'repeatable read' })).rejects.toThrow('target refused');
      await f.withPeer!(async peer => {
        await peer.db.transaction(async tx => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(731670,0)`);
          await expect(runManagerRoutinePaymentForward(f.db, forward)).rejects.toThrow('busy');
        });
      });
      expect(await acl()).toEqual(before);
      expect((await auditManagerRuntimePrivileges(f.db, target)).ready).toBe(false);
    });
  }, 60000);
});
