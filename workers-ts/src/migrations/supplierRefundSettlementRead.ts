import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {ServiceUnavailableException} from '@/utils/errors';
import {pricingIdentifier} from './checkoutPricingLockCatalog';
import {assertSupplierOrderEditOperationReadable} from './supplierOrderEditOperation';
import {assertSupplierOfflinePaymentOperationReadable} from './supplierOfflinePaymentOperation';
import {assertSupplierManualRefundReady} from './supplierManualRefund';
import {assertSupplierProactiveRefundReadable} from './supplierProactiveRefund';

type Query=Pick<DbClient,'execute'>;
export const SUPPLIER_REFUND_SETTLEMENT_READ_TABLES=[
 'supplier_order_edit_operation_v1','supplier_offline_payment_operation_v1',
 'supplier_manual_refund_operation_v1','supplier_manual_refund_proof_v1',
 'supplier_proactive_refund_operation_v1','supplier_proactive_refund_decision_v1',
 'supplier_refund_money_payment_v1','supplier_refund_money_completion_v1',
] as const;
const names=sql.join(SUPPLIER_REFUND_SETTLEMENT_READ_TABLES.map(name=>sql`${name}`),sql`,`);
const functionNames=[
 'public.supplier_manual_refund_promotion_delete_v1(integer,integer)',
 'public.supplier_manual_refund_promotion_lock_v1()',
 'public.supplier_manual_refund_channel_lock_v1()',
] as const;
const unavailable=()=>new ServiceUnavailableException('累计供应商退款只读凭据或显式读取权限尚未就绪');

/** Metadata only: missing SELECT must not cause a 42501 and poison the caller's
 * snapshot. A normal whole-shop LOGIN may also hold reviewed append rights;
 * those do not grant this endpoint execution authority in its READ ONLY TX. */
function privileges(role:string|null) {
 const identity=role===null?sql`SELECT oid FROM pg_roles WHERE rolname IN(current_user,session_user)
  UNION SELECT usesysid FROM pg_stat_activity WHERE pid=pg_backend_pid()` : sql`SELECT oid FROM pg_roles WHERE rolname=${role}`;
 const target=role===null?sql`current_user`:sql`${role}::text`;
 return sql`WITH RECURSIVE identity(oid) AS(${identity}), authority(oid) AS(
  SELECT oid FROM identity UNION SELECT m.roleid FROM pg_auth_members m JOIN authority a ON a.oid=m.member
   WHERE m.set_option OR m.admin_option OR m.inherit_option),
  relations AS(SELECT * FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN(${names}))
 SELECT (SELECT count(*)=1 FROM identity) AS identity_unique,
 ${role===null?sql`current_user=session_user AND EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_roles r ON r.oid=b.usesysid
  WHERE b.pid=pg_backend_pid() AND r.rolname=session_user AND r.rolcanlogin)`:
  sql`EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role} AND rolcanlogin)`} AS login_safe,
 (SELECT count(*)=8 AND bool_and(relkind='r' AND has_table_privilege(${target},oid,'SELECT')) FROM relations) AS read,
 NOT EXISTS(SELECT 1 FROM authority a JOIN pg_roles r ON r.oid=a.oid WHERE
  r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
  OR has_parameter_privilege(r.oid,'session_replication_role','SET')
  OR has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
  OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND(n.nspowner=r.oid OR has_schema_privilege(r.oid,n.oid,'CREATE')))
  OR EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND(d.datdba=r.oid OR has_database_privilege(r.oid,d.oid,'CREATE')))
  OR EXISTS(SELECT 1 FROM relations c WHERE c.relowner=r.oid)
  OR EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN(to_regclass('public.store_order'),to_regclass('public.store_order_refund'),
   to_regclass('public.store_order_refund_split'),to_regclass('public.store_order_outbox')) AND c.relowner=r.oid)) AS role_safe,
 NOT EXISTS(SELECT 1 FROM authority a CROSS JOIN relations c WHERE c.relowner=a.oid
  OR has_table_privilege(a.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_any_column_privilege(a.oid,c.oid,'INSERT,UPDATE,REFERENCES')) AS tables_read_only,
 NOT EXISTS(SELECT 1 FROM authority a JOIN pg_class c ON c.oid=to_regclass('public.supplier_refund_money_payment_v1_id_seq')
  WHERE c.relowner=a.oid OR has_sequence_privilege(a.oid,c.oid,'USAGE,SELECT,UPDATE')) AS sequence_read_only,
 NOT EXISTS(SELECT 1 FROM authority a JOIN pg_proc p ON p.oid IN(${sql.join(functionNames.map(name=>sql`to_regprocedure(${name})`),sql`,`)})
  WHERE p.proowner=a.oid OR has_function_privilege(a.oid,p.oid,'EXECUTE')) AS functions_read_only`;
}
const safe=['identity_unique','login_safe','role_safe'] as const;
const pure=[...safe,'tables_read_only','sequence_read_only','functions_read_only'] as const;
async function inspectPrivileges(tx:Query,role:string|null) {
 const versions=await tx.execute<{pg16:boolean}>(sql`SELECT current_setting('server_version_num')::integer/10000=16 AS pg16`);
 if(versions.length!==1||versions[0].pg16!==true)return null;
 const rows=await tx.execute<Record<string,boolean>>(privileges(role));
 return rows.length===1?rows[0]:null;
}
async function assertCatalogs(tx:Query) {
 await assertSupplierOrderEditOperationReadable(tx);
 await assertSupplierOfflinePaymentOperationReadable(tx);
 await assertSupplierManualRefundReady(tx,'read');
 await assertSupplierProactiveRefundReadable(tx);
}
export async function supplierRefundSettlementReadReadiness(tx:Query) {
 const state=await inspectPrivileges(tx,null);
 if(!state||![...safe,'read'].every(key=>state[key]===true))return{
  ready:false,reason:'supplier_refund_settlement_read_privileges_unreviewed',state};
 try {await assertCatalogs(tx);return{ready:true,reason:'',state};}
 catch(cause){return{ready:false,reason:'supplier_refund_settlement_read_catalog_incompatible',state,cause};}
}
export async function assertSupplierRefundSettlementReadReady(tx:Query) {
 const readiness=await supplierRefundSettlementReadReadiness(tx);
 if(!readiness.ready)throw Object.assign(unavailable(),{cause:readiness});
}
/** Stronger commissioning contract for a dedicated reader. Runtime readiness
 * intentionally does not require this of an existing reviewed Supplier writer. */
