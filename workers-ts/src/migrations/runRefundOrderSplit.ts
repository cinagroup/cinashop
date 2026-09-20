import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { INVOICE_MAINTENANCE_SETUP_SQL } from './invoiceEvidenceInstallation';
import { INVOICE_EVIDENCE_STATE_SQL } from './invoiceEvidenceCatalog';
import { REFUND_SPLIT_STATE_SQL } from './refundOrderSplitCatalog';
import { REFUND_SPLIT_INSTALLATION_SQL, REFUND_SPLIT_ORM_INSTALLATION_SQL } from './refundOrderSplitInstallation';

type Root = Pick<DbClient,'transaction'> & Partial<Pick<DbClient,'$client'>>;
type Query = Pick<DbClient,'execute'>;
type State = 'fresh' | 'v1' | 'orm-pending' | 'drift';
const setup=sql.raw(INVOICE_MAINTENANCE_SETUP_SQL);
function validate(db: Root,role?: string) {
  if(!Object.hasOwn(db,'$client') || !db.$client) throw Error('Refund split installation requires a root database');
  if(role!==undefined && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) throw Error('Invalid explicit refund runtime role');
}
async function environment(tx: Query) {
  const [row]=await tx.execute(sql`SELECT current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed'
    AND current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS safe`);
  if(row?.safe!==true) throw Error('Refund split inspection requires reviewed PG16 READ COMMITTED');
}
async function catalog(tx: Query): Promise<{state: State;invoiceProtectionReady: boolean}> {
  const [row]=await tx.execute(sql.raw(`SELECT refund.state,invoice.state='v2' AS invoice_ready
    FROM (${REFUND_SPLIT_STATE_SQL}) refund CROSS JOIN (${INVOICE_EVIDENCE_STATE_SQL}) invoice`));
  const state=row?.state;
  if(state!=='fresh' && state!=='v1' && state!=='orm-pending' && state!=='drift') throw Error('Refund catalog state unavailable');
  return {state,invoiceProtectionReady:row.invoice_ready===true};
}
async function runtimeSafe(tx: Query,role: string) {
  const [row]=await tx.execute(sql`WITH RECURSIVE authority AS (
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
async function ready(tx: Query,role: string,split: boolean) {
  const [row]=await tx.execute(sql`SELECT has_schema_privilege(${role},'public','USAGE')
    AND has_sequence_privilege(${role},'public.store_order_invoice_id_seq','USAGE')
    AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('public.store_order_invoice','SELECT',false),('public.store_order_invoice','INSERT',false),
      ('public.store_order_invoice','UPDATE',false),('public.store_order_invoice','DELETE',false),
      ('public.store_order_invoice_evidence','SELECT',false),('public.store_order_invoice_allocation','SELECT',false),
      ('public.store_order_invoice_allocation','INSERT',false),('public.store_order_refund_split','SELECT',true),
      ('public.store_order_refund_split','INSERT',true),('public.store_order_fulfillment_branch','SELECT',true),
      ('public.store_order_fulfillment_branch','INSERT',true)) p(tab,priv,ledger)
      WHERE NOT CASE WHEN ledger AND NOT ${split} THEN true ELSE has_table_privilege(${role},p.tab,p.priv) END) AS ready`);
  return row?.ready===true;
}

/** A read-only observation, not full application-role or history certification. */
export async function inspectRefundOrderSplit(db: Root,role: string) {
  validate(db,role);
  return db.transaction(async tx=>{
    await tx.execute(setup);await environment(tx);
    const state=await catalog(tx),safe=await runtimeSafe(tx,role);
    return {...state,runtimeSafe:safe,runtimeReady:safe && state.state==='v1' && state.invoiceProtectionReady && await ready(tx,role,true)};
  },{isolationLevel:'read committed',accessMode:'read only'});
}
/** Two additive SELECT/INSERT grants only. Invoice commissioning is required
 * beforehand and remains in the same transaction's final revalidation. */
export async function runRefundOrderSplit(db: Root,role: string,completeEmptyOrm=false) {
  validate(db,role);
  return db.transaction(async tx=>{
    await tx.execute(setup);await environment(tx);
    if(!await runtimeSafe(tx,role) || !(await catalog(tx)).invoiceProtectionReady || !await ready(tx,role,false))
      throw Error('Refund runtime authority or invoice prerequisites are unsafe or missing');
    await tx.execute(sql.raw(completeEmptyOrm ? REFUND_SPLIT_ORM_INSTALLATION_SQL : REFUND_SPLIT_INSTALLATION_SQL));
    await tx.execute(sql.raw(`GRANT SELECT,INSERT ON public.store_order_refund_split,public.store_order_fulfillment_branch TO "${role}"`));
    await environment(tx);const state=await catalog(tx);
    if(state.state!=='v1' || !state.invoiceProtectionReady || !await runtimeSafe(tx,role) || !await ready(tx,role,true))
      throw Error('Refund split catalog or runtime verification failed');
    return {...state,runtimeSafe:true,runtimeReady:true};
  },{isolationLevel:'read committed',accessMode:'read write'});
}
export async function runRefundOrderSplitSchema(db: Root,completeEmptyOrm=false): Promise<void> {
  validate(db);
  await db.transaction(tx=>tx.execute(sql.raw(completeEmptyOrm ? REFUND_SPLIT_ORM_INSTALLATION_SQL : REFUND_SPLIT_INSTALLATION_SQL)),
    {isolationLevel:'read committed',accessMode:'read write'});
}
export async function inspectRefundOrderSplitSchema(db: Root) {
  validate(db);
  return db.transaction(async tx=>{await tx.execute(setup);await environment(tx);return catalog(tx);},
    {isolationLevel:'read committed',accessMode:'read only'});
}
