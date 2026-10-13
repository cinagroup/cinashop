import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { refundEntityAcceptedPairSql } from './guestRefundEntityCatalog';
import { INVOICE_MAINTENANCE_SETUP_SQL, INVOICE_EVIDENCE_INSTALLATION_SQL, INVOICE_EVIDENCE_ORM_INSTALLATION_SQL } from './invoiceEvidenceInstallation';

type Root = Pick<DbClient,'transaction'> & Partial<Pick<DbClient,'$client'>>;
type Query = Pick<DbClient,'execute'>;
type State = 'fresh' | 'v1' | 'v2' | 'v3' | 'orm-pending' | 'drift';
export interface InvoiceEvidenceInspection {
  state: State;
  runtimeSafe: boolean;
  runtimeReady: boolean;
  /** Presence only, no private invoice rows and no invented historical baseline. */
  preInstallHistoryUnknown: boolean;
}
const setup = sql.raw(INVOICE_MAINTENANCE_SETUP_SQL);

function validate(db: Root, role: string) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Invoice installation requires a root database');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) throw Error('Invalid explicit invoice runtime role');
}
async function environment(tx: Query) {
  const [row] = await tx.execute(sql`SELECT
    current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed'
    AND current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS safe`);
  if (row?.safe !== true) throw Error('Invoice installation environment requires PG16 READ COMMITTED and reviewed triggers');
}
async function catalog(tx: Query): Promise<State> {
  const [row]=await tx.execute(sql.raw(`SELECT invoice AS state,split,profile FROM (${refundEntityAcceptedPairSql()}) entities`));
  const state=row?.state;
  if ((state==='v3' || row?.split==='v2') && (row?.profile!=='guest' || state!=='v3' || row.split!=='v2')) return 'drift';
  if (state==='fresh' || state==='v1' || state==='v2' || state==='v3' || state==='orm-pending' || state==='drift') return state;
  throw Error('Invoice catalog state unavailable');
}
/** Idempotent owner path only. It never installs the guest upgrade; all eight
 * components must already match before and after the original lock graph. */
export async function lockReviewedGuestRefundEntities(tx: Query): Promise<void> {
  if (Object.hasOwn(tx,'$client')) throw Error('Guest entity inspection requires the owning maintenance transaction');
  const [supported] = await tx.execute(sql`SELECT current_setting('transaction_read_only')='off'
    AND current_setting('search_path')='public, pg_temp' AND current_schema()='public'
    AND current_setting('row_security')='off'
    AND (SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') BETWEEN 1 AND 30000
    AND (SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout') BETWEEN 1 AND 1000
    AND (SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout') BETWEEN 1 AND 5000 AS safe`);
  if (supported?.safe!==true) throw Error('Guest entity idempotence requires bounded owner maintenance');
  await environment(tx);
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731611,0) AS locked`);
  if (gate?.locked!==true) throw Error('Evidence installation already running');
  if (await catalog(tx)!=='v3') throw Error('Complete guest entity catalog required');
  for (const table of ['store_order_invoice','store_order_invoice_evidence','store_order_invoice_allocation',
    'store_order_refund_split','store_order_fulfillment_branch'])
    await tx.execute(sql.raw(`LOCK TABLE public.${table} IN ACCESS EXCLUSIVE MODE NOWAIT`));
  await environment(tx);
  if (await catalog(tx)!=='v3') throw Error('Guest entity catalog changed during locking');
}
async function runtimeSafety(tx: Query, role: string): Promise<boolean> {
  const [row] = await tx.execute(sql`WITH RECURSIVE authority AS (
    SELECT oid FROM pg_roles WHERE rolname=${role}
    UNION SELECT m.roleid FROM pg_auth_members m JOIN authority a ON a.oid=m.member
  ) SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role} AND rolcanlogin)
    AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_roles r ON r.oid=a.oid
      WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
      OR r.rolname=current_user OR r.rolname IN ('pg_write_all_data','pg_execute_server_program','pg_write_server_files'))
    AND NOT EXISTS(SELECT 1 FROM authority WHERE has_schema_privilege(oid,'public','CREATE')
      OR has_parameter_privilege(oid,'session_replication_role','SET'))
    AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_namespace n ON n.nspowner=a.oid WHERE n.nspname='public') AS safe`);
  return row?.safe===true;
}
async function ready(tx: Query, role: string, state: State) {
  if (state!=='v2' && state!=='v3') return false;
  const [row] = await tx.execute(sql`SELECT
    has_schema_privilege(r.oid,'public','USAGE')
    AND has_sequence_privilege(r.oid,'public.store_order_invoice_id_seq','USAGE')
    AND has_table_privilege(r.oid,'public.store_order_invoice_evidence','SELECT')
    AS ready
    FROM pg_roles r WHERE rolname=${role}`);
  // has_* accepts a comma list as ANY, not ALL; verify every required privilege.
  const [all] = await tx.execute(sql`SELECT NOT EXISTS(
    SELECT 1 FROM (VALUES ('public.store_order_invoice','SELECT'),('public.store_order_invoice','INSERT'),
      ('public.store_order_invoice','UPDATE'),('public.store_order_invoice','DELETE'),
      ('public.store_order_invoice_allocation','SELECT'),('public.store_order_invoice_allocation','INSERT')) p(tab,priv)
    WHERE NOT has_table_privilege(${role},p.tab,p.priv)) AS ready`);
  return row?.ready===true && all?.ready===true;
}
async function unknownHistory(tx: Query, state: State) {
  if (state==='drift' || state==='orm-pending') return true;
  if (state==='fresh') {
    const [row] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM public.store_order_invoice) AS unknown`);
    return row?.unknown===true;
  }
  const [row] = await tx.execute(sql`SELECT EXISTS(
    SELECT 1 FROM public.store_order_invoice i WHERE NOT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence e
      WHERE e.invoice_id=i.id AND e.kind='created' AND e.document_number=''))
    OR EXISTS(SELECT 1 FROM public.store_order_invoice_evidence WHERE kind='unverified') AS unknown`);
  return row?.unknown===true;
}

