/** Explicit runtime declaration, not a new installer or grant plan.
 * Full five-profile inspection remains a commissioning/audit responsibility. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';
import { inspectStoreOrderFulfillmentAssignment, STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE,
  type StoreOrderFulfillmentAssignmentBinding } from './storeOrderFulfillmentAssignment';
import { ServiceUnavailableException } from '@/utils/errors';

import { ASSIGNMENT_SOURCE_TABLES, type AssignmentRuntimeDeclaration } from './fulfillmentAssignmentRuntimeDeclaration';
export { captureAssignmentRuntimeDeclaration, type AssignmentRuntimeDeclaration } from './fulfillmentAssignmentRuntimeDeclaration';
type Query = Pick<DbClient, 'execute'>;
/** Shared try-only gate and physical ACCESS SHARE fence survive through this
 * exact business transaction. Never changes ACLs, role, schema or objects. */
export async function assertAssignmentAdminTx(tx: Query, declaration: AssignmentRuntimeDeclaration,
  write: boolean): Promise<StoreOrderFulfillmentAssignmentBinding> {
  try {
    if (Object.hasOwn(tx, '$client')) throw Error('Caller-owned assignment transaction required');
    const t = declaration.target;
    const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(
      ${STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE[0]},${STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE[1]}) AS locked`);
    if (gate?.locked !== true) throw Error('Assignment maintenance is busy');
    // Catalog inspection below fails closed for missing/partial/drifted state;
    // this physical lock also prevents table DDL until the caller commits.
    await tx.execute(sql`LOCK TABLE ONLY public.store_order_fulfillment_assignment IN ACCESS SHARE MODE NOWAIT`);
    const catalog = await inspectStoreOrderFulfillmentAssignment(tx, { maintenance: t.maintenance, admin: t.admin, manager: MANAGER_RUNTIME_ROLE });
    const b = catalog.binding;
    if (!catalog.ready || !b || b.database !== t.database || b.maintenance !== t.maintenance || b.admin !== t.admin
      || b.manager !== MANAGER_RUNTIME_ROLE) throw Error('Named assignment catalog binding required');
    const [actual] = await tx.execute<{ ready: boolean }>(sql`SELECT
      pg_catalog.current_database()=${t.database}
      AND (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())=${b.databaseOid}
      AND current_user=${t.admin} AND current_user=session_user AND pg_catalog.current_setting('role')='none'
      AND r.oid::text=${b.adminOid} AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
      AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
        AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND pg_catalog.current_schema()='public' AND pg_catalog.current_setting('server_version_num')::integer/10000=16
      AND pg_catalog.current_setting('transaction_isolation')=${write ? 'read committed' : 'repeatable read'}
      AND pg_catalog.current_setting('transaction_read_only')=${write ? 'off' : 'on'}
      AND pg_catalog.current_setting('session_replication_role')='origin'
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
      AND pg_catalog.to_regclass('store_order_fulfillment_assignment')=pg_catalog.to_regclass('public.store_order_fulfillment_assignment')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(${JSON.stringify(ASSIGNMENT_SOURCE_TABLES)}::jsonb) n(name)
        LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(n.name))
        WHERE c.oid IS NULL OR c.relkind<>'r' OR c.relpersistence<>'p' OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity
          OR pg_catalog.to_regclass(pg_catalog.quote_ident(n.name)) IS DISTINCT FROM c.oid
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)) AS ready
      FROM pg_catalog.pg_roles r WHERE r.rolname=${t.admin}`);
    if (actual?.ready !== true) throw Error('Actual named assignment Admin LOGIN/database required');
    return b;
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('订单履约分配合同或实际后台账号尚未就绪，请保留原请求核对'), { cause });
  }
}
