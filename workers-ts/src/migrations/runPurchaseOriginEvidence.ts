import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { PURCHASE_ORIGIN_STATE_SQL } from './purchaseOriginEvidenceCatalog';
import { PURCHASE_ORIGIN_SETUP_SQL, PURCHASE_ORIGIN_SOURCE_SQL, PURCHASE_ORIGIN_INSTALLATION_SQL, PURCHASE_ORIGIN_ORM_INSTALLATION_SQL } from './purchaseOriginEvidenceInstallation';

type Root = Pick<DbClient,'transaction'> & Partial<Pick<DbClient,'$client'>>;
type Query = Pick<DbClient,'execute'>;
function validate(db: Root, role?: string) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Purchase origin maintenance requires a root database');
  if (role !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) throw Error('Invalid explicit purchase origin runtime role');
}
async function inspect(tx: Query) {
  const [environment] = await tx.execute(sql`SELECT current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS safe`);
  if (environment?.safe !== true) throw Error('Purchase origin inspection requires reviewed PG16 READ COMMITTED');
  const [row] = await tx.execute(sql.raw(`SELECT s.state,p.ready FROM (${PURCHASE_ORIGIN_STATE_SQL}) s CROSS JOIN (${PURCHASE_ORIGIN_SOURCE_SQL}) p`));
  const state = row?.state;
  if (state !== 'fresh' && state !== 'v1' && state !== 'orm-pending' && state !== 'drift') throw Error('Purchase origin catalog unavailable');
  return { state, sourcesReady: row.ready === true };
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
    AND NOT EXISTS(SELECT 1 FROM roles r JOIN pg_class c ON c.relowner=r.oid WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN ('store_order','store_order_cart_info','store_order_purchase_origin')) AS safe`);
  return row?.safe === true;
}
async function prerequisites(tx: Query, role: string) {
  const [row] = await tx.execute(sql`SELECT has_schema_privilege(${role},'public','USAGE')
    AND NOT EXISTS(SELECT 1 FROM (VALUES ('public.store_order'),('public.store_order_cart_info')) t(name)
      WHERE NOT has_table_privilege(${role},t.name,'SELECT') OR NOT has_column_privilege(${role},t.name,'id','UPDATE')) AS ready`);
  return row?.ready === true;
}
async function runtimeReady(tx: Query, role: string) {
  const [row] = await tx.execute(sql`SELECT has_table_privilege(${role},'public.store_order_purchase_origin','SELECT')
    AND has_table_privilege(${role},'public.store_order_purchase_origin','INSERT')
    AND NOT has_table_privilege(${role},'public.store_order_purchase_origin','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_function_privilege(${role},'public.capture_purchase_origin_v1()','EXECUTE')
    AND NOT has_function_privilege(${role},'public.protect_purchase_origin_v1()','EXECUTE') AS ready`);
  return row?.ready === true;
}

export async function inspectPurchaseOriginEvidence(db: Root, role?: string) {
  validate(db, role);
  return db.transaction(async tx => {
    await tx.execute(sql.raw(PURCHASE_ORIGIN_SETUP_SQL));
    const state = await inspect(tx);
    if (role === undefined) return state;
    const runtimeSafe = await authority(tx, role);
    return { ...state, runtimeSafe, runtimeReady: runtimeSafe && state.sourcesReady && state.state === 'v1'
      && await prerequisites(tx, role) && await runtimeReady(tx, role) };
  }, { isolationLevel: 'read committed', accessMode: 'read only' });
}
export async function runPurchaseOriginEvidenceSchema(db: Root): Promise<void> {
  validate(db);
  await db.transaction(tx => tx.execute(sql.raw(PURCHASE_ORIGIN_INSTALLATION_SQL)),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
/** Explicit empty-ORM construction follow-up, never automatic runtime repair.
 * Completion is structural only and grants nothing to a runtime identity. */
export async function completePurchaseOriginEvidenceOrm(db: Root): Promise<void> {
  validate(db);
  await db.transaction(tx => tx.execute(sql.raw(PURCHASE_ORIGIN_ORM_INSTALLATION_SQL)),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
/** Explicit role only; two additive grants, no source privilege repair or role creation. */
export async function runPurchaseOriginEvidence(db: Root, role: string) {
  validate(db, role);
  return db.transaction(async tx => {
    await tx.execute(sql.raw(PURCHASE_ORIGIN_SETUP_SQL));
    const initial = await inspect(tx);
    if (!initial.sourcesReady || initial.state === 'drift' || !await authority(tx, role) || !await prerequisites(tx, role))
      throw Error('Purchase origin runtime authority or source prerequisites are unsafe or missing');
    await tx.execute(sql.raw(PURCHASE_ORIGIN_INSTALLATION_SQL));
    await tx.execute(sql.raw(`GRANT SELECT,INSERT ON public.store_order_purchase_origin TO "${role}"`));
    const final = await inspect(tx);
    if (final.state !== 'v1' || !final.sourcesReady || !await authority(tx, role)
      || !await prerequisites(tx, role) || !await runtimeReady(tx, role)) throw Error('Purchase origin runtime verification failed');
    return { ...final, runtimeSafe: true, runtimeReady: true };
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}
