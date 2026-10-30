import { Buffer } from 'node:buffer';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Env } from '@/env';
import { ValidateException } from '@/utils/errors';

export interface RoutineIdentityObservation {
  version: 1;
  purpose: 'routine_code2session';
  observationId: string;
  appId: string;
  openid: string;
  unionid: string;
  sourceStamp: string;
  observedAt: number;
  signature: string;
}

type SigningEnv = Pick<Env, 'APP_KEY'>;
type IssueInput = { appId: string; openid: string; unionid?: string; sourceStamp: string };
type ExpectedIdentity = { openid: string; unionid?: string; sourceStamp: string };
const DOMAIN = 'cinashop.routine.identity-observation.v1\0';
const FIELDS = ['version', 'purpose', 'observationId', 'appId', 'openid', 'unionid', 'sourceStamp', 'observedAt', 'signature'] as const;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const invalid = () => new ValidateException('小程序身份观察无效或已过期，请重新授权');
const identifier = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max && !/[^A-Za-z0-9_-]/u.test(value);
const hex = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/u.test(value);

/** Read only own enumerable data fields; never execute a supplied accessor. */
function exactData(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))
      || required.some(key => !keys.includes(key))) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) return null;
      result[key] = field.value;
    }
    return result;
  } catch { return null; }
}

function copyShape(value: unknown): RoutineIdentityObservation | null {
  const row = exactData(value, FIELDS);
  if (!row || row.version !== 1 || row.purpose !== 'routine_code2session'
    || typeof row.observationId !== 'string' || row.observationId.length !== 36 || !UUID_V4.test(row.observationId)
    || !identifier(row.appId, 1, 32) || !identifier(row.openid, 1, 100) || !identifier(row.unionid, 0, 30)
    || !hex(row.sourceStamp) || !Number.isSafeInteger(row.observedAt) || Number(row.observedAt) <= 0 || !hex(row.signature)) return null;
  return { version: 1, purpose: 'routine_code2session', observationId: row.observationId,
    appId: row.appId, openid: row.openid, unionid: row.unionid, sourceStamp: row.sourceStamp,
    observedAt: row.observedAt as number, signature: row.signature };
}

/** Structural early rejection only. This does not authenticate a provider observation. */
export function hasRoutineIdentityObservationShape(value: unknown): boolean {
  return copyShape(value) !== null;
}

function key(env: SigningEnv): string {
  try { const value = env?.APP_KEY; if (typeof value === 'string' && value.length > 0) return value; }
  catch { /* Expose only the same reauthorization error as an invalid proof. */ }
  throw invalid();
}

function now(): number {
  const seconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw invalid();
  return seconds;
}

function signature(secret: string, value: Omit<RoutineIdentityObservation, 'signature'>): string {
  // Fixed order is independent of the object's insertion order. This domain
  // cannot be substituted for a credential stamp, ticket or payment witness.
  const canonical = JSON.stringify({ version: value.version, purpose: value.purpose,
    observationId: value.observationId, appId: value.appId, openid: value.openid,
    unionid: value.unionid, sourceStamp: value.sourceStamp, observedAt: value.observedAt });
  return createHmac('sha256', secret).update(DOMAIN).update(canonical).digest('hex');
}

/** Called only with the server-captured code2Session request/response identity.
 * No code, OAuth Secret or session key is accepted or included in the proof. */
export function issueRoutineIdentityObservation(env: SigningEnv, input: IssueInput): Readonly<RoutineIdentityObservation> {
  const secret = key(env);
  const row = exactData(input, ['appId', 'openid', 'unionid', 'sourceStamp'], ['appId', 'openid', 'sourceStamp']);
  const unionid = row?.unionid === undefined ? '' : row.unionid;
  if (!row || !identifier(row.appId, 1, 32) || !identifier(row.openid, 1, 100)
    || !identifier(unionid, 0, 30) || !hex(row.sourceStamp)) throw invalid();
  const value = { version: 1 as const, purpose: 'routine_code2session' as const, observationId: randomUUID(),
    appId: row.appId, openid: row.openid, unionid, sourceStamp: row.sourceStamp, observedAt: now() };
  return Object.freeze({ ...value, signature: signature(secret, value) });
}

/** A missing expected unionid means empty, not a wildcard. allowExpired is only
 * for durable public-witness reads, never login ticket/pending admission. */
export function verifyRoutineIdentityObservation(env: SigningEnv, value: unknown,
  expected?: ExpectedIdentity, options?: { allowExpired?: boolean }): Readonly<RoutineIdentityObservation> {
  const secret = key(env), copy = copyShape(value);
  if (!copy) throw invalid();
  const settings: Record<string, unknown> | null = options === undefined ? {} : exactData(options, ['allowExpired'], []);
  if (!settings || settings.allowExpired !== undefined && typeof settings.allowExpired !== 'boolean') throw invalid();
  const seconds = now();
  if (copy.observedAt > seconds + 60 || settings.allowExpired !== true && seconds - copy.observedAt > 900) throw invalid();
  if (expected !== undefined) {
    const row = exactData(expected, ['openid', 'unionid', 'sourceStamp'], ['openid', 'sourceStamp']);
    const unionid = row?.unionid === undefined ? '' : row.unionid;
    if (!row || !identifier(row.openid, 1, 100) || !identifier(unionid, 0, 30) || !hex(row.sourceStamp)
      || copy.openid !== row.openid || copy.unionid !== unionid || copy.sourceStamp !== row.sourceStamp) throw invalid();
  }
  if (!timingSafeEqual(Buffer.from(copy.signature, 'hex'), Buffer.from(signature(secret, copy), 'hex'))) throw invalid();
  return Object.freeze(copy);
}
