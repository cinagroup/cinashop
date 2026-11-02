import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';
import { captureAssignmentRuntimeDeclaration, ASSIGNMENT_SOURCE_TABLES,
  type AssignmentRuntimeDeclaration } from './fulfillmentAssignmentRuntimeDeclaration';
import { inspectStoreOrderFulfillmentAssignment, STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE } from './storeOrderFulfillmentAssignment';
import { inspectManagerAssignedFulfillment, MANAGER_ASSIGNED_FULFILLMENT_GATE,
  type ManagerAssignedFulfillmentBinding } from './managerAssignedFulfillment';
import { inspectManagerRuntimeCapabilities } from './managerRuntimeCapabilities';
import type { RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { ServiceUnavailableException } from '@/utils/errors';

type Query = Pick<DbClient, 'execute'>;
const sources = [...ASSIGNMENT_SOURCE_TABLES, 'user', 'system_store_staff', 'express_company'];
export function captureManagerAssignedRuntime(value: RuntimeGiftPeerDeclarations): AssignmentRuntimeDeclaration {
  const declaration = captureAssignmentRuntimeDeclaration(value);
  if (!declaration.managerAssignedWholeExpress) throw Error('Explicit Manager assigned receipt successor required');
  return declaration;
}
/** Dedicated exact LOGIN/catalog admission. It confers no staff, grant, source
 * or delivery authority; the business transaction proves those after root locks. */
export async function assertManagerAssignedTx(tx: Query, declaration: AssignmentRuntimeDeclaration,
  write: boolean): Promise<ManagerAssignedFulfillmentBinding> {
  try {
    if (Object.hasOwn(tx, '$client')) throw Error('Caller-owned assigned Manager transaction required');
    const t = declaration.target;
    for (const gate of [STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE, MANAGER_ASSIGNED_FULFILLMENT_GATE]) {
      const [r] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${gate[0]},${gate[1]}) AS ready`);
      if (r?.ready !== true) throw Error('Assignment or receipt maintenance is busy');
    }
    await tx.execute(sql`LOCK TABLE ONLY public.store_order_fulfillment_assignment,
      ONLY public.manager_assigned_fulfillment_request IN ACCESS SHARE MODE NOWAIT`);
    const assignment = await inspectStoreOrderFulfillmentAssignment(tx, { maintenance: t.maintenance, admin: t.admin });
    const receipt = await inspectManagerAssignedFulfillment(tx, { maintenance: t.maintenance });
    const b = receipt.binding, a = assignment.binding;
    if (!assignment.ready || !receipt.ready || !a || !b || b.database !== t.database || b.maintenance !== t.maintenance
      || b.manager !== MANAGER_RUNTIME_ROLE || a.databaseOid !== b.databaseOid || a.managerOid !== b.managerOid
      || a.maintenanceOid !== b.maintenanceOid || a.admin !== t.admin) throw Error('Named assignment/receipt binding required');
    const [actual] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_database()=${t.database}
      AND (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())=${b.databaseOid}
      AND current_user=${MANAGER_RUNTIME_ROLE} AND current_user=session_user AND pg_catalog.current_setting('role')='none'
      AND r.oid::text=${b.managerOid} AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
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
      AND pg_catalog.to_regclass('manager_assigned_fulfillment_request')=pg_catalog.to_regclass('public.manager_assigned_fulfillment_request')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(${JSON.stringify(sources)}::jsonb) n(name)
        LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(n.name))
        WHERE c.oid IS NULL OR c.relkind<>'r' OR c.relpersistence<>'p' OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity
          OR pg_catalog.to_regclass(pg_catalog.quote_ident(n.name)) IS DISTINCT FROM c.oid
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)) AS ready
      FROM pg_catalog.pg_roles r WHERE r.rolname=${MANAGER_RUNTIME_ROLE}`);
    if (actual?.ready !== true) throw Error('Actual fixed Manager LOGIN/database required');
    return b;
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('门店分配履约合同或实际店长账号尚未就绪，请保留原请求核对'), { cause });
  }
}
/** The existing reviewed capability supplies only a physical waybill fence.
 * No old store-owned GUC, fabricated scope or new raw UPDATE grant is used. */
export async function lockManagerAssignedWaybill(tx: DbClient): Promise<void> {
  const state = (await inspectManagerRuntimeCapabilities(tx)).waybill;
  if (!state.ready || !state.functionOid) throw new ServiceUnavailableException('店长面单读取栅栏尚未就绪');
  const [caller] = await tx.execute<{ ready: boolean }>(sql`SELECT current_user=${MANAGER_RUNTIME_ROLE}
    AND current_user=session_user AND pg_catalog.current_setting('role')='none'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=${MANAGER_RUNTIME_ROLE})
    AND pg_catalog.has_function_privilege(current_user,${state.functionOid}::oid,'EXECUTE') AS ready`);
  if (caller?.ready !== true) throw new ServiceUnavailableException('面单栅栏需要实际店长连接');
  await tx.execute(sql`SELECT public.manager_lock_waybill_v1()`);
}
