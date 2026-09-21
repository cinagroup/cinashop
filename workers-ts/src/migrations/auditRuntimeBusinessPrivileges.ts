import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { runtimeBusinessPrivilegePlan } from './runtimeBusinessPrivilegePlan';
import { inspectRuntimeAdminBoundary } from './runtimeAdminBoundary';
import { inspectRuntimeLockOnlyBoundary } from './runtimeLockOnlyBoundary';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { reviewedRuntimePricingCapabilities } from './reviewedRuntimePricingCapabilities';

/** Exact effective ACL comparison for the real connection, not SET ROLE on a
 * maintenance session. Readonly: never grants/revokes/repairs. The result proves
 * the declared profile and its two conditional-write boundaries, NOT complete
 * service coverage, HTTP authorization or production commissioning. */
export type RuntimeAuditStage = 'root'|'setup'|'identity'|'tables'|'columns'|'sequences'|'pricing'|'routines'|'defaults'|'staff'|'locks';
export async function auditRuntimeBusinessPrivileges(db: DbClient, kind:'app'|'admin', names:{app:string;admin:string;maintenance:string}, onStage?:(stage:RuntimeAuditStage)=>void) {
  onStage?.('root');
  if(!Object.hasOwn(db,'$client') || !db.$client)throw Error('Root connection required');
  // TypeScript structural callers may include deployment metadata. Only the
  // three declared LOGIN identities participate in this authority check.
  const identities=[names.app,names.admin,names.maintenance];
  identities.forEach(pricingIdentifier);
  if(new Set(identities).size!==3)throw Error('Distinct identities required');
  const plan=runtimeBusinessPrivilegePlan(kind),expectedRole=names[kind];
  return db.transaction(async tx=>{
    onStage?.('setup');
    await tx.execute(sql`SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
      set_config('idle_in_transaction_session_timeout','5000',true),set_config('search_path','public,pg_temp',true)`);
    onStage?.('identity');
    const [identity]=await tx.execute(sql`SELECT current_user AS role,session_user AS session,
      (SELECT r.rolname FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend,
      current_setting('server_version_num')::int/10000=16 AS version,
      NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls) AS restricted,
      r.rolcanlogin AS login,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS no_memberships,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o') AS no_ownership,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
        AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE') AS no_ddl,
      NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
        AND current_setting('session_replication_role')='origin' AS no_replication_bypass,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('public','information_schema') AND n.nspname NOT LIKE 'pg_%'
        AND CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
          WHEN c.relkind IN ('r','p','v','m','f') THEN pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END) AS no_other_schema_data
      FROM pg_catalog.pg_roles r WHERE rolname=current_user`);
    const failures:string[]=[];
    if(identity?.role!==expectedRole || identity?.session!==expectedRole || identity?.backend!==expectedRole)failures.push('connection_identity');
    for(const key of ['version','restricted','login','no_memberships','no_ownership','no_ddl','no_replication_bypass','no_other_schema_data'])
      if(identity?.[key]!==true)failures.push(key);
    onStage?.('tables');
    const tableRows=await tx.execute(sql`SELECT c.relname AS name,c.oid::text AS oid,c.relkind,c.relpersistence,
      c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid) AS nonordinary,
      p.privilege,pg_catalog.has_table_privilege(current_user,c.oid,p.privilege) AS allowed,
      pg_catalog.has_table_privilege(current_user,c.oid,p.privilege||' WITH GRANT OPTION') AS delegate
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
      WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f')`);
    const present=new Set<string>();
    for(const r of tableRows){
      const name=String(r.name),privilege=String(r.privilege);present.add(name);
      const expected=plan.tables[name]?.some(p=>p===privilege)??false;
      if(r.allowed!==expected || r.delegate!==false)failures.push('table:'+name+':'+privilege);
      if(plan.tables[name] && (r.relkind!=='r' || r.relpersistence!=='p' || r.nonordinary!==false))failures.push('shape:'+name);
    }
    for(const table of Object.keys(plan.tables))if(!present.has(table))failures.push('missing:'+table);
    onStage?.('columns');
    const columns=await tx.execute(sql`SELECT c.relname AS name,a.attname AS column,p.privilege,
      pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege) AS allowed,
      pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS delegate
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
    for(const r of columns){
      const table=String(r.name),column=String(r.column),privilege=String(r.privilege);
      const expected=(plan.tables[table]?.some(p=>p===privilege)??false)
        || (privilege==='UPDATE' && (plan.updateColumns[table]?.includes(column)??false));
      if(r.allowed!==expected || r.delegate!==false)failures.push('column:'+table+'.'+column+':'+privilege);
    }
    onStage?.('sequences');
    const sequences=await tx.execute(sql`SELECT s.relname AS name,
      (SELECT t.relname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class t ON t.oid=d.refobjid AND t.relnamespace=s.relnamespace
        WHERE d.classid='pg_catalog.pg_class'::regclass AND d.refclassid=d.classid AND d.objid=s.oid AND d.deptype IN('a','i') LIMIT 1) AS parent,
      pg_catalog.has_sequence_privilege(current_user,s.oid,'USAGE') AS usage,
      pg_catalog.has_sequence_privilege(current_user,s.oid,'SELECT,UPDATE') AS extras,
      pg_catalog.has_sequence_privilege(current_user,s.oid,'USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') AS delegate
      FROM pg_catalog.pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S'`);
    for(const r of sequences){
      const expected=plan.standaloneSequences.includes(String(r.name)) || (plan.tables[String(r.parent)]?.includes('INSERT')??false);
      if(r.usage!==expected || r.extras!==false || r.delegate!==false)failures.push('sequence:'+r.name);
    }
    for(const name of plan.standaloneSequences)if(!sequences.some(r=>r.name===name))failures.push('missing_sequence:'+name);
    onStage?.('pricing');
    const reviewed=kind==='app'?await reviewedRuntimePricingCapabilities(tx,'public','shared-shop'):{checkout:null,offline:null};
    onStage?.('routines');
    const [routines]=await tx.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname<>'information_schema' AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
      AND p.oid::text IS DISTINCT FROM ${reviewed.checkout} AND p.oid::text IS DISTINCT FROM ${reviewed.offline}) AS no_unreviewed_definer,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
        AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION')) AS no_delegation`);
    if(routines?.no_unreviewed_definer!==true || routines?.no_delegation!==true)failures.push('routine_authority');
    onStage?.('defaults');
    const [defaults]=await tx.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d
      CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
        OR (a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS safe`);
    if(defaults?.safe!==true)failures.push('default_grants');
    if(kind==='app' && (!reviewed.checkout || !reviewed.offline))failures.push('pricing_capabilities');
    onStage?.('staff');
    if(!(await inspectRuntimeAdminBoundary(tx,names.app,names.maintenance)).ready)failures.push('staff_boundary');
    onStage?.('locks');
    if(!(await inspectRuntimeLockOnlyBoundary(tx,names.app,names.admin,names.maintenance)).ready)failures.push('lock_only_boundary');
    const unique=[...new Set(failures)].sort();
    return {ready:unique.length===0,readOnly:true as const,completeServiceCoverageVerified:false as const,kind,
      failures:unique,tableCount:present.size,sequenceCount:sequences.length};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
