import { createHmac } from 'node:crypto';
import { desc, eq, inArray, and, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { systemConfig } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ValidateException } from '@/utils/errors';
import { validateWechatCallbackSecret } from './WechatCallbackCrypto';
import { WECHAT_BASE_CALLBACK_AUTHORITY_KEY, type WechatBaseMode } from '../../../../view/common/wechatBase';

type RuntimeEnv = Pick<Env, 'APP_KEY' | 'WECHAT_OFFICIAL_CALLBACK_TOKEN' | 'WECHAT_OFFICIAL_CALLBACK_AES_KEY'>;
export interface OfficialAccountCredentials { appId: string; secret: string; stamp: string }
export interface OfficialAccountCallbackConfig {
  appId: string;
  token: string;
  aesKey: string;
  mode: WechatBaseMode;
  authority: 'deployment' | 'database';
}

/** Read exact platform keys in one fresh, bounded snapshot. No cfg_* KV reads
 * or writes: both winners and all shadow-row identities belong to this read. */
async function rowsInTx(tx: DbClient, keys: readonly string[]) {
    const rows = await tx.select({
      id: systemConfig.id, isStore: systemConfig.isStore, menuName: systemConfig.menuName,
      type: systemConfig.type, inputType: systemConfig.inputType, configTabId: systemConfig.configTabId,
      parameter: systemConfig.parameter, uploadType: systemConfig.uploadType, required: systemConfig.required,
      width: systemConfig.width, high: systemConfig.high, value: systemConfig.value,
      info: systemConfig.info, desc: systemConfig.desc, sort: systemConfig.sort, status: systemConfig.status,
      rowVersion: sql<string>`xmin::text`,
    }).from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...keys])))
      .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
    if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024) {
      throw new ValidateException('公众号配置超过完整读取容量，请维护后重试');
    }
    return rows;
}
async function rowsFor(container: Container, keys: readonly string[]) {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    return rowsInTx(tx, keys);
  });
}

/** Caller owns isolation, deadlines and any writer barrier. Never opens a
 * nested transaction, so a QR publication can compare this same full stamp. */
export async function readOfficialAccountCredentialsInTx(tx: DbClient, env: Pick<RuntimeEnv, 'APP_KEY'>): Promise<OfficialAccountCredentials> {
  const rows = await rowsInTx(tx, ['wechat_appid', 'wechat_appsecret']);
  const value = (key: string) => normalizeConfigScalar(rows.find(row => row.menuName === key)?.value ?? '');
  const appId = value('wechat_appid'), secret = value('wechat_appsecret');
  // Keep imported consumer syntax: new authors validate wx IDs separately.
  if (!appId || !secret) throw new ValidateException('公众号 AppID 或 AppSecret 未配置');
  if (!env.APP_KEY) throw new ValidateException('公众号运行时签名未配置');
  const stamp = createHmac('sha256', env.APP_KEY).update('cinashop.official-runtime.credentials.v1\0')
    .update(JSON.stringify(rows)).digest('hex');
  return { appId, secret, stamp };
}

export async function readOfficialAccountCredentials(container: Container, env: Pick<RuntimeEnv, 'APP_KEY'>): Promise<OfficialAccountCredentials> {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    return readOfficialAccountCredentialsInTx(tx, env);
  });
}

export function officialCredentialCacheKey(credentials: OfficialAccountCredentials, purpose: 'access-token' | 'jsapi-ticket'): string {
  if (!/^[a-f0-9]{64}$/.test(credentials.stamp)) throw new ValidateException('公众号运行时身份无效');
  return `official-runtime:${purpose}:v1:${credentials.stamp}`;
}

export async function readOfficialAccountCallbackConfig(container: Container, env: RuntimeEnv): Promise<OfficialAccountCallbackConfig> {
  // Presence is not validity: whitespace/partial deployment bindings must not
  // silently enable database authority or select a weaker callback mode.
  const deployed = Boolean(env.WECHAT_OFFICIAL_CALLBACK_TOKEN || env.WECHAT_OFFICIAL_CALLBACK_AES_KEY);
  const keys = deployed ? ['wechat_appid']
    : ['wechat_appid', 'wechat_token', 'wechat_encodingaeskey', 'wechat_encode', WECHAT_BASE_CALLBACK_AUTHORITY_KEY];
  const rows = await rowsFor(container, keys);
  const raw = (key: string) => rows.find(row => row.menuName === key)?.value;
  const appId = normalizeConfigScalar(raw('wechat_appid'));
  if (!appId || appId.length > 64) throw new Error('wechat_callback_app_id_invalid');
  if (deployed) {
    const token = env.WECHAT_OFFICIAL_CALLBACK_TOKEN ?? '', aesKey = env.WECHAT_OFFICIAL_CALLBACK_AES_KEY ?? '';
    if (!token.trim()) throw new Error('wechat_callback_token_invalid');
    validateWechatCallbackSecret(token, aesKey);
    return { appId, token, aesKey, mode: 2, authority: 'deployment' };
  }
  if (raw(WECHAT_BASE_CALLBACK_AUTHORITY_KEY) !== 'database') throw new Error('wechat_callback_database_authority_disabled');
  const modeValue = normalizeConfigScalar(raw('wechat_encode'));
  if (!['0', '1', '2'].includes(modeValue)) throw new Error('wechat_callback_mode_invalid');
  const mode = Number(modeValue) as WechatBaseMode;
  const token = normalizeConfigScalar(raw('wechat_token')), aesKey = normalizeConfigScalar(raw('wechat_encodingaeskey'));
  if (!/^[A-Za-z0-9]{3,32}$/.test(token)) throw new Error('wechat_callback_token_invalid');
  if (mode !== 0) validateWechatCallbackSecret(token, aesKey);
  return { appId, token, aesKey, mode, authority: 'database' };
}
