import { eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin } from '@/models/schema';
import { ApiErrorCode, AuthException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { assertAdminAuthoritySession, parseAdminAuthorityRoleIds, type AdminAuthorityActor } from './AdminAuthorityWriteService';

/** Read-side authority does not acquire row locks or repair legacy roles. */
export async function authorizeAdminLegacyProductRead(tx: DbClient, actor: AdminAuthorityActor, permission = 'product.view'): Promise<void> {
  assertAdminAuthoritySession(actor);
  const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
  if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
    || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
  const encoder = new TextEncoder();
  if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(live.roles), live.level);
  const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
  if (live.level !== 0 && !hasAdminPermission(keys, permission)) throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
}
export async function assertAdminLegacyProductReadDeadline(tx: DbClient, actor: AdminAuthorityActor): Promise<void> {
  const [clock] = await tx.execute(sql`SELECT extract(epoch FROM clock_timestamp())>=${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
  if (clock?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  assertAdminAuthoritySession(actor);
}
