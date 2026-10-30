import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { ADMIN_WECHAT_APP_OPERATION_SQL, inspectAdminWechatAppOperation } from './adminWechatAppOperation';
import { NATIVE_APP_PAYMENT_AUTHORITY_SQL, inspectNativeAppPaymentAuthority } from './nativeAppPaymentAuthority';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const ADMIN_WECHAT_APP_UPGRADE = 'admin-wechat-app-payment-authority-v1';

/** Explicit maintenance only. Exact existing current runtime profiles precede
 * installation; the operation receipt, historical accounts, order evidence and
 * exact App/Admin grants commit together. No business rows, credentials or old stages are
 * rewritten. Neither an HTTP request nor startup imports/calls this installer. */
export async function installAdminWechatAppUpgradeInTransaction(tx: Pick<DbClient,'execute'>, target: SeckillScheduleRuntimeTarget) {
  if (Object.hasOwn(tx,'$client')) throw Error('WechatApp operation upgrade requires an existing maintenance transaction');
  const identities = [target.maintenance,target.app,target.admin];
  [...identities,target.database].forEach(pricingIdentifier);
  if (new Set(identities).size !== 3) throw Error('Distinct WechatApp operation maintenance/runtime identities required');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','5000',true),
    set_config('lock_timeout','1000',true),set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [context] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND current_user=session_user AND current_schema()='public' AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (context?.supported !== true) throw Error('WechatApp operation upgrade requires explicit PG16 owner/database maintenance');
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731663,0) AS locked`);
  if (gate?.locked !== true) throw Error('WechatApp operation commissioning is busy');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  // Inspect presence only after acquiring the shared commissioning namespace.
  // No operation-only addon was deployed: a partial bundle is not a predecessor
  // version and must never be silently completed or repaired.
  const [objects] = await tx.execute(sql`SELECT
    to_regclass('public.admin_wechat_app_operation') IS NOT NULL AS operation_present,
    to_regclass('public.native_app_payment_account') IS NOT NULL AS account_present,
    to_regclass('public.native_app_payment_evidence') IS NOT NULL AS evidence_present,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND proname='admin_wechat_app_operation_immutable_v1') AS operation_function_present,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND proname='native_app_payment_account_immutable_v1') AS account_function_present,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND proname='native_app_payment_evidence_immutable_v1') AS evidence_function_present,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'native_app_payment_') OR starts_with(relname,'napa_') OR starts_with(relname,'nape_')
        OR starts_with(relname,'admin_wechat_app_operation') OR starts_with(relname,'awao_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND (starts_with(proname,'native_app_payment_') OR starts_with(proname,'napa_') OR starts_with(proname,'nape_')
        OR starts_with(proname,'admin_wechat_app_operation') OR starts_with(proname,'awao_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace
      AND (starts_with(conname,'napa_') OR starts_with(conname,'nape_') OR starts_with(conname,'awao_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      WHERE c.relnamespace='public'::regnamespace
      AND (starts_with(t.tgname,'napa_') OR starts_with(t.tgname,'nape_') OR starts_with(t.tgname,'awao_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace
      AND (starts_with(typname,'native_app_payment_') OR starts_with(typname,'_native_app_payment_')
        OR starts_with(typname,'napa_') OR starts_with(typname,'nape_'))) AS any_owned_object`);
  if (!objects || typeof objects.any_owned_object !== 'boolean') throw Error('WechatApp bundle presence inspection failed');
  const complete = objects && ['operation_present', 'account_present', 'evidence_present', 'operation_function_present',
    'account_function_present', 'evidence_function_present'].every(key => objects[key] === true);
  const present = objects?.any_owned_object === true;
  if (present && !complete) throw Error('Partial WechatApp operation/payment authority bundle requires review');
  if (present) await tx.execute(sql.raw('LOCK TABLE ONLY public.admin_wechat_app_operation, ONLY public.native_app_payment_account, ONLY public.native_app_payment_evidence IN ACCESS EXCLUSIVE MODE NOWAIT'));
  const inspect = async () => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,'current'),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,'current'),
  });
  const before = await inspect();
  if (!before.app.ready || !before.admin.ready) throw Error('WechatApp operation commissioning requires exact existing runtime profiles');
  if (present) {
    if (!await inspectAdminWechatAppOperation(tx,target) || !await inspectNativeAppPaymentAuthority(tx,target))
      throw Error('Existing WechatApp operation/payment authority catalog/owner/ACL drift requires review');
    return { operation: ADMIN_WECHAT_APP_UPGRADE, applied: false as const };
  }
  await tx.execute(sql.raw(ADMIN_WECHAT_APP_OPERATION_SQL + NATIVE_APP_PAYMENT_AUTHORITY_SQL));
  // Reject unexpected default grants instead of repairing somebody else's ACL.
  if (!await inspectAdminWechatAppOperation(tx) || !await inspectNativeAppPaymentAuthority(tx))
    throw Error('WechatApp operation/payment authority initial owner-only catalog verification failed');
  await tx.execute(sql.raw(`GRANT SELECT, INSERT ON TABLE public.admin_wechat_app_operation, public.native_app_payment_account TO ${pricingIdentifier(target.admin)};
GRANT SELECT ON TABLE public.native_app_payment_account TO ${pricingIdentifier(target.app)};
GRANT SELECT, INSERT ON TABLE public.native_app_payment_evidence TO ${pricingIdentifier(target.app)}`));
  if (!await inspectAdminWechatAppOperation(tx,target) || !await inspectNativeAppPaymentAuthority(tx,target))
    throw Error('WechatApp operation/payment authority installed catalog/ACL verification failed');
  const after = await inspect();
  if (!after.app.ready || !after.admin.ready) throw Error('WechatApp operation commissioned runtime profiles failed verification');
  return { operation: ADMIN_WECHAT_APP_UPGRADE, applied: true as const };
}

export async function runAdminWechatAppUpgrade(db: DbClient, target: SeckillScheduleRuntimeTarget) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('WechatApp operation upgrade requires a root maintenance connection');
  return db.transaction(tx => installAdminWechatAppUpgradeInTransaction(tx,target), { isolationLevel: 'read committed', accessMode: 'read write' });
}
