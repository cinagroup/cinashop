import type { DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { readRoutineCredentialsInTx, type RoutineCredentials } from '@/services/wechat/RoutineRuntimeConfig';
import { ServiceUnavailableException } from '@/utils/errors';

export const DIVISION_STAFF_INVITE_PAGE = 'pages/users/agent/bind';
export const DIVISION_STAFF_INVITE_TTL = 600;
/** SQL is authoritative for both the provider method and its before/after guard. */
export async function readDivisionStaffWechatCredentials(db: DbClient, env: Pick<Env, 'APP_KEY'>): Promise<RoutineCredentials> {
  const credentials = await readRoutineCredentialsInTx(db, env);
  const { appId, secret } = credentials;
  if (!appId || appId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(appId) || !secret || secret.length > 256) throw new ServiceUnavailableException('员工邀请小程序配置未完成');
  return credentials;
}
