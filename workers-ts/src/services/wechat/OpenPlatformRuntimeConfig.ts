import { createHmac } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { WECHAT_OPEN_AUTHORITY_KEY, WECHAT_OPEN_KEYS, validWechatOpenAppId, validWechatOpenSecret } from '../../../../view/common/wechatOpen';

type RuntimeEnv = Pick<Env, 'APP_KEY' | 'WECHAT_OPEN_APP_SECRET'>;
export interface OpenPlatformCredentials {
  appId: string;
  secret: string;
  stamp: string;
  authority: 'deployment' | 'database';
}
const keys = [...WECHAT_OPEN_KEYS, WECHAT_OPEN_AUTHORITY_KEY];

/** Exact platform rows, including shadow metadata/xmin, form one fresh snapshot.
 * Never read or populate cfg_* KV, including for public AppID bootstrap. */
async function rowsInTx(tx: DbClient) {
  const rows = await tx.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` })
    .from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, keys)))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
  if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024) {
    throw new ServiceUnavailableException('开放平台配置超过完整读取容量，请维护后重试');
  }
  return rows;
}

export async function readOpenPlatformCredentialsInTx(tx: DbClient, env: RuntimeEnv): Promise<OpenPlatformCredentials> {
  const rows = await rowsInTx(tx);
  const raw = (key: string) => rows.find(row => row.menuName === key)?.value;
  const appId = normalizeConfigScalar(raw('wechat_open_app_id'));
  // Author readiness, state creation and code exchange share the exact valid
  // account boundary. Public bootstrap alone preserves imported source values.
  if (!validWechatOpenAppId(appId)) throw new ServiceUnavailableException('微信开放平台登录尚未配置');
  // Presence is deliberately checked before normalization. A malformed deployed
  // value must never silently switch the account to database authority.
  const deployment = env.WECHAT_OPEN_APP_SECRET;
  const deployed = deployment !== undefined && deployment !== '';
  const authority = deployed ? 'deployment' : raw(WECHAT_OPEN_AUTHORITY_KEY) === 'database' ? 'database' : null;
  const secret = deployed ? deployment : normalizeConfigScalar(raw('wechat_open_app_secret'));
  if (!authority || !validWechatOpenSecret(secret)) throw new ServiceUnavailableException('微信开放平台登录尚未配置');
  if (!env.APP_KEY) throw new ServiceUnavailableException('开放平台运行时签名尚未配置');
  const stamp = createHmac('sha256', env.APP_KEY).update('cinashop.open-platform.credentials.v1\0')
    .update(JSON.stringify({ rows, deployment, authority })).digest('hex');
  return { appId, secret, stamp, authority };
}

export async function readOpenPlatformCredentials(container: Container, env: RuntimeEnv): Promise<OpenPlatformCredentials> {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    return readOpenPlatformCredentialsInTx(tx, env);
  });
}

/** Public AppID remains usable without a Secret/APP_KEY; it is never cached. */
export async function readOpenPlatformAppId(container: Container): Promise<string> {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    return normalizeConfigScalar((await rowsInTx(tx)).find(row => row.menuName === 'wechat_open_app_id')?.value);
  });
}

/** No provider network request runs inside this barrier. Mature identity/login
 * services get a container bound to this transaction: their withTx calls are
 * same-connection SAVEPOINTs, so the shared lock survives through outer COMMIT. */
export async function withOpenPlatformCredentials<T>(
  container: Container, env: RuntimeEnv, expectedStamp: string,
  action: (bound: Container, credentials: OpenPlatformCredentials) => Promise<T>,
): Promise<T> {
  if (!/^[a-f0-9]{64}$/u.test(expectedStamp)) throw new ValidateException('微信授权配置已变化，请重新发起登录');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true), set_config('lock_timeout','2s',true), set_config('idle_in_transaction_session_timeout','5s',true)`);
    const [lock] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731661,0) AS locked`);
    if (lock?.locked !== true) throw new ServiceUnavailableException('开放平台配置正在维护，请重新发起登录');
    const credentials = await readOpenPlatformCredentialsInTx(tx, env);
    if (credentials.stamp !== expectedStamp) throw new ValidateException('微信授权配置已变化，请重新发起登录');
    const result = await action(createContainerFromDb(tx), credentials);
    if ((await readOpenPlatformCredentialsInTx(tx, env)).stamp !== expectedStamp) throw new ValidateException('微信授权配置已变化，请重新发起登录');
    const [deadline] = await tx.execute<{ valid: boolean }>(sql`SELECT clock_timestamp() <= transaction_timestamp() + interval '5 seconds' AS valid`);
    if (deadline?.valid !== true) throw new ServiceUnavailableException('微信登录提交超过有效时限，请重新发起登录');
    return result;
  });
}
