import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '../src/migrations/customerFinancialRuntimePlan';
import { auditCustomerFinancialRuntimePrivileges } from '../src/migrations/auditCustomerFinancialRuntimePrivileges';
import { inspectCustomerFinancialManualRefundRuntime } from '../src/migrations/customerFinancialManualRefundRuntime';
import { upgradeCustomerFinancialManualRefundRuntime, upgradeCustomerFinancialManualRefundRuntimeInTransaction } from '../src/migrations/upgradeCustomerFinancialManualRefundRuntime';
import { customerManualRefundReadiness } from '../src/migrations/runCustomerManualRefund';
import { auditCheckoutPricingLockRuntime } from '../src/migrations/checkoutPricingLock';
import { inspectRoutinePaymentRuntime } from '../src/migrations/routinePaymentRuntime';
import { CUSTOMER_MANUAL_GUEST_IDENTITY_CONSTRAINTS } from '../src/migrations/customerManualRefundGuestIdentity';
import { pricingIdentifier } from '../src/migrations/checkoutPricingLockCatalog';
import { inspectManagerRuntimeCapabilities, installManagerRuntimeCapabilities } from '../src/migrations/managerRuntimeCapabilities';
import { storeProductAttrValue, storeService, user, userBill } from '../src/models/schema';
import { customerFinancialManualRuntimeFixture } from './helpers/customerFinancialManualRuntimeFixture';

