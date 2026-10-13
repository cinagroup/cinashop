import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {HttpApiException} from '@/utils/errors';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {pricingIdentifier} from './checkoutPricingLockCatalog';
import {CUSTOMER_MANUAL_REFUND_PROTOCOL_INSTALLATION_SQL} from './customerManualRefund';
import {CUSTOMER_MANUAL_GUEST_IDENTITY_UPGRADE_SQL,CUSTOMER_MANUAL_GUEST_IDENTITY_POSTCHECK_SQL} from './customerManualRefundGuestIdentity';
import {customerManualGuestIdentityReadiness} from './guestRefundEntityCatalog';
import {CUSTOMER_MANUAL_REFUND_CATALOG_SHA256,CUSTOMER_FINANCIAL_MANUAL_CATALOG_SHA256} from './customerManualRefundPins';
import {customerFinancialOperationReadiness,inspectCustomerFinancialOperation,CUSTOMER_FINANCIAL_OPERATION_CATALOG_SHA256} from './runCustomerFinancialOperation';
import {CASHIER_SECOND_CARD_ABANDON_CATALOG_SQL} from './runCashierSecondCardAbandon';
import {reviewedManualRefundPromotionLockCatalogQuery} from './cashierSecondCardPromotionLock';
type Query=Pick<DbClient,'execute'>;
export const CUSTOMER_MANUAL_REFUND_CATALOG_SQL=CASHIER_SECOND_CARD_ABANDON_CATALOG_SQL.replaceAll('cashier_second_card_abandon_v1',()=> 'customer_financial_manual_refund_v1').replace(" 'dropped_columns'",()=>` 'promotion_function',(SELECT jsonb_agg(jsonb_build_object(
 'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),
 'kind',p.prokind,'language',l.lanname,'trusted',l.lanpltrusted,'security_definer',p.prosecdef,
 'volatile',p.provolatile,'parallel',p.proparallel,'leakproof',p.proleakproof,'strict',p.proisstrict,
 'set_result',p.proretset,'source',p.prosrc,'config',p.proconfig,'support',p.prosupport::text,
 'binary',p.probin,'sql_body',p.prosqlbody::text,'cost',p.procost,'rows',p.prorows,
 'variadic',p.provariadic::text,'default_count',p.pronargdefaults,'all_argument_types',p.proallargtypes::text,
 'argument_modes',p.proargmodes,'argument_names',p.proargnames,'defaults',p.proargdefaults::text,'transform_types',p.protrftypes::text
 ) ORDER BY pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
 WHERE n.nspname='public' AND p.proname='customer_manual_refund_promotion_delete_v1'),
 'dropped_columns'`);
