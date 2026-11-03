/** Durable record verification only; no current provider, local row, policy or runtime authority. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { parseRoutineProviderObservation, routineEvidenceHmac, type RoutineProviderObservation } from './RoutineProviderObservation';

type Signing = Pick<Env, 'APP_KEY'>;
export type RoutineOriginalDomain = 'store_order' | 'recharge' | 'membership';
export type RoutineOriginalLocal = { domain: RoutineOriginalDomain; orderId: number; buyerUid: number; orderNo: string;
  amountCents: number; paid: number; payType: string; tradeNo: string };
export type RoutineOriginalBinding = { state: 'bound'; local: RoutineOriginalLocal } | { state: 'unresolved'; reason: 'order_missing' | 'order_ambiguous' | 'unsupported_order_type' | 'local_order_invalid' };
export type RoutineOriginalPayload = { format: 1; binding: RoutineOriginalBinding; sourceDigest: string; observation: RoutineProviderObservation };
export type RoutineOriginalEvidence = { evidence_id: string; order_no: string; transaction_id: string;
  source: RoutineProviderObservation['source']; source_id: string; format_version: 1;
  payload: RoutineOriginalPayload; created_at: number; signature: string };
const fail = (suffix: string): never => { throw Error('routine_original_' + suffix); };
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    || Reflect.ownKeys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))
    || Object.entries(Object.getOwnPropertyDescriptors(v)).some(([key, d]) => !keys.includes(key) || !d.enumerable || !('value' in d))) return fail('record_invalid');
  return v as Record<string, unknown>;
}
const evidenceKey = (env: Signing, source: string, sourceId: string) => routineEvidenceHmac(env, 'evidence-key', [source, sourceId]);
export function parseRoutineOriginalBinding(v: unknown): RoutineOriginalBinding {
  const state = v && typeof v === 'object' ? Object.getOwnPropertyDescriptor(v, 'state') : undefined;
  if (state && 'value' in state && state.value === 'unresolved') {
    const r = object(v, ['state','reason']);
    if (r.reason !== 'order_missing' && r.reason !== 'order_ambiguous' && r.reason !== 'unsupported_order_type'
      && r.reason !== 'local_order_invalid') return fail('binding_invalid');
    return { state: 'unresolved', reason: r.reason };
  }
  const b = object(v, ['state','local']), l = object(b.local, ['domain','orderId','buyerUid','orderNo','amountCents','paid','payType','tradeNo']);
  if (b.state !== 'bound' || (l.domain !== 'store_order' && l.domain !== 'recharge' && l.domain !== 'membership') || !id(l.orderId) || !id(l.buyerUid)
    || typeof l.orderNo !== 'string' || !/^[A-Za-z0-9_-]{2,64}$/u.test(l.orderNo)
    || !id(l.amountCents) || (l.paid !== 0 && l.paid !== 1)
    || typeof l.payType !== 'string' || l.payType.length > 32 || typeof l.tradeNo !== 'string' || l.tradeNo.length > 100) return fail('binding_invalid');
  return { state: 'bound', local: { domain: l.domain, orderId: l.orderId, buyerUid: l.buyerUid,
    orderNo: l.orderNo, amountCents: l.amountCents, paid: l.paid, payType: l.payType, tradeNo: l.tradeNo } };
}
export function parseRoutineOriginalEvidence(env: Signing, value: unknown): RoutineOriginalEvidence {
  const r = object(value, ['evidence_id','order_no','transaction_id','source','source_id','format_version','payload','created_at','signature']);
  const p = object(r.payload, ['format','binding','sourceDigest','observation']);
  const o = parseRoutineProviderObservation(env, p.observation), binding = parseRoutineOriginalBinding(p.binding);
  const created = typeof r.created_at === 'string' && /^[1-9][0-9]*$/u.test(r.created_at) ? Number(r.created_at) : r.created_at;
  if (!hex(r.evidence_id) || r.evidence_id !== evidenceKey(env, o.source, o.sourceId)
    || r.order_no !== o.facts.orderNo || r.transaction_id !== o.facts.transactionId || r.source !== o.source || r.source_id !== o.sourceId
    || r.format_version !== 1 || p.format !== 1 || !hex(p.sourceDigest) || !Number.isSafeInteger(created) || Number(created) <= 0
    || binding.state === 'bound' && binding.local.orderNo !== r.order_no) return fail('record_invalid');
  const { signature, ...raw } = r;
  const facts = { ...raw, created_at: created };
  if (!hex(signature) || !timingSafeEqual(Buffer.from(signature, 'hex'),
    Buffer.from(routineEvidenceHmac(env, 'evidence-record', facts), 'hex'))) return fail('signature_invalid');
  return { ...facts, payload: { format: 1, binding, sourceDigest: p.sourceDigest, observation: o }, signature } as RoutineOriginalEvidence;
}
