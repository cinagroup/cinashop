/** Explicit owner-operated namespace commissioning only. No source/business
 * permissions, credential adoption, role creation or startup/HTTP integration. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { RECHARGE_REFUND_BINDING_VERSION, RECHARGE_REFUND_GATE,
  RECHARGE_REFUND_RUNTIME_TABLE_PRIVILEGES, RECHARGE_REFUND_STATE_UPDATE_COLUMNS,
  type RechargeRefundBinding } from './rechargeRefundContract';
import { inspectRechargeRefundCatalog, RECHARGE_REFUND_CATALOG_SQL } from './rechargeRefundCatalog';

const roleKeys = ['maintenance','app','admin','financial','manager'] as const;
const bindingKeys = ['database','databaseOid',...roleKeys.flatMap(role=>[role,role+'Oid'])] as const;
const runtimeRoles = ['admin','app','financial'] as const;
const fail = (reason: string): never => { throw Error('Recharge refund commissioning refused: '+reason); };

function captureBinding(input: RechargeRefundBinding): Readonly<RechargeRefundBinding> {
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))
  return fail('an exact independently reviewed binding is required');
 const fields=Object.getOwnPropertyDescriptors(input),names=Reflect.ownKeys(fields);
 if(names.length!==bindingKeys.length||bindingKeys.some(key=>!fields[key]?.enumerable||!('value'in fields[key])))
  return fail('the complete binding fields are required');
 const copy:Record<string,string>=Object.create(null);
 for(const key of bindingKeys) {
  const value:unknown=fields[key].value;
  if(typeof value!=='string'||!value||value.trim()!==value)return fail('invalid binding scalar');
  if(key.endsWith('Oid')) {
   if(!/^[1-9]\d{0,9}$/.test(value)||Number(value)>4_294_967_295)return fail('invalid binding OID');
  } else if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))return fail('invalid binding identifier');
  copy[key]=value;
 }
 if(new Set(roleKeys.map(role=>copy[role])).size!==5||new Set(roleKeys.map(role=>copy[role+'Oid'])).size!==5)
  return fail('five distinct login principals are required');
 return Object.freeze(copy) as unknown as Readonly<RechargeRefundBinding>;
}
function sameBinding(actual:RechargeRefundBinding|null,declared:RechargeRefundBinding):boolean {
 return !!actual&&bindingKeys.every(key=>actual[key as keyof RechargeRefundBinding]===declared[key as keyof RechargeRefundBinding]);
}
type Query=Pick<DbClient,'execute'>;

async function assertContext(tx:Query,b:RechargeRefundBinding):Promise<void> {
 const [context]=await tx.execute<{safe:boolean}>(sql`SELECT current_database()=${b.database}
  AND (SELECT d.oid::text FROM pg_catalog.pg_database d WHERE d.datname=current_database())=${b.databaseOid}
  AND current_user=session_user AND current_user=${b.maintenance} AND r.oid::text=${b.maintenanceOid}
  AND r.rolcanlogin AND r.rolsuper AND current_setting('role')='none'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid() AND a.usesysid=r.oid)
  AND current_setting('server_version_num')::integer/10000=16
  AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off'
  AND current_setting('session_replication_role')='origin' AND pg_catalog.current_schema()='public'
  AND current_setting('search_path')='public, pg_temp'
  AND current_setting('row_security')='off' AND current_setting('standard_conforming_strings')='on'
  AND (SELECT setting::bigint BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
  AND (SELECT setting::bigint BETWEEN 1 AND 1000 FROM pg_catalog.pg_settings WHERE name='lock_timeout')
  AND (SELECT setting::bigint BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS safe
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
 if(context?.safe!==true)return fail('direct PG16 maintenance identity/context does not match the declaration');
 const [roles]=await tx.execute<{safe:boolean}>(sql`WITH declared(role_key,name,oid_text) AS (VALUES
  ('maintenance',${b.maintenance},${b.maintenanceOid}),('app',${b.app},${b.appOid}),
  ('admin',${b.admin},${b.adminOid}),('financial',${b.financial},${b.financialOid}),('manager',${b.manager},${b.managerOid}))
 SELECT count(*)=5 AND count(DISTINCT r.oid)=5
  AND bool_and(r.oid IS NOT NULL AND r.oid::text=d.oid_text AND r.rolcanlogin
   AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
   AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT')
   AND CASE WHEN d.role_key='maintenance' THEN r.rolsuper
    ELSE NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
     AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid)
     AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
     AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
     AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
     AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
       AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
     AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d
       WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o') END) AS safe
 FROM declared d LEFT JOIN pg_catalog.pg_roles r ON r.rolname=d.name`);
 if(roles?.safe!==true)return fail('declared roles/OIDs, existing CONNECT/USAGE or isolation restrictions do not match');
}

async function observe(tx:Query,b:RechargeRefundBinding) {
 const catalog=await inspectRechargeRefundCatalog(tx,b);
 if(!catalog.present||!catalog.installed)return fail('an exact installed catalog is required');
 const rows=await tx.execute<Record<string,unknown>>(sql.raw(RECHARGE_REFUND_CATALOG_SQL));
 if(rows.length!==1)return fail('ambiguous catalog observation');
 const [comment]=await tx.execute<{value:string|null;bytes:number|null}>(sql`SELECT
  pg_catalog.obj_description(c.oid,'pg_class') AS value,
  pg_catalog.octet_length(pg_catalog.obj_description(c.oid,'pg_class')) AS bytes
  FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.recharge_refund_operation')`);
 if(!comment||typeof comment.value!=='string'||typeof comment.bytes!=='number'||comment.bytes>4096)
  return fail('binding comment is absent or exceeds the source-lock contract');
 return {catalog,raw:rows[0]};
}
export interface RechargeRefundCommissionResult {
 readonly binding:Readonly<RechargeRefundBinding>;
 readonly replayed:boolean;
}

/** The operator supplies real independently reviewed database/role OIDs.
 * Owner-only unbound installation may advance once; an identical commissioned
 * replay executes no GRANT/COMMENT. Any partial ACL/comment or role replacement
 * is rejected rather than repaired. Every write shares one root transaction. */