export async function inspectCustomerManualRefund(db:Query){const rows=await db.execute<{shape:unknown;server_version_num:number}>(sql.raw(CUSTOMER_MANUAL_REFUND_CATALOG_SQL));if(!rows.length)return{present:false,complete:false,fingerprint:null};if(rows.length!==1)throw Error('Manual refund catalog ambiguous');const fingerprint=await outRequestHash(rows[0].shape);return{present:true,complete:Math.floor(rows[0].server_version_num/10000)===16&&fingerprint===CUSTOMER_MANUAL_REFUND_CATALOG_SHA256,fingerprint};}
export async function customerManualRefundReadiness(db:Query){
 const catalog=await inspectCustomerManualRefund(db);if(!catalog.complete)return{ready:false,catalog,financial:null,privileges:null,reason:catalog.present?'customer_manual_refund_catalog_incompatible':'customer_manual_refund_not_installed'};
 const financial=await customerFinancialOperationReadiness(db);if(!financial.ready||financial.catalog.fingerprint!==CUSTOMER_FINANCIAL_MANUAL_CATALOG_SHA256)return{ready:false,catalog,financial:financial.catalog,privileges:null,reason:'customer_manual_refund_financial_upgrade_unreviewed'};
 const guest=await customerManualGuestIdentityReadiness(db);if(!guest.ready)return{ready:false,catalog,financial:financial.catalog,privileges:null,reason:'customer_manual_refund_guest_entity_upgrade_unreviewed'};
 const rows=await db.execute<Record<string,boolean>>(sql`WITH RECURSIVE identity AS(SELECT oid FROM pg_roles WHERE rolname IN(current_user,session_user)
 UNION SELECT usesysid FROM pg_stat_activity WHERE pid=pg_backend_pid()),authority(oid) AS(SELECT oid FROM identity UNION SELECT m.roleid FROM pg_auth_members m JOIN authority a ON a.oid=m.member),
 ledger AS(SELECT * FROM pg_class WHERE oid='public.customer_financial_manual_refund_v1'::regclass)
 SELECT has_table_privilege(current_user,'public.customer_financial_manual_refund_v1','SELECT') AS read,has_table_privilege(current_user,'public.customer_financial_manual_refund_v1','INSERT') AS append,
 NOT(has_table_privilege(current_user,'public.customer_financial_manual_refund_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,'public.customer_financial_manual_refund_v1','UPDATE,REFERENCES')) AS immutable,
 NOT EXISTS(SELECT 1 FROM ledger c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) g WHERE g.grantee<>c.relowner AND(g.grantee=0 OR g.is_grantable OR g.privilege_type NOT IN('SELECT','INSERT')))
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.customer_financial_manual_refund_v1'::regclass AND a.attacl IS NOT NULL) AS acl_safe,
 NOT EXISTS(SELECT 1 FROM authority a JOIN ledger c ON c.relowner=a.oid OR has_table_privilege(a.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(a.oid,c.oid,'UPDATE,REFERENCES')) AS authority_safe,
 current_user=session_user AND EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_roles r ON r.oid=b.usesysid WHERE b.pid=pg_backend_pid() AND r.rolname=session_user AND r.rolcanlogin)
 AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_roles r ON r.oid=a.oid WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
 OR has_parameter_privilege(r.oid,'session_replication_role','SET') OR has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND(n.nspowner=r.oid OR has_schema_privilege(r.oid,n.oid,'CREATE')))
 OR EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND d.datdba=r.oid)) AS role_safe`);
 const [promotion]=await db.execute<{ready:boolean;owner:number}>(sql`WITH RECURSIVE authority(oid) AS(SELECT oid FROM pg_roles WHERE rolname IN(current_user,session_user) UNION SELECT m.roleid FROM pg_auth_members m JOIN authority a ON a.oid=m.member)
 SELECT min(p.proowner::integer) AS owner,count(*)=1 AND bool_and(p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')
 AND NOT(r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
 AND NOT EXISTS(SELECT 1 FROM authority a WHERE a.oid=p.proowner)
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=p.proowner OR m.roleid=p.proowner)
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND(n.nspowner=p.proowner OR has_schema_privilege(p.proowner,n.oid,'CREATE')))
 AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relkind IN('r','p') AND c.relowner=p.proowner)
 AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) g WHERE g.grantee<>p.proowner AND(g.grantee=0 OR g.is_grantable OR g.privilege_type<>'EXECUTE'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND
 (has_table_privilege(p.proowner,c.oid,'INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(p.proowner,c.oid,'INSERT,UPDATE,REFERENCES')
 OR(c.relname<>'store_order_promotions' AND has_table_privilege(p.proowner,c.oid,'DELETE'))))
 AND has_table_privilege(p.proowner,'public.store_order_promotions','SELECT') AND has_table_privilege(p.proowner,'public.store_order_promotions','DELETE')
 AND has_table_privilege(p.proowner,'public.customer_financial_manual_refund_v1','SELECT')
 AND has_table_privilege(p.proowner,'public.customer_financial_operation_request','SELECT')
 AND has_table_privilege(p.proowner,'public.store_order','SELECT') AND has_table_privilege(p.proowner,'public.store_order_refund','SELECT')
 AND has_table_privilege(p.proowner,'public.store_order_refund_split','SELECT')
 AND has_table_privilege(current_user,'public.store_order_promotions','SELECT') AND has_table_privilege(current_user,'public.store_order_promotions','INSERT')
 AND has_column_privilege(current_user,'public.store_order_promotions','id','UPDATE')
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.store_order_promotions'::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'id' AND has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE'))
 AND (SELECT count(*)=1 AND bool_and(has_sequence_privilege(current_user,s.oid,'USAGE') AND NOT has_sequence_privilege(current_user,s.oid,'UPDATE')) FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace JOIN pg_depend d ON d.objid=s.oid AND d.deptype IN('a','i') JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid WHERE s.relkind='S' AND n.nspname='public' AND a.attrelid='public.store_order_promotions'::regclass AND a.attname='id')
 AND NOT(has_table_privilege(current_user,'public.store_order_promotions','DELETE,TRUNCATE')))
 AS ready FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.customer_manual_refund_promotion_delete_v1(integer,integer)'::regprocedure`);
 const [identity]=await db.execute<{role:string}>(sql`SELECT session_user::text AS role`);
 let guardReady=false;
 if(promotion?.ready===true&&Number.isSafeInteger(promotion.owner)&&promotion.owner>0&&identity?.role){const [guard]=await db.execute<Record<string,unknown>>(reviewedManualRefundPromotionLockCatalogQuery(identity.role,promotion.owner));guardReady=guard?.absent===false&&['tablesSafe','definitionSafe','triggerSafe','ownerSafe','roleSafe','aclSafe'].every(k=>guard?.[k]===true);}
 const privileges=rows[0],ready=rows.length===1&&['read','append','immutable','acl_safe','authority_safe','role_safe'].every(k=>privileges?.[k]===true)&&promotion?.ready===true&&guardReady;return{ready,catalog,financial:financial.catalog,privileges:{...privileges,promotion_safe:promotion?.ready??false,promotion_guard:guardReady},reason:ready?'':'customer_manual_refund_runtime_privileges_unreviewed'};
}
export async function assertCustomerManualRefundReady(db:Query){if(!(await customerManualRefundReadiness(db)).ready)throw new HttpApiException('人工现金退款台账、完整协议及实际权限尚未验收，请保留原请求',503,503);}
/** Only a fully commissioned catalog and constrained actual owner/ACL may supply
 * the fixed definer OID to the explicit ordinary-customer pricing envelope. */
