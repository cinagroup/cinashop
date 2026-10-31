import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '@/env';

type Signing = Pick<Env, 'APP_KEY'>;
export interface RoutineProviderFacts {
  appId: string; merchantId: string; orderNo: string; transactionId: string;
  amountCents: number; currency: 'CNY'; tradeState: 'SUCCESS'; tradeType: 'JSAPI';
  payerId: string; providerEventTime: number;
}
export interface RoutineProviderObservation {
  format: 1; purpose: 'routine_provider_original'; source: 'callback' | 'signed_query'; sourceId: string;
  facts: RoutineProviderFacts; verifiedAt: number; verifierKey: string; responseDigest: string; signature: string;
}
const slot = Symbol('routine.verified-provider-observation.v1');
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const token = (v: unknown, max: number): v is string => typeof v === 'string'
  && new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`, 'u').test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const invalid = (): never => { throw Error('routine_provider_observation_invalid'); };
export const routineEvidenceCanonical = (v: unknown): string => JSON.stringify(v, (_key, row) =>
  row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
export function routineEvidenceHmac(env: Signing, domain: string, value: unknown): string {
  if (!env.APP_KEY) throw Error('routine_original_signing_unavailable');
  return createHmac('sha256', env.APP_KEY).update(`cinashop.routine.original-payment.${domain}.v1\0`)
    .update(routineEvidenceCanonical(value)).digest('hex');
}
function equal(a: unknown, b: string): boolean {
  return hex(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))
    || Object.entries(descriptors).some(([key, d]) => !keys.includes(key) || !d.enumerable || !('value' in d))) return invalid();
  return v as Record<string, unknown>;
}
function facts(v: unknown): RoutineProviderFacts {
  const r = object(v, ['appId','merchantId','orderNo','transactionId','amountCents','currency','tradeState','tradeType','payerId','providerEventTime']);
  if (!token(r.appId, 32) || typeof r.merchantId !== 'string' || !/^[0-9]{1,32}$/u.test(r.merchantId)
    || !token(r.orderNo, 64) || r.orderNo.length < 2 || !token(r.transactionId, 100)
    || !token(r.payerId, 128) || !positive(r.amountCents) || r.amountCents > 2147483647
    || r.currency !== 'CNY' || r.tradeState !== 'SUCCESS' || r.tradeType !== 'JSAPI' || !positive(r.providerEventTime)) return invalid();
  return { appId: r.appId, merchantId: r.merchantId, orderNo: r.orderNo, transactionId: r.transactionId,
    amountCents: r.amountCents, currency: 'CNY', tradeState: 'SUCCESS', tradeType: 'JSAPI',
    payerId: r.payerId, providerEventTime: r.providerEventTime };
}

/** Called only after the production adapter's actual RSA verification (and
 * AES-GCM for callbacks). This server authenticator preserves that capture;
 * a source label, current config, login witness or PREPAY is not this proof. */
export function captureRoutineProviderObservation(env: Signing, input: {
  source: 'callback' | 'signed_query'; providerEventId?: string; facts: RoutineProviderFacts;
  verifiedBody: string; verifierKey: string;
}): RoutineProviderObservation {
  const observed = facts(input.facts);
  if (!['callback','signed_query'].includes(input.source) || typeof input.verifiedBody !== 'string'
    || !input.verifiedBody || new TextEncoder().encode(input.verifiedBody).byteLength > 1048576
    || typeof input.verifierKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.verifierKey)) return invalid();
  const sourceId = input.source === 'callback' ? input.providerEventId
    : routineEvidenceHmac(env, 'query-source', observed);
  if (typeof sourceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(sourceId)
    || input.source === 'signed_query' && input.providerEventId !== undefined) return invalid();
  const value = { format: 1 as const, purpose: 'routine_provider_original' as const, source: input.source, sourceId,
    facts: observed, verifiedAt: Math.floor(Date.now()/1000), verifierKey: input.verifierKey,
    responseDigest: createHash('sha256').update(input.verifiedBody).digest('hex') };
  return { ...value, signature: routineEvidenceHmac(env, 'provider-observation', value) };
}

/** Always copies before asynchronous I/O. Expiry is checked using the database
 * clock by append; durable immutable rows may be read after this TTL. */
export function parseRoutineProviderObservation(env: Signing, value: unknown): RoutineProviderObservation {
  const r = object(value, ['format','purpose','source','sourceId','facts','verifiedAt','verifierKey','responseDigest','signature']);
  const observed = facts(r.facts);
  if (r.format !== 1 || r.purpose !== 'routine_provider_original' || (r.source !== 'callback' && r.source !== 'signed_query')
    || typeof r.sourceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(r.sourceId)
    || !positive(r.verifiedAt) || typeof r.verifierKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(r.verifierKey)
    || !hex(r.responseDigest)) return invalid();
  const row: Omit<RoutineProviderObservation, 'signature'> = { format: 1, purpose: 'routine_provider_original',
    source: r.source, sourceId: r.sourceId, facts: observed,
    verifiedAt: r.verifiedAt, verifierKey: r.verifierKey, responseDigest: r.responseDigest };
  if (!equal(r.signature, routineEvidenceHmac(env, 'provider-observation', row))
    || row.source === 'signed_query' && row.sourceId !== routineEvidenceHmac(env, 'query-source', observed)) return invalid();
  return { ...row, signature: r.signature as string };
}

/** Request-local, non-enumerable capability. No module-level request map,
 * Queue/public JSON field or accidental object-spread propagation of payer. */
export function attachRoutineProviderObservation<T extends object>(target: T, value: RoutineProviderObservation): T {
  const captured = Object.freeze({ ...value, facts: Object.freeze({ ...value.facts }) });
  Object.defineProperty(target, slot, { value: captured, enumerable: false, writable: false, configurable: false });
  return target;
}
export function routineProviderObservationOf(value: object): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, slot);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
