import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {inspectManagerOrderOperation} from './runManagerOrderOperation';
import {pricingIdentifier} from './checkoutPricingLockCatalog';
type Query=Pick<DbClient,'execute'>;

/** This realm is a payment-history reader, never a manager operation writer.
 * The published manager shape pin stays unchanged; ownership and effective
 * privileges are additional facts about this deployment and actual LOGIN. */
function privileges(role:string|null){
 const identity=role===null?sql`SELECT oid FROM pg_roles WHERE rolname IN(current_user,session_user) UNION SELECT usesysid FROM pg_stat_activity WHERE pid=pg_backend_pid()` : sql`SELECT oid FROM pg_roles WHERE rolname=${role}`;
 const target=role===null?sql`current_user`:sql`${role}::text`;
 return sql`WITH RECURSIVE identity(oid) AS(${identity}),authority(oid) AS(
 -- ADMIN may also be held through inherited roles, and can change SET options.
 -- Such authority is not read-only because direct SET/INHERIT is false.
 SELECT oid FROM identity UNION SELECT m.roleid FROM pg_auth_members m JOIN authority a ON a.oid=m.member WHERE m.set_option OR m.admin_option OR m.inherit_option),
 ledger AS(SELECT * FROM pg_class WHERE oid=to_regclass('public.manager_order_operation_request'))
 SELECT current_setting('server_version_num')::integer/10000=16 AS pg16,
 (SELECT count(*)=1 FROM identity) AS identity_unique,
 ${role===null?sql`current_user=session_user AND EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_roles r ON r.oid=b.usesysid WHERE b.pid=pg_backend_pid() AND r.rolname=session_user AND r.rolcanlogin)` : sql`EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role} AND rolcanlogin)`} AS login_safe,
 (SELECT count(*)=4 AND count(DISTINCT relowner)=1 AND min(relowner::bigint)=(SELECT relowner::bigint FROM ledger) FROM pg_class WHERE oid IN(to_regclass('public.manager_order_operation_request'),to_regclass('public.store_order'),to_regclass('public.store_order_status'),to_regclass('public.store_order_outbox'))) AS owner_bound,
 (SELECT has_table_privilege(${target},oid,'SELECT') FROM ledger) AS read,
 NOT EXISTS(SELECT 1 FROM authority a JOIN ledger c ON c.relowner=a.oid OR has_table_privilege(a.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(a.oid,c.oid,'INSERT,UPDATE,REFERENCES')) AS authority_read_only,
 NOT EXISTS(SELECT 1 FROM authority a JOIN pg_roles r ON r.oid=a.oid WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
 OR has_parameter_privilege(r.oid,'session_replication_role','SET') OR has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND(n.nspowner=r.oid OR has_schema_privilege(r.oid,n.oid,'CREATE')))
 OR EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND(d.datdba=r.oid OR has_database_privilege(r.oid,d.oid,'CREATE')))
 OR EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN(to_regclass('public.store_order'),to_regclass('public.store_order_status'),to_regclass('public.store_order_outbox')) AND c.relowner=r.oid)) AS role_safe,
 NOT EXISTS(SELECT 1 FROM ledger c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) g WHERE g.grantee<>c.relowner AND(g.grantee=0 OR g.is_grantable OR g.privilege_type NOT IN('SELECT','INSERT')))
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN ledger c ON c.oid=a.attrelid WHERE a.attacl IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k JOIN ledger c ON c.oid=k.confrelid) AS append_only_acl`;
}
const required=['pg16','identity_unique','login_safe','owner_bound','authority_read_only','role_safe','append_only_acl'] as const;
export async function customerManualManagerOriginReadiness(db:Query){
 const catalog=await inspectManagerOrderOperation(db);
 if(!catalog.complete)return{ready:false,reason:catalog.present?'customer_manual_manager_origin_catalog_incompatible':'customer_manual_manager_origin_not_installed',catalog,privileges:null};
 const versions=await db.execute<{pg16:boolean}>(sql`SELECT current_setting('server_version_num')::integer/10000=16 AS pg16`);
 // Check before referencing PG16 membership-option columns. An unsupported
 // server is an unavailable source, rather than an undefined-column failure.
 if(versions.length!==1||versions[0].pg16!==true)return{ready:false,reason:'customer_manual_manager_origin_requires_pg16',catalog,privileges:null};
 const rows=await db.execute<Record<string,boolean>>(privileges(null)),p=rows[0];
 const ready=rows.length===1&&[...required,'read'].every(key=>p?.[key]===true);
 return{ready,reason:ready?'':'customer_manual_manager_origin_read_privileges_unreviewed',catalog,privileges:p??null};
}
/** Named-role maintenance inspection. It never claims that the caller is the
 * target LOGIN. The pre-grant stage permits only the missing SELECT; every
 * published catalog, ownership and read-only authority predicate still holds. */
