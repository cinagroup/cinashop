import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { createContainerFromDb, createCustomerFinancialDatabaseSession, withTx, type DbClient } from '../src/lib/di';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE, CUSTOMER_FINANCIAL_RUNTIME_CONNECTION_LIMIT,
  customerFinancialRuntimePrivilegePlan } from '../src/migrations/customerFinancialRuntimePlan';
import { auditCustomerFinancialRuntimePrivileges, inspectCustomerFinancialRuntimeCatalogPrerequisites,
  inspectCustomerFinancialRuntimePrivileges } from '../src/migrations/auditCustomerFinancialRuntimePrivileges';
import { CUSTOMER_FINANCIAL_PROVISION_GATE, provisionCustomerFinancialRuntime,
  provisionCustomerFinancialRuntimeInTransaction } from '../src/migrations/provisionCustomerFinancialRuntime';
import { inspectRoutinePaymentRuntime } from '../src/migrations/routinePaymentRuntime';
import { inspectCustomerUserCatalogLock } from '../src/migrations/runCustomerUserCatalogLock';
import { auditCheckoutPricingLockRuntime } from '../src/migrations/checkoutPricingLock';
import { pricingIdentifier } from '../src/migrations/checkoutPricingLockCatalog';
import { paymentReconciliationAction, paymentReconciliationCase, storeOrder, storeOrderOutbox, storeOrderStatus, storeService } from '../src/models/schema';
import { PaymentReconciliationService } from '../src/services/payment/PaymentReconciliationService';
import { registerPaymentReconciliationTx } from '../src/services/payment/PaymentReconciliationRegistry';
import { amountToCents } from '../src/services/payment/RefundGateway';
import { CustomerWorkFinancialReadService } from '../src/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_VERSION, type FinancialInput, type FinancialReceipt } from '../src/services/customer-work/CustomerWorkFinancialProtocol';
import { customerFinancialRuntimeFixture, customerFinancialCredential } from './helpers/customerFinancialRuntimeFixture';