/** Explicit maintenance-owner snapshot, not runtime admission or a provider audit.
 * No invoice payloads leave the database. An empty result cannot attest erased history. */
export async function inspectInvoiceEvidence(db: Root, role: string): Promise<InvoiceEvidenceInspection> {
  validate(db,role);
  return db.transaction(async tx => {
    await tx.execute(setup); await environment(tx);
    const state = await catalog(tx), runtimeSafe = await runtimeSafety(tx,role);
    return {state,runtimeSafe,runtimeReady:runtimeSafe && await ready(tx,role,state),
      preInstallHistoryUnknown:await unknownHistory(tx,state)};
  },{isolationLevel:'read committed',accessMode:'read only'});
}

/** Atomic fresh/v1->v2 installation. Never drops/replaces an existing object,
 * repairs unsafe ACLs, backfills old invoices or registers an HTTP/startup hook.
 * Only two additive runtime grants; base invoice privileges are prerequisites. */
export async function runInvoiceEvidence(db: Root, role: string, completeEmptyOrm = false): Promise<InvoiceEvidenceInspection> {
  validate(db,role);
  return db.transaction(async tx => {
    await tx.execute(setup); await environment(tx);
    if (!await runtimeSafety(tx,role)) throw Error('Invoice runtime authority is unsafe or missing');
    const guest = await catalog(tx)==='v3';
    if (guest) await lockReviewedGuestRefundEntities(tx);
    else await tx.execute(sql.raw(completeEmptyOrm ? INVOICE_EVIDENCE_ORM_INSTALLATION_SQL : INVOICE_EVIDENCE_INSTALLATION_SQL));
    await tx.execute(sql.raw(`GRANT SELECT ON public.store_order_invoice_evidence TO "${role}";
      GRANT SELECT,INSERT ON public.store_order_invoice_allocation TO "${role}"`));
    await environment(tx);
    const expected = guest ? 'v3' : 'v2';
    if (await catalog(tx)!==expected || !await runtimeSafety(tx,role) || !await ready(tx,role,expected))
      throw Error('Invoice runtime prerequisites or catalog verification failed');
    return {state:expected,runtimeSafe:true,runtimeReady:true,preInstallHistoryUnknown:await unknownHistory(tx,expected)};
  },{isolationLevel:'read committed',accessMode:'read write'});
}

/** Construction/upgrade protocol only; runtime commissioning remains separate. */
export async function runInvoiceEvidenceSchema(db: Root, completeEmptyOrm = false): Promise<void> {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Invoice schema installation requires a root database');
  await db.transaction(async tx=>{
    await tx.execute(setup); await environment(tx);
    if (await catalog(tx)==='v3') await lockReviewedGuestRefundEntities(tx);
    else await tx.execute(sql.raw(completeEmptyOrm ? INVOICE_EVIDENCE_ORM_INSTALLATION_SQL : INVOICE_EVIDENCE_INSTALLATION_SQL));
  },{isolationLevel:'read committed',accessMode:'read write'});
}

export async function inspectInvoiceEvidenceSchema(db: Root): Promise<State> {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Invoice schema inspection requires a root database');
  return db.transaction(async tx=>{await tx.execute(setup);await environment(tx);return catalog(tx);},
    {isolationLevel:'read committed',accessMode:'read only'});
}
