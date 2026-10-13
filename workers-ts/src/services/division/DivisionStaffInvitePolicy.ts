import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ServiceUnavailableException } from '@/utils/errors';

export const DIVISION_STAFF_INVITE_PAGE = 'pages/users/agent/bind';
export const DIVISION_STAFF_INVITE_TTL = 600;
/** SQL is authoritative for both the provider method and its before/after guard. */
export async function readDivisionStaffWechatCredentials(db: DbClient): Promise<{ appId: string; secret: string }> {
  const rows = await db.select({ name: systemConfig.menuName, value: systemConfig.value }).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, ['routine_appId', 'routine_appsecret'])));
  if (rows.length !== 2 || new Set(rows.map(row => row.name)).size !== 2) throw new ServiceUnavailableException('员工邀请小程序配置未完成');
  const appId = normalizeConfigScalar(rows.find(row => row.name === 'routine_appId')?.value).trim();
  const secret = normalizeConfigScalar(rows.find(row => row.name === 'routine_appsecret')?.value).trim();
  if (!appId || appId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(appId) || !secret || secret.length > 256) throw new ServiceUnavailableException('员工邀请小程序配置未完成');
  return { appId, secret };
}
