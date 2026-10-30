import { createHash, createHmac } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { parseWechatRoutineStoredText } from '../../../../view/common/wechatRoutine';

/** Reserved for the Mini configuration author and its short consumer commits.
 * Native App731664, customer finance731665 and website Open731661 are separate.
 * Taking this gate is not evidence that an old identity belongs to an AppID.
 */
export const ROUTINE_CREDENTIAL_GATE = [731666, 0] as const;
export const ROUTINE_CREDENTIAL_KEYS = ['routine_appId', 'routine_appsecret'] as const;
export interface RoutineCredentials { appId: string; secret: string; stamp: string }
export interface RoutineAppIdSource { appId: string; stamp: string }
type RuntimeEnv = Pick<Env, 'APP_KEY'>;

/** Deterministic local configuration faults, distinct from SQL/transport faults. */
export class RoutineConfigurationError extends ServiceUnavailableException {}

async function rowsInTx(tx: DbClient, keys: readonly string[] = ROUTINE_CREDENTIAL_KEYS) {
  const rows = await tx.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` })
    .from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...keys])))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
  if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024)
    throw new RoutineConfigurationError('小程序配置超过完整读取容量，请维护后重试');
  return rows;
}

/** One SQL snapshot supplies the pair. No cfg_* cache or other WeChat realm
 * may provide either half. Author values stay lossless; provider credentials
 * retain the existing routine reader's whitespace normalization.
 */
async function configuredCredentialsInTx(tx: DbClient, env: RuntimeEnv): Promise<RoutineCredentials | null> {
  const rows = await rowsInTx(tx);
  const text = (key: string) => parseWechatRoutineStoredText(rows.find(row => row.menuName === key)?.value)?.trim() ?? '';
  const appId = text('routine_appId'), secret = text('routine_appsecret');
  if (!appId || !secret) return null;
  if (!env.APP_KEY) throw new RoutineConfigurationError('小程序运行时签名尚未配置');
  // Every shadow/version participates, including an A→B→A write. The public
  // name/contact/avatar settings do not revoke an otherwise unchanged pair.
  const stamp = createHmac('sha256', env.APP_KEY).update('cinashop.routine.credentials.v1\0')
    .update(JSON.stringify(rows)).digest('hex');
  return { appId, secret, stamp };
}

export async function readRoutineCredentialsInTx(tx: DbClient, env: RuntimeEnv): Promise<RoutineCredentials> {
  const credentials = await configuredCredentialsInTx(tx, env);
  if (!credentials) throw new RoutineConfigurationError('小程序微信登录凭据未完整配置');
  return credentials;
}

function read<T>(container: Container, action: (tx: DbClient) => Promise<T>) {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true), set_config('lock_timeout','2s',true)`);
    return action(tx);
  });
}

export function readRoutineCredentials(container: Container, env: RuntimeEnv) {
  return read(container, tx => readRoutineCredentialsInTx(tx, env));
}

/** Optional features may be disabled by an incomplete SQL pair. SQL/capacity
 * faults and a missing signing key remain errors; no cache fallback is used. */
export function readRoutineCredentialsIfConfigured(container: Container, env: RuntimeEnv): Promise<RoutineCredentials | null> {
  return read(container, tx => configuredCredentialsInTx(tx, env));
}

/** Public account selection is independent of an OAuth Secret and APP_KEY.
 * This reads the current public field; it does not identify an old payment.
 */
export function readRoutineAppId(container: Container): Promise<string> {
  return read(container, async tx => parseWechatRoutineStoredText((await rowsInTx(tx))
    .find(row => row.menuName === 'routine_appId')?.value)?.trim() ?? '');
}

async function appIdSourceInTx(tx: DbClient): Promise<RoutineAppIdSource> {
  const rows = await rowsInTx(tx, ['routine_appId']);
  const appId = parseWechatRoutineStoredText(rows[0]?.value)?.trim() ?? '';
  if (!appId || appId.length > 64 || /[\u0000-\u001f\u007f]/u.test(appId))
    throw new Error('wechat_callback_app_id_invalid');
  // This is public source identity, not an OAuth credential or an account
  // ownership witness. Secret rotation must not revoke a verified callback.
  const stamp = createHash('sha256').update('cinashop.routine.public-app-id.v1\0')
    .update(JSON.stringify(rows)).digest('hex');
  return { appId, stamp };
}

