import { createHmac } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { WECHAT_APP_KEYS, parseWechatAppStoredText } from '../../../../view/common/wechatApp';

type RuntimeEnv = Pick<Env, 'APP_KEY'>;
export interface NativeAppCredentials { appId: string; secret: string; stamp: string }

/** Only the two platform Native App rows participate. The complete winner and
 * shadow metadata/xmin are bound together; neither website Open nor cfg_* KV
 * can supply this account. Author text rules do not assert provider validity. */
async function rowsInTx(tx: DbClient) {
  const rows = await tx.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` })
    .from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...WECHAT_APP_KEYS])))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
  if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024)
    throw new ServiceUnavailableException('原生App配置超过完整读取容量，请维护后重试');
  return rows;
}

export async function readNativeAppCredentialsInTx(tx: DbClient, env: RuntimeEnv): Promise<NativeAppCredentials> {
  const rows = await rowsInTx(tx);
  const text = (key: string) => parseWechatAppStoredText(rows.find(row => row.menuName === key)?.value);
  const appId = text('wechat_app_appid'), secret = text('wechat_app_appsecret');
  if (!appId || !secret) throw new ServiceUnavailableException('原生App微信登录凭据未完整配置');
  if (!env.APP_KEY) throw new ServiceUnavailableException('原生App运行时签名尚未配置');
  const stamp = createHmac('sha256', env.APP_KEY).update('cinashop.native-app.credentials.v1\0')
    .update(JSON.stringify(rows)).digest('hex');
  return { appId, secret, stamp };
}

function read<T>(container: Container, action: (tx: DbClient) => Promise<T>) {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true), set_config('lock_timeout','2s',true)`);
    return action(tx);
  });
}
export function readNativeAppCredentials(container: Container, env: RuntimeEnv) {
  return read(container, tx => readNativeAppCredentialsInTx(tx, env));
}

/** Payment readiness needs the public field, independently of an OAuth Secret.
 * This primitive does not select historical payment identity for an old order. */
export function readNativeAppAppId(container: Container): Promise<string> {
  return read(container, async tx => parseWechatAppStoredText((await rowsInTx(tx))
    .find(row => row.menuName === 'wechat_app_appid')?.value) ?? '');
}

/** Provider I/O finishes before this shared account fence. Nested identity and
 * login transactions use the same connection through SAVEPOINTs. The author
 * must acquire the exclusive731664 fence before rotating either field. */
export async function withNativeAppCredentials<T>(container: Container, env: RuntimeEnv, expectedStamp: string,
  action: (bound: Container, credentials: NativeAppCredentials) => Promise<T>): Promise<T> {
  if (!/^[a-f0-9]{64}$/u.test(expectedStamp)) throw new ValidateException('原生App微信配置已变化，请重新登录');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true), set_config('lock_timeout','2s',true), set_config('idle_in_transaction_session_timeout','5s',true)`);
    const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731664,0) AS locked`);
    if (gate?.locked !== true) throw new ServiceUnavailableException('原生App配置正在维护，请重新登录');
    // The App LOGIN is SELECT-only on system_config and cannot take a SHARE
    // table lock. Public admission requires every generic App writer to be
    // closed; the dedicated author takes the exclusive account gate.
    const credentials = await readNativeAppCredentialsInTx(tx, env);
    if (credentials.stamp !== expectedStamp) throw new ValidateException('原生App微信配置已变化，请重新登录');
    const result = await action(createContainerFromDb(tx), credentials);
    if ((await readNativeAppCredentialsInTx(tx, env)).stamp !== expectedStamp)
      throw new ValidateException('原生App微信配置已变化，请重新登录');
    const [deadline] = await tx.execute<{ valid: boolean }>(sql`SELECT clock_timestamp() <= transaction_timestamp() + interval '5 seconds' AS valid`);
    if (deadline?.valid !== true) throw new ServiceUnavailableException('原生App登录提交超过有效时限，请重新登录');
    return result;
  });
}
