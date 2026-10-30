import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '../src/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '../src/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges, inspectCustomerCashierSecondCardRuntimePrivileges } from '../src/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import { inspectOrderPromotionGiftReceiptCatalog } from '../src/migrations/orderPromotionGiftReceipt';
import { inspectReviewedRuntimeGiftPeers, type RuntimeGiftPeerDeclarations } from '../src/migrations/customerRuntimeGiftPeers';
import { inspectCustomerFinancialManualRefundRuntime } from '../src/migrations/customerFinancialManualRefundRuntime';
import { cashierSecondCardPromotionLockReadiness } from '../src/migrations/cashierSecondCardPromotionLock';
import { auditCheckoutPricingLockRuntime } from '../src/migrations/checkoutPricingLock';
import { pricingIdentifier } from '../src/migrations/checkoutPricingLockCatalog';
import { inspectRuntimeAppCashierOriginReader } from '../src/migrations/runtimeAppCashierOriginReader';
import { upgradeRuntimeAppCashierOriginReader, upgradeRuntimeAppCashierOriginReaderInTransaction } from '../src/migrations/upgradeRuntimeAppCashierOriginReader';
import { customerOriginalPaymentRuntimeFixture } from './helpers/customerOriginalPaymentRuntimeFixture';

// Five independent full published LOGIN profiles and explicit shared gift ACL
// declarations. Empty INSERTs below probe authority without manufacturing an
// order, original payment, gift receipt or paid-consumer result. The old whole
// offline suite separately exercises genuine producers and payment consumers.
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).sequential('original-payment complete runtime profiles and explicit gift peers coexist on owned PG16', { timeout: 30000 }, () => {
  let f: Awaited<ReturnType<typeof customerOriginalPaymentRuntimeFixture>>;
  beforeAll(async () => { f = await customerOriginalPaymentRuntimeFixture(); }, 180000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external request in original-payment coexistence acceptance')); });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  const gift = (peers: RuntimeGiftPeerDeclarations | undefined = f.peers) => inspectOrderPromotionGiftReceiptCatalog(
    f.maintenanceDb, f.target.maintenance, { app: f.target.app, admin: f.target.admin }, peers);
  const peerProof = (peers = f.peers) => inspectReviewedRuntimeGiftPeers(f.maintenanceDb,
    { app: f.target.app, admin: f.target.admin }, f.target.maintenance, peers);
  const cashierAudit = () => auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db,
    f.cashierRuntime.role, f.target, { abandon: true });
  const financialAudit = () => auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db, f.target, f.manual, f.readers);
  const namedCashier = () => inspectCustomerCashierSecondCardRuntimePrivileges(f.maintenanceDb,
    { role: f.cashierRuntime.role, requireLogin: true, routine: { target: f.target, stage: 'ready' }, abandon: true });
  const assertCashierReady = async () => {
    expect(await cashierAudit()).toMatchObject({ ready: true, profileReady: true, realLogin: true, failures: [],
      conditionalWriteSemanticsVerified: false, completeServiceCoverageVerified: false });
  };
  const assertGiftReady = async () => {
    expect(await gift()).toMatchObject({ ready: true, catalogReady: true, sequenceReady: true, pointsReady: true,
      peerProof: { ready: true, failures: [], readOnly: true,
        conditionalWriteSemanticsVerified: false, completeServiceCoverageVerified: false } });
  };
  // Capture catalog state, not a replacement privilege proof. Each negative
  // also calls the actual production auditors while the drift is present.
  const authoritySnapshot = async () => {
    const [row] = await f.maintenanceDb.execute(sql`SELECT jsonb_build_object(
      'relations',(SELECT jsonb_agg(jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl::text) ORDER BY c.oid)
        FROM pg_class c WHERE c.relnamespace='public'::regnamespace),
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid::text,a.attnum,a.attacl::text) ORDER BY a.attrelid,a.attnum)
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL),
      'routines',(SELECT jsonb_agg(jsonb_build_array(p.oid::text,p.proname,p.proowner::text,p.proacl::text,
          CASE WHEN p.prokind IN('f','p') THEN md5(pg_get_functiondef(p.oid)) ELSE NULL END) ORDER BY p.oid)
        FROM pg_proc p WHERE p.pronamespace='public'::regnamespace),
      'roles',(SELECT jsonb_agg(jsonb_build_array(r.oid::text,r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
          r.rolinherit,r.rolreplication,r.rolbypassrls,r.rolconnlimit) ORDER BY r.oid)
        FROM pg_roles r WHERE r.rolname IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role},${f.managerRuntime.role},${f.cashierRuntime.role})),
      'giftRows',(SELECT count(*) FROM public.store_order_promotion_gift_coupon_reward)) AS state`);
    return row.state;
  };

  it('independently audits all five real LOGINs with the same final routine binding and explicit gift peers', async () => {
    const runtimes = [f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime];
    const identities = await Promise.all(runtimes.map(async runtime => {
      const [identity] = await runtime.db.execute(sql`SELECT current_database() AS database,current_user AS role,
        session_user AS session,pg_backend_pid() AS pid,(SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r
          ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend`);
      expect(identity).toMatchObject({ database: f.database, role: runtime.role, session: runtime.role, backend: runtime.role });
      expect(await runtime.verify()).toBe(identity.pid); return identity;
    }));
    const [maintenance] = await f.maintenanceDb.execute(sql`SELECT pg_backend_pid() AS pid`);
    expect(new Set([...identities.map(identity => identity.pid), maintenance.pid]).size).toBe(6);
    const audits = await Promise.all([
      auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders),
      auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, f.peers),
      financialAudit(), auditManagerRuntimePrivileges(f.managerRuntime.db, f.target), cashierAudit(),
    ]);
    for (const result of audits) expect(result).toMatchObject({ ready: true, failures: [], completeServiceCoverageVerified: false });
    expect(audits[4]).toMatchObject({ realLogin: true, conditionalWriteSemanticsVerified: false,
      giftSourcePrivileges: { table: 'store_order_promotion_gift_coupon_reward', privileges: ['SELECT', 'INSERT'],
        sequence: 'store_order_promotion_gift_coupon_reward_id_seq', sequencePrivileges: ['USAGE'] } });
    const proof = await peerProof();
    expect(proof.grants.map(item => ({ kind: item.kind, role: item.role, table: item.table, sequence: item.sequence }))).toEqual([
      { kind: 'financial', role: f.financialRuntime.role, table: ['SELECT', 'INSERT'], sequence: ['USAGE'] },
      { kind: 'cashier-second-card', role: f.cashierRuntime.role, table: ['SELECT', 'INSERT'], sequence: ['USAGE'] },
      { kind: 'manager', role: f.managerRuntime.role, table: ['SELECT'], sequence: [] },
    ]);
    expect(new Set(proof.grants.map(item => item.oid)).size).toBe(3); await assertGiftReady();
  });

  const appAudit = () => auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders);
  const appSource = () => inspectRuntimeAppCashierOriginReader(f.maintenanceDb,
    { role: f.appRuntime.role, maintenance: f.target.maintenance, requirePrivileges: true, addon: f.appReaders });

  it('declares the App origin-only read and retains independent producer and validator denials', async () => {
    expect(await appSource()).toMatchObject({ ready: true, catalogReady: true, failures: [] });
    expect(await appAudit()).toMatchObject({ ready: true, failures: [] });
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers)).ready).toBe(false);
    await expect(auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, f.peers, f.appReaders)).rejects.toThrow();
    expect(await f.appRuntime.db.execute(sql`SELECT * FROM public.cashier_second_card_origin_v1 LIMIT 0`)).toHaveLength(0);
    for (const query of [
      sql`SELECT * FROM public.cashier_second_card_cart_v1 LIMIT 0`,
      sql`SELECT * FROM public.cashier_second_card_payment_v1 LIMIT 0`,
      sql`DELETE FROM public.cashier_second_card_origin_v1 WHERE false`,
      sql`SELECT public.cashier_second_card_origin_valid_v1('invalid','{}'::jsonb)`,
    ]) await expect(f.appRuntime.db.execute(query)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(f.adminRuntime.db.execute(sql`SELECT * FROM public.cashier_second_card_origin_v1 LIMIT 0`)).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('replays the commissioned App reader forward without assigning an XID or repairing ACLs', async () => {
    const before = await authoritySnapshot();
    await f.maintenanceDb.transaction(async tx => {
      const [first] = await tx.execute(sql`SELECT pg_current_xact_id_if_assigned()::text AS xid`);
      expect(first.xid).toBeNull();
      expect(await upgradeRuntimeAppCashierOriginReaderInTransaction(tx, f.target, f.appReaders, f.peers)).toMatchObject({ changed: false });
      const [after] = await tx.execute(sql`SELECT pg_current_xact_id_if_assigned()::text AS xid`);
      expect(after.xid).toBeNull();
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
    expect(await authoritySnapshot()).toEqual(before);
    await expect(upgradeRuntimeAppCashierOriginReader(f.appRuntime.db, f.target, f.appReaders, f.peers)).rejects.toThrow();
    expect(await authoritySnapshot()).toEqual(before);
  });

  it('rolls the sole App read back with the caller transaction and then commissions the exact base profile', async () => {
    const role = pricingIdentifier(f.appRuntime.role), before = await authoritySnapshot();
    await f.exec(`REVOKE SELECT ON public.cashier_second_card_origin_v1 FROM ${role}`);
    try {
      expect((await appSource()).ready).toBe(false);
      expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers)).ready).toBe(true);
      const rollback = Error('Deliberate owned App reader transaction rollback');
      await expect(f.maintenanceDb.transaction(async tx => {
        expect(await upgradeRuntimeAppCashierOriginReaderInTransaction(tx, f.target, f.appReaders, f.peers)).toMatchObject({ changed: true });
        const [inside] = await tx.execute(sql`SELECT has_table_privilege(${f.appRuntime.role},'public.cashier_second_card_origin_v1','SELECT') AS ready`);
        expect(inside.ready).toBe(true); throw rollback;
      }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(rollback);
      expect((await appSource()).ready).toBe(false);
      expect(await upgradeRuntimeAppCashierOriginReader(f.maintenanceDb, f.target, f.appReaders, f.peers)).toMatchObject({ changed: true });
      expect(await appAudit()).toMatchObject({ ready: true, failures: [] });
    } finally {
      const [state] = await f.maintenanceDb.execute(sql`SELECT has_table_privilege(${f.appRuntime.role},'public.cashier_second_card_origin_v1','SELECT') AS ready`);
      if(state.ready!==true)await upgradeRuntimeAppCashierOriginReader(f.maintenanceDb, f.target, f.appReaders, f.peers);
    }
    expect(await authoritySnapshot()).toEqual(before);
  });

  it.each(['cashier_second_card_cart_v1', 'cashier_second_card_payment_v1'] as const)
    ('refuses unrelated App source read %s without repairing the extra ACL', async table => {
      const role = pricingIdentifier(f.appRuntime.role), before = await authoritySnapshot();
      await f.exec(`GRANT SELECT ON public.${pricingIdentifier(table)} TO ${role}`);
      try {
        expect((await appSource()).ready).toBe(false); expect((await appAudit()).ready).toBe(false);
        await expect(upgradeRuntimeAppCashierOriginReader(f.maintenanceDb, f.target, f.appReaders, f.peers)).rejects.toThrow();
        const [extra] = await f.maintenanceDb.execute(sql`SELECT has_table_privilege(${f.appRuntime.role},${'public.'+table},'SELECT') AS ready`);
        expect(extra.ready).toBe(true);
      } finally { await f.exec(`REVOKE SELECT ON public.${pricingIdentifier(table)} FROM ${role}`); }
      expect(await authoritySnapshot()).toEqual(before); expect(await appAudit()).toMatchObject({ ready: true, failures: [] });
    });

  it.each([[731669,0],[731670,0],[731625,2],[731685,0]])
    ('rejects an actual conflicting App source installation gate %i/%i', async (key, subkey) => {
      const before = await authoritySnapshot();
      await f.withMaintenancePeer(async peer => peer.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey})`);
        await expect(upgradeRuntimeAppCashierOriginReader(f.maintenanceDb, f.target, f.appReaders, f.peers)).rejects.toThrow();
      }, { isolationLevel: 'read committed', accessMode: 'read write' }));
      expect(await authoritySnapshot()).toEqual(before);
    });

  it('rejects an actual source table lock conflict before granting a missing App read', async () => {
    const before = await authoritySnapshot(), role = pricingIdentifier(f.appRuntime.role);
    await f.exec(`REVOKE SELECT ON public.cashier_second_card_origin_v1 FROM ${role}`);
    try {
      await f.withMaintenancePeer(async peer => peer.transaction(async tx => {
        await tx.execute(sql`LOCK TABLE ONLY public.cashier_second_card_origin_v1 IN ACCESS EXCLUSIVE MODE`);
        await expect(upgradeRuntimeAppCashierOriginReader(f.maintenanceDb, f.target, f.appReaders, f.peers)).rejects.toThrow();
      }, { isolationLevel: 'read committed', accessMode: 'read write' }));
      expect((await appSource()).ready).toBe(false);
    } finally { await upgradeRuntimeAppCashierOriginReader(f.maintenanceDb, f.target, f.appReaders, f.peers); }
    expect(await authoritySnapshot()).toEqual(before); expect(await appAudit()).toMatchObject({ ready: true, failures: [] });
  });

  it('opens independent same-principal peer backends for the existing concurrency fixtures', async () => {
    for (const runtime of [f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime]) {
      const primary = await runtime.verify();
      await runtime.withPeer(async (db, pid) => {
        const [identity] = await db.execute(sql`SELECT current_database() AS database,current_user AS role,
          session_user AS session,pg_backend_pid() AS pid,(SELECT r.rolname FROM pg_stat_activity a
            JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend`);
        expect(identity).toEqual({ database: f.database, role: runtime.role, session: runtime.role, pid, backend: runtime.role });
        expect(pid).not.toBe(primary);
      });
    }
  });

  it('allows source-approved gift reads and no-effect appends through actual LOGINs, with Admin and Manager remaining readers', async () => {
    const before = await authoritySnapshot();
    for (const runtime of [f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime])
      expect(await runtime.db.execute(sql`SELECT * FROM public.store_order_promotion_gift_coupon_reward LIMIT 0`)).toHaveLength(0);
    for (const runtime of [f.appRuntime, f.financialRuntime, f.cashierRuntime]) {
      const [privileges] = await runtime.db.execute(sql`SELECT has_table_privilege(current_user,'public.store_order_promotion_gift_coupon_reward','INSERT') AS append,
        has_sequence_privilege(current_user,'public.store_order_promotion_gift_coupon_reward_id_seq','USAGE') AS usage`);
      expect(privileges).toEqual({ append: true, usage: true });
      expect(await runtime.db.execute(sql`INSERT INTO public.store_order_promotion_gift_coupon_reward
        (order_id,uid,root_id,tier_id,auxiliary_id,issue_coupon_id,coupon_user_id)
        SELECT 1,1,1,1,1,1,1 WHERE false RETURNING id`)).toHaveLength(0);
    }
    for (const runtime of [f.adminRuntime, f.managerRuntime])
      await expect(runtime.db.execute(sql`INSERT INTO public.store_order_promotion_gift_coupon_reward
        (order_id,uid,root_id,tier_id,auxiliary_id,issue_coupon_id,coupon_user_id)
        SELECT 1,1,1,1,1,1,1 WHERE false`)).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await authoritySnapshot()).toEqual(before); await assertGiftReady();
  });

  it('does not infer undeclared Financial or Cashier peers from their existing grants', async () => {
    const before = await authoritySnapshot();
    const result = await inspectOrderPromotionGiftReceiptCatalog(f.maintenanceDb, f.target.maintenance,
      { app: f.target.app, admin: f.target.admin });
    expect(result.ready).toBe(false);
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, undefined, f.appReaders)).ready).toBe(false);
    expect((await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target)).ready).toBe(false);
    expect(await authoritySnapshot()).toEqual(before); await assertGiftReady();
  });

  it.each(['financial', 'cashierSecondCard', 'manager'] as const)('refuses an explicit declaration omitting the legitimate %s peer', async key => {
    const declaration = { ...f.peers }; delete declaration[key];
    const before = await authoritySnapshot(), result = await gift(declaration);
    expect(result.ready).toBe(false);
    // The remaining peers may independently prove their profiles; that never
    // authorizes the omitted role's global receipt ACL.
    expect(result.peerProof).toMatchObject({ ready: true, failures: [] });
    expect(await authoritySnapshot()).toEqual(before); await assertGiftReady();
  });

  it.each(['database', 'maintenance', 'app-admin', 'local-binding', 'case-binding'] as const)
    ('refuses a %s mismatch against the stored final routine target', async mutation => {
      const other = mutation === 'maintenance' || mutation === 'local-binding'
        ? await f.createOwnedRole('wrong_target', mutation === 'local-binding') : null;
      const target = mutation === 'database' ? { ...f.target, database: 'coexist_wrong_database_v14' }
        : mutation === 'maintenance' ? { ...f.target, maintenance: other!.role }
          : mutation === 'app-admin' ? { ...f.target, app: f.target.admin, admin: f.target.app }
            : mutation === 'local-binding' ? { ...f.target, local: [...(f.target.local ?? []), other!.role] }
              : { ...f.target, caseLock: { owner: f.target.caseLock!.owner, runtimeRoles: [...f.target.caseLock!.runtimeRoles, f.cashierRuntime.role] } };
      const before = await authoritySnapshot(), proof = await peerProof({ ...f.peers, target });
      expect(proof.ready).toBe(false); expect(proof.failures).toContain('peer_routine_binding');
      expect((await gift({ ...f.peers, target })).ready).toBe(false);
      expect(await authoritySnapshot()).toEqual(before); await assertGiftReady();
    });

  it('rejects an unknown NOLOGIN gift reader even when all three declared source profiles still prove ready', async () => {
    const other = await f.createOwnedRole('gift_reader'), role = pricingIdentifier(other.role), before = await authoritySnapshot();
    await f.exec(`GRANT SELECT ON public.store_order_promotion_gift_coupon_reward TO ${role}`);
    try {
      expect(await peerProof()).toMatchObject({ ready: true, failures: [] });
      expect((await gift()).ready).toBe(false);
      expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders)).ready).toBe(false);
    } finally { await f.exec(`REVOKE SELECT ON public.store_order_promotion_gift_coupon_reward FROM ${role}`); }
    expect(await authoritySnapshot()).toEqual(before); await assertGiftReady();
  });

  it.each([
    ['unrelated sensitive column', 'UPDATE(value) ON public.system_config'],
    ['gift DELETE', 'DELETE ON public.store_order_promotion_gift_coupon_reward'],
  ] as const)('rejects Financial %s authority before admitting its gift peer', async (_name, privilege) => {
    const role = pricingIdentifier(f.financialRuntime.role), before = await authoritySnapshot();
    await f.exec(`GRANT ${privilege} TO ${role}`);
    try {
      expect((await financialAudit()).ready).toBe(false);
      expect((await peerProof()).ready).toBe(false); expect((await gift()).ready).toBe(false);
    } finally { await f.exec(`REVOKE ${privilege} FROM ${role}`); }
    expect(await authoritySnapshot()).toEqual(before);
    expect(await financialAudit()).toMatchObject({ ready: true, realLogin: true, failures: [] }); await assertGiftReady();
  });

  it.each([
    ['origin validator', 'EXECUTE ON FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb)'],
    ['payment validator', 'EXECUTE ON FUNCTION public.cashier_second_card_payment_valid_v1(text,jsonb)'],
    ['published abandonment append', 'INSERT ON public.cashier_second_card_abandon_v1'],
    ['published abandonment read', 'SELECT ON public.cashier_second_card_abandon_v1'],
    ['cart source read', 'SELECT ON public.cashier_second_card_cart_v1'],
    ['payment source append', 'INSERT ON public.cashier_second_card_payment_v1'],
  ] as const)('rejects a Cashier missing %s with no gift exception and no profile repair', async (_name, privilege) => {
    const role = pricingIdentifier(f.cashierRuntime.role), before = await authoritySnapshot();
    await f.exec(`REVOKE ${privilege} FROM ${role}`);
    try {
      expect((await namedCashier()).ready).toBe(false);
      expect(await cashierAudit()).toMatchObject({ ready: false, giftSourcePrivileges: null });
      const proof = await peerProof(); expect(proof.ready).toBe(false);
      expect(proof.failures.some(name => name.startsWith('cashier:'))).toBe(true);
      expect((await gift()).ready).toBe(false);
    } finally { await f.exec(`GRANT ${privilege} TO ${role}`); }
    expect(await authoritySnapshot()).toEqual(before); await assertCashierReady(); await assertGiftReady();
  });

  it('requires the explicit published abandonment option instead of accepting a caller-selected smaller Cashier profile', async () => {
    const before = await authoritySnapshot();
    await expect(inspectCustomerCashierSecondCardRuntimePrivileges(f.maintenanceDb, {
      role: f.cashierRuntime.role, requireLogin: true, routine: { target: f.target, stage: 'ready' }, abandon: false,
    } as never)).rejects.toThrow('Explicit published second-card LOGIN, ready routine binding and abandon addon required');
    await expect(peerProof({ ...f.peers, cashierSecondCard: { role: f.cashierRuntime.role, abandon: false } } as never))
      .rejects.toThrow('Explicit independent bound cashier gift peer required');
    expect(await authoritySnapshot()).toEqual(before); await assertCashierReady(); await assertGiftReady();
  });

  it.each(['SELECT', 'UPDATE', 'USAGE WITH GRANT OPTION'] as const)('rejects Cashier gift sequence %s authority and restores the exact raw ACL', async privilege => {
    const role = pricingIdentifier(f.cashierRuntime.role), before = await authoritySnapshot();
    await f.exec(privilege === 'USAGE WITH GRANT OPTION'
      ? `GRANT USAGE ON SEQUENCE public.store_order_promotion_gift_coupon_reward_id_seq TO ${role} WITH GRANT OPTION`
      : `GRANT ${privilege} ON SEQUENCE public.store_order_promotion_gift_coupon_reward_id_seq TO ${role}`);
    try {
      expect(await cashierAudit()).toMatchObject({ ready: false, giftSourcePrivileges: null });
      expect((await peerProof()).ready).toBe(false); expect((await gift()).ready).toBe(false);
    } finally {
      await f.exec(privilege === 'USAGE WITH GRANT OPTION'
        ? `REVOKE GRANT OPTION FOR USAGE ON SEQUENCE public.store_order_promotion_gift_coupon_reward_id_seq FROM ${role}`
        : `REVOKE ${privilege} ON SEQUENCE public.store_order_promotion_gift_coupon_reward_id_seq FROM ${role}`);
    }
    expect(await authoritySnapshot()).toEqual(before); await assertCashierReady(); await assertGiftReady();
  });

  it('rejects Cashier gift table delegation while the underlying SELECT and INSERT remain present', async () => {
    const role = pricingIdentifier(f.cashierRuntime.role), before = await authoritySnapshot();
    await f.exec(`GRANT SELECT ON public.store_order_promotion_gift_coupon_reward TO ${role} WITH GRANT OPTION`);
    try {
      expect((await cashierAudit()).ready).toBe(false); expect((await gift()).ready).toBe(false);
    } finally { await f.exec(`REVOKE GRANT OPTION FOR SELECT ON public.store_order_promotion_gift_coupon_reward FROM ${role}`); }
    expect(await authoritySnapshot()).toEqual(before); await assertCashierReady(); await assertGiftReady();
  });

  it('rejects an established Cashier backend after NOLOGIN, preserving the LOGIN attributes on exact restoration', async () => {
    const role = pricingIdentifier(f.cashierRuntime.role), before = await authoritySnapshot();
    await f.cashierRuntime.verify(); await f.exec(`ALTER ROLE ${role} NOLOGIN`);
    try {
      expect((await namedCashier()).ready).toBe(false);
      expect(await cashierAudit()).toMatchObject({ ready: false, realLogin: true, giftSourcePrivileges: null });
      expect((await gift()).ready).toBe(false);
    } finally { await f.exec(`ALTER ROLE ${role} LOGIN`); }
    expect(await authoritySnapshot()).toEqual(before); await assertCashierReady(); await assertGiftReady();
  });

  it('rejects a Cashier executable unknown definer instead of granting a gift exception by role name', async () => {
    const role = pricingIdentifier(f.cashierRuntime.role), before = await authoritySnapshot();
    await f.exec(`CREATE FUNCTION public.coexist_unknown_definer_v14() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT 1';
      REVOKE ALL ON FUNCTION public.coexist_unknown_definer_v14() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.coexist_unknown_definer_v14() TO ${role}`);
    try {
      const result = await cashierAudit(); expect(result.ready).toBe(false); expect(result.giftSourcePrivileges).toBeNull();
      expect(result.failures).toContain('unreviewed_definer');
      expect((await peerProof()).ready).toBe(false); expect((await gift()).ready).toBe(false);
      expect((await auditCheckoutPricingLockRuntime(f.cashierRuntime.db, 'public', 'customer-work')).ready).toBe(false);
    } finally { await f.exec('DROP FUNCTION public.coexist_unknown_definer_v14()'); }
    expect(await authoritySnapshot()).toEqual(before); await assertCashierReady(); await assertGiftReady();
  });

  it.each(['renamed function', 'changed function body'] as const)('rejects a shared manual owner with a %s and restores the original OID, body and ACL', async mutation => {
    const before = await authoritySnapshot();
    const [original] = await f.maintenanceDb.execute<{ body: string; oid: string }>(sql`SELECT pg_get_functiondef(oid) AS body,oid::text AS oid
      FROM pg_proc WHERE oid='public.customer_manual_refund_promotion_delete_v1(integer,integer)'::regprocedure`);
    if (mutation === 'renamed function')
      await f.exec('ALTER FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) RENAME TO coexist_renamed_manual_v14');
    else await f.exec("CREATE OR REPLACE FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN 0; END'");
    try {
      expect((await inspectCustomerFinancialManualRefundRuntime(f.maintenanceDb,
        { role: f.cashierRuntime.role, promotionOwner: f.manual.promotionOwner, requirePrivileges: false })).ready).toBe(false);
      expect((await cashierSecondCardPromotionLockReadiness(f.cashierRuntime.db)).ready).toBe(false);
      expect((await cashierAudit()).ready).toBe(false); expect((await financialAudit()).ready).toBe(false);
      expect((await gift()).ready).toBe(false);
    } finally {
      if (mutation === 'renamed function')
        await f.exec('ALTER FUNCTION public.coexist_renamed_manual_v14(integer,integer) RENAME TO customer_manual_refund_promotion_delete_v1');
      else await f.exec(original.body);
    }
    const [restored] = await f.maintenanceDb.execute(sql`SELECT pg_get_functiondef(oid) AS body,oid::text AS oid
      FROM pg_proc WHERE oid='public.customer_manual_refund_promotion_delete_v1(integer,integer)'::regprocedure`);
    expect(restored).toEqual(original); expect(await authoritySnapshot()).toEqual(before);
    await assertCashierReady(); expect((await financialAudit()).ready).toBe(true); await assertGiftReady();
  });

  it('proves actual Cashier promotion and pricing readiness without granting any manual ledger access or manual capability EXECUTE', async () => {
    const [permissions] = await f.cashierRuntime.db.execute(sql`SELECT
      has_table_privilege(current_user,'public.customer_financial_manual_refund_v1','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS manual_table,
      has_any_column_privilege(current_user,'public.customer_financial_manual_refund_v1','SELECT,INSERT,UPDATE,REFERENCES') AS manual_columns,
      has_function_privilege(current_user,'public.customer_manual_refund_promotion_delete_v1(integer,integer)','EXECUTE') AS manual_execute,
      has_function_privilege(current_user,'public.manager_delete_order_promotions_v1(integer,jsonb)','EXECUTE') AS manager_execute`);
    expect(permissions).toEqual({ manual_table: false, manual_columns: false, manual_execute: false, manager_execute: false });
    await expect(f.cashierRuntime.db.execute(sql`SELECT * FROM public.customer_financial_manual_refund_v1 LIMIT 0`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(f.cashierRuntime.db.execute(sql`SELECT public.customer_manual_refund_promotion_delete_v1(1,1)`)).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await inspectCustomerFinancialManualRefundRuntime(f.maintenanceDb,
      { role: f.cashierRuntime.role, promotionOwner: f.manual.promotionOwner, requirePrivileges: false })).toMatchObject({ ready: true, catalogReady: true });
    expect((await cashierSecondCardPromotionLockReadiness(f.cashierRuntime.db)).ready).toBe(true);
    expect((await auditCheckoutPricingLockRuntime(f.cashierRuntime.db, 'public', 'customer-work')).ready).toBe(true);
    await assertCashierReady(); await assertGiftReady();
  });

  it.each(['financial', 'cashier'] as const)('keeps sensitive customer designation, configuration values and staff deletion denied to the actual %s LOGIN', async kind => {
    const runtime = kind === 'financial' ? f.financialRuntime : f.cashierRuntime, before = await authoritySnapshot();
    const [privileges] = await runtime.db.execute(sql`SELECT
      has_column_privilege(current_user,'public.store_service','customer','UPDATE') AS customer_write,
      has_column_privilege(current_user,'public.system_config','value','UPDATE') AS configuration_write,
      has_table_privilege(current_user,'public.system_admin','DELETE') AS staff_delete`);
    expect(privileges).toEqual({ customer_write: false, configuration_write: false, staff_delete: false });
    // The complete source plans retain other inherited App staff privileges;
    // this test claims only these specific sensitive denials, not an unproved
    // universal staff-write or conditional-guard boundary.
    for (const query of [sql`UPDATE public.store_service SET customer=customer WHERE false`,
      sql`UPDATE public.system_config SET value=value WHERE false`, sql`DELETE FROM public.system_admin WHERE false`])
      await expect(runtime.db.execute(query)).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await authoritySnapshot()).toEqual(before);
    expect((await (kind === 'financial' ? financialAudit() : cashierAudit())).ready).toBe(true);
  });

  it('ends with all five full source profiles ready and keeps inherited conditional Cashier business coverage explicitly unverified', async () => {
    const results = await Promise.all([
      auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders),
      auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, f.peers),
      financialAudit(), auditManagerRuntimePrivileges(f.managerRuntime.db, f.target), cashierAudit(),
    ]);
    for (const result of results) expect(result).toMatchObject({ ready: true, failures: [], completeServiceCoverageVerified: false });
    expect(results[4]).toMatchObject({ conditionalWriteSemanticsVerified: false }); await assertGiftReady();
  });
});
