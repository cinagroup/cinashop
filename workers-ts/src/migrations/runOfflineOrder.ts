import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { INVOICE_MAINTENANCE_SETUP_SQL } from './invoiceEvidenceInstallation';
import { OFFLINE_STATE_SQL, OFFLINE_TABLES, OFFLINE_DISPATCH_COLUMNS } from './offlineOrderCatalog';
import { OFFLINE_INSTALLATION_SQL, OFFLINE_ORM_INSTALLATION_SQL } from './offlineOrderInstallation';

type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
type Query = Pick<DbClient, 'execute'>;
type State = 'fresh' | 'v1' | 'orm-pending' | 'drift';
const setup = sql.raw(INVOICE_MAINTENANCE_SETUP_SQL);
function validate(db: Root, role?: string) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Offline maintenance requires a root database');
  if (role !== undefined && (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role) || role.length > 63 || role.trim() !== role))
    throw Error('Invalid explicit offline runtime role');
}
async function environment(tx: Query) {
  const [row] = await tx.execute(sql`SELECT current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed'
    AND current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS safe`);
  if (row?.safe !== true) throw Error('Offline maintenance requires reviewed PG16 READ COMMITTED');
}
async function catalog(tx: Query): Promise<State> {
  const [row] = await tx.execute(sql.raw(OFFLINE_STATE_SQL));
  if (row?.state !== 'fresh' && row?.state !== 'v1' && row?.state !== 'orm-pending' && row?.state !== 'drift') throw Error('Offline catalog unavailable');
  return row.state;
}
async function runtimeSafe(tx: Query, role: string) {
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
  return row?.safe === true;
}
async function protocolPrivileges(tx: Query, role: string) {
  const [row] = await tx.execute(sql`SELECT has_schema_privilege(${role},'public','USAGE')
    AND has_function_privilege(${role},'public.ooa_lock_pricing()','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[${sql.join(OFFLINE_TABLES.map(name => sql`${name}`), sql`, `)}]::text[]) t(name)
      WHERE NOT has_table_privilege(${role},'public.'||name,'SELECT') OR NOT has_table_privilege(${role},'public.'||name,'INSERT'))
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[${sql.join(OFFLINE_DISPATCH_COLUMNS.map(name => sql`${name}`), sql`, `)}]::text[]) c(name)
      WHERE NOT has_column_privilege(${role},'public.offline_order_payment_dispatch',name,'UPDATE')) AS ready`);
  return row?.ready === true;
}
export async function inspectOfflineOrderSchema(db: Root) {
  validate(db);
  return db.transaction(async tx => { await tx.execute(setup); await environment(tx); return { state: await catalog(tx) }; },
    { isolationLevel: 'read committed', accessMode: 'read only' });
}
export async function runOfflineOrderSchema(db: Root, completeEmptyOrm = false): Promise<void> {
  validate(db);
  await db.transaction(tx => tx.execute(sql.raw(completeEmptyOrm ? OFFLINE_ORM_INSTALLATION_SQL : OFFLINE_INSTALLATION_SQL)),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
/** Protocol-only grants, not a claim that the complete application can run. */
export async function inspectOfflineOrder(db: Root, role: string) {
  validate(db, role);
  return db.transaction(async tx => {
    await tx.execute(setup); await environment(tx);
    const state = await catalog(tx), safe = await runtimeSafe(tx, role);
    return { state, runtimeSafe: safe, protocolPrivilegesReady: state === 'v1' && safe && await protocolPrivileges(tx, role) };
  }, { isolationLevel: 'read committed', accessMode: 'read only' });
}
export async function runOfflineOrder(db: Root, role: string, completeEmptyOrm = false) {
  validate(db, role);
  return db.transaction(async tx => {
    await tx.execute(setup); await environment(tx);
    if (!await runtimeSafe(tx, role)) throw Error('Offline runtime authority is unsafe or missing');
    await tx.execute(sql.raw(completeEmptyOrm ? OFFLINE_ORM_INSTALLATION_SQL : OFFLINE_INSTALLATION_SQL));
    await tx.execute(sql.raw(`GRANT SELECT,INSERT ON ${OFFLINE_TABLES.map(t => `public.${t}`).join(',')} TO "${role}";
      GRANT UPDATE(${OFFLINE_DISPATCH_COLUMNS.join(',')}) ON public.offline_order_payment_dispatch TO "${role}";
      GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO "${role}";`));
    await environment(tx);
    if (await catalog(tx) !== 'v1' || !await runtimeSafe(tx, role) || !await protocolPrivileges(tx, role))
      throw Error('Offline protocol catalog or privileges failed final verification');
    return { state: 'v1' as const, runtimeSafe: true, protocolPrivilegesReady: true };
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}
