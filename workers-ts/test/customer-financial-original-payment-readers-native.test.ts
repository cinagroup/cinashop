import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '../src/migrations/customerFinancialRuntimePlan';
import { auditCustomerFinancialRuntimePrivileges, inspectCustomerFinancialRuntimePrivileges } from '../src/migrations/auditCustomerFinancialRuntimePrivileges';
import { CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES, inspectCustomerFinancialOriginalPaymentReaders } from '../src/migrations/customerFinancialOriginalPaymentReaders';
import { upgradeCustomerFinancialOriginalPaymentReaders, upgradeCustomerFinancialOriginalPaymentReadersInTransaction } from '../src/migrations/upgradeCustomerFinancialOriginalPaymentReaders';
import { inspectRoutinePaymentRuntime } from '../src/migrations/routinePaymentRuntime';
import { pricingIdentifier } from '../src/migrations/checkoutPricingLockCatalog';
import { customerFinancialOriginalPaymentReadersFixture } from './helpers/customerFinancialOriginalPaymentReadersFixture';

// Candidate whole-file acceptance: genuine fixed LOGIN, canonical sources and
// exact full-profile auditing. Actual Manager/Admin/cashier payment provenance
// remains the separate complete offline-origin wholefile, never empty-ledger
// SELECTs or maintenance-authored source rows substituted as a paid positive.
describe.sequential('fixed Financial immutable original-payment reader forward on owned PG16', { timeout: 30000 }, () => {
  let f: Awaited<ReturnType<typeof customerFinancialOriginalPaymentReadersFixture>>;
  beforeAll(async () => { f = await customerFinancialOriginalPaymentReadersFixture(); }, 180000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider I/O in original-payment reader acceptance')); });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  const role = pricingIdentifier(CUSTOMER_FINANCIAL_RUNTIME_ROLE);
  const upgrade = () => upgradeCustomerFinancialOriginalPaymentReaders(f.db, f.target, f.addon, f.originalPaymentReaders);
  const audit = () => auditCustomerFinancialRuntimePrivileges(f.runtime, f.target, f.addon, f.originalPaymentReaders);
  const inspect = (requirePrivileges: boolean) => inspectCustomerFinancialOriginalPaymentReaders(f.db, {
    role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, maintenance: f.target.maintenance, readers: f.originalPaymentReaders, requirePrivileges,
  });
  const snapshot = async () => ({ credential: await f.credential(), history: await f.history(), raw: await f.rawAcl(),
    manualAcl: await f.financialAcl(), sourceAcl: await f.sourceAcl(), sources: await f.sourceRows(), business: await f.businessState(),
    manual: await f.manualRows(), ledger: await f.ledger() });
  const ready = async () => { expect(await audit()).toMatchObject({ ready: true, realLogin: true, failures: [] }); };

  it('keeps exact commissioned manual behavior while every complete source awaits its explicit read grant', async () => {
    expect(await auditCustomerFinancialRuntimePrivileges(f.runtime, f.target, f.addon)).toMatchObject({ ready: true });
    expect(await inspect(false)).toMatchObject({ ready: true, catalogReady: true, failures: [],
      tables: [...CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES], sourceWritesGranted: false, completeServiceCoverageVerified: false });
    expect(await inspect(true)).toMatchObject({ ready: false, catalogReady: true, failures: ['target_read'] });
    expect((await audit()).ready).toBe(false);
    await expect(f.runtime.execute(sql`SELECT * FROM public.cashier_second_card_origin_v1`)).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each(['owner', 'database', 'maintenance', 'prior', 'local'] as const)('refuses wrong %s without changing grants, history or credentials', async mutation => {
    const other = mutation === 'owner' ? await f.createOwnedRole('reader_other') : null;
    const target = mutation === 'database' ? { ...f.target, database: 'wrong_reader_database' }
      : mutation === 'maintenance' ? { ...f.target, maintenance: f.target.app }
        : mutation === 'prior' ? { ...f.target, app: f.target.admin, admin: f.target.app }
          : mutation === 'local' ? { ...f.target, local: [] } : f.target;
    const before = await snapshot();
    await expect(upgradeCustomerFinancialOriginalPaymentReaders(f.db, target,
      other ? { promotionOwner: other.role } : f.addon, f.originalPaymentReaders)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it.each(CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES)('refuses a partial pre-grant on %s rather than repairing the other sources', async table => {
    await f.exec(`GRANT SELECT ON public.${pricingIdentifier(table)} TO ${role}`);
    try {
      const before = await snapshot(); await expect(upgrade()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
    } finally { await f.exec(`REVOKE SELECT ON public.${pricingIdentifier(table)} FROM ${role}`); }
    expect((await auditCustomerFinancialRuntimePrivileges(f.runtime, f.target, f.addon)).ready).toBe(true);
  });

  it('requires an explicit exact reader option and the complete manual starting profile', async () => {
    const before = await snapshot();
    await expect(upgradeCustomerFinancialOriginalPaymentReaders(f.db, f.target, f.addon,
      { secondCard: true, unknown: true } as typeof f.originalPaymentReaders)).rejects.toThrow('Explicit complete');
    await expect(auditCustomerFinancialRuntimePrivileges(f.runtime, f.target, undefined, f.originalPaymentReaders))
      .rejects.toThrow('explicitly commissioned manual');
    expect(await snapshot()).toEqual(before);
  });

  const gates = [[731669, 0], [731670, 0], [731665, 1], [731695, 'public'], [731711, 0], [731626, 0],
    [731685, 0], [731627, 15], [731627, 16]] as const;
  it.each(gates)('refuses real held maintenance gate %s/%s without partial reads', async (key, subkey) => {
    const [namespace] = await f.db.execute<{ oid: number }>(sql`SELECT oid::integer AS oid FROM pg_namespace WHERE nspname='public'`);
    const before = await snapshot();
    await f.withPeer!(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},${subkey === 'public' ? namespace.oid : subkey})`);
      await expect(upgrade()).rejects.toThrow();
    }, { isolationLevel: 'read committed', accessMode: 'read write' }));
    expect(await snapshot()).toEqual(before);
  });

  it('honors caller rollback and tighter deadlines after the complete four-read audit succeeds', async () => {
    const before = await snapshot();
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout','3000',true),set_config('lock_timeout','700',true),
        set_config('idle_in_transaction_session_timeout','3000',true)`);
      expect(await upgradeCustomerFinancialOriginalPaymentReadersInTransaction(tx, f.target, f.addon, f.originalPaymentReaders))
        .toMatchObject({ changed: true, audit: { ready: true } });
      const [caps] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(caps).toEqual({ statement: '3s', lock: '700ms', idle: '3s' });
      throw Error('owned caller rollback');
    }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toThrow('owned caller rollback');
    expect(await snapshot()).toEqual(before);
  });

  it('atomically commissions only four reads while preserving the existing binding, manual profile, business and credential', async () => {
    const before = await snapshot(), result = await upgrade(), after = await snapshot();
    expect(result).toMatchObject({ changed: true, credentialChanged: false, historicalRowsReassigned: false,
      sourceWritesGranted: false, target: f.target, originalPaymentReaders: { secondCard: true }, audit: { ready: true } });
    expect({ ...after, sourceAcl: before.sourceAcl }).toEqual(before);
    expect(after.sourceAcl).not.toEqual(before.sourceAcl);
    expect((await inspectRoutinePaymentRuntime(f.db, f.target)).ready).toBe(true);
    expect((await auditCustomerFinancialRuntimePrivileges(f.runtime, f.target, f.addon)).ready).toBe(false);
    expect((await auditCustomerFinancialRuntimePrivileges(f.runtime, f.target)).ready).toBe(false);
    await ready();
  });

  it('replays the exact completed forward without transaction writes or credential rotation', async () => {
    const before = await snapshot();
    await f.db.transaction(async tx => {
      const [first] = await tx.execute(sql`SELECT txid_current_if_assigned()::text AS id`); expect(first.id).toBeNull();
      expect(await upgradeCustomerFinancialOriginalPaymentReadersInTransaction(tx, f.target, f.addon, f.originalPaymentReaders))
        .toMatchObject({ changed: false, audit: { ready: true } });
      const [last] = await tx.execute(sql`SELECT txid_current_if_assigned()::text AS id`); expect(last.id).toBeNull();
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
    expect(await snapshot()).toEqual(before); await ready();
  });

  it('uses the actual fixed LOGIN for all four reads and denies cashier creation, payment, source DML and validator EXECUTE', async () => {
    const [identity] = await f.runtime.execute(sql`SELECT current_user AS role,session_user AS session,
      pg_backend_pid() AS pid,(SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend`);
    const [owner] = await f.db.execute(sql`SELECT pg_backend_pid() AS pid`);
    expect(identity).toMatchObject({ role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, session: CUSTOMER_FINANCIAL_RUNTIME_ROLE, backend: CUSTOMER_FINANCIAL_RUNTIME_ROLE });
    expect(identity.pid).not.toBe(owner.pid);
    for (const table of CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES) {
      await f.runtime.execute(sql.raw(`SELECT * FROM public.${pricingIdentifier(table)} LIMIT 0`));
      for (const statement of [`INSERT INTO public.${pricingIdentifier(table)} SELECT * FROM public.${pricingIdentifier(table)} WHERE false`,
        `DELETE FROM public.${pricingIdentifier(table)} WHERE false`, `TRUNCATE public.${pricingIdentifier(table)}`])
        await expect(f.runtime.execute(sql.raw(statement))).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    await expect(f.runtime.execute(sql`SELECT * FROM public.cashier_second_card_cart_v1`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(f.runtime.execute(sql`SELECT public.cashier_second_card_origin_valid_v1('bad','{}'::jsonb)`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(f.runtime.execute(sql`SELECT public.cashier_second_card_payment_valid_v1('cash','{}'::jsonb)`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await ready();
  });

  it('refuses an existing backend after its fixed role is changed to NOLOGIN without rotating its credential', async () => {
    const before = await f.credential(); await f.exec(`ALTER ROLE ${role} NOLOGIN`);
    try { expect((await audit()).ready).toBe(false); await expect(upgrade()).rejects.toThrow(); }
    finally { await f.exec(`ALTER ROLE ${role} LOGIN`); }
    expect(await f.credential()).toEqual(before); await ready();
  });

  it.each(CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES)('reports missing %s SELECT and refuses to repair a partial installed reader profile', async table => {
    await f.exec(`REVOKE SELECT ON public.${pricingIdentifier(table)} FROM ${role}`);
    try {
      const before = await snapshot(); expect((await audit()).ready).toBe(false);
      expect(await inspect(true)).toMatchObject({ ready: false, catalogReady: true, failures: ['target_read'] });
      await expect(upgrade()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
    } finally { await f.exec(`GRANT SELECT ON public.${pricingIdentifier(table)} TO ${role}`); }
    await ready();
  });

  it.each(['cashier-index', 'cashier-validator', 'edit-trigger', 'partition-trigger', 'source-owner', 'owned-sequence'] as const)
    ('rejects %s catalog drift with exact restoration', async mutation => {
      let restore: () => Promise<unknown> = async () => {};
      if (mutation === 'cashier-index') {
        await f.exec('CREATE INDEX reader_unreviewed_v14 ON public.cashier_second_card_origin_v1(created_at)');
        restore = () => f.exec('DROP INDEX public.reader_unreviewed_v14');
      } else if (mutation === 'cashier-validator') {
        const [original] = await f.db.execute<{ body: string }>(sql`SELECT pg_get_functiondef('public.cashier_second_card_origin_valid_v1(text,jsonb)'::regprocedure) AS body`);
        await f.exec("CREATE OR REPLACE FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS 'SELECT true'");
        restore = () => f.exec(original.body);
      } else if (mutation.endsWith('trigger')) {
        const table = mutation === 'edit-trigger' ? 'supplier_order_edit_operation_v1' : 'legacy_order_gain_partition_v1';
        const trigger = mutation === 'edit-trigger' ? 'soeo_immutable_rows' : 'logp_immutable_rows';
        await f.exec(`ALTER TABLE public.${table} DISABLE TRIGGER ${trigger}`);
        restore = () => f.exec(`ALTER TABLE public.${table} ENABLE TRIGGER ${trigger}`);
      } else if (mutation === 'source-owner') {
        const other = await f.createOwnedRole('reader_owner');
        await f.exec(`ALTER TABLE public.cashier_second_card_payment_v1 OWNER TO ${pricingIdentifier(other.role)}`);
        restore = () => f.exec(`ALTER TABLE public.cashier_second_card_payment_v1 OWNER TO ${pricingIdentifier(f.target.maintenance)}`);
      } else {
        await f.exec('CREATE SEQUENCE public.reader_source_sequence_v14 OWNED BY public.cashier_second_card_origin_v1.order_id');
        restore = () => f.exec('DROP SEQUENCE public.reader_source_sequence_v14');
      }
      try {
        const before = await snapshot(); expect((await inspect(true)).catalogReady).toBe(false); expect((await audit()).ready).toBe(false);
        await expect(upgrade()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
      } finally { await restore(); }
      await ready();
    });

  it.each(['public', 'insert', 'column', 'execute', 'grant-option', 'set-writer', 'admin-writer', 'inherited-admin-writer'] as const)
    ('rejects %s source authority rather than accepting a read-looking principal', async mutation => {
      const writers: string[] = [];
      try {
        if (mutation === 'public') await f.exec('GRANT SELECT ON public.cashier_second_card_origin_v1 TO PUBLIC');
        if (mutation === 'insert') await f.exec(`GRANT INSERT ON public.supplier_order_edit_operation_v1 TO ${role}`);
        if (mutation === 'column') await f.exec(`GRANT SELECT(order_id) ON public.cashier_second_card_origin_v1 TO ${role}`);
        if (mutation === 'execute') await f.exec(`GRANT EXECUTE ON FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb) TO ${role}`);
        if (mutation === 'grant-option') await f.exec(`GRANT SELECT ON public.legacy_order_gain_partition_v1 TO ${role} WITH GRANT OPTION`);
        if (mutation.endsWith('writer')) {
          const writer = await f.createOwnedRole('reader_writer'); writers.push(writer.role);
          await f.exec(`GRANT INSERT ON public.cashier_second_card_payment_v1 TO ${pricingIdentifier(writer.role)}`);
          if (mutation === 'set-writer') await f.exec(`GRANT ${pricingIdentifier(writer.role)} TO ${role} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
          if (mutation === 'admin-writer') await f.exec(`GRANT ${pricingIdentifier(writer.role)} TO ${role} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
          if (mutation === 'inherited-admin-writer') {
            const middle = await f.createOwnedRole('reader_middle'); writers.push(middle.role);
            await f.exec(`GRANT ${pricingIdentifier(writer.role)} TO ${pricingIdentifier(middle.role)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
            await f.exec(`GRANT ${pricingIdentifier(middle.role)} TO ${role} WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`);
          }
        }
        const before = await snapshot(); expect((await inspect(true)).ready).toBe(false); expect((await audit()).ready).toBe(false);
        await expect(upgrade()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
      } finally {
        for (const writer of [...writers].reverse()) await f.exec(`REVOKE ${pricingIdentifier(writer)} FROM ${role} CASCADE; DROP OWNED BY ${pricingIdentifier(writer)} CASCADE`);
        await f.exec(`REVOKE SELECT ON public.cashier_second_card_origin_v1 FROM PUBLIC;
          REVOKE INSERT ON public.supplier_order_edit_operation_v1 FROM ${role};
          REVOKE SELECT(order_id) ON public.cashier_second_card_origin_v1 FROM ${role};
          REVOKE EXECUTE ON FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb) FROM ${role};
          REVOKE GRANT OPTION FOR SELECT ON public.legacy_order_gain_partition_v1 FROM ${role}`);
      }
      await ready();
    });

  it('retains whole-profile, default ACL and unknown definer refusal beyond the four source tables', async () => {
    await f.db.transaction(async tx => {
      await tx.execute(sql.raw(`ALTER DEFAULT PRIVILEGES FOR ROLE ${pricingIdentifier(f.target.maintenance)} IN SCHEMA public GRANT SELECT ON TABLES TO ${role}`));
      expect((await inspectCustomerFinancialRuntimePrivileges(tx, { requireLogin: true, routine: { target: f.target, stage: 'ready' },
        manualRefund: f.addon, originalPaymentReaders: f.originalPaymentReaders })).ready).toBe(false);
      throw Error('default ACL rollback');
    }).catch(error => { expect(error.message).toBe('default ACL rollback'); });
    await f.exec(`CREATE FUNCTION public.reader_unknown_definer_v14() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT 1';
      REVOKE ALL ON FUNCTION public.reader_unknown_definer_v14() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.reader_unknown_definer_v14() TO ${role}`);
    try { expect((await audit()).ready).toBe(false); await expect(upgrade()).rejects.toThrow(); }
    finally { await f.exec('DROP FUNCTION public.reader_unknown_definer_v14()'); }
    await f.exec(`GRANT UPDATE(value) ON public.system_config TO ${role}`);
    try { expect((await audit()).ready).toBe(false); await expect(upgrade()).rejects.toThrow(); }
    finally { await f.exec(`REVOKE UPDATE(value) ON public.system_config FROM ${role}`); }
    await ready();
  });
});
