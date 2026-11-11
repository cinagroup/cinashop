/** Independent leaf: fixed catalog and declared named LOGINs only. No full
 * profile auditor is called here, so gift peer proofs cannot recurse. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { capturePurchasedLabelStorageTarget, inspectPurchasedLabelStorageCatalog, PURCHASED_LABEL_STORAGE_GATE } from './purchasedProductLabelStorage';
import { capturePurchasedLabelPrincipals, PURCHASED_LABEL_TABLE_PRIVILEGES, PURCHASED_LABEL_STATE_UPDATE } from './purchasedProductLabelPermissions';

type Query = Pick<DbClient, 'execute'>;
export const PURCHASED_LABEL_RUNTIME_VERSION = 'purchased-label-runtime-v1';
export interface PurchasedLabelRuntimeAddon { purchasedProductLabels: true }
export interface PurchasedLabelRuntimeBinding {
  version: typeof PURCHASED_LABEL_RUNTIME_VERSION;
  database: string; databaseOid: string; maintenance: string; maintenanceOid: string;
  app: string; appOid: string; admin: string; adminOid: string;
}
export function capturePurchasedLabelRuntimeAddon(input: PurchasedLabelRuntimeAddon): Readonly<PurchasedLabelRuntimeAddon> {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 1)
    throw Error('Explicit purchased label runtime declaration required');
  const d = Object.getOwnPropertyDescriptor(input, 'purchasedProductLabels');
  if (!d?.enumerable || !('value' in d) || d.value !== true) throw Error('Data-only purchased label runtime declaration required');
  return Object.freeze({ purchasedProductLabels: true });
}
export function capturePurchasedLabelRuntimeBinding(input: unknown): Readonly<PurchasedLabelRuntimeBinding> {
  const keys = ['version', 'database', 'databaseOid', 'maintenance', 'maintenanceOid', 'app', 'appOid', 'admin', 'adminOid'];
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== keys.length)
    throw Error('Complete purchased label runtime binding required');
  const row: Record<string, string> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string') throw Error('Data-only purchased label binding required');
    row[key] = d.value;
  }
  if (row.version !== PURCHASED_LABEL_RUNTIME_VERSION) throw Error('Purchased label runtime version differs');
  capturePurchasedLabelStorageTarget({ database: row.database!, maintenance: row.maintenance! });
  capturePurchasedLabelPrincipals({ app: row.app!, admin: row.admin! });
  for (const key of ['databaseOid', 'maintenanceOid', 'appOid', 'adminOid'])
    if (!/^[1-9]\d{0,9}$/u.test(row[key]!) || Number(row[key]) > 4294967295) throw Error('Exact purchased label OID required');
  if (new Set([row.maintenance, row.app, row.admin]).size !== 3 || new Set([row.maintenanceOid, row.appOid, row.adminOid]).size !== 3)
    throw Error('Independent purchased label principals required');
  return Object.freeze(row) as unknown as Readonly<PurchasedLabelRuntimeBinding>;
}

/** Resolves only explicitly named principals, never SELECT/INSERT grantees. */
export async function purchasedLabelNamedBinding(tx: Query, target: Pick<RoutinePaymentRuntimeTarget, 'database' | 'maintenance' | 'app' | 'admin'>) {
  if (!target || ![Object.prototype, null].includes(Object.getPrototypeOf(target))) throw Error('Plain named purchased label target required');
  const names: Record<string, string> = {};
  for (const key of ['database', 'maintenance', 'app', 'admin']) {
    const d = Object.getOwnPropertyDescriptor(target, key);
    if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string') throw Error('Data-only purchased label target required');
    names[key] = d.value;
  }
  const t = capturePurchasedLabelStorageTarget({ database: names.database!, maintenance: names.maintenance! });
  const p = capturePurchasedLabelPrincipals({ app: names.app!, admin: names.admin! });
  if ([p.app, p.admin].includes(t.maintenance)) throw Error('Independent purchased label maintenance required');
  const rows = await tx.execute<{ name: string; oid: string; safe: boolean; database: string; databaseOid: string }>(sql`SELECT
    r.rolname AS name,r.oid::text AS oid,pg_catalog.current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",
    pg_catalog.current_database()=${t.database} AND r.rolcanlogin AND CASE WHEN r.rolname=${t.maintenance} THEN r.rolsuper
      ELSE NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT')
      AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
        AND pg_catalog.has_schema_privilege(r.oid,oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d WHERE EXISTS(
        SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=r.oid)) END AS safe
    FROM pg_catalog.pg_roles r WHERE r.rolname IN(${t.maintenance},${p.app},${p.admin})`);
  const m = rows.find(r => r.name === t.maintenance), a = rows.find(r => r.name === p.app), d = rows.find(r => r.name === p.admin);
  if (rows.length !== 3 || rows.some(r => r.safe !== true) || !m || !a || !d) throw Error('Actual restricted purchased label LOGINs required');
  return capturePurchasedLabelRuntimeBinding({ version: PURCHASED_LABEL_RUNTIME_VERSION, database: m.database, databaseOid: m.databaseOid,
    maintenance: m.name, maintenanceOid: m.oid, app: a.name, appOid: a.oid, admin: d.name, adminOid: d.oid });
}
export async function inspectPurchasedLabelRuntime(tx: Query, target: RoutinePaymentRuntimeTarget, addon: PurchasedLabelRuntimeAddon) {
  capturePurchasedLabelRuntimeAddon(addon);
  const binding = await purchasedLabelNamedBinding(tx, target);
  const catalog = await inspectPurchasedLabelStorageCatalog(tx, { database: binding.database, maintenance: binding.maintenance },
    { app: binding.app, admin: binding.admin });
  if (!catalog.storageReady) return { ready: false, binding: null, failures: catalog.failures };
  const [comment] = await tx.execute<{ value: string | null }>(sql`SELECT pg_catalog.obj_description(
    pg_catalog.to_regclass('public.purchased_product_label_intent'),'pg_class') AS value`);
  if (typeof comment?.value !== 'string' || comment.value.length > 4096) return { ready: false, binding: null, failures: ['binding_absent'] };
  try {
    const stored = capturePurchasedLabelRuntimeBinding(JSON.parse(comment.value));
    if (comment.value !== JSON.stringify(stored) || JSON.stringify(stored) !== JSON.stringify(binding))
      return { ready: false, binding: null, failures: ['binding_differs'] };
  } catch { return { ready: false, binding: null, failures: ['binding_invalid'] }; }
  return { ready: true, binding, failures: [] as string[] };
}
export function applyPurchasedLabelRuntimePlan(plan: RuntimePrivilegePlan, kind: 'app' | 'admin') {
  for (const [table, privileges] of Object.entries(PURCHASED_LABEL_TABLE_PRIVILEGES[kind])) plan.tables[table] = [...privileges];
  plan.updateColumns.purchased_product_label_state = [...PURCHASED_LABEL_STATE_UPDATE[kind]];
}