export async function reviewedCustomerManualRefundPromotionOid(db:Query):Promise<string|null>{if(!(await customerManualRefundReadiness(db)).ready)return null;const rows=await db.execute<{oid:string}>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_proc WHERE oid='public.customer_manual_refund_promotion_delete_v1(integer,integer)'::regprocedure`);return rows.length===1&&/^[1-9][0-9]*$/.test(rows[0].oid)?rows[0].oid:null;}
export async function installCustomerManualRefund(db:Pick<DbClient,'transaction'>&Partial<Pick<DbClient,'$client'>>,promotionOwner:string){if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Manual refund installation requires root maintenance client');const owner=pricingIdentifier(promotionOwner);await db.transaction(async tx=>{
 const prior=await inspectCustomerFinancialOperation(tx);if(!prior.complete||prior.fingerprint!==CUSTOMER_FINANCIAL_OPERATION_CATALOG_SHA256)throw Error('Manual refund upgrade requires exact original financial catalog');
 const [role]=await tx.execute<{ready:boolean}>(sql`SELECT count(*)=1 AND bool_and(NOT(rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)) AS ready FROM pg_roles WHERE rolname=${promotionOwner}`);if(role?.ready!==true)throw Error('Manual promotion owner must be explicit constrained NOLOGIN role');
 await tx.execute(sql.raw(CUSTOMER_MANUAL_GUEST_IDENTITY_UPGRADE_SQL));
 // Pending measurements are evidence only. This exact postcheck rolls back
 // all four CHECK upgrades until separately measured pins are fixed in source.
 await tx.execute(sql.raw(CUSTOMER_MANUAL_GUEST_IDENTITY_POSTCHECK_SQL));
 await tx.execute(sql.raw(CUSTOMER_MANUAL_REFUND_PROTOCOL_INSTALLATION_SQL));
 await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${owner};GRANT SELECT ON public.customer_financial_manual_refund_v1,public.customer_financial_operation_request,public.store_order,public.store_order_refund,public.store_order_refund_split,public.store_order_promotions TO ${owner};GRANT DELETE ON public.store_order_promotions TO ${owner};ALTER FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) OWNER TO ${owner};`));
 },{isolationLevel:'read committed',accessMode:'read write'});}
export const runCustomerManualRefund=installCustomerManualRefund;
