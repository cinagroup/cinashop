import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac } from './RoutineProviderObservation';

export interface RechargeRefundScope {
  readonly database: string;
  readonly databaseOid: string;
  readonly maintenance: string;
  readonly maintenanceOid: string;
  readonly app: string;
  readonly appOid: string;
  readonly admin: string;
  readonly adminOid: string;
  readonly financial: string;
  readonly financialOid: string;
  readonly manager: string;
  readonly managerOid: string;
}
export type RechargeRefundJournalKind = 'operation' | 'attempt' | 'provider-result' | 'local-result' | 'quote';
export type RechargeRefundJson = null | boolean | number | string | readonly RechargeRefundJson[] | { readonly [key: string]: RechargeRefundJson };
export interface RechargeRefundEnvelope {
  readonly format: 1;
  readonly kind: RechargeRefundJournalKind;
  readonly scope: Readonly<RechargeRefundScope>;
  readonly data: RechargeRefundJson;
  readonly createdAt: number;
  readonly signature: string;
}
type Signing = Pick<Env, 'APP_KEY'>;
const fail = (): never => { throw new ServiceUnavailableException('充值退款持久证据或数据库归属无效'); };
const scopeKeys = ['database','databaseOid','maintenance','maintenanceOid','app','appOid','admin','adminOid',
  'financial','financialOid','manager','managerOid'];
const kinds: readonly RechargeRefundJournalKind[] = ['operation','attempt','provider-result','local-result','quote'];

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) return fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

export function captureRechargeRefundScope(value: unknown): Readonly<RechargeRefundScope> {
  const data = object(value, scopeKeys);
  for (const key of scopeKeys) {
    const part = data[key];
    if (typeof part !== 'string' || !part || part.trim() !== part) return fail();
    if (key.endsWith('Oid')) {
      if (!/^[1-9]\d{0,9}$/.test(part) || Number(part) > 4_294_967_295) return fail();
    } else if (!/^[A-Za-z0-9_-]{1,128}$/.test(part)) return fail();
  }
  const roles = ['maintenance','app','admin','financial','manager'];
  if (new Set(roles.map(key => data[key])).size !== roles.length
    || new Set(roles.map(key => data[key + 'Oid'])).size !== roles.length) return fail();
  return Object.freeze(data) as unknown as Readonly<RechargeRefundScope>;
}

/** Finite, copied JSON only. No getter, Date, sparse array, cycle, undefined,
 * nonfinite/unsafe number or prototype can enter a signed durable record. */
export function captureRechargeRefundJson(input: unknown): RechargeRefundJson {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): RechargeRefundJson {
    if (++nodes > 2_048 || depth > 16) return fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > 16_384) return fail();
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) return fail();
      return value;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return fail();
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 512
          || Reflect.ownKeys(value).length !== value.length + 1) return fail();
        const descriptors = Object.getOwnPropertyDescriptors(value);
        return Object.freeze(Array.from({ length: value.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
          return visit(descriptor.value, depth + 1);
        }));
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
      const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
      if (keys.length > 128 || keys.some(key => typeof key !== 'string')) return fail();
      const copied: Record<string, RechargeRefundJson> = Object.create(null);
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !('value' in descriptor)) return fail();
        copied[key] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(copied);
    } finally { seen.delete(value); }
  }
  const captured = visit(input, 0);
  if (Buffer.byteLength(routineEvidenceCanonical(captured), 'utf8') > 16_384) return fail();
  return captured;
}

function unsigned(kind: RechargeRefundJournalKind, scope: unknown, data: unknown, createdAt: number) {
  if (!kinds.includes(kind) || !Number.isSafeInteger(createdAt) || createdAt <= 0) return fail();
  return { format: 1 as const, kind, scope: captureRechargeRefundScope(scope), data: captureRechargeRefundJson(data), createdAt };
}

/** Called only after the relevant SQL author, or the actual signature-verifying
 * transport, has established authority. A MAC never supplies missing provider
 * verification, administrator permission, funds reservation or row binding. */
export function signRechargeRefundJournal(env: Signing, kind: RechargeRefundJournalKind,
  scope: RechargeRefundScope, data: unknown, createdAt: number): Readonly<RechargeRefundEnvelope> {
  const body = unsigned(kind, scope, data, createdAt);
  return Object.freeze({ ...body, signature: routineEvidenceHmac(env, `recharge-refund-${kind}-journal-v1`, body) });
}

/** Verify a stored envelope against this transaction's actual catalog scope
 * and the exact expected record kind. Historical signatures do not expire with
 * an account approval or merchant credential; fresh sending is authorized again. */
export function parseRechargeRefundJournal(env: Signing, kind: RechargeRefundJournalKind,
  expectedScope: RechargeRefundScope, value: unknown): Readonly<RechargeRefundEnvelope> {
  const row = object(value, ['format','kind','scope','data','createdAt','signature']);
  if (row.format !== 1 || row.kind !== kind || typeof row.createdAt !== 'number'
    || typeof row.signature !== 'string' || row.signature.length !== 64 || !/^[a-f0-9]{64}$/.test(row.signature)) return fail();
  const body = unsigned(kind, row.scope, row.data, row.createdAt);
  if (routineEvidenceCanonical(body.scope) !== routineEvidenceCanonical(captureRechargeRefundScope(expectedScope))) return fail();
  const expected = routineEvidenceHmac(env, `recharge-refund-${kind}-journal-v1`, body);
  if (!timingSafeEqual(Buffer.from(row.signature, 'hex'), Buffer.from(expected, 'hex'))) return fail();
  return Object.freeze({ ...body, signature: row.signature });
}
