import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { inspectRechargeRefundCatalog } from './rechargeRefundCatalog';

type Query=Pick<DbClient,'execute'>;
export interface RechargeRefundSourceReaderPrincipal { readonly name:string; readonly oid:string }

/** Independent actor proof only. It does not inspect source ACLs or call any
 * goods/source inspector. SELECT grantees never establish an actor identity.
 * The caller must still prove one complete three-table ACL matrix and the
 * ordinary immutable source catalogs before consuming payment history. */
export async function readRechargeRefundSourceReaderPrincipals(tx:Query,names:{maintenance:string;app:string}):Promise<readonly RechargeRefundSourceReaderPrincipal[]|null> {
 const catalog=await inspectRechargeRefundCatalog(tx),b=catalog.binding;
 if(!catalog.commissioned||!b||b.maintenance!==names.maintenance||b.app!==names.app)return null;
 const [identity]=await tx.execute<{ready:boolean}>(sql`SELECT
  pg_catalog.current_database()=${b.database}
  AND (SELECT d.oid::text FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database())=${b.databaseOid}
  AND (SELECT r.oid::text FROM pg_catalog.pg_roles r WHERE r.rolname=${b.maintenance})=${b.maintenanceOid}
  AND (SELECT r.oid::text FROM pg_catalog.pg_roles r WHERE r.rolname=${b.app})=${b.appOid}
  AND (SELECT r.oid::text FROM pg_catalog.pg_roles r WHERE r.rolname=${b.admin})=${b.adminOid}
  AND (SELECT r.oid::text FROM pg_catalog.pg_roles r WHERE r.rolname=${b.financial})=${b.financialOid}
  AND (SELECT count(*)=3 AND COALESCE(bool_and(c.relowner::text=${b.maintenanceOid}),false)
   FROM pg_catalog.pg_class c WHERE c.oid IN(
    pg_catalog.to_regclass('public.routine_original_payment_evidence'),
    pg_catalog.to_regclass('public.routine_payment_account_policy'),
    pg_catalog.to_regclass('public.routine_payment_account_use'))) AS ready`);
 if(identity?.ready!==true)return null;
 return Object.freeze([
  Object.freeze({name:b.admin,oid:b.adminOid}),
  Object.freeze({name:b.financial,oid:b.financialOid}),
 ]);
}
