import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { configFlag } from '@/services/activity/StoreNewcomerService';

/** PHP Register listener -> StoreNewcomerServices::setUserLevel, for NEW users
 * only. Call after identity locks/duplicate checks, immediately before INSERT.
 * Both switches share one SQL snapshot; no eventually-consistent KV authority.
 * The returned flag is inserted with the account so gifts/identity/replay writes
 * commit or roll back together. This does not activate existing login users,
 * assign a level, grant manual-activation gifts, or backfill historical accounts.
 */
export async function readRegistrationLevelStatus(tx: DbClient): Promise<0 | 1> {
  const value = (name: string) => sql<string | null>`(
    SELECT ${systemConfig.value} FROM ${systemConfig}
    WHERE ${systemConfig.isStore} = 0 AND ${systemConfig.menuName} = ${name}
    ORDER BY ${systemConfig.sort} DESC, ${systemConfig.id} DESC LIMIT 1
  )`;
  const [row] = await tx.select({
    member: value('member_func_status'), required: value('level_activate_status'),
  }).from(sql`(VALUES (1)) registration_level_policy(n)`);
  if (!row) throw new Error('新用户会员激活配置读取失败');
  // Match manual activation's existing flag normalization/defaults. Config
  // status is field visibility, not its value. Neither missing flag is enabled.
  return configFlag(row.member ?? undefined) && !configFlag(row.required ?? undefined) ? 1 : 0;
}
