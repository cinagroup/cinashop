import { eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin } from '@/models/schema';
import { AdminPermissionService } from './AdminPermissionService';
import { adminRefundReview } from './AdminRefundReadService';
import { ApiErrorCode, AuthException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import type { RefundExecutionScope } from '@/services/order/StoreOrderRefundService';

export interface AdminRefundDecisionActor { id: number; authVersion: string; expiresAt: number }
type Action = 'return' | 'refund' | 'refuse';

/** SQL-only admission. NOWAIT avoids acquiring authority locks in a wait cycle
 * with unrelated admin writers; every granted role/menu stays locked to commit. */
export async function authorizeAdminRefundActor(tx: DbClient, actor: AdminRefundDecisionActor): Promise<void> {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647
    || !/^[a-f0-9]{32}$/.test(actor.authVersion) || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  const expired = () => actor.expiresAt <= Math.floor(Date.now() / 1000);
  if (expired()) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  try {
    const [admin] = await tx.select({ id: systemAdmin.id, pwd: systemAdmin.pwd, adminType: systemAdmin.adminType,
      status: systemAdmin.status, isDel: systemAdmin.isDel, level: systemAdmin.level, roles: systemAdmin.roles })
      .from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1).for('share', { noWait: true });
    if (!admin || admin.adminType !== 1 || admin.status !== 1 || admin.isDel !== 0) throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
    const encoder = new TextEncoder();
    if (!timingSafeEqual(encoder.encode(md5(admin.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    if (admin.level !== 0) {
      const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(admin.roles, true);
      if (!keys.has('refund.manage')) throw new AuthException('退款操作权限已变化', ApiErrorCode.ERR_AUTH);
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

/** Live refund.manage authentication in the caller's RR/RO snapshot only.
 * No row/advisory lock, writer authority or permission-loss recovery is added.
 * The HTTP middleware separately verifies the admin JWT realm before selecting
 * its independent Admin connection. This rechecks the captured principal. */
export async function authorizeAdminRefundActorReadTx(tx: DbClient, actorInput: AdminRefundDecisionActor): Promise<void> {
  const actor = Object.freeze({ id: actorInput.id, authVersion: actorInput.authVersion, expiresAt: actorInput.expiresAt });
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647
    || typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (Object.hasOwn(tx, '$client')) throw new ServiceUnavailableException('退款执行状态必须在只读快照中核对');
  const [mode] = await tx.execute<{ ready: boolean }>(sql`SELECT
    pg_catalog.current_setting('transaction_isolation')='repeatable read'
    AND pg_catalog.current_setting('transaction_read_only')='on'
    AND pg_catalog.current_setting('session_replication_role')='origin'
    AND pg_catalog.current_schema()='public'
    AND pg_catalog.to_regclass('system_admin')=pg_catalog.to_regclass('public.system_admin')
    AND pg_catalog.to_regclass('system_role')=pg_catalog.to_regclass('public.system_role')
    AND pg_catalog.to_regclass('system_menus')=pg_catalog.to_regclass('public.system_menus') AS ready`);
  if (mode?.ready !== true) throw new ServiceUnavailableException('退款执行状态必须在只读快照中核对');
  const expired = () => actor.expiresAt <= Math.floor(Date.now() / 1000);
  if (expired()) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  const [admin] = await tx.select({ id: systemAdmin.id, pwd: systemAdmin.pwd, adminType: systemAdmin.adminType,
    status: systemAdmin.status, isDel: systemAdmin.isDel, level: systemAdmin.level, roles: systemAdmin.roles })
    .from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
  if (!admin || admin.adminType !== 1 || admin.status !== 1 || admin.isDel !== 0) throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
  const encoder = new TextEncoder();
  if (!timingSafeEqual(encoder.encode(md5(admin.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  if (admin.level !== 0) {
    const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(admin.roles, false);
    if (!keys.has('refund.manage')) throw new AuthException('退款操作权限已变化', ApiErrorCode.ERR_AUTH);
  }
  if (expired()) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}

export function adminRefundDecisionScope(review: unknown, value: unknown, action: Action, actor: AdminRefundDecisionActor): RefundExecutionScope {
  const scope = adminRefundReview(review);
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647
    || !/^[a-f0-9]{32}$/.test(actor.authVersion) || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('请重新读取退款状态并确认');
  const row = value as Record<string, unknown>;
  if (typeof row.applyType !== 'number' || ![1,2,3,4].includes(row.applyType)
    || typeof row.refundType !== 'number' || ![0,1,2,4,5].includes(row.refundType) || typeof row.received !== 'boolean') throw new ValidateException('退款决策快照无效');
  const decision = { applyType: row.applyType, refundType: row.refundType, received: row.received };
  if (action === 'return' && (![2,3].includes(decision.applyType) || ![0,1,2].includes(decision.refundType))) throw new ValidateException('此状态不能审批退货');
  if (action === 'refund' && [2,3].includes(decision.applyType) && (!decision.received
    || decision.applyType === 2 && decision.refundType !== 5 || decision.applyType === 3 && ![4,5].includes(decision.refundType))) throw new ValidateException('请先核对退货并确认已实际验收');
  const capturedActor = { ...actor };
  return { ...scope, authorizeLockedDecision: async (tx, refund) => {
    await authorizeAdminRefundActor(tx, capturedActor);
    if (refund.applyType !== decision.applyType || refund.refundType !== decision.refundType) throw new ValidateException('退款类型或状态已变化，请刷新后重新确认');
  } };
}