export async function runRechargeRefundRuntimeCommission(rootDb:DbClient,
 input:RechargeRefundBinding):Promise<Readonly<RechargeRefundCommissionResult>> {
 const binding=captureBinding(input),client=Object.getOwnPropertyDescriptor(rootDb,'$client');
 if(!client||!('value'in client)||!client.value||typeof client.value.begin!=='function')
  return fail('a root postgres-js database is required');
 return rootDb.transaction(rawTx=>commissionRechargeRefundRuntimeInTransaction(rawTx as unknown as DbClient,binding),{isolationLevel:'read committed',accessMode:'read write'});
}

export async function commissionRechargeRefundRuntimeInTransaction(tx:Query,
 input:RechargeRefundBinding):Promise<Readonly<RechargeRefundCommissionResult>> {
 const binding=captureBinding(input);
  if(Object.hasOwn(tx,'$client'))return fail('a root object cannot stand in for the transaction');
  await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
  await tx.execute(sql`SET LOCAL row_security TO off`);
  await tx.execute(sql`SET LOCAL standard_conforming_strings TO on`);
  await tx.execute(sql`SELECT
   pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
   pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
   pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
  await assertContext(tx,binding);
  const [gate]=await tx.execute<{held:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${RECHARGE_REFUND_GATE[0]},${RECHARGE_REFUND_GATE[1]}) AS held`);
  if(gate?.held!==true)return fail('maintenance/runtime gate is busy');
  await observe(tx,binding);
  await tx.execute(sql`LOCK TABLE ONLY public.recharge_refund_operation,ONLY public.recharge_refund_attempt,
   ONLY public.recharge_refund_result,ONLY public.recharge_refund_state IN ACCESS EXCLUSIVE MODE NOWAIT`);
  const before=await observe(tx,binding);
  if(before.catalog.commissioned) {
   if(!sameBinding(before.catalog.binding,binding)||before.raw.binding_safe!==true||before.raw.commissioned_acl!==true)
    return fail('commissioned binding differs from the complete declaration');
   await assertContext(tx,binding);
   return Object.freeze({binding,replayed:true});
  }
  if(before.catalog.binding!==null||before.raw.owner_only!==true||before.raw.unbound!==true
   ||before.raw.binding!==null||before.raw.binding_safe!==false||before.raw.commissioned_acl!==false)
   return fail('only the exact owner-only unbound installation may be commissioned');

  for(const role of runtimeRoles) {
   for(const [table,privileges] of Object.entries(RECHARGE_REFUND_RUNTIME_TABLE_PRIVILEGES[role]))
    await tx.execute(sql`GRANT ${sql.raw(privileges.join(','))} ON TABLE public.${sql.identifier(table)} TO ${sql.identifier(binding[role])}`);
   await tx.execute(sql`GRANT UPDATE (${sql.join(RECHARGE_REFUND_STATE_UPDATE_COLUMNS.map(column=>sql.identifier(column)),sql`,`)})
    ON TABLE public.recharge_refund_state TO ${sql.identifier(binding[role])}`);
   await tx.execute(sql`GRANT EXECUTE ON FUNCTION public.recharge_refund_valid_v1(pg_catalog.text,pg_catalog.jsonb),
    public.recharge_refund_lock_source_v1(pg_catalog.int4) TO ${sql.identifier(binding[role])}`);
  }
  const comment=JSON.stringify({version:RECHARGE_REFUND_BINDING_VERSION,...binding});
  await tx.execute(sql.raw("COMMENT ON TABLE public.recharge_refund_operation IS '"+comment.replaceAll("'","''")+"'"));
  const after=await observe(tx,binding);
  if(!after.catalog.commissioned||!sameBinding(after.catalog.binding,binding)
   ||after.raw.binding_safe!==true||after.raw.commissioned_acl!==true||after.raw.owner_only!==false||after.raw.unbound!==false)
   return fail('post-grant exact commissioning verification failed');
  await assertContext(tx,binding);
  return Object.freeze({binding,replayed:false});
}