/** A new notification records its intended account in the caller's SQL
 * transaction. This is delivery intent, not proof of old UID/order ownership.
 * Missing configuration disables this optional channel without disabling SMS. */
export async function readRoutineNotificationAppIdInTx(tx: DbClient): Promise<string> {
  const rows = await rowsInTx(tx, ['routine_appId']);
  const appId = parseWechatRoutineStoredText(rows[0]?.value)?.trim() ?? '';
  if (appId.length > 64 || /[\u0000-\u001f\u007f]/u.test(appId))
    throw new RoutineConfigurationError('小程序通知 AppID 配置无效');
  return appId;
}

/** Callback admission needs only a fresh public AppID and deployment token/AES.
 * Include every public shadow row and xmin to detect changes and A→B→A. */
export function readRoutineAppIdSource(container: Container): Promise<RoutineAppIdSource> {
  return read(container, appIdSourceInTx);
}

/** Same author gate as OAuth, without requiring a Secret or APP_KEY. Only SQL
 * effects belong in action; signature/decryption/Queue/Redis I/O stay outside. */
export async function withRoutineAppId<T>(container: Container, expected: RoutineAppIdSource,
  action: (bound: Container) => Promise<T>): Promise<T> {
  const { appId, stamp } = expected;
  if (!/^[a-f0-9]{64}$/u.test(stamp) || !appId)
    throw new ValidateException('小程序微信配置已变化，请重新接收回调');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true), set_config('lock_timeout','2s',true), set_config('idle_in_transaction_session_timeout','5s',true)`);
    const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731666,0) AS locked`);
    if (gate?.locked !== true) throw new ServiceUnavailableException('小程序配置正在维护，请重新接收回调');
    const matches = async () => {
      const current = await appIdSourceInTx(tx);
      if (current.appId !== appId || current.stamp !== stamp)
        throw new ValidateException('小程序微信配置已变化，请重新接收回调');
    };
    await matches();
    const result = await action(createContainerFromDb(tx));
    await matches();
    const [deadline] = await tx.execute<{ valid: boolean }>(sql`SELECT clock_timestamp() <= transaction_timestamp() + interval '5 seconds' AS valid`);
    if (deadline?.valid !== true) throw new ServiceUnavailableException('小程序回调提交超过有效时限，请重新接收回调');
    return result;
  });
}

/** No Secret or raw provider identifier appears in a Redis key. Old global
 * and AppID-only token entries cannot be mistaken for this source namespace.
 */
export function routineCredentialCacheKey(credentials: Pick<RoutineCredentials, 'stamp'>, purpose: 'access_token'): string {
  if (!/^[a-f0-9]{64}$/u.test(credentials.stamp) || purpose !== 'access_token')
    throw new ValidateException('小程序凭据来源无效，请重新授权');
  return `routine:v2:${purpose}:${credentials.stamp}`;
}

/** Provider/Redis/SMS I/O belongs outside this short transaction. The caller's
 * identity changes use bound.db/the same connection and commit under this
 * shared gate; a future author uses its exclusive counterpart. The explicit
 * author and generic-writer closure must be integrated before enabling saves.
 */
export async function withRoutineCredentials<T>(container: Container, env: RuntimeEnv, expectedStamp: string,
  action: (bound: Container, credentials: RoutineCredentials) => Promise<T>): Promise<T> {
  if (!/^[a-f0-9]{64}$/u.test(expectedStamp)) throw new ValidateException('小程序微信配置已变化，请重新授权');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true), set_config('lock_timeout','2s',true), set_config('idle_in_transaction_session_timeout','5s',true)`);
    const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731666,0) AS locked`);
    if (gate?.locked !== true) throw new ServiceUnavailableException('小程序配置正在维护，请重新授权');
    const credentials = await readRoutineCredentialsInTx(tx, env);
    if (credentials.stamp !== expectedStamp) throw new ValidateException('小程序微信配置已变化，请重新授权');
    const result = await action(createContainerFromDb(tx), credentials);
    if ((await readRoutineCredentialsInTx(tx, env)).stamp !== expectedStamp)
      throw new ValidateException('小程序微信配置已变化，请重新授权');
    const [deadline] = await tx.execute<{ valid: boolean }>(sql`SELECT clock_timestamp() <= transaction_timestamp() + interval '5 seconds' AS valid`);
    if (deadline?.valid !== true) throw new ServiceUnavailableException('小程序登录提交超过有效时限，请重新授权');
    return result;
  });
}
