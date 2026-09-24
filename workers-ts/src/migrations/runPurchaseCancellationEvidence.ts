import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { PURCHASE_CANCELLATION_STATE_SQL } from './purchaseCancellationEvidenceCatalog';
import { PURCHASE_CANCELLATION_SETUP_SQL, PURCHASE_CANCELLATION_SOURCE_SQL, PURCHASE_CANCELLATION_INSTALLATION_SQL, PURCHASE_CANCELLATION_ORM_INSTALLATION_SQL } from './purchaseCancellationEvidenceInstallation';

type Root = Pick<DbClient,'transaction'> & Partial<Pick<DbClient,'$client'>>;
type Query = Pick<DbClient,'execute'>;
function validate(db: Root, role?: string) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Purchase cancellation maintenance requires a root database');
  if (role!==undefined && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) throw Error('Invalid explicit purchase cancellation runtime role');
}
async function inspect(tx: Query) {
  const [environment] = await tx.execute(sql`SELECT current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS safe`);
  if (environment?.safe!==true) throw Error('Purchase cancellation inspection requires reviewed PG16 READ COMMITTED');
  const [row] = await tx.execute(sql.raw(`SELECT s.state,p.ready FROM (${PURCHASE_CANCELLATION_STATE_SQL}) s CROSS JOIN (${PURCHASE_CANCELLATION_SOURCE_SQL}) p`));
  const state = row?.state;
  if (state!=='fresh' && state!=='v1' && state!=='orm-pending' && state!=='drift') throw Error('Purchase cancellation catalog unavailable');
  return { state,sourcesReady:row.ready===true };
}
async function authority(tx: Query, role: string) {
  const [row] = await tx.execute(sql`WITH RECURSIVE roles AS (
    SELECT oid FROM pg_roles WHERE rolname=${role}
    UNION SELECT m.roleid FROM pg_auth_members m JOIN roles r ON r.oid=m.member
  ) SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role} AND rolcanlogin)
    AND NOT EXISTS(SELECT 1 FROM roles a JOIN pg_roles r ON r.oid=a.oid
      WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
        OR r.rolname IN (current_user,session_user,'pg_write_all_data','pg_execute_server_program','pg_write_server_files'))
    AND NOT EXISTS(SELECT 1 FROM roles WHERE has_schema_privilege(oid,'public','CREATE')
      OR has_parameter_privilege(oid,'session_replication_role','SET'))
    AND NOT EXISTS(SELECT 1 FROM roles r JOIN pg_namespace n ON n.nspowner=r.oid WHERE n.nspname='public')
    AND NOT EXISTS(SELECT 1 FROM roles r CROSS JOIN pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN ('store_order','store_order_cart_info','store_order_purchase_origin','store_order_status','user_bill','store_order_purchase_cancellation')
      AND (c.relowner=r.oid OR has_table_privilege(r.oid,c.oid,'TRIGGER'))) AS safe`);
  return row?.safe===true;
}
async function prerequisites(tx: Query, role: string) {
  const [row] = await tx.execute(sql`SELECT has_schema_privilege(${role},'public','USAGE')
    AND NOT EXISTS(SELECT 1 FROM (VALUES ('public.store_order'),('public.store_order_cart_info'),
      ('public.store_order_purchase_origin'),('public.store_order_status'),('public.user_bill')) t(name)
      WHERE NOT has_table_privilege(${role},t.name,'SELECT'))
    AND NOT EXISTS(SELECT 1 FROM (VALUES ('public.store_order'),('public.store_order_cart_info')) t(name)
      WHERE NOT has_column_privilege(${role},t.name,'id','UPDATE')) AS ready`);
  return row?.ready===true;
}
async function runtimeReady(tx: Query, role: string) {
  const [row] = await tx.execute(sql`SELECT has_table_privilege(${role},'public.store_order_purchase_cancellation','SELECT')
    AND has_table_privilege(${role},'public.store_order_purchase_cancellation','INSERT')
    AND NOT has_table_privilege(${role},'public.store_order_purchase_cancellation','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_function_privilege(${role},'public.begin_purchase_cancellation_v1()','EXECUTE')
    AND NOT has_function_privilege(${role},'public.capture_purchase_cancellation_v1()','EXECUTE')
    AND NOT has_function_privilege(${role},'public.validate_purchase_cancellation_v1()','EXECUTE')
    AND NOT has_function_privilege(${role},'public.protect_purchase_cancellation_v1()','EXECUTE') AS ready`);
  return row?.ready===true;
}
export async function inspectPurchaseCancellationEvidence(db: Root, role?: string) {
  validate(db,role);
  return db.transaction(async tx => {
    await tx.execute(sql.raw(PURCHASE_CANCELLATION_SETUP_SQL));
    const state = await inspect(tx);
    if (role===undefined) return state;
    const runtimeSafe = await authority(tx,role);
    return { ...state,runtimeSafe,runtimeReady:runtimeSafe && state.sourcesReady && state.state==='v1'
      && await prerequisites(tx,role) && await runtimeReady(tx,role) };
  },{ isolationLevel:'read committed',accessMode:'read only' });
}
export async function runPurchaseCancellationEvidenceSchema(db: Root): Promise<void> {
  validate(db);
  await db.transaction(tx => tx.execute(sql.raw(PURCHASE_CANCELLATION_INSTALLATION_SQL)),
    { isolationLevel:'read committed',accessMode:'read write' });
}
/** Separate empty-ORM construction follow-up; no grants, history or repair. */
export async function completePurchaseCancellationEvidenceOrm(db: Root): Promise<void> {
  validate(db);
  await db.transaction(tx => tx.execute(sql.raw(PURCHASE_CANCELLATION_ORM_INSTALLATION_SQL)),
    { isolationLevel:'read committed',accessMode:'read write' });
}
/** Only receipt SELECT/INSERT. Prerequisites must already exist; no schema or
 * role ownership, source repair, role creation, or quota-policy activation. */
export async function runPurchaseCancellationEvidence(db: Root, role: string) {
  validate(db,role);
  return db.transaction(async tx => {
    await tx.execute(sql.raw(PURCHASE_CANCELLATION_SETUP_SQL));
    const initial = await inspect(tx);
    if (!initial.sourcesReady || !['fresh','v1'].includes(initial.state) || !await authority(tx,role) || !await prerequisites(tx,role))
      throw Error('Purchase cancellation runtime authority or source prerequisites are unsafe or missing');
    await tx.execute(sql.raw(PURCHASE_CANCELLATION_INSTALLATION_SQL));
    await tx.execute(sql.raw(`GRANT SELECT,INSERT ON public.store_order_purchase_cancellation TO "${role}"`));
    const final = await inspect(tx);
    if (final.state!=='v1' || !final.sourcesReady || !await authority(tx,role)
      || !await prerequisites(tx,role) || !await runtimeReady(tx,role)) throw Error('Purchase cancellation runtime verification failed');
    return { ...final,runtimeSafe:true,runtimeReady:true };
  },{ isolationLevel:'read committed',accessMode:'read write' });
}