export async function supplierRefundSettlementReadOnlyRole(tx:Query,role:string|null=null) {
 if(role!==null)pricingIdentifier(role);
 const state=await inspectPrivileges(tx,role);
 return{ready:state!==null&&[...pure,'read'].every(key=>state[key]===true),state};
}
export function supplierRefundSettlementReadGrantSql(role:string) {
 return `GRANT SELECT ON TABLE ${SUPPLIER_REFUND_SETTLEMENT_READ_TABLES.map(name=>'public.'+name).join(',')} TO ${pricingIdentifier(role)};`;
}
/** Explicit maintenance-only additive SELECT commissioning. No startup caller,
 * installation, role creation, ownership transfer, function grant or repair. */
export async function runSupplierRefundSettlementRead(db:Pick<DbClient,'transaction'>&Partial<Pick<DbClient,'$client'>>,role:string) {
 pricingIdentifier(role);
 if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Settlement read grants require root maintenance client');
 await db.transaction(async tx=>{
  await tx.execute(sql`SET LOCAL search_path=public,pg_temp`);
  await tx.execute(sql`SET LOCAL row_security=off`);
  await tx.execute(sql`SELECT set_config('statement_timeout','5000ms',true),set_config('lock_timeout','1500ms',true)`);
  const [environment]=await tx.execute<{ready:boolean}>(sql`SELECT current_setting('server_version_num')::integer/10000=16
   AND current_setting('transaction_read_only')='off' AND current_setting('transaction_isolation')='read committed'
   AND current_setting('session_replication_role')='origin' AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
   AND pg_try_advisory_xact_lock(731637,0)
   AND (SELECT count(*)=8 AND bool_and(pg_get_userbyid(relowner)=current_user) FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relname IN(${names})) AS ready`);
  if(environment?.ready!==true)throw Error('Settlement read grants require reviewed PG16 financial owner transaction');
  await tx.execute(sql.raw(`LOCK TABLE ${SUPPLIER_REFUND_SETTLEMENT_READ_TABLES.map(name=>'public.'+name).join(',')} IN SHARE MODE NOWAIT`));
  await assertCatalogs(tx);
  const before=await inspectPrivileges(tx,role);
  if(!before||!pure.every(key=>before[key]===true))throw Error('Settlement reader authority is not read-only');
  await tx.execute(sql.raw(supplierRefundSettlementReadGrantSql(role)));
  await assertCatalogs(tx);
  if(!(await supplierRefundSettlementReadOnlyRole(tx,role)).ready)throw Error('Settlement read grant postcheck failed');
 },{isolationLevel:'read committed',accessMode:'read write'});
}
