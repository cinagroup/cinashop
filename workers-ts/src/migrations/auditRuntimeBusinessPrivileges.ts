import { inspectUserMessageReadCapability } from './userMessageReadCapability';
import { inspectRoutineOriginalPaymentEvidenceCatalog, ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_RUNTIME_PRIVILEGES } from './routineOriginalPaymentEvidence';
import { inspectRoutineIdentityOwnershipCatalog, ROUTINE_IDENTITY_OWNERSHIP_RUNTIME_PRIVILEGES } from './routineIdentityOwnership';
import { inspectAdminWechatAppOperation, ADMIN_WECHAT_APP_OPERATION_RUNTIME_PRIVILEGES } from './adminWechatAppOperation';
import { inspectNativeAppPaymentAuthority, NATIVE_APP_PAYMENT_AUTHORITY_RUNTIME_PRIVILEGES } from './nativeAppPaymentAuthority';
import { inspectAdminWechatOpenOperation, ADMIN_WECHAT_OPEN_OPERATION_RUNTIME_PRIVILEGES } from './adminWechatOpenOperation';
import { inspectAdminPcBaseOperation, ADMIN_PC_BASE_OPERATION_RUNTIME_PRIVILEGES } from './adminPcBaseOperation';
import { ADMIN_PRODUCT_LABEL_OPERATION_RUNTIME_PRIVILEGES, inspectAdminProductLabelOperation } from './adminProductLabelOperation';
import { sql } from 'drizzle-orm';
import { inspectAdminWechatMenuOperation, ADMIN_WECHAT_MENU_OPERATION_RUNTIME_PRIVILEGES } from './adminWechatMenuOperation';
import { inspectAdminWechatBaseOperation, ADMIN_WECHAT_BASE_OPERATION_RUNTIME_PRIVILEGES } from './adminWechatBaseOperation';
import { inspectAdminWechatRoutineWriteCatalog } from './adminWechatRoutineWriteCatalog';
import { ADMIN_WECHAT_ROUTINE_OPERATION_RUNTIME_PRIVILEGES } from './adminWechatRoutineOperation';
import { ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE } from './adminWechatRoutineWriteCapability';
import type { DbClient } from '../lib/di';
import { outRequestHash } from '../services/out/OutIdempotency';
import { runtimeBusinessPrivilegePlanAtStage, type RuntimeBusinessProfileVersion } from './runtimeBusinessPrivilegePlan';
import { inspectRuntimeAdminBoundary } from './runtimeAdminBoundary';
import { inspectCashierRuntimeConditionalBoundary } from './cashierRuntimeConditionalBoundary';
import { inspectRoutinePaymentRuntime, routinePaymentRuntimeTablePrivileges, type RoutinePaymentRuntimeNames } from './routinePaymentRuntime';
import { inspectRuntimeLockOnlyBoundary } from './runtimeLockOnlyBoundary';
import { pricingIdentifier, pricingCatalogReady } from './checkoutPricingLockCatalog';
import { inspectCheckoutPricingLock } from './checkoutPricingLock';
import { reviewedOfflinePricingOid } from './reviewedOfflinePricingCapability';
import { reviewedRuntimePricingCapabilities } from './reviewedRuntimePricingCapabilities';
import { inspectRuntimePurchaseEvidence, inspectRuntimePurchaseGiftEvidence, inspectRuntimePurchasePhysicalEvidence } from './runtimePurchaseEvidence';
import { inspectSeckillTimeReferenceLock } from './seckillTimeReferenceLock';
import { seckillTimeReferenceLockCatalogReady } from './seckillTimeReferenceLockCatalog';
import { inspectRuntimeSeckillScheduleLockBoundary, type SeckillScheduleRuntimeNames } from './runtimeSeckillScheduleLockBoundary';
import { inspectSeckillParentRuntimeSequence } from './seckillParentRuntimeCatalog';
import { inspectCouponTemplateCatalog } from './couponTemplateCatalog';
import { inspectOrderPromotionGiftReceiptCatalog } from './orderPromotionGiftReceipt';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, inspectRuntimeAppCashierOriginReader, RUNTIME_APP_CASHIER_ORIGIN_READ_TABLE,
  type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { inspectPromotionManagementRuntimeSequences } from './promotionManagementRuntimeCatalog';
import { inspectAdminSupplierMenuWriteCapability } from './adminSupplierMenuWriteCapability';
import { inspectSupplierProductLabelCapability } from './supplierProductLabelCapability';
import { inspectSignDayConfigRuntimeCatalog } from './signDayConfigRuntimeCatalog';
import { inspectRuntimeSignDayGroupLockBoundary } from './runtimeSignDayGroupLockBoundary';
import { inspectRuntimeAgentLevelCatalogBoundary } from './runtimeAgentLevelCatalogBoundary';
import { inspectAgentLevelRuntimeCatalog } from './agentLevelRuntimeCatalog';
import { inspectNewcomerCartAddReplayCatalog } from './runNewcomerCartAddReplay';
import { ADMIN_AUTHORITY_OPERATION_RUNTIME_PRIVILEGES, ADMIN_AUTHORITY_OPERATION_RUNTIME_FUNCTIONS,
  inspectAdminAuthorityOperation, inspectAdminAuthorityMenuLock } from './adminAuthorityOperation';
