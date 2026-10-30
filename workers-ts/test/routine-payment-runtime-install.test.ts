import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../src/lib/di';
import { paymentReconciliationAction, paymentReconciliationCase } from '../src/models/schema';
import { ROUTINE_IDENTITY_WITNESS_SQL } from '../src/migrations/routineIdentityWitness';
import { ROUTINE_PAYMENT_ATTEMPT_SQL } from '../src/migrations/routinePaymentAttempt';
import { auditRoutinePaymentRuntime, inspectRoutinePaymentRuntime, installRoutinePaymentRuntimeInTransaction,
  runRoutinePaymentRuntimeInstallation, type RoutinePaymentRuntimeTarget } from '../src/migrations/routinePaymentRuntime';
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';

describe('explicit routine storage installation on owned PG16 and independent LOGINs', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, target: RoutinePaymentRuntimeTarget;
  const peers: { role: string; oid: string; client: ReturnType<typeof postgres>; db: DbClient }[] = [];
  const rawState = () => f.db.execute(sql`SELECT * FROM (SELECT 'witness' AS kind,to_jsonb(w) AS row FROM public.routine_identity_witness w
    UNION ALL SELECT 'attempt',to_jsonb(a) FROM public.routine_payment_attempt a) saved ORDER BY kind,row::text`);
  const installed = () => runRoutinePaymentRuntimeInstallation(f.db, target);
  const audit = (index: number) => auditRoutinePaymentRuntime(peers[index].db,
    index === 0 ? 'app' : index === 1 ? 'admin' : 'local', target, index > 1 ? peers[index].role : undefined);
  async function originalRows() {
    await f.exec(`INSERT INTO public.routine_identity_witness VALUES('${randomUUID()}',11,12,1,'{"original":true}',1,'${'a'.repeat(64)}');
      INSERT INTO public.routine_payment_attempt VALUES('original_order','INITIATION','{"original":true}',1,'${'b'.repeat(64)}');`);
  }
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Actual owned PG16 required');
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL);
    f = await financePostgres([paymentReconciliationCase, paymentReconciliationAction], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX prc_provider_order_uq ON public.payment_reconciliation_case(provider,order_no)');
    const [identity] = await f.db.execute<{ database: string }>(sql`SELECT current_database() AS database`);
    if (!ownsFinanceFixtureTarget(identity.database, 'public', base.href)) throw Error('Unowned routine installation fixture');
    await f.exec(`REVOKE CREATE,TEMPORARY ON DATABASE "${identity.database}" FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    for (let index = 0; index < 3; index++) {
      const role = `routine_runtime_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const [row] = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${role}`);
      const endpoint = new URL(base.href); endpoint.pathname = `/${identity.database}`; endpoint.username = role; endpoint.password = password;
      const client = postgres(endpoint.href, { max: 1, prepare: false, connect_timeout: 5,
        connection: { options: '-c statement_timeout=5000 -c lock_timeout=1000 -c search_path=public' } });
      peers.push({ role, oid: row.oid, client, db: drizzle(client) as unknown as DbClient });
      const [actual] = await client`SELECT current_user AS role,session_user AS session,current_database() AS database`;
      expect(actual).toEqual({ role, session: role, database: identity.database });
    }
    target = { database: identity.database, maintenance: 'finance_test', app: peers[0].role, admin: peers[1].role, local: [peers[2].role] };
  }, 30000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider I/O in installation'));
    await f.exec(`DROP TABLE IF EXISTS public.routine_identity_witness; DROP FUNCTION IF EXISTS public.routine_identity_witness_immutable_v1();
      DROP TABLE IF EXISTS public.routine_payment_attempt; DROP FUNCTION IF EXISTS public.routine_payment_attempt_immutable_v1();`);
    for (const { role } of peers) await f.exec(`REVOKE ALL ON public.payment_reconciliation_action,public.payment_reconciliation_case FROM "${role}"`);
    await f.reset();
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => {
    try {
      for (const peer of peers) {
        await peer.client.end({ timeout: 5 });
        const [current] = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${peer.role}`);
        if (current?.oid !== peer.oid) throw Error('Owned runtime cleanup identity changed');
        await f.exec(`DROP OWNED BY "${peer.role}"; DROP ROLE "${peer.role}"`);
      }
    } finally { await f?.close(); }
  }, 30000);

  it('installs both exact immutable ledgers and only the three fixed addon profiles', async () => {
    expect(await installed()).toMatchObject({ applied: true, after: { ready: true }, baseProfilesVerified: false, historicalRowsReassigned: false });
    for (let index = 0; index < peers.length; index++) expect(await audit(index)).toMatchObject({ ready: true, realLogin: true, readOnly: true, baseProfilesVerified: false });
    await peers[0].client.unsafe(`INSERT INTO public.routine_identity_witness VALUES('${randomUUID()}',11,12,1,'{}',1,'${'a'.repeat(64)}');
      INSERT INTO public.routine_payment_attempt VALUES('local_login_order','INITIATION','{}',1,'${'b'.repeat(64)}')`);
    for (const peer of peers) {
      await peer.client.unsafe('SELECT * FROM public.routine_payment_attempt; SELECT * FROM public.payment_reconciliation_action');
      for (const statement of ['UPDATE public.routine_payment_attempt SET created_at=2', 'DELETE FROM public.routine_payment_attempt',
        'TRUNCATE public.routine_payment_attempt', 'UPDATE public.routine_identity_witness SET uid=2',
        'DELETE FROM public.routine_identity_witness', 'TRUNCATE public.routine_identity_witness',
        'SELECT public.routine_payment_attempt_immutable_v1()', 'SELECT public.routine_identity_witness_immutable_v1()',
        'CREATE TABLE public.forbidden_runtime_object(id int)']) await expect(peer.client.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
    }
    for (const peer of peers.slice(1)) {
      await expect(peer.client.unsafe(`INSERT INTO public.routine_payment_attempt VALUES('denied_order','PREPAY','{}',1,'${'c'.repeat(64)}')`)).rejects.toMatchObject({ code: '42501' });
      await expect(peer.client.unsafe('SELECT * FROM public.routine_identity_witness')).rejects.toMatchObject({ code: '42501' });
    }
    await expect(peers[2].client.unsafe('INSERT INTO public.payment_reconciliation_action DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
  });
  it('replays an exact installed profile without changing any original history', async () => {
    await installed(); await originalRows(); const before = await rawState();
    expect(await installed()).toMatchObject({ applied: false, after: { ready: true } });
    expect(await rawState()).toEqual(before);
  });
  it('adopts an exact owner-only pair without reconstructing or deleting history', async () => {
    await f.exec(ROUTINE_IDENTITY_WITNESS_SQL); await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL); await originalRows();
    const before = await rawState(); expect(await installed()).toMatchObject({ applied: true, before: { storageOnly: true }, after: { ready: true } });
    expect(await rawState()).toEqual(before);
  });
  it('rejects a partial ledger namespace without installing the other half', async () => {
    await f.exec(ROUTINE_IDENTITY_WITNESS_SQL);
    await expect(installed()).rejects.toThrow('preflight refused');
    expect(await f.db.execute(sql`SELECT to_regclass('public.routine_payment_attempt') AS other`)).toMatchObject([{ other: null }]);
  });
  it('rejects unknown prefixed objects instead of adopting their namespace', async () => {
    await f.exec('CREATE TABLE public.rpa_unknown(value integer)');
    try { await expect(installed()).rejects.toThrow('preflight refused'); }
    finally { await f.exec('DROP TABLE public.rpa_unknown'); }
  });
  it('rejects a changed immutable trigger body before any grants', async () => {
    await f.exec(ROUTINE_IDENTITY_WITNESS_SQL); await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL);
    await f.exec("CREATE OR REPLACE FUNCTION public.routine_payment_attempt_immutable_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS 'BEGIN RETURN NEW; END'");
    await expect(installed()).rejects.toThrow('preflight refused');
    expect((await f.db.transaction(tx => inspectRoutinePaymentRuntime(tx, target))).ready).toBe(false);
  });
  it.each(['UPDATE', 'SELECT WITH GRANT OPTION', 'SELECT,INSERT'])('refuses an unreviewed partial ACL %s without repairing it', async privilege => {
    await f.exec(ROUTINE_IDENTITY_WITNESS_SQL); await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL);
    await f.exec(`GRANT ${privilege.replace(' WITH GRANT OPTION','')} ON public.routine_payment_attempt TO "${peers[1].role}"${privilege.includes(' WITH GRANT OPTION') ? ' WITH GRANT OPTION' : ''}`);
    await expect(installed()).rejects.toThrow(/preflight refused|partial grants/);
    await expect(peers[0].client.unsafe('SELECT * FROM public.routine_payment_attempt')).rejects.toMatchObject({ code: '42501' });
  });
  it('rejects omitted or additional runtime identities instead of inferring them from grants', async () => {
    await installed();
    const changed = { ...target, local: [] };
    expect((await f.db.transaction(tx => inspectRoutinePaymentRuntime(tx, changed))).failures).toContain('ledger_acl');
    await expect(runRoutinePaymentRuntimeInstallation(f.db, changed)).rejects.toThrow('partial grants');
  });
  it('rolls back both newly created ledgers if action evidence is missing', async () => {
    await f.exec('ALTER TABLE public.payment_reconciliation_action RENAME TO fixture_action_retained');
    try {
      await expect(installed()).rejects.toThrow('action evidence table');
      expect(await f.db.execute(sql`SELECT to_regclass('public.routine_identity_witness') AS witness,
        to_regclass('public.routine_payment_attempt') AS attempt`)).toMatchObject([{ witness: null, attempt: null }]);
    } finally { await f.exec('ALTER TABLE public.fixture_action_retained RENAME TO payment_reconciliation_action'); }
  });
  it.each([731669, 731670])('refuses the live shared maintenance gate %s with no schema or ACL mutation', async gate => {
    await withFinancePeers(f.db, async ([peer]) => {
      let release!: () => void, ready!: () => void;
      const held = new Promise<void>(resolve => { ready = resolve; }), until = new Promise<void>(resolve => { release = resolve; });
      const holder = peer.db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${gate},0)`); ready(); await until; });
      await held;
      try { await expect(installed()).rejects.toThrow('maintenance is busy'); }
      finally { release(); await holder; }
    });
    expect(await f.db.execute(sql`SELECT to_regclass('public.routine_identity_witness') AS witness`)).toMatchObject([{ witness: null }]);
  });
  it('uses NOWAIT for existing ledger table locks and retains all old rows', async () => {
    await f.exec(ROUTINE_IDENTITY_WITNESS_SQL); await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL); await originalRows();
    const before = await rawState();
    await withFinancePeers(f.db, async ([peer]) => {
      let release!: () => void, ready!: () => void;
      const held = new Promise<void>(resolve => { ready = resolve; }), until = new Promise<void>(resolve => { release = resolve; });
      const holder = peer.db.transaction(async tx => { await tx.execute(sql`LOCK TABLE public.routine_payment_attempt IN SHARE MODE`); ready(); await until; });
      await held;
      try { await expect(installed()).rejects.toMatchObject({ cause: { code: '55P03' } }); }
      finally { release(); await holder; }
    });
    expect(await rawState()).toEqual(before);
    expect(await installed()).toMatchObject({ applied: true });
  });
  it('retains tighter caller statement, lock and idle limits', async () => {
    await f.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout','1s',true),set_config('lock_timeout','250ms',true),set_config('idle_in_transaction_session_timeout','2s',true)`);
      await installRoutinePaymentRuntimeInTransaction(tx, target);
      const [caps] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
        current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(caps).toEqual({ statement: '1s', lock: '250ms', idle: '2s' });
    });
  });
  it('refuses the wrong database and a nonmaintenance real LOGIN', async () => {
    await expect(runRoutinePaymentRuntimeInstallation(f.db, { ...target, database: 'wrong_database' })).rejects.toThrow('target requires review');
    await expect(runRoutinePaymentRuntimeInstallation(peers[0].db, target)).rejects.toThrow('target requires review');
  });
  it('requires a caller transaction and read-committed read-write maintenance', async () => {
    await expect(installRoutinePaymentRuntimeInTransaction(f.db, target)).rejects.toThrow('caller-owned');
    await expect(f.db.transaction(tx => installRoutinePaymentRuntimeInTransaction(tx, target), { isolationLevel: 'repeatable read' })).rejects.toThrow('target requires review');
    await expect(f.db.transaction(tx => installRoutinePaymentRuntimeInTransaction(tx, target), { accessMode: 'read only' })).rejects.toThrow('target requires review');
  });
  it('refuses a named role with elevated capabilities before installing anything', async () => {
    await f.exec(`ALTER ROLE "${peers[2].role}" CREATEDB`);
    try { await expect(installed()).rejects.toThrow('identities require review'); }
    finally { await f.exec(`ALTER ROLE "${peers[2].role}" NOCREATEDB`); }
  });
  it('binds the addon audit to the actual independently authenticated LOGIN', async () => {
    await installed();
    expect(await auditRoutinePaymentRuntime(peers[0].db, 'admin', target)).toMatchObject({ ready: false, realLogin: false });
    expect(await audit(0)).toMatchObject({ ready: true, realLogin: true });
  });
  async function lockOwner(run: (owner: string) => Promise<void>) {
    const owner = `routine_lock_owner_${randomUUID().replaceAll('-', '')}`;
    await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    const [identity] = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${owner}`);
    try { await run(owner); }
    finally {
      const [current] = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${owner}`);
      if (current?.oid !== identity.oid) throw Error('Owned case lock owner changed');
      await f.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`);
    }
  }
  it('atomically installs and replays the explicit local-only case capability with both ledgers', async () => {
    await lockOwner(async owner => {
      await f.exec(`GRANT SELECT ON public.payment_reconciliation_case TO "${peers[2].role}"`);
      const combined = { ...target, caseLock: { owner, runtimeRoles: [peers[2].role] } };
      expect(await runRoutinePaymentRuntimeInstallation(f.db, combined)).toMatchObject({ applied: true, after: { ready: true }, caseLock: { applied: true, ready: true } });
      expect(await runRoutinePaymentRuntimeInstallation(f.db, combined)).toMatchObject({ applied: false, after: { ready: true }, caseLock: { applied: false } });
      expect(await auditRoutinePaymentRuntime(peers[2].db, 'local', combined, peers[2].role)).toMatchObject({ ready: true, realLogin: true });
      expect((await f.db.transaction(tx => inspectRoutinePaymentRuntime(tx, target))).failures).toContain('local_case_lock_binding');
      await expect(peers[2].client.unsafe('UPDATE public.payment_reconciliation_case SET id=id')).rejects.toMatchObject({ code: '42501' });
      await expect(peers[0].client.unsafe("SELECT public.local_payment_case_lock_v1('forbidden_order')")).rejects.toMatchObject({ code: '42501' });
    });
  });
  it('rolls back ledgers and all addon grants if the declared lock-only owner is unsafe', async () => {
    await lockOwner(async owner => {
      await f.exec(`GRANT SELECT ON public.payment_reconciliation_case TO "${peers[2].role}","${owner}"`);
      const combined = { ...target, caseLock: { owner, runtimeRoles: [peers[2].role] } };
      await expect(runRoutinePaymentRuntimeInstallation(f.db, combined)).rejects.toThrow('unused restricted NOLOGIN');
      expect(await f.db.execute(sql`SELECT to_regclass('public.routine_identity_witness') AS witness,
        to_regclass('public.routine_payment_attempt') AS attempt,to_regprocedure('public.local_payment_case_lock_v1(text)') AS capability`))
        .toMatchObject([{ witness: null, attempt: null, capability: null }]);
      for (const peer of peers) await expect(peer.client.unsafe('SELECT * FROM public.routine_payment_attempt')).rejects.toMatchObject({ code: '42P01' });
    });
  });
  it('adds the declared case capability to already ready ledgers without changing their history or grants', async () => {
    await lockOwner(async owner => {
      await installed(); await originalRows();
      const before = await rawState();
      const grants = await f.db.execute(sql`SELECT relname,relacl::text FROM pg_catalog.pg_class
        WHERE relnamespace='public'::regnamespace AND relname IN('routine_identity_witness','routine_payment_attempt') ORDER BY relname`);
      await f.exec(`GRANT SELECT ON public.payment_reconciliation_case TO "${peers[2].role}"`);
      const combined = { ...target, caseLock: { owner, runtimeRoles: [peers[2].role] } };
      expect(await runRoutinePaymentRuntimeInstallation(f.db, combined)).toMatchObject({ applied: true, before: { ledgerReady: true },
        after: { ready: true }, caseLock: { applied: true } });
      expect(await rawState()).toEqual(before);
      expect(await f.db.execute(sql`SELECT relname,relacl::text FROM pg_catalog.pg_class
        WHERE relnamespace='public'::regnamespace AND relname IN('routine_identity_witness','routine_payment_attempt') ORDER BY relname`)).toEqual(grants);
      expect(await auditRoutinePaymentRuntime(peers[2].db, 'local', combined, peers[2].role)).toMatchObject({ ready: true });
    });
  });
});
