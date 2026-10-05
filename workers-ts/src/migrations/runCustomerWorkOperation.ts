import { customerWorkCatalogSql } from './customerWorkCatalog';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { HttpApiException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { CUSTOMER_WORK_OPERATION_INSTALLATION_SQL } from './customerWorkOperation';
import { customerWorkScopeLockReadiness } from './runCustomerWorkScopeLock';
export const CUSTOMER_WORK_OPERATION_CATALOG_SQL=customerWorkCatalogSql('customer_work_operation_request');
/** Filled from the actual PG16 canonical installation, never a row's self
 * asserted version/comment or a check-name-only compatibility shortcut. */
export const CUSTOMER_WORK_OPERATION_CATALOG_SHA256='94369d92fc243b3c94b0028d50beebae0890bed075582dfe8298e81dc0a56421';
export async function inspectCustomerWorkOperation(db:Pick<DbClient,'execute'>){const rows=await db.execute<{shape:unknown}>(sql.raw(CUSTOMER_WORK_OPERATION_CATALOG_SQL));if(rows.length===0)return{present:false,complete:false,fingerprint:null};if(rows.length!==1)throw Error('Customer work operation catalog ambiguous');const fingerprint=await outRequestHash(rows[0].shape);return{present:true,complete:fingerprint===CUSTOMER_WORK_OPERATION_CATALOG_SHA256,fingerprint};}
export async function assertCustomerWorkOperationCatalog(db:Pick<DbClient,'execute'>){const state=await inspectCustomerWorkOperation(db);if(!state.complete)throw new HttpApiException('管理请求台账尚未安装或结构未验收，请保留原请求核对',503,503);}
/** Read-only capability inspection. A source file never proves installation
 * or grants. Production runtime must have append/read only; an owner or broad
 * grant cannot be advertised as an immutable-operation runtime profile. */
export async function customerWorkOperationReadiness(db:Pick<DbClient,'execute'>){
 const catalog=await inspectCustomerWorkOperation(db);
 if(!catalog.complete)return{ready:false,available:false,reason:catalog.present?'customer_work_operation_catalog_incompatible':'customer_work_operation_not_installed',catalog,privileges:null};
 const scope=await customerWorkScopeLockReadiness(db);if(!scope.ready)return{ready:false,available:false,reason:scope.reason,catalog,privileges:null};
 const rows=await db.execute<{read:boolean;append:boolean;mutable:boolean;append_only_acl:boolean}>(sql`SELECT has_table_privilege(current_user,'public.customer_work_operation_request','SELECT') AS read,has_table_privilege(current_user,'public.customer_work_operation_request','INSERT') AS append,(has_table_privilege(current_user,'public.customer_work_operation_request','UPDATE') OR has_table_privilege(current_user,'public.customer_work_operation_request','DELETE') OR has_table_privilege(current_user,'public.customer_work_operation_request','TRUNCATE') OR has_table_privilege(current_user,'public.customer_work_operation_request','REFERENCES') OR has_table_privilege(current_user,'public.customer_work_operation_request','TRIGGER') OR has_any_column_privilege(current_user,'public.customer_work_operation_request','UPDATE,REFERENCES')) AS mutable,
 NOT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='public.customer_work_operation_request'::regclass AND a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.customer_work_operation_request'::regclass AND a.attacl IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.confrelid='public.customer_work_operation_request'::regclass) AS append_only_acl`);
 const p=rows[0],available=rows.length===1&&p.read===true&&p.append===true&&p.mutable===false&&p.append_only_acl===true;
 return{ready:available,available,reason:available?'':'customer_work_operation_runtime_privileges_unreviewed',catalog,privileges:p??null};
}
/** Explicit fresh table installation only. No API startup call, permissions
 * repair, rerun-all migration, replacement or production connection fallback. */
export async function runCustomerWorkOperation(db:Pick<DbClient,'transaction'> & Partial<Pick<DbClient,'$client'>>){if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Customer work ledger installation requires a root database');await db.transaction(async tx=>{await tx.execute(sql.raw(CUSTOMER_WORK_OPERATION_INSTALLATION_SQL));},{isolationLevel:'read committed',accessMode:'read write'});}
