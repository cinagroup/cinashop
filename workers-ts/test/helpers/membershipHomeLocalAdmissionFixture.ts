import { expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { PAYMENT_CALLBACK_PIPELINE_SQL } from '@/migrations/paymentCallbackPipeline';
import { PAYMENT_RECONCILIATION_SQL } from '@/migrations/paymentReconciliation';
import { ROUTINE_PAYMENT_ATTEMPT_SQL, inspectRoutinePaymentAttempt } from '@/migrations/routinePaymentAttempt';
import { membershipHomeFixture } from './membershipHomeFixture';
import { ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';
import { sortedDiyState, type DiyStateRow, type DiyStateSnapshot } from './diyStateFixture';

const protocolTables = ['payment_callback_event', 'payment_callback_outbox',
  'payment_reconciliation_action', 'payment_reconciliation_case', 'routine_payment_attempt'] as const;

/** Explicit native-only opt-in for the inherited owner-session HTTP suite.
 * Published DDL and the real local-admission reader execute unchanged. This is
 * storage/accounting acceptance, not an App/Admin runtime-role commission.
 * The shared browser/PGlite fixture and its mutable restore remain unchanged. */
export async function membershipHomeLocalAdmissionFixture() {
  const f = await membershipHomeFixture();
  try {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [identity] = await f.db.execute<{ database: string; schema: string; role: string; session: string;
      major: number; host: string; port: number; superuser: boolean }>(sql`SELECT current_database() AS database,
      current_schema() AS schema,current_user AS role,session_user AS session,
      current_setting('server_version_num')::integer/10000 AS major,
      host(inet_server_addr()) AS host,inet_server_port() AS port,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser`);
    if (!identity || identity.schema !== 'public' || identity.role !== 'finance_test'
      || identity.session !== identity.role || identity.major !== 16 || identity.superuser !== true
      || !ownsFinanceFixtureEndpoint(identity.database, 'public', base.href, identity.host, identity.port))
      throw Error('Membership local admission requires this process owned PG16 public fixture');
    const names = sql.join(protocolTables.map(name => sql`${name}`), sql`, `);
    const [fresh] = await f.db.execute<{ fresh: boolean }>(sql`SELECT
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
        AND relname IN (${names}))
      AND to_regprocedure('public.routine_payment_attempt_immutable_v1()') IS NULL AS fresh`);
    if (fresh?.fresh !== true) throw Error('Fresh membership local-admission storage required');
    await f.db.transaction(async tx => {
      await tx.execute(sql.raw(PAYMENT_CALLBACK_PIPELINE_SQL + PAYMENT_RECONCILIATION_SQL + ROUTINE_PAYMENT_ATTEMPT_SQL));
      expect(await inspectRoutinePaymentAttempt(tx)).toBe(true);
    });
    // The original fixture captured its mutable scope before these objects
    // existed. Its restore cannot truncate or reinsert any protocol table.
    expect(f.tables.some(name => (protocolTables as readonly string[]).includes(name))).toBe(false);
    const sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name
      FROM pg_catalog.pg_sequences WHERE schemaname='public' ORDER BY sequencename`))
      .map(row => row.name).filter(name => !f.sequences.includes(name));
    expect(sequences).toEqual(['payment_callback_event_id_seq', 'payment_callback_outbox_id_seq',
      'payment_reconciliation_action_id_seq', 'payment_reconciliation_case_id_seq']);

    async function protocolSnapshot(): Promise<DiyStateSnapshot> {
      const state: DiyStateSnapshot = {};
      for (const row of await f.db.execute<{ name: string; rows: DiyStateRow[] }>(sql.join(protocolTables.map(name =>
        sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows
          FROM public.${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
      state.__protocol_sequences = await f.db.execute(sql.join(sequences.map(name =>
        sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called
          FROM public.${sql.identifier(name)}`), sql` UNION ALL `));
      // Include object identities, owners, ACLs, full structural definitions,
      // dependencies and comments. No statistics/xids or secret role columns.
      state.__payment_admission_catalog = await f.db.execute(sql`WITH roots AS (
        SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname IN (${names})
      ), relations AS (
        SELECT oid FROM roots UNION SELECT indexrelid FROM pg_catalog.pg_index WHERE indrelid IN (SELECT oid FROM roots)
        UNION SELECT d.objid FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class c ON c.oid=d.objid
          WHERE d.classid='pg_catalog.pg_class'::regclass AND d.refobjid IN (SELECT oid FROM roots)
          AND d.deptype IN ('a','i') AND c.relkind='S'
      ), functions AS (
        SELECT 'public.routine_payment_attempt_immutable_v1()'::regprocedure::oid AS oid
      ) SELECT jsonb_build_object(
        'relations',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.relname,'owner',c.relowner,
          'acl',c.relacl,'kind',c.relkind,'persistence',c.relpersistence,'namespace',c.relnamespace,
          'checks',c.relchecks,'attributes',c.relnatts,'options',c.reloptions,'rls',c.relrowsecurity,
          'force_rls',c.relforcerowsecurity,'replica_identity',c.relreplident,'partition',c.relispartition,
          'access_method',c.relam,'row_type',c.reltype,'of_type',c.reloftype,'rules',c.relhasrules,
          'triggers',c.relhastriggers) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid IN (SELECT oid FROM relations)),
        'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a
          WHERE a.attrelid IN (SELECT oid FROM relations)),
        'defaults',(SELECT jsonb_agg(to_jsonb(d)||jsonb_build_object('expression',pg_catalog.pg_get_expr(d.adbin,d.adrelid))
          ORDER BY d.oid) FROM pg_catalog.pg_attrdef d WHERE d.adrelid IN (SELECT oid FROM relations)),
        'constraints',(SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('definition',pg_catalog.pg_get_constraintdef(c.oid))
          ORDER BY c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations)),
        'indexes',(SELECT jsonb_agg(to_jsonb(i)||jsonb_build_object('definition',pg_catalog.pg_get_indexdef(i.indexrelid))
          ORDER BY i.indexrelid) FROM pg_catalog.pg_index i WHERE i.indrelid IN (SELECT oid FROM roots)),
        'triggers',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('definition',pg_catalog.pg_get_triggerdef(t.oid))
          ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN (SELECT oid FROM roots)),
        'functions',(SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('definition',pg_catalog.pg_get_functiondef(p.oid))
          ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid IN (SELECT oid FROM functions)),
        'sequence_definitions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.seqrelid) FROM pg_catalog.pg_sequence s
          WHERE s.seqrelid IN (SELECT oid FROM relations)),
        'types',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_type t
          WHERE t.typrelid IN (SELECT oid FROM roots) OR t.typelem IN
            (SELECT reltype FROM pg_catalog.pg_class WHERE oid IN (SELECT oid FROM roots))),
        'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_catalog.pg_rewrite r
          WHERE r.ev_class IN (SELECT oid FROM roots)),
        'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p
          WHERE p.polrelid IN (SELECT oid FROM roots)),
        'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype)
          FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid IN (SELECT oid FROM relations)
          OR d.classid='pg_catalog.pg_proc'::regclass AND d.objid IN (SELECT oid FROM functions)),
        'comments',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.classoid,d.objoid,d.objsubid) FROM pg_catalog.pg_description d
          WHERE d.classoid='pg_catalog.pg_class'::regclass AND d.objoid IN (SELECT oid FROM relations)
          OR d.classoid='pg_catalog.pg_proc'::regclass AND d.objoid IN (SELECT oid FROM functions)
          OR d.classoid='pg_catalog.pg_constraint'::regclass AND d.objoid IN
            (SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN (SELECT oid FROM roots))
          OR d.classoid='pg_catalog.pg_trigger'::regclass AND d.objoid IN
            (SELECT oid FROM pg_catalog.pg_trigger WHERE tgrelid IN (SELECT oid FROM roots))
          OR d.classoid='pg_catalog.pg_type'::regclass AND d.objoid IN
            (SELECT oid FROM pg_catalog.pg_type WHERE typrelid IN (SELECT oid FROM roots))),
        'owner',(SELECT jsonb_build_object('oid',r.oid,'name',r.rolname,'superuser',r.rolsuper,'login',r.rolcanlogin,
          'inherit',r.rolinherit,'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,'replication',r.rolreplication,
          'bypassrls',r.rolbypassrls) FROM pg_catalog.pg_roles r WHERE r.rolname=current_user)
      ) AS value`);
      return sortedDiyState(state);
    }
    const protocolBaseline = await protocolSnapshot();
    for (const table of protocolTables) expect(protocolBaseline[table]).toEqual([]);
    const allTables = [...f.tables, ...protocolTables].sort();
    async function assertProtocolUnchanged() {
      expect(await protocolSnapshot()).toEqual(protocolBaseline);
      const actual = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_catalog.pg_tables
        WHERE schemaname='public' ORDER BY tablename`)).map(row => row.name);
      expect(actual).toEqual(allTables);
    }
    async function snapshot(): Promise<DiyStateSnapshot> {
      await assertProtocolUnchanged();
      const business = await f.snapshot(), protocol = await protocolSnapshot();
      const { __protocol_sequences, ...rows } = protocol;
      return sortedDiyState({ ...business, ...rows, __sequences: [...business.__sequences, ...__protocol_sequences] });
    }
    async function restore() {
      await assertProtocolUnchanged();
      await f.restore();
      await assertProtocolUnchanged();
    }
    async function close() {
      try { await assertProtocolUnchanged(); } finally { await f.close(); }
    }
    return { ...f, snapshot, restore, close, baseline: await snapshot(),
      tables: allTables, sequences: [...f.sequences, ...sequences].sort(),
      protocolBaseline, assertProtocolUnchanged, fullRuntimeRoleCommissioned: false as const };
  } catch (error) { await f.close(); throw error; }
}
