import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { ServiceUnavailableException } from '../../utils/errors';
import { verifyRoutineIdentityObservation, type RoutineIdentityObservation } from './RoutineIdentityObservation';

type Signing = Pick<Env, 'APP_KEY'>;
export type RoutineIdentityOwnershipRow = {
  ownership_id: string; app_id: string; openid: string; uid: number; binding_id: number; observation_id: string;
  format_version: number; observed_at: number | string; created_at: number | string; signature: string;
};
export type RoutineIdentityWitnessRow = {
  observation_id: string; uid: number; binding_id: number; format_version: number;
  observation: unknown; created_at: number | string; signature: string;
};
export interface RoutineIdentityOwner {
  readonly ownershipId: string; readonly appId: string; readonly openid: string; readonly uid: number; readonly bindingId: number;
  readonly observationId: string; readonly observedAt: number; readonly createdAt: number;
}
export interface RoutineIdentityWitness {
  readonly observationId: string; readonly uid: number; readonly bindingId: number;
  readonly observation: Readonly<RoutineIdentityObservation>; readonly createdAt: number;
}

const ownershipUnavailable = () => new ServiceUnavailableException('小程序账号归属记录未完整就绪，请维护后重试');
const witnessUnavailable = () => new ServiceUnavailableException('小程序身份观察记录无效，请重新授权或维护');
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const token = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0
  && value.length <= max && /^[A-Za-z0-9_-]+$/u.test(value);
const timestamp = (value: unknown): value is number | string => typeof value === 'number' || typeof value === 'string';
const ownershipFields = ['ownership_id', 'app_id', 'openid', 'uid', 'binding_id', 'observation_id',
  'format_version', 'observed_at', 'created_at', 'signature'] as const;
const witnessFields = ['observation_id', 'uid', 'binding_id', 'format_version', 'observation', 'created_at', 'signature'] as const;

/** SQL projections contain only own data fields. Unknown maintenance inputs
 * must not execute getters or timestamp coercions while authenticating them. */
function record(value: unknown, fields: readonly string[], unavailable: () => Error): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw unavailable();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) throw unavailable();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of fields) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) throw unavailable();
      result[key] = field.value;
    }
    return result;
  } catch {
    throw unavailable();
  }
}

function ownershipMac(env: Signing, domain: string, value: unknown): string {
  if (typeof env.APP_KEY !== 'string' || !env.APP_KEY) throw ownershipUnavailable();
  return createHmac('sha256', env.APP_KEY).update('cinashop.routine-identity-ownership.' + domain + '.v1\0')
    .update(JSON.stringify(value)).digest('hex');
}
function ownershipId(env: Signing, row: RoutineIdentityOwnershipRow): string {
  return ownershipMac(env, 'identity', [row.app_id, row.openid, row.uid, row.binding_id]);
}
function ownershipSignature(env: Signing, row: RoutineIdentityOwnershipRow): string {
  return ownershipMac(env, 'record', [row.ownership_id, row.app_id, row.openid, row.uid, row.binding_id, row.observation_id,
    row.format_version, Number(row.observed_at), Number(row.created_at)]);
}
function witnessSignature(env: Signing, row: RoutineIdentityWitnessRow, observation: RoutineIdentityObservation): string {
  if (typeof env.APP_KEY !== 'string' || !env.APP_KEY) throw witnessUnavailable();
  const o = observation;
  return createHmac('sha256', env.APP_KEY).update('cinashop.routine-identity-witness.record.v1\0')
    .update(JSON.stringify([row.observation_id, row.uid, row.binding_id, row.format_version,
      [o.version, o.purpose, o.observationId, o.appId, o.openid, o.unionid, o.sourceStamp, o.observedAt, o.signature], Number(row.created_at)])).digest('hex');
}

/** Authenticates a durable prospective mapping only. It does not establish
 * live user/binding state, the stored witness anchor, login or switch authority. */
export function parseRoutineIdentityOwnership(env: Signing, raw: unknown): RoutineIdentityOwner {
  const row = record(raw, ownershipFields, ownershipUnavailable) as unknown as RoutineIdentityOwnershipRow;
  if (!timestamp(row.observed_at) || !timestamp(row.created_at)
    || typeof row.ownership_id !== 'string' || typeof row.observation_id !== 'string') throw ownershipUnavailable();
  const observedAt = Number(row.observed_at), createdAt = Number(row.created_at);
  if (!positive(row.uid) || !positive(row.binding_id) || !token(row.app_id, 32) || !token(row.openid, 100)
    || row.format_version !== 1 || !/^[a-f0-9]{64}$/u.test(row.ownership_id) || row.ownership_id !== ownershipId(env, row)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row.observation_id)
    || !Number.isSafeInteger(observedAt) || observedAt <= 0 || !Number.isSafeInteger(createdAt)
    || createdAt < observedAt - 60 || createdAt > observedAt + 900 || createdAt > Math.floor(Date.now() / 1000) + 60
    || typeof row.signature !== 'string' || !/^[a-f0-9]{64}$/u.test(row.signature)
    || !timingSafeEqual(Buffer.from(row.signature, 'hex'), Buffer.from(ownershipSignature(env, row), 'hex'))) throw ownershipUnavailable();
  return Object.freeze({ ownershipId: row.ownership_id, appId: row.app_id, openid: row.openid, uid: row.uid, bindingId: row.binding_id,
    observationId: row.observation_id, observedAt, createdAt });
}

/** The captured observation may be older than 900 seconds. This authenticates
 * durable bytes, not a fresh exchange, current account or live binding. */
export function parseRoutineIdentityWitness(env: Signing, raw: unknown): RoutineIdentityWitness {
  const captured = record(raw, witnessFields, witnessUnavailable) as unknown as RoutineIdentityWitnessRow;
  const observation = verifyRoutineIdentityObservation(env, captured.observation, undefined, { allowExpired: true });
  if (!timestamp(captured.created_at)) throw witnessUnavailable();
  const row = { ...captured, created_at: Number(captured.created_at), observation };
  if (!positive(row.uid) || !positive(row.binding_id) || row.format_version !== 1
    || row.observation_id !== observation.observationId || !Number.isSafeInteger(row.created_at)
    || row.created_at < observation.observedAt - 60 || row.created_at > Math.floor(Date.now() / 1000) + 60
    || typeof row.signature !== 'string' || !/^[a-f0-9]{64}$/u.test(row.signature)
    || !timingSafeEqual(Buffer.from(row.signature, 'hex'), Buffer.from(witnessSignature(env, row, observation), 'hex'))) throw witnessUnavailable();
  return Object.freeze({ observationId: row.observation_id, uid: row.uid, bindingId: row.binding_id, observation, createdAt: row.created_at });
}