// Complete source profile, real fixed LOGINs, real shared gates and SQL rollback.
// Business acceptance follows actual UserJWT -> v1Routes -> middleware -> core
// payment -> original paid consumer -> quote/application/refund/owner recovery.
// Provider I/O is forbidden; immutable Mini presence is never payment success.
describe.sequential('fixed Financial complete manual refund forward and actual routes on owned PG16', { timeout: 30000 }, () => {
  let f: Awaited<ReturnType<typeof customerFinancialManualRuntimeFixture>>;
  beforeAll(async () => { f = await customerFinancialManualRuntimeFixture(); }, 180000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No real provider request in manual Financial acceptance')); });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  const role = pricingIdentifier(CUSTOMER_FINANCIAL_RUNTIME_ROLE);
  const audit = () => auditCustomerFinancialRuntimePrivileges(f.runtime, f.target, f.addon);
  const inspect = (requirePrivileges: boolean) => inspectCustomerFinancialManualRefundRuntime(f.db,
    { role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, ...f.addon, requirePrivileges });
  const upgrade = () => upgradeCustomerFinancialManualRefundRuntime(f.db, f.target, f.addon);
  const snapshot = async () => ({ history: await f.history(), raw: await f.rawAcl(), addon: await f.financialAcl(),
    credential: await f.credential(), business: await f.businessState(), manual: await f.manualRows(), ledger: await f.ledger() });
  const assertReady = async () => { const result = await audit(); expect(result.failures).toEqual([]); expect(result.ready).toBe(true); };

  it('retains the exact whole base while explicitly installed canonical manual sources wait for any addon grant', async () => {
    expect(await auditCustomerFinancialRuntimePrivileges(f.runtime, f.target)).toMatchObject({ ready: true, failures: [] });
    expect(await inspect(false)).toMatchObject({ ready: true, catalogReady: true, failures: [], promotionSequence: {
      name: 'store_order_promotions_id_seq', table: 'store_order_promotions', column: 'id' } });
    const post = await inspect(true); expect(post.ready).toBe(false); expect(post.catalogReady).toBe(true);
    expect(post.failures).toContain('manual_target_manual_append'); expect(post.failures).toContain('manual_target_manager_read');
    expect((await customerManualRefundReadiness(f.runtime)).ready).toBe(false);
    expect((await audit()).ready).toBe(false);
  });

  it.each(['wrong-owner', 'wrong-prior', 'wrong-database', 'wrong-maintenance', 'missing-local'] as const)
    ('rejects %s without changing credentials, source evidence or any grant', async mutation => {
      const before = await snapshot(), other = mutation === 'wrong-owner' ? await f.createOwnedRole('other_manual') : null;
      const target = mutation === 'wrong-prior' ? { ...f.target, app: f.target.admin, admin: f.target.app }
        : mutation === 'wrong-database' ? { ...f.target, database: 'wrong_owned_manual_database' }
          : mutation === 'wrong-maintenance' ? { ...f.target, maintenance: f.target.app }
            : mutation === 'missing-local' ? { ...f.target, local: [] } : f.target;
      await expect(upgradeCustomerFinancialManualRefundRuntime(f.db, target, other ? { promotionOwner: other.role } : f.addon)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await auditCustomerFinancialRuntimePrivileges(f.runtime, f.target)).toMatchObject({ ready: true });
    });

  it('refuses a partial manual grant instead of silently repairing it', async () => {
    await f.exec(`GRANT SELECT ON public.customer_financial_manual_refund_v1 TO ${role}`);
    try { const before = await snapshot(); await expect(upgrade()).rejects.toThrow('outcome not confirmed'); expect(await snapshot()).toEqual(before); }
    finally { await f.exec(`REVOKE SELECT ON public.customer_financial_manual_refund_v1 FROM ${role}`); }
    expect(await auditCustomerFinancialRuntimePrivileges(f.runtime, f.target)).toMatchObject({ ready: true });
  });

  it.each(['witness', 'attempt', 'financial', 'promotion', 'manual', 'manager-reader'] as const)
    ('holds the existing %s maintenance boundary and refuses the competing forward atomically', async name => {
      const [namespace] = await f.db.execute<{ oid: number }>(sql`SELECT oid::integer AS oid FROM pg_namespace WHERE nspname='public'`);
      const pair = name === 'witness' ? [731669, 0] : name === 'attempt' ? [731670, 0] : name === 'financial' ? [731665, 1]
        : name === 'promotion' ? [731695, namespace.oid] : name === 'manual' ? [731711, 0] : [731626, 0];
      const before = await snapshot();
      await f.withPeer!(peer => peer.db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${pair[0]},${pair[1]})`);
        await expect(upgrade()).rejects.toThrow('outcome not confirmed');
      }));
      expect(await snapshot()).toEqual(before);
    });

  it('rolls back a fully ready inner forward and preserves all six gates and tighter caller deadlines', async () => {
    const before = await snapshot(); let inside = false;
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout','4500ms',true),set_config('lock_timeout','700ms',true),
        set_config('idle_in_transaction_session_timeout','4500ms',true)`);
      const result = await upgradeCustomerFinancialManualRefundRuntimeInTransaction(tx, f.target, f.addon);
      inside = result.changed && result.audit.ready; expect(inside).toBe(true);
      const [caps] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
        current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(caps).toEqual({ statement: '4500ms', lock: '700ms', idle: '4500ms' });
      const [gates] = await tx.execute(sql`SELECT count(*)=6 AS ready FROM pg_locks WHERE pid=pg_backend_pid()
        AND locktype='advisory' AND objsubid=2 AND mode='ExclusiveLock' AND granted
        AND(classid=731669 AND objid=0 OR classid=731670 AND objid=0 OR classid=731665 AND objid=1
          OR classid=731695 AND objid='public'::regnamespace::oid OR classid=731711 AND objid=0 OR classid=731626 AND objid=0)`);
      expect(gates.ready).toBe(true); throw Error('rollback after real full manual forward');
    }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toThrow('rollback after real full manual forward');
    expect(inside).toBe(true); expect(await snapshot()).toEqual(before);
    expect(await auditCustomerFinancialRuntimePrivileges(f.runtime, f.target)).toMatchObject({ ready: true });
  });

  it('commits the complete explicit addon atomically without changing password, raw binding, old evidence or business rows', async () => {
    const before = await snapshot(), result = await upgrade(), after = await snapshot();
    expect(result).toMatchObject({ changed: true, commissioned: true, credentialChanged: false, historicalRowsReassigned: false,
      audit: { ready: true, profileReady: true, completeServiceCoverageVerified: false } });
    expect(after.history).toEqual(before.history); expect(after.raw).toEqual(before.raw); expect(after.credential).toEqual(before.credential);
    expect(after.business).toEqual(before.business); expect(after.manual).toEqual(before.manual); expect(after.ledger).toEqual(before.ledger);
    expect(await inspectRoutinePaymentRuntime(f.db, f.target)).toMatchObject({ ready: true }); await assertReady();
    expect((await auditCustomerFinancialRuntimePrivileges(f.runtime, f.target)).ready).toBe(false);
  });

  it('treats only the exact completed addon as a read-only idempotent replay without assigning a transaction id', async () => {
    const before = await snapshot();
    await f.db.transaction(async tx => {
      const [start] = await tx.execute(sql`SELECT txid_current_if_assigned()::text AS xid`); expect(start.xid).toBeNull();
      expect(await upgradeCustomerFinancialManualRefundRuntimeInTransaction(tx, f.target, f.addon)).toMatchObject({ changed: false, audit: { ready: true } });
      const [end] = await tx.execute(sql`SELECT txid_current_if_assigned()::text AS xid`); expect(end.xid).toBeNull();
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
    expect(await snapshot()).toEqual(before);
  });

  it('proves actual fixed LOGIN identity, manual and pricing readiness while manager history remains SELECT-only', async () => {
    const [identity] = await f.runtime.execute(sql`SELECT current_user AS role,session_user AS session,
      (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend,
      has_table_privilege(current_user,'public.manager_order_operation_request','SELECT') AS manager_read,
      has_table_privilege(current_user,'public.manager_order_operation_request','INSERT,UPDATE,DELETE,TRUNCATE') AS manager_write,
      has_table_privilege(current_user,'public.store_order_promotions','DELETE') AS promotion_delete`);
    expect(identity).toEqual({ role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, session: CUSTOMER_FINANCIAL_RUNTIME_ROLE,
      backend: CUSTOMER_FINANCIAL_RUNTIME_ROLE, manager_read: true, manager_write: false, promotion_delete: false });
    expect((await customerManualRefundReadiness(f.runtime)).ready).toBe(true);
    expect((await auditCheckoutPricingLockRuntime(f.runtime, 'public', 'customer-work')).ready).toBe(true);
    for (const query of [sql`INSERT INTO public.manager_order_operation_request DEFAULT VALUES`,
      sql`UPDATE public.manager_order_operation_request SET actor_uid=actor_uid`, sql`DELETE FROM public.manager_order_operation_request`,
      sql`SELECT * FROM public.manager_order_operation_request FOR UPDATE`]) await expect(f.runtime.execute(query)).rejects.toThrow();
    await expect(f.runtime.execute(sql`DELETE FROM public.customer_financial_manual_refund_v1`)).rejects.toThrow();
  });

  it.each([
    ['manual-append', 'REVOKE INSERT ON public.customer_financial_manual_refund_v1', 'GRANT INSERT ON public.customer_financial_manual_refund_v1'],
    ['manager-read', 'REVOKE SELECT ON public.manager_order_operation_request', 'GRANT SELECT ON public.manager_order_operation_request'],
    ['manual-execute', 'REVOKE EXECUTE ON FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer)', 'GRANT EXECUTE ON FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer)'],
    ['promotion-id', 'REVOKE UPDATE(id) ON public.store_order_promotions', 'GRANT UPDATE(id) ON public.store_order_promotions'],
    ['promotion-sequence', 'REVOKE USAGE ON SEQUENCE public.store_order_promotions_id_seq', 'GRANT USAGE ON SEQUENCE public.store_order_promotions_id_seq'],
  ] as const)('rejects missing exact %s without repairing it and accepts precise restoration', async (_name, revoke, grant) => {
    await assertReady(); await f.exec(`${revoke} FROM ${role}`);
    try { expect((await audit()).ready).toBe(false); await expect(upgrade()).rejects.toThrow('outcome not confirmed'); }
    finally { await f.exec(`${grant} TO ${role}`); }
    await assertReady();
  });

  it('rejects unreviewed whole-profile table authority even when the manual addon itself remains complete', async () => {
    await f.exec(`GRANT DELETE ON public.user_group TO ${role}`);
    try { expect((await inspect(true)).ready).toBe(true); const result = await audit(); expect(result.ready).toBe(false);
      expect(result.failures).toContain('table:user_group:DELETE'); await expect(upgrade()).rejects.toThrow(); }
    finally { await f.exec(`REVOKE DELETE ON public.user_group FROM ${role}`); }
    await assertReady();
  });

  it.each(['LOGIN', 'INHERIT', 'CREATE-public', 'extra-SELECT', 'foreign-data', 'owned-function'] as const)
    ('rejects actual manual NOLOGIN owner drift %s and requires exact restoration', async mutation => {
      const owner = pricingIdentifier(f.manualOwner), probe = 'manual_owner_probe_' + randomUUID().replaceAll('-', '').slice(0, 12);
      if (mutation === 'LOGIN' || mutation === 'INHERIT') await f.exec(`ALTER ROLE ${owner} ${mutation}`);
      else if (mutation === 'CREATE-public') await f.exec(`GRANT CREATE ON SCHEMA public TO ${owner}`);
      else if (mutation === 'extra-SELECT') await f.exec(`GRANT SELECT ON public."user" TO ${owner}`);
      else if (mutation === 'foreign-data') await f.exec(`CREATE SCHEMA "${probe}";CREATE TABLE "${probe}".evidence(id integer);GRANT USAGE ON SCHEMA "${probe}" TO ${owner};GRANT SELECT ON "${probe}".evidence TO ${owner}`);
      else await f.exec(`CREATE FUNCTION public."${probe}"() RETURNS integer LANGUAGE sql AS 'SELECT 1';ALTER FUNCTION public."${probe}"() OWNER TO ${owner}`);
      try { expect((await inspect(true)).catalogReady).toBe(false); expect((await audit()).ready).toBe(false); await expect(upgrade()).rejects.toThrow(); }
      finally {
        if (mutation === 'LOGIN' || mutation === 'INHERIT') await f.exec(`ALTER ROLE ${owner} NO${mutation}`);
        else if (mutation === 'CREATE-public') await f.exec(`REVOKE CREATE ON SCHEMA public FROM ${owner}`);
        else if (mutation === 'extra-SELECT') await f.exec(`REVOKE SELECT ON public."user" FROM ${owner}`);
        else if (mutation === 'foreign-data') await f.exec(`DROP SCHEMA "${probe}" CASCADE`);
        else await f.exec(`DROP FUNCTION public."${probe}"()`);
      }
      await assertReady();
    });

  it.each(['manual-index', 'promotion-index', 'manual-body', 'guard-body', 'unknown-definer'] as const)
    ('rejects complete catalog drift %s and keeps the original source after restoration', async mutation => {
      const probe = 'manual_catalog_probe_' + randomUUID().replaceAll('-', '').slice(0, 12);
      const signature = mutation === 'guard-body' ? 'public.cashier_second_card_promotion_lock_v1()'
        : 'public.customer_manual_refund_promotion_delete_v1(integer,integer)';
      const definition = mutation === 'manual-body' || mutation === 'guard-body'
        ? (await f.db.execute<{ source: string }>(sql`SELECT pg_get_functiondef(to_regprocedure(${signature})) AS source`))[0].source : '';
      if (mutation === 'manual-index') await f.exec(`ALTER INDEX public.cmfr_actor_history RENAME TO "${probe}"`);
      else if (mutation === 'promotion-index') await f.exec(`ALTER INDEX public.sop_order_product RENAME TO "${probe}"`);
      else if (mutation === 'manual-body') await f.exec("CREATE OR REPLACE FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN 0;END'");
      else if (mutation === 'guard-body') await f.exec("CREATE OR REPLACE FUNCTION public.cashier_second_card_promotion_lock_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN NEW;END'");
      else await f.exec(`CREATE FUNCTION public."${probe}"() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';REVOKE ALL ON FUNCTION public."${probe}"() FROM PUBLIC;GRANT EXECUTE ON FUNCTION public."${probe}"() TO ${role}`);
      try { expect((await audit()).ready).toBe(false); expect((await auditCheckoutPricingLockRuntime(f.runtime, 'public', 'customer-work')).ready).toBe(false);
        await expect(upgrade()).rejects.toThrow(); }
      finally {
        if (mutation === 'manual-index') await f.exec(`ALTER INDEX public."${probe}" RENAME TO cmfr_actor_history`);
        else if (mutation === 'promotion-index') await f.exec(`ALTER INDEX public."${probe}" RENAME TO sop_order_product`);
        else if (mutation === 'manual-body' || mutation === 'guard-body') await f.exec(definition);
        else await f.exec(`DROP FUNCTION public."${probe}"()`);
      }
      await assertReady(); expect((await auditCheckoutPricingLockRuntime(f.runtime, 'public', 'customer-work')).ready).toBe(true);
    });

  it.each(CUSTOMER_MANUAL_GUEST_IDENTITY_CONSTRAINTS)('rejects a mixed guest predicate at $name without financial effects', async constraint => {
    const before = await snapshot(), legacy = constraint.body.replace('uid >= 0', 'uid > 0');
    expect(constraint.body.match(/\buid >= 0\b/gu)).toHaveLength(1);
    await f.exec(`ALTER TABLE public.${constraint.table} DROP CONSTRAINT ${constraint.name},ADD CONSTRAINT ${constraint.name} CHECK (${legacy})`);
    try { expect((await inspect(true)).catalogReady).toBe(false); expect((await customerManualRefundReadiness(f.runtime)).ready).toBe(false);
      expect((await audit()).ready).toBe(false); await expect(upgrade()).rejects.toThrow(); }
    finally { await f.exec(`ALTER TABLE public.${constraint.table} DROP CONSTRAINT ${constraint.name},ADD CONSTRAINT ${constraint.name} CHECK (${constraint.body})`); }
    expect(await snapshot()).toEqual(before); await assertReady();
  });

  it.each(['7.00', '0.00'])('runs real fixed-LOGIN offline payment, original paid consumer and all actual refund routes for price %s', async price => {
    const paid = await f.paidOffline(price), beforeAccounts = await f.db.select().from(user), beforeBills = await f.db.select().from(userBill);
    const [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    expect(await paid.consumer.processMessage(paid.message)).toBe('already-completed');
    const created = await f.create(paid.order.id), done = await f.execute(created.id), status = price === '0.00' ? 'ZERO_SUCCESS' : 'CASH_SUCCESS';
    expect(done.response.body, done.response.body.msg).toMatchObject({ status: 200, data: { receipt: { actor_uid: 101,
      outcome: price === '0.00' ? 'zero-settled' : 'cash-settled' }, execution: { status, completed: true, verified: true } } });
    const proofs = (await f.manualRows()).filter(row => row.refund_id === created.id); expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({ actor_uid: 101, buyer_uid: 11, pay_type: 'offline', amount: paid.order.payPrice,
      cash_returned: price !== '0.00', settlement: price === '0.00' ? 'zero' : 'cash' });
    expect(await f.db.select().from(user)).toEqual(beforeAccounts); expect(await f.db.select().from(userBill)).toEqual(beforeBills);
    const [afterSku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)); expect(afterSku.stock).toBe(sku.stock + 1);
    const beforeReplay = await snapshot();
    expect((await f.request('/mobile/work/financial/refund-execute', done.body, done.key)).body).toMatchObject({ status: 200,
      data: { receipt: done.result.receipt, execution: { status, completed: true } } });
    expect(await snapshot()).toEqual(beforeReplay);
    await f.db.update(storeService).set({ customer: 0 }).where(eq(storeService.uid, 101));
    try {
      const recovered = await f.request('/mobile/work/financial/operations/' + done.key);
      expect(recovered.body).toMatchObject({ status: 200, data: { receipt: done.result.receipt, execution: { status, completed: true, verified: true } } });
      expect((await f.request('/mobile/work/financial/operations/' + done.key, undefined, undefined, f.environment, 102)).body)
        .toMatchObject({ status: 200, data: { receipt: null } });
      const rejectedBefore = await snapshot(), rejectedKey = randomUUID();
      const rejected = await f.request('/mobile/work/financial/refund-create', created.body, rejectedKey);
      expect(rejected.response.status).toBe(200);
      expect(rejected.body).toMatchObject({ status: 200, data: { replayed: false, execution: null, receipt: {
        request_key: rejectedKey, actor_uid: 101, service_id: 0, order_id: paid.order.id,
        kind: 'refund_create', outcome: 'rollback-rejected', evidence: { code: '410000' },
      } } });
      const rejectedAfter = await snapshot(), { ledger: beforeLedger, ...beforeBusiness } = rejectedBefore,
        { ledger: afterLedger, ...afterBusiness } = rejectedAfter;
      expect(afterBusiness).toEqual(beforeBusiness);
      const rejectionRows = afterLedger.filter(row => row.actor_uid === 101 && row.request_key === rejectedKey);
      expect(rejectionRows).toHaveLength(1);
      expect(rejectionRows[0]).toMatchObject({ actor_uid: 101, service_id: 0, order_id: paid.order.id,
        kind: 'refund_create', outcome: 'rollback-rejected', evidence: { code: '410000' }, intent: created.body });
      expect(afterLedger.filter(row => row.actor_uid !== 101 || row.request_key !== rejectedKey)).toEqual(beforeLedger);
      expect(afterLedger).toHaveLength(beforeLedger.length + 1);
      expect((await f.request('/mobile/work/financial/refund-create', created.body, rejectedKey)).body).toMatchObject({
        status: 200, data: { replayed: true, execution: null, receipt: {
          request_key: rejectedKey, actor_uid: 101, service_id: 0, kind: 'refund_create', outcome: 'rollback-rejected', evidence: { code: '410000' },
        } },
      });
      expect(await snapshot()).toEqual(rejectedAfter);
    } finally { await f.db.update(storeService).set({ customer: 1 }).where(eq(storeService.uid, 101)); }
    await assertReady();
  });

  it('keeps direct promotion UPDATE(id) guarded and cannot invoke deletion without same-transaction refund proof', async () => {
    const [row] = await f.db.execute<{ id: number }>(sql`INSERT INTO public.store_order_promotions(oid,uid,promotions_price) VALUES(190001,11,0.00) RETURNING id`);
    try { await expect(f.runtime.execute(sql`UPDATE public.store_order_promotions SET id=id WHERE id=${row.id}`)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(f.runtime.execute(sql`SELECT public.customer_manual_refund_promotion_delete_v1(190001,190001)`)).rejects.toThrow(); }
    finally { await f.db.execute(sql`DELETE FROM public.store_order_promotions WHERE id=${row.id}`); }
    await assertReady();
  });

  it('composes the exact published Manager promotion capability under the declared manual NOLOGIN owner without granting Financial Manager EXECUTE', async () => {
    const before = await inspect(true), waybill = await f.createOwnedRole('manager_waybill');
    const capabilities = await f.db.transaction(tx => installManagerRuntimeCapabilities(tx,
      { waybillOwner: waybill.role, promotionOwner: f.manualOwner }), { isolationLevel: 'read committed', accessMode: 'read write' });
    expect(capabilities.promotion).toMatchObject({ ready: true, ownerOid: before.promotionOwnerOid });
    expect(capabilities.promotion.functionOid).toMatch(/^[1-9][0-9]*$/u);
    const after = await inspect(true);
    expect(after).toMatchObject({ ready: true, catalogReady: true, failures: [], manualFunctionOid: before.manualFunctionOid,
      promotionOwnerOid: before.promotionOwnerOid });
    const [identity] = await f.runtime.execute(sql`SELECT current_user AS role,session_user AS session,
      has_function_privilege(current_user,'public.manager_delete_order_promotions_v1(integer,jsonb)','EXECUTE') AS manager_execute`);
    expect(identity).toEqual({ role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, session: CUSTOMER_FINANCIAL_RUNTIME_ROLE, manager_execute: false });
    await assertReady(); expect((await customerManualRefundReadiness(f.runtime)).ready).toBe(true);
    expect((await auditCheckoutPricingLockRuntime(f.runtime, 'public', 'customer-work')).ready).toBe(true);
    expect(await upgrade()).toMatchObject({ changed: false, audit: { ready: true } });
  });

  it('refuses Manager EXECUTE on the Financial LOGIN even with an exact shared owner protocol', async () => {
    await f.exec(`GRANT EXECUTE ON FUNCTION public.manager_delete_order_promotions_v1(integer,jsonb) TO ${role}`);
    try {
      const inspected = await inspect(true); expect(inspected.ready).toBe(false); expect(inspected.failures).toContain('manual_target_function_safe');
      expect((await audit()).ready).toBe(false); await expect(upgrade()).rejects.toThrow();
      await expect(f.runtime.execute(sql`SELECT public.manager_delete_order_promotions_v1(190001,'[]'::jsonb)`)).rejects.toMatchObject({ cause: { code: '42501' } });
    } finally { await f.exec(`REVOKE EXECUTE ON FUNCTION public.manager_delete_order_promotions_v1(integer,jsonb) FROM ${role}`); }
    await assertReady();
  });

  it('refuses a changed same-name shared Manager body rather than accepting its name or owner alone', async () => {
    const [original] = await f.db.execute<{ source: string }>(sql`SELECT pg_get_functiondef('public.manager_delete_order_promotions_v1(integer,jsonb)'::regprocedure) AS source`);
    await f.exec("CREATE OR REPLACE FUNCTION public.manager_delete_order_promotions_v1(integer,jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN 0;END'");
    try {
      expect((await inspectManagerRuntimeCapabilities(f.db)).promotion.ready).toBe(false);
      const inspected = await inspect(true); expect(inspected.catalogReady).toBe(false);
      expect(inspected.failures).toContain('manual_manager_promotion_composition');
      expect((await audit()).ready).toBe(false); await expect(upgrade()).rejects.toThrow();
    } finally { await f.exec(original.source); }
    await assertReady();
  });
});