import { ADMIN_PROFILE_RUNTIME_PRIVILEGES, inspectAdminProfile } from './adminProfile';
import { ADMIN_EXPRESS_OPERATION_RUNTIME_PRIVILEGES, inspectAdminExpressOperation } from './adminExpressOperation';
import { ADMIN_LEVEL_OPERATION_RUNTIME_PRIVILEGES, inspectAdminLevelOperation } from './adminLevelOperation';
import { ADMIN_LABEL_OPERATION_RUNTIME_PRIVILEGES, inspectAdminLabelOperation } from './adminLabelOperation';
import { ADMIN_STORE_OPERATION_RUNTIME_PRIVILEGES, inspectAdminStoreOperation } from './adminStoreOperation';
import { ADMIN_STAFF_OPERATION_RUNTIME_PRIVILEGES, inspectAdminStaffOperation } from './adminStaffOperation';
import { ADMIN_DELIVERY_OPERATION_RUNTIME_PRIVILEGES, inspectAdminDeliveryOperation } from './adminDeliveryOperation';
import { ADMIN_GROUP_OPERATION_RUNTIME_PRIVILEGES, inspectAdminGroupOperation } from './adminGroupOperation';
import { ADMIN_UNIT_OPERATION_RUNTIME_PRIVILEGES, inspectAdminUnitOperation } from './adminUnitOperation';
import { ADMIN_ENSURE_OPERATION_RUNTIME_PRIVILEGES, inspectAdminEnsureOperation } from './adminEnsureOperation';
import { ADMIN_RULE_OPERATION_RUNTIME_PRIVILEGES, inspectAdminRuleOperation } from './adminRuleOperation';
import { ADMIN_PARAMETER_OPERATION_RUNTIME_PRIVILEGES, inspectAdminParameterOperation } from './adminParameterOperation';
import { ADMIN_HOTWORD_OPERATION_RUNTIME_PRIVILEGES, inspectAdminHotwordOperation } from './adminHotwordOperation';
import { ADMIN_PLATFORM_MENU_OPERATION_RUNTIME_PRIVILEGES, inspectAdminPlatformMenuOperation,
  inspectAdminPlatformMenuWriteCapability } from './adminPlatformMenuWriteCapability';

/** Exact effective ACL comparison for the real connection, not SET ROLE on a
 * maintenance session. Readonly: never grants/revokes/repairs. The result proves
 * the declared profile and its fixed conditional-write boundaries, NOT complete
 * service coverage, HTTP authorization or production commissioning. */