export async function inspectCustomerManualManagerOriginReadiness(db:Query,role:string,requireRead=true){
 pricingIdentifier(role);if(typeof requireRead!=='boolean')throw Error('Explicit manager-origin read stage required');
 const catalog=await inspectManagerOrderOperation(db);
 if(!catalog.complete)return{ready:false,reason:catalog.present?'customer_manual_manager_origin_catalog_incompatible':'customer_manual_manager_origin_not_installed',catalog,privileges:null};
 const versions=await db.execute<{pg16:boolean}>(sql`SELECT current_setting('server_version_num')::integer/10000=16 AS pg16`);
 if(versions.length!==1||versions[0].pg16!==true)return{ready:false,reason:'customer_manual_manager_origin_requires_pg16',catalog,privileges:null};
 const rows=await db.execute<Record<string,boolean>>(privileges(role)),p=rows[0];
 const ready=rows.length===1&&required.every(key=>p?.[key]===true)&&(!requireRead||p?.read===true);
 return{ready,reason:ready?'':'customer_manual_manager_origin_read_privileges_unreviewed',catalog,privileges:p??null};
}
/** Explicit SELECT only. No startup call, manager scope EXECUTE, writes,
 * table installation, ownership transfer or automatic privilege repair. */
export function customerManualManagerOriginReadGrantSql(role:string){return `GRANT SELECT ON TABLE public.manager_order_operation_request TO ${pricingIdentifier(role)};`;}
export async function runCustomerManualManagerOriginRead(db:Pick<DbClient,'transaction'>&Partial<Pick<DbClient,'$client'>>,role:string){
 pricingIdentifier(role);if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Manager origin read grants require root maintenance client');
 await db.transaction(async tx=>{
  await tx.execute(sql`SET LOCAL search_path=public,pg_temp`);await tx.execute(sql`SET LOCAL row_security=off`);
  await tx.execute(sql`SELECT set_config('statement_timeout','5000ms',true),set_config('lock_timeout','1500ms',true)`);
  const [environment]=await tx.execute<{ready:boolean}>(sql`SELECT current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_read_only')='off' AND current_setting('transaction_isolation')='read committed' AND current_setting('session_replication_role')='origin'
   AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AND pg_try_advisory_xact_lock(731626,0)
   AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=to_regclass('public.manager_order_operation_request') AND r.rolname=current_user) AS ready`);
  if(environment?.ready!==true)throw Error('Manager origin read grants require reviewed PG16 financial owner transaction');
  await tx.execute(sql`LOCK TABLE public.manager_order_operation_request IN SHARE MODE NOWAIT`);
  if(!(await inspectManagerOrderOperation(tx)).complete)throw Error('Manager origin read grants require exact published manager catalog');
  const pre=await tx.execute<Record<string,boolean>>(privileges(role));
  if(pre.length!==1||!required.every(key=>pre[0][key]===true))throw Error('Manager origin reader authority/ownership/ACL is unreviewed');
  await tx.execute(sql.raw(customerManualManagerOriginReadGrantSql(role)));
  const post=await tx.execute<Record<string,boolean>>(privileges(role));
  if(!(await inspectManagerOrderOperation(tx)).complete||post.length!==1||![...required,'read'].every(key=>post[0][key]===true))throw Error('Manager origin read grant postcheck failed');
 },{isolationLevel:'read committed',accessMode:'read write'});
}
