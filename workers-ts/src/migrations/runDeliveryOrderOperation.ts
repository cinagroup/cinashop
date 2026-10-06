import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { HttpApiException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { DELIVERY_ORDER_OPERATION_INSTALLATION_SQL } from './deliveryOrderOperation';

export const DELIVERY_ORDER_OPERATION_CATALOG_SQL=`
SELECT jsonb_build_object(
 'table',jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'rules',c.relhasrules,'partition',c.relispartition),
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'validated',k.convalidated,'definition',pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('unique',i.indisunique,'keys',i.indkey::text,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'predicate',pg_get_expr(i.indpred,i.indrelid),'expression',pg_get_expr(i.indexprs,i.indrelid),'method',am.amname,'options',ic.reloptions) ORDER BY i.indkey::text) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam WHERE i.indrelid=c.oid),
 'triggers',(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=c.oid),
 'parents',(SELECT count(*) FROM pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid)
) AS shape FROM pg_class c WHERE c.oid=to_regclass('public.delivery_order_operation_request')`;
/** Filled from the actual PG16 canonical installation, never a row's self
 * asserted version/comment or a check-name-only compatibility shortcut. */
export const DELIVERY_ORDER_OPERATION_CATALOG_SHA256='c51f40d3d0d469de8edd2c668e179589119bbe3a41e484fa0c00212dde671d6b';
export async function inspectDeliveryOrderOperation(db:Pick<DbClient,'execute'>){const rows=await db.execute<{shape:unknown}>(sql.raw(DELIVERY_ORDER_OPERATION_CATALOG_SQL));if(rows.length===0)return{present:false,complete:false,fingerprint:null};if(rows.length!==1)throw Error('Delivery operation catalog ambiguous');const fingerprint=await outRequestHash(rows[0].shape);return{present:true,complete:fingerprint===DELIVERY_ORDER_OPERATION_CATALOG_SHA256,fingerprint};}
export async function assertDeliveryOrderOperationCatalog(db:Pick<DbClient,'execute'>){const state=await inspectDeliveryOrderOperation(db);if(!state.complete)throw new HttpApiException('配送请求台账尚未安装或结构未验收，请保留原请求核对',503,503);}
/** Read-only capability inspection. A source file never proves installation
 * or grants. Production runtime must have append/read only; an owner or broad
 * grant cannot be advertised as an immutable-operation runtime profile. */
export async function deliveryOperationReadiness(db:Pick<DbClient,'execute'>){
 const catalog=await inspectDeliveryOrderOperation(db);
 if(!catalog.complete)return{ready:false,available:false,reason:catalog.present?'delivery_operation_catalog_incompatible':'delivery_operation_not_installed',catalog,privileges:null};

 const rows=await db.execute<{read:boolean;append:boolean;mutable:boolean;append_only_acl:boolean;ordinary_login:boolean}>(sql`SELECT has_table_privilege(current_user,'public.delivery_order_operation_request','SELECT') AS read,has_table_privilege(current_user,'public.delivery_order_operation_request','INSERT') AS append,(has_table_privilege(current_user,'public.delivery_order_operation_request','UPDATE') OR has_table_privilege(current_user,'public.delivery_order_operation_request','DELETE') OR has_table_privilege(current_user,'public.delivery_order_operation_request','TRUNCATE') OR has_table_privilege(current_user,'public.delivery_order_operation_request','REFERENCES') OR has_table_privilege(current_user,'public.delivery_order_operation_request','TRIGGER') OR has_any_column_privilege(current_user,'public.delivery_order_operation_request','UPDATE,REFERENCES')) AS mutable,
 NOT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='public.delivery_order_operation_request'::regclass AND a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.delivery_order_operation_request'::regclass AND a.attacl IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.confrelid='public.delivery_order_operation_request'::regclass) AS append_only_acl,
 current_user=session_user AND current_setting('session_replication_role')='origin' AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user AND(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)) AND NOT has_schema_privilege(current_user,'public','CREATE') AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND d.datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS ordinary_login`);
 const p=rows[0],available=rows.length===1&&p.read===true&&p.append===true&&p.mutable===false&&p.append_only_acl===true&&p.ordinary_login===true;
 return{ready:available,available,reason:available?'':'delivery_operation_runtime_privileges_unreviewed',catalog,privileges:p??null};
}
/** Explicit fresh table installation only. No API startup call, permissions
 * repair, rerun-all migration, replacement or production connection fallback. */
export async function runDeliveryOrderOperation(db:Pick<DbClient,'transaction'> & Partial<Pick<DbClient,'$client'>>){if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Delivery ledger installation requires a root database');await db.transaction(async tx=>{await tx.execute(sql.raw(DELIVERY_ORDER_OPERATION_INSTALLATION_SQL));},{isolationLevel:'read committed',accessMode:'read write'});}