export type RuntimeAuditStage = 'root'|'setup'|'identity'|'tables'|'columns'|'sequences'|'pricing'|'routines'|'defaults'|'staff'|'locks'|'schedule_locks'|'coupon_templates'|'purchase_evidence'|'sign_day_config'|'agent_levels';
export async function auditRuntimeBusinessPrivileges(db: DbClient, kind:'app'|'admin', names:RoutinePaymentRuntimeNames, onStage?:(stage:RuntimeAuditStage)=>void,
  declaredPeers?:RuntimeGiftPeerDeclarations, appReader?:RuntimeAppCashierOriginReaderAddon) {
  const peers=declaredPeers?captureRuntimeGiftPeerDeclarations(declaredPeers):undefined;
  const reader=appReader===undefined?undefined:captureRuntimeAppCashierOriginReader(appReader);
  if(reader&&kind!=='app')throw Error('Cashier-origin reader addon is App-only');
  onStage?.('root');
  if(!Object.hasOwn(db,'$client') || !db.$client)throw Error('Root connection required');
  // TypeScript structural callers may include deployment metadata. Only the
  // three declared LOGIN identities participate in this authority check.
  const identities=[names.app,names.admin,names.maintenance];
  identities.forEach(pricingIdentifier);
  if(new Set(identities).size!==3)throw Error('Distinct identities required');
  return db.transaction(async tx=>{
    onStage?.('setup');
    await tx.execute(sql`SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
      set_config('idle_in_transaction_session_timeout','5000',true),set_config('search_path','public,pg_temp',true)`);
    return inspectRuntimeBusinessProfile(tx,kind,names,'current',true,onStage,peers,reader);
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}

/** Readonly maintenance comparison for fixed historical forward protocols.
 * Each stage pins its exact grants and installed boundaries; no caller-supplied
 * ACL plan or relaxed drift policy.
 * This does not claim an independently authenticated runtime connection. */
export async function inspectRuntimeBusinessProfileInTransaction(tx:Pick<DbClient,'execute'>,kind:'app'|'admin',
  names:SeckillScheduleRuntimeNames, version:RuntimeBusinessProfileVersion, declaredPeers?:RuntimeGiftPeerDeclarations,
  appReader?:RuntimeAppCashierOriginReaderAddon) {
  if(Object.hasOwn(tx,'$client'))throw Error('Profile inspection requires an existing transaction');
  const reader=appReader===undefined?undefined:captureRuntimeAppCashierOriginReader(appReader);
  if(reader&&kind!=='app')throw Error('Cashier-origin reader addon is App-only');
  return inspectRuntimeBusinessProfile(tx,kind,names,version,false,undefined,declaredPeers?captureRuntimeGiftPeerDeclarations(declaredPeers):undefined,reader);
}

async function inspectRuntimeBusinessProfile(tx:Pick<DbClient,'execute'>,kind:'app'|'admin',names:SeckillScheduleRuntimeNames,
  version:RuntimeBusinessProfileVersion,verifyConnection:boolean,onStage?:(stage:RuntimeAuditStage)=>void,peers?:RuntimeGiftPeerDeclarations,
  appReader?:RuntimeAppCashierOriginReaderAddon) {
    const identities=[names.app,names.admin,names.maintenance];identities.forEach(pricingIdentifier);
    if(new Set(identities).size!==3)throw Error('Distinct identities required');
    const plan=runtimeBusinessPrivilegePlanAtStage(kind,version),expectedRole=names[kind];
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
      FROM pg_catalog.pg_roles r WHERE rolname=${expectedRole}`);
    const failures:string[]=[];
    const cashierConditional = peers?.cashierSecondCard?.conditionalGuards
      ? await inspectCashierRuntimeConditionalBoundary(tx, peers.target, peers.cashierSecondCard.role) : null;
    const cashierBinding = cashierConditional?.binding ?? undefined;
    if (cashierConditional && (!cashierConditional.ready || version !== 'current' || !peers
      || peers.target.app !== names.app || peers.target.admin !== names.admin || peers.target.maintenance !== names.maintenance))
      failures.push('cashier_conditional_boundary');
    if(verifyConnection && (identity?.role!==expectedRole || identity?.session!==expectedRole || identity?.backend!==expectedRole))failures.push('connection_identity');
    for(const key of ['version','restricted','login','no_memberships','no_ownership','no_ddl','no_replication_bypass','no_other_schema_data'])
      if(identity?.[key]!==true)failures.push(key);
    // A caller explicitly selects this one immutable source read. Installed
    // objects and bare grants never extend the historical base profile.
    if(appReader) {
      const proof=await inspectRuntimeAppCashierOriginReader(tx,{role:expectedRole,maintenance:names.maintenance,
        requirePrivileges:true,addon:appReader});
      if(kind!=='app')throw Error('Cashier-origin reader addon is App-only');
      if(!proof.ready)failures.push(...proof.failures.map(name=>'app_cashier_origin_reader:'+name));
      else plan.tables[RUNTIME_APP_CASHIER_ORIGIN_READ_TABLE]=['SELECT'];
    }
    // Separately maintained Mini storage does not change the historical base
    // profile. Only an exact owner/catalog/explicit-LOGIN ACL delta may extend
    // the full audit; partial objects or grants fail closed.
    const routinePayment = await inspectRoutinePaymentRuntime(tx,names);
    if (routinePayment.present) {
      if (!routinePayment.ready) failures.push('routine_payment_runtime_catalog');
      else {
        Object.assign(plan.tables,routinePaymentRuntimeTablePrivileges(kind));
        plan.tables.payment_reconciliation_action=[...new Set([...(plan.tables.payment_reconciliation_action??[]),'SELECT' as const])];
      }
    }
    const routineOriginal = await inspectRoutineOriginalPaymentEvidenceCatalog(tx, names);
    if (routineOriginal.present) {
      if (!routineOriginal.ready) failures.push('routine_original_payment_evidence_catalog');
      else plan.tables.routine_original_payment_evidence = [...ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_RUNTIME_PRIVILEGES[kind]];
    }
    const routineOwnership = await inspectRoutineIdentityOwnershipCatalog(tx, names);
    if (routineOwnership.present) {
      if (!routineOwnership.ready) failures.push('routine_identity_ownership_catalog');
      else plan.tables.routine_identity_ownership = [...ROUTINE_IDENTITY_OWNERSHIP_RUNTIME_PRIVILEGES[kind]];
    }
    // This separately commissioned receipt is absent from the fixed base
    // profile. When installed, its actual PG16 shape must match before the
    // auditor accepts precisely the app SELECT/INSERT grant and no Admin grant.
    const newcomerReplay = await inspectNewcomerCartAddReplayCatalog(tx);
    if(newcomerReplay.present) {
      if(!newcomerReplay.complete)failures.push('newcomer_cart_replay_catalog');
      else plan.tables.newcomer_cart_add_replay=kind==='app'?['SELECT','INSERT']:[];
    }
    const [pcBaseAddon]=await tx.execute(sql`SELECT to_regclass('public.admin_pc_base_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname='admin_pc_base_operation_immutable_v1') AS present`);
    if (pcBaseAddon?.present===true) {
      if (!await inspectAdminPcBaseOperation(tx,names)) failures.push('admin_pc_base_operation_catalog');
      else plan.tables.admin_pc_base_operation=ADMIN_PC_BASE_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [wechatAppAddon]=await tx.execute(sql`SELECT to_regclass('public.admin_wechat_app_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
        AND (starts_with(relname,'native_app_payment_') OR starts_with(relname,'napa_') OR starts_with(relname,'nape_')))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND (proname='admin_wechat_app_operation_immutable_v1' OR starts_with(proname,'native_app_payment_')
          OR starts_with(proname,'napa_') OR starts_with(proname,'nape_')))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace
        AND (starts_with(conname,'napa_') OR starts_with(conname,'nape_')))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace
        AND (starts_with(typname,'native_app_payment_') OR starts_with(typname,'_native_app_payment_')
          OR starts_with(typname,'napa_') OR starts_with(typname,'nape_')))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        WHERE c.relnamespace='public'::regnamespace
          AND (starts_with(t.tgname,'napa_') OR starts_with(t.tgname,'nape_'))) AS present`);
    if (wechatAppAddon?.present===true) {
      if (!await inspectAdminWechatAppOperation(tx,names)) failures.push('admin_wechat_app_operation_catalog');
      else if (!await inspectNativeAppPaymentAuthority(tx,names)) failures.push('native_app_payment_authority_catalog');
      else {
        plan.tables.admin_wechat_app_operation=ADMIN_WECHAT_APP_OPERATION_RUNTIME_PRIVILEGES[kind];
        Object.assign(plan.tables,NATIVE_APP_PAYMENT_AUTHORITY_RUNTIME_PRIVILEGES[kind]);
      }
    }
    const [wechatOpenAddon]=await tx.execute(sql`SELECT to_regclass('public.admin_wechat_open_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname='admin_wechat_open_operation_immutable_v1') AS present`);
    if (wechatOpenAddon?.present===true) {
      if (!await inspectAdminWechatOpenOperation(tx,names)) failures.push('admin_wechat_open_operation_catalog');
      else plan.tables.admin_wechat_open_operation=ADMIN_WECHAT_OPEN_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [wechatBaseAddon]=await tx.execute(sql`SELECT to_regclass('public.admin_wechat_base_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname='admin_wechat_base_operation_immutable_v1') AS present`);
    if (wechatBaseAddon?.present===true) {
      if (!await inspectAdminWechatBaseOperation(tx,names)) failures.push('admin_wechat_base_operation_catalog');
      else plan.tables.admin_wechat_base_operation=ADMIN_WECHAT_BASE_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [wechatMenuAddon]=await tx.execute(sql`SELECT to_regclass('public.admin_wechat_menu_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname='admin_wechat_menu_operation_immutable_v1') AS present`);
    if (wechatMenuAddon?.present===true) {
      if (!await inspectAdminWechatMenuOperation(tx,names)) failures.push('admin_wechat_menu_operation_catalog');
      else plan.tables.admin_wechat_menu_operation=ADMIN_WECHAT_MENU_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [authorityReceipt]=await tx.execute(sql`SELECT to_regclass('public.admin_authority_operation') IS NOT NULL AS present`);
    let reviewedAuthorityMenuLock:string|null=null;
    if (authorityReceipt?.present===true) {
      if (!(await inspectAdminAuthorityOperation(tx,names)) || !(await inspectAdminAuthorityMenuLock(tx,names))) failures.push('admin_authority_operation_catalog');
      else {
        plan.tables.admin_authority_operation=ADMIN_AUTHORITY_OPERATION_RUNTIME_PRIVILEGES[kind];
        plan.functions=[...plan.functions,...ADMIN_AUTHORITY_OPERATION_RUNTIME_FUNCTIONS[kind]];
        // A separately commissioned v3 hard-delete addon permits precisely one
        // extra Admin table privilege. The fixed historical plan stays intact;
        // absent/v1/v2 catalogs never justify this DELETE grant, nor does App.
        if (kind==='admin' && await inspectAdminAuthorityOperation(tx,names,'legacy-role-v3')) {
          plan.tables.system_role=[...(plan.tables.system_role ?? []),'DELETE'];
        }
        if (kind==='admin') {
          const [capability]=await tx.execute(sql`SELECT to_regprocedure('public.admin_authority_menu_lock_v1()')::oid::text AS oid`);
          if (typeof capability?.oid==='string') reviewedAuthorityMenuLock=capability.oid;
        }
      }
    }
    // Separate optional addon: neither absent catalogs nor a partial/drifted
    // table/function justify grants. Historical fixed stage plans stay intact.
    const [profileAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_profile_operation') IS NOT NULL
      OR to_regclass('public.admin_profile_avatar') IS NOT NULL
      OR to_regprocedure('public.admin_profile_immutable_v1()') IS NOT NULL AS present`);
    if (profileAddon?.present === true) {
      if (!await inspectAdminProfile(tx,names)) failures.push('admin_profile_catalog');
      else {
        plan.tables.admin_profile_operation=ADMIN_PROFILE_RUNTIME_PRIVILEGES[kind];
        plan.tables.admin_profile_avatar=ADMIN_PROFILE_RUNTIME_PRIVILEGES[kind];
      }
    }
    // Independent Express receipt addon; no carrier DML grant, sequence or
    // SECURITY DEFINER capability is added to the fixed historical profiles.
    const [expressAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_express_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_express_operation_immutable_v1') AS present`);
    if (expressAddon?.present === true) {
      if (!await inspectAdminExpressOperation(tx,names)) failures.push('admin_express_operation_catalog');
      else plan.tables.admin_express_operation=ADMIN_EXPRESS_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    // Independent ordinary-level receipt addon: no catalog DML or legacy stage
    // grant is changed. Partial/drifted evidence never justifies access.
    const [levelAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_level_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_level_operation_immutable_v1') AS present`);
    if (levelAddon?.present === true) {
      if (!await inspectAdminLevelOperation(tx,names)) failures.push('admin_level_operation_catalog');
      else plan.tables.admin_level_operation=ADMIN_LEVEL_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [labelAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_label_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_label_operation_immutable_v1') AS present`);
    if (labelAddon?.present === true) {
      if (!await inspectAdminLabelOperation(tx,names)) failures.push('admin_label_operation_catalog');
      else plan.tables.admin_label_operation=ADMIN_LABEL_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [storeAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_store_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_store_operation_immutable_v1') AS present`);
    if (storeAddon?.present === true) {
      if (!await inspectAdminStoreOperation(tx,names)) failures.push('admin_store_operation_catalog');
      else plan.tables.admin_store_operation=ADMIN_STORE_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [staffAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_staff_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_staff_operation_immutable_v1') AS present`);
    if (staffAddon?.present === true) {
      if (!await inspectAdminStaffOperation(tx,names)) failures.push('admin_staff_operation_catalog');
      else plan.tables.admin_staff_operation=ADMIN_STAFF_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [deliveryAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_delivery_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_delivery_operation_immutable_v1') AS present`);
    if (deliveryAddon?.present === true) {
      if (!await inspectAdminDeliveryOperation(tx,names)) failures.push('admin_delivery_operation_catalog');
      else plan.tables.admin_delivery_operation=ADMIN_DELIVERY_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [groupAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_group_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_group_operation_immutable_v1') AS present`);
    if (groupAddon?.present === true) {
      if (!await inspectAdminGroupOperation(tx,names)) failures.push('admin_group_operation_catalog');
      else plan.tables.admin_group_operation=ADMIN_GROUP_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [unitAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_unit_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_unit_operation_immutable_v1') AS present`);
    if (unitAddon?.present === true) {
      if (!await inspectAdminUnitOperation(tx,names)) failures.push('admin_unit_operation_catalog');
      else plan.tables.admin_unit_operation=ADMIN_UNIT_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [ensureAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_ensure_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_ensure_operation_immutable_v1') AS present`);
    if (ensureAddon?.present === true) {
      if (!await inspectAdminEnsureOperation(tx,names)) failures.push('admin_ensure_operation_catalog');
      else plan.tables.admin_ensure_operation=ADMIN_ENSURE_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [ruleAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_rule_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_rule_operation_immutable_v1') AS present`);
    if (ruleAddon?.present === true) {
      if (!await inspectAdminRuleOperation(tx,names)) failures.push('admin_rule_operation_catalog');
      else plan.tables.admin_rule_operation=ADMIN_RULE_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [parameterAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_parameter_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_parameter_operation_immutable_v1') AS present`);
    if (parameterAddon?.present === true) {
      if (!await inspectAdminParameterOperation(tx,names)) failures.push('admin_parameter_operation_catalog');
      else plan.tables.admin_parameter_operation=ADMIN_PARAMETER_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const [hotwordAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_hotword_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_hotword_operation_immutable_v1') AS present`);
    if (hotwordAddon?.present === true) {
      if (!await inspectAdminHotwordOperation(tx,names)) failures.push('admin_hotword_operation_catalog');
      else plan.tables.admin_hotword_operation=ADMIN_HOTWORD_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    let productLabelAuxiliaryRead = false;
    const [productLabelAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_product_label_operation') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND proname='admin_product_label_operation_immutable_v1') AS present`);
    if (productLabelAddon?.present === true) {
      if (!await inspectAdminProductLabelOperation(tx,names)) failures.push('admin_product_label_operation_catalog');
      else {
        plan.tables.admin_product_label_operation=ADMIN_PRODUCT_LABEL_OPERATION_RUNTIME_PRIVILEGES[kind];
        productLabelAuxiliaryRead=kind==='admin';
      }
    }
    // Independent type-1 addon. A partial receipt/capability or an unsafe owner
    // never justifies a new table grant or a SECURITY DEFINER allowlist entry.
    const platformMenuWrite = await inspectAdminPlatformMenuWriteCapability(tx,names.admin,cashierBinding ? { app:names.app, maintenance:names.maintenance, cashier:cashierBinding } : undefined);
    const [platformMenuAddon] = await tx.execute(sql`SELECT to_regclass('public.admin_platform_menu_operation') IS NOT NULL
      OR to_regprocedure('public.admin_platform_menu_operation_immutable_v1()') IS NOT NULL AS present`);
    const platformMenuReady = platformMenuWrite.ready && await inspectAdminPlatformMenuOperation(tx,names);
    if (!platformMenuWrite.absent || platformMenuAddon?.present === true) {
      if (!platformMenuReady) failures.push('admin_platform_menu_catalog');
      else plan.tables.admin_platform_menu_operation=ADMIN_PLATFORM_MENU_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const reviewedPlatformMenu = kind==='admin' && platformMenuReady ? platformMenuWrite.functionOid : null;
    // An independently commissioned Routine writer never extends App's SQL
    // authority. Bind the whole bundle to these exact maintenance/Admin names
    // before accepting Admin SELECT and this single SECURITY DEFINER OID.
    const [routineOwner] = await tx.execute<{ writer: string; oid: string }>(sql`SELECT
      pg_catalog.pg_get_userbyid(proowner) AS writer,oid::text AS oid FROM pg_catalog.pg_proc
      WHERE oid=pg_catalog.to_regprocedure(${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE})`);
    const routineWrite = await inspectAdminWechatRoutineWriteCatalog(tx, routineOwner
      ? { maintenance: names.maintenance, admin: names.admin, writer: routineOwner.writer } : undefined);
    if (routineWrite.present) {
      if (!routineWrite.ready) failures.push('admin_wechat_routine_catalog');
      else plan.tables.admin_wechat_routine_operation=ADMIN_WECHAT_ROUTINE_OPERATION_RUNTIME_PRIVILEGES[kind];
    }
    const reviewedRoutineWrite = kind==='admin' && routineWrite.ready && routineOwner ? routineOwner.oid : null;
    onStage?.('tables');
    const tableRows=await tx.execute(sql`SELECT c.relname AS name,c.oid::text AS oid,c.relkind,c.relpersistence,
      c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid) AS nonordinary,
      p.privilege,pg_catalog.has_table_privilege(${expectedRole},c.oid,p.privilege) AS allowed,
      pg_catalog.has_table_privilege(${expectedRole},c.oid,p.privilege||' WITH GRANT OPTION') AS delegate
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
      pg_catalog.has_column_privilege(${expectedRole},c.oid,a.attnum,p.privilege) AS allowed,
      pg_catalog.has_column_privilege(${expectedRole},c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS delegate
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
    for(const r of columns){
      const table=String(r.name),column=String(r.column),privilege=String(r.privilege);
      const expected=(plan.tables[table]?.some(p=>p===privilege)??false)
        || (privilege==='UPDATE' && (plan.updateColumns[table]?.includes(column)??false))
        || (productLabelAuxiliaryRead && table==='store_product_label_auxiliary' && column==='label_id' && privilege==='SELECT');
      if(r.allowed!==expected || r.delegate!==false)failures.push('column:'+table+'.'+column+':'+privilege);
    }
    onStage?.('sequences');
    const sequences=await tx.execute(sql`SELECT s.relname AS name,
      (SELECT t.relname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class t ON t.oid=d.refobjid AND t.relnamespace=s.relnamespace
        WHERE d.classid='pg_catalog.pg_class'::regclass AND d.refclassid=d.classid AND d.objid=s.oid AND d.deptype IN('a','i') LIMIT 1) AS parent,
      pg_catalog.has_sequence_privilege(${expectedRole},s.oid,'USAGE') AS usage,
      pg_catalog.has_sequence_privilege(${expectedRole},s.oid,'SELECT,UPDATE') AS extras,
      pg_catalog.has_sequence_privilege(${expectedRole},s.oid,'USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') AS delegate
      FROM pg_catalog.pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S'`);
    for(const r of sequences){
      const expected=plan.standaloneSequences.includes(String(r.name)) || (plan.tables[String(r.parent)]?.includes('INSERT')??false);
      if(r.usage!==expected || r.extras!==false || r.delegate!==false)failures.push('sequence:'+r.name);
    }
    for(const name of plan.standaloneSequences)if(!sequences.some(r=>r.name===name))failures.push('missing_sequence:'+name);
    onStage?.('pricing');
    let reviewed:{checkout:string|null;offline:string|null}={checkout:null,offline:null};
    if(kind==='app') {
      if(verifyConnection) reviewed=await reviewedRuntimePricingCapabilities(tx,'public','shared-shop');
      else {
        // The full named-role checks above already reject membership, DDL,
        // ownership and every extra table/column privilege. Review the exact
        // two installed pricing OIDs here without impersonating the LOGIN.
        const catalog=await inspectCheckoutPricingLock(tx),offline=await reviewedOfflinePricingOid(tx,'public');
        if(pricingCatalogReady(catalog) && catalog.functionOid && offline) {
          const [allowed]=await tx.execute(sql`SELECT
            pg_catalog.has_function_privilege(${expectedRole},${catalog.functionOid}::oid,'EXECUTE')
            AND pg_catalog.has_function_privilege(${expectedRole},${offline}::oid,'EXECUTE') AS ready`);
          if(allowed?.ready===true)reviewed={checkout:catalog.functionOid,offline};
        }
      }
    }
    const slotLock = await inspectSeckillTimeReferenceLock(tx);
    let reviewedSlotLock: string | null = null;
    if (kind === 'admin' && seckillTimeReferenceLockCatalogReady(slotLock) && slotLock.functionOid) {
      const [execute] = await tx.execute(sql`SELECT pg_catalog.has_function_privilege(${expectedRole},${slotLock.functionOid}::oid,'EXECUTE') AS allowed`);
      if (execute?.allowed === true) reviewedSlotLock = slotLock.functionOid;
    }
    if (kind === 'admin' && !reviewedSlotLock) failures.push('seckill_time_reference_capability');
    // Optional, separately installed type-4-only capability. Its exact body,
    // restricted NOLOGIN owner, table grants and EXECUTE ACL are all reviewed
    // before its SECURITY DEFINER OID can enter the runtime allowlist.
    const supplierMenuWrite = await inspectAdminSupplierMenuWriteCapability(tx,names.admin);
    if (!supplierMenuWrite.absent && !supplierMenuWrite.ready) failures.push('supplier_menu_capability');
    const reviewedSupplierMenu = kind === 'admin' && supplierMenuWrite.ready
      ? supplierMenuWrite.functionOid : null;
    const messageRead=await inspectUserMessageReadCapability(tx,names.app);
    if(!messageRead.absent && !messageRead.ready)failures.push('user_message_read_capability');
    const reviewedMessageRead=kind==='app' && messageRead.ready?messageRead.functionOid:null;
    // Supplier label DML stays denied on the App tables. Only a separately
    // installed exact function/owner/ACL may supply this narrow write port.
    const supplierLabelWrite = await inspectSupplierProductLabelCapability(tx,
      { app: names.app, admin: names.admin, maintenance: names.maintenance });
    if (!supplierLabelWrite.absent && !supplierLabelWrite.ready) failures.push('supplier_product_label_capability');
    const reviewedSupplierLabel = kind === 'app' && supplierLabelWrite.ready
      ? supplierLabelWrite.functionOid : null;
    onStage?.('routines');
    const [routines]=await tx.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname<>'information_schema' AND pg_catalog.has_function_privilege(${expectedRole},p.oid,'EXECUTE')
      AND p.oid::text IS DISTINCT FROM ${reviewed.checkout} AND p.oid::text IS DISTINCT FROM ${reviewed.offline}
      AND p.oid::text IS DISTINCT FROM ${reviewedSlotLock}
      AND p.oid::text IS DISTINCT FROM ${reviewedAuthorityMenuLock}
      AND p.oid::text IS DISTINCT FROM ${reviewedSupplierMenu}
      AND p.oid::text IS DISTINCT FROM ${reviewedMessageRead}

      AND p.oid::text IS DISTINCT FROM ${reviewedSupplierLabel}
      AND p.oid::text IS DISTINCT FROM ${reviewedPlatformMenu}
      AND p.oid::text IS DISTINCT FROM ${reviewedRoutineWrite}) AS no_unreviewed_definer,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
        AND pg_catalog.has_function_privilege(${expectedRole},p.oid,'EXECUTE WITH GRANT OPTION')) AS no_delegation`);
    if(routines?.no_unreviewed_definer!==true || routines?.no_delegation!==true)failures.push('routine_authority');
    onStage?.('defaults');
    const [defaults]=await tx.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d
      CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${expectedRole})
        OR (a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS safe`);
    if(defaults?.safe!==true)failures.push('default_grants');
    if(kind==='app' && (!reviewed.checkout || !reviewed.offline))failures.push('pricing_capabilities');
    onStage?.('staff');
    if(!(await inspectRuntimeAdminBoundary(tx,names.app,names.maintenance,cashierBinding)).ready)failures.push('staff_boundary');
    onStage?.('locks');
    if(!(await inspectRuntimeLockOnlyBoundary(tx,names.app,names.admin,names.maintenance,(version==='current' || version==='pre-physical-origin')?'agent-levels':version==='pre-agent-levels' || version==='pre-sign-day'?'promotion-gifts':'legacy',cashierBinding)).ready)failures.push('lock_only_boundary');
    onStage?.('schedule_locks');
    const scheduleBoundary=await inspectRuntimeSeckillScheduleLockBoundary(tx,names,cashierBinding);
    if(version!=='legacy-seckill-schedule'? !scheduleBoundary.ready : !scheduleBoundary.absent || !scheduleBoundary.tablesSafe)
      failures.push('seckill_schedule_lock_boundary');
    if(((version==='current' || version==='pre-physical-origin') || version==='pre-agent-levels' || version==='pre-sign-day' || version==='pre-full-gifts' || version==='pre-coupon-templates') && !(await inspectSeckillParentRuntimeSequence(tx,names.maintenance)).ready)
      failures.push('seckill_parent_serial_sequence');
    if((version==='current' || version==='pre-physical-origin') || version==='pre-agent-levels' || version==='pre-sign-day' || version==='pre-full-gifts') {
      onStage?.('coupon_templates');
      if(!(await inspectCouponTemplateCatalog(tx,names.maintenance)).ready)failures.push('coupon_template_catalog');
    }
    if(((version==='current' || version==='pre-physical-origin') || version==='pre-agent-levels' || version==='pre-sign-day') && !(await inspectOrderPromotionGiftReceiptCatalog(tx,names.maintenance,names,peers)).ready)
      failures.push('promotion_gift_receipt_catalog');
    if(((version==='current' || version==='pre-physical-origin') || version==='pre-agent-levels' || version==='pre-sign-day') && !(await inspectPromotionManagementRuntimeSequences(tx,names.maintenance)).ready)
      failures.push('promotion_management_serial_sequences');
    if(((version==='current' || version==='pre-physical-origin') || version==='pre-agent-levels' || version==='pre-sign-day') && !(await inspectRuntimePurchaseGiftEvidence(tx,names.maintenance)).ready)
      failures.push('promotion_gift_cancellation_protocol');
    if((version==='current' || version==='pre-physical-origin') || version==='pre-agent-levels') {
      onStage?.('sign_day_config');
      if(!(await inspectSignDayConfigRuntimeCatalog(tx,names.maintenance,names)).ready)failures.push('sign_day_config_catalog');
    }
    const signDayGroupBoundary=await inspectRuntimeSignDayGroupLockBoundary(tx,names);
    if((version==='current' || version==='pre-physical-origin') || version==='pre-agent-levels'? !signDayGroupBoundary.ready : !signDayGroupBoundary.absent || !signDayGroupBoundary.tablesSafe)
      failures.push('sign_day_group_lock_boundary');
    onStage?.('agent_levels');
    const agentBoundary=await inspectRuntimeAgentLevelCatalogBoundary(tx,names,cashierBinding);
    if((version==='current' || version==='pre-physical-origin') ? !agentBoundary.ready : !agentBoundary.absent || !agentBoundary.tablesSafe)
      failures.push('agent_level_catalog_boundary');
    if((version==='current' || version==='pre-physical-origin') && !(await inspectAgentLevelRuntimeCatalog(tx,names.maintenance,names,cashierBinding)).ready)
      failures.push('agent_level_catalog');
    onStage?.('purchase_evidence');
    if(!(await inspectRuntimePurchaseEvidence(tx,names.maintenance)).ready)failures.push('purchase_evidence_protocols');
    if(version==='current' && !(await inspectRuntimePurchasePhysicalEvidence(tx,names.maintenance)).ready)failures.push('purchase_physical_origin_protocol');
    // Bind the complete canonical set before maintenance callers cap diagnostics.
    const unique=[...new Set(failures)].sort();
    return {ready:unique.length===0,readOnly:true as const,completeServiceCoverageVerified:false as const,kind,
      failures:unique,failureSetSha256:await outRequestHash(unique),tableCount:present.size,sequenceCount:sequences.length};
}
