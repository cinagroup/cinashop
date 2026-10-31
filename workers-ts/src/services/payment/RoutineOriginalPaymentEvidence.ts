import { timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { storeOrder, userRecharge, otherOrder } from '@/models/schema';
import { decimalToCents } from '@/services/order/OrderBrokerageService';
import { inspectRoutineOriginalPaymentEvidenceCatalog, assertRoutineOriginalPaymentEvidenceReady,
  ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_GATE } from '@/migrations/routineOriginalPaymentEvidence';
import { lockStoreOrderPaymentBoundary } from './StoreOrderPaymentBoundary';
import { assertRoutineApprovedUseTx } from './RoutineApprovedPaymentAccount';
import { parseRoutineProviderObservation, routineEvidenceCanonical, routineEvidenceHmac,
  type RoutineProviderObservation, type RoutineProviderFacts } from './RoutineProviderObservation';

type Signing = Pick<Env, 'APP_KEY'>;
type Domain = 'store_order' | 'recharge' | 'membership';
type Local = { domain: Domain; orderId: number; buyerUid: number; orderNo: string;
  amountCents: number; paid: number; payType: string; tradeNo: string };
type Binding = { state: 'bound'; local: Local } | { state: 'unresolved'; reason: 'order_missing' | 'order_ambiguous' | 'unsupported_order_type' | 'local_order_invalid' };
type Payload = { format: 1; binding: Binding; sourceDigest: string; observation: RoutineProviderObservation };
export type RoutineOriginalEvidence = { evidence_id: string; order_no: string; transaction_id: string;
  source: RoutineProviderObservation['source']; source_id: string; format_version: 1;
  payload: Payload; created_at: number; signature: string };
export type RoutineEvidenceExpected = { source: RoutineProviderObservation['source']; orderNo: string; transactionId: string;
  amountCents: number; currency: string; providerEventTime: number; providerEventId?: string; domain?: string };
const preparedSlot = Symbol('routine.original.prepared-caller-transaction.v1');
export type PreparedRoutineOriginal = { readonly [preparedSlot]: DbClient;
  readonly observation: RoutineProviderObservation; readonly binding: Binding; readonly sourceDigest: string };
const referenceSlot = Symbol('routine.original-evidence-reference.v1');
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
function expectedFacts(o: RoutineProviderObservation, e: RoutineEvidenceExpected): void {
  const f = o.facts;
  if (o.source !== e.source || f.orderNo !== e.orderNo || f.transactionId !== e.transactionId
    || f.amountCents !== e.amountCents || f.currency !== e.currency || f.providerEventTime !== e.providerEventTime
    || o.source === 'callback' && o.sourceId !== e.providerEventId) fail('provider_scope_mismatch');
}
function localConflict(binding: Binding, facts: RoutineProviderFacts): boolean {
  if (binding.state !== 'bound') return true;
  const l = binding.local;
  return l.orderNo !== facts.orderNo || l.amountCents !== facts.amountCents
    || !!l.tradeNo && l.tradeNo !== facts.transactionId || l.paid === 1 && l.payType !== 'weixin';
}
function parseBinding(v: unknown): Binding {
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
  const o = parseRoutineProviderObservation(env, p.observation), binding = parseBinding(p.binding);
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

/** The entire optional namespace must be absent for legacy operation. Partial
 * objects, wrong real SQL role or drift never degrade to legacy acceptance. */
export async function routineOriginalEvidenceInstalledTx(tx: DbClient): Promise<boolean> {
  if (Object.hasOwn(tx, '$client')) return fail('caller_transaction_required');
  // Set finite bounds without increasing a caller's already shorter limits.
  await tx.execute(sql`SELECT set_config('statement_timeout',
    (SELECT CASE WHEN setting::integer=0 THEN 5000 ELSE least(setting::integer,5000) END::text FROM pg_settings WHERE name='statement_timeout'),true),
    set_config('lock_timeout',(SELECT CASE WHEN setting::integer=0 THEN 2000 ELSE least(setting::integer,2000) END::text FROM pg_settings WHERE name='lock_timeout'),true),
    set_config('idle_in_transaction_session_timeout',(SELECT CASE WHEN setting::integer=0 THEN 5000 ELSE least(setting::integer,5000) END::text FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),true)`);
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(
    ${ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_GATE[0]},${ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_GATE[1]}) AS locked`);
  if (gate?.locked !== true) return fail('maintenance_busy');
  const catalog = await inspectRoutineOriginalPaymentEvidenceCatalog(tx);
  if (!catalog.present) return false;
  await assertRoutineOriginalPaymentEvidenceReady(tx);
  return true;
}

/** Called BEFORE the common order/provider/case boundary. The short NOWAIT
 * SHARE fences make the COMPLETE same-number candidate universe stable even
 * for absent rows; no provider I/O, RSA/AES verification or Queue work runs
 * while they are held. Local HMACs authenticate the immutable SQL records.
 * Unresolved or conflicting genuine observations remain immutable evidence,
 * never a usable original or an authorization to assign old UID ownership. */
export async function prepareRoutineOriginalPaymentTx(tx: DbClient, env: Signing, value: unknown,
  expected: RoutineEvidenceExpected): Promise<PreparedRoutineOriginal | null> {
  if (!await routineOriginalEvidenceInstalledTx(tx)) return null;
  const observation = parseRoutineProviderObservation(env, value);
  expectedFacts(observation, expected);
  const [clock] = await tx.execute<{ now: string }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`);
  const now = Number(clock?.now);
  if (!Number.isSafeInteger(now) || now < observation.verifiedAt-60 || now-observation.verifiedAt > 900) return fail('observation_expired');
  await tx.execute(sql`LOCK TABLE ONLY public.store_order, ONLY public.user_recharge, ONLY public.other_order IN SHARE MODE NOWAIT`);
  const store = await tx.select({ orderId: storeOrder.id, buyerUid: storeOrder.uid, orderNo: storeOrder.orderId,
    price: storeOrder.payPrice, paid: storeOrder.paid, payType: storeOrder.payType, tradeNo: storeOrder.tradeNo })
    .from(storeOrder).where(eq(storeOrder.orderId, expected.orderNo)).orderBy(storeOrder.id).limit(65).for('update', { noWait: true });
  const recharge = await tx.select({ orderId: userRecharge.id, buyerUid: userRecharge.uid, orderNo: userRecharge.orderId,
    price: userRecharge.price, paid: userRecharge.paid, payType: userRecharge.rechargeType, tradeNo: userRecharge.tradeNo })
    .from(userRecharge).where(eq(userRecharge.orderId, expected.orderNo)).orderBy(userRecharge.id).limit(65).for('update', { noWait: true });
  const membership = await tx.select({ orderId: otherOrder.id, buyerUid: otherOrder.uid, orderNo: otherOrder.orderId,
    price: otherOrder.payPrice, paid: otherOrder.paid, payType: otherOrder.payType, tradeNo: otherOrder.tradeNo, type: otherOrder.type })
    .from(otherOrder).where(eq(otherOrder.orderId, expected.orderNo)).orderBy(otherOrder.id).limit(65).for('update', { noWait: true });
  const rows = [...store.map(row => ({ ...row, domain: 'store_order' as const })),
    ...recharge.map(row => ({ ...row, domain: 'recharge' as const })), ...membership.map(row => ({ ...row, domain: 'membership' as const }))];
  if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1048576) return fail('local_capacity');
  let binding: Binding;
  if (rows.length !== 1) binding = { state: 'unresolved', reason: rows.length ? 'order_ambiguous' : 'order_missing' };
  else if (membership.length && ![0,1].includes(membership[0].type)) binding = { state: 'unresolved', reason: 'unsupported_order_type' };
  else {
    const r = rows[0];
    try {
      binding = parseBinding({ state: 'bound', local: { domain: r.domain, orderId: r.orderId, buyerUid: r.buyerUid,
        orderNo: r.orderNo, amountCents: decimalToCents(r.price), paid: r.paid, payType: r.payType, tradeNo: r.tradeNo } });
    } catch { binding = { state: 'unresolved', reason: 'local_order_invalid' }; }
    if (expected.domain && expected.domain !== r.domain) binding = { state: 'unresolved', reason: 'order_ambiguous' };
  }
  Object.freeze(observation.facts); Object.freeze(observation);
  if (binding.state === 'bound') Object.freeze(binding.local);
  return Object.freeze({ [preparedSlot]: tx, observation, binding: Object.freeze(binding),
    sourceDigest: routineEvidenceHmac(env, 'local-source', rows) });
}
async function related(tx: DbClient, env: Signing, orderNo: string, transactionId: string): Promise<RoutineOriginalEvidence[]> {
  const rows = await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence
    WHERE order_no=${orderNo} OR transaction_id=${transactionId} ORDER BY evidence_id LIMIT 65`);
  if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1048576) return fail('evidence_capacity');
  return Array.from(rows, row => parseRoutineOriginalEvidence(env, row));
}
function conflicts(rows: RoutineOriginalEvidence[], current: RoutineOriginalEvidence): boolean {
  if (localConflict(current.payload.binding, current.payload.observation.facts)) return true;
  return rows.some(row => routineEvidenceCanonical(row.payload.observation.facts) !== routineEvidenceCanonical(current.payload.observation.facts)
    || localConflict(row.payload.binding, row.payload.observation.facts)
    || row.payload.binding.state !== 'bound' || current.payload.binding.state !== 'bound'
    || row.payload.binding.local.domain !== current.payload.binding.local.domain
    || row.payload.binding.local.orderId !== current.payload.binding.local.orderId
    || row.payload.binding.local.buyerUid !== current.payload.binding.local.buyerUid);
}
export async function appendRoutineOriginalPaymentTx(tx: DbClient, env: Signing, prepared: PreparedRoutineOriginal) {
  const owner = Object.getOwnPropertyDescriptor(prepared, preparedSlot);
  if (!owner || !('value' in owner) || owner.value !== tx) return fail('prepared_transaction_mismatch');
  const { observation: o, binding, sourceDigest } = prepared;
  await lockStoreOrderPaymentBoundary(tx, o.facts.orderNo);
  // Same provider transaction lock as minimized ingress, not a new competing
  // namespace. All local table/row fences were taken before this boundary.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wechat:${o.facts.transactionId}`},0))`);
  const key = evidenceKey(env, o.source, o.sourceId), before = await related(tx, env, o.facts.orderNo, o.facts.transactionId);
  let row = before.find(row => row.evidence_id === key), replayed = !!row;
  if (row) {
    if (routineEvidenceCanonical(row.payload.observation.facts) !== routineEvidenceCanonical(o.facts)) return fail('source_immutable_conflict');
  } else {
    if (before.length >= 64) return fail('evidence_capacity');
    const [clock] = await tx.execute<{ now: string }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`);
    if (!Number.isSafeInteger(Number(clock?.now)) || Number(clock.now) < o.verifiedAt-60 || Number(clock.now)-o.verifiedAt > 900) return fail('observation_expired');
    const facts = { evidence_id: key, order_no: o.facts.orderNo, transaction_id: o.facts.transactionId, source: o.source,
      source_id: o.sourceId, format_version: 1 as const, payload: { format: 1 as const, binding, sourceDigest, observation: o }, created_at: Number(clock?.now) };
    const signature = routineEvidenceHmac(env, 'evidence-record', facts);
    await tx.execute(sql`INSERT INTO public.routine_original_payment_evidence
      (evidence_id,order_no,transaction_id,source,source_id,format_version,payload,created_at,signature)
      VALUES(${key},${facts.order_no},${facts.transaction_id},${facts.source},${facts.source_id},1,
        ${JSON.stringify(facts.payload)}::text::jsonb,${facts.created_at},${signature})`);
    const [saved] = await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence WHERE evidence_id=${key}`);
    row = parseRoutineOriginalEvidence(env, saved);
    if (routineEvidenceCanonical(row) !== routineEvidenceCanonical({ ...facts, signature })) return fail('append_readback');
  }
  return { row, replayed, conflict: conflicts(before, row) };
}

export function attachRoutineOriginalReference<T extends object>(target: T, evidenceId: string): T {
  if (!hex(evidenceId)) return fail('reference_invalid');
  Object.defineProperty(target, referenceSlot, { value: evidenceId, enumerable: false, writable: false, configurable: false });
  return target;
}
export async function assertRoutineOriginalReferenceTx(tx: DbClient, env: Signing, target: object | string,
  expected: RoutineEvidenceExpected, domain: string): Promise<void> {
  if (!await routineOriginalEvidenceInstalledTx(tx)) return;
  const descriptor = typeof target === 'string' ? null : Object.getOwnPropertyDescriptor(target, referenceSlot);
  const key = typeof target === 'string' ? evidenceKey(env, 'callback', target) : descriptor && 'value' in descriptor ? descriptor.value : null;
  if (!hex(key)) return fail('reference_required');
  const [raw] = await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence WHERE evidence_id=${key}`);
  const row = parseRoutineOriginalEvidence(env, raw);
  await assertRoutineApprovedUseTx(tx, env, row);
  expectedFacts(row.payload.observation, expected);
  const b = row.payload.binding;
  if (b.state !== 'bound' || domain && b.local.domain !== domain || conflicts(await related(tx, env, expected.orderNo, expected.transactionId), row)) return fail('evidence_conflict');
  // Business caller already owns this order row. Re-read exact physical identity
  // without taking any backwards order lock after the payment boundary.
  const table = b.local.domain === 'store_order' ? storeOrder : b.local.domain === 'recharge' ? userRecharge : otherOrder;
  const [local] = await tx.select({ id: table.id, uid: table.uid, orderNo: table.orderId, paid: table.paid, tradeNo: table.tradeNo,
    price: b.local.domain === 'recharge' ? userRecharge.price : b.local.domain === 'store_order' ? storeOrder.payPrice : otherOrder.payPrice,
    payType: b.local.domain === 'recharge' ? userRecharge.rechargeType : b.local.domain === 'store_order' ? storeOrder.payType : otherOrder.payType })
    .from(table).where(eq(table.id, b.local.orderId)).limit(1);
  if (!local || local.uid !== b.local.buyerUid || local.orderNo !== expected.orderNo) return fail('local_identity_changed');
  if (decimalToCents(local.price) !== expected.amountCents || local.paid !== 0 && local.paid !== 1
    || local.tradeNo !== '' && local.tradeNo !== expected.transactionId || local.paid === 1 && local.payType !== 'weixin') return fail('local_payment_changed');
}
