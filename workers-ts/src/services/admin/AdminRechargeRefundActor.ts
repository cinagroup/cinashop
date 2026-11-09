import { timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin } from '@/models/schema';
import { ApiErrorCode, AuthException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService } from './AdminPermissionService';
import { RECHARGE_REFUND_PERMISSION } from './AdminRechargeRefundPermission';

export interface AdminRechargeRefundActor {
  readonly id: number;
  readonly authVersion: string;
  readonly expiresAt: number;
}

export function captureAdminRechargeRefundActor(value: AdminRechargeRefundActor): Readonly<AdminRechargeRefundActor> {
  if (!value || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1 || value.id > 2_147_483_647
    || typeof value.authVersion !== 'string' || value.authVersion.length !== 32 || !/^[a-f0-9]{32}$/.test(value.authVersion)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  return Object.freeze({ id: value.id, authVersion: value.authVersion, expiresAt: value.expiresAt });
}

/** Same SQL snapshot as the operation. A generic order/refund/user capability
 * does not grant recharge refunds. Mutation admission pins role/menu rows to
 * commit; a status lookup uses its caller's REPEATABLE READ READ ONLY snapshot. */
export async function authorizeAdminRechargeRefundTx(tx: DbClient, input: AdminRechargeRefundActor,
  mode: 'write' | 'read' = 'write'): Promise<void> {
  const actor = captureAdminRechargeRefundActor(input);
  if (Object.hasOwn(tx, '$client')) throw new ServiceUnavailableException('充值退款权限须在业务事务内核对');
  if (mode !== 'write' && mode !== 'read') throw new ServiceUnavailableException('充值退款权限读取方式无效');
  const expired = () => actor.expiresAt <= Math.floor(Date.now() / 1000);
  if (expired()) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  await tx.execute(sql`SELECT
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [context] = await tx.execute<{ ready: boolean }>(sql`SELECT
    pg_catalog.current_schema()='public' AND pg_catalog.current_setting('session_replication_role')='origin'
    AND pg_catalog.to_regclass('system_admin')=pg_catalog.to_regclass('public.system_admin')
    AND pg_catalog.to_regclass('system_role')=pg_catalog.to_regclass('public.system_role')
    AND pg_catalog.to_regclass('system_menus')=pg_catalog.to_regclass('public.system_menus')
    AND (${mode}='write' AND pg_catalog.current_setting('transaction_read_only')='off'
      OR ${mode}='read' AND pg_catalog.current_setting('transaction_isolation')='repeatable read'
        AND pg_catalog.current_setting('transaction_read_only')='on') AS ready`);
  if (context?.ready !== true) throw new ServiceUnavailableException('充值退款权限事务来源无效');
  try {
    const query = tx.select({ id: systemAdmin.id, pwd: systemAdmin.pwd, adminType: systemAdmin.adminType,
      status: systemAdmin.status, isDel: systemAdmin.isDel, level: systemAdmin.level, roles: systemAdmin.roles })
      .from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
    const [admin] = await (mode === 'write' ? query.for('share', { noWait: true }) : query);
    if (!admin || admin.adminType !== 1 || admin.status !== 1 || admin.isDel !== 0) {
      throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
    }
    const encoder = new TextEncoder();
    if (!timingSafeEqual(encoder.encode(md5(admin.pwd)), encoder.encode(actor.authVersion))) {
      throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    }
    if (admin.level !== 0) {
      const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(admin.roles, mode === 'write');
      if (!keys.has(RECHARGE_REFUND_PERMISSION)) throw new AuthException('没有充值退款权限', ApiErrorCode.ERR_AUTH);
    }
    if (expired()) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('管理员权限正在变更，请刷新后重新确认');
      cause = 'cause' in cause ? cause.cause : undefined;
    }
    throw error;
  }
}
