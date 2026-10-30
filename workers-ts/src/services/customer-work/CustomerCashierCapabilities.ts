import { sql } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { AuthException, ApiErrorCode, HttpApiException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { captureCashierRuntimeConditionalBinding, type CashierRuntimeConditionalBinding } from '@/migrations/cashierRuntimeConditionalBinding';
import { captureCashierConditionalTarget, inspectCashierRuntimeConditionalBoundary } from '@/migrations/cashierRuntimeConditionalBoundary';
import type { RoutinePaymentRuntimeTarget } from '@/migrations/routinePaymentRuntime';
import { cashierSecondCardOriginReadiness } from '@/migrations/runCashierSecondCardOrigin';
import { cashierSecondCardAbandonReadiness } from '@/migrations/runCashierSecondCardAbandon';
import { cashierSecondCardFormImagesReadiness } from '@/migrations/runCashierSecondCardFormImages';
import { cashierFormBaseReadiness } from './CustomerCashierFormImages';
import { authorizeCustomerWorkActor, type CustomerWorkActor, type CustomerWorkScope } from './CustomerWorkScope';
import { freezeCustomerActor } from './CustomerWorkOperationRequest';

export const CUSTOMER_CASHIER_CAPABILITIES_VERSION = 'customer-cashier-capabilities-v1' as const;
export const CUSTOMER_CASHIER_CAPABILITY_LEASE_SECONDS = 60;
type Query = Pick<DbClient, 'execute'>;
export interface CustomerCashierCapabilityContext {
  readonly application: Container;
  readonly binding: CashierRuntimeConditionalBinding;
  readonly target: RoutinePaymentRuntimeTarget;
  readonly applicationRoleOid: string;
}
const unavailable = () => new HttpApiException('次卡收银能力的独立运行绑定尚未完成核对', 503, 503);
async function bounded(db: Query) {
  await db.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
async function actualIdentity(db: Query, binding: CashierRuntimeConditionalBinding, role: string, roleOid?: string) {
  const rows = await db.execute<{ ready: boolean; role_oid: string }>(sql`SELECT r.oid::text AS role_oid,
    current_database()=${binding.database} AND d.oid::text=${binding.databaseOid}
    AND current_user=${role} AND session_user=current_user
    AND (${roleOid ?? null}::text IS NULL OR r.oid::text=${roleOid ?? null})
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid() AND usesysid=r.oid)
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
    AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
    AND NOT pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready
    FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_database d WHERE r.rolname=current_user AND d.datname=current_database()`);
  if (rows.length !== 1 || rows[0].ready !== true || !/^[1-9][0-9]*$/u.test(rows[0].role_oid)) throw unavailable();
  return rows[0].role_oid;
}
async function applicationIdentity(application: Container, binding: CashierRuntimeConditionalBinding,
  target: RoutinePaymentRuntimeTarget, roleOid?: string) {
  return application.db.transaction(async tx => {
    await bounded(tx); return actualIdentity(tx, binding, target.app, roleOid);
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
/** Only the dedicated capability middleware calls this, after full App JWT
 * authentication and before opening Cashier. Scope hashes alone do not bind
 * two databases. Configuration is the trusted formal maintenance result. */
export async function prepareCustomerCashierCapabilityContext(application: Container, env: Env): Promise<CustomerCashierCapabilityContext> {
  try {
    const binding = Object.freeze(captureCashierRuntimeConditionalBinding(env.CUSTOMER_CASHIER_RUNTIME_IDENTITY!));
    const target = captureCashierConditionalTarget(env.CUSTOMER_CASHIER_RUNTIME_TARGET!, binding.role);
    if (target.database !== binding.database) throw unavailable();
    Object.freeze(target.local); if (target.caseLock) { Object.freeze(target.caseLock.runtimeRoles); Object.freeze(target.caseLock); }
    Object.freeze(target);
    const applicationRoleOid = await applicationIdentity(application, binding, target);
    return Object.freeze({ application, binding, target, applicationRoleOid });
  } catch { throw unavailable(); }
}
function sameScope(left: CustomerWorkScope, right: CustomerWorkScope) {
  if (left.actor_uid !== right.actor_uid || left.service_id !== right.service_id || left.scope_key !== right.scope_key)
    throw new HttpApiException('次卡收银经营资格已变化，请重新读取', 403, 403);
}
const state = (ready: boolean, reason: string) => ({ ready, reason: ready ? '' : reason });
/** Short independent UI hint only. No grants, row locks, business writes or
 * server bearer lease. Every author and original receipt retains its own auth. */
export class CustomerCashierCapabilities {
  constructor(readonly container: Container, readonly context: CustomerCashierCapabilityContext) {}
  async read(value: CustomerWorkActor) {
    const actor = freezeCustomerActor(value), { application, binding, target, applicationRoleOid } = this.context;
    const appScope = await application.db.transaction(async tx => {
      await bounded(tx); await actualIdentity(tx, binding, target.app, applicationRoleOid);
      return authorizeCustomerWorkActor(tx as unknown as DbClient, actor);
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    const result = await this.container.db.transaction(async tx => {
      await bounded(tx); await actualIdentity(tx, binding, binding.role, binding.roleOid);
      const db = tx as unknown as DbClient, scope = await authorizeCustomerWorkActor(db, actor); sameScope(appScope, scope);
      const origin = await cashierSecondCardOriginReadiness(tx), formBase = await cashierFormBaseReadiness(tx),
        abandon = await cashierSecondCardAbandonReadiness(tx), conditional = await inspectCashierRuntimeConditionalBoundary(tx, target, binding.role),
        formImages = await cashierSecondCardFormImagesReadiness(tx);
      if (!conditional.binding || JSON.stringify(conditional.binding) !== JSON.stringify(binding)) throw unavailable();
      const readiness = { origin: state(origin.ready, origin.reason), form_base: state(formBase.ready, formBase.reason),
        abandon: state(abandon.ready, abandon.reason), conditional: state(conditional.ready, 'cashier_conditional_runtime_unavailable'),
        form_images: state(formImages.ready, formImages.reason) };
      const ready = readiness.origin.ready && readiness.form_base.ready && readiness.abandon.ready && readiness.conditional.ready;
      const imagesReady = ready && readiness.form_images.ready;
      const runtime_revision = await outRequestHash({ version: CUSTOMER_CASHIER_CAPABILITIES_VERSION,
        binding, target, applicationRoleOid, functions: conditional.functions, triggers: conditional.triggers,
        origin: origin.catalog, form_images: formImages.catalog, readiness });
      return { scope, readiness, runtime_revision, ready, imagesReady };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    // Both connections get fresh READ ONLY checks after the multi-query
    // snapshot; expired passwords, revoked/duplicate qualifications or scope
    // changes cannot publish an old capability. No global App consistency read.
    await application.db.transaction(async tx => {
      await bounded(tx); await actualIdentity(tx, binding, target.app, applicationRoleOid);
      sameScope(result.scope, await authorizeCustomerWorkActor(tx as unknown as DbClient, actor));
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    await this.container.db.transaction(async tx => {
      await bounded(tx); await actualIdentity(tx, binding, binding.role, binding.roleOid);
      sameScope(result.scope, await authorizeCustomerWorkActor(tx as unknown as DbClient, actor));
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    const issued_at = Math.floor(Date.now()/1000), expires_at = Math.min(issued_at + CUSTOMER_CASHIER_CAPABILITY_LEASE_SECONDS, actor.expires_at);
    if (expires_at <= issued_at) throw new AuthException('手机订单管理会话已失效', ApiErrorCode.ERR_EXPIRED);
    const data = { capabilities: { cashier_second_card: result.ready, cashier_form_images: result.imagesReady },
      readiness: result.readiness, runtime_revision: result.runtime_revision,
      lease: { issued_at, expires_at, session_expires_at: actor.expires_at } };
    return { version: CUSTOMER_CASHIER_CAPABILITIES_VERSION, actor_uid: actor.uid,
      principal: { kind: 'customer-order-manager' as const, service_id: result.scope.service_id, scope: 'global' as const },
      scope_key: result.scope.scope_key,
      consistency_key: await outRequestHash({ version: CUSTOMER_CASHIER_CAPABILITIES_VERSION, actor_uid: actor.uid,
        service_id: result.scope.service_id, scope_key: result.scope.scope_key, data }), data };
  }
}
