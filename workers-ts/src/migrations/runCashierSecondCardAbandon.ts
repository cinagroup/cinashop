import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { HttpApiException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { customerWorkCatalogSql } from './customerWorkCatalog';
import { CASHIER_SECOND_CARD_ABANDON_INSTALLATION_SQL } from './cashierSecondCardAbandon';
export const CASHIER_SECOND_CARD_ABANDON_CATALOG_SQL = `SELECT jsonb_build_object(
 'ledger',(${customerWorkCatalogSql('cashier_second_card_abandon_v1').replace(' AS shape FROM',' FROM')}),
 'dropped_columns',(SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.cashier_second_card_abandon_v1') AND attnum>0 AND attisdropped),
 'policies',(SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid=to_regclass('public.cashier_second_card_abandon_v1')),
 'inbound_foreign_keys',(SELECT count(*) FROM pg_catalog.pg_constraint WHERE confrelid=to_regclass('public.cashier_second_card_abandon_v1'))
 ) AS shape,pg_catalog.current_setting('server_version_num')::integer AS server_version_num
 WHERE to_regclass('public.cashier_second_card_abandon_v1') IS NOT NULL`;
/** Commissioning pin must be measured in an independently owned PG16 cluster. */
export const CASHIER_SECOND_CARD_ABANDON_CATALOG_SHA256 = '6251f58d0a944d24678716ec004454c6ef9779da710ffe9715b459a034098263';
type Query = Pick<DbClient,'execute'>;
export async function inspectCashierSecondCardAbandon(db:Query) {
 const rows=await db.execute<{shape:unknown;server_version_num:number}>(sql.raw(CASHIER_SECOND_CARD_ABANDON_CATALOG_SQL));
 if(!rows.length)return{present:false,complete:false,fingerprint:null};
 if(rows.length!==1)throw Error('Cashier abandonment catalog ambiguous');
 const fingerprint=await outRequestHash(rows[0].shape);
 return{present:true,complete:Math.floor(rows[0].server_version_num/10000)===16&&fingerprint===CASHIER_SECOND_CARD_ABANDON_CATALOG_SHA256,fingerprint};
}
export async function cashierSecondCardAbandonBaseReadiness(db:Query) {
 const catalog=await inspectCashierSecondCardAbandon(db);
 if(!catalog.present)return{ready:false,present:false,reason:'cashier_second_card_abandon_not_installed'};
 if(!catalog.complete)return{ready:false,present:true,reason:'cashier_second_card_abandon_catalog_incompatible'};
 const [row]=await db.execute<{ready:boolean}>(sql`SELECT has_table_privilege(current_user,'public.cashier_second_card_abandon_v1','SELECT') AS ready`);
 return{ready:row?.ready===true,present:true,reason:row?.ready===true?'':'cashier_second_card_abandon_read_grants_missing'};
}
export async function assertCashierSecondCardAbandonReads(db:Query) {
 const state=await cashierSecondCardAbandonBaseReadiness(db);
 if(state.present&&!state.ready)throw new HttpApiException('原收银放弃事实读取权限或结构尚未验收，请保留原编号核对',503,503);
 return state;
}
export async function cashierSecondCardAbandonReadiness(db:Query) {
 const catalog=await inspectCashierSecondCardAbandon(db);
 if(!catalog.complete)return{ready:false,available:false,catalog,privileges:null,reason:catalog.present?'cashier_second_card_abandon_catalog_incompatible':'cashier_second_card_abandon_not_installed'};
 const rows=await db.execute<Record<string,boolean>>(sql`WITH RECURSIVE
 identity AS(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(current_user,session_user)
 UNION SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()),
 authority(oid) AS(SELECT oid FROM identity UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON a.oid=m.member),
 ledger AS(SELECT * FROM pg_catalog.pg_class WHERE oid='public.cashier_second_card_abandon_v1'::regclass)
 SELECT has_table_privilege(current_user,'public.cashier_second_card_abandon_v1','SELECT') AS read,
 has_table_privilege(current_user,'public.cashier_second_card_abandon_v1','INSERT') AS append,
 NOT(has_table_privilege(current_user,'public.cashier_second_card_abandon_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 OR has_any_column_privilege(current_user,'public.cashier_second_card_abandon_v1','UPDATE,REFERENCES')) AS immutable,
 NOT EXISTS(SELECT 1 FROM ledger c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) g
 WHERE g.grantee<>c.relowner AND(g.grantee=0 OR g.is_grantable OR g.privilege_type NOT IN('SELECT','INSERT')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.cashier_second_card_abandon_v1'::regclass AND a.attacl IS NOT NULL) AS acl_safe,
 NOT EXISTS(SELECT 1 FROM authority a JOIN ledger c ON c.relowner=a.oid
 OR has_table_privilege(a.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(a.oid,c.oid,'UPDATE,REFERENCES')) AS authority_safe,
 current_user=session_user AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity b JOIN pg_catalog.pg_roles r ON r.oid=b.usesysid
 WHERE b.pid=pg_catalog.pg_backend_pid() AND r.rolname=session_user AND r.rolcanlogin)
 AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_catalog.pg_roles r ON r.oid=a.oid WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
 OR r.rolreplication OR r.rolbypassrls OR has_parameter_privilege(r.oid,'session_replication_role','SET')
 OR has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='public' AND(n.nspowner=r.oid OR has_schema_privilege(r.oid,n.oid,'CREATE')))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=current_database() AND d.datdba=r.oid)) AS role_safe`);
 const privileges=rows[0],ready=rows.length===1&&['read','append','immutable','acl_safe','authority_safe','role_safe'].every(key=>privileges?.[key]===true);
 return{ready,available:ready,catalog,privileges:privileges??null,reason:ready?'':'cashier_second_card_abandon_runtime_privileges_unreviewed'};
}
export async function installCashierSecondCardAbandon(db:Pick<DbClient,'transaction'>&Partial<Pick<DbClient,'$client'>>) {
 if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Cashier abandonment installation requires root maintenance client');
 await db.transaction(async tx=>{await tx.execute(sql.raw(CASHIER_SECOND_CARD_ABANDON_INSTALLATION_SQL));},{isolationLevel:'read committed',accessMode:'read write'});
}
export const runCashierSecondCardAbandon=installCashierSecondCardAbandon;