// One full canonical owned PG16 fixture, actual production installers, real
// fixed LOGINs, real JWT -> middleware -> production route/controller -> SQL.
// No SQL/catalog/provider result is mocked; historical INIT presence is only
// denial evidence and cannot prove a provider call or old-payment ownership.
describe.sequential('complete fixed Customer financial profile and production routes on owned PG16', () => {
  let f: Awaited<ReturnType<typeof customerFinancialRuntimeFixture>>, runtime: DbClient;
  beforeAll(async () => { f = await customerFinancialRuntimeFixture(); }, 180000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No real provider HTTP in Customer runtime fixture')); });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  const absent = async () => expect(await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${CUSTOMER_FINANCIAL_RUNTIME_ROLE}`)).toEqual([]);
  const audit = () => auditCustomerFinancialRuntimePrivileges(runtime, f.target);
  const noRequestBackends = async () => {
    const [row] = await f.db.execute(sql`SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname=${f.database} AND application_name='cinashop_customer_financial'`);
    expect(row.count).toBe(0);
  };
  const financialInput = async (order: typeof storeOrder.$inferSelect): Promise<FinancialInput> => {
    const response = await f.request('/mobile/work/financial/orders/' + order.id + '?order_no=' + order.orderId);
    expect(response.response.status).toBe(200); expect(response.body.status, response.body.msg).toBe(200);
    const envelope = response.body.data as Awaited<ReturnType<CustomerWorkFinancialReadService['order']>>;
    expect(envelope.data).toMatchObject({ order_id: order.id, order_no: order.orderId, paid: 0, readiness: { writes: true }, actions: { confirm_offline: { available: true } } });
    await noRequestBackends();
    return { version: CUSTOMER_FINANCIAL_VERSION, scope_key: envelope.scope_key, order_id: order.id,
      expected_order_revision: envelope.data.order_revision, expected_financial_revision: envelope.data.financial_revision, payload: {} };
  };
  const roleCredential = async () => (await f.db.execute(sql`SELECT oid::text AS oid,rolpassword AS hash FROM pg_authid
    WHERE rolname=${CUSTOMER_FINANCIAL_RUNTIME_ROLE}`))[0];
  const ledger = () => f.db.execute(sql`SELECT actor_uid,request_key,kind,outcome,evidence FROM public.customer_financial_operation_request ORDER BY actor_uid,request_key`);
  const pricing = async (phase: string) => {
    const [identity] = await runtime.execute(sql`SELECT current_user AS role,session_user AS session,
      pg_backend_pid() AS pid,current_setting('server_version_num') AS version,
      (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend`);
    expect(identity).toMatchObject({ role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, session: CUSTOMER_FINANCIAL_RUNTIME_ROLE,
      backend: CUSTOMER_FINANCIAL_RUNTIME_ROLE });
    expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
    const result = await auditCheckoutPricingLockRuntime(runtime, 'public', 'customer-work');
    console.log('CUSTOMER_FINANCIAL_RUNTIME_PRICING ' + JSON.stringify({ phase, identity, result }));
    return result;
  };

  it('has the whole fixed source profile and actual independent App/Admin previous binding before any Customer role exists', async () => {
    await absent();
    const catalogs = await inspectCustomerFinancialRuntimeCatalogPrerequisites(f.db, 'finance_test');
    expect(catalogs).toMatchObject({ ready: true, failures: [] }); expect(catalogs.requiredTableCount).toBeGreaterThan(200);
    expect(await inspectRoutinePaymentRuntime(f.db, f.previous)).toMatchObject({ ready: true });
    const [app] = await f.app.db.execute(sql`SELECT current_user AS role,session_user AS session,
      has_table_privilege(current_user,'public.customer_financial_operation_request','SELECT,INSERT') AS financial`);
    const [admin] = await f.admin.db.execute(sql`SELECT current_user AS role,session_user AS session`);
    expect(app).toEqual({ role: f.previous.app, session: f.previous.app, financial: false });
    expect(admin).toEqual({ role: f.previous.admin, session: f.previous.admin }); expect(app.role).not.toBe(admin.role);
  });

  it('keeps the strict NOLOGIN user capability ready beside the actual current-session temp namespace', async () => {
    const context = f.userCatalogContext;
    expect(context.context.temp_oid).not.toBe('0'); expect(context.context.temp_schema).toMatch(/^pg_temp_[0-9]+$/u);
    expect(context.schema_authority).toEqual([{ oid: context.context.temp_oid, schema: context.context.temp_schema,
      owner: 'finance_bootstrap', owns: false, create: true, usage: true, current_temp: true }]);
    const [actual] = await f.db.execute(sql`SELECT pg_my_temp_schema()::text AS oid,
      (SELECT rolcanlogin FROM pg_roles WHERE rolname=${f.userOwner}) AS login,
      EXISTS(SELECT 1 FROM pg_stat_activity WHERE usesysid=(SELECT oid FROM pg_roles WHERE rolname=${f.userOwner})) AS active_owner,
      has_schema_privilege(${f.userOwner},'public','CREATE') AS public_create`);
    expect(actual).toEqual({ oid: context.context.temp_oid, login: false, active_owner: false, public_create: false });
    expect(await inspectCustomerUserCatalogLock(f.db)).toMatchObject({ tablesSafe: true, absent: false,
      definitionSafe: true, ownerSafe: true, aclSafe: true });
  });

  it.each(['wrong-prior', 'wrong-database', 'wrong-maintenance'] as const)('refuses %s atomically without role, grant or history repair', async reason => {
    const history = await f.history(), grants = await f.rawAcl();
    const prior = reason === 'wrong-prior' ? { ...f.previous, app: f.previous.admin, admin: f.previous.app }
      : reason === 'wrong-database' ? { ...f.previous, database: 'wrong_owned_customer_database' }
      : { ...f.previous, maintenance: f.previous.app };
    await expect(provisionCustomerFinancialRuntime(f.db, f.password, prior)).rejects.toThrow();
    await absent(); expect(await f.history()).toEqual(history); expect(await f.rawAcl()).toEqual(grants);
    expect(await inspectRoutinePaymentRuntime(f.db, f.previous)).toMatchObject({ ready: true });
  });

  it.each([[731669, 0], [731670, 0], [...CUSTOMER_FINANCIAL_PROVISION_GATE]] as const)
    ('refuses a real competing shared maintenance gate %s,%s without partial commission', async (key, subkey) => {
      const history = await f.history(), grants = await f.rawAcl();
      await f.withPeer!(peer => peer.db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${key},${subkey})`);
        await expect(provisionCustomerFinancialRuntime(f.db, f.password, f.previous)).rejects.toThrow('outcome not confirmed');
      }));
      await absent(); expect(await f.history()).toEqual(history); expect(await f.rawAcl()).toEqual(grants);
    });

  it('rolls back a complete successful inner commission while retaining all canonical gates and tighter caller deadlines', async () => {
    const history = await f.history(), grants = await f.rawAcl(); let insideReady = false;
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout','4500ms',true),set_config('lock_timeout','700ms',true),
        set_config('idle_in_transaction_session_timeout','4500ms',true)`);
      expect(await provisionCustomerFinancialRuntimeInTransaction(tx, f.password, f.previous)).toMatchObject({
        created: true, commissioned: true, role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, audit: { ready: true }, historicalRowsReassigned: false });
      insideReady = (await inspectCustomerFinancialRuntimePrivileges(tx, { requireLogin: true,
        routine: { target: f.target, stage: 'ready' } })).ready;
      expect(insideReady).toBe(true);
      const [caps] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
        current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(caps).toEqual({ statement: '4500ms', lock: '700ms', idle: '4500ms' });
      const [gates] = await tx.execute(sql`SELECT count(*)=3 AS ready FROM pg_locks WHERE pid=pg_backend_pid()
        AND locktype='advisory' AND objsubid=2 AND mode='ExclusiveLock' AND granted
        AND (classid=731669 AND objid=0 OR classid=731670 AND objid=0 OR classid=${CUSTOMER_FINANCIAL_PROVISION_GATE[0]} AND objid=${CUSTOMER_FINANCIAL_PROVISION_GATE[1]})`);
      expect(gates.ready).toBe(true); throw Error('rollback after actual complete Customer commission');
    }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toThrow('rollback after actual complete Customer commission');
    expect(insideReady).toBe(true); await absent(); expect(await f.history()).toEqual(history); expect(await f.rawAcl()).toEqual(grants);
    expect(await inspectRoutinePaymentRuntime(f.db, f.previous)).toMatchObject({ ready: true });
  }, 60000);

  it('commissions the exact fresh fixed LOGIN and full addon profile, preserves history and opens an actual independent request session', async () => {
    const history = await f.history();
    expect(await f.commission()).toMatchObject({ created: true, commissioned: true, role: CUSTOMER_FINANCIAL_RUNTIME_ROLE,
      audit: { ready: true, profileReady: true }, historicalRowsReassigned: false });
    runtime = f.login(); expect(await audit()).toMatchObject({ ready: true, profileReady: true, failures: [], completeServiceCoverageVerified: false });
    const selected = await createCustomerFinancialDatabaseSession(f.environment);
    try {
      const [identity] = await selected.container.db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
        (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend,
        has_table_privilege(current_user,'public.payment_reconciliation_case','UPDATE') AS direct_case,
        has_table_privilege(current_user,'public.routine_payment_attempt','SELECT') AS attempt_read,
        has_table_privilege(current_user,'public.routine_payment_attempt','INSERT,UPDATE,DELETE,TRUNCATE') AS attempt_write,
        has_table_privilege(current_user,'public.routine_identity_witness','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS witness,
        to_regprocedure('public.local_payment_case_lock_v1(text)') IS NULL AS no_extra_case_definer`);
      expect(identity).toMatchObject({ role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, session: CUSTOMER_FINANCIAL_RUNTIME_ROLE,
        backend: CUSTOMER_FINANCIAL_RUNTIME_ROLE, direct_case: true, attempt_read: true, attempt_write: false, witness: false, no_extra_case_definer: true });
      const [owner] = await f.db.execute(sql`SELECT pg_backend_pid() AS pid`); expect(identity.pid).not.toBe(owner.pid);
      await expect(selected.container.db.execute(sql`INSERT INTO public.routine_payment_attempt DEFAULT VALUES`)).rejects.toMatchObject({ cause: { code: '42501' } });
    } finally { await selected.close(); }
    await noRequestBackends(); expect(await f.history()).toEqual(history);
  }, 60000);

  it('keeps actual fixed LOGIN financial pricing ready with the fully reviewed product and user capabilities', async () => {
    expect(await pricing('complete-fixed-profile')).toEqual({ ready: true, catalogReady: true, callerSafe: true,
      requiredPrivileges: true, noUnreviewedDefinerRoutine: true });
    await noRequestBackends();
  }, 60000);

  it('never rotates or repairs an existing fixed role or grants on a second commissioning request', async () => {
    const credential = await roleCredential(), history = await f.history(), grants = await f.rawAcl();
    await expect(provisionCustomerFinancialRuntime(f.db, customerFinancialCredential(), f.previous)).rejects.toThrow('outcome not confirmed');
    expect(await roleCredential()).toEqual(credential); expect(await f.history()).toEqual(history); expect(await f.rawAcl()).toEqual(grants);
    expect(await audit()).toMatchObject({ ready: true });
  });

  it('uses real financial HTTP read/offline routes and recovers the unchanged owner UUID receipt after customer qualification withdrawal', async () => {
    const order = await f.newOrder(runtime), body = await financialInput(order), key = randomUUID();
    const beforeUsers = await f.db.execute(sql`SELECT to_jsonb(t) AS row FROM public."user" t ORDER BY uid`);
    const committed = await f.request('/mobile/work/financial/confirm-offline', body, key);
    expect(committed.response.status).toBe(200); expect(committed.body.status, committed.body.msg).toBe(200);
    const result = committed.body.data as { receipt: FinancialReceipt; replayed: boolean };
    expect(result).toMatchObject({ receipt: { actor_uid: 101, service_id: 901, order_id: order.id, kind: 'confirm_offline', outcome: 'offline-paid' }, replayed: false });
    expect((await runtime.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0]).toMatchObject({ paid: 1, payType: 'offline' });
    expect(await runtime.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, 'order.paid:' + order.id))).toHaveLength(1);
    expect((await runtime.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, order.id)))
      .filter(row => row.changeType === 'cw_financial_confirm_offline')).toHaveLength(1);
    expect(await f.db.execute(sql`SELECT to_jsonb(t) AS row FROM public."user" t ORDER BY uid`)).toEqual(beforeUsers);
    const state = await f.businessState(), receipts = await ledger();
    await f.db.update(storeService).set({ customer: 0 }).where(eq(storeService.uid, 101));
    try {
      const recovered = await f.request('/mobile/work/financial/operations/' + key);
      expect(recovered.body.status, recovered.body.msg).toBe(200); expect(recovered.body.data).toMatchObject({ receipt: result.receipt });
      const replay = await f.request('/mobile/work/financial/confirm-offline', body, key);
      expect(replay.body.status, replay.body.msg).toBe(200); expect(replay.body.data).toMatchObject({ receipt: result.receipt, replayed: true });
      const other = await f.request('/mobile/work/financial/operations/' + key, undefined, undefined, f.environment, 102);
      expect(other.body.status).toBe(200); expect(other.body.data).toMatchObject({ receipt: null });
      expect(await f.businessState()).toEqual(state); expect(await ledger()).toEqual(receipts);
    } finally { await f.db.update(storeService).set({ customer: 1 }).where(eq(storeService.uid, 101)); }
    await noRequestBackends();
  }, 60000);

  it.each(['missing-binding', 'wrong-real-login'] as const)('fails real financial HTTP with503 on %s and leaves all business/receipts unchanged', async reason => {
    const bindings: Env = { ...f.environment };
    if (reason === 'missing-binding') delete bindings.HYPERDRIVE_CUSTOMER_FINANCIAL;
    else {
      const wrong = new URL(f.admin.connectionString); wrong.searchParams.set('application_name', 'owned_wrong_customer_login');
      bindings.HYPERDRIVE_CUSTOMER_FINANCIAL = { connectionString: wrong.href } as Env['HYPERDRIVE'];
    }
    const state = await f.businessState(), receipts = await ledger();
    const response = await f.request('/mobile/work/financial/operations/' + randomUUID(), undefined, undefined, bindings);
    expect(response.response.status).toBe(503); expect(response.body.status).toBe(503);
    expect(await f.businessState()).toEqual(state); expect(await ledger()).toEqual(receipts); await noRequestBackends();
  });

  it.each(['INITIATION', 'RETRY'] as const)('uses actual %s history to refuse new offline HTTP admission without paid/funds/outbox/status changes', async kind => {
    const order = await f.newOrder(runtime);
    const candidate = await withTx(createContainerFromDb(f.db), tx => registerPaymentReconciliationTx(tx, {
      provider: 'wechat', profile: 'routine', orderDomain: 'store_order', orderNo: order.orderId,
      expectedAmountCents: amountToCents(order.payPrice)!, initiated: false }));
    if (kind === 'INITIATION') await f.db.execute(sql`INSERT INTO public.routine_payment_attempt
      VALUES(${order.orderId},'INITIATION','{"fixture_denial_presence_only":true}',1,${'c'.repeat(64)})`);
    else {
      await f.db.update(paymentReconciliationCase).set({ status: 'UNKNOWN' }).where(eq(paymentReconciliationCase.id, candidate.id));
      await new PaymentReconciliationService(createContainerFromDb(f.db), f.environment).decide({ caseId: candidate.id,
        adminId: 91, actionKey: randomUUID(), action: 'retry', reasonCode: 'owned_customer_runtime_retry' });
      expect(await f.db.select().from(paymentReconciliationAction).where(eq(paymentReconciliationAction.caseId, candidate.id)))
        .toMatchObject([{ actionType: 'RETRY', afterStatus: 'OPEN' }]);
    }
    const body = await financialInput(order), key = randomUUID(), state = await f.businessState(), history = await f.history();
    const result = await f.request('/mobile/work/financial/confirm-offline', body, key);
    expect(result.body.status, result.body.msg).toBe(200); expect(result.body.data).toMatchObject({ receipt: { outcome: 'rollback-rejected' }, replayed: false });
    const replay = await f.request('/mobile/work/financial/confirm-offline', body, key);
    expect(replay.body.data).toMatchObject({ receipt: (result.body.data as { receipt: unknown }).receipt, replayed: true });
    expect(await f.businessState()).toEqual(state); expect(await f.history()).toEqual(history); await noRequestBackends();
  }, 60000);

  it.each(['table', 'column', 'sequence', 'sequence-nonserial', 'sequence-duplicate', 'sequence-missing',
    'connection-limit', 'public-data', 'default', 'taxonomy-execute', 'definer', 'membership', 'catalog'] as const)
    ('refuses committed %s drift in the whole fixed profile and succeeds only after exact restoration', async kind => {
      expect(await audit()).toMatchObject({ ready: true });
      const role = '"' + CUSTOMER_FINANCIAL_RUNTIME_ROLE + '"', state = await f.businessState();
      let restore = async () => {};
      if (kind === 'table') {
        const approvedColumns = customerFinancialRuntimePrivilegePlan().updateColumns.store_service;
        expect(approvedColumns).toEqual(['online']);
        await f.exec(`GRANT UPDATE ON public.store_service TO ${role}`);
        restore = async () => { await f.exec(`REVOKE UPDATE ON public.store_service FROM ${role};
          GRANT UPDATE(${approvedColumns.map(pricingIdentifier).join(',')}) ON public.store_service TO ${role}`); };
      } else if (kind === 'column') {
        await f.exec(`GRANT UPDATE(customer) ON public.store_service TO ${role}`);
        restore = async () => { await f.exec(`REVOKE UPDATE(customer) ON public.store_service FROM ${role}`); };
      } else if (kind === 'sequence') {
        await f.exec(`GRANT SELECT ON SEQUENCE public.store_order_id_seq TO ${role}`);
        restore = async () => { await f.exec(`REVOKE SELECT ON SEQUENCE public.store_order_id_seq FROM ${role}`); };
      } else if (kind === 'sequence-nonserial' || kind === 'sequence-duplicate') {
        const column = kind === 'sequence-nonserial' ? 'uid' : 'id';
        await f.exec(`CREATE SEQUENCE public.owned_customer_sequence_drift OWNED BY public.store_order.${column};
          GRANT USAGE ON SEQUENCE public.owned_customer_sequence_drift TO ${role}`);
        restore = async () => { await f.exec('DROP SEQUENCE public.owned_customer_sequence_drift'); };
      } else if (kind === 'sequence-missing') {
        await f.exec('ALTER SEQUENCE public.store_order_id_seq OWNED BY NONE');
        restore = async () => { await f.exec('ALTER SEQUENCE public.store_order_id_seq OWNED BY public.store_order.id'); };
      } else if (kind === 'connection-limit') {
        await f.exec(`ALTER ROLE ${role} CONNECTION LIMIT ${CUSTOMER_FINANCIAL_RUNTIME_CONNECTION_LIMIT - 1}`);
        restore = async () => { await f.exec(`ALTER ROLE ${role} CONNECTION LIMIT ${CUSTOMER_FINANCIAL_RUNTIME_CONNECTION_LIMIT}`); };
      } else if (kind === 'public-data') {
        await f.exec('GRANT SELECT ON public.store_service TO PUBLIC');
        restore = async () => { await f.exec('REVOKE SELECT ON public.store_service FROM PUBLIC'); };
      } else if (kind === 'default') {
        await f.exec(`ALTER DEFAULT PRIVILEGES FOR ROLE finance_test GRANT SELECT ON TABLES TO ${role}`);
        restore = async () => { await f.exec(`ALTER DEFAULT PRIVILEGES FOR ROLE finance_test REVOKE SELECT ON TABLES FROM ${role}`); };
      } else if (kind === 'taxonomy-execute') {
        const signature = 'customer_user_lock_catalog_v1(text, integer[])';
        expect(customerFinancialRuntimePrivilegePlan().functions).toContain(signature);
        await f.exec(`REVOKE EXECUTE ON FUNCTION public.${signature} FROM ${role}`);
        restore = async () => { await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${role}`); };
      } else if (kind === 'definer') {
        await f.exec(`CREATE FUNCTION public.owned_customer_unreviewed_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT 1';
          REVOKE ALL ON FUNCTION public.owned_customer_unreviewed_definer() FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION public.owned_customer_unreviewed_definer() TO ${role}`);
        restore = async () => { await f.exec('DROP FUNCTION public.owned_customer_unreviewed_definer()'); };
      } else if (kind === 'membership') {
        const peer = await f.createOwnedRole('membership'); await f.exec(`GRANT "${peer.role}" TO ${role}`);
        restore = async () => { await f.exec(`REVOKE "${peer.role}" FROM ${role}`); };
      } else {
        const [constraint] = await f.db.execute<{ name: string }>(sql`SELECT conname AS name FROM pg_constraint
          WHERE conrelid='public.customer_financial_operation_request'::regclass AND contype='c' ORDER BY conname LIMIT 1`);
        if (!constraint || !/^[a-z_][a-z_0-9]*$/u.test(constraint.name)) throw Error('Canonical Customer financial check missing');
        await f.exec(`ALTER TABLE public.customer_financial_operation_request RENAME CONSTRAINT "${constraint.name}" TO owned_customer_catalog_drift`);
        restore = async () => { await f.exec(`ALTER TABLE public.customer_financial_operation_request RENAME CONSTRAINT owned_customer_catalog_drift TO "${constraint.name}"`); };
      }
      try {
        const result = await audit(); expect(result.ready).toBe(false); expect(result.failures.length).toBeGreaterThan(0);
        if (kind.startsWith('sequence-')) expect(result.failures.some(failure => failure.startsWith('sequence'))).toBe(true);
        if (kind === 'connection-limit') expect(result.failures).toContain('connection_limit');
        if (kind === 'public-data') expect(result.failures).toContain('public_data_authority');
        if (kind === 'taxonomy-execute') {
          expect(result.failures).toContain('missing_function:customer_user_lock_catalog_v1(text, integer[])');
          expect(await pricing('taxonomy-execute-missing')).toEqual({ ready: false, catalogReady: true,
            callerSafe: true, requiredPrivileges: true, noUnreviewedDefinerRoutine: true });
        }
        if (kind === 'definer') expect(await pricing('unknown-definer')).toEqual({ ready: false, catalogReady: true,
          callerSafe: true, requiredPrivileges: true, noUnreviewedDefinerRoutine: false });
      }
      finally { await restore(); }
      expect(await audit()).toMatchObject({ ready: true, failures: [] }); expect(await f.businessState()).toEqual(state);
      if (kind === 'taxonomy-execute') expect(await pricing('taxonomy-execute-restored')).toEqual({ ready: true,
        catalogReady: true, callerSafe: true, requiredPrivileges: true, noUnreviewedDefinerRoutine: true });
      if (kind === 'definer') expect(await pricing('unknown-definer-removed')).toEqual({ ready: true, catalogReady: true,
        callerSafe: true, requiredPrivileges: true, noUnreviewedDefinerRoutine: true });
    }, 60000);

  it.each(['public', 'ordinary'] as const)('still refuses user capability owner CREATE on the real %s schema and returns ready only after exact revocation', async kind => {
    expect(await audit()).toMatchObject({ ready: true });
    const schema = kind === 'public' ? 'public' : 'owned_customer_user_namespace_drift', role = '"' + f.userOwner + '"';
    const state = await f.businessState();
    if (kind === 'ordinary') {
      const [before] = await f.db.execute(sql`SELECT to_regnamespace(${schema}) IS NULL AS absent`); expect(before.absent).toBe(true);
      await f.exec('CREATE SCHEMA owned_customer_user_namespace_drift AUTHORIZATION finance_test');
    }
    try {
      await f.exec(`GRANT CREATE ON SCHEMA "${schema}" TO ${role}`);
      try {
        const result = await audit(); expect(result.ready).toBe(false); expect(result.failures).toContain('customer_user_lock_catalog');
        expect(await inspectCustomerUserCatalogLock(f.db)).toMatchObject({ ownerSafe: false });
      } finally { await f.exec(`REVOKE CREATE ON SCHEMA "${schema}" FROM ${role}`); }
      expect(await audit()).toMatchObject({ ready: true, failures: [] });
      expect(await inspectCustomerUserCatalogLock(f.db)).toMatchObject({ ownerSafe: true });
    } finally { if (kind === 'ordinary') await f.exec('DROP SCHEMA owned_customer_user_namespace_drift'); }
    expect(await f.businessState()).toEqual(state);
  }, 60000);

  it('refuses commissioning through the actual non-maintenance LOGIN without changing its credential or any history', async () => {
    const credential = await roleCredential(), history = await f.history(), grants = await f.rawAcl();
    await expect(provisionCustomerFinancialRuntime(runtime, customerFinancialCredential(), f.previous)).rejects.toThrow('outcome not confirmed');
    expect(await roleCredential()).toEqual(credential); expect(await f.history()).toEqual(history); expect(await f.rawAcl()).toEqual(grants);
    expect(await audit()).toMatchObject({ ready: true });
  });
});
