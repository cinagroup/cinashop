import { createHmac } from 'node:crypto';
import type { Env } from '@/env';
import { ServiceUnavailableException, HttpApiException } from '@/utils/errors';
import { assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { WECHAT_ROUTINE_KEYS, parseWechatRoutineSave, wechatRoutineStoredValue,
  wechatRoutineStoredRadioValue, wechatRoutineRequestId, wechatRoutineRevision,
  type WechatRoutineKey, type WechatRoutineReceipt } from '../../../../view/common/wechatRoutine';

type Signing = Pick<Env, 'APP_KEY'>;
export type WechatRoutineSqlIntent = { action: 'keep' } | { action: 'clear' } | { action: 'replace'; raw: string };
export type WechatRoutineSqlFields = Record<WechatRoutineKey, WechatRoutineSqlIntent>;

function hmac(env: Signing, domain: string, value: unknown): string {
  if (!env.APP_KEY) throw new ServiceUnavailableException('小程序配置签名未就绪');
  return createHmac('sha256', env.APP_KEY)
    .update(`cinashop.wechat-routine.author.${domain}.v1\0${JSON.stringify(value)}`).digest('hex');
}

/** This is an opaque revision namespace, not SQL authentication. A recovered
 * receipt retains its ORIGINAL binding even after the same UID gets a new JWT.
 * The HTTP service must independently revalidate that current actor's account,
 * password, permissions and expiry before reading or invoking the SQL port.
 */
export function wechatRoutineActorBinding(env: Signing, actor: AdminAuthorityActor): string {
  assertAdminAuthoritySession(actor);
  return hmac(env, 'actor', [actor.id, actor.authVersion, actor.expiresAt]);
}

/** The SQL fingerprint is private. Only its keyed, actor-bound revision leaves
 * the server; it is never substituted for routine credential/account evidence.
 */
export function wechatRoutineSourceRevision(env: Signing, actorBinding: string, source: string): string {
  if (!wechatRoutineRevision(actorBinding) || !wechatRoutineRevision(source)) {
    throw new ServiceUnavailableException('小程序配置完整来源无效');
  }
  return hmac(env, 'revision', [actorBinding, source]);
}

/** Raw JSON strings keep escaped NUL/surrogates OUTSIDE jsonb's text decoder.
 * Pass this object with the DB driver's json helper, not JSON.stringify twice.
 * No caller-supplied metadata, target ID or claimed post-revision enters SQL.
 */
export function wechatRoutineSqlFields(value: unknown): WechatRoutineSqlFields {
  const input = parseWechatRoutineSave(value);
  return Object.fromEntries(WECHAT_ROUTINE_KEYS.map(key => {
    const intent = input.fields[key];
    if (intent.action === 'keep' || intent.action === 'clear') return [key, { action: intent.action }];
    const raw = key === 'routine_contact_type' || key === 'store_user_avatar'
      ? wechatRoutineStoredRadioValue(intent.value) : wechatRoutineStoredValue(intent.value);
    return [key, { action: 'replace', raw }];
  })) as WechatRoutineSqlFields;
}

export interface WechatRoutinePrivateReceipt {
  operation_id: string; actor_id: number; operation: 'save' | 'resolve'; format_version: 1;
  payload_hash: string; revision: string; state: 'committed' | 'not_applied'; created_at: number;
  result: { format: 1; actor_binding: string; before_source: string; after_source: string; changed_keys: WechatRoutineKey[] };
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function invalid(): never { throw new ServiceUnavailableException('小程序配置回执格式或实际来源不完整'); }

/** Decode only immutable DB evidence after the full catalog/ACL inspection.
 * No caller-provided JSON is trusted as a receipt. This decoder alone cannot
 * prove installation, the SQL caller's human identity, or an HTTP signature.
 */
export function parseWechatRoutinePrivateReceipt(value: unknown): WechatRoutinePrivateReceipt {
  if (!record(value)) return invalid();
  const { replayed, ...row } = value;
  if (replayed !== undefined && typeof replayed !== 'boolean'
    || !exact(row, ['operation_id', 'actor_id', 'operation', 'format_version', 'payload_hash', 'revision', 'state', 'result', 'created_at'])
    || !wechatRoutineRequestId(row.operation_id) || !Number.isSafeInteger(row.actor_id) || Number(row.actor_id) <= 0
    || Number(row.actor_id) > 2147483647 || row.format_version !== 1
    || !wechatRoutineRevision(row.payload_hash) || !wechatRoutineRevision(row.revision)
    || !(row.operation === 'save' && row.state === 'committed' || row.operation === 'resolve' && row.state === 'not_applied')) return invalid();
  const created = typeof row.created_at === 'string' && /^[1-9][0-9]*$/.test(row.created_at) ? Number(row.created_at) : row.created_at;
  if (!Number.isSafeInteger(created) || Number(created) <= 0) return invalid();
  const result = row.result;
  if (!record(result) || !exact(result, ['format', 'actor_binding', 'before_source', 'after_source', 'changed_keys'])
    || result.format !== 1 || !wechatRoutineRevision(result.actor_binding) || !wechatRoutineRevision(result.before_source)
    || !wechatRoutineRevision(result.after_source) || !Array.isArray(result.changed_keys)
    || JSON.stringify(result.changed_keys) !== JSON.stringify(WECHAT_ROUTINE_KEYS.filter(key => (result.changed_keys as unknown[]).includes(key)))
    || result.changed_keys.length === 0 && result.before_source !== result.after_source
    || row.state === 'not_applied' && result.changed_keys.length !== 0) return invalid();
  return { ...row, created_at: created } as WechatRoutinePrivateReceipt;
}

/** Whitelist the public result and derive its historical post-revision from
 * SQL's ACTUAL after-source and the original binding. Neither the private
 * source fingerprints, actor binding, payload hash nor settings are returned.
 */
export function wechatRoutineReceiptDto(value: unknown, actorId: number, env: Signing, replayed: boolean,
  cacheStatus: WechatRoutineReceipt['cache_status'] = 'not_required'): WechatRoutineReceipt {
  const row = parseWechatRoutinePrivateReceipt(value);
  if (row.actor_id !== actorId) throw new HttpApiException('小程序配置请求不属于当前账号', 409, 409);
  return { request_id: row.operation_id, actor_id: row.actor_id, state: row.state,
    revision: wechatRoutineSourceRevision(env, row.result.actor_binding, row.result.after_source),
    created_at: row.created_at, replayed, cache_status: cacheStatus };
}
