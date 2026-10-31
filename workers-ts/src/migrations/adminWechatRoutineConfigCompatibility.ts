import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_SIGNATURE } from './adminWechatRoutineWriteCapability';
import { inspectAdminWechatRoutineWriteCatalog } from './adminWechatRoutineWriteCatalog';

/** The shared maintenance gate remains held through the caller's business
 * commit. Only the complete OID-bound bundle may coexist with another config
 * author; an absent bundle retains that author's original no-trigger rule. */
export async function reviewedAdminWechatRoutineConfigGuardOid(tx: Pick<DbClient, 'execute'>): Promise<string | null> {
  try {
    if (Object.hasOwn(tx, '$client')) throw Error('An existing author transaction is required');
    const [gate] = await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(731667,0) AS locked`);
    if (gate?.locked !== true) throw Error('Routine maintenance is busy');
    const catalog = await inspectAdminWechatRoutineWriteCatalog(tx);
    if (!catalog.present) return null;
    if (!catalog.ready || !catalog.binding) throw Error('Routine author catalog is incomplete or drifted');
    const [caller] = await tx.execute<{ ready: boolean; guard_oid: string | null }>(sql`SELECT
      current_user=session_user AND current_user=${catalog.binding.admin}::name
        AND r.oid=${catalog.binding.adminOid}::oid AS ready,
      pg_catalog.to_regprocedure(${ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_SIGNATURE})::oid::text AS guard_oid
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (caller?.ready !== true || typeof caller.guard_oid !== 'string'
      || !/^[1-9][0-9]*$/.test(caller.guard_oid) || Number(caller.guard_oid) > 4294967295) {
      throw Error('Routine config guard or its bound Admin is unavailable');
    }
    return caller.guard_oid;
  } catch {
    throw new ServiceUnavailableException('微信小程序配置维护或目录校验未就绪，请稍后重新核对');
  }
}