export type PurchasedLabelRuntimePurpose = 'produce' | 'consume' | 'claim' | 'dispatch' | 'replay' | 'read';
/** No DDL, grants or SET ROLE. Shared metadata/physical fences survive until
 * the exact caller transaction commits. Complete profiles are proved by the
 * owner commissioning step; this leaf authenticates every actual executor. */
export async function assertPurchasedLabelRuntimeTx(tx: Query, target: RoutinePaymentRuntimeTarget, purpose: PurchasedLabelRuntimePurpose) {
  if (Object.hasOwn(tx, '$client')) throw Error('Purchased label caller transaction required');
  const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(
    ${PURCHASED_LABEL_STORAGE_GATE[0]},${PURCHASED_LABEL_STORAGE_GATE[1]}) AS locked`);
  if (gate?.locked !== true) throw Error('购买标签维护正在进行');
  await tx.execute(sql`LOCK TABLE ONLY public.purchased_product_label_intent,ONLY public.purchased_product_label_state,
    ONLY public.purchased_product_label_result IN ACCESS SHARE MODE NOWAIT`);
  const catalog = await inspectPurchasedLabelRuntime(tx, target, { purchasedProductLabels: true });
  if (!catalog.ready || !catalog.binding) throw Error('购买标签运行合同尚未就绪');
  const b = catalog.binding, allowed = purpose === 'consume' || purpose === 'claim' ? [b.app] : ['replay', 'read'].includes(purpose) ? [b.admin] : [b.app, b.admin];
  const source = ['store_order_outbox', 'store_order', 'store_order_cart_info', 'user', 'store_product', 'store_discounts', 'user_label', 'user_label_relation'];
  const [actual] = await tx.execute<{ safe: boolean }>(sql`SELECT current_user=session_user AND current_user IN(
    ${sql.join(allowed.map(r => sql`${r}`), sql`,`)}) AND pg_catalog.current_setting('role')='none'
    AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND pg_catalog.current_setting('server_version_num')::int/10000=16
    AND pg_catalog.current_setting('transaction_isolation')=${purpose === 'read' ? 'repeatable read' : 'read committed'}
    AND pg_catalog.current_setting('transaction_read_only')=${purpose === 'read' ? 'on' : 'off'}
    AND pg_catalog.current_setting('session_replication_role')='origin'
    AND pg_catalog.replace(pg_catalog.current_setting('search_path'),' ','')='public,pg_temp'
    AND pg_catalog.current_schema()='public'
    AND (SELECT count(*)=${source.length} AND bool_and(c.relkind='r' AND c.relpersistence='p' AND c.relowner::text=${b.maintenanceOid}
      AND NOT(c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules)
      AND pg_catalog.to_regclass(pg_catalog.quote_ident(c.relname))=c.oid
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid))
      FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN(
      ${sql.join(source.map(n => sql`${n}`), sql`,`)})) AS safe
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (actual?.safe !== true) throw Error('购买标签实际执行账号或事务不匹配');
  return b;
}
